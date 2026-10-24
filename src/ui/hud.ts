import type { View3D } from '../render/view3d';
import { bearingDeg, dist, headingOf, len, v3 } from '../sim/math';
import { EARLY_BONUS_M } from '../campaign/laststand';
import { THREAT_LABELS, ThreatType, spawnThreat } from '../sim/threats';
import { missilesOnTrack, timeToGo } from '../sim/tewa';
import type { Ident, Track } from '../sim/tracker';
import type { Wcs } from '../sim/tewa';
import type { World } from '../sim/world';
import type { Radar } from '../sim/radar';
import type { Site } from '../sim/sites';
import type { Ciws } from '../sim/ciws';
import { CATALOG, RANKS } from '../sim/catalog';
import { DayObjective, objectiveDesc, objectiveName, objectiveStatus } from '../campaign/objectives';
import { MOBILITY, moveError, moveStatus } from '../sim/mobility';
import { FIELD_REPAIR, QRA, RESUPPLY, callRepair, callResupply, qraError, repairError, resupplyCost, resupplyError, scrambleQra } from '../sim/support';
import { CLASS_NAME, IDENT_COLOR, IDENT_NAME, fmtTime } from './colors';
import type { Ppi } from './ppi';

export interface GameControl {
  speed: number;
  paused: boolean;
}

const SPEEDS = [1, 2, 4, 8, 16];
const BEARINGS: [string, number][] = [
  ['N', 0], ['NE', 45], ['E', 90], ['SE', 135], ['S', 180], ['SW', 225], ['W', 270], ['NW', 315],
];

