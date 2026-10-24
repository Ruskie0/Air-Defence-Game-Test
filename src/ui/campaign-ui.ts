import { CAMPAIGN_DAYS, Campaign, DIFFICULTY, DayReport, Difficulty } from '../campaign/campaign';
import type { View3D } from '../render/view3d';
import { CATALOG, DeployedUnit, RANKS, UnitType, rankOf } from '../sim/catalog';
import { bearingDeg, v3 } from '../sim/math';
import { MAP_TYPES, MAP_TYPE_LIST, MapType } from '../sim/terrain';
import type { World } from '../sim/world';
import type { Ppi } from './ppi';
import { UPGRADES, UPGRADE_ORDER, UpgradeId } from '../campaign/upgrades';
import { objectiveDesc, objectiveName } from '../campaign/objectives';

const SAVE_KEY = 'air-defence-campaign-v1';

const SHOP_ORDER: UnitType[] = ['MR', 'SH', 'CIWS', 'GUN', 'LASER', 'EWR', 'GAP', 'GNSS', 'DECOY', 'CAP', 'LR'];

const $ = (id: string): HTMLElement => document.getElementById(id)!;
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const money = (m: number): string => (m > 0 && m < 10 ? `$${m.toFixed(1)}M` : `$${Math.round(m)}M`);

/** Where the campaign screens hand control back to the game loop. */
export interface CampaignHost {
  view: View3D;
  ppi: Ppi;
  /** Show the planning preview (no simulation running). */
  showPreview(w: World): void;
  /** Start today's battle. */
  startBattle(w: World, c: Campaign): void;
  /** Back to the main menu. */
  toMenu(): void;
  /** Start the sandbox on a new map (of this type, or a random one). */
  startSandbox(type?: MapType): void;
}

/** Saved campaign in this browser, if any. Storage can be unavailable, so every access is guarded. */
export function loadSaved(): Campaign | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    const c = raw ? Campaign.load(raw) : null;
    return c && !c.s.over ? c : null;
  } catch {
    return null;
  }
}

function store(c: Campaign | null): void {
  try {
    if (c && !c.s.over) localStorage.setItem(SAVE_KEY, c.save());
    else localStorage.removeItem(SAVE_KEY);
  } catch {
    /* storage unavailable: the campaign still runs, it just is not kept */
  }
}

/** Main menu, the between-days planning screen (shop, deployment, repairs) and the debrief. */
export class CampaignUi {
  private c: Campaign | null = null;
  private readonly host: CampaignHost;
  /** Unit being placed on the map. */
  private placing: DeployedUnit | null = null;
  /** Unit highlighted in the order of battle. */
  private focus: number | null = null;
  private confirmSell: number | null = null;
  private note = '';
  /** Map type picked on the menu (undefined = random). */
  private mapPick: MapType | undefined;

