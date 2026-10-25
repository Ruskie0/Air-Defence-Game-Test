import type { HurtBy } from '../sim/world';
import { dismissTip, tip } from './onboard';
import { loadBest } from '../campaign/laststand';
import { MEDALS, MedalId, earnedMedals } from '../campaign/medals';
import { ARMOUR_BDE, ARMOUR_STRIKE, CAMPAIGN_DAYS, Campaign, DIFFICULTY, DayReport, Difficulty, REPAIR_CREW } from '../campaign/campaign';
import { ARMOUR } from '../sim/enemyarmour';
import { DELIVERY_H, PULSES, hhmm, stamp } from '../campaign/clock';
import type { View3D } from '../render/view3d';
import { CATALOG, DeployedUnit, RANKS, UnitType, rankOf } from '../sim/catalog';
import { bearingDeg, v3 } from '../sim/math';
import { MAP_TYPES, MAP_TYPE_LIST, MapType } from '../sim/terrain';
import type { World } from '../sim/world';
import type { Ppi } from './ppi';
import { UPGRADES, UPGRADE_ORDER, UpgradeId } from '../campaign/upgrades';
import { objectiveDesc, objectiveName } from '../campaign/objectives';
import { EVENTS } from '../campaign/events';
import { DEEP_STRIKES, DeepStrikeId, deepStrike, deepStrikeError, strikeTargets } from '../campaign/deepstrike';
import { type Asset, BASE_DEFS, assetCount, stockText } from '../sim/theatre';
import { ASSAULT_HOLD, DEVASTATED_ZONE_M, OFFENSIVE_COST_M, TOWN_THREAT_CUT, TOWN_ZONE_M, dugIn, nextObjective } from '../campaign/front';

const SAVE_KEY = 'air-defence-campaign-v1';

