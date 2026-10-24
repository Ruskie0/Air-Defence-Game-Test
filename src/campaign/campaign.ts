import { CATALOG, DEFENDED_ASSETS, DeployedUnit, Deployment, RANKS, ROUND_COST, UnitType, launcherOffsets, newUnit, rankOf } from '../sim/catalog';
import { CAP_RADIUS, DEPLOY_RADIUS, nearestFree, placeError } from '../sim/deploy';
import { finishMoves } from '../sim/mobility';
import { UPGRADES, UpgradeId } from './upgrades';
import { DayObjective, objectiveName, objectiveStatus, pickObjectives } from './objectives';
import { ReconDrone } from '../sim/entities';
import { EVENTS, EventId, rollEvent } from './events';
import type { DeepStrikeId } from './deepstrike';
import { WEATHER, WeatherId, rollWeather } from './weather';
import { hdist, v3 } from '../sim/math';
import { CLASSIC_LAYOUT, MapLayout, MapType, Terrain, legacyLayout, randomLayout, typeForSeed } from '../sim/terrain';
import { MAP_SEED } from '../sim/world';
import { World } from '../sim/world';
import { EnemyModel, PKG, PkgKind, PlannedPkg, SECTOR_NAMES, newEnemy, planDay, sectorOf, toRaids } from './raidgen';

export const CAMPAIGN_DAYS = 10;
export { CAP_RADIUS, DEPLOY_RADIUS };
/** Price of a replacement fighter for a pair that lost one, $M. */
export const AIRCRAFT_COST = 85;
/** Shooting down this many airliners ends the campaign. */
export const CIVIL_LIMIT = 2;

export type Difficulty = 'easy' | 'normal' | 'hard';

/** What each difficulty changes: the enemy's daily threat budget, our income and the starting budget. */
export const DIFFICULTY: Record<Difficulty, { name: string; desc: string; threat: number; income: number; start: number }> = {
  easy: { name: 'Recruit', desc: 'Smaller raids and a bigger budget.', threat: 0.75, income: 1.2, start: 220 },
  normal: { name: 'Regular', desc: 'The intended balance.', threat: 1, income: 1, start: 160 },
  hard: { name: 'Veteran', desc: 'Bigger raids, a tighter budget.', threat: 1.3, income: 0.85, start: 130 },
};

export interface DayReport {
  day: number;
  kills: number;
  /** Kills per shooter. */
  killsBy?: Record<string, number>;
  leakers: number;
  missilesFired: number;
  missileCostM: number;
  civilian: number;
  fratricide: number;
  income: number;
  /** Asset damage taken this day (hp points lost per asset). */
  damage: { name: string; lost: number; hp: number }[];
  /** Equipment destroyed. */
  losses: string[];
  /** What the enemy took away from the day. */
  lessons: string[];
  /** Crews that went up a rank. */
  promotions?: string[];
  /** Spent on resupply convoys and field repairs during the battle ($M). */
  supportM?: number;
  /** Bonus objectives and whether they were met. */
  objectives?: { name: string; rewardM: number; done: boolean }[];
}

export interface CampaignState {
  version: 1;
  seed: number;
  day: number;
  money: number;
  deployment: Deployment;
  nextUid: number;
  nextPkg: number;
  enemy: EnemyModel;
  plan: PlannedPkg[];
  history: DayReport[];
  civilLosses: number;
  over: null | { won: boolean; reason: string };
  /** Seed of this campaign's map; absent in saves from before random maps (the classic map). */
  mapSeed?: number;
  /** Map type; absent in saves from before map types (their maps are rebuilt the old way). */
  mapType?: MapType;
  difficulty?: Difficulty;
  /** Upgrades bought (UpgradeId); absent in old saves. */
  upgrades?: string[];
  /** Today's bonus objectives. */
  objectives?: DayObjective[];
  /** Today's event, until the player has chosen; and what the choice did. */
  event?: EventId | null;
  eventResult?: string;
  /** Taken off the next income (an event). */
  incomePenalty?: number;
  /** Today's weather. */
  weather?: WeatherId;
  /** Today's deep strike, once flown. */
  deepStrike?: { id: DeepStrikeId; ok: boolean; text: string } | null;
}

