import type { View3D } from '../render/view3d';
import { bearingDeg, dist, headingOf, v3 } from '../sim/math';
import { THREAT_LABELS, ThreatType, spawnThreat } from '../sim/threats';
import { missilesOnTrack, timeToGo } from '../sim/tewa';
import type { Ident, Track } from '../sim/tracker';
import type { Wcs } from '../sim/tewa';
import type { World } from '../sim/world';
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
  private readonly w: World;
  private readonly view: View3D;
  private readonly ppi: Ppi;
  private readonly ctl: GameControl;
  selected: number | null = null;
  private lastOrder = '';
  private nextSlow = 0;
  private lastLogLen = -1;
  private cache = new Map<string, string>();

  constructor(w: World, view: View3D, ppi: Ppi, ctl: GameControl) {
    this.w = w;
    this.view = view;
    this.ppi = ppi;
    this.ctl = ctl;
    view.onSelect = (id) => this.select(id);
    ppi.onSelect = (id) => this.select(id);
    this.buildStatic();
    document.addEventListener('pointerdown', (e) => this.onAction(e));
    document.addEventListener('keydown', (e) => this.onKey(e));
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
    } else if (e.code === 'Escape') {
      this.select(null);
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
      case 'ciws': {
        const c = w.ciws.find((x) => x.code === d.code);
        if (c) {
          c.auto = !c.auto;
          w.log(`${c.name} ${c.auto ? 'AUTO' : 'HOLD'}`, 'info');
        }
        break;
      }
      case 'gnss':
        w.gnss.on = !w.gnss.on;
        w.log(`GNSS jammer ${w.gnss.on ? 'ON' : 'OFF'}`, 'info');
        break;
      case 'decoy':
        w.decoy.on = !w.decoy.on;
        w.log(`Radar decoy ${w.decoy.on ? 'radiating' : 'off'}`, 'info');
        break;
      case 'cap-station':
        w.fighters[Number(d.i)].toStation(w);
        break;
      case 'cap-rtb':
        w.fighters[Number(d.i)].rtb(w);
        break;
      case 'sel':
        this.select(Number(d.id));
        break;
      case 'engage': {
        const tr = this.resolve();
        if (tr) this.lastOrder = `${d.code}: ${w.engage(tr.id, d.code as 'LR' | 'MR' | 'SH')}`;
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
    if (!r) {
      this.set('raid', `<span class="lbl">RAIDS</span> all six launched${w.scenario.done ? ', sandbox clear' : ''}`);
      return;
    }
    const n = w.scenario.raids.indexOf(r);
    this.set(
      'raid',
      `<span class="lbl">NEXT</span><span title="${esc(r.desc)}">${esc(r.name)}</span> <span class="mono">in ${fmtTime(r.t - w.t)}</span>` +
        `<button data-act="raid">Launch now</button><span class="dim">${n}/6 launched</span>`,
    );
  }

  private updateScore(): void {
    const s = this.w.stats;
    const fired = s.fired.LR + s.fired.MR + s.fired.SH + s.fired.AAM;
    this.set(
      'score',
      `<span class="chip">Kills <b>${s.kills}</b></span><span class="chip ${s.leakers ? 'bad' : ''}">Leakers <b>${s.leakers}</b></span>` +
        `<span class="chip" title="LR ${s.fired.LR} · MR ${s.fired.MR} · SHORAD ${s.fired.SH} · AAM ${s.fired.AAM} · CIWS rounds ${s.ciwsRounds}">Missiles <b>${fired}</b> ($${s.costM.toFixed(1)}M)</span>` +
        (s.fratricide || s.civilian ? `<span class="chip bad">Fratricide ${s.fratricide} · Civil ${s.civilian}</span>` : ''),
    );
  }

  private radarState(code: string): string {
    const r = this.w.radarByCode(code);
    if (!r) return '';
    if (!r.alive) return '<span class="st dead">DESTROYED</span>';
    if (!r.emitting) return '<span class="st emcon">EMCON</span>';
    const j = r.sideJnrDb > 0 ? ` <span class="st jam" title="Sidelobe jam-to-noise">J/N ${r.sideJnrDb.toFixed(0)} dB</span>` : '';
    return `<span class="st ok">RADIATE</span>${j}`;
  }

  private updateSystems(): void {
    const w = this.w;
    const rows: string[] = ['<h3>Fire units</h3>'];
    for (const u of w.units) {
      const r = u.radar!;
      const active = u.activeTargets(w).size;
      const reload = u.launchers.filter((l) => l.reloadAt > 0 && l.site.alive);
      rows.push(`<div class="sys">
        <div class="sys-h"><b>${u.name}</b> ${this.radarState(r.code)}</div>
        <div class="sys-b">Missiles <b>${u.rounds}</b>/${u.maxRounds} · Channels ${active}/${u.channels}${reload.length ? ` · reload ${fmtTime(Math.min(...reload.map((l) => l.reloadAt)) - w.t)}` : ''}
        <button data-act="emcon" data-code="${r.code}" ${r.alive ? '' : 'disabled'}>${r.emitting ? 'EMCON' : 'Radiate'}</button></div></div>`);
    }
    for (const c of w.ciws) {
      const st = !c.site.alive
        ? '<span class="st dead">DESTROYED</span>'
        : c.ammo === 0
          ? '<span class="st emcon">RELOAD</span>'
          : c.firing
            ? '<span class="st jam">FIRING</span>'
            : c.target
              ? '<span class="st ok">TRACK</span>'
              : c.auto
                ? '<span class="st ok">AUTO</span>'
                : '<span class="st emcon">HOLD</span>';
      rows.push(`<div class="sys"><div class="sys-h"><b>${c.name}</b> ${st}</div>
        <div class="sys-b">Rounds <b>${c.ammo}</b>/${c.maxAmmo} <button data-act="ciws" data-code="${c.code}" ${c.site.alive ? '' : 'disabled'}>${c.auto ? 'Hold' : 'Auto'}</button></div></div>`);
    }
    rows.push('<h3>Electronic warfare</h3>');
    rows.push(`<div class="sys"><div class="sys-h"><b>GNSS jammer</b> ${w.gnss.site.alive ? (w.gnss.on ? '<span class="st jam">ON</span>' : '<span class="st">OFF</span>') : '<span class="st dead">DESTROYED</span>'}
      <button data-act="gnss">${w.gnss.on ? 'Off' : 'On'}</button></div><div class="sys-b dim">30 km, drags GNSS-guided drones off target</div></div>`);
    rows.push(`<div class="sys"><div class="sys-h"><b>Radar decoy</b> ${w.decoy.alive ? (w.decoy.on ? '<span class="st jam">RADIATE</span>' : '<span class="st">OFF</span>') : '<span class="st dead">DESTROYED</span>'}
      <button data-act="decoy">${w.decoy.on ? 'Off' : 'On'}</button></div><div class="sys-b dim">Mimics the LR radar for ARM seekers</div></div>`);
    rows.push('<h3>Combat air patrol</h3>');
    w.fighters.forEach((f, i) => {
      const tr = f.targetTrackId !== null ? w.tracker.get(f.targetTrackId) : undefined;
      const st = !f.alive ? 'LOST' : f.state === 'ground' ? `REARM ${fmtTime(f.groundUntil - w.t)}` : f.state === 'intercept' ? `INTERCEPT ${tr?.label ?? ''}` : f.state.toUpperCase();
      rows.push(`<div class="sys"><div class="sys-h"><b>${f.name}</b> <span class="st ${f.alive ? 'ok' : 'dead'}">${st}</span></div>
        <div class="sys-b">AAM <b>${f.missiles}</b> · Fuel ${Math.round((100 * f.fuel) / f.maxFuel)}%
        <button data-act="cap-station" data-i="${i}" ${f.alive && f.airborne ? '' : 'disabled'}>CAP</button><button data-act="cap-rtb" data-i="${i}" ${f.alive && f.airborne ? '' : 'disabled'}>RTB</button></div></div>`);
    });
    rows.push('<h3>Defended assets</h3>');
    const hurt = w.sites.filter((s) => s.defended || s.hp < 100);
    rows.push(
      '<div class="assets">' +
        hurt
          .map((s) => `<div class="asset ${s.alive ? '' : 'dead'}"><span>${s.name}</span><span class="bar"><i style="width:${s.hp}%;background:${s.hp > 60 ? '#5ee07a' : s.hp > 25 ? '#ffd84d' : '#ff4d4d'}"></i></span></div>`)
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

  private updateDetail(): void {
    const w = this.w;
    const tr = this.resolve();
    if (!tr) {
      this.set(
        'detail',
        `<h3>Track</h3><div class="dim">Select a track in the table, on the PPI, or click its label in the 3D view. Hostiles are engaged automatically under WCS TIGHT (hostile only) and FREE (anything not friend or neutral).</div>`,
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
      `<h3 style="color:${IDENT_COLOR[tr.ident]}">${tr.label} · ${IDENT_NAME[tr.ident]} · ${CLASS_NAME[tr.cls]}</h3>
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