const SHOP_ORDER: UnitType[] = ['MR', 'SH', 'CIWS', 'GUN', 'LASER', 'EWR', 'GAP', 'GNSS', 'DECOY', 'JAM', 'CAP', 'LR'];

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
  startTraining(lesson?: 'basics' | 'front'): void;
  startLastStand(type?: MapType): void;
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
    const best = loadBest();
    const got = earnedMedals();
    $('menu-body').innerHTML = `
      <h2>AIR DEFENCE</h2>
      <p>Command the integrated air defence of an airbase, its command and reporting centre (CRC) and a power plant. Every radar, missile and gun round is simulated.</p>
      <div class="menu-opts">
        <button data-cui="training" class="big ${saved ? '' : 'go'}">
          <b>Training</b>
          <small>New here? A short guided battle: tracks, weapons control, firing by hand and dealing with radar-hunting SEAD. About ten minutes.</small>
        </button>
        <button data-cui="training-front" class="big">
          <b>Training: the front</b>
          <small>The second lesson: get an assault column up the road, sweep an enemy SAM site, shoot and scoot, and call a supply convoy.</small>
        </button>
        <div class="big-group">
          <div class="big-h"><b>New campaign</b>
          <small>${CAMPAIGN_DAYS} days on a new random map. Earn a budget from what still stands, buy and deploy units, and face an enemy that learns from what worked.${saved ? ' Replaces the saved campaign.' : ''}</small></div>
          <div class="diff">${(Object.keys(DIFFICULTY) as Difficulty[])
            .map((d) => `<button data-cui="new" data-diff="${d}" class="${d === 'normal' ? 'go' : ''}"><b>${DIFFICULTY[d].name}</b><small>${DIFFICULTY[d].desc}</small></button>`)
            .join('')}</div>
        </div>
        ${
          saved
            ? `<button data-cui="continue" class="big"><b>Continue campaign</b><small>${esc(stamp(saved.clock))} of ${CAMPAIGN_DAYS} days, budget ${money(saved.s.money)}, ${saved.units.length} units deployed. Saved automatically between raids.</small></button>`
            : ''
        }
        <button data-cui="laststand" class="big">
          <b>Last Stand</b>
          <small>One battle against endless waves that grow each time. Hold a wave, pick one of three reinforcements, go again. How long can the airbase last?${best ? ` Your best: ${best} wave${best === 1 ? '' : 's'}.` : ''}</small>
        </button>
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
        <div class="big-group">
          <div class="big-h"><b>Medals ${Object.keys(got).length}/${Object.keys(MEDALS).length}</b><small>Career awards, kept across every campaign and Last Stand run.</small></div>
          <div class="medals">${(Object.keys(MEDALS) as MedalId[])
            .map((id) => `<span class="medal ${got[id] ? 'got' : ''}" title="${esc(MEDALS[id].desc)}${got[id] ? ` Earned ${got[id]}.` : ''}">${got[id] ? '★' : '☆'} ${esc(MEDALS[id].name)}</span>`)
            .join('')}</div>
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
  /** Hire an extra repair crew: faster repairs between raids, for money that could buy a unit. */
  private crewRow(c: Campaign): string {
    const n = c.s.repairCrews ?? 0;
    const why = c.crewError();
    return `<div class="asset"><span>Repair crews <span class="dim">${1 + n} at work, ${c.repairPerH} points an hour</span></span><span></span>
      <button data-cui="crew" ${why ? 'disabled' : ''} title="${esc(why ?? `Hire another crew for the rest of the war (${money(REPAIR_CREW.costM)}): repairs between raids go ${Math.round(((2 + n) / (1 + n) - 1) * 100)}% faster. That is three quarters of a SHORAD unit.`)}">Hire crew ${money(REPAIR_CREW.costM)}</button></div>`;
  }

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
    $('raid').innerHTML = `<span class="lbl">DAY</span><b>${s.day}</b><span class="dim">/${CAMPAIGN_DAYS}</span> <span class="lbl" style="margin-left:10px">PLANNING</span><span class="dim">${c.diff.name} · saved</span>`;
    $('clock').innerHTML = `<b>${hhmm(c.clock)}</b> <span class="rate paused">CLOCK STOPPED</span>`;
    $('score').innerHTML = `<span class="chip">Budget <b>${money(s.money)}</b></span>`;

    const shop = SHOP_ORDER.map((t) => {
      const info = CATALOG[t];
      const why = c.canBuy(t);
      const locked = !c.unlocked(t);
      return `<div class="shop-item ${locked ? 'locked' : ''}">
        <div class="shop-h"><b>${info.name}</b><span class="mono">${money(c.price(t))}</span></div>
        <div class="dim">${esc(info.role)}</div>
        <div class="row">${locked ? `<span class="st emcon">Day ${info.unlockDay}</span>` : `<button data-cui="buy" data-type="${t}" ${why ? 'disabled' : ''} title="${esc(why ?? (c.started ? `Buy and place on the map. It reaches the depot ${DELIVERY_H[t]} h after ordering and sits out raids until then` : 'Buy and place on the map'))}">Buy</button>${c.started ? ` <span class="dim">arrives in ${DELIVERY_H[t]} h</span>` : ''}`}</div>
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
    const ev = s.event ? EVENTS[s.event] : null;
    const event = ev
      ? `<div class="event"><h3>${esc(ev.title)}</h3><p>${esc(ev.text)}</p><div class="row">${ev.choices
          .map((ch, i) => {
            const why = c.eventChoiceError(i);
            const price = ch.costM ? (ch.costM > 0 ? ` (${money(ch.costM)})` : ` (+${money(-ch.costM)})`) : '';
            return `<button data-cui="event" data-i="${i}" ${why ? 'disabled' : ''} title="${esc(why ?? ch.detail)}"><b>${esc(ch.label)}${price}</b><br><small class="dim">${esc(ch.detail)}</small></button>`;
          })
          .join('')}</div></div>`
      : s.eventResult
        ? `<div class="event dim">${esc(s.eventResult)}</div>`
        : '';
    const strikes = s.deepStrike
      ? `<div class="event ${s.deepStrike.ok ? '' : 'dim'}">${esc(s.deepStrike.text)}</div>`
      : strikeTargets(c)
          .map((b) => {
            const d = DEEP_STRIKES[b.kind]!;
            const why = deepStrikeError(c, b.id);
            const locked = s.day < d.unlockDay;
            return `<div class="shop-item ${locked ? 'locked' : ''}">
              <div class="shop-h"><b>${esc(b.name)}</b><span class="mono">${money(d.costM)} · ${Math.round(d.chance * 100)}%</span></div>
              <div class="dim">${esc(d.desc)} Holds ${esc(stockText(b))}.</div>
              <div class="row">${locked ? `<span class="st emcon">Day ${d.unlockDay}</span>` : `<button data-cui="deepstrike" data-id="${b.id}" ${why ? 'disabled' : ''} title="${esc(why ?? `${Math.round(d.chance * 100)}% chance. If it works, half of what it holds is destroyed for good, and the next raid's packages from it are cut`)}">Strike</button>`}</div>
            </div>`;
          })
          .join('') || '<div class="dim">No enemy installation is located yet. Bases show up once they launch something.</div>';
    $('plan-left').innerHTML = `
      <h3>Situation, ${esc(stamp(c.clock))}</h3>
      ${this.situationMap()}
      ${event}
      ${this.frontPanel()}
      <h3>Intelligence briefing, ${esc(stamp(c.clock))}</h3>
      <p class="dim">${esc(this.mapLine())}</p>
      <ul class="intel">${intel.map((l) => `<li>${esc(l)}</li>`).join('') || '<li class="dim">Nothing reported.</li>'}</ul>
      ${this.enemyPanel()}
      <h3>Bonus objectives</h3>
      <ul class="intel">${(s.objectives ?? []).map((o) => `<li><b>${esc(objectiveName(o))}</b> <span class="mono">+${money(o.rewardM)}</span>: ${esc(objectiveDesc(o))}</li>`).join('') || '<li class="dim">None for this raid.</li>'}</ul>
      <h3>Deep strike <span class="dim">one a day, between raids</span></h3>
      <div class="shop">${strikes}</div>
      ${last?.lessons.length ? `<h3>Enemy assessment</h3><ul class="intel">${last.lessons.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
      <h3>Procurement <span class="dim">budget ${money(s.money)}</span></h3>
      <div class="shop">${shop}</div>
      <h3>Upgrades <span class="dim">one-off, for the rest of the campaign</span></h3>
      <div class="shop">${upgrades}</div>`;

    const towns = (s.front?.towns ?? [])
      .map((t, i) => {
        if (!t.ours) return '';
        const cost = c.townRepairCost(i);
        const col = t.hp > 60 ? '#5ee07a' : t.hp > 25 ? '#ffd84d' : '#ff4d4d';
        return `<div class="asset"><span>${esc(t.name)} <span class="dim">+${money(t.incomeM)}/day</span></span><span class="bar"><i style="width:${t.hp}%;background:${col}"></i></span>
          ${cost > 0 ? `<button data-cui="repairtown" data-i="${i}" ${s.money > 0 ? '' : 'disabled'} title="Rebuild: a battered town pays less, and a town knocked flat falls">Repair ${money(Math.min(cost, s.money))}</button>` : '<span class="dim">intact</span>'}</div>`;
      })
      .join('');
    const assets = s.deployment.assets
      .map((a) => {
        const cost = c.repairCost(a.name);
        const col = a.hp > 60 ? '#5ee07a' : a.hp > 25 ? '#ffd84d' : '#ff4d4d';
        const done = c.repairDone(a.name);
        const working = done !== null ? ` <span class="dim" title="Repair crews restore ${c.repairPerH} points an hour">+${Math.round(c.repairing(a.name))} by ${hhmm(done)}</span>` : '';
        return `<div class="asset"><span>${a.name}${working}</span><span class="bar"><i style="width:${a.hp}%;background:${col}"></i></span>
          ${cost > 0 ? `<button data-cui="repair" data-name="${a.name}" ${s.money > 0 ? '' : 'disabled'} title="Full repair ${money(cost)}; a partial repair uses what you have.${c.started ? ` The crews restore ${c.repairPerH} points an hour.` : ''}">Repair ${money(Math.min(cost, s.money))}</button>` : '<span class="dim">intact</span>'}</div>`;
      })
      .join('') + this.crewRow(c);

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
        const dmg = c.unitDamage(u);
        if (dmg.done !== null) rows.push(`<span class="${dmg.hp < 40 ? 'bad' : 'warn'}">Damaged in an earlier raid: down to ${Math.round(dmg.hp)}%. The crew has it repaired by ${hhmm(dmg.done)}; another hit before then could finish it.</span>`);
        if (u.arrives !== undefined) rows.push(`<span class="warn">On its way: reaches the depot about ${hhmm(u.arrives)}. It sits out raids until then; place it now and it deploys where you put it.</span>`);
        if (c.spotted(u)) rows.push(`<span class="bad">The enemy has a fix on this position (recon photographs or its launches). Strikes may be aimed here: move it to dodge them.</span>`);
        if (info.sector) rows.push(`Sector facing <b>${Math.round(u.facing).toString().padStart(3, '0')}°</b> (±60°)`);
        const reload = c.reloadCost(u);
        const actions = [
          `<button data-cui="move" data-uid="${u.uid}" class="${this.placing === u ? 'on' : ''}">${this.placing === u ? 'Placing…' : 'Move'}</button>`,
          info.sector ? `<button data-cui="turn" data-uid="${u.uid}" data-d="-30" title="Turn the sector 30° left">⟲</button><button data-cui="turn" data-uid="${u.uid}" data-d="30" title="Turn the sector 30° right">⟳</button>` : '',
          reload > 0 ? btn('reload', 'Reload', reload, 'Fill every launcher') : '',
          u.launchers.length ? btn('spares', '+4 spares', c.sparesCost(u), 'Spare missiles reload the launchers during the day') : '',
          btn('launcher', '+Launcher', c.launcherCost(u), 'One more loaded launcher'),
          btn('aircraft', 'Replace fighter', c.replaceAircraftCost(u)),
          u.loan ? '<span class="st ok">On loan until 06:00</span>' : `<button data-cui="sell" data-uid="${u.uid}" class="${this.confirmSell === u.uid ? 'warn' : ''}" title="Scrap for a fifth of the price">${this.confirmSell === u.uid ? `Confirm +${money(info.costM * 0.2)}` : 'Sell'}</button>`,
        ].join('');
        return `<div class="sys ${this.focus === u.uid ? 'focus' : ''}" data-cui="focus" data-uid="${u.uid}">
          <div class="sys-h"><b>${this.label(u)}</b> <span class="dim">${this.where(u)}</span></div>
          ${rows.map((r) => `<div class="sys-b">${r}</div>`).join('')}
          <div class="sys-b btns">${actions}</div></div>`;
      })
      .join('');

    $('plan-right').innerHTML = `
      <h3>Defended assets <span class="dim">income at 06:00 ${money(c.income())}</span></h3>
      <div class="assets">${assets}${towns}</div>
      <h3>Order of battle <span class="dim">${c.units.length} units</span></h3>
      <div class="row restock">${
        c.restockCost() > 0
          ? `<button data-cui="restock" ${s.money > 0 ? '' : 'disabled'} title="Fill every launcher and top spares up to 4 per battery, as far as the budget goes">Restock all ${money(Math.min(c.restockCost(), s.money))}</button>`
          : '<span class="dim">Every battery is stocked.</span>'
      }<label title="Restock automatically at the start of every day"><input type="checkbox" data-cui="autorestock" ${s.autoRestock ? 'checked' : ''}> every morning</label></div>
      ${this.note ? `<div class="order">${esc(this.note)}</div>` : ''}
      <div class="oob">${units || '<div class="dim">No units. Buy some from the procurement list.</div>'}</div>
      <div class="plan-go">${this.goButtons()}</div>`;
  }

  /** The clock controls: on to the next raid, or wait an hour first (orders arrive, repairs go on, units can move). */
  private goButtons(): string {
    const c = this.c!;
    const warn = c.s.warn;
    const when = warn ? ` <small>expected about ${hhmm(warn.at)}</small>` : '';
    const lull = c.started ? tip('lull', 'data-cui') : '';
    const waiting = c.started && (c.units.some((u) => u.arrives !== undefined) || c.s.deployment.assets.some((a) => c.repairing(a.name) > 0));
    const down = c.airbaseDownNote();
    return `${down ? `<p class="warn"><b>${esc(down)}</b></p>` : ''}<button data-cui="start" class="go big-go" title="The clock runs on to the enemy's next operation and the battle starts">Advance to the next raid ▶${when}</button>
      ${lull}${c.started ? `<button data-cui="wait" title="Let an hour pass, to let orders arrive and repairs go on before you reposition. Intel's timings can be out: the enemy may come during the hour">Wait 1 hour${waiting ? '' : ' <small class="dim">nothing pending</small>'}</button>` : ''}`;
  }

  /** The war at a glance: our ground, the road, located enemy installations with what they hold, and where the next raid is expected from. */
  private situationMap(): string {
    const c = this.c!;
    const f = c.s.front;
    const W = 340;
    const H = 230;
    const bases = c.theatre.filter((b) => (b.known || b.lost) && b.kind !== 'rear');
    const pts = [{ x: 0, y: 0 }, ...(f?.towns ?? []), ...bases];
    // Fit the airbase, the road and the located installations, at least 60 km across, with a margin for labels.
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const spanX = Math.max(60000, (Math.max(...xs) - Math.min(...xs)) * 1.3);
    const spanY = Math.max(60000, (Math.max(...ys) - Math.min(...ys)) * 1.3);
    const k = Math.min((W - 60) / spanX, (H - 30) / spanY);
    const reach = Math.max(spanX, spanY) / 2;
    const sx = (x: number): number => W / 2 - 20 + (x - cx) * k;
    const sy = (y: number): number => H / 2 - (y - cy) * k;
    const out: string[] = [];
    for (const z of c.zones) out.push(`<circle cx="${sx(z.x).toFixed(1)}" cy="${sy(z.y).toFixed(1)}" r="${Math.max(3, z.r * k).toFixed(1)}" fill="rgba(70,209,138,0.12)" stroke="rgba(70,209,138,0.5)"/>`);
    if (f?.towns.length) {
      const road = [{ x: 0, y: 0 }, ...f.towns].map((t) => `${sx(t.x).toFixed(1)},${sy(t.y).toFixed(1)}`).join(' ');
      out.push(`<polyline points="${road}" fill="none" stroke="#6b7a70" stroke-dasharray="3 3"/>`);
      f.towns.forEach((t, i) => {
        const col = t.ours ? '#5ee07a' : i === f.offensive ? '#ffd84d' : '#ff6b5b';
        out.push(`<rect x="${(sx(t.x) - 4).toFixed(1)}" y="${(sy(t.y) - 4).toFixed(1)}" width="8" height="8" fill="${col}"><title>${esc(t.name)}${t.ours ? ' (ours)' : ''}</title></rect>`);
        out.push(`<text x="${(sx(t.x) + 6).toFixed(1)}" y="${(sy(t.y) + 3).toFixed(1)}" fill="${col}" font-size="9">${esc(t.name)}${t.airfield ? ' ✈' : ''}</text>`);
      });
    }
    out.push(`<circle cx="${sx(0)}" cy="${sy(0)}" r="4" fill="#46d18a"/><text x="${sx(0) + 6}" y="${sy(0) - 5}" fill="#46d18a" font-size="9">Airbase</text>`);
    const total = (st: Partial<Record<Asset, number>>): number => (Object.keys(st) as Asset[]).reduce((t, a) => t + Math.floor((st[a] ?? 0) + 1e-6), 0);
    for (const b of bases) {
      const x = sx(b.x);
      const y = sy(b.y);
      const full = b.start ? total(b.start) : 0;
      const pct = b.lost ? 0 : full ? Math.min(1, total(b.stock) / full) : 1;
      out.push(`<g opacity="${b.lost ? 0.45 : 1}"><path d="M${x} ${y - 5} L${x + 5} ${y} L${x} ${y + 5} L${x - 5} ${y} Z" fill="none" stroke="#ff6b5b" stroke-width="1.5"><title>${esc(b.name)}: ${b.lost ? 'out of the war' : esc(stockText(b))}</title></path>`);
      if (b.lost) out.push(`<path d="M${x - 5} ${y - 5} L${x + 5} ${y + 5} M${x + 5} ${y - 5} L${x - 5} ${y + 5}" stroke="#ff6b5b"/>`);
      else out.push(`<rect x="${x - 8}" y="${y + 7}" width="16" height="3" fill="#3a2a2a"/><rect x="${x - 8}" y="${y + 7}" width="${(16 * pct).toFixed(1)}" height="3" fill="${pct > 0.6 ? '#ff6b5b' : pct > 0.3 ? '#ffb05b' : '#8a8a8a'}"/>`);
      out.push('</g>');
    }
    // The warning: an arrow in from the expected axis, with the time.
    const warn = c.s.warn;
    if (warn) {
      // From the map edge along the expected bearing, towards the airbase.
      const a = (warn.sector * 45 * Math.PI) / 180;
      const dx = Math.sin(a);
      const dy = -Math.cos(a);
      const bx = sx(0);
      const by = sy(0);
      const edge = Math.min(dx > 0 ? (W - 10 - bx) / dx : dx < 0 ? (10 - bx) / dx : 1e9, dy > 0 ? (H - 10 - by) / dy : dy < 0 ? (16 - by) / dy : 1e9);
      const x0 = bx + dx * edge;
      const y0 = by + dy * edge;
      const x1 = bx + dx * Math.min(edge * 0.45, edge - 24);
      const y1 = by + dy * Math.min(edge * 0.45, edge - 24);
      out.push(`<defs><marker id="sit-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10 Z" fill="#ffd84d"/></marker></defs>`);
      out.push(`<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" stroke="#ffd84d" stroke-width="2.5" marker-end="url(#sit-arrow)"/>`);
      const tx = Math.min(W - 70, Math.max(4, x0 - 30));
      const ty = Math.min(H - 4, Math.max(12, y0 + (y0 < H / 2 ? 14 : -6)));
      out.push(`<text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" fill="#ffd84d" font-size="10">next raid ~${hhmm(warn.at)}</text>`);
    }
    const hidden = c.theatre.filter((b) => !b.known && !b.lost).length;
    const scaleKm = reach > 120000 ? 50 : 25;
    out.push(`<line x1="8" y1="${H - 8}" x2="${8 + scaleKm * 1000 * k}" y2="${H - 8}" stroke="#8a9a90"/><text x="8" y="${H - 12}" fill="#8a9a90" font-size="9">${scaleKm} km</text>`);
    out.push(`<text x="${W - 4}" y="${H - 6}" fill="#8a9a90" font-size="9" text-anchor="end">N ↑${hidden ? ` · ${hidden} enemy site${hidden > 1 ? 's' : ''} not located` : ''}</text>`);
    return `<div class="sitmap"><svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Situation map">${out.join('')}</svg></div>`;
  }

  /** The enemy's installations as far as intel knows them, with what each has left, and what it has lost. */
  private enemyPanel(): string {
    const c = this.c!;
    const bases = c.theatre;
    const total = (b: { stock: Partial<Record<Asset, number>> }): number => (Object.keys(b.stock) as Asset[]).reduce((t, a) => t + Math.floor((b.stock[a] ?? 0) + 1e-6), 0);
    const rows = bases
      .filter((b) => b.known || b.lost)
      .map((b) => {
        const km = (Math.hypot(b.x, b.y) / 1000).toFixed(0);
        if (b.lost) return `<div class="eb dead"><span><b>${esc(b.name)}</b></span><span class="dim">out of the war</span></div>`;
        const full = b.start ? total({ stock: b.start }) : 0;
        const pct = full ? Math.min(100, (100 * total(b)) / full) : 100;
        const col = pct > 60 ? '#ff6b5b' : pct > 30 ? '#ffb05b' : '#8a8a8a';
        return `<div class="eb"><span><b>${esc(b.name)}</b> ${b.kind === 'rear' ? '' : `<span class="dim">${km} km</span>`}<br><small>${esc(stockText(b))}${c.runwayDown(b.id) ? ` · <b>Runway cratered until ${hhmm(c.runwayDown(b.id)!)}</b>` : ''}</small></span><span class="bar" title="Strength left against what it started the war with"><i style="width:${pct}%;background:${col}"></i></span></div>`;
      })
      .join('');
    const hidden = bases.filter((b) => !b.known && !b.lost);
    const kinds = [...new Set(hidden.map((b) => BASE_DEFS[b.kind].name.toLowerCase()))];
    const lost = Object.entries(c.s.enemyLost ?? {}).filter(([, n]) => n! >= 1) as [Asset, number][];
    return `<h3>Enemy order of battle <span class="dim">as far as intel knows</span></h3>${tip('oob', 'data-cui')}
      <div class="enemy-oob">${rows || '<div class="dim">Nothing located yet.</div>'}</div>
      ${hidden.length ? `<p class="dim">Not yet located: ${hidden.length} installation${hidden.length > 1 ? 's' : ''} (${esc(kinds.join(', '))}). Each one shows up once it launches.</p>` : ''}
      ${c.s.front ? `<div class="eb"><span><b>Armour brigade</b> <span class="dim">up the road</span><br><small>${Math.floor(c.armourStock)} battalion${Math.floor(c.armourStock) === 1 ? '' : 's'}: ${c.armourStock >= ARMOUR_BDE.perAttack ? `enough for ${Math.floor(c.armourStock / ARMOUR_BDE.perAttack)} attack${c.armourStock >= 2 * ARMOUR_BDE.perAttack ? 's' : ''}` : 'too weak to attack until reinforced'}. Beaten-off attacks and armour strikes destroy battalions.</small></span><span class="bar"><i style="width:${Math.min(100, (100 * c.armourStock) / ARMOUR_BDE.start)}%;background:#ff6b5b"></i></span></div>` : ''}
      <p class="dim">Destroyed so far: ${lost.length ? esc(lost.map(([a, n]) => assetCount(a, Math.floor(n))).join(', ')) : 'nothing yet'}. What the enemy loses stays lost; it gets a trickle of reinforcements each night.</p>`;
  }

  /** Today's big decision: hold the line, or push up the road to the next town. */
  private frontPanel(): string {
    const c = this.c!;
    const f = c.s.front;
    if (!f?.towns.length) return '';
    const next = nextObjective(f);
    const road = f.towns
      .map((t, i) => {
        const km = (Math.hypot(t.x, t.y) / 1000).toFixed(0);
        const cls = t.ours ? 'good' : i === f.offensive ? 'warn' : 'dim';
        const st = t.ours ? `ours, ${t.hp > 0 ? `${t.hp}%` : '<b>devastated</b>'}${dugIn(t, c.clock) ? ', <b>dug in</b>' : ''}` : i === f.offensive ? 'offensive on' : i === next ? 'next objective' : 'enemy held';
        return `<li class="${cls}"><b>${esc(t.name)}</b> ${km} km · ${st} · +${money(t.incomeM)}/day${t.airfield ? ' · <b>take it to win</b>' : ''}</li>`;
      })
      .join('');
    const why = c.offensiveError();
    const action =
      f.offensive !== null
        ? `<p class="warn">The assault force moves up to ${esc(f.towns[f.offensive].name)} during the next raid. Keep it above ${ASSAULT_HOLD}% until the raid ends. Cover it: units may stand within ${TOWN_ZONE_M / 1000} km of a town we hold.</p>
           <div class="row"><button data-cui="offensive-cancel" title="Call it off for the money back">Call off the offensive</button></div>`
        : next >= 0
          ? `<div class="row"><button data-cui="offensive" class="go" ${why ? 'disabled' : ''} title="${esc(why ?? `The enemy will counter-attack the assault force with drones, missiles, helicopters and jets. It goes in with the next raid: hold it above ${ASSAULT_HOLD}% until the raid ends to take the town. One offensive a day.`)}">Attack ${esc(f.towns[next].name)} ${money(OFFENSIVE_COST_M)}</button>${why ? ` <span class="dim">${esc(why)}</span>` : ''}</div>`
          : '<p class="good">Every town on the road is ours.</p>';
    return `<h3>The front</h3>
      <p class="dim">Towns we hold pay every day, let units deploy round them, and each one past the first cuts the enemy's raids by ${Math.round(TOWN_THREAT_CUT * 100)}%. Raids also go for our front town: one knocked flat is devastated (no income, a ${DEVASTATED_ZONE_M / 1000} km zone) but only falls to enemy armour.</p>
      <ul class="intel road">${road}</ul>
      ${this.pushPanel()}
      ${this.fieldPanel()}
      ${action}`;
  }

  /** Before an assault on the enemy airfield: everything the enemy has ready to throw at it. */
  private fieldPanel(): string {
    const c = this.c!;
    const f = c.s.front!;
    const next = nextObjective(f);
    if (next < 0 || !f.towns[next].airfield || f.offensive !== null) return '';
    const force = c.fieldCounterForce();
    const per: Record<string, number> = {};
    for (const x of force) per[x.kind] = (per[x.kind] ?? 0) + x.n;
    const waves = c.fieldArmourWaves();
    const names: Record<string, string> = { strike: 'strike jets', sead: 'SEAD jets', helo: 'attack helicopters', drones: 'drones', cruise: 'cruise missiles' };
    const parts = Object.entries(per).map(([k, n]) => `${n} ${names[k] ?? k}`);
    parts.push(waves ? `${waves} armour wave${waves > 1 ? 's' : ''} (−${ARMOUR_BDE.counterHp}% each to the force)` : `no armour (the brigade needs ${2 * ARMOUR_BDE.perAttack} battalions to spare any)`);
    const field = c.theatre.find((b) => b.kind === 'airfield' && !b.lost);
    const down = field ? c.runwayDown(field.id) : null;
    return `<div class="event"><h3>The airfield counter-attack</h3>${down ? `<p class="good"><b>Runway cratered until ${hhmm(down)}</b>: no jets or SEAD can fly from it. Assault now and only helicopters, drones, missiles and armour meet the force.</p>` : '<p class="dim">A deep strike that hits the airfield craters its runway for 24 h: assault inside that window and its jets stay on the ground.</p>'}<p>If we assault ${esc(f.towns[next].name)} now, the enemy throws everything it has ready at the assault force: <b>${esc(parts.join(', ') || 'nothing')}</b>. Deep strikes on the airfield and FARP, AWACS hunts and beating off its armour wear this down first.</p></div>`;
  }

  /** The enemy's own attack on one of our towns: when it is coming, and the chance to break it up first. */
  private pushPanel(): string {
    const c = this.c!;
    const p = c.s.enemyPush;
    const f = c.s.front;
    if (!p || !f) return '';
    const town = f.towns[p.town]?.name ?? '';
    if (p.broken) return `<p class="good">The enemy attack on ${esc(town)} was broken up by our strike.</p>`;
    const now = c.pushNow;
    const why = c.armourStrikeError();
    return `<div class="event"><h3>Enemy armour massing at ${esc(f.towns[p.from]?.name ?? '')}</h3>${tip('armour', 'data-cui')}
      <p>${now ? `It attacks ${esc(town)} with the next raid` : `Intel expects it to attack ${esc(town)} in a later raid today`}, behind drones and missiles aimed at the town. If the raids knock the town below ${ARMOUR.takeHp}% while the armour assaults it, the town falls. Cover it with air defence, or hit the armour before it moves.</p>
      <div class="row"><button data-cui="armourstrike" ${why ? 'disabled' : ''} title="${esc(why ?? `${Math.round(ARMOUR_STRIKE.chance * 100)}% chance to break the attack up before it starts`)}">Strike the armour ${money(ARMOUR_STRIKE.costM)} · ${Math.round(ARMOUR_STRIKE.chance * 100)}%</button>${p.struck ? ' <span class="dim">Our strike missed.</span>' : ''}</div></div>`;
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

  /** Called by the battle HUD's End raid button. */
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
      <h2>${over ? (over.won ? `Campaign won${c.s.grade ? `: ${c.s.grade}` : ''}` : over.draw ? 'Stalemate' : 'Campaign lost') : `${r.at !== undefined ? `${esc(stamp(r.at))}, ${r.pulse ? esc(PULSES[r.pulse].name.toLowerCase()) : 'raid'}` : `Day ${r.day}`} debrief`}</h2>
      ${over ? `<p class="${over.won ? 'good' : over.draw ? 'warn' : 'bad'}"><b>${esc(over.reason)}</b></p>` : ''}
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
        ${r.hurt?.length ? `<span>What hurt you</span><b>${r.hurt.map((h) => `<span title="${esc(`${HURT_TIP[h.by]} Hit: ${h.sites.join(', ')}`)}">${esc(HURT_NAME[h.by])} ${h.dmg} dmg (${h.hits} hit${h.hits > 1 ? 's' : ''})</span>`).join(' · ')}<br><span class="dim">${esc(HURT_TIP[r.hurt[0].by])}</span></b>` : ''}
        <span>Missiles fired</span><b>${r.missilesFired} (${money(r.missileCostM)})</b>
        ${r.supportM ? `<span>Support calls (convoys, repairs)</span><b>${money(r.supportM)}</b>` : ''}
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
      ${this.timeline(r)}
      ${r.front?.length ? `<h3>The front</h3><ul class="intel">${r.front.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
      ${r.enemy?.length ? `<h3>The enemy</h3><ul class="intel">${r.enemy.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
      <h3>Damage</h3>
      <p>${dmg.length ? dmg.map((d) => `${d.name} −${d.lost} (now ${d.hp}%)`).join(', ') : 'No damage to the defended assets.'}</p>
      ${r.medals?.length ? `<h3>Medals</h3><p class="good">${r.medals.map(esc).join(', ')}</p>` : ''}
      ${r.promotions?.length ? `<h3>Promotions</h3><p class="good">${r.promotions.map(esc).join(', ')}</p>` : ''}
      ${r.losses.length ? `<h3>Equipment lost</h3><p>${r.losses.map(esc).join(', ')}</p>` : ''}
      ${r.lessons.length ? `<h3>Enemy assessment</h3><ul class="intel">${r.lessons.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
      ${
        over
          ? `<p>Final score <b>${c.score()}</b> over ${c.s.history.length} raids.</p>
             <div class="menu-opts row"><button data-cui="new" class="go">New campaign</button><button data-cui="menu">Main menu</button></div>`
          : (r.grantM ? `<p><b>Emergency grant: ${money(r.grantM)}.</b> The airbase is badly hurt. Crews repair it twice as fast while it is below 40%.</p>` : '') + (r.income
            ? `<p>That was the day's last operation. At 06:00 the income came in: <b>${money(r.income)}</b> from the assets still working and the towns we hold${r.bonusM ? `, after ${money(r.bonusM)} of objective bonuses` : ''}${r.restockM ? `; ${money(r.restockM)} already spent restocking the batteries` : ''}. Budget now <b>${money(c.s.money)}</b>.</p>
             <div class="row"><button data-cui="plan" class="go">Plan day ${c.s.day} ▶</button><button data-cui="menu">Save and quit</button></div>`
            : `<p>Budget now <b>${money(c.s.money)}</b>${r.bonusM ? ` (objective bonuses ${money(r.bonusM)} paid)` : ''}. The day's income comes at 06:00. The clock is stopped at ${hhmm(c.clock)} while you plan for the next operation.</p>
             <div class="row"><button data-cui="plan" class="go">Plan for the next raid ▶</button><button data-cui="menu">Save and quit</button></div>`)
      }`;
    $('debrief').classList.remove('hidden');
  }

  /** After action: every package in the order it came, and what became of it. */
  private timeline(r: DayReport): string {
    if (!r.timeline?.length) return '';
    const rows = r.timeline
      .map((p) => {
        const out: string[] = [];
        if (p.down) out.push(`${p.down} shot down`);
        if (p.hits) out.push(`<span class="bad">${p.hits} hit${p.hits > 1 ? 's' : ''}</span>`);
        if (p.missed) out.push(`${p.missed} missed`);
        if (p.home) out.push(`${p.home} went home`);
        const left = p.spawned - p.down - p.hits - p.missed - p.home;
        if (left > 0) out.push(`${left} still out`);
        const outcome = p.spawned ? out.join(', ') : '<span class="dim">never launched</span>';
        return `<tr class="${p.hits ? 'tl-hit' : ''}"><td class="mono">${hhmm(p.at)}</td><td>${p.counter ? 'Counter-attack: ' : ''}${esc(p.name)} ×${p.size}</td><td>${esc(p.from)}${p.base ? ` <span class="dim">${esc(p.base.toLowerCase())}</span>` : ''}</td><td>${outcome}</td></tr>`;
      })
      .join('');
    return `<h3>After action</h3><table class="timeline"><thead><tr><th>Time</th><th>Package</th><th>From</th><th>What became of it</th></tr></thead><tbody>${rows}</tbody></table>`;
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
      case 'training':
        this.host.startTraining();
        return;
      case 'training-front':
        this.host.startTraining('front');
        return;
      case 'laststand':
        this.host.startLastStand(this.mapPick);
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
      case 'event':
        if (!c.chooseEvent(Number(d.i))) return;
        break;
      case 'deepstrike': {
        const r = deepStrike(c, d.id as DeepStrikeId);
        if (!r) return;
        this.note = r;
        break;
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
      case 'crew':
        if (c.hireCrew()) this.note = `Repair crew hired: repairs now run at ${c.repairPerH} points an hour.`;
        break;
      case 'repairtown':
        c.repairTown(Number(d.i));
        break;
      case 'restock': {
        const spent = c.restock();
        this.note = spent > 0 ? `Restocked for ${money(spent)}.` : 'Nothing to restock.';
        break;
      }
      case 'autorestock':
        c.s.autoRestock = (el as HTMLInputElement).checked;
        store(c);
        return;
      case 'offensive':
        if (!c.launchOffensive()) return;
        this.note = `Offensive on ${c.s.front!.towns[c.s.front!.offensive!].name} ordered. Move units up to cover the assault force (yellow on the scope).`;
        break;
      case 'armourstrike': {
        const r = c.strikeArmour();
        if (!r) return;
        this.note = r;
        break;
      }
      case 'offensive-cancel':
        c.cancelOffensive();
        this.note = 'Offensive called off.';
        break;
      case 'start':
        this.stopPlacing();
        this.focus = null;
        store(c);
        this.host.startBattle(c.startPulse(), c);
        return;
      case 'tip-ok':
        dismissTip(d.name!);
        break;
      case 'wait': {
        const before = c.clock;
        const r = c.wait(60);
        if (r.raid) {
          // Intel had the timing wrong: the raid is on before the hour was up.
          this.stopPlacing();
          this.focus = null;
          store(c);
          this.host.startBattle(c.startPulse(), c);
          return;
        }
        this.note = `${hhmm(before)} to ${hhmm(c.clock)}: ${r.news.join(' ') || 'quiet.'}`;
        break;
      }
      default:
        return;
    }
    store(c);
    this.refreshWorld();
    this.render();
  }
}

const HURT_NAME: Record<HurtBy, string> = {
  drones: 'Attack drones', cruise: 'Cruise missiles', tbm: 'Ballistic missiles', arm: 'Anti-radiation missiles',
  helo: 'Helicopters', strike: 'Strike jets', artillery: 'Artillery', other: 'Other',
};

/** One line of advice per kind of weapon that did the most damage. */
const HURT_TIP: Record<HurtBy, string> = {
  drones: 'Drones got through: put guns, SHORAD or CIWS right next to what they hit, and jam their GNSS.',
  cruise: 'Cruise missiles come in low: cover the approaches with SHORAD and CIWS, and keep an early warning radar up.',
  tbm: 'Only the LR SAM stops ballistic missiles: keep it covering what matters and stocked with missiles.',
  arm: 'ARMs hit your radars: use the Auto EMCON presets and ARM auto, and place radar decoys.',
  helo: 'Helicopters pop up close: guns and SHORAD forward, on the side they come from.',
  strike: 'Strike jets got to their release point: fighters on CAP and an MR SAM on their approach.',
  artillery: 'Enemy artillery spotted by a SAM site radar: sweep that site with a fighter.',
  other: 'Mixed damage this raid.',
};