/** Where new units go before the player moves them, in order of preference. */
const DEFAULT_SPOTS: Record<UnitType, [number, number][]> = {
  LR: [[2500, 7000], [-7000, -3000], [8000, 2000]],
  MR: [[-6000, 6000], [7000, -4000], [-3000, -9000], [9000, 6000]],
  SH: [[1500, -1600], [5200, -7400], [-3800, -2000], [-1500, 4500], [8000, -9500]],
  CIWS: [[-700, 600], [6200, -8600], [-4000, -3300], [2900, 6400], [700, -700]],
  GUN: [[-1200, 2200], [4200, 5200], [-2500, -1500], [6500, -7000]],
  LASER: [[600, 1400], [-1800, -800], [5000, -6000], [2000, 5000]],
  EWR: [[-2500, 3500], [4000, -2000]],
  GAP: [[0, 14000], [-12000, 8000], [12000, 8000]],
  GNSS: [[0, 2500], [5000, -6000]],
  DECOY: [[4800, 8600], [-6500, 4500]],
  JAM: [[-4500, 1500], [3500, -4500]],
  CAP: [[0, 50000], [35000, 25000], [-35000, 25000]],
};

export class Campaign {
  s: CampaignState;

  constructor(state: CampaignState) {
    this.s = state;
  }

  static create(seed: number, difficulty: Difficulty = 'normal', mapType: MapType = typeForSeed(seed)): Campaign {
    const c = new Campaign({
      version: 1,
      seed,
      day: 1,
      money: DIFFICULTY[difficulty].start,
      deployment: { units: [], assets: DEFENDED_ASSETS.map((a) => ({ name: a.name, hp: 100 })) },
      nextUid: 1,
      nextPkg: 1,
      enemy: newEnemy(randomLayout(seed, mapType).rot),
      plan: [],
      history: [],
      civilLosses: 0,
      over: null,
      mapSeed: seed,
      mapType,
      difficulty,
      upgrades: [],
    });
    // Starting order of battle: one MR battery, a SHORAD unit and a CIWS on the airbase.
    c.add('MR');
    c.add('SH');
    c.add('CIWS');
    c.replan();
    return c;
  }

  static load(json: string): Campaign | null {
    try {
      const s = JSON.parse(json, (_k, v) => (v === 'Infinity' ? Infinity : v)) as CampaignState;
      if (!s || s.version !== 1) return null;
      // Saves from before decoy drones and upgrades.
      s.enemy.kindW.decoys ??= 0.8;
      s.upgrades ??= [];
      s.enemy.kindW.recon ??= 1;
      s.enemy.kindW.strike ??= 1;
      s.objectives ??= pickObjectives(s.plan, s.day, s.seed);
      return new Campaign(s);
    } catch {
      return null;
    }
  }

  save(): string {
    return JSON.stringify(this.s, (_k, v) => (v === Infinity ? 'Infinity' : v));
  }

  private map: Terrain | null = null;

  get diff(): (typeof DIFFICULTY)[Difficulty] {
    return DIFFICULTY[this.s.difficulty ?? 'normal'];
  }

  /** This campaign's map layout (the classic map for old saves). */
  get layout(): MapLayout {
    if (this.s.mapSeed === undefined) return CLASSIC_LAYOUT;
    return this.s.mapType ? randomLayout(this.s.mapSeed, this.s.mapType) : legacyLayout(this.s.mapSeed);
  }

  /** This campaign's terrain, built once and shared by every day and the planning preview. */
  get terrain(): Terrain {
    if (!this.map) this.map = this.s.mapSeed === undefined ? new Terrain(MAP_SEED) : new Terrain(this.s.mapSeed, this.layout);
    return this.map;
  }

  get units(): DeployedUnit[] {
    return this.s.deployment.units;
  }

  unit(uid: number): DeployedUnit | undefined {
    return this.units.find((u) => u.uid === uid);
  }

  unlocked(type: UnitType): boolean {
    return this.s.day >= CATALOG[type].unlockDay;
  }