const $ = (id: string): HTMLElement => document.getElementById(id)!;
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export class Hud {
  private w: World;
  /** Campaign mode hides the sandbox spawn panel and offers to end the day once the raids are over. */
  campaign: { day: number; days: number; objectives: DayObjective[]; onEndDay: () => void } | null = null;
  /** Last Stand: the wave counter and best score in the top bar. */
  stand: { wave: number; best: number; canCallEarly: boolean; callEarly: () => void } | null = null;
  private readonly view: View3D;
  private readonly ppi: Ppi;
  private readonly ctl: GameControl;
  selected: number | null = null;
  /** Selected friendly: a fire unit, CIWS or radar code, or F<index> for a fighter. */
  unitSel: string | null = null;
  private lastOrder = '';
  /** Code of the unit waiting for a click on the map to say where it should move. */
  private moving: string | null = null;
  private nextSlow = 0;
  private lastLogLen = -1;
  private cache = new Map<string, string>();

  constructor(w: World, view: View3D, ppi: Ppi, ctl: GameControl) {
    this.w = w;
    this.view = view;
    this.ppi = ppi;
    this.ctl = ctl;
    view.onSelect = (id) => this.select(id);
    view.onSelectSite = (site) => this.selectUnit(this.unitAtSite(site));
    view.onEmptyClick = () => this.clearSelection();
    ppi.onSelect = (id) => this.select(id);
    this.buildStatic();
    document.addEventListener('pointerdown', (e) => this.onAction(e));
    document.addEventListener('keydown', (e) => this.onKey(e));
  }

  /** Point the HUD at a new world (a new campaign day, or the sandbox). */
  setWorld(w: World): void {
    this.stopMove();
    this.w = w;
    this.cache.clear();
    this.lastLogLen = -1;
    this.clearSelection();
    $('spawn').hidden = !!this.campaign || !!this.stand;
  }

  private set(id: string, html: string): void {
    if (this.cache.get(id) === html) return;
    this.cache.set(id, html);
    $(id).innerHTML = html;
  }

  select(id: number | null): void {
    this.selected = id;
    this.lastOrder = '';
    this.view.selected = id;
    this.ppi.selected = id;
    this.nextSlow = 0;
    if (id !== null) this.selectUnit(null);
  }

  /** Select one of our own units: the detail panel then shows its status and what it can engage. */
  selectUnit(code: string | null): void {
    this.unitSel = code;
    this.lastOrder = '';
    this.nextSlow = 0;
    this.view.selectedSite = code ? this.siteOfUnit(code) : null;
    if (code !== null && this.selected !== null) {
      this.selected = null;
      this.view.selected = null;
      this.ppi.selected = null;
    }
  }

  clearSelection(): void {
    this.stopMove();
    this.select(null);
    this.selectUnit(null);
  }

  /** Wait for a click on the map, then send the unit there. */
  private startMove(code: string): void {
    const w = this.w;
    const f = w.fieldedByCode(code);
    if (!f) return;
    this.moving = code;
    this.lastOrder = f.unit.type === 'CAP' ? 'Click the map for the new CAP station. Esc cancels.' : `Click the map where the unit should go. It packs up, drives there and sets up again (${Math.round((MOBILITY[f.unit.type].packS + MOBILITY[f.unit.type].setupS) * w.mods.moveMult)} s out of action plus the drive). Esc cancels.`;
    const v = this.view;
    const reach = CATALOG[f.unit.type].rangeKm;
    v.onGroundHover = (p) => {
      if (!p) return v.setPreview(null);
      const err = moveError(this.w, f, p.x, p.y);
      v.setPreview(p, reach, !err);
      v.renderer.domElement.title = err ?? '';
    };
    v.onGroundClick = (p) => {
      const err = this.w.moveUnit(code, p.x, p.y);
      if (err) {
        this.lastOrder = `Cannot move there: ${err}`;
      } else {
        this.stopMove();
        this.lastOrder = 'Moving.';
      }
      this.nextSlow = 0;
    };
    this.nextSlow = 0;
  }

  private stopMove(): void {
    if (!this.moving) return;
    this.moving = null;
    const v = this.view;
    v.onGroundClick = null;
    v.onGroundHover = null;
    v.setPreview(null);
    v.renderer.domElement.title = '';
  }

  /** Support call buttons for a unit: a resupply convoy for SAM batteries, a repair team when damaged. */
  private supportRow(code: string): string {
    const w = this.w;
    const f = w.fieldedByCode(code);
    if (!f || !f.sites.length) return '';
    const btns: string[] = [];
    if (f.fu) {
      const err = resupplyError(w, f.fu);
      btns.push(`<button data-act="resupply" data-code="${f.fu.code}" ${err ? 'disabled' : ''} title="${esc(err ?? `${RESUPPLY.rounds} spare missiles in ${fmtTime(RESUPPLY.delayS)}`)}">Resupply ${this.cost(resupplyCost(f.fu))}</button>`);
    }
    const hurt = f.sites.filter((x) => x.alive && x.hp < 100);
    for (const site of hurt.slice(0, 3)) {
      const err = repairError(w, site);
      btns.push(`<button data-act="repair" data-name="${esc(site.name)}" ${err ? 'disabled' : ''} title="${esc(err ?? `+${FIELD_REPAIR.hp}% in ${fmtTime(FIELD_REPAIR.delayS)}`)}">Repair ${esc(site.name)} ${Math.round(site.hp)}% ${this.cost(FIELD_REPAIR.costM)}</button>`);
    }
    return btns.length ? `<div class="row">${btns.join('')}</div>` : '';
  }

  /** A price for a support call (free in the sandbox). */
  private cost(m: number): string {
    return Number.isFinite(this.w.budgetM) ? `$${m.toFixed(m < 10 ? 1 : 0)}M` : '';
  }

  /** Move button and status line for a unit's detail panel. */
  private moveRow(code: string): string {
    const f = this.w.fieldedByCode(code);
    if (!f || !f.sites.length && f.unit.type !== 'CAP') return '';
    const st = moveStatus(this.w, f);
    const can = f.unit.type === 'CAP' ? f.fighters?.some((x) => x.alive) : f.sites[0].alive;
    return `<div class="row"><button data-act="move" data-code="${code}" class="${this.moving === code ? 'on' : ''}" ${can ? '' : 'disabled'} title="Move (G): pick a new position on the map">${f.unit.type === 'CAP' ? 'Move station' : 'Move'}</button>${st ? `<span class="st jam">${esc(st)}</span>` : ''}</div>`;
  }

  private unitAtSite(site: Site): string | null {
    const f = this.w.fielded.find((x) => x.sites.includes(site));
    return f?.fu?.code ?? f?.ciws?.code ?? f?.radar?.code ?? null;
  }

  private siteOfUnit(code: string): Site | null {
    const w = this.w;
    const fu = w.unit(code);
    if (fu) return w.fielded.find((f) => f.fu === fu)?.sites[0] ?? null;
    return w.fielded.find((f) => f.ciws?.code === code || f.radar?.code === code)?.sites[0] ?? null;
  }

  private buildStatic(): void {
    const opts = (Object.keys(THREAT_LABELS) as ThreatType[]).map((k) => `<option value="${k}">${THREAT_LABELS[k]}</option>`).join('');
    const brg = BEARINGS.map(([n, b]) => `<option value="${b}">${n}</option>`).join('');
    $('spawn').innerHTML = `
      <h3>Sandbox</h3>
      <div class="row"><select id="spawn-type">${opts}</select><select id="spawn-brg">${brg}</select></div>
      <div class="row"><button data-act="spawn" class="wide">Spawn threat</button></div>
      <div class="row toggles">
        <label><input type="checkbox" id="tg-truth"> Show undetected</label>
        <label><input type="checkbox" id="tg-labels" checked> Labels</label>
        <label><input type="checkbox" id="tg-cov" checked> Coverage</label>
      </div>
      <div class="row"><button data-act="view" data-v="defended">Defended</button><button data-act="view" data-v="overview">Overview</button><button data-act="view" data-v="north">North</button></div>`;
    ($('tg-truth') as HTMLInputElement).addEventListener('change', (e) => (this.view.showTruth = (e.target as HTMLInputElement).checked));
    ($('tg-labels') as HTMLInputElement).addEventListener('change', (e) => (this.view.showLabels = (e.target as HTMLInputElement).checked));
    ($('tg-cov') as HTMLInputElement).addEventListener('change', (e) => (this.view.showCoverage = (e.target as HTMLInputElement).checked));
    $('ppi-ctl').innerHTML = `<button data-act="ppi" data-d="-1">−</button><button data-act="ppi" data-d="1">+</button>`;
    $('help-btn').addEventListener('click', () => $('help').classList.toggle('hidden'));
    $('help').addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-close]') || e.target === $('help')) $('help').classList.add('hidden');
    });
  }

  private onKey(e: KeyboardEvent): void {
    if ((e.target as HTMLElement).tagName === 'SELECT' || (e.target as HTMLElement).tagName === 'INPUT') return;
    if (e.code === 'Space') {
      this.ctl.paused = !this.ctl.paused;
      e.preventDefault();
    } else if (/^Digit[1-5]$/.test(e.code)) {
      this.ctl.speed = SPEEDS[Number(e.code.slice(5)) - 1];
      this.ctl.paused = false;
    } else if (e.code === 'KeyG' && this.unitSel) {
      if (this.moving) this.stopMove();
      else this.startMove(this.unitSel);
    } else if (e.code === 'KeyH' && this.unitSel) {
      this.w.toggleHold(this.unitSel);
      this.nextSlow = 0;
    } else if (e.code === 'Escape') {
      if (this.moving) {
        this.stopMove();
        this.lastOrder = '';
        return;
      }
      this.clearSelection();
      $('help').classList.add('hidden');
    }
  }

  private resolve(): Track | undefined {
    if (this.selected === null) return undefined;
    let id = this.selected;
    for (let i = 0; i < 5 && this.w.remapped.has(id); i++) id = this.w.remapped.get(id)!;
    if (id !== this.selected) this.select(id);
    return this.w.tracker.get(id);
  }

  private onAction(e: PointerEvent): void {
    const el = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (!el || (el as HTMLButtonElement).disabled) return;
    const w = this.w;
    const d = el.dataset;
    switch (d.act) {
      case 'speed':
        this.ctl.speed = Number(d.v);
        this.ctl.paused = false;
        break;
      case 'pause':
        this.ctl.paused = !this.ctl.paused;
        break;
      case 'wcs':
        w.setWcs(d.v as Wcs);
        break;
      case 'raid':
        w.scenario.launchNext(w);
        break;
      case 'emcon':
        w.toggleEmcon(d.code!);
        break;
      case 'armwatch':
        w.toggleArmWatch(d.code!);
        break;
      case 'ciws':
      case 'hold':
        w.toggleHold(d.code!);
        break;
      case 'resupply': {
        const fu = w.unit(d.code!);
        if (fu) this.lastOrder = callResupply(w, fu) ?? 'Resupply convoy on its way.';
        break;
      }
      case 'repair': {
        const site = w.site(d.name!);
        if (site) this.lastOrder = callRepair(w, site) ?? `Repair team on its way to ${site.name}.`;
        break;
      }
      case 'move':
        if (this.moving === d.code) this.stopMove();
        else this.startMove(d.code!);
        break;
      case 'gnss': {
        const j = w.gnss[Number(d.i)];
        j.on = !j.on;
        w.log(`${j.site.name} ${j.on ? 'ON' : 'OFF'}`, 'info');
        break;
      }
      case 'decoy': {
        const dc = w.decoys[Number(d.i)];
        dc.on = !dc.on;
        w.log(`${dc.name} ${dc.on ? 'radiating' : 'off'}`, 'info');
        break;
      }
      case 'ewj': {
        const j = w.ewj[Number(d.i)];
        j.on = !j.on;
        w.log(`${j.name} ${j.on ? 'jamming' : 'off'}`, 'info');
        break;
      }
      case 'qra':
        this.lastOrder = scrambleQra(w) ?? 'Alert pair scrambled.';
        break;
      case 'nextwave':
        this.stand?.callEarly();
        break;
      case 'endday':
        this.campaign?.onEndDay();
        break;
      case 'cap-station':
        w.fighters[Number(d.i)].toStation(w);
        break;
      case 'cap-rtb':
        w.fighters[Number(d.i)].rtb(w);
        break;
      case 'sel':
        // Clicking the selected track again deselects it.
        this.select(this.selected === Number(d.id) ? null : Number(d.id));
        break;
      case 'desel':
        this.clearSelection();
        break;
      case 'unit':
        this.selectUnit(this.unitSel === d.code ? null : d.code!);
        break;
      case 'engage-from': {
        const tr = w.tracker.get(Number(d.id));
        if (tr) this.lastOrder = `${w.unit(d.code!)?.name ?? d.code} on ${tr.label}: ${w.engage(tr.id, d.code!)}`;
        break;
      }
      case 'cap-on': {
        const f = w.fighters[Number(d.i)];
        const tr = w.tracker.get(Number(d.id));
        if (f && tr) {
          f.intercept(w, tr.id);
          this.lastOrder = `${f.name} committed on ${tr.label}`;
        }
        break;
      }
      case 'engage': {
        const tr = this.resolve();
        if (tr) this.lastOrder = `${w.unit(d.code!)?.name ?? d.code}: ${w.engage(tr.id, d.code!)}`;
        break;
      }
      case 'cap': {
        const tr = this.resolve();
        if (tr) w.fighters[Number(d.i)].intercept(w, tr.id);
        break;
      }
      case 'ident': {
        const tr = this.resolve();
        if (tr) w.setIdent(tr.id, d.v === 'AUTO' ? null : (d.v as Ident));
        break;
      }
      case 'follow':
        this.view.follow = !this.view.follow;
        break;
      case 'spawn': {
        const type = ($('spawn-type') as HTMLSelectElement).value as ThreatType;
        const brg = Number(($('spawn-brg') as HTMLSelectElement).value);
        spawnThreat(w, type, brg);
        w.log(`Sandbox: spawned ${THREAT_LABELS[type]} from ${BEARINGS.find((b) => b[1] === brg)?.[0]}`, 'raid');
        break;
      }
      case 'view':
        this.view.setView(d.v as 'defended' | 'overview' | 'north');
        break;
      case 'ppi':
        this.ppi.cycleRange(Number(d.d));
        break;
      default:
        return;
    }
    this.nextSlow = 0;
  }

  update(): void {
    const w = this.w;
    this.set('clock', `<span class="lbl">T+</span>${fmtTime(w.t)}`);
    this.set(
      'speed',
      `<button data-act="pause" class="${this.ctl.paused ? 'on warn' : ''}">${this.ctl.paused ? '▶' : '❚❚'}</button>` +
        SPEEDS.map((s) => `<button data-act="speed" data-v="${s}" class="${!this.ctl.paused && this.ctl.speed === s ? 'on' : ''}">${s}×</button>`).join(''),
    );
    this.set(
      'wcs',
      `<span class="lbl">WCS</span>` +
        (['HOLD', 'TIGHT', 'FREE'] as Wcs[]).map((m) => `<button data-act="wcs" data-v="${m}" class="wcs-${m} ${w.wcs === m ? 'on' : ''}">${m}</button>`).join(''),
    );
    const now = performance.now();
    if (now < this.nextSlow) return;
    this.nextSlow = now + 250;
    this.updateRaid();
    this.updateScore();
    this.updateSystems();
    this.updateTracks();
    this.updateDetail();
    this.updateLog();
  }

  private updateRaid(): void {
    const w = this.w;
    const r = w.scenario.next;
    const total = w.scenario.raids.length;
    const day = this.campaign
      ? `<span class="lbl">DAY</span><b>${this.campaign.day}</b><span class="dim">/${this.campaign.days}</span> `
      : this.stand
        ? `<span class="lbl">WAVE</span><b>${this.stand.wave}</b><span class="dim">best ${this.stand.best}</span> `
        : '';
    if (!r) {
      const clear = w.scenario.done;
      this.set(
        'raid',
        day +
          `<span class="lbl">RAIDS</span> all ${total} launched${clear ? ', airspace clear' : ''}` +
          (this.stand?.canCallEarly ? `<button data-act="nextwave" class="go" title="Count this wave as held now for +$${EARLY_BONUS_M}M, while what is left of it is still in the air">Next wave now</button>` : '') +
          (this.campaign ? `<button data-act="endday" class="${clear ? 'go' : ''}" title="${clear ? 'Go to the debrief' : 'Threats are still inbound: ending now counts them as leakers'}">End day</button>` : ''),
      );
      return;
    }
    const n = w.scenario.raids.filter((x) => x.launched).length;
    if (this.campaign || this.stand) {
      // Only reported packages are known in advance.
      const known = w.scenario.raids.filter((x) => !x.launched && !x.unreported);
      const k = known[0];
      this.set(
        'raid',
        day +
          (k
            ? `<span class="lbl">EXPECTED</span><span title="${esc(k.desc)}">${esc(k.name)}</span> <span class="mono">in ${fmtTime(k.t - w.t)}</span>`
            : '<span class="lbl">INTEL</span><span class="dim">no further packages reported</span>') +
          `<span class="dim">${n}/${total} packages in</span>`,
      );
      return;
    }
    this.set(
      'raid',
      day +
        `<span class="lbl">NEXT</span><span title="${esc(r.desc)}">${esc(r.name)}</span> <span class="mono">in ${fmtTime(r.t - w.t)}</span>` +
        `<button data-act="raid">Launch now</button><span class="dim">${n}/${total} launched</span>`,
    );
  }

  private updateScore(): void {
    const s = this.w.stats;
    const fired = s.fired.LR + s.fired.MR + s.fired.SH + s.fired.AAM;
    this.set(
      'score',
      `<span class="chip">Kills <b>${s.kills}</b></span><span class="chip ${s.leakers ? 'bad' : ''}">Leakers <b>${s.leakers}</b></span>` +
        `<span class="chip" title="LR ${s.fired.LR} · MR ${s.fired.MR} · SHORAD ${s.fired.SH} · AAM ${s.fired.AAM} · CIWS rounds ${s.ciwsRounds}">Missiles <b>${fired}</b> ($${s.costM.toFixed(1)}M)</span>` +
        (Number.isFinite(this.w.budgetM) ? `<span class="chip" title="Campaign budget left for support calls (resupply, field repair)">Budget <b>$${Math.round(this.w.budgetM - this.w.supportSpentM)}M</b></span>` : '') +
        (this.w.weatherId !== 'clear' ? `<span class="chip" title="${esc(this.w.weather.desc)}">${this.w.weather.name}</span>` : '') +
        (s.fratricide || s.civilian ? `<span class="chip bad">Fratricide ${s.fratricide} · Civil ${s.civilian}</span>` : ''),
    );
  }

  private radarState(code: string): string {
    const r = this.w.radarByCode(code);
    if (!r) return '';
    if (!r.alive) return '<span class="st dead">DESTROYED</span>';
    if (r.stowed) return '<span class="st emcon" title="Packing up, on the move or setting up">MOVING</span>';
    if (!r.emitting) return r.armSilent ? '<span class="st jam" title="Shut down by the automatic ARM response">ARM SILENT</span>' : '<span class="st emcon">EMCON</span>';
    const j = r.sideJnrDb > 0 ? ` <span class="st jam" title="Sidelobe jam-to-noise">J/N ${r.sideJnrDb.toFixed(0)} dB</span>` : '';
    return `<span class="st ok">RADIATE</span>${j}`;
  }

  private radarButtons(r: Radar): string {
    const dis = r.alive ? '' : 'disabled';
    return `<button data-act="emcon" data-code="${r.code}" ${dis}>${r.emitting ? 'EMCON' : 'Radiate'}</button>` +
      `<button data-act="armwatch" data-code="${r.code}" class="${r.armWatch ? 'on' : ''}" ${dis} title="Automatic ARM response: shut the radar down while an anti-radiation missile is closing on it">ARM auto</button>`;
  }

  /** Crew rank badge after a unit's name. */
  private badge(rank: number): string {
    return rank ? ` <span class="rank" title="${RANKS[rank].name} crew">${RANKS[rank].badge}</span>` : '';
  }

  private gunState(c: Ciws): string {
    if (!c.site.alive) return '<span class="st dead">DESTROYED</span>';
    if (c.radar.stowed) return '<span class="st emcon">MOVING</span>';
    if (c.coolUntil > 0) return '<span class="st emcon">COOLING</span>';
    if (c.ammo === 0) return '<span class="st emcon">RELOAD</span>';
    if (c.firing) return '<span class="st jam">FIRING</span>';
    if (c.lasing) return '<span class="st jam">LASING</span>';
    if (c.target) return '<span class="st ok">TRACK</span>';
    return c.auto ? '<span class="st ok">AUTO</span>' : '<span class="st emcon">HOLD</span>';
  }

  private gunAmmo(c: Ciws): string {
    if (Number.isFinite(c.maxAmmo)) return `Rounds <b>${c.ammo}</b>/${c.maxAmmo}`;
    return `Heat <b>${Math.round((100 * c.heat) / (c.spec.heatS ?? 1))}%</b>`;
  }

  private holdButton(code: string, hold: boolean): string {
    return `<button data-act="hold" data-code="${code}" class="${hold ? 'on warn' : ''}" title="Hold fire (H): no automatic engagements. Your direct orders still fire.">${hold ? 'Holding' : 'Hold fire'}</button>`;
  }

  private updateSystems(): void {
    const w = this.w;
    const rows: string[] = [];
    if (this.campaign?.objectives.length) {
      rows.push('<h3>Objectives</h3>');
      for (const o of this.campaign.objectives) {
        const st = objectiveStatus(o, w, w.scenario.done);
        const mark = st === 'done' ? '<span class="st ok">DONE</span>' : st === 'failed' ? '<span class="st dead">FAILED</span>' : '<span class="st">OPEN</span>';
        rows.push(`<div class="sys" title="${esc(objectiveDesc(o))}"><div class="sys-h"><b>${esc(objectiveName(o))}</b> ${mark}<span class="dim" style="margin-left:auto">+$${o.rewardM}M</span></div><div class="sys-b dim">${esc(objectiveDesc(o))}</div></div>`);
      }
    }
    rows.push('<h3>Fire units</h3>');
    for (const u of w.units) {
      const r = u.radar!;
      const active = u.activeTargets(w).size;
      const reload = u.launchers.filter((l) => l.reloadAt > 0 && l.site.alive);
      rows.push(`<div class="sys sel-able ${this.unitSel === u.code ? 'focus' : ''}" data-act="unit" data-code="${u.code}">
        <div class="sys-h"><b>${u.name}</b>${this.badge(u.rank)} ${this.radarState(r.code)}${u.hold ? ' <span class="st emcon">HOLD</span>' : ''}</div>
        <div class="sys-b">Missiles <b>${u.rounds}</b>/${u.maxRounds}${Number.isFinite(u.spares) ? ` +${u.spares}` : ''} · Channels ${active}/${u.channels}${reload.length ? ` · reload ${fmtTime(Math.min(...reload.map((l) => l.reloadAt)) - w.t)}` : ''}
        ${this.holdButton(u.code, u.hold)}${this.radarButtons(r)}</div></div>`);
    }
    if (w.ciws.length) rows.push('<h3>Point defence</h3>');
    for (const c of w.ciws) {
      rows.push(`<div class="sys sel-able ${this.unitSel === c.code ? 'focus' : ''}" data-act="unit" data-code="${c.code}"><div class="sys-h"><b>${c.name}</b>${this.badge(c.rank)} ${this.gunState(c)}</div>
        <div class="sys-b">${this.gunAmmo(c)} <button data-act="ciws" data-code="${c.code}" class="${c.auto ? '' : 'on warn'}" ${c.site.alive ? '' : 'disabled'}>${c.auto ? 'Hold fire' : 'Holding'}</button></div></div>`);
    }
    const ewr = w.fielded.filter((f) => (f.unit.type === 'EWR' || f.unit.type === 'GAP') && f.radar);
    if (ewr.length) {
      rows.push('<h3>Sensors</h3>');
      for (const f of ewr) {
        const r = f.radar!;
        rows.push(`<div class="sys sel-able ${this.unitSel === r.code ? 'focus' : ''}" data-act="unit" data-code="${r.code}"><div class="sys-h"><b>${r.name}</b> ${this.radarState(r.code)}</div>
          <div class="sys-b dim">${f.unit.type === 'EWR' ? 'L-band, 250 km' : 'Low-level, 25 km'} ${this.radarButtons(r)}</div></div>`);
      }
    }
    if (w.gnss.length || w.decoys.length || w.ewj.length) rows.push('<h3>Electronic warfare</h3>');
    w.gnss.forEach((j, i) => {
      rows.push(`<div class="sys"><div class="sys-h"><b>${j.site.name}</b> ${j.site.alive ? (j.on ? '<span class="st jam">ON</span>' : '<span class="st">OFF</span>') : '<span class="st dead">DESTROYED</span>'}
        <button data-act="gnss" data-i="${i}" ${j.site.alive ? '' : 'disabled'}>${j.on ? 'Off' : 'On'}</button></div><div class="sys-b dim">30 km, drags GNSS-guided drones off target</div></div>`);
    });
    w.decoys.forEach((dc, i) => {
      rows.push(`<div class="sys"><div class="sys-h"><b>${dc.name}</b> ${dc.alive ? (dc.on ? '<span class="st jam">RADIATE</span>' : '<span class="st">OFF</span>') : '<span class="st dead">DESTROYED</span>'}
        <button data-act="decoy" data-i="${i}" ${dc.alive ? '' : 'disabled'}>${dc.on ? 'Off' : 'On'}</button></div><div class="sys-b dim">Mimics the LR radar for ARM seekers</div></div>`);
    });
    w.ewj.forEach((j, i) => {
      rows.push(`<div class="sys"><div class="sys-h"><b>${j.name}</b> ${j.alive ? (j.isEmitting() ? '<span class="st jam">JAMMING</span>' : '<span class="st">OFF</span>') : '<span class="st dead">DESTROYED</span>'}
        <button data-act="ewj" data-i="${i}" ${j.alive ? '' : 'disabled'} title="Jamming blinds enemy SEAD, spoils bomb and missile aiming and stops recon pictures within 90 km, but SEAD can home on it">${j.on ? 'Off' : 'On'}</button></div><div class="sys-b dim">90 km: blinds SEAD and recon, spoils weapon aiming. Draws ARMs.</div></div>`);
    });
    rows.push('<h3>Combat air patrol</h3>');
    if (!w.qraUsed) {
      const why = qraError(w);
      rows.push(`<div class="sys"><div class="sys-h"><b>Quick reaction alert</b> <span class="st">ON ALERT</span>
        <button data-act="qra" ${why ? 'disabled' : ''} title="${esc(why ?? `Scramble two fighters with ${QRA.missiles} missiles each from the airbase, for one sortie. Once a battle.`)}">Scramble $${QRA.costM}M</button></div></div>`);
    }
    w.fighters.forEach((f, i) => {
      const tr = f.targetTrackId !== null ? w.tracker.get(f.targetTrackId) : undefined;
      const st = !f.alive ? 'LOST' : f.state === 'ground' ? (f.oneSortie ? 'LANDED' : `REARM ${fmtTime(f.groundUntil - w.t)}`) : f.state === 'intercept' ? `INTERCEPT ${tr?.label ?? ''}` : f.state.toUpperCase();
      rows.push(`<div class="sys sel-able ${this.unitSel === `F${i}` ? 'focus' : ''}" data-act="unit" data-code="F${i}"><div class="sys-h"><b>${f.name}</b> <span class="st ${f.alive ? 'ok' : 'dead'}">${st}</span></div>
        <div class="sys-b">AAM <b>${f.missiles}</b> · Fuel ${Math.round((100 * f.fuel) / f.maxFuel)}%
        <button data-act="cap-station" data-i="${i}" ${f.alive && f.airborne ? '' : 'disabled'}>CAP</button><button data-act="cap-rtb" data-i="${i}" ${f.alive && f.airborne ? '' : 'disabled'}>RTB</button></div></div>`);
    });
    rows.push('<h3>Defended assets</h3>');
    const hurt = w.sites.filter((s) => s.defended || s.hp < 100);
    rows.push(
      '<div class="assets">' +
        hurt
          .map((s) => {
            const err = repairError(w, s);
            const btn = s.alive && s.hp < 100 ? `<button data-act="repair" data-name="${esc(s.name)}" ${err ? 'disabled' : ''} title="${esc(err ?? `Field repair: +${FIELD_REPAIR.hp}% in ${fmtTime(FIELD_REPAIR.delayS)}`)}">Repair ${this.cost(FIELD_REPAIR.costM)}</button>` : '';
            return `<div class="asset ${s.alive ? '' : 'dead'}"><span>${s.name} ${btn}</span><span class="bar"><i style="width:${s.hp}%;background:${s.hp > 60 ? '#5ee07a' : s.hp > 25 ? '#ffd84d' : '#ff4d4d'}"></i></span></div>`;
          })
          .join('') +
        '</div>',
    );
    this.set('systems', rows.join(''));
  }

  private engStatus(tr: Track): string {
    const w = this.w;
    const units = new Map<string, number>();
    for (const m of w.missiles) if (m.alive && m.trackId === tr.id) units.set(m.spec.code, (units.get(m.spec.code) ?? 0) + 1);
    const parts = [...units].map(([k, n]) => `${k}×${n}`);
    if (w.fighters.some((f) => f.state === 'intercept' && f.targetTrackId === tr.id)) parts.push('CAP');
    if (!parts.length && w.t < tr.kaUntil) parts.push('KA');
    return parts.join(' ');
  }

  private updateTracks(): void {
    const w = this.w;
    const list = w.tracker.tracks
      .filter((t) => t.confirmed)
      .map((t) => ({ t, tgo: timeToGo(w, t), r: dist(t.pos, v3()) }))
      .sort((a, b) => {
        const ha = a.t.ident === 'HOS' ? 0 : 1;
        const hb = b.t.ident === 'HOS' ? 0 : 1;
        if (ha !== hb) return ha - hb;
        if (a.tgo !== b.tgo) return a.tgo - b.tgo;
        return a.r - b.r;
      });
    const rows = list.map(({ t, tgo }) => {
      const p = t.predict(w.t);
      const r = Math.hypot(p.x, p.y) / 1000;
      const src = t.liveSources(w.t).join(' ');
      return `<tr data-act="sel" data-id="${t.id}" class="${t.id === this.selected ? 'sel' : ''}" style="color:${IDENT_COLOR[t.ident]}">
        <td>${t.label}</td><td>${t.ident}</td><td>${t.cls}</td><td class="n">${r.toFixed(r < 10 ? 1 : 0)}</td><td class="n">${Math.round(bearingDeg(v3(), p))
          .toString()
          .padStart(3, '0')}</td><td class="n">${Math.max(0, Math.round(p.z / 10) * 10)}</td><td class="n">${Math.round(t.speed)}</td><td class="n">${
            Number.isFinite(tgo) && tgo < 3600 ? fmtTime(tgo) : '—'
          }</td><td class="src">${src}</td><td class="eng">${this.engStatus(t)}</td></tr>`;
    });
    this.set(
      'tracks',
      `<h3>Air picture <span class="dim">${list.length} tracks · ${w.tracker.tracks.length - list.length} tentative</span></h3>
      <div class="tbl-wrap"><table><thead><tr><th>Track</th><th>ID</th><th>Cls</th><th>km</th><th>Brg</th><th>Alt m</th><th>m/s</th><th>TTG</th><th>Src</th><th>Eng</th></tr></thead>
      <tbody>${rows.join('') || '<tr><td colspan="10" class="dim">No tracks</td></tr>'}</tbody></table></div>`,
    );
  }

  /** Tracks a friendly unit might be told to engage, most urgent first. */
  private candidates(): Track[] {
    const w = this.w;
    return w.tracker.tracks
      .filter((t) => t.confirmed && !t.dropped && t.ident !== 'FRD' && t.ident !== 'NEU')
      .map((t) => ({ t, tgo: timeToGo(w, t), hos: t.ident === 'HOS' ? 0 : 1 }))
      .sort((a, b) => a.hos - b.hos || a.tgo - b.tgo)
      .slice(0, 14)
      .map((x) => x.t);
  }

  private targetRow(tr: Track, from: { x: number; y: number }, action: string): string {
    const w = this.w;
    const p = tr.predict(w.t);
    const r = Math.hypot(p.x - from.x, p.y - from.y) / 1000;
    const tgo = timeToGo(w, tr);
    return `<tr style="color:${IDENT_COLOR[tr.ident]}"><td data-act="sel" data-id="${tr.id}" class="link">${tr.label}</td><td>${tr.ident}</td><td>${tr.cls}</td>
      <td class="n">${r.toFixed(r < 10 ? 1 : 0)}</td><td class="n">${Number.isFinite(tgo) && tgo < 3600 ? fmtTime(tgo) : '—'}</td><td class="eng">${this.engStatus(tr)}</td><td>${action}</td></tr>`;
  }

  private targetTable(rows: string[]): string {
    return `<h3>Targets <span class="dim">km from this unit</span></h3><div class="tbl-wrap unit-targets"><table><thead><tr><th>Track</th><th>ID</th><th>Cls</th><th>km</th><th>TTG</th><th>Eng</th><th></th></tr></thead>
      <tbody>${rows.join('') || '<tr><td colspan="7" class="dim">No hostile, suspect or unknown tracks</td></tr>'}</tbody></table></div>`;
  }

  /** Status of the selected friendly unit and the tracks it can be ordered to engage. */
  private unitDetail(code: string): string | null {
    const w = this.w;
    const close = '<button data-act="desel" class="close-x" title="Deselect (Esc)">×</button>';
    const order = this.lastOrder ? `<div class="order">${esc(this.lastOrder)}</div>` : '';
    const fu = w.unit(code);
    if (fu) {
      const r = fu.radar!;
      const active = [...fu.activeTargets(w)].map((id) => w.tracker.get(id)?.label ?? `T${String(id).padStart(3, "0")}`);
      const ready = fu.launchers.filter((l) => l.site.alive && l.rounds > 0).length;
      const reload = fu.launchers.filter((l) => l.reloadAt > 0 && l.site.alive);
      const rows = this.candidates().map((tr) => {
        const f = fu.feasibility(w, tr);
        return this.targetRow(
          tr,
          r.pos,
          f.ok
            ? `<button data-act="engage-from" data-code="${fu.code}" data-id="${tr.id}" class="go">Engage</button>`
            : `<small class="dim" title="${esc(f.reason)}">${esc(f.reason)}</small>`,
        );
      });
      return `<h3>${fu.name}${this.badge(fu.rank)} ${this.radarState(r.code)} ${close}</h3>
        <div class="kv">
          <span>Missiles</span><b>${fu.rounds}/${fu.maxRounds}${Number.isFinite(fu.spares) ? ` · ${fu.spares} spare` : ''} · ${ready}/${fu.launchers.length} launchers ready</b>
          <span>Reload</span><b>${reload.length ? `next in ${fmtTime(Math.min(...reload.map((l) => l.reloadAt)) - w.t)}` : 'none pending'}</b>
          <span>Channels</span><b>${active.length}/${fu.channels}${active.length ? `: ${active.join(', ')}` : ''}</b>
          <span>Missile</span><b>${fu.spec.name}, ${(fu.spec.maxRangeM / 1000).toFixed(0)} km</b>
        </div>
        <div class="row">${this.holdButton(fu.code, fu.hold)}${this.radarButtons(r)}</div>
        ${this.moveRow(fu.code)}${this.supportRow(fu.code)}${order}${this.targetTable(rows)}`;
    }
    const c = w.ciws.find((x) => x.code === code);
    if (c) {
      return `<h3>${c.name}${this.badge(c.rank)} ${close}</h3>
        <div class="kv">
          <span>${Number.isFinite(c.maxAmmo) ? 'Rounds' : 'Heat'}</span><b>${this.gunAmmo(c).replace(/^\w+ /, '')}</b>
          <span>State</span><b>${!c.site.alive ? 'destroyed' : c.firing || c.lasing ? `firing at ${c.target?.name ?? ''}` : c.target ? `tracking ${c.target.name}` : c.auto ? 'automatic' : 'hold'}</b>
        </div>
        <div class="row"><button data-act="ciws" data-code="${c.code}" ${c.site.alive ? '' : 'disabled'}>${c.auto ? 'Hold fire' : 'Automatic'}</button></div>
        ${this.moveRow(c.code)}${this.supportRow(c.code)}${order}
        <div class="dim">${c.spec.kind === 'laser' ? 'The laser burns down drones (and, slowly, cruise missiles) inside 3.5 km. It never runs out of ammunition but overheats after long bursts.' : `The gun engages anything inbound inside about ${(c.spec.rangeM / 1000).toFixed(1)} km on its own; it cannot be pointed at a track.`}</div>`;
    }
    if (code.startsWith('F')) {
      const i = Number(code.slice(1));
      const f = w.fighters[i];
      if (!f) return null;
      const tr = f.targetTrackId !== null ? w.tracker.get(f.targetTrackId) : undefined;
      const ok = f.alive && f.airborne && f.missiles > 0;
      const rows = this.candidates()
        .filter((t) => t.cls !== 'TBM')
        .map((t) =>
          this.targetRow(t, f.pos, ok ? `<button data-act="cap-on" data-i="${i}" data-id="${t.id}" class="go">Intercept</button>` : '<small class="dim">not available</small>'),
        );
      return `<h3>${f.name} <span class="st ${f.alive ? 'ok' : 'dead'}">${f.alive ? f.state.toUpperCase() : 'LOST'}</span> ${close}</h3>
        <div class="kv">
          <span>AAM</span><b>${f.missiles}</b>
          <span>Fuel</span><b>${Math.round((100 * f.fuel) / f.maxFuel)}%</b>
          <span>Altitude</span><b>${Math.round(f.pos.z)} m, ${Math.round(len(f.vel))} m/s</b>
          <span>Target</span><b>${tr ? tr.label : 'none'}</b>
        </div>
        <div class="row"><button data-act="cap-station" data-i="${i}" ${f.alive && f.airborne ? '' : 'disabled'}>Back to CAP</button><button data-act="cap-rtb" data-i="${i}" ${f.alive && f.airborne ? '' : 'disabled'}>RTB</button></div>
        ${this.moveRow(code)}${order}${this.targetTable(rows)}`;
    }
    const r = w.radarByCode(code);
    if (r) {
      return `<h3>${r.name} ${this.radarState(r.code)} ${close}</h3>
        <div class="kv">
          <span>Band</span><b>${r.spec.freqGHz} GHz, ${r.spec.maxRangeKm} km</b>
          <span>Firm tracks</span><b>${r.firm.size}</b>
          <span>Radiated</span><b>${fmtTime(w.radiating.get(r.code) ?? 0)} this day</b>
        </div>
        <div class="row">${this.radarButtons(r)}</div>
        ${this.moveRow(r.code)}${this.supportRow(r.code)}${order}`;
    }
    return null;
  }

  private updateDetail(): void {
    const w = this.w;
    if (this.unitSel) {
      const html = this.unitDetail(this.unitSel);
      if (html) {
        this.set('detail', html);
        return;
      }
      this.unitSel = null;
    }
    const tr = this.resolve();
    if (!tr) {
      this.set(
        'detail',
        `<h3>Selection</h3><div class="dim">Select a track in the table, on the PPI, or click its label in the 3D view. Select one of your units in the left panel or click its name on the map to see its status and give it targets. Esc, the × button or a click on empty ground deselects. Hostiles are engaged automatically under WCS TIGHT (hostile only) and FREE (anything not friend or neutral).</div>`,
      );
      return;
    }
    const p = tr.predict(w.t);
    const tgo = timeToGo(w, tr);
    const units = w.units.map((u) => {
      const f = u.feasibility(w, tr);
      return `<button data-act="engage" data-code="${u.code}" class="eng-btn ${f.ok ? 'ok' : ''}" ${f.ok ? '' : 'disabled'} title="${esc(f.reason)}">
        <b>${u.name}</b><small>${esc(f.reason)}</small></button>`;
    });
    const caps = w.fighters.map((f, i) => {
      const ok = f.alive && f.airborne && f.missiles > 0;
      return `<button data-act="cap" data-i="${i}" ${ok ? '' : 'disabled'}>${f.name}</button>`;
    });
    const ident = (['HOS', 'SUS', 'NEU', 'FRD'] as Ident[]).map(
      (i) => `<button data-act="ident" data-v="${i}" class="${tr.manual === i ? 'on' : ''}" style="color:${IDENT_COLOR[i]}">${i}</button>`,
    );
    ident.push(`<button data-act="ident" data-v="AUTO" class="${tr.manual ? '' : 'on'}">AUTO</button>`);
    const inFlight = missilesOnTrack(w, tr.id);
    this.set(
      'detail',
      `<h3 style="color:${IDENT_COLOR[tr.ident]}">${tr.label} · ${IDENT_NAME[tr.ident]} · ${CLASS_NAME[tr.cls]} <button data-act="desel" class="close-x" title="Deselect (Esc)">×</button></h3>
      <div class="kv">
        <span>Range / brg</span><b>${(Math.hypot(p.x, p.y) / 1000).toFixed(1)} km / ${Math.round(bearingDeg(v3(), p))}°</b>
        <span>Alt / speed</span><b>${Math.round(p.z)} m / ${Math.round(tr.speed)} m/s (M${(tr.speed / 340).toFixed(2)})</b>
        <span>Heading</span><b>${Math.round(headingOf(tr.vel))}°</b>
        <span>Time to go</span><b>${Number.isFinite(tgo) ? fmtTime(tgo) : 'not inbound'}</b>
        <span>IFF replies</span><b>M5 ${tr.iffM5} · M3/C ${tr.iffM3} · none ${tr.iffNone}</b>
        <span>RCS est.</span><b>${tr.jam && !tr.skin ? 'n/a (strobe fix)' : `${tr.rcsDb.toFixed(1)} dBsm`}</b>
        <span>Sources</span><b>${tr.liveSources(w.t).join(' ') || 'coasting'} · σ ${Math.round(tr.sigma)} m</b>
        <span>Engagement</span><b>${inFlight ? `${inFlight} missile(s) in flight` : this.engStatus(tr) || 'none'}</b>
      </div>
      <div class="btns engage">${units.join('')}</div>
      <div class="row"><span class="lbl">CAP</span>${caps.join('')}<button data-act="follow" class="${this.view.follow ? 'on' : ''}">Follow</button></div>
      <div class="row"><span class="lbl">ID</span>${ident.join('')}</div>
      ${this.lastOrder ? `<div class="order">${esc(this.lastOrder)}</div>` : ''}`,
    );
  }

  private updateLog(): void {
    const w = this.w;
    if (w.logSeq === this.lastLogLen) return;
    this.lastLogLen = w.logSeq;
    const items = w.logEntries
      .slice(-80)
      .reverse()
      .map((e) => `<div class="log-${e.level}"><span class="mono">${fmtTime(e.t)}</span> ${esc(e.msg)}</div>`);
    this.set('log', items.join(''));
  }
}
