import { RED_SUPPORT } from '../sim/redair';
import { CATALOG, DEFENDED_ASSETS, DeployedUnit, Deployment, RANKS, ROUND_COST, UnitType, launcherOffsets, newUnit, rankOf } from '../sim/catalog';
import { CAP_RADIUS, DEPLOY_RADIUS, nearestFree, placeError } from '../sim/deploy';
import { finishMoves } from '../sim/mobility';
import { finishConvoys } from '../sim/support';
import { UPGRADES, UpgradeId } from './upgrades';
import { DayObjective, objectiveName, objectiveStatus, pickObjectives } from './objectives';
import { ReconDrone } from '../sim/entities';
import { EVENTS, EventId, rollEvent } from './events';
import type { DeepStrikeId } from './deepstrike';
import { WEATHER, WeatherId, rollWeather } from './weather';
import { hdist, v3 } from '../sim/math';
import { CLASSIC_LAYOUT, MapLayout, MapType, Terrain, legacyLayout, randomLayout, typeForSeed } from '../sim/terrain';
import { type HurtBy, MAP_SEED, RECON_BOUNTY_M } from '../sim/world';
import { World } from '../sim/world';
import { doctrineOf, pickDoctrine } from './doctrine';
import { award, battleMedals } from './medals';
import { EnemyModel, PKG, PkgKind, PlannedPkg, SECTOR_NAMES, aimAtSightings, assignBases, newEnemy, planDay, refundBases, sectorOf, sortiesOf, threatBudget, toRaids } from './raidgen';
import { DAY_START_MIN, DELIVERY_H, PULSES, PulseSlot, PulseType, REPAIR_PER_H, TURNAROUND_H, hhmm, scheduleDay } from './clock';
import { cbStrikes } from '../sim/exposure';
import { ARMOUR } from '../sim/enemyarmour';
import type { Sighting } from '../sim/entities';
import { ASSAULT_HOLD, FrontState, OFFENSIVE_COST_M, TAKEN_HP, TOWN_THREAT_CUT, assaultSpot, columnStart, deployZones, frontTown, newFront, nextObjective, townIncome, townsHeld } from './front';
import { AIRCRAFT, type Asset, type EnemyBase, TALLY_ASSET, assetCount, avail, draw, fallBack, makeTheatre, overrun, reinforce } from '../sim/theatre';
import { Rng } from '../sim/rng';
import { DeployZone, inZones } from '../sim/deploy';

export const CAMPAIGN_DAYS = 10;
/** Scale on the enemy's threat points for a whole day, shared between its operations (balance). */
export let DAY_THREAT = 1.75;
/** Override the threat scale (headless sweeps). */
export function setDayThreat(v: number): void {
  DAY_THREAT = v;
}

/** A raid that loses at least this share of its aircraft shakes the enemy: its next 12 h of raids are smaller. */
export const SHAKEN = { lossShare: 0.4, minFlown: 4, hours: 12, maxCut: 0.35 };
/** Below this airbase health an emergency grant arrives at 06:00, and crews repair the airbase twice as fast. */
export const EMERGENCY = { belowHp: 40, perHpM: 3, repairX: 2 };
/** Our strike on the enemy's armour while it masses for an attack on one of our towns. */
export const ARMOUR_STRIKE = { costM: 35, chance: 0.6 };
/** What the enemy remembers of a position it photographed or located is good for this long (minutes). */
const SIGHTING_MIN = 18 * 60;
export { CAP_RADIUS, DEPLOY_RADIUS };
/** Price of a replacement fighter for a pair that lost one, $M. */
export const AIRCRAFT_COST = 85;
/** Shooting down this many airliners ends the campaign. */
export const CIVIL_LIMIT = 2;

export type Difficulty = 'easy' | 'normal' | 'hard';

/** What each difficulty changes: the enemy's daily threat budget, our income and the starting budget. */
export const DIFFICULTY: Record<Difficulty, { name: string; desc: string; threat: number; income: number; start: number }> = {
  easy: { name: 'Easy', desc: 'Smaller raids and a little more money.', threat: 0.914, income: 1.05, start: 180 },
  normal: { name: 'Normal', desc: 'The intended balance.', threat: 1, income: 1, start: 160 },
  hard: { name: 'Hard', desc: 'Bigger raids, a tighter budget.', threat: 1.057, income: 0.95, start: 150 },
};