  // ------------------------------------------------------------- economy

  /** Budget the defended area earns at the start of the next day, from what is still standing. */
  income(): number {
    const hp = (n: string): number => (this.s.deployment.assets.find((a) => a.name === n)?.hp ?? 0) / 100;
    const supply = this.has('supply') ? 15 : 0;
    return Math.max(0, Math.round((50 + 65 * hp('Airbase') + 45 * hp('Power plant') + 25 * hp('CRC')) * this.diff.income) + supply - (this.s.incomePenalty ?? 0));
  }

  /** Price of restoring one hp point of an asset. */
  private repairRate(name: string): number {
    return ((DEFENDED_ASSETS.find((x) => x.name === name)?.valueM ?? 0) / 100) * 0.35;
  }

  /** Cost of a full repair. */
  repairCost(name: string): number {
    const a = this.s.deployment.assets.find((x) => x.name === name);
    return a ? Math.ceil((100 - a.hp) * this.repairRate(name)) : 0;
  }

  /** Repair an asset as far as the budget allows. */
  repair(name: string): boolean {
    const a = this.s.deployment.assets.find((x) => x.name === name);
    if (!a || a.hp >= 100) return false;
    const rate = this.repairRate(name);
    const pts = Math.min(100 - a.hp, Math.floor(this.s.money / rate));
    if (pts <= 0) return false;
    const cost = pts >= 100 - a.hp ? this.repairCost(name) : Math.ceil(pts * rate);
    this.s.money -= Math.min(cost, this.s.money);
    a.hp += pts;
    return true;
  }

  has(id: UpgradeId): boolean {
    return !!this.s.upgrades?.includes(id);
  }

  canUpgrade(id: UpgradeId): string | null {
    const u = UPGRADES[id];
    if (this.has(id)) return 'Bought';
    if (this.s.day < u.unlockDay) return `Available from day ${u.unlockDay}`;
    if (u.costM > this.s.money) return 'Not enough budget';
    return null;
  }

  upgrade(id: UpgradeId): boolean {
    if (this.canUpgrade(id)) return false;
    this.s.money -= UPGRADES[id].costM;
    (this.s.upgrades ??= []).push(id);
    return true;
  }

  canBuy(type: UnitType): string | null {
    const info = CATALOG[type];
    if (!this.unlocked(type)) return `Available from day ${info.unlockDay}`;
    if (info.costM > this.s.money) return 'Not enough budget';
    return null;
  }

  buy(type: UnitType): DeployedUnit | null {
    if (this.canBuy(type)) return null;
    this.s.money -= CATALOG[type].costM;
    return this.add(type);
  }

  /** Add a unit at the first free default spot (the player moves it afterwards). */
  private add(type: UnitType): DeployedUnit {
    const t = this.terrain;
    // Default spots are laid out for a threat from the north: turn them to face this map's mountains.
    const spots = DEFAULT_SPOTS[type].map(([u, v]) => t.toWorld(u, v));
    const free = (x: number, y: number): boolean =>
      !this.placeError(t, type, x, y) && !this.units.some((u) => u.type !== 'CAP' && type !== 'CAP' && Math.hypot(u.x - x, u.y - y) < 1500);
    const spot = spots.find((p) => free(p.x, p.y));
    // Otherwise spiral out from the first spot until the ground allows it.
    const p = spot ?? nearestFree(t, type, spots[0].x, spots[0].y, this.units, -1, 1500);
    const u = newUnit(this.s.nextUid++, type, Math.round(p.x), Math.round(p.y), CATALOG[type].sector ? t.layout.rot : 0);
    this.units.push(u);
    return u;
  }

  /** Cost of filling every launcher of a battery from the depot. */
  reloadCost(u: DeployedUnit): number {
    const missing = u.launchers.reduce((s, l) => s + (l.max - l.rounds), 0);
    return Math.round(missing * (ROUND_COST[u.type] ?? 0) * 10) / 10;
  }

  reload(u: DeployedUnit): boolean {
    const cost = this.reloadCost(u);
    if (cost <= 0 || cost > this.s.money) return false;
    this.s.money -= cost;
    for (const l of u.launchers) l.rounds = l.max;
    return true;
  }