  constructor(host: CampaignHost) {
    this.host = host;
    document.addEventListener('click', (e) => this.onClick(e));
    document.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this.placing) this.stopPlacing('Placement cancelled.');
    });
  }

  get campaign(): Campaign | null {
    return this.c;
  }

  // ------------------------------------------------------------- menu

  showMenu(): void {
    this.c = null;
    this.stopPlacing();
    document.body.dataset.mode = 'menu';
    const saved = loadSaved();
    $('menu-body').innerHTML = `
      <h2>AIR DEFENCE</h2>
      <p>Command the integrated air defence of an airbase, its command and reporting centre (CRC) and a power plant. Every radar, missile and gun round is simulated.</p>
      <div class="menu-opts">
        <div class="big-group">
          <div class="big-h"><b>New campaign</b>
          <small>${CAMPAIGN_DAYS} days on a new random map. Earn a budget from what still stands, buy and deploy units, and face an enemy that learns from what worked.${saved ? ' Replaces the saved campaign.' : ''}</small></div>
          <div class="diff">${(Object.keys(DIFFICULTY) as Difficulty[])
            .map((d) => `<button data-cui="new" data-diff="${d}" class="${d === 'normal' ? 'go' : ''}"><b>${DIFFICULTY[d].name}</b><small>${DIFFICULTY[d].desc}</small></button>`)
            .join('')}</div>
        </div>
        ${
          saved
            ? `<button data-cui="continue" class="big"><b>Continue campaign</b><small>Day ${saved.s.day} of ${CAMPAIGN_DAYS}, budget ${money(saved.s.money)}, ${saved.units.length} units deployed.</small></button>`
            : ''
        }
        <button data-cui="sandbox" class="big">
          <b>Sandbox</b>
          <small>A fully equipped defence against six scripted raids on a new map, with a panel to spawn any threat. Good for learning the systems.</small>
        </button>
        <div class="big-group">
          <div class="big-h"><b>Map</b><small>Every new campaign and sandbox gets a new 300 km map: pick its kind, or leave it to chance.</small></div>
          <div class="diff maps">
            <button data-cui="map" data-map="" class="${this.mapPick ? '' : 'on'}"><b>Random</b><small>Any of the five</small></button>
            ${MAP_TYPE_LIST.map((m) => `<button data-cui="map" data-map="${m}" class="${this.mapPick === m ? 'on' : ''}" title="${esc(MAP_TYPES[m].blurb)}"><b>${MAP_TYPES[m].name}</b><small>${esc(MAP_TYPES[m].blurb)}</small></button>`).join('')}
          </div>
        </div>
      </div>
      <p class="dim">Press <b>?</b> in the top bar at any time for how the systems work.</p>`;
  }

  newCampaign(seed = Math.floor(Math.random() * 1e6) + 1, difficulty: Difficulty = 'normal', mapType: MapType | undefined = this.mapPick): void {
    this.c = Campaign.create(seed, difficulty, mapType);
    store(this.c);
    this.note = 'Your first units are in their default positions. Move them, buy more, then start the day.';
    this.showPlanning();
  }

  continueCampaign(c: Campaign): void {
    this.c = c;
    this.note = '';
    this.showPlanning();
  }

  // ------------------------------------------------------------- planning

  showPlanning(): void {
    if (!this.c) return;
    document.body.dataset.mode = 'plan';
    $('debrief').classList.add('hidden');
    this.refreshWorld();
    this.host.view.setView('deploy');
    this.render();
  }

  /** Rebuild the preview world after anything on the map changed. */
  private refreshWorld(): void {
    if (!this.c) return;
    this.host.showPreview(this.c.makeWorld(false));
    this.showFocus();
  }

  /** The campaign's map for the briefing. */
  private mapLine(): string {
    return `Terrain: ${this.c!.terrain.describe()}`;
  }

  private label(u: DeployedUnit): string {
    const same = this.c!.units.filter((x) => x.type === u.type);
    return same.length > 1 ? `${CATALOG[u.type].name} ${same.indexOf(u) + 1}` : CATALOG[u.type].name;
  }

  private where(u: DeployedUnit): string {
    const r = Math.hypot(u.x, u.y);
    if (r < 400) return 'at the airbase';
    return `${(r / 1000).toFixed(1)} km, ${Math.round(bearingDeg(v3(), v3(u.x, u.y))).toString().padStart(3, '0')}°`;
  }

  private render(): void {
    const c = this.c;
    if (!c) return;
    const s = c.s;
    const last = s.history[s.history.length - 1];
    $('raid').innerHTML = `<span class="lbl">DAY</span><b>${s.day}</b><span class="dim">/${CAMPAIGN_DAYS}</span> <span class="lbl" style="margin-left:10px">PLANNING</span><span class="dim">${c.diff.name}</span>`;
    $('clock').innerHTML = '';
    $('score').innerHTML = `<span class="chip">Budget <b>${money(s.money)}</b></span>`;

    const shop = SHOP_ORDER.map((t) => {
      const info = CATALOG[t];
      const why = c.canBuy(t);
      const locked = !c.unlocked(t);
      return `<div class="shop-item ${locked ? 'locked' : ''}">
        <div class="shop-h"><b>${info.name}</b><span class="mono">${money(info.costM)}</span></div>
        <div class="dim">${esc(info.role)}</div>
        <div class="row">${locked ? `<span class="st emcon">Day ${info.unlockDay}</span>` : `<button data-cui="buy" data-type="${t}" ${why ? 'disabled' : ''} title="${esc(why ?? 'Buy and place on the map')}">Buy</button>`}</div>
      </div>`;
    }).join('');

    const upgrades = UPGRADE_ORDER.map((id) => {
      const up = UPGRADES[id];
      const why = c.canUpgrade(id);
      const owned = c.has(id);
      const locked = s.day < up.unlockDay;
      return `<div class="shop-item ${locked ? 'locked' : ''}">
        <div class="shop-h"><b>${up.name}</b><span class="mono">${owned ? 'owned' : money(up.costM)}</span></div>
        <div class="dim">${esc(up.desc)}</div>
        <div class="row">${owned ? '<span class="st ok">In service</span>' : locked ? `<span class="st emcon">Day ${up.unlockDay}</span>` : `<button data-cui="upgrade" data-id="${id}" ${why ? 'disabled' : ''} title="${esc(why ?? 'Buy this upgrade for the rest of the campaign')}">Buy</button>`}</div>
      </div>`;
    }).join('');

    const intel = c.intel();
    $('plan-left').innerHTML = `
      <h3>Intelligence briefing, day ${s.day}</h3>
      <p class="dim">${esc(this.mapLine())}</p>
      <ul class="intel">${intel.map((l) => `<li>${esc(l)}</li>`).join('') || '<li class="dim">Nothing reported.</li>'}</ul>
      <h3>Bonus objectives</h3>
      <ul class="intel">${(s.objectives ?? []).map((o) => `<li><b>${esc(objectiveName(o))}</b> <span class="mono">+${money(o.rewardM)}</span>: ${esc(objectiveDesc(o))}</li>`).join('') || '<li class="dim">None today.</li>'}</ul>
      ${last?.lessons.length ? `<h3>Enemy assessment</h3><ul class="intel">${last.lessons.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
      <h3>Procurement <span class="dim">budget ${money(s.money)}</span></h3>
      <div class="shop">${shop}</div>
      <h3>Upgrades <span class="dim">one-off, for the rest of the campaign</span></h3>
      <div class="shop">${upgrades}</div>`;

    const assets = s.deployment.assets
      .map((a) => {
        const cost = c.repairCost(a.name);
        const col = a.hp > 60 ? '#5ee07a' : a.hp > 25 ? '#ffd84d' : '#ff4d4d';
        return `<div class="asset"><span>${a.name}</span><span class="bar"><i style="width:${a.hp}%;background:${col}"></i></span>
          ${cost > 0 ? `<button data-cui="repair" data-name="${a.name}" ${s.money > 0 ? '' : 'disabled'} title="Full repair ${money(cost)}; a partial repair uses what you have">Repair ${money(Math.min(cost, s.money))}</button>` : '<span class="dim">intact</span>'}</div>`;
      })
      .join('');

    const units = c.units
      .map((u) => {
        const info = CATALOG[u.type];
        const rows: string[] = [];
        const btn = (act: string, text: string, cost: number | null, title = ''): string =>
          cost === null ? '' : `<button data-cui="${act}" data-uid="${u.uid}" ${cost > s.money ? 'disabled' : ''} title="${esc(title)}">${text} ${money(cost)}</button>`;
        if (u.launchers.length) {
          const rounds = u.launchers.reduce((t, l) => t + l.rounds, 0);
          const max = u.launchers.reduce((t, l) => t + l.max, 0);
          rows.push(`Missiles <b>${rounds}</b>/${max}${u.spares ? ` +${u.spares} spare` : ''} · ${u.launchers.length} launcher${u.launchers.length > 1 ? 's' : ''}`);
        }
        if (u.type === 'CAP') rows.push(`Aircraft <b>${u.aircraft}</b>/2 · station ${(Math.hypot(u.x, u.y) / 1000).toFixed(0)} km out`);
        if (u.xp || u.launchers.length || u.type === 'CIWS' || u.type === 'GUN' || u.type === 'LASER') {
          const rank = rankOf(u.xp);
          const next = RANKS[rank + 1];
          rows.push(`Crew <b>${RANKS[rank].name} ${RANKS[rank].badge}</b> · ${u.xp ?? 0} kills${next ? `, ${next.xp - (u.xp ?? 0)} to ${next.name}` : ''}`);
        }
        if (c.spotted(u)) rows.push(`<span class="bad">Photographed by enemy recon: strikes may be aimed here. Move it to dodge them.</span>`);
        if (info.sector) rows.push(`Sector facing <b>${Math.round(u.facing).toString().padStart(3, '0')}°</b> (±60°)`);
        const reload = c.reloadCost(u);
        const actions = [
          `<button data-cui="move" data-uid="${u.uid}" class="${this.placing === u ? 'on' : ''}">${this.placing === u ? 'Placing…' : 'Move'}</button>`,
          info.sector ? `<button data-cui="turn" data-uid="${u.uid}" data-d="-30" title="Turn the sector 30° left">⟲</button><button data-cui="turn" data-uid="${u.uid}" data-d="30" title="Turn the sector 30° right">⟳</button>` : '',
          reload > 0 ? btn('reload', 'Reload', reload, 'Fill every launcher') : '',
          u.launchers.length ? btn('spares', '+4 spares', c.sparesCost(u), 'Spare missiles reload the launchers during the day') : '',
          btn('launcher', '+Launcher', c.launcherCost(u), 'One more loaded launcher'),
          btn('aircraft', 'Replace fighter', c.replaceAircraftCost(u)),
          `<button data-cui="sell" data-uid="${u.uid}" class="${this.confirmSell === u.uid ? 'warn' : ''}" title="Scrap for a fifth of the price">${this.confirmSell === u.uid ? `Confirm +${money(info.costM * 0.2)}` : 'Sell'}</button>`,
        ].join('');
        return `<div class="sys ${this.focus === u.uid ? 'focus' : ''}" data-cui="focus" data-uid="${u.uid}">
          <div class="sys-h"><b>${this.label(u)}</b> <span class="dim">${this.where(u)}</span></div>
          ${rows.map((r) => `<div class="sys-b">${r}</div>`).join('')}
          <div class="sys-b btns">${actions}</div></div>`;
      })
      .join('');

    $('plan-right').innerHTML = `
      <h3>Defended assets <span class="dim">income tomorrow ${money(c.income())}</span></h3>
      <div class="assets">${assets}</div>
      <h3>Order of battle <span class="dim">${c.units.length} units</span></h3>
      ${this.note ? `<div class="order">${esc(this.note)}</div>` : ''}
      <div class="oob">${units || '<div class="dim">No units. Buy some from the procurement list.</div>'}</div>
      <div class="plan-go"><button data-cui="start" class="go big-go">Start day ${s.day} ▶</button></div>`;
  }

  private showFocus(): void {
    const u = this.focus !== null ? this.c?.unit(this.focus) : undefined;
    if (!u || this.placing) {
      if (!this.placing) this.host.view.setPreview(null);
      return;
    }
    const info = CATALOG[u.type];
    this.host.view.setPreview(v3(u.x, u.y), info.rangeKm, true, info.sector ? { facing: u.facing, half: 60 } : undefined);
  }

  private startPlacing(u: DeployedUnit): void {
    const c = this.c!;
    const info = CATALOG[u.type];
    this.placing = u;
    this.focus = u.uid;
    this.note = `Click the map to place the ${this.label(u)}. Esc cancels.`;
    const v = this.host.view;
    v.onGroundHover = (p) => {
      if (!p) return v.setPreview(null);
      const err = c.placeError(c.terrain, u.type, p.x, p.y, u.uid);
      v.setPreview(p, info.rangeKm, !err, info.sector ? { facing: u.facing, half: 60 } : undefined);
      v.renderer.domElement.title = err ?? '';
    };
    v.onGroundClick = (p) => {
      const err = c.place(c.terrain, u, p.x, p.y);
      if (err) {
        this.note = err;
        this.render();
        return;
      }
      this.stopPlacing(`${this.label(u)} placed ${this.where(u)}.`);
      store(c);
      this.refreshWorld();
    };
    this.render();
  }

  private stopPlacing(note?: string): void {
    this.placing = null;
    const v = this.host.view;
    v.onGroundClick = null;
    v.onGroundHover = null;
    v.renderer.domElement.title = '';
    v.setPreview(null);
    if (note !== undefined) {
      this.note = note;
      this.showFocus();
      this.render();
    }
  }

  // ------------------------------------------------------------- the day

  /** Called by the battle HUD's End day button. */
  endDay(w: World): void {
    const c = this.c;
    if (!c) return;
    const r = c.settle(w);
    store(c);
    this.showDebrief(r);
  }

  private showDebrief(r: DayReport): void {
    const c = this.c!;
    const over = c.s.over;
    document.body.dataset.mode = 'debrief';
    const dmg = r.damage.filter((d) => d.lost > 0);
    $('debrief-body').innerHTML = `
      <h2>${over ? (over.won ? 'Campaign won' : 'Campaign lost') : `Day ${r.day} debrief`}</h2>
      ${over ? `<p class="${over.won ? 'good' : 'bad'}"><b>${esc(over.reason)}</b></p>` : ''}
      <div class="kv">
        <span>Threats destroyed</span><b>${r.kills}</b>
        ${
          r.killsBy && Object.keys(r.killsBy).length
            ? `<span class="dim">by unit</span><b class="dim">${Object.entries(r.killsBy)
                .sort((a, b) => b[1] - a[1])
                .map(([k, n]) => `${esc(k)}: ${n}`)
                .join(' · ')}</b>`
            : ''
        }
        <span>Leakers (hits on defended or AD sites)</span><b>${r.leakers}</b>
        <span>Missiles fired</span><b>${r.missilesFired} (${money(r.missileCostM)})</b>
        ${r.civilian ? `<span class="bad">Civil airliners shot down</span><b class="bad">${r.civilian}</b>` : ''}
        ${r.fratricide ? `<span class="bad">Friendly aircraft shot down</span><b class="bad">${r.fratricide}</b>` : ''}
      </div>
      ${
        r.objectives?.length
          ? `<h3>Bonus objectives</h3><ul class="intel">${r.objectives
              .map((o) => `<li class="${o.done ? 'good' : 'dim'}">${o.done ? '✓' : '✗'} ${esc(o.name)} ${o.done ? `+${money(o.rewardM)}` : ''}</li>`)
              .join('')}</ul>`
          : ''
      }
      <h3>Damage</h3>
      <p>${dmg.length ? dmg.map((d) => `${d.name} −${d.lost} (now ${d.hp}%)`).join(', ') : 'No damage to the defended assets.'}</p>
      ${r.promotions?.length ? `<h3>Promotions</h3><p class="good">${r.promotions.map(esc).join(', ')}</p>` : ''}
      ${r.losses.length ? `<h3>Equipment lost</h3><p>${r.losses.map(esc).join(', ')}</p>` : ''}
      ${r.lessons.length ? `<h3>Enemy assessment</h3><ul class="intel">${r.lessons.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
      ${
        over
          ? `<p>Final score <b>${c.score()}</b> over ${c.s.history.length} days.</p>
             <div class="menu-opts row"><button data-cui="new" class="go">New campaign</button><button data-cui="menu">Main menu</button></div>`
          : `<p>Budget for tomorrow: <b>${money(c.s.money)}</b> (income ${money(r.income)}: the assets still working${r.objectives?.some((o) => o.done) ? ' plus objective bonuses' : ''}).</p>
             <div class="row"><button data-cui="plan" class="go">Plan day ${c.s.day} ▶</button><button data-cui="menu">Save and quit</button></div>`
      }`;
    $('debrief').classList.remove('hidden');
  }

  // ------------------------------------------------------------- input

  private onClick(e: MouseEvent): void {
    const el = (e.target as HTMLElement).closest('[data-cui]') as HTMLElement | null;
    if (!el || (el as HTMLButtonElement).disabled) return;
    const c = this.c;
    const d = el.dataset;
    const u = d.uid ? c?.unit(Number(d.uid)) : undefined;
    if (d.cui !== 'sell' && d.cui !== 'focus') this.confirmSell = null;
    switch (d.cui) {
      case 'new':
        $('debrief').classList.add('hidden');
        this.newCampaign(undefined, (d.diff as Difficulty | undefined) ?? this.c?.s.difficulty ?? 'normal');
        return;
      case 'continue': {
        const saved = loadSaved();
        if (saved) this.continueCampaign(saved);
        return;
      }
      case 'sandbox':
        this.host.startSandbox(this.mapPick);
        return;
      case 'map':
        this.mapPick = (d.map || undefined) as MapType | undefined;
        this.showMenu();
        return;
      case 'menu':
        $('debrief').classList.add('hidden');
        this.host.toMenu();
        return;
      case 'plan':
        this.note = '';
        this.focus = null;
        this.showPlanning();
        return;
    }
    if (!c) return;
    e.stopPropagation();
    switch (d.cui) {
      case 'focus':
        if (u && this.focus !== u.uid) {
          this.focus = u.uid;
          this.showFocus();
          this.render();
        }
        return;
      case 'buy': {
        const t = d.type as UnitType;
        const nu = c.buy(t);
        if (!nu) return;
        store(c);
        this.refreshWorld();
        this.startPlacing(nu);
        return;
      }
      case 'upgrade':
        if (!c.upgrade(d.id as UpgradeId)) return;
        this.note = `${UPGRADES[d.id as UpgradeId].name} bought.`;
        break;
      case 'move':
        if (!u) return;
        if (this.placing === u) this.stopPlacing('Placement cancelled.');
        else this.startPlacing(u);
        return;
      case 'turn':
        if (!u) return;
        c.turn(c.terrain, u, u.facing + Number(d.d));
        this.focus = u.uid;
        break;
      case 'reload':
        if (u) c.reload(u);
        break;
      case 'spares':
        if (u) c.buySpares(u);
        break;
      case 'launcher':
        if (u) c.addLauncher(u);
        break;
      case 'aircraft':
        if (u) c.replaceAircraft(u);
        break;
      case 'sell':
        if (!u) return;
        if (this.confirmSell !== u.uid) {
          this.confirmSell = u.uid;
          this.render();
          return;
        }
        this.confirmSell = null;
        if (this.placing === u) this.stopPlacing();
        c.sell(u);
        this.note = `${CATALOG[u.type].name} sold.`;
        if (this.focus === u.uid) this.focus = null;
        break;
      case 'repair':
        c.repair(d.name!);
        break;
      case 'start':
        this.stopPlacing();
        this.focus = null;
        store(c);
        this.host.startBattle(c.makeWorld(), c);
        return;
      default:
        return;
    }
    store(c);
    this.refreshWorld();
    this.render();
  }
}