/** One raid's outcome (several a day on the continuous clock). */
export interface DayReport {
  day: number;
  /** Campaign clock when the raid began and ended, and what kind of operation it was. */
  at?: number;
  end?: number;
  pulse?: PulseType;
  /** Paid at once for the raid's bonus objectives ($M). */
  bonusM?: number;
  /** After action: each package, when it came, from where, and how what it sent ended. */
  timeline?: { at: number; name: string; size: number; from: string; base?: string; spawned: number; down: number; hits: number; missed: number; home: number; counter?: boolean }[];
  kills: number;
  /** Kills per shooter. */
  killsBy?: Record<string, number>;
  leakers: number;
  /** What hurt us: damage to our sites by weapon type, worst first. */
  hurt?: { by: HurtBy; dmg: number; hits: number; sites: string[] }[];
  missilesFired: number;
  missileCostM: number;
  civilian: number;
  fratricide: number;
  income: number;
  /** Asset damage taken this day (hp points lost per asset). */
  damage: { name: string; lost: number; hp: number }[];
  /** Equipment destroyed. */
  losses: string[];
  /** What happened on the front line. */
  front?: string[];
  /** Spent by the automatic restock this morning ($M). */
  restockM?: number;
  /** Emergency grant paid at 06:00 because the airbase is badly hurt ($M). */
  grantM?: number;
  /** What the enemy took away from the day. */
  lessons: string[];
  /** Crews that went up a rank. */
  promotions?: string[];
  /** Career medals earned in this battle. */
  medals?: string[];
  /** Spent on resupply convoys and field repairs during the battle ($M). */
  supportM?: number;
  /** Bonus objectives and whether they were met. */
  objectives?: { name: string; rewardM: number; done: boolean }[];
  /** The enemy's side of the day: aircraft it lost, installations found, overrun or moved. */
  enemy?: string[];
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
  /** The front line: towns held and today's offensive. Absent only in saves from before it (added on load). */
  front?: FrontState;
  /** Refill launchers and top up spares every morning. */
  autoRestock?: boolean;
  /** The enemy's installations and what each has left. Absent only in saves from before the theatre (built on load). */
  theatre?: EnemyBase[];
  /** Enemy aircraft we have shot down, and stock our deep strikes and offensives destroyed, over the campaign. */
  enemyLost?: Partial<Record<Asset, number>>;
  /** After a costly raid the enemy flies smaller raids until `until` (clock minutes), by `cut`. */
  shaken?: { until: number; cut: number } | null;
  /** The campaign clock (minutes since midnight before day 1): now, in the lull between raids. Absent in old saves. */
  clock?: number;
  /** Today's enemy operations, and which one comes next. */
  pulses?: PulseSlot[];
  pulseIdx?: number;
  /** Threat points the enemy has for the whole day, shared out between its operations. */
  dayBudget?: number;
  /** What intel expects of the next operation: about when, and from where. It is sometimes wrong. */
  warn?: { at: number; sector: number };
  /** Enemy aircraft still being turned round after a sortie ("base:asset"), until a clock time. */
  sorties?: { key: string; n: number; until: number }[];
  /** Repair points paid for that the crews are still working on, per asset. */
  repairs?: Record<string, number>;
  /** Extra repair crews hired: each adds REPAIR_PER_H points an hour to repairs. */
  repairCrews?: number;
  /** Clock time the enemy has a new AWACS after we shot its last one down. */
  awacsBackAt?: number;
  /** Day the last offensive went in (one a day). */
  offensiveDay?: number;
  /** The enemy's own ground offensive today: on which of our towns, from which of theirs, in which operation. */
  enemyPush?: { pulse: number; town: number; from: number; struck?: boolean; broken?: boolean } | null;
  /** How the war ended on the clock: a ceasefire after the last day, graded by the ground we hold. */
  grade?: 'Bronze' | 'Silver' | 'Gold';
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

/** An extra repair crew: cost, and how many can be hired. */
/** A second (or later) fighter pair, against the first one's catalogue price. */
export const SECOND_CAP_M = 120;
export const REPAIR_CREW = { costM: 30, max: 2 };

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
      enemy: newEnemy(randomLayout(seed, mapType).rot, pickDoctrine(seed)),
      plan: [],
      history: [],
      civilLosses: 0,
      over: null,
      mapSeed: seed,
      mapType,
      difficulty,
      upgrades: [],
      autoRestock: true,
      clock: DAY_START_MIN,
    });
    c.s.front = newFront(c.terrain, seed);
    c.s.theatre = makeTheatre(c.terrain, seed, c.s.front.towns, c.diff.threat);
    c.s.enemyLost = {};
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
      s.enemy.kindW.helo ??= 1;
      s.objectives ??= pickObjectives(s.plan, s.day, s.seed);
      const c = new Campaign(s);
      s.front ??= newFront(c.terrain, s.mapSeed ?? s.seed);
      s.theatre ??= makeTheatre(c.terrain, s.mapSeed ?? s.seed, s.front.towns, c.diff.threat);
      s.enemyLost ??= {};
      // Saves from before the campaign clock: today's plan becomes the first of today's operations.
      if (s.clock === undefined) {
        s.clock = DAY_START_MIN + (s.day - 1) * 1440;
        s.pulses = scheduleDay(s.day, s.seed);
        s.pulseIdx = 0;
        s.dayBudget = c.dayThreat();
      }
      return c;
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

  /** The enemy's installations. */
  get theatre(): EnemyBase[] {
    return (this.s.theatre ??= makeTheatre(this.terrain, this.s.mapSeed ?? this.s.seed, this.s.front?.towns ?? [], this.diff.threat));
  }

  /** Swap today's raid plan for a new one: munitions the old one had drawn go back to their bases. */
  replacePlan(plan: PlannedPkg[]): void {
    const counters = this.s.plan.filter((p) => p.counter || p.push);
    refundBases(this.s.plan.filter((p) => !p.counter && !p.push), this.theatre);
    this.s.plan = [...assignBases(plan, this.theatre, this.busy(this.pulse?.at, counters)), ...counters].sort((a, b) => a.t - b.t);
  }

  // ------------------------------------------------------------- the clock

  /** The campaign clock (minutes since midnight before day 1). */
  get clock(): number {
    return this.s.clock ?? DAY_START_MIN + (this.s.day - 1) * 1440;
  }

  /** The enemy operation coming next. */
  get pulse(): PulseSlot | undefined {
    return this.s.pulses?.[this.s.pulseIdx ?? 0];
  }

  /** The first raid has been fought: from then on orders take time to arrive and repairs take hours. */
  get started(): boolean {
    return this.s.history.length > 0;
  }

  /** Threat points the enemy has for today, less for every town we hold beyond the first. */
  dayThreat(): number {
    const cut = 1 - TOWN_THREAT_CUT * Math.max(0, townsHeld(this.s.front) - 1);
    return threatBudget(this.s.day, this.diff.threat * cut) * DAY_THREAT;
  }

  /** Enemy aircraft not ready to fly at a clock time ("base:asset" -> count), plus those `plan` already uses. */
  busy(at = this.pulse?.at ?? this.clock, plan: PlannedPkg[] = []): Map<string, number> {
    const m = sortiesOf(plan);
    for (const r of this.s.sorties ?? []) if (r.until > at) m.set(r.key, (m.get(r.key) ?? 0) + r.n);
    return m;
  }

  /** Let the clock run on to `t` in the lull: orders reach the depot and the repair crews work. */
  advanceTo(t: number): string[] {
    const from = this.clock;
    if (t <= from) return [];
    const out: string[] = [];
    this.s.clock = t;
    for (const u of this.units) {
      if (u.arrives === undefined || u.arrives > t) continue;
      delete u.arrives;
      out.push(`${CATALOG[u.type].name} has arrived.`);
    }
    const pts = (this.repairPerH * (t - from)) / 60;
    const reps = this.s.repairs ?? {};
    for (const [name, left] of Object.entries(reps)) {
      const a = this.s.deployment.assets.find((x) => x.name === name);
      if (!a) continue;
      // Whole points only, so health stays a whole number.
      const x = name === 'Airbase' && a.hp < EMERGENCY.belowHp ? EMERGENCY.repairX : 1;
      const n = Math.floor(Math.min(left, pts * x, 100 - a.hp));
      a.hp += n;
      reps[name] = left - n;
      if (reps[name] < 1 || a.hp >= 100) {
        delete reps[name];
        out.push(`Repairs to the ${name.toLowerCase()} are finished.`);
      }
    }
    // Unit crews patch up their own equipment at the same rate, free.
    for (const u of this.units) {
      if (u.hp !== undefined) {
        u.hp = Math.min(100, Math.floor(u.hp + pts));
        if (u.hp >= 100) {
          delete u.hp;
          out.push(`${CATALOG[u.type].name} repaired.`);
        }
      }
      for (const l of u.launchers) if (l.hp !== undefined && (l.hp = Math.min(100, Math.floor(l.hp + pts))) >= 100) delete l.hp;
    }
    this.s.sorties = (this.s.sorties ?? []).filter((r) => r.until > t);
    return out;
  }

  /** Wait in the lull, to let orders arrive or repairs finish: what happened meanwhile, and whether the enemy came first (the raid is on). */
  wait(min: number): { raid: boolean; news: string[] } {
    const p = this.pulse;
    if (!p) return { raid: false, news: [] };
    const t = Math.min(this.clock + min, p.at);
    const news = this.advanceTo(t);
    return { raid: t >= p.at, news };
  }

  /** The clock runs on to the next raid, and the battle starts. */
  startPulse(): World {
    const p = this.pulse;
    if (p) this.advanceTo(p.at);
    const w = this.makeWorld();
    // The enemy's counter-battery fire is shared out over the day's operations.
    w.exposure.strikesLeft = Math.max(1, Math.round(cbStrikes(this.s.day) * (p?.share ?? 0.5) * 2));
    return w;
  }

  /** When an order placed now reaches the depot (straight away before the first raid). */
  deliveryAt(type: UnitType): number | undefined {
    return this.started ? this.clock + DELIVERY_H[type] * 60 : undefined;
  }

  /** A new day at 06:00: the weather, the enemy's budget for the day and its operations. */
  private startDay(): void {
    // Targets our deep strikes hit recover a day at a time.
    const sup = this.s.enemy.suppressed;
    if (sup) for (const k of Object.keys(sup) as PkgKind[]) if (--sup[k]! <= 0) delete sup[k];
    this.s.deepStrike = null;
    this.s.weather = rollWeather(this.s.seed, this.s.day);
    this.s.dayBudget = this.dayThreat();
    this.s.pulses = scheduleDay(this.s.day, this.s.seed);
    this.s.pulseIdx = 0;
    if (this.s.front) this.s.front.offensive = null;
    // From day 3 the enemy may throw its own armour at our front town in one of the day's combined strikes.
    this.s.enemyPush = null;
    const f = this.s.front;
    const front = f ? frontTown(f) : null;
    const ft = f && front ? f.towns.indexOf(front) : -1;
    const rng = new Rng(this.s.seed * 7307 + this.s.day * 211);
    const strikes = this.s.pulses.map((p, i) => (p.type === 'strike' ? i : -1)).filter((i) => i >= 0);
    if (f && ft >= 0 && ft + 1 < f.towns.length && this.s.day >= 3 && strikes.length && rng.chance(Math.min(0.6, 0.2 + 0.04 * this.s.day))) {
      this.s.enemyPush = { pulse: strikes[rng.int(0, strikes.length - 1)], town: ft, from: ft + 1 };
    }
  }

  /** The enemy's ground offensive if it goes in with the coming raid (and has not been broken up). */
  get pushNow(): { town: number; from: number } | null {
    const p = this.s.enemyPush;
    const f = this.s.front;
    if (!p || !f || p.broken || p.pulse > (this.s.pulseIdx ?? 0) || !f.towns[p.town]?.ours || f.towns[p.from]?.ours) return null;
    return p;
  }

  /** Why we cannot strike the enemy's massing armour now, or null. */
  armourStrikeError(): string | null {
    const p = this.s.enemyPush;
    if (!p || p.broken) return 'No enemy armour is massing';
    if (p.struck) return 'Already struck';
    if (ARMOUR_STRIKE.costM > this.s.money) return 'Not enough budget';
    return null;
  }

  /** Hit the armour while it masses: if it works, the attack is broken up before it starts. */
  strikeArmour(): string | null {
    if (this.armourStrikeError()) return null;
    const p = this.s.enemyPush!;
    this.s.money -= ARMOUR_STRIKE.costM;
    p.struck = true;
    const ok = new Rng(this.s.seed * 4513 + this.s.day * 97).chance(ARMOUR_STRIKE.chance);
    const town = this.s.front!.towns[p.town].name;
    if (ok) {
      p.broken = true;
      refundBases(this.s.plan.filter((x) => x.push), this.theatre);
      this.s.plan = this.s.plan.filter((x) => !x.push);
      return `Our strike caught the armour massing for ${town}: the attack has been broken up.`;
    }
    return `Our strike on the armour massing for ${town} missed. The attack is still coming.`;
  }

  /** A raid plan for the coming operation, its share of the day's threat (scaled down by a pre-emptive strike, say). */
  pulsePlan(scale = 1, salt = 0): PlannedPkg[] {
    const slot = this.pulse!;
    const idx = this.s.pulseIdx ?? 0;
    const plan = planDay(this.s.day, this.s.seed + idx * 7177 + salt, this.s.enemy, this.s.nextPkg, this.layout.rot, 1, WEATHER[this.s.weather ?? 'clear'].noDrones, {
      ...PULSES[slot.type].opts,
      budget: (this.s.dayBudget ?? this.dayThreat()) * slot.share * scale * (1 - this.shakenCut(slot.at)),
    });
    this.s.nextPkg += plan.length;
    return plan;
  }

  /** Plan the coming operation: what flies, from which installation, at what, and what intel makes of it. */
  private planPulse(): void {
    const slot = this.pulse!;
    // Every package flies from a real installation, only as big as what it has ready: aircraft still being
    // turned round from an earlier sortie stay on the ground.
    this.s.plan = assignBases(this.pulsePlan(), this.theatre, this.busy(slot.at));
    aimAtSightings(this.s.plan, this.s.enemy.known ?? []);
    // An operation the enemy has nothing left to fly is called off: on to its next one today.
    if (!this.s.plan.some((p) => p.kind !== 'dark') && (this.s.pulseIdx ?? 0) + 1 < (this.s.pulses?.length ?? 0)) {
      this.s.pulseIdx = (this.s.pulseIdx ?? 0) + 1;
      return this.planPulse();
    }
    const idx = this.s.pulseIdx ?? 0;
    const rng = new Rng(this.s.seed * 53 + this.s.day * 7 + idx * 131);
    // The enemy's ground offensive goes in with air support aimed at the town: drones and missiles to knock it down.
    const push = this.pushNow;
    if (push && this.s.front) {
      const town = this.s.front.towns[push.town];
      const from = this.s.front.towns[push.from];
      const day = this.s.day;
      const support: PlannedPkg[] = (
        [
          ['drones', Math.min(14, 6 + Math.floor(day / 2))],
          ['cruise', Math.min(6, 2 + Math.floor(day / 3))],
          ['drones', Math.min(10, 4 + Math.floor(day / 3))],
        ] as [PkgKind, number][]
      ).map(([kind, size], i) => ({
        id: this.s.nextPkg++,
        kind,
        bearing: (Math.atan2(from.x - town.x, from.y - town.y) * 180) / Math.PI,
        size,
        t: Math.round(60 + i * 150 + rng.range(0, 40)),
        reported: true,
        target: town.name,
        origin: { x: from.x, y: from.y },
        push: true,
      }));
      this.s.plan = [...this.s.plan, ...assignBases(support, this.theatre, this.busy(slot.at, this.s.plan))].sort((a, b) => a.t - b.t);
    }
    const f = this.s.front;
    if (f) {
      // Some of the raids go for our most forward town.
      const front = frontTown(f);
      if (front && this.s.day >= 2) for (const p of this.s.plan) if ((p.kind === 'drones' || p.kind === 'cruise' || p.kind === 'strike') && !p.aims && rng.chance(0.3)) p.target = front.name;
    }
    this.refreshObjectives();
    // The warning: the main axis and rough time. A quarter of the time the timing is out by an hour or two,
    // and now and then the axis is wrong.
    const bySector = new Map<number, number>();
    for (const p of this.s.plan) if (p.kind !== 'dark') bySector.set(sectorOf(p.bearing), (bySector.get(sectorOf(p.bearing)) ?? 0) + p.size);
    let main = sectorOf(this.layout.rot);
    for (const [sec, n] of bySector) if (n > (bySector.get(main) ?? 0)) main = sec;
    const off = rng.chance(0.25) ? (rng.chance(0.5) ? 1 : -1) * rng.range(60, 120) : rng.range(-20, 20);
    const sector = rng.chance(0.2) ? (main + (rng.chance(0.5) ? 1 : 7)) % 8 : main;
    this.s.warn = { at: Math.max(this.clock + 10, Math.round((slot.at + off) / 10) * 10), sector };
  }

  get units(): DeployedUnit[] {
    return this.s.deployment.units;
  }

  unit(uid: number): DeployedUnit | undefined {
    return this.units.find((u) => u.uid === uid);
  }

  /** Where ground units may stand today. */
  get zones(): DeployZone[] {
    return deployZones(this.s.front);
  }

  unlocked(type: UnitType): boolean {
    return this.s.day >= CATALOG[type].unlockDay;
  }

  // ------------------------------------------------------------- economy

  /** Budget the defended area earns at the start of the next day, from what is still standing. */
  income(): number {
    const hp = (n: string): number => (this.s.deployment.assets.find((a) => a.name === n)?.hp ?? 0) / 100;
    const supply = this.has('supply') ? 15 : 0;
    const towns = Math.round(townIncome(this.s.front) * this.diff.income);
    return Math.max(0, Math.round((50 + 65 * hp('Airbase') + 45 * hp('Power plant') + 25 * hp('CRC')) * this.diff.income) + towns + supply - (this.s.incomePenalty ?? 0));
  }

  /** Price of restoring one hp point of an asset. */
  private repairRate(name: string): number {
    return ((DEFENDED_ASSETS.find((x) => x.name === name)?.valueM ?? 0) / 100) * 0.35;
  }

  /** Repair points paid for and not yet done. */
  repairing(name: string): number {
    return this.s.repairs?.[name] ?? 0;
  }

  /** Cost of a full repair (less what the crews are already working on). */
  repairCost(name: string): number {
    const a = this.s.deployment.assets.find((x) => x.name === name);
    return a ? Math.max(0, Math.ceil((100 - a.hp - this.repairing(name)) * this.repairRate(name))) : 0;
  }

  /** How much smaller a raid at clock time `at` is because the enemy is still licking its wounds. */
  shakenCut(at: number): number {
    const k = this.s.shaken;
    return k && at < k.until ? k.cut : 0;
  }

  /** The 06:00 emergency grant while the airbase is badly hurt, bigger the worse it is. */
  emergencyGrant(): number {
    const hp = this.s.deployment.assets.find((a) => a.name === 'Airbase')?.hp ?? 100;
    return hp > 0 && hp < EMERGENCY.belowHp ? Math.round((EMERGENCY.belowHp - hp) * EMERGENCY.perHpM) : 0;
  }

  /** Repair points restored an hour: the base crews plus every crew hired. */
  get repairPerH(): number {
    return REPAIR_PER_H * (1 + (this.s.repairCrews ?? 0));
  }

  /** Why another repair crew cannot be hired, or null. */
  crewError(): string | null {
    if ((this.s.repairCrews ?? 0) >= REPAIR_CREW.max) return `At most ${REPAIR_CREW.max} extra crews`;
    if (this.s.money < REPAIR_CREW.costM) return 'Not enough budget';
    return null;
  }

  /** Hire a repair crew for the rest of the war: repairs go faster, for money that could have bought a unit. */
  hireCrew(): boolean {
    if (this.crewError()) return false;
    this.s.money -= REPAIR_CREW.costM;
    this.s.repairCrews = (this.s.repairCrews ?? 0) + 1;
    return true;
  }

  /** Repair an asset as far as the budget allows. Before the first raid it is done at once; after, crews restore this.repairPerH points an hour. */
  repair(name: string): boolean {
    const a = this.s.deployment.assets.find((x) => x.name === name);
    const need = a ? Math.floor(100 - a.hp - this.repairing(name)) : 0;
    if (!a || need <= 0) return false;
    const rate = this.repairRate(name);
    const pts = Math.min(need, Math.floor(this.s.money / rate));
    if (pts <= 0) return false;
    const cost = pts >= need ? this.repairCost(name) : Math.ceil(pts * rate);
    this.s.money -= Math.min(cost, this.s.money);
    if (this.started) (this.s.repairs ??= {})[name] = this.repairing(name) + pts;
    else a.hp += pts;
    return true;
  }

  /** A unit's worst damaged site (main site or launcher), 100 when undamaged, and when its crew will have it repaired. */
  unitDamage(u: DeployedUnit): { hp: number; done: number | null } {
    const hp = Math.min(u.hp ?? 100, ...u.launchers.map((l) => l.hp ?? 100));
    return { hp, done: hp < 100 ? this.clock + ((100 - hp) / this.repairPerH) * 60 : null };
  }

  /** When the crews will have finished an asset's repairs (clock), or null if nothing is being repaired. */
  repairDone(name: string): number | null {
    const left = this.repairing(name);
    return left > 0 ? this.clock + (left / this.repairPerH) * 60 : null;
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

  /** What a unit costs to buy now: a second fighter pair comes cheaper, so it is a real mid-campaign buy. */
  price(type: UnitType): number {
    return type === 'CAP' && this.units.some((u) => u.type === 'CAP') ? SECOND_CAP_M : CATALOG[type].costM;
  }

  canBuy(type: UnitType): string | null {
    const info = CATALOG[type];
    if (!this.unlocked(type)) return `Available from day ${info.unlockDay}`;
    if (this.price(type) > this.s.money) return 'Not enough budget';
    return null;
  }

  buy(type: UnitType): DeployedUnit | null {
    if (this.canBuy(type)) return null;
    this.s.money -= this.price(type);
    const u = this.add(type);
    u.arrives = this.deliveryAt(type);
    if (u.arrives === undefined) delete u.arrives;
    return u;
  }

  /** Add a unit at the first free default spot (the player moves it afterwards). */
  add(type: UnitType): DeployedUnit {
    const t = this.terrain;
    // Default spots are laid out for a threat from the north: turn them to face this map's mountains.
    const spots = DEFAULT_SPOTS[type].map(([u, v]) => t.toWorld(u, v));
    const free = (x: number, y: number): boolean =>
      !this.placeError(t, type, x, y) && !this.units.some((u) => u.type !== 'CAP' && type !== 'CAP' && Math.hypot(u.x - x, u.y - y) < 1500);
    const spot = spots.find((p) => free(p.x, p.y));
    // Otherwise spiral out from the first spot until the ground allows it.
    const p = spot ?? nearestFree(t, type, spots[0].x, spots[0].y, this.units, -1, 1500, this.zones);
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

  /** What Restock all costs now: every launcher full, and at least 4 spare missiles per battery. */
  restockCost(): number {
    let cost = 0;
    for (const u of this.units) {
      if (!u.launchers.length) continue;
      cost += this.reloadCost(u);
      if (u.spares < 4) cost += this.sparesCost(u);
    }
    return Math.round(cost * 10) / 10;
  }

  /** Refill every launcher and top spares up to 4, as far as the budget goes. Returns what it spent ($M). */
  restock(): number {
    const before = this.s.money;
    for (const u of this.units) this.reload(u);
    for (const u of this.units) if (u.launchers.length && u.spares < 4) this.buySpares(u);
    return Math.round((before - this.s.money) * 10) / 10;
  }

  // ------------------------------------------------------------- the front line

  /** Why an offensive cannot be launched today, or null. */
  offensiveError(): string | null {
    const f = this.s.front;
    if (!f || f.towns.length < 2) return 'There is no road to push up on this map';
    if (f.offensive !== null) return 'Already launched';
    if (this.s.offensiveDay === this.s.day) return 'One offensive a day';
    if (nextObjective(f) < 0) return 'Every town on the road is ours';
    if (this.s.day < 2) return 'Available from day 2';
    if (OFFENSIVE_COST_M > this.s.money) return 'Not enough budget';
    return null;
  }

  /** Send the ground forces up the road to take the next town; the enemy will counter-attack the assault force. */
  launchOffensive(): boolean {
    if (this.offensiveError()) return false;
    const f = this.s.front!;
    this.s.money -= OFFENSIVE_COST_M;
    f.offensive = nextObjective(f);
    const day = this.s.day;
    const rng = new Rng(this.s.seed * 97 + day * 13 + (this.s.pulseIdx ?? 0) * 7);
    const at = assaultSpot(this.terrain, f, f.offensive);
    // The enemy fights hardest for its forward airfield: everything it has goes at that assault force.
    const field = f.towns[f.offensive].airfield;
    const big = (n: number): number => (field ? Math.ceil(n * 1.3) : n);
    const kinds: [PkgKind, number][] = [['drones', big(Math.min(12, 4 + Math.floor(day / 2)))]];
    if (day >= 2) kinds.push(['cruise', big(Math.min(5, 2 + Math.floor(day / 4)))]);
    if (day >= 3 || field) kinds.push(['helo', big(day >= 6 ? 3 : 2)]);
    if (day >= 4 || field) kinds.push(['strike', big(day >= 8 ? 3 : 2)]);
    if (field) kinds.push(['sead', 2], ['drones', big(4 + Math.floor(day / 2))]);
    const counters: PlannedPkg[] = [];
    kinds.forEach(([kind, size], i) => {
      counters.push({
        id: this.s.nextPkg++,
        kind,
        bearing: (this.layout.rot + rng.range(-30, 30) + 360) % 360,
        size,
        t: Math.round(90 + i * 140 + rng.range(0, 60)),
        reported: true,
        target: 'Assault force',
        origin: kind === 'drones' || kind === 'helo' ? at : undefined,
        counter: true,
      });
    });
    // The counter-attack comes from what the enemy has left after today's raids, nearest the assault force first.
    for (const p of counters) p.origin ??= at;
    this.s.plan.push(...assignBases(counters, this.theatre, this.busy(this.pulse?.at, this.s.plan)));
    this.s.plan.sort((a, b) => a.t - b.t);
    return true;
  }

  /** Call today's offensive off before the battle, for the money back. */
  cancelOffensive(): boolean {
    const f = this.s.front;
    if (!f || f.offensive === null) return false;
    f.offensive = null;
    this.s.money += OFFENSIVE_COST_M;
    refundBases(this.s.plan.filter((p) => p.counter), this.theatre);
    this.s.plan = this.s.plan.filter((p) => !p.counter);
    return true;
  }

  /** Price of restoring one hp point of a town. */
  private townRate = 0.3;

  townRepairCost(i: number): number {
    const tn = this.s.front?.towns[i];
    return tn && tn.ours ? Math.ceil((100 - tn.hp) * this.townRate) : 0;
  }

  repairTown(i: number): boolean {
    const tn = this.s.front?.towns[i];
    if (!tn || !tn.ours || tn.hp >= 100) return false;
    const pts = Math.min(100 - tn.hp, Math.floor(this.s.money / this.townRate));
    if (pts <= 0) return false;
    this.s.money -= Math.min(this.s.money, Math.ceil(pts * this.townRate));
    tn.hp += pts;
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
    return placeError(t, type, x, y, this.units, uid, this.zones);
  }

  /** Move a unit (and its launchers with it). */
  place(t: Terrain, u: DeployedUnit, x: number, y: number): string | null {
    const err = this.placeError(t, u.type, x, y, u.uid);
    if (err) return err;
    const dx = x - u.x;
    const dy = y - u.y;
    u.x = x;
    u.y = y;
    // A move puts the enemy's picture of where it was firing from out of date.
    if (dx || dy) delete u.heat;
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

  /** Start a new day: its operations, the first one's plan, and the day's event. */
  replan(): void {
    this.startDay();
    this.planPulse();
    this.s.event = rollEvent(this);
    this.s.eventResult = undefined;
  }

  /** Pick the coming raid's bonus objectives again after the plan changed: half a day's rewards, as there are several raids a day. */
  refreshObjectives(): void {
    const idx = this.s.pulseIdx ?? 0;
    this.s.objectives = pickObjectives(this.s.plan, this.s.day, this.s.seed + idx * 101).map((o) => ({ ...o, rewardM: Math.round(o.rewardM / 2) }));
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
    if (id === 'preempt' && i === 0) this.refreshObjectives();
    return true;
  }

  /** Units an enemy recon drone photographed that are still where it saw them. */
  spotted(u: DeployedUnit): boolean {
    return !!this.s.enemy.known?.some((k) => k.uid === u.uid && Math.hypot(k.x - u.x, k.y - u.y) < 400);
  }

  /** Intel summary lines for the briefing. */
  intel(): string[] {
    const wx = WEATHER[this.s.weather ?? 'clear'];
    const lines: string[] = [];
    const slot = this.pulse;
    const warn = this.s.warn;
    if (slot && warn) {
      const left = (this.s.pulses?.length ?? 1) - (this.s.pulseIdx ?? 0) - 1;
      lines.push(`Next: ${PULSES[slot.type].name.toLowerCase()}, ${PULSES[slot.type].desc}. Expected about ${hhmm(warn.at)}, mainly from the ${SECTOR_NAMES[warn.sector]}. Timings from intel have been out by an hour or two before. ${left ? `${left === 1 ? 'One more operation' : `${left} more operations`} expected today.` : 'The last operation expected today.'}`);
    }
    const push = this.pushNow;
    if (push) {
      const f = this.s.front!;
      lines.push(`Enemy armour is massing at ${f.towns[push.from].name} to attack ${f.towns[push.town].name} with the next raid, with drones and missiles aimed at the town. Keep the town above ${ARMOUR.takeHp}% while the armour assaults it, or strike the armour before it moves.`);
    }
    lines.push(`Weather: ${wx.desc}`);
    const doc = doctrineOf(this.s.enemy.doctrine);
    if (doc) lines.push(this.s.day >= 2 ? `Enemy commander: ${doc.name}. ${doc.desc}` : 'Enemy commander: not yet known. Watch what they send today; by tomorrow we will know who we are up against.');
    const f = this.s.front;
    if (f?.towns.length) {
      const held = f.towns.filter((t) => t.ours);
      const next = nextObjective(f);
      lines.push(`Front line: we hold ${held.map((t) => t.name).join(', ') || 'nothing beyond the airbase'}.${next >= 0 ? ` Next up the road: ${f.towns[next].name}${f.towns[next].airfield ? ', the enemy forward airfield' : ''}, ${(Math.hypot(f.towns[next].x, f.towns[next].y) / 1000).toFixed(0)} km out.` : ''}`);
      if (f.offensive !== null) lines.push(`Offensive on ${f.towns[f.offensive].name} today: keep the assault force above ${ASSAULT_HOLD}% until the raid ends and the town is ours. Expect a counter-attack on it.`);
    }
    lines.push(...this.s.plan
      .filter((p) => p.reported && !p.counter)
      .map((p) => {
        const def = PKG[p.kind];
        const when = p.t < 120 ? 'early' : p.t < 500 ? 'mid-raid' : 'late';
        const aimed = p.aims ? `, aimed at ${p.aims.length > 1 ? `${p.aims.length} of our positions` : 'one of our positions'} their recon photographed` : '';
        const base = this.theatre.find((b) => b.id === p.base);
        const src = base?.known ? `, launching from the ${base.name.toLowerCase()}` : '';
        return `${def.name} from the ${SECTOR_NAMES[sectorOf(p.bearing)]} (${when}): ${def.describe(p.size)}${aimed}${src}`;
      }));
    const counter = this.s.plan.filter((p) => p.counter);
    if (counter.length) lines.push(`Counter-attack on the assault force: ${counter.map((p) => `${PKG[p.kind].name.toLowerCase()} (${p.size})`).join(', ')}`);
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
    // Units still on their way to the depot sit this one out.
    const now = this.clock;
    dep.units = dep.units.filter((u) => u.arrives === undefined || u.arrives <= now);
    const f = this.s.front;
    const off = f && f.offensive !== null ? f.towns[f.offensive] : null;
    return new World({
      towns: f?.towns.filter((t) => t.ours).map((t) => ({ name: t.name, x: t.x, y: t.y, hp: t.hp })),
      enemyAssault: (() => {
        const p = withRaids ? this.pushNow : null;
        if (!p || !f) return undefined;
        return { target: f.towns[p.town].name, from: { x: f.towns[p.from].x, y: f.towns[p.from].y }, to: { x: f.towns[p.town].x, y: f.towns[p.town].y } };
      })(),
      assault: off ? { ...assaultSpot(this.terrain, f!, f!.offensive!), target: off.name, from: columnStart(this.terrain, f!, f!.offensive!) } : undefined,
      zones: this.zones,
      seed: this.s.seed * 31 + this.s.day * 7 + (this.s.pulseIdx ?? 0),
      terrain: this.terrain,
      theatre: JSON.parse(JSON.stringify(this.theatre)) as EnemyBase[],
      deployment: dep,
      raids: withRaids ? toRaids(this.s.plan) : [],
      civil: withRaids,
      upgrades: this.s.upgrades,
      budgetM: this.s.money,
      weather: this.s.weather,
      counterBattery: withRaids ? this.s.day : 0,
      clockStart: withRaids ? this.clock : undefined,
      pulse: withRaids ? this.pulse?.type : undefined,
      awacsDenied: withRaids && (this.s.awacsBackAt ?? 0) > this.clock,
    });
  }

  /** Read the raid's outcome back from the world, pay the bills, let the enemy learn, and plan its next operation. */
  settle(w: World): DayReport {
    const s = this.s;
    const at = this.clock;
    const end = at + w.t / 60;
    const slot = this.pulse;
    if (w.redSupport.awacsKilledAt !== null) s.awacsBackAt = at + w.redSupport.awacsKilledAt / 60 + RED_SUPPORT.replaceH * 60;
    // Weapons still inbound when the day is ended early reach their targets.
    for (const e of w.entities) {
      if (!e.alive || e.side !== 'red' || !e.munition || !e.target) continue;
      e.pos = { ...e.target };
      w.detonate(e);
    }

    finishConvoys(w);
    finishMoves(w);
    // Support calls made during the battle are paid for now.
    s.money = Math.max(0, s.money - w.supportSpentM);
    const losses: string[] = [];
    const promotions: string[] = [];
    const before = new Map(s.deployment.assets.map((a) => [a.name, a.hp]));
    s.deployment.assets = DEFENDED_ASSETS.map((a) => ({ name: a.name, hp: Math.round(w.site(a.name)?.hp ?? 0) }));
    // Units that were not in the battle (still on their way) are as they were.
    const kept: DeployedUnit[] = s.deployment.units.filter((u) => !w.fielded.some((f) => f.unit.uid === u.uid));
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
          .map((l, i) => ({ ...u.launchers[i], x: Math.round(l.site.pos.x), y: Math.round(l.site.pos.y), rounds: l.rounds, hp: l.site !== main && l.site.hp < 99.5 ? Math.round(l.site.hp) : undefined }))
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
      // Damage stays until the crews have repaired it.
      if (main && main.alive && main.hp < 99.5) u.hp = Math.round(main.hp);
      else delete u.hp;
      // Units moved during the battle stay where they ended up.
      u.x = f.unit.x;
      u.y = f.unit.y;
      // The enemy half remembers where it was firing from by the next raid.
      if (f.heat && f.heat >= 2) u.heat = Math.round(f.heat / 2);
      else delete u.heat;
      if (f.radar) u.armWatch = f.radar.armWatch;
      if (f.fu) u.holdFire = f.fu.hold;
      if (f.ciws) u.holdFire = !f.ciws.auto;
      const em = w.gnss.find((j) => j.site === f.sites[0]) ?? w.decoys.find((d) => d.site === f.sites[0]) ?? w.ewj.find((j) => j.site === f.sites[0]);
      if (em) u.on = em.on;
      kept.push(u);
    }
    s.deployment.units = kept;

    // The enemy's side: its installations as the battle left them (launches gave some away, counter-battery
    // strikes drew on their stock), less every aircraft we shot down, which is gone for good.
    const enemyLines: string[] = [];
    const knownBefore = new Set(this.theatre.filter((b) => b.known).map((b) => b.id));
    const th = w.theatre;
    const downed: Partial<Record<Asset, number>> = {};
    const lostByPkg = new Map<number, number>();
    for (const [key, n] of w.redAirLost) {
      const [pkg, tally] = key.split('|');
      const a = TALLY_ASSET[tally];
      if (!a) continue;
      lostByPkg.set(Number(pkg), (lostByPkg.get(Number(pkg)) ?? 0) + n);
      const id = s.plan.find((p) => p.id === Number(pkg))?.base;
      const b = th.find((x) => x.id === id) ?? th.find((x) => avail(x, a) > 0);
      if (b) draw(b, a, n);
      downed[a] = (downed[a] ?? 0) + n;
    }
    const lost = (s.enemyLost ??= {});
    for (const [a, n] of Object.entries(downed) as [Asset, number][]) lost[a] = (lost[a] ?? 0) + n;
    if (Object.keys(downed).length) enemyLines.push(`Shot down: ${(Object.entries(downed) as [Asset, number][]).map(([a, n]) => assetCount(a, n)).join(', ')}. The enemy will not get them back.`);
    const found = th.filter((b) => b.known && !knownBefore.has(b.id));
    if (found.length) enemyLines.push(`Located by their launches: ${found.map((b) => b.name.toLowerCase()).join(', ')}. They are on the map and open to a deep strike.`);
    s.theatre = th;
    // A raid that bled badly makes the enemy cautious: fewer ready aircraft and a warier planner.
    let flown = 0;
    let downAir = 0;
    for (const p of s.plan) {
      const a = PKG[p.kind].asset;
      if (!a || !AIRCRAFT.includes(a)) continue;
      flown += p.size;
      downAir += Math.min(p.size, lostByPkg.get(p.id) ?? 0);
    }
    if (flown >= SHAKEN.minFlown && downAir / flown >= SHAKEN.lossShare) {
      const cut = Math.min(SHAKEN.maxCut, (downAir / flown) * 0.5);
      s.shaken = { until: end + SHAKEN.hours * 60, cut };
      enemyLines.push(`The enemy lost ${downAir} of ${flown} aircraft. Expect smaller raids (about ${Math.round(cut * 100)}% less) for the next ${SHAKEN.hours} hours.`);
    }
    // Aircraft that came back need turning round before they fly again.
    for (const p of s.plan) {
      const a = PKG[p.kind].asset;
      const back = p.size - (lostByPkg.get(p.id) ?? 0);
      if (!a || !p.base || !AIRCRAFT.includes(a) || back <= 0) continue;
      (s.sorties ??= []).push({ key: `${p.base}:${a}`, n: back, until: end + (TURNAROUND_H[a] ?? 6) * 60 });
    }

    // The front line: towns knocked flat fall, a surviving assault force takes its town.
    const frontLines: string[] = [];
    const f = s.front;
    if (f) {
      for (const tn of f.towns) {
        const site = tn.ours ? w.site(tn.name) : undefined;
        if (site) tn.hp = Math.round(site.hp);
      }
      // The enemy's armour: a town knocked down while it was assaulted falls to it.
      if (w.enemyArmour) {
        const tn = f.towns.find((x) => x.name === w.enemyArmour!.target);
        if (w.enemyArmour.endOfRaid(w) === 'taken') {
          if (tn) tn.hp = 0;
          frontLines.push(`Enemy armour overran ${w.enemyArmour.target} after the raids knocked it below ${ARMOUR.takeHp}%.`);
        } else frontLines.push(`The enemy attack on ${w.enemyArmour.target} was beaten off: the town held${tn ? ` at ${tn.hp}%` : ''}.`);
        s.enemyPush = null;
      }
      const fallen = f.towns.findIndex((tn) => tn.ours && tn.hp <= 0);
      if (fallen >= 0) {
        for (const tn of f.towns.slice(fallen)) {
          if (!tn.ours) continue;
          tn.ours = false;
          tn.hp = 100;
          frontLines.push(`${tn.name} has fallen to the enemy. We lose its income and the ground round it.`);
        }
      }
      if (f.offensive !== null) {
        const tn = f.towns[f.offensive];
        const hp = Math.round(w.site('Assault force')?.hp ?? 0);
        // The column has to reach its start line first; then the force has to hold.
        const arrived = !w.column || w.assaultOutcome === 'arrived';
        if (hp >= ASSAULT_HOLD && arrived && (fallen < 0 || fallen > f.offensive)) {
          tn.ours = true;
          tn.hp = TAKEN_HP;
          frontLines.push(`The assault force held (${hp}%) and took ${tn.name}: +$${tn.incomeM}M a day, and units can now deploy round it.`);
          const before = th.map((b) => ({ ...b.stock }));
          enemyLines.push(...overrun(th, tn.name, f.towns.find((x) => !x.ours)));
          th.forEach((b, i) => {
            for (const [a, n] of Object.entries(before[i]) as [Asset, number][]) {
              const gone = Math.floor(n - (b.stock[a] ?? 0));
              if (gone > 0) lost[a] = (lost[a] ?? 0) + gone;
            }
          });
        } else {
          frontLines.push(`The offensive on ${tn.name} failed: ${hp > 0 && !arrived ? 'the assault column never reached its start line' : `the assault force was ${hp > 0 ? `down to ${hp}%` : 'destroyed'}`}.`);
        }
      }
      if (f.offensive !== null) {
        s.offensiveDay = s.day;
        f.offensive = null;
      }
      // Units left outside the ground we hold pull back.
      const zones = this.zones;
      for (const u of s.deployment.units) {
        if (u.type === 'CAP' || inZones(zones, u.x, u.y)) continue;
        const z = zones.reduce((a, b) => (Math.hypot(u.x - b.x, u.y - b.y) - b.r < Math.hypot(u.x - a.x, u.y - a.y) - a.r ? b : a));
        const d = Math.hypot(u.x - z.x, u.y - z.y);
        const p = nearestFree(this.terrain, u.type, z.x + ((u.x - z.x) * z.r * 0.8) / d, z.y + ((u.y - z.y) * z.r * 0.8) / d, s.deployment.units, u.uid, 300, zones);
        this.place(this.terrain, u, p.x, p.y);
        frontLines.push(`${CATALOG[u.type].name} pulled back inside our lines.`);
      }
      // Enemy launch teams too close to the ground we now hold move further back.
      enemyLines.push(...fallBack(this.terrain, th, zones));
    }

    // Enemy learning: packages that hit something are repeated, from the same direction.
    const lessons: string[] = [];
    const clamp = (x: number): number => Math.min(4, Math.max(0.3, x));
    // Several raids a day: each teaches the enemy a little less than a whole day used to.
    const learn = (m: number): number => Math.pow(m, 0.6);
    for (const p of s.plan) {
      if (p.kind === 'dark' || p.kind === 'decoys' || p.kind === 'recon') continue;
      const hits = w.pkgHits.get(p.id) ?? 0;
      const sec = sectorOf(p.bearing);
      if (hits > 0) {
        s.enemy.kindW[p.kind] = clamp(s.enemy.kindW[p.kind] * learn(doctrineOf(s.enemy.doctrine)?.learn ?? 1.25));
        s.enemy.axisW[sec] = clamp(s.enemy.axisW[sec] * learn(1.35));
        lessons.push(`${PKG[p.kind].name} from the ${SECTOR_NAMES[sec]} got through (${hits} hit${hits > 1 ? 's' : ''}). Expect more of that.`);
      } else {
        s.enemy.kindW[p.kind] = clamp(s.enemy.kindW[p.kind] * learn(0.92));
        s.enemy.axisW[sec] = clamp(s.enemy.axisW[sec] * learn(0.9));
      }
    }
    // Recon that got home tells tomorrow's strike planners where our units are.
    for (const e of w.entities) if (e.alive && e instanceof ReconDrone) for (const p of e.seen) w.reconSeen.set(p.uid, p);
    // What the enemy knows carries on from raid to raid: earlier sightings of units that have not moved, new
    // photographs, and batteries it located by their launches. A move, or most of a day, makes a sighting stale.
    const where = new Map<number, Sighting>();
    const still = (k: Sighting): boolean => {
      const u = s.deployment.units.find((x) => x.uid === k.uid);
      return !!u && Math.hypot(u.x - k.x, u.y - k.y) < 400;
    };
    for (const k of s.enemy.known ?? []) if (still(k) && end - (k.at ?? end) < SIGHTING_MIN) where.set(k.uid, k);
    const photographed = [...w.reconSeen.values()];
    for (const p of photographed) where.set(p.uid, { ...p, at: end });
    for (const l of w.exposure.located) {
      const k = { uid: l.uid, x: l.x, y: l.y, name: l.unit, at: end };
      if (still(k)) where.set(l.uid, k);
    }
    s.enemy.known = [...where.values()];
    if (s.plan.some((p) => p.kind === 'recon')) {
      s.enemy.kindW.recon = clamp((s.enemy.kindW.recon ?? 1) * learn(photographed.length ? 1.2 : 0.85));
      if (photographed.length) lessons.push(`Enemy recon photographed ${photographed.length} of our positions. Move those units before the next raid or expect strikes on them.`);
    }
    const marked = w.exposure.located.filter((l) => still({ uid: l.uid, x: l.x, y: l.y, name: l.unit }));
    if (marked.length) lessons.push(`The enemy still has ${marked.length === 1 ? `the ${marked[0].unit} marked where it fired from` : `${marked.length} of our batteries marked where they fired from`}. Move ${marked.length === 1 ? 'it' : 'them'} or expect another strike there.`);
    // Decoys work if they drew missiles.
    if (s.plan.some((p) => p.kind === 'decoys')) {
      const n = w.stats.decoyMissiles;
      s.enemy.kindW.decoys = Math.min(2, clamp(s.enemy.kindW.decoys * learn(n >= 4 ? 1.2 : n >= 2 ? 1 : 0.8)));
      if (n >= 2) lessons.push(`We spent ${n} missiles on decoy drones. The enemy will send more of them.`);
    }
    const dayLen = Math.max(1, w.t);
    const loud = [...w.radiating].filter(([code, sec]) => /^(LR|MR|EW)/.test(code) && sec / dayLen > 0.8);
    if (loud.length && s.day >= 2) {
      s.enemy.kindW.sead = clamp(s.enemy.kindW.sead * learn(1.15));
      lessons.push('Your big radars radiated the whole raid: enemy ESM has them mapped, and more SEAD is likely.');
    }

    s.civilLosses += w.stats.civilian;
    const objectives = (s.objectives ?? []).map((o) => ({ name: objectiveName(o), rewardM: o.rewardM, done: objectiveStatus(o, w, true) === 'done' }));
    if (w.reconDenied) objectives.push({ name: `Intel denied: ${w.reconDenied} recon drone${w.reconDenied > 1 ? 's' : ''} shot down with photos aboard`, rewardM: w.reconDenied * RECON_BOUNTY_M, done: true });
    const bonus = objectives.reduce((t, o) => t + (o.done ? o.rewardM : 0), 0);
    s.money += bonus;
    const lastToday = (s.pulseIdx ?? 0) + 1 >= (s.pulses?.length ?? 1);
    // The day's income is paid at 06:00, after the day's last raid.
    const income = lastToday ? this.income() : 0;
    const timeline = s.plan
      .filter((p) => p.kind !== 'dark')
      .map((p) => {
        const t = w.pkgTally.get(p.id) ?? { spawned: 0, down: 0, hits: 0, missed: 0, home: 0 };
        const b = this.theatre.find((x) => x.id === p.base);
        return { at: at + p.t / 60, name: PKG[p.kind].name, size: p.size, from: SECTOR_NAMES[sectorOf(p.bearing)], base: b?.known ? b.name : undefined, counter: p.counter, ...t };
      });
    const report: DayReport = {
      day: s.day,
      timeline,
      at,
      end,
      pulse: slot?.type,
      bonusM: bonus,
      kills: w.stats.kills,
      killsBy: { ...w.stats.killsBy },
      leakers: w.stats.leakers,
      hurt: [...w.hurt].map(([by, h]) => ({ by, dmg: Math.round(h.dmg), hits: h.hits, sites: [...h.sites] })).filter((h) => h.dmg > 0).sort((a, b) => b.dmg - a.dmg),
      missilesFired: w.stats.fired.LR + w.stats.fired.MR + w.stats.fired.SH + w.stats.fired.AAM,
      missileCostM: Math.round(w.stats.costM * 10) / 10,
      civilian: w.stats.civilian,
      fratricide: w.stats.fratricide,
      income,
      damage: s.deployment.assets.map((a) => ({ name: a.name, lost: (before.get(a.name) ?? 100) - a.hp, hp: a.hp })),
      losses,
      front: frontLines,
      lessons,
      promotions,
      objectives,
      supportM: Math.round(w.supportSpentM * 10) / 10,
      enemy: enemyLines,
    };
    s.history.push(report);

    const airbase = s.deployment.assets.find((a) => a.name === 'Airbase')!;
    if (airbase.hp <= 0) s.over = { won: false, reason: 'The airbase was destroyed. The defence has failed.' };
    else if (s.front?.towns.some((t) => t.airfield && t.ours)) s.over = { won: true, reason: `We took the enemy's forward airfield on day ${s.day}. The front has collapsed: the campaign is won.` };
    else if (s.civilLosses >= CIVIL_LIMIT) s.over = { won: false, reason: `${s.civilLosses} civil airliners shot down. You have been relieved of command.` };
    else if (s.day >= CAMPAIGN_DAYS && lastToday) {
      // The ceasefire: graded by how far up the road we got.
      const towns = s.front?.towns ?? [];
      const held = townsHeld(s.front);
      s.grade = towns.length && held >= towns.length - 1 ? 'Gold' : held >= 2 || !towns.length ? 'Silver' : 'Bronze';
      s.over = { won: true, reason: `Ceasefire after ${CAMPAIGN_DAYS} days: the airbase held${towns.length ? `, and we hold ${held} of the ${towns.length} towns on the road` : ''}. ${s.grade} grade.` };
    }
    const medals = battleMedals(w);
    if (s.day >= 3 && report.leakers === 0 && report.kills > 0) medals.push(award('clean') ?? '');
    if (s.over?.won) {
      medals.push(award('victory') ?? '');
      if (s.difficulty === 'hard') medals.push(award('veteran') ?? '');
      if (s.civilLosses === 0 && s.history.every((r) => !r.fratricide)) medals.push(award('hands') ?? '');
    }
    report.medals = medals.filter(Boolean);
    s.clock = end;
    if (!s.over && !lastToday) {
      // On to the enemy's next operation today: the planning lull starts now.
      s.pulseIdx = (s.pulseIdx ?? 0) + 1;
      const next = this.pulse!;
      next.at = Math.max(next.at, Math.ceil(end + 30));
      this.planPulse();
    } else if (!s.over) {
      // The night: the clock runs on to 06:00, when the day's income is paid and the enemy's installations get
      // their reinforcements. Loaned units leave.
      s.day++;
      this.advanceTo(Math.max(end, DAY_START_MIN + (s.day - 1) * 1440));
      s.money += income;
      s.incomePenalty = 0;
      const grant = this.emergencyGrant();
      if (grant) {
        s.money += grant;
        report.grantM = grant;
      }
      s.deployment.units = s.deployment.units.filter((u) => !u.loan);
      reinforce(this.theatre, this.diff.threat);
      this.replan();
      if (s.autoRestock) report.restockM = this.restock();
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
    const towns = townsHeld(s.front) * 300 + (s.front?.towns.some((t) => t.airfield && t.ours) ? 1500 : 0);
    return Math.max(0, Math.round(kills * 10 + assets * 5 + towns + s.money - civ * 500 - frat * 200 + (s.over?.won ? 1000 : 0)));
  }
}

/** Distance helper for the UI: is a ground point within the deployment area? */
export const inDeployArea = (x: number, y: number): boolean => hdist(v3(x, y), v3()) <= DEPLOY_RADIUS;