  /** Spare missiles come in fours, held at the battery for reloads during the day. */
  sparesCost(u: DeployedUnit): number {
    return Math.round(4 * (ROUND_COST[u.type] ?? 0) * 10) / 10;
  }

  buySpares(u: DeployedUnit): boolean {
    const cost = this.sparesCost(u);
    if (!cost || cost > this.s.money) return false;
    this.s.money -= cost;
    u.spares += 4;
    return true;
  }

  launcherCost(u: DeployedUnit): number | null {
    const info = CATALOG[u.type];
    if (!info.launcherCostM || u.launchers.length >= (info.maxLaunchers ?? 0)) return null;
    return info.launcherCostM + (info.perLauncher ?? 0) * (ROUND_COST[u.type] ?? 0);
  }

  addLauncher(u: DeployedUnit): boolean {
    const cost = this.launcherCost(u);
    if (cost === null || cost > this.s.money) return false;
    this.s.money -= cost;
    const info = CATALOG[u.type];
    const n = u.launchers.length + 1;
    const offs = launcherOffsets(u.type, n, u.facing);
    const [dx, dy] = offs[n - 1];
    u.launchers.push({ x: u.x + dx, y: u.y + dy, rounds: info.perLauncher!, max: info.perLauncher! });
    return true;
  }

  replaceAircraftCost(u: DeployedUnit): number | null {
    return u.type === 'CAP' && u.aircraft < 2 && !u.loan ? AIRCRAFT_COST : null;
  }

  replaceAircraft(u: DeployedUnit): boolean {
    const cost = this.replaceAircraftCost(u);
    if (cost === null || cost > this.s.money) return false;
    this.s.money -= cost;
    u.aircraft++;
    return true;
  }

  /** Scrap a unit for a fifth of its price. */
  sell(u: DeployedUnit): void {
    if (u.loan) return;
    this.s.money += Math.round(CATALOG[u.type].costM * 0.2);
    this.s.deployment.units = this.units.filter((x) => x !== u);
  }

  // ------------------------------------------------------------- deployment

  /** Why a unit cannot stand at (x, y), or null if it can. */
  placeError(t: Terrain, type: UnitType, x: number, y: number, uid = -1): string | null {
    return placeError(t, type, x, y, this.units, uid);
  }

  /** Move a unit (and its launchers with it). */
  place(t: Terrain, u: DeployedUnit, x: number, y: number): string | null {
    const err = this.placeError(t, u.type, x, y, u.uid);
    if (err) return err;
    const dx = x - u.x;
    const dy = y - u.y;
    u.x = x;
    u.y = y;
    for (const l of u.launchers) {
      l.x += dx;
      l.y += dy;
      // Launchers that would end up in the sea or off the map stay close to the radar instead.
      if (!t.buildable(l.x, l.y)) {
        l.x = x;
        l.y = y;
      }
    }
    return null;
  }

  /** Turn a phased-array sector (LR) to face a new bearing; its launchers re-form behind it. */
  turn(t: Terrain, u: DeployedUnit, facing: number): void {
    u.facing = ((facing % 360) + 360) % 360;
    const offs = launcherOffsets(u.type, u.launchers.length, u.facing);
    u.launchers.forEach((l, i) => {
      const nx = u.x + offs[i][0];
      const ny = u.y + offs[i][1];
      if (t.buildable(nx, ny)) {
        l.x = nx;
        l.y = ny;
      }
    });
  }

  // ------------------------------------------------------------- the day

  replan(): void {
    // Targets our deep strikes hit recover a day at a time.
    const sup = this.s.enemy.suppressed;
    if (sup) for (const k of Object.keys(sup) as PkgKind[]) if (--sup[k]! <= 0) delete sup[k];
    this.s.deepStrike = null;
    this.s.weather = rollWeather(this.s.seed, this.s.day);
    this.s.plan = planDay(this.s.day, this.s.seed, this.s.enemy, this.s.nextPkg, this.layout.rot, this.diff.threat, WEATHER[this.s.weather].noDrones);
    this.s.nextPkg += this.s.plan.length;
    this.s.objectives = pickObjectives(this.s.plan, this.s.day, this.s.seed);
    this.s.event = rollEvent(this);
    this.s.eventResult = undefined;
  }

  /** Pick today's bonus objectives again after the plan changed. */
  refreshObjectives(): void {
    this.s.objectives = pickObjectives(this.s.plan, this.s.day, this.s.seed);
  }

  /** Re-aim today's strike packages after the enemy learned new positions (an event). */
  replanStrikes(): void {
    const known = this.s.enemy.known ?? [];
    for (const p of this.s.plan) if ((p.kind === 'cruise' || p.kind === 'tbm') && !p.aims && known.length) p.aims = known.slice(0, Math.max(1, p.size));
  }

  /** Why the player cannot take this choice of today's event, or null. */
  eventChoiceError(i: number): string | null {
    const id = this.s.event;
    if (!id) return 'No event';
    const cost = EVENTS[id].choices[i].costM ?? 0;
    return cost > this.s.money ? 'Not enough budget' : null;
  }

  chooseEvent(i: number): boolean {
    const id = this.s.event;
    if (!id || this.eventChoiceError(i)) return false;
    this.s.money -= EVENTS[id].choices[i].costM ?? 0;
    this.s.eventResult = `${EVENTS[id].title}: ${EVENTS[id].apply(this, i)}`;
    this.s.event = null;
    if (id === 'preempt' && i === 0) this.s.objectives = pickObjectives(this.s.plan, this.s.day, this.s.seed);
    return true;
  }

  /** Units an enemy recon drone photographed that are still where it saw them. */
  spotted(u: DeployedUnit): boolean {
    return !!this.s.enemy.known?.some((k) => k.uid === u.uid && Math.hypot(k.x - u.x, k.y - u.y) < 400);
  }

  /** Intel summary lines for the briefing. */
  intel(): string[] {
    const wx = WEATHER[this.s.weather ?? 'clear'];
    const lines = [`Weather: ${wx.desc}`];
    lines.push(...this.s.plan
      .filter((p) => p.reported)
      .map((p) => {
        const def = PKG[p.kind];
        const when = p.t < 120 ? 'early' : p.t < 500 ? 'mid-raid' : 'late';
        const aimed = p.aims ? `, aimed at ${p.aims.length > 1 ? `${p.aims.length} of our positions` : 'one of our positions'} their recon photographed` : '';
        return `${def.name} from the ${SECTOR_NAMES[sectorOf(p.bearing)]} (${when}): ${def.describe(p.size)}${aimed}`;
      }));
    const missed = this.s.plan.filter((p) => !p.reported).length;
    if (missed) lines.push(`Intel coverage is incomplete: expect ${missed === 1 ? 'one package' : 'more packages'} we have not seen.`);
    const sup = Object.entries(this.s.enemy.suppressed ?? {}).filter(([, n]) => n! > 0);
    if (sup.length) lines.push(`Still recovering from our deep strikes: ${sup.map(([k, n]) => `${PKG[k as PkgKind].name.toLowerCase()} (${n} day${n! > 1 ? 's' : ''})`).join(', ')}.`);
    return lines;
  }

  /** The world for today's battle (or, before it starts, the deployment preview). */
  makeWorld(withRaids = true): World {
    const dep: Deployment = JSON.parse(JSON.stringify(this.s.deployment, (_k, v) => (v === Infinity ? 'Infinity' : v)), (_k, v) =>
      v === 'Infinity' ? Infinity : v,
    );
    return new World({
      seed: this.s.seed * 31 + this.s.day,
      terrain: this.terrain,
      deployment: dep,
      raids: withRaids ? toRaids(this.s.plan) : [],
      civil: withRaids,
      upgrades: this.s.upgrades,
      budgetM: this.s.money,
      weather: this.s.weather,
    });
  }

  /** Read the day's outcome back from the world, pay the bills, let the enemy learn, and plan tomorrow. */
  settle(w: World): DayReport {
    const s = this.s;
    // Weapons still inbound when the day is ended early reach their targets.
    for (const e of w.entities) {
      if (!e.alive || e.side !== 'red' || !e.munition || !e.target) continue;
      e.pos = { ...e.target };
      w.detonate(e);
    }

    finishMoves(w);
    // Support calls made during the battle are paid for now.
    s.money = Math.max(0, s.money - w.supportSpentM);
    const losses: string[] = [];
    const promotions: string[] = [];
    const before = new Map(s.deployment.assets.map((a) => [a.name, a.hp]));
    s.deployment.assets = DEFENDED_ASSETS.map((a) => ({ name: a.name, hp: Math.round(w.site(a.name)?.hp ?? 0) }));
    const kept: DeployedUnit[] = [];
    for (const f of w.fielded) {
      const u = s.deployment.units.find((x) => x.uid === f.unit.uid);
      if (!u) continue;
      const main = f.sites[0];
      if (f.fu) {
        if (!f.fu.radar?.alive) {
          losses.push(`${f.fu.name} (radar destroyed)`);
          continue;
        }
        u.launchers = f.fu.launchers
          .map((l, i) => ({ ...u.launchers[i], x: Math.round(l.site.pos.x), y: Math.round(l.site.pos.y), rounds: l.rounds }))
          .filter((_l, i) => {
            const alive = f.fu!.launchers[i].site.alive;
            if (!alive) losses.push(`${f.fu!.name} launcher ${i + 1}`);
            return alive;
          });
        u.spares = f.fu.spares;
      } else if (f.fighters) {
        const alive = f.fighters.filter((x) => x.alive).length;
        if (alive < u.aircraft) losses.push(`${u.aircraft - alive} fighter${u.aircraft - alive > 1 ? 's' : ''}`);
        u.aircraft = alive;
        if (!alive) continue;
      } else if (main && !main.alive) {
        losses.push(main.name);
        continue;
      }
      // Crews gain experience from their kills.
      const shooter = f.fu?.name ?? f.ciws?.name;
      if (shooter) {
        const before = rankOf(u.xp);
        u.xp = (u.xp ?? 0) + (w.stats.killsBy[shooter] ?? 0);
        const after = rankOf(u.xp);
        if (after > before) promotions.push(`${shooter} promoted to ${RANKS[after].name}`);
      }
      // Units moved during the battle stay where they ended up.
      u.x = f.unit.x;
      u.y = f.unit.y;
      if (u.loan) continue;
      if (f.radar) u.armWatch = f.radar.armWatch;
      if (f.fu) u.holdFire = f.fu.hold;
      if (f.ciws) u.holdFire = !f.ciws.auto;
      const em = w.gnss.find((j) => j.site === f.sites[0]) ?? w.decoys.find((d) => d.site === f.sites[0]) ?? w.ewj.find((j) => j.site === f.sites[0]);
      if (em) u.on = em.on;
      kept.push(u);
    }
    s.deployment.units = kept;

    // Enemy learning: packages that hit something are repeated, from the same direction.
    const lessons: string[] = [];
    const clamp = (x: number): number => Math.min(4, Math.max(0.3, x));
    for (const p of s.plan) {
      if (p.kind === 'dark' || p.kind === 'decoys' || p.kind === 'recon') continue;
      const hits = w.pkgHits.get(p.id) ?? 0;
      const sec = sectorOf(p.bearing);
      if (hits > 0) {
        s.enemy.kindW[p.kind] = clamp(s.enemy.kindW[p.kind] * 1.25);
        s.enemy.axisW[sec] = clamp(s.enemy.axisW[sec] * 1.35);
        lessons.push(`${PKG[p.kind].name} from the ${SECTOR_NAMES[sec]} got through (${hits} hit${hits > 1 ? 's' : ''}). Expect more of that.`);
      } else {
        s.enemy.kindW[p.kind] = clamp(s.enemy.kindW[p.kind] * 0.92);
        s.enemy.axisW[sec] = clamp(s.enemy.axisW[sec] * 0.9);
      }
    }
    // Recon that got home tells tomorrow's strike planners where our units are.
    for (const e of w.entities) if (e.alive && e instanceof ReconDrone) for (const p of e.seen) w.reconSeen.set(p.uid, p);
    s.enemy.known = [...w.reconSeen.values()];
    if (s.plan.some((p) => p.kind === 'recon')) {
      s.enemy.kindW.recon = clamp((s.enemy.kindW.recon ?? 1) * (s.enemy.known.length ? 1.2 : 0.85));
      if (s.enemy.known.length) lessons.push(`Enemy recon photographed ${s.enemy.known.length} of our positions. Move those units before tomorrow or expect strikes on them.`);
    }
    // Decoys work if they drew missiles.
    if (s.plan.some((p) => p.kind === 'decoys')) {
      const n = w.stats.decoyMissiles;
      s.enemy.kindW.decoys = Math.min(2, clamp(s.enemy.kindW.decoys * (n >= 4 ? 1.2 : n >= 2 ? 1 : 0.8)));
      if (n >= 2) lessons.push(`We spent ${n} missiles on decoy drones. The enemy will send more of them.`);
    }
    const dayLen = Math.max(1, w.t);
    const loud = [...w.radiating].filter(([code, sec]) => /^(LR|MR|EW)/.test(code) && sec / dayLen > 0.8);
    if (loud.length && s.day >= 2) {
      s.enemy.kindW.sead = clamp(s.enemy.kindW.sead * 1.15);
      lessons.push('Your big radars radiated all day: enemy ESM has them mapped, and more SEAD is likely.');
    }

    s.civilLosses += w.stats.civilian;
    const objectives = (s.objectives ?? []).map((o) => ({ name: objectiveName(o), rewardM: o.rewardM, done: objectiveStatus(o, w, true) === 'done' }));
    const bonus = objectives.reduce((t, o) => t + (o.done ? o.rewardM : 0), 0);
    const income = this.income() + bonus;
    s.incomePenalty = 0;
    const report: DayReport = {
      day: s.day,
      kills: w.stats.kills,
      killsBy: { ...w.stats.killsBy },
      leakers: w.stats.leakers,
      missilesFired: w.stats.fired.LR + w.stats.fired.MR + w.stats.fired.SH + w.stats.fired.AAM,
      missileCostM: Math.round(w.stats.costM * 10) / 10,
      civilian: w.stats.civilian,
      fratricide: w.stats.fratricide,
      income,
      damage: s.deployment.assets.map((a) => ({ name: a.name, lost: (before.get(a.name) ?? 100) - a.hp, hp: a.hp })),
      losses,
      lessons,
      promotions,
      objectives,
      supportM: Math.round(w.supportSpentM * 10) / 10,
    };
    s.history.push(report);

    const airbase = s.deployment.assets.find((a) => a.name === 'Airbase')!;
    if (airbase.hp <= 0) s.over = { won: false, reason: 'The airbase was destroyed. The defence has failed.' };
    else if (s.civilLosses >= CIVIL_LIMIT) s.over = { won: false, reason: `${s.civilLosses} civil airliners shot down. You have been relieved of command.` };
    else if (s.day >= CAMPAIGN_DAYS) s.over = { won: true, reason: `You held the airbase for ${CAMPAIGN_DAYS} days.` };
    if (!s.over) {
      s.day++;
      s.money += income;
      this.replan();
    }
    return report;
  }

  /** Simple score for the end screen: assets standing, money left, minus civil and friendly losses. */
  score(): number {
    const s = this.s;
    const assets = s.deployment.assets.reduce((t, a) => t + a.hp, 0);
    const kills = s.history.reduce((t, d) => t + d.kills, 0);
    const civ = s.history.reduce((t, d) => t + d.civilian, 0);
    const frat = s.history.reduce((t, d) => t + d.fratricide, 0);
    return Math.max(0, Math.round(kills * 10 + assets * 5 + s.money - civ * 500 - frat * 200 + (s.over?.won ? 1000 : 0)));
  }
}

/** Distance helper for the UI: is a ground point within the deployment area? */
export const inDeployArea = (x: number, y: number): boolean => hdist(v3(x, y), v3()) <= DEPLOY_RADIUS;
