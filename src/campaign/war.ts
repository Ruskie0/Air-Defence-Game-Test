import { CATALOG, DEFENDED_ASSETS, type DeployedUnit, RANKS, rankOf } from '../sim/catalog';
import { inZones, nearestFree } from '../sim/deploy';
import type { Sighting } from '../sim/entities';
import { GROUND, Ground, type GroundState, type Order } from '../sim/ground';
import { MOBILITY, orderMove, shiftUnit } from '../sim/mobility';
import { RED_SUPPORT, sweepCap } from '../sim/redair';
import { ENEMY_AD } from '../sim/enemyad';
import { ARTY } from '../sim/exposure';
import { hdist } from '../sim/math';
import { Rng } from '../sim/rng';
import { AIRCRAFT, type Asset, TALLY_ASSET, assetCount, avail, basesWith, draw, fallBack, overrun, reinforce } from '../sim/theatre';
import type { Fielded, Stats, World } from '../sim/world';
import { ARMOUR_BDE, CAMPAIGN_DAYS, CIVIL_LIMIT, Campaign, DayReport, EMERGENCY, SHAKEN } from './campaign';
import { DAY_START_MIN, PULSES, PulseType, REPAIR_PER_H, TURNAROUND_H, hhmm, isNight } from './clock';
import { doctrineOf } from './doctrine';
import { TAKEN_HP } from './front';
import { PKG, PkgKind, PlannedPkg, SECTOR_NAMES, aimAtSightings, assignBases, planDay, sectorOf, toRaids } from './raidgen';
import { WEATHER } from './weather';

/**
 * The living war: one world for the whole campaign, on one clock. There are no separate raids. The enemy
 * banks strength as the day goes on and flies an operation whenever it has massed enough, from whatever its
 * installations have ready, aimed at what it knows of us. Income, reinforcements, deliveries and repairs all
 * happen on the same clock while the battle runs. Game-level pacing, not a real air tasking cycle.
 */
export const WAR = {
  /** Sim seconds between bookkeeping passes (losses, deliveries, repairs, the enemy planner). */
  tickS: 5,
  /** An operation is this share of the enemy's daily strength, picked at random in the range. */
  opShare: [0.33, 0.5] as [number, number],
  /** Time on target: the second wave arrives this long after the first (s), and each package within this of its wave. */
  waveGapS: 480,
  totSpreadS: 150,
  /** Intel warns of an operation once the enemy has massed this share of it. */
  warnAt: 0.7,
  /** Packages are judged (what got through, what the enemy learns) this long after launch (min). */
  judgeMin: 150,
  /** An offensive takes its town once its force has held its start line this long (min) above ASSAULT_HOLD. */
  holdMin: 60,
  /** The enemy armour's attack goes in between these hours of the day it is planned for. */
  pushHours: [8, 16] as [number, number],
  /** Where new units turn up: this far from the airbase's centre, towards our rear (m). */
  depotM: 1500,
};

/** Close air support from the CAP squadron. Game-level numbers. */
export const CAS = {
  reachM: 160000,
  /** Transit speed (m/s), and rearming once home (s). */
  speed: 230,
  rearmS: 1500,
  /** Chance per jet of being lost to each enemy SAM site covering the target, and to each enemy fighter up. */
  samLoss: 0.18,
  fighterLoss: 0.05,
  /** Strength each surviving jet takes off the battalion (percent). */
  hitPerJet: [12, 18] as [number, number],
};

/** Unit types that can be attached to follow a battalion, and how far ahead it gets before an MR battery bounds forward. */
const ESCORT_TYPES = ['SH', 'GUN', 'CIWS', 'LASER', 'MR'];
const ESCORT_BOUND_M = 8000;
const PUSH_ANSWER_MIN = 90;

/** Our rocket artillery battalion. Game-level numbers. */
export const BLUE_ARTY = {
  rangeM: 60000,
  /** Minutes between salvos, rocket flight time (s), and what a salvo takes off (percent). */
  cycleMin: 20,
  flightS: 80,
  hit: [6, 10] as [number, number],
  /** Chance each salvo draws counter-battery fire. */
  counterChance: 0.35,
};

/** A package in the air, until it is judged. */
export interface Flight {
  pkg: PlannedPkg;
  /** Campaign clock at launch (min). */
  at: number;
}

/** The living war's own part of the save. */
export interface WarState {
  /** The clock has started running: from then on orders take time to arrive and moves take time to drive. */
  begun: boolean;
  /** Threat points the enemy has banked, and how many it is massing for its next operation. */
  pool: number;
  opSize: number;
  opIdx: number;
  /** Intel has warned of the operation being massed. */
  warned: boolean;
  flights: Flight[];
  /** Clock time the enemy armour's attack goes in today, if one is planned. */
  pushAt?: number;
  /** The ground war: battalions, capture bars, our objective. */
  ground?: GroundState;
  /** CAS sorties out: the squadron, the battalion, when they reach it and when the pair is back on station (clock). */
  cas?: { uid: number; bn: number; at: number; back: number; done?: boolean }[];
  /** Our rocket batteries: when each can fire again, and salvos in the air (clock). */
  artyReady?: Record<number, number>;
  salvos?: { bn: number; at: number }[];
  /** Earliest campaign minute the enemy answers another push with air. */
  pushAnswer?: number;
  /** Air defence units attached to follow a battalion. */
  escorts?: { uid: number; bn: number }[];
  /** The last objective logged, so a repeated order is not logged again. */
  lastObjective?: string;
  /** The day so far, for the 06:00 report. */
  day: { front: string[]; enemy: string[]; lessons: string[]; losses: string[]; hp: Record<string, number> };
}

const blankDay = (): WarState['day'] => ({ front: [], enemy: [], lessons: [], losses: [], hp: {} });

export class War {
  readonly c: Campaign;
  w: World;
  /** Raised when the campaign has ended (the UI shows the final debrief). */
  onOver: (() => void) | null = null;
  /** Raised at 06:00 with the day's report. */
  onDay: ((r: DayReport) => void) | null = null;
  private nextTick = 0;
  private escortDrawn = 0;
  private lastClock: number;
  /** Losses and kills already written into the campaign, so each tick takes only what is new. */
  private written = new Map<string, number>();
  private killsSeen = new Map<string, number>();
  private dayStats: Stats;
  /** Units whose death has been booked. */
  private dead = new Set<number>();

  constructor(c: Campaign) {
    this.c = c;
    const s = c.s;
    s.war ??= { begun: false, pool: 0, opSize: 0, opIdx: 0, warned: false, flights: [], day: blankDay() };
    s.plan = [];
    s.objectives = [];
    s.event = null;
    this.w = this.build();
    this.lastClock = c.clock;
    this.dayStats = JSON.parse(JSON.stringify(this.w.stats)) as Stats;
    if (!s.war.opSize) this.newOp(0.5);
    this.snapshotHp();
  }

  get st(): WarState {
    return this.c.s.war!;
  }

  /** The campaign clock now (minutes). */
  get clock(): number {
    return (this.w.clockStart ?? 0) + this.w.t / 60;
  }

  /** The world for the war as the campaign state has it: every unit in place, every fix the enemy holds. */
  private build(): World {
    const c = this.c;
    const w = c.makeLiveWorld();
    w.exposure.mode = 'intel';
    w.scenario.doneMsg = '';
    w.redSupport.denied = (c.s.awacsBackAt ?? 0) > c.clock;
    for (const k of c.s.enemy.known ?? []) {
      w.exposure.fixes.push({ uid: k.uid, unit: k.name, x: k.x, y: k.y, t: ((k.at ?? c.clock) - c.clock) * 60, how: 'elint' });
    }
    c.s.civilBefore = c.s.civilLosses;
    this.buildGround(w);
    return w;
  }

  /** The ground war on this world: from the save, or the opening line-up on the first day. */
  private buildGround(w: World): void {
    const c = this.c;
    const f = c.s.front;
    if (!f?.towns.length) return;
    const st = this.st;
    const fresh = !st.ground;
    const g = new Ground(f.towns, st.ground ?? { bats: [], capture: [], nextId: 1 }, {
      owner: (i) => (f.towns[i].ours ? 'blue' : 'red'),
      captured: (i, by) => (by === 'blue' ? this.takeTown(i, Math.round(this.w.ground?.bats.filter((b) => b.side === 'blue' && b.alive && Math.abs(b.s - (this.w.ground?.townS[i] ?? 0)) < GROUND.townR).reduce((m, b) => Math.max(m, b.strength), 0) ?? 70)) : this.townFalls(i)),
      event: (msg) => this.onEvent?.(msg),
    });
    if (fresh) {
      // Two of ours at the front town and a third at the depot.
      const front = f.towns.map((t, i) => (t.ours ? i : -1)).filter((i) => i >= 0).pop() ?? -1;
      const fs = front >= 0 ? g.townS[front] : g.blueDepot;
      g.add('blue', 'armour', fs - 400);
      g.add('blue', 'mech', fs - 900);
      g.add('blue', 'mech', g.blueDepot);
      g.add('blue', 'arty', Math.max(g.blueDepot, fs - GROUND.artyStandoffM));
      const red = f.towns.map((t, i) => (t.ours ? -1 : i)).filter((i) => i >= 0);
      // The enemy garrisons its nearest town and has one more coming up: it needs reinforcements before it can attack.
      if (red.length) g.add('red', 'armour', g.townS[red[0]] + 400);
      g.add('red', 'mech', g.redDepot);
    }
    for (const b of g.bats) if (b.side === 'blue' && b.alive) {
      const p = g.place(b);
      b.site = w.addBattalionSite(b.name, p.x, p.y, b.strength);
      b.vuln = b.site.vuln;
    }
    w.ground = g;
  }

  /** A unit that should be on the map: delivered (or bought before the war began). */
  private fieldable(u: DeployedUnit): boolean {
    return u.arrives === undefined || u.arrives <= this.c.clock;
  }

  /** Nothing of the enemy's is in the air and no missile is flying: a safe moment to save. */
  quiet(): boolean {
    const w = this.w;
    return !w.missiles.length && w.pendingCount === 0 && !w.entities.some((e) => e.alive && e.side === 'red' && (e.munition || e.airborne)) && !w.exposure.barrages.length;
  }

  fielded(uid: number): Fielded | undefined {
    return this.w.fielded.find((f) => f.unit.uid === uid);
  }

  // ------------------------------------------------------------- orders from the plan overlay

  /** A unit's record changed on the plan overlay (reloaded, refitted, moved before the war began): match the map to it. */
  apply(u: DeployedUnit): void {
    const w = this.w;
    const f = this.fielded(u.uid);
    if (!this.st.begun) {
      // Before the clock has run nothing has happened yet: build the world again as the records now are.
      this.rebuild();
      return;
    }
    if (!f) return;
    if (f.fu) {
      f.fu.spares = u.spares;
      u.launchers.forEach((l, i) => {
        const fl = f.fu!.launchers[i];
        if (fl) {
          if (fl.site.alive) fl.rounds = l.rounds;
        } else w.addLauncher(f, l.x, l.y, l.rounds);
      });
    }
    if (f.fighters) while (f.fighters.filter((x) => x.alive).length < u.aircraft && w.site('Airbase')?.alive !== false) w.addFighter(f);
    if (f.radar && CATALOG[u.type].sector) f.radar.boresight = u.facing;
  }

  /** Every unit's record may have changed (restock all, the morning restock). */
  applyAll(): void {
    if (!this.st.begun) return this.rebuild();
    for (const u of this.c.units) this.apply(u);
  }

  /** Raised when the world is built again (before the war has begun), so the views can follow it. */
  onWorld: ((w: World) => void) | null = null;
  /** Something that wants the player's decision happened (the game may stop the clock for it). */
  onEvent: ((msg: string) => void) | null = null;
  private warnedAt: number | undefined;
  private flagged = new Set<number>();

  private rebuild(): void {
    if (this.w.ground) this.st.ground = this.w.ground.save();
    this.w = this.build();
    this.onWorld?.(this.w);
  }

  /** A unit was scrapped. */
  remove(uid: number): void {
    if (!this.st.begun) return this.rebuild();
    const f = this.fielded(uid);
    if (f) this.w.removeUnit(f);
  }

  /** Send a unit somewhere: it packs up and drives once the war has begun, and is simply put there before. */
  move(u: DeployedUnit, x: number, y: number): string | null {
    if (!this.st.begun) {
      const err = this.c.place(this.c.terrain, u, x, y);
      if (!err) this.apply(u);
      return err;
    }
    const f = this.fielded(u.uid);
    // A move order takes it off escort duty.
    if (this.st.escorts) this.st.escorts = this.st.escorts.filter((e) => e.uid !== u.uid);
    if (!f) {
      // Still on its way: it will drive to the new spot when it reaches the depot.
      const err = this.c.placeError(this.c.terrain, u.type, x, y, u.uid);
      if (!err) this.c.place(this.c.terrain, u, x, y);
      return err;
    }
    const err = orderMove(this.w, f, x, y);
    if (!err) this.w.layoutSeq++;
    return err;
  }

  /** The player's objective for the ground war: push for a town (it must be the next one up the road) or hold one of ours. */
  setObjective(kind: 'push' | 'hold', town: number): string | null {
    const g = this.w.ground;
    const f = this.c.s.front;
    if (!g || !f) return 'No ground war on this map';
    const t = f.towns[town];
    if (!t) return 'No such town';
    if (kind === 'push' && (t.ours || town !== f.towns.findIndex((x) => !x.ours))) return 'Push for the next town up the road the enemy holds';
    if (kind === 'hold' && !t.ours) return 'Hold a town we hold';
    const key = `${kind}${town}`;
    if (g.setObjective(kind, town) && key !== this.st.lastObjective && (this.st.lastObjective = key)) this.w.log(kind === 'push' ? `Objective: take ${t.name}. Battalions ordered to advance head for it; it falls ${Math.round(GROUND.captureS / 60)} minutes after we hold it uncontested.` : `Objective: hold ${t.name}. Battalions ordered to advance move up to it and dig in.`, 'raid');
    return null;
  }

  /** An order to one of our battalions: advance on the objective, hold where it is, or pull back. */
  orderBattalion(id: number, o: Order): string | null {
    const g = this.w.ground;
    const b = g?.bats.find((x) => x.id === id);
    if (!g || !b) return 'No such battalion';
    return g.order(b, o);
  }

  /** The battalion this unit is escorting, if any. */
  escortOf(uid: number): number | undefined {
    return this.st.escorts?.find((e) => e.uid === uid)?.bn;
  }

  /**
   * Attach an air defence unit to follow a battalion up the road (bn null detaches it: it drives back inside our
   * lines). SHORAD, guns, CIWS and lasers keep 2 to 3 km behind and fight on the move; an MR battery follows in
   * bounds, packing up and driving when the battalion is 8 km ahead, and is dark while it moves.
   */
  escort(uid: number, bn: number | null): string | null {
    const f = this.w.fielded.find((x) => x.unit.uid === uid);
    if (!f || !f.sites[0]?.alive) return 'No such unit';
    if (!ESCORT_TYPES.includes(f.unit.type)) return 'Only SHORAD, guns, CIWS, lasers and MR batteries can escort';
    const list = (this.st.escorts ??= []).filter((e) => e.uid !== uid);
    this.st.escorts = list;
    if (bn === null) {
      const u = f.unit;
      const z = this.c.zones.reduce((a, b) => (Math.hypot(u.x - b.x, u.y - b.y) - b.r < Math.hypot(u.x - a.x, u.y - a.y) - a.r ? b : a));
      const p = nearestFree(this.c.terrain, u.type, z.x, z.y, this.c.units, u.uid, 600, this.c.zones);
      orderMove(this.w, f, p.x, p.y, true);
      this.w.log(`${this.w.unitName(f)} detached: driving back inside our lines`, 'info');
      return null;
    }
    const b = this.w.ground?.bats.find((x) => x.id === bn && x.side === 'blue' && x.alive);
    if (!b) return 'No such battalion';
    list.push({ uid, bn });
    this.w.log(`${this.w.unitName(f)} is following ${b.name}`, 'info');
    return null;
  }

  private escortStep(dt: number): void {
    const g = this.w.ground;
    const list = this.st.escorts;
    if (!g || !list?.length) return;
    const w = this.w;
    const rank = new Map<number, number>();
    let moved = false;
    for (const e of [...list]) {
      const f = w.fielded.find((x) => x.unit.uid === e.uid);
      const b = g.bats.find((x) => x.id === e.bn && x.alive);
      if (!f || !f.sites[0]?.alive) {
        this.st.escorts = this.st.escorts!.filter((x) => x !== e);
        continue;
      }
      if (!b) {
        this.escort(e.uid, null);
        continue;
      }
      const i = rank.get(b.id) ?? 0;
      rank.set(b.id, i + 1);
      // Behind it on the road, staggered: the side it came from is the side away from the enemy.
      const back = b.side === 'blue' ? -1 : 1;
      const t = g.at(b.s + back * (2500 + 500 * i), (i % 2 ? 1 : -1) * (300 + 200 * i));
      const p = f.sites[0].pos;
      const d = Math.hypot(t.x - p.x, t.y - p.y);
      if (f.unit.type === 'MR') {
        if (!f.move && d > ESCORT_BOUND_M) orderMove(w, f, t.x, t.y, true);
        continue;
      }
      if (f.move) continue;
      if (d < 150) continue;
      const k = Math.min(1, (MOBILITY[f.unit.type].speed * dt) / d);
      shiftUnit(w, f, p.x + (t.x - p.x) * k, p.y + (t.y - p.y) * k);
      moved = true;
    }
    // Coverage is redrawn now and then while escorts drive, not every step.
    if (moved && w.t - this.escortDrawn > 20) {
      this.escortDrawn = w.t;
      w.layoutSeq++;
    }
  }

  /**
   * Pushing is when the enemy throws its air at us: battalions advancing past our forward town draw a helicopter
   * and drone package aimed at them, at most every PUSH_ANSWER_MIN.
   */
  private answerPush(): void {
    const g = this.w.ground;
    const s = this.c.s;
    const f = s.front;
    if (!g || !f || this.clock < (this.st.pushAnswer ?? 0)) return;
    const front = f.towns.map((t, i) => (t.ours ? g.townS[i] : -Infinity)).reduce((a, b) => Math.max(a, b), g.blueDepot);
    const going = g.bats.filter((b) => b.side === 'blue' && b.alive && !b.broken && b.order === 'advance' && b.kind !== 'arty' && b.s > front + GROUND.townR).sort((a, b) => b.s - a.s);
    if (!going.length) return;
    this.st.pushAnswer = this.clock + PUSH_ANSWER_MIN;
    const out: PlannedPkg[] = [];
    going.slice(0, 2).forEach((b, i) => {
      const a = g.at(b.s);
      const c = g.at(b.s + 8000);
      const base = { bearing: (Math.atan2(c.x - a.x, c.y - a.y) * 180) / Math.PI, t: 0, reported: true, origin: { x: b.pos.x, y: b.pos.y }, target: b.name };
      if (i === 0) out.push({ ...base, id: s.nextPkg++, kind: 'helo', size: Math.min(4, 2 + Math.floor(s.day / 4)) });
      out.push({ ...base, id: s.nextPkg++, kind: 'drones', size: Math.min(10, 4 + Math.floor(s.day / 2)) });
    });
    const plan = assignBases(out, this.c.theatre, this.c.busy(this.clock));
    if (!plan.length) return;
    timeOnTarget(plan, new Rng(s.seed * 97 + Math.round(this.clock)));
    this.fly(plan);
    this.w.log(`Intel: the enemy is sending helicopters and drones against our advancing battalions`, 'alert');
  }

  /** Why the CAP squadron cannot fly close air support on this enemy battalion now, or null if it can. */
  casError(id: number): string | null {
    const b = this.w.ground?.bats.find((x) => x.id === id && x.side === 'red' && x.alive);
    if (!b) return 'No such battalion';
    const sq = this.casSquadron();
    if (!sq) return this.w.fielded.some((f) => f.unit.type === 'CAP') ? 'No fighters ready: on a sortie, rearming or lost' : 'Needs a CAP squadron';
    if (Math.hypot(b.pos.x, b.pos.y) > CAS.reachM) return `Beyond the fighters' reach (${CAS.reachM / 1000} km)`;
    return null;
  }

  /** A CAP squadron with at least two fighters on station or on the ground ready, not on a CAS sortie. */
  private casSquadron(): Fielded | undefined {
    return this.w.fielded.find((f) => f.unit.type === 'CAP' && !this.st.cas?.some((x) => x.uid === f.unit.uid) && (f.fighters?.filter((x) => x.alive && (x.state === 'station' || (x.state === 'ground' && x.groundUntil <= this.w.t + 60))).length ?? 0) >= 2);
  }

  /**
   * Close air support: the CAP pair leaves its station, flies out through whatever enemy SAM sites cover the
   * battalion and past any enemy fighters up, attacks, and comes home to rearm. The air picture over the base
   * has a gap while it is away. Abstracted: the pair is off the map for the sortie, and the risk and the damage
   * are rolled when it reaches the target.
   */
  cas(id: number): string {
    const err = this.casError(id);
    if (err) return err;
    const b = this.w.ground!.bats.find((x) => x.id === id)!;
    const sq = this.casSquadron()!;
    const jets = sq.fighters!.filter((x) => x.alive).slice(0, 2);
    const out = Math.hypot(b.pos.x, b.pos.y) / CAS.speed;
    for (const j of jets) {
      j.state = 'ground';
      j.airborne = false;
      j.groundUntil = this.w.t + 2 * out + CAS.rearmS;
    }
    (this.st.cas ??= []).push({ uid: sq.unit.uid, bn: id, at: this.clock + out / 60, back: this.clock + (2 * out + CAS.rearmS) / 60 });
    const line = `${this.w.unitName(sq)} is flying close air support against ${b.name}: over the target in about ${Math.max(1, Math.round(out / 60))} minutes, back on station in ${Math.round((2 * out + CAS.rearmS) / 60)}.`;
    this.w.log(line, 'info');
    return line;
  }

  /** CAS sorties reaching their target: enemy SAM sites and fighters take their chance, the survivors attack. */
  private casStep(): void {
    const st = this.st;
    if (!st.cas?.length) return;
    const w = this.w;
    const now = this.clock;
    for (const sor of st.cas) {
      if (sor.done || now < sor.at) continue;
      sor.done = true;
      const f = this.fielded(sor.uid);
      const b = w.ground?.bats.find((x) => x.id === sor.bn && x.alive);
      const jets = f?.fighters?.filter((x) => x.alive && x.state === 'ground').slice(0, 2) ?? [];
      if (!b || !jets.length) continue;
      const rng = new Rng(this.c.s.seed * 31 + Math.round(now));
      const sams = w.enemyAd.sites.filter((a) => a.site.alive && hdist(a.site.pos, b.pos) < ENEMY_AD.samRangeM).length;
      const fighters = w.entities.filter((e) => e.alive && e.kind === 'redfighter').length;
      const pLoss = 1 - Math.pow(1 - CAS.samLoss, sams) * Math.pow(1 - CAS.fighterLoss, Math.min(4, fighters));
      let left = 0;
      for (const j of jets) {
        if (rng.chance(pLoss)) {
          j.alive = false;
          w.setFate(j, 'missile', sams ? 'enemy SAM' : 'enemy fighter');
          w.log(`${j.name} shot down on the CAS sortie over ${b.name}${sams ? ` (${sams} enemy SAM site${sams > 1 ? 's' : ''} covering it)` : ''}`, 'damage');
        } else left++;
      }
      if (!left) continue;
      const hit = left * rng.range(...CAS.hitPerJet);
      b.strength -= hit;
      for (let k = 0; k < 4 * left; k++) w.effect({ x: b.pos.x + rng.gauss() * 250, y: b.pos.y + rng.gauss() * 250, z: b.pos.z }, 'ground');
      const line = `Close air support hit ${b.name}: −${Math.round(hit)}%, down to ${Math.round(b.strength)}%.`;
      w.log(line, 'kill');
      st.day.front.push(line);
    }
    st.cas = st.cas.filter((x) => now < x.back);
  }

  /**
   * Our rocket artillery: every so often each battery shells the enemy battalion in reach that matters most (one
   * fighting ours, then one forming up, then the nearest). Its launches give it away: the enemy's own rocket
   * artillery may answer with counter-battery fire.
   */
  private artyStep(): void {
    const g = this.w.ground;
    if (!g) return;
    const w = this.w;
    const st = this.st;
    const now = this.clock;
    const red = g.bats.filter((b) => b.side === 'red' && b.alive);
    for (const a of g.bats) {
      if (a.side !== 'blue' || a.kind !== 'arty' || !a.alive || a.broken || a.foe) continue;
      const ready = (st.artyReady ??= {})[a.id] ?? 0;
      if (now < ready) continue;
      const inReach = red.filter((r) => hdist(r.pos, a.pos) <= BLUE_ARTY.rangeM);
      const tgt = inReach.find((r) => r.foe) ?? inReach.find((r) => r.formUntil !== undefined) ?? inReach.sort((x, y) => hdist(x.pos, a.pos) - hdist(y.pos, a.pos))[0];
      if (!tgt) continue;
      st.artyReady[a.id] = now + BLUE_ARTY.cycleMin;
      (st.salvos ??= []).push({ bn: tgt.id, at: now + BLUE_ARTY.flightS / 60 });
      for (let k = 0; k < 3; k++) w.effect({ x: a.pos.x + w.rng.gauss() * 60, y: a.pos.y + w.rng.gauss() * 60, z: a.pos.z + 5 }, 'small');
      w.log(`${a.name} fires a rocket salvo at ${tgt.name}`, 'engage');
      // The launch gives it away: counter-battery fire from enemy rocket artillery in reach.
      if (w.rng.chance(BLUE_ARTY.counterChance) && a.site) {
        const base = basesWith(this.c.theatre, 'shell', 1, a.pos).find((x) => Math.hypot(x.x - a.pos.x, x.y - a.pos.y) <= ARTY.rangeM);
        if (base && !w.exposure.barrages.some((x) => x.unit === a.name)) {
          draw(base, 'shell', 1);
          w.exposure.barrages.push({ uid: -a.id, unit: a.name, x: a.pos.x, y: a.pos.y, base: base.id, at: w.t + w.rng.range(...ARTY.callS), left: ARTY.shells });
          w.log(`Enemy counter-battery radar has located ${a.name}: expect rockets on it in a few minutes. Move it or accept the fire.`, 'alert');
          this.onEvent?.(`${a.name} has been located by counter-battery radar`);
        }
      }
    }
    if (!st.salvos?.length) return;
    for (const sv of st.salvos) {
      if (now < sv.at) continue;
      const b = g.bats.find((x) => x.id === sv.bn && x.alive);
      if (!b) continue;
      const hit = w.rng.range(...BLUE_ARTY.hit);
      b.strength -= hit;
      for (let k = 0; k < 6; k++) w.effect({ x: b.pos.x + w.rng.gauss() * 200, y: b.pos.y + w.rng.gauss() * 200, z: b.pos.z }, 'ground');
    }
    st.salvos = st.salvos.filter((x) => now < x.at);
  }

  // ------------------------------------------------------------- the clock

  /** Bookkeeping after the world has stepped: cheap unless a tick is due. */
  update(): void {
    const w = this.w;
    if (w.t < this.nextTick || this.c.s.over) return;
    this.nextTick = w.t + WAR.tickS;
    const c = this.c;
    const st = this.st;
    const now = this.clock;
    const dMin = now - this.lastClock;
    this.lastClock = now;
    if (w.t > 0) st.begun = true;
    // The day turns over at 06:00, before anything else happens after it.
    const nextDay = DAY_START_MIN + c.s.day * 1440;
    if (now >= nextDay) {
      c.s.clock = nextDay;
      this.newDay();
      if (c.s.over) return;
    }
    c.s.clock = now;
    this.losses();
    this.deliveries();
    this.repairs(dMin);
    this.intel();
    this.judge();
    this.planner(dMin);
    this.support();
    this.moveArtillery();
    this.escortStep(WAR.tickS);
    this.answerPush();
    this.casStep();
    this.artyStep();
    this.checkOver();
    this.events();
  }

  /** The enemy's rocket artillery battalion moves with the front: it sets up a few kilometres behind its staging town. */
  private moveArtillery(): void {
    const g = this.w.ground;
    const f = this.c.s.front;
    if (!g || !f) return;
    const red = f.towns.map((t, i) => (t.ours ? -1 : i)).filter((i) => i >= 0);
    const at = red.length ? g.at(g.townS[red[0]] + 8000, 3000) : g.at(g.redDepot, 3000);
    for (const b of this.c.theatre) {
      if (b.kind !== 'arty' || b.lost || Math.hypot(b.x - at.x, b.y - at.y) < 500) continue;
      b.x = Math.round(at.x);
      b.y = Math.round(at.y);
      // A new firing position: it has to give itself away again.
      b.known = false;
      this.w.layoutSeq++;
    }
  }

  /** Raise the moments worth stopping the clock for: a fresh intel warning, a unit newly compromised. */
  private events(): void {
    const wn = this.c.s.warn;
    if (wn && wn.at !== this.warnedAt && wn.at > this.clock) {
      this.warnedAt = wn.at;
      this.onEvent?.(`intel expects an enemy operation about ${hhmm(wn.at)} from the ${SECTOR_NAMES[wn.sector]}`);
    }
    const w = this.w;
    for (const f of w.fielded) {
      const bad = w.exposure.compromised(f);
      if (bad && !this.flagged.has(f.unit.uid)) this.onEvent?.(`${w.unitName(f)} is probably compromised: move it or expect fire`);
      if (bad) this.flagged.add(f.unit.uid);
      else this.flagged.delete(f.unit.uid);
    }
  }

  /** Enemy aircraft shot down come off their bases for good; our units destroyed come off the order of battle. */
  private losses(): void {
    const w = this.w;
    const c = this.c;
    const lost = (c.s.enemyLost ??= {});
    const downed: Partial<Record<Asset, number>> = {};
    for (const [key, n] of w.redAirLost) {
      const fresh = n - (this.written.get(key) ?? 0);
      if (fresh <= 0) continue;
      this.written.set(key, n);
      const [pkg, tally] = key.split('|');
      const a = TALLY_ASSET[tally];
      if (!a) continue;
      const id = this.st.flights.find((f) => f.pkg.id === Number(pkg))?.pkg.base;
      const b = c.theatre.find((x) => x.id === id) ?? c.theatre.find((x) => avail(x, a) > 0);
      if (b) draw(b, a, fresh);
      lost[a] = (lost[a] ?? 0) + fresh;
      downed[a] = (downed[a] ?? 0) + fresh;
    }
    if (Object.keys(downed).length) this.st.day.enemy.push(`${hhmm(this.clock)} shot down: ${(Object.entries(downed) as [Asset, number][]).map(([a, n]) => assetCount(a, n)).join(', ')}.`);
    for (const f of w.fielded) {
      if (this.dead.has(f.unit.uid)) continue;
      const gone = f.fighters ? f.fighters.length > 0 && f.fighters.every((x) => !x.alive) : !f.sites[0]?.alive;
      if (!gone) continue;
      this.dead.add(f.unit.uid);
      const name = w.unitName(f);
      this.st.day.losses.push(name);
      if (!f.fighters) {
        c.s.deployment.units = c.units.filter((u) => u.uid !== f.unit.uid);
        w.log(`${name} has been destroyed and is struck off the order of battle`, 'damage');
      }
    }
    // Crews gain experience from their kills.
    for (const f of w.fielded) {
      const shooter = f.fu?.name ?? f.ciws?.name;
      if (!shooter) continue;
      const k = w.stats.killsBy[shooter] ?? 0;
      const fresh = k - (this.killsSeen.get(shooter) ?? 0);
      if (fresh <= 0) continue;
      this.killsSeen.set(shooter, k);
      const before = rankOf(f.unit.xp);
      f.unit.xp = (f.unit.xp ?? 0) + fresh;
      const after = rankOf(f.unit.xp);
      if (after > before) {
        if (f.fu) f.fu.rank = after;
        if (f.ciws) f.ciws.rank = after;
        w.log(`${shooter} promoted to ${RANKS[after].name}`, 'kill');
      }
    }
  }

  /** Units on order reach the depot by the airbase and drive to where they were placed; ghosts show the rest. */
  private deliveries(): void {
    const c = this.c;
    const w = this.w;
    const t = c.terrain;
    const ab = t.asset('Airbase');
    const incoming: World['incoming'] = [];
    for (const u of c.units) {
      if (this.fielded(u.uid)) continue;
      if (!this.fieldable(u)) {
        incoming.push({ uid: u.uid, type: u.type, x: u.x, y: u.y, eta: u.arrives!, depot: { x: ab.x, y: ab.y } });
        continue;
      }
      delete u.arrives;
      if (u.type === 'CAP' || !this.st.begun) {
        w.reinforce(u);
        continue;
      }
      // Off the transporters at the depot, then on the road to its spot.
      const to = { x: u.x, y: u.y };
      const back = t.layout.rot + 180;
      const a = (back * Math.PI) / 180;
      const d = nearestFree(t, u.type, ab.x + Math.sin(a) * WAR.depotM, ab.y + Math.cos(a) * WAR.depotM, c.units, u.uid, 300, c.zones);
      const dx = d.x - u.x;
      const dy = d.y - u.y;
      u.x = d.x;
      u.y = d.y;
      for (const l of u.launchers) {
        l.x += dx;
        l.y += dy;
      }
      const f = w.reinforce(u);
      this.onEvent?.(`${w.unitName(f)} has reached the depot`);
      if (Math.hypot(to.x - d.x, to.y - d.y) > 300 && !orderMove(w, f, to.x, to.y)) w.log(`${w.unitName(f)} has reached the depot and is driving to its position`, 'info');
      else w.log(`${w.unitName(f)} has reached the depot`, 'info');
    }
    w.incoming = incoming;
  }

  /** Repair crews work on the defended assets as paid for, and unit crews patch up their own equipment. */
  private repairs(dMin: number): void {
    if (dMin <= 0) return;
    const c = this.c;
    const w = this.w;
    const pts = (c.repairPerH * dMin) / 60;
    const reps = c.s.repairs ?? {};
    for (const [name, left] of Object.entries(reps)) {
      const s = w.site(name);
      if (!s) {
        delete reps[name];
        continue;
      }
      const x = name === 'Airbase' && s.hp < EMERGENCY.belowHp ? EMERGENCY.repairX : 1;
      const n = Math.min(left, pts * x, 100 - s.hp);
      s.hp += n;
      if (s.hp > 0) s.alive = true;
      reps[name] = left - n;
      if (reps[name] < 0.5 || s.hp >= 100) {
        delete reps[name];
        w.log(`Repairs to the ${name.toLowerCase()} are finished`, 'info');
      }
    }
    const own = (REPAIR_PER_H * dMin) / 60;
    for (const f of w.fielded) for (const s of f.sites) if (s.alive && s.hp < 100) s.hp = Math.min(100, s.hp + own);
  }

  /** What the enemy knows of us: fixes from our launches and emissions, and what its recon drones got home with. */
  private intel(): void {
    const w = this.w;
    for (const p of w.reconSeen.values()) w.exposure.addFix(w, { uid: p.uid, unit: p.name, x: p.x, y: p.y, t: w.t, how: 'recon' });
    w.reconSeen.clear();
  }

  /** The enemy's picture of our positions, as the raid planner wants it. */
  private sightings(): Sighting[] {
    const c0 = this.w.clockStart ?? 0;
    return this.w.exposure.fixes.map((fx) => ({ uid: fx.uid, x: fx.x, y: fx.y, name: fx.unit, at: c0 + fx.t / 60 }));
  }

  /** Packages long since launched: what got through teaches the enemy, and a bloody nose makes it cautious. */
  private judge(): void {
    const c = this.c;
    const s = c.s;
    const w = this.w;
    const now = this.clock;
    const due = this.st.flights.filter((f) => now - f.at >= WAR.judgeMin);
    if (!due.length) return;
    this.st.flights = this.st.flights.filter((f) => now - f.at < WAR.judgeMin);
    const clamp = (x: number): number => Math.min(4, Math.max(0.3, x));
    const learn = (m: number): number => Math.pow(m, 0.6);
    let flown = 0;
    let downAir = 0;
    for (const { pkg: p } of due) {
      const a = PKG[p.kind].asset;
      const tally = w.pkgTally.get(p.id);
      if (a && AIRCRAFT.includes(a)) {
        flown += p.size;
        downAir += Math.min(p.size, tally?.down ?? 0);
      }
      if (p.kind === 'dark' || p.kind === 'decoys' || p.kind === 'recon' || p.counter || p.push) continue;
      const hits = w.pkgHits.get(p.id) ?? 0;
      const sec = sectorOf(p.bearing);
      if (hits > 0) {
        s.enemy.kindW[p.kind] = clamp(s.enemy.kindW[p.kind] * learn(doctrineOf(s.enemy.doctrine)?.learn ?? 1.25));
        s.enemy.axisW[sec] = clamp(s.enemy.axisW[sec] * learn(1.35));
        this.st.day.lessons.push(`${PKG[p.kind].name} from the ${SECTOR_NAMES[sec]} got through (${hits} hit${hits > 1 ? 's' : ''}). Expect more of that.`);
      } else {
        s.enemy.kindW[p.kind] = clamp(s.enemy.kindW[p.kind] * learn(0.92));
        s.enemy.axisW[sec] = clamp(s.enemy.axisW[sec] * learn(0.9));
      }
    }
    if (flown >= SHAKEN.minFlown && downAir / flown >= SHAKEN.lossShare) {
      const cut = Math.min(SHAKEN.maxCut, (downAir / flown) * 0.5);
      s.shaken = { until: now + SHAKEN.hours * 60, cut };
      const line = `The enemy lost ${downAir} of ${flown} aircraft. Expect it to hold back (about ${Math.round(cut * 100)}% less) for the next ${SHAKEN.hours} hours.`;
      this.st.day.enemy.push(line);
      w.log(line, 'info');
    }
  }

  // ------------------------------------------------------------- the enemy planner

  /** Pick the size of the next operation; `head` is how much of it is already banked (the first of the war). */
  private newOp(head = 0): void {
    const st = this.st;
    const rng = new Rng(this.c.s.seed * 4111 + st.opIdx * 271);
    st.opSize = this.c.dayThreat() * rng.range(...WAR.opShare);
    st.pool = Math.max(st.pool, st.opSize * head);
    st.warned = false;
  }

  /** The kind of operation the hour calls for. */
  private opType(): PulseType {
    const m = ((this.clock % 1440) + 1440) % 1440;
    if (isNight(this.clock)) return 'night';
    return m < 9 * 60 ? 'probe' : 'strike';
  }

  /** The enemy banks strength by the minute, warns of what it is massing, and flies when it has enough. */
  private planner(dMin: number): void {
    const c = this.c;
    const st = this.st;
    if (dMin <= 0) return;
    const rate = c.dayThreat() / 1440;
    st.pool += rate * dMin * (1 - c.shakenCut(this.clock));
    if (!st.warned && st.pool >= st.opSize * WAR.warnAt) {
      st.warned = true;
      const left = Math.max(10, ((st.opSize - st.pool) / rate) * (1 - c.shakenCut(this.clock)));
      const rng = new Rng(c.s.seed * 53 + st.opIdx * 131);
      const off = rng.chance(0.25) ? rng.range(-60, 60) : rng.range(-15, 15);
      // The likeliest axis from what has worked for the enemy, and now and then simply wrong.
      let sec = sectorOf(c.layout.rot);
      c.s.enemy.axisW.forEach((x, i) => {
        if (x > c.s.enemy.axisW[sec]) sec = i;
      });
      if (rng.chance(0.2)) sec = (sec + (rng.chance(0.5) ? 1 : 7)) % 8;
      const at = Math.round((this.clock + left + off) / 10) * 10;
      c.s.warn = { at, sector: sec };
      this.w.log(`Intel: the enemy is massing for an operation. Expect it around ${hhmm(at)}, mainly from the ${SECTOR_NAMES[sec]}.`, 'raid');
    }
    if (st.pool >= st.opSize) this.launchOp();
  }

  /** Fly an operation now, from what the enemy has ready, at what it knows. */
  private launchOp(): void {
    const c = this.c;
    const s = c.s;
    const st = this.st;
    const type = this.opType();
    s.enemy.known = this.sightings();
    const wanted = planDay(s.day, s.seed + st.opIdx * 7177, s.enemy, s.nextPkg, c.layout.rot, 1, WEATHER[s.weather ?? 'clear'].noDrones, { ...PULSES[type].opts, budget: st.pool });
    s.nextPkg += wanted.length;
    const plan = assignBases(wanted, c.theatre, c.busy(this.clock));
    aimAtSightings(plan, s.enemy.known);
    // Some of it goes for our most forward town.
    const f = s.front;
    const rng = new Rng(s.seed * 53 + st.opIdx * 977);
    const front = f?.towns.filter((t) => t.ours).pop();
    if (front && s.day >= 2) for (const p of plan) if ((p.kind === 'drones' || p.kind === 'cruise' || p.kind === 'strike') && !p.aims && rng.chance(0.3)) p.target = front.name;
    st.opIdx++;
    plan.push(...this.groundSupport(rng));
    const spent = plan.reduce((t, p) => t + PKG[p.kind].cost(p.size), 0);
    // Nothing ready to fly: it waits, and the strength it banked keeps.
    if (!plan.some((p) => p.kind !== 'dark')) {
      st.pool = st.opSize * 0.6;
      st.warned = true;
      return;
    }
    st.pool = Math.max(0, st.pool - spent);
    timeOnTarget(plan, rng);
    this.fly(plan);
    if (type === 'strike') sweepCap(this.w);
    this.newOp();
  }

  /**
   * Air power over the ground war: helicopters and drones hunt our battalions (worst for those beyond our air
   * defence), and an enemy attack under way gets drones and missiles at the town it goes for.
   */
  private groundSupport(rng: Rng): PlannedPkg[] {
    const g = this.w.ground;
    const s = this.c.s;
    if (!g) return [];
    const out: PlannedPkg[] = [];
    const bearingAt = (sAt: number): number => {
      const a = g.at(sAt);
      const b = g.at(sAt + 8000);
      return (Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI;
    };
    const ours = g.bats.filter((b) => b.side === 'blue' && b.alive && b.site && !b.broken);
    // The most forward of ours is the one they go for.
    const prey = ours.sort((a, b) => b.s - a.s)[0];
    if (prey && rng.chance(0.65)) {
      const o = { x: prey.pos.x, y: prey.pos.y };
      const base = { id: 0, bearing: bearingAt(prey.s), t: 0, reported: true, origin: o } as const;
      if (s.day >= 2) out.push({ ...base, id: s.nextPkg++, kind: 'helo', size: Math.min(4, 2 + Math.floor(s.day / 4)), target: prey.name });
      out.push({ ...base, id: s.nextPkg++, kind: 'drones', size: Math.min(10, 3 + Math.floor(s.day / 2)), target: prey.name });
    }
    if (g.enemyGoal !== undefined) {
      const tn = s.front!.towns[g.enemyGoal];
      const o = { x: tn.x, y: tn.y };
      out.push({ id: s.nextPkg++, kind: 'drones', size: Math.min(12, 5 + Math.floor(s.day / 2)), bearing: bearingAt(g.townS[g.enemyGoal]), t: 0, reported: true, target: tn.name, origin: o });
      if (s.day >= 2) out.push({ id: s.nextPkg++, kind: 'cruise', size: Math.min(5, 2 + Math.floor(s.day / 3)), bearing: bearingAt(g.townS[g.enemyGoal]), t: 0, reported: true, target: tn.name });
    }
    return out.length ? assignBases(out, this.c.theatre, this.c.busy(this.clock)) : [];
  }

  /** Put packages in the air, `p.t` seconds from now: their aircraft are busy until turned round. */
  private fly(plan: PlannedPkg[]): void {
    const c = this.c;
    const w = this.w;
    const now = this.clock;
    const raids = toRaids(plan);
    raids.forEach((r) => (r.t += w.t));
    w.scenario.raids.push(...raids);
    w.scenario.done = false;
    for (const p of plan) {
      this.st.flights.push({ pkg: p, at: now });
      const a = PKG[p.kind].asset;
      if (a && p.base && AIRCRAFT.includes(a)) (c.s.sorties ??= []).push({ key: `${p.base}:${a}`, n: p.size, until: now + p.t / 60 + 90 + (TURNAROUND_H[a] ?? 6) * 60 });
    }
    w.redSupport.coordinate(w);
  }

  // ------------------------------------------------------------- the ground war

  /** A town is ours: income, ground to deploy on, and whatever the enemy had in it is overrun. */
  private takeTown(i: number, hp: number): void {
    const c = this.c;
    const s = c.s;
    const f = s.front!;
    const w = this.w;
    const tn = f.towns[i];
    tn.ours = true;
    tn.hp = TAKEN_HP;
    // Taken: the objective becomes holding it.
    const g = this.w.ground;
    if (g?.objective?.town === i) g.objective = { kind: 'hold', town: i };
    tn.heldSince = this.clock;
    w.addTown(tn);
    const line = `Our troops took ${tn.name} (${hp}% strength): +$${tn.incomeM}M a day, and units can now deploy round it.`;
    this.st.day.front.push(line);
    w.log(line, 'kill');
    const lost = (s.enemyLost ??= {});
    const before = c.theatre.map((b) => ({ ...b.stock }));
    const lines = overrun(c.theatre, tn.name, f.towns.find((x) => !x.ours));
    c.theatre.forEach((b, k) => {
      for (const [a, n] of Object.entries(before[k]) as [Asset, number][]) {
        const gone = Math.floor(n - (b.stock[a] ?? 0));
        if (gone > 0) lost[a] = (lost[a] ?? 0) + gone;
      }
    });
    // The enemy's SAM site there goes with it.
    for (const ad of w.enemyAd.sites) if (ad.base.town === tn.name && ad.site.alive) ad.site.alive = false;
    this.frontMoved(lines);
  }

  /** The enemy has taken town i: it and every town of ours beyond it (cut off) are lost. */
  private townFalls(i: number): void {
    const tn = this.c.s.front!.towns[i];
    const g = this.w.ground;
    // Holding it is no longer an objective: battalions told to advance on it stop where they are.
    if (g?.objective && g.objective.town <= i) {
      g.objective = undefined;
      for (const b of g.bats) if (b.side === 'blue' && b.order === 'advance') g.order(b, 'hold');
    }
    this.st.day.front.push(`Enemy battalions took ${tn.name}.`);
    this.onEvent?.(`the enemy has taken ${tn.name}`);
    this.loseTowns(i);
  }

  /** Towns from `i` up the road fall to the enemy. */
  private loseTowns(i: number): void {
    const f = this.c.s.front!;
    const w = this.w;
    for (const tn of f.towns.slice(i)) {
      if (!tn.ours) continue;
      tn.ours = false;
      tn.hp = 100;
      delete tn.heldSince;
      const site = w.site(tn.name);
      if (site) w.removeSite(site);
      const line = `${tn.name} has fallen to the enemy. We lose its income and the ground round it.`;
      this.st.day.front.push(line);
      w.log(line, 'damage');
    }
    this.frontMoved([]);
  }

  /** The ground we hold changed: new deploy zones, units outside them pull back, enemy launch teams move away. */
  private frontMoved(enemyLines: string[]): void {
    const c = this.c;
    const w = this.w;
    const zones = c.zones;
    w.zones = zones;
    for (const fl of w.fielded) {
      const u = fl.unit;
      if (u.type === 'CAP' || this.escortOf(u.uid) !== undefined || inZones(zones, u.x, u.y) || !fl.sites[0]?.alive) continue;
      const z = zones.reduce((a, b) => (Math.hypot(u.x - b.x, u.y - b.y) - b.r < Math.hypot(u.x - a.x, u.y - a.y) - a.r ? b : a));
      const d = Math.hypot(u.x - z.x, u.y - z.y) || 1;
      const p = nearestFree(c.terrain, u.type, z.x + ((u.x - z.x) * z.r * 0.8) / d, z.y + ((u.y - z.y) * z.r * 0.8) / d, c.units, u.uid, 300, zones);
      if (!orderMove(w, fl, p.x, p.y)) this.st.day.front.push(`${w.unitName(fl)} is pulling back inside our lines.`);
    }
    enemyLines.push(...fallBack(c.terrain, c.theatre, zones));
    for (const l of enemyLines) w.log(l, 'info');
    this.st.day.enemy.push(...enemyLines);
    w.layoutSeq++;
  }

  // ------------------------------------------------------------- support aircraft, the day, the end

  /** The enemy keeps an AWACS (and a tanker) up from day 4, and puts up a new one some hours after we kill it. */
  private support(): void {
    const c = this.c;
    const w = this.w;
    const rs = w.redSupport;
    if (rs.awacsKilledAt !== null) {
      c.s.awacsBackAt = (w.clockStart ?? 0) + rs.awacsKilledAt / 60 + RED_SUPPORT.replaceH * 60;
      rs.awacsKilledAt = null;
      rs.denied = true;
    }
    if (rs.denied && this.clock >= (c.s.awacsBackAt ?? 0)) rs.denied = false;
    if (!rs.denied) rs.launch(w, c.s.day);
  }

  /** The old raid-shaped report for the day just ended, built from what the world counted since 06:00. */
  private dayReport(income: number): DayReport {
    const c = this.c;
    const w = this.w;
    const st = this.st;
    const d0 = this.dayStats;
    const s = w.stats;
    const killsBy: Record<string, number> = {};
    for (const [k, n] of Object.entries(s.killsBy)) if (n - (d0.killsBy[k] ?? 0) > 0) killsBy[k] = n - (d0.killsBy[k] ?? 0);
    const missiles = (x: Stats): number => x.fired.LR + x.fired.MR + x.fired.SH + x.fired.AAM;
    return {
      day: c.s.day,
      at: c.clock - 1440,
      end: c.clock,
      kills: s.kills - d0.kills,
      killsBy,
      leakers: s.leakers - d0.leakers,
      missilesFired: missiles(s) - missiles(d0),
      missileCostM: Math.round((s.costM - d0.costM) * 10) / 10,
      civilian: s.civilian - d0.civilian,
      fratricide: s.fratricide - d0.fratricide,
      income,
      damage: c.s.deployment.assets.map((a) => ({ name: a.name, lost: Math.max(0, Math.round((st.day.hp[a.name] ?? 100) - a.hp)), hp: a.hp })),
      losses: [...st.day.losses],
      front: [...st.day.front],
      lessons: [...st.day.lessons],
      enemy: [...st.day.enemy],
    };
  }

  /** A report of the day so far (the final debrief when the war ends mid-day). */
  emptyReport(): DayReport {
    this.sync();
    return this.dayReport(0);
  }

  /** Match the defended assets on the map to their records (repairs bought before the war began are instant). */
  applyAssets(): void {
    if (!this.st.begun) this.rebuild();
  }

  private snapshotHp(): void {
    this.st.day.hp = Object.fromEntries(DEFENDED_ASSETS.map((a) => [a.name, this.w.site(a.name)?.hp ?? 0]));
  }

  /** 06:00: the day's income, the enemy's reinforcements, the weather, and the new day's plans on both sides. */
  private newDay(): void {
    const c = this.c;
    const s = c.s;
    const w = this.w;
    this.sync();
    const income = c.income();
    const report = this.dayReport(income);
    s.history.push(report);
    this.dayStats = JSON.parse(JSON.stringify(w.stats)) as Stats;
    this.st.day = blankDay();
    if (s.day >= CAMPAIGN_DAYS) {
      this.ceasefire();
      this.onDay?.(report);
      return;
    }
    s.day++;
    s.money += income;
    s.incomePenalty = 0;
    const airbase = s.deployment.assets.find((a) => a.name === 'Airbase')!;
    if (airbase.hp <= 0) {
      s.downMornings = (s.downMornings ?? 0) + 1;
      if (s.downMornings >= 2) s.over = { won: false, reason: 'The airbase was still out of action on a second morning. The defence has failed.' };
      else if (s.front && !s.front.towns.some((t) => t.ours)) s.over = { won: false, reason: 'Morning found the airbase out of action and every town fallen. The defence has failed.' };
    } else s.downMornings = 0;
    // A cratered airfield gets no reinforcement while it is down.
    const held = c.theatre.filter((b) => c.runwayDown(b.id)).map((b) => [b, { ...b.stock }] as const);
    reinforce(c.theatre, c.diff.threat);
    for (const [b, st] of held) b.stock = st;
    s.armourStock = Math.min(ARMOUR_BDE.max, c.armourStock + ARMOUR_BDE.perNight);
    for (const u of c.units.filter((x) => x.loan)) this.remove(u.uid);
    s.deployment.units = c.units.filter((u) => !u.loan);
    c.startDay();
    s.plan = [];
    s.objectives = [];
    w.setWeather(s.weather ?? 'clear');
    w.qraUsed = false;
    w.exposure.level = s.day;
    // No scripted armour push: the enemy's attacks are its battalions. A battalion a day reaches each side's depot.
    s.enemyPush = null;
    this.st.pushAt = undefined;
    const g = w.ground;
    if (g) {
      const kind = s.day % 2 ? 'armour' : 'mech';
      const b = g.add('blue', kind, g.blueDepot);
      const p = g.place(b);
      b.site = w.addBattalionSite(b.name, p.x, p.y, 100);
      b.vuln = b.site.vuln;
      g.add('red', s.day % 2 ? 'mech' : 'armour', g.redDepot);
      w.log(`${b.name} has reached our depot by the airbase. Intel reports a fresh enemy battalion at its depot too.`, 'info');
    }
    if (s.autoRestock) {
      report.restockM = c.restock();
      this.applyAll();
    }
    const grant = s.grantDay === s.day ? 0 : c.emergencyGrant();
    if (grant) {
      s.money += grant;
      s.grantDay = s.day;
      report.grantM = grant;
    }
    w.log(`Day ${s.day}, 06:00. Yesterday: ${report.kills} kills, ${report.leakers} leakers, ${report.missilesFired} missiles fired. Income +$${income}M${report.restockM ? `, restock −$${report.restockM}M` : ''}${grant ? `, emergency grant +$${grant}M` : ''}. ${WEATHER[s.weather ?? 'clear'].desc}`, 'raid');
    this.snapshotHp();
    this.onDay?.(report);
    if (s.over) this.onOver?.();
  }

  /** The ceasefire after the last day: graded by the ground we hold. */
  private ceasefire(): void {
    const s = this.c.s;
    const towns = s.front?.towns ?? [];
    const held = towns.filter((t) => t.ours).length;
    const airbase = s.deployment.assets.find((a) => a.name === 'Airbase')!;
    if (airbase.hp <= 0) {
      if (held > 0 || !s.front) {
        s.grade = 'Bronze';
        s.over = { won: false, draw: true, reason: `Stalemate: ceasefire after ${CAMPAIGN_DAYS} days with the airbase out of action${s.front ? `, holding ${held} of the ${towns.length} towns on the road` : ''}. Bronze grade.` };
      } else s.over = { won: false, reason: 'The ceasefire came with the airbase out of action and every town fallen. The defence has failed.' };
    } else {
      s.grade = towns.length && held >= towns.length - 1 ? 'Gold' : held >= 2 || !towns.length ? 'Silver' : 'Bronze';
      const dr = s.grade === 'Bronze';
      s.over = { won: !dr, draw: dr, reason: `${dr ? 'Stalemate: c' : 'C'}easefire after ${CAMPAIGN_DAYS} days: the airbase held${towns.length ? `, and we hold ${held} of the ${towns.length} towns on the road` : ''}. ${s.grade} grade.` };
    }
    this.onOver?.();
  }

  private checkOver(): void {
    const s = this.c.s;
    if (s.over) return;
    s.civilLosses = this.w.stats.civilian + (s.civilBefore ?? 0);
    if (s.front?.towns.some((t) => t.airfield && t.ours)) s.over = { won: true, reason: `We took the enemy's forward airfield on day ${s.day}. The front has collapsed: the campaign is won.` };
    else if (s.civilLosses >= CIVIL_LIMIT) s.over = { won: false, reason: `${s.civilLosses} civil airliners shot down. You have been relieved of command.` };
    if (s.over) {
      this.sync();
      this.onOver?.();
    }
  }

  // ------------------------------------------------------------- saving

  /** Write the world back into the campaign state: what the save holds, and what the plan overlay shows. */
  sync(): void {
    const c = this.c;
    const s = c.s;
    const w = this.w;
    s.clock = Math.max(s.clock ?? 0, this.clock);
    s.deployment.assets = DEFENDED_ASSETS.map((a) => ({ name: a.name, hp: Math.round(w.site(a.name)?.hp ?? 0) }));
    for (const f of w.fielded) {
      const u = c.unit(f.unit.uid);
      if (!u) continue;
      const main = f.sites[0];
      if (f.fu) {
        u.launchers = f.fu.launchers
          .map((l, i) => ({ ...u.launchers[i], x: Math.round(l.site.pos.x), y: Math.round(l.site.pos.y), rounds: l.rounds, max: l.max, hp: l.site !== main && l.site.hp < 99.5 ? Math.round(l.site.hp) : undefined, alive: l.site.alive }))
          .filter((l) => l.alive)
          .map(({ alive: _a, ...l }) => l);
        u.spares = f.fu.spares;
        u.holdFire = f.fu.hold;
      }
      if (f.fighters) u.aircraft = f.fighters.filter((x) => x.alive).length;
      if (f.ciws) u.holdFire = !f.ciws.auto;
      if (main && main.alive && main.hp < 99.5) u.hp = Math.round(main.hp);
      else delete u.hp;
      // A unit on the road is saved where it is going.
      if (f.move && f.unit.type !== 'CAP') {
        u.x = Math.round(f.move.to.x);
        u.y = Math.round(f.move.to.y);
      }
      if (f.heat && f.heat >= 2) u.heat = Math.round(f.heat);
      else delete u.heat;
      if (f.radar) {
        u.armWatch = f.radar.armWatch;
        u.emcon = f.radar.emcon === 'on' ? undefined : f.radar.emcon;
        u.silent = f.radar.emcon === 'on' && !f.radar.emitting && !f.radar.armSilent ? true : undefined;
      }
      const em = w.gnss.find((j) => j.site === main) ?? w.decoys.find((d) => d.site === main) ?? w.ewj.find((j) => j.site === main);
      if (em) u.on = em.on;
    }
    if (s.front) for (const tn of s.front.towns) if (tn.ours) tn.hp = Math.round(w.site(tn.name)?.hp ?? tn.hp);
    if (w.ground) this.st.ground = w.ground.save();
    s.enemy.known = this.sightings();
  }

  /**
   * A world stepped through quiet time: when nothing of the enemy's is near, the clock can jump instead of
   * stepping, as long as nothing is due before then. Returns the seconds it is safe to skip.
   */
  skippable(): number {
    if (!this.quiet() || this.w.enemyArmour || this.w.column || this.w.fielded.some((f) => f.move)) return 0;
    const w = this.w;
    const st = this.st;
    const c = this.c;
    const rate = c.dayThreat() / 1440 / 60;
    const toOp = rate > 0 ? (st.opSize * (st.warned ? 1 : WAR.warnAt) - st.pool) / rate : Infinity;
    const nextDay = (DAY_START_MIN + c.s.day * 1440 - this.clock) * 60;
    const due = [toOp, nextDay, ...c.units.filter((u) => u.arrives !== undefined).map((u) => (u.arrives! - this.clock) * 60), st.pushAt !== undefined ? (st.pushAt - this.clock) * 60 : Infinity];
    const raids = w.scenario.raids.filter((r) => !r.launched).map((r) => r.t - w.t);
    // A ground fight or an advance under way: short jumps, so orders, CAS and the guns keep up with it.
    const g = w.ground;
    const busy = g && (g.objective?.kind === 'push' || g.capture.some((x) => x > 0 && x < 1) || g.bats.some((b) => b.alive && (b.foe || (b.side === 'blue' && b.order === 'advance' && b.kind !== 'arty'))));
    return Math.max(0, Math.min(...due, ...raids, busy ? 300 : Infinity) - 1);
  }

  /** Jump the clock `s` seconds through quiet time without stepping (headless runs): exposure drains as it would. */
  jump(s: number): void {
    const w = this.w;
    // The ground war goes on through quiet time, in coarse steps.
    for (let left = s; left > 0; left -= 30) {
      const dt = Math.min(30, left);
      w.t += dt;
      w.ground?.step(w, dt);
      this.escortStep(dt);
      if (left > 30) this.update();
    }
    for (const f of w.fielded) if (f.heat && !f.radar?.isEmitting()) f.heat = Math.max(0, f.heat - 0.5 * s);
    this.update();
  }
}

/** Rough flight time from launch to our ground per package kind (s): spawn distance over cruise speed. */
const TRAVEL_S: Partial<Record<PkgKind, number>> = { drones: 1000, decoys: 1000, cruise: 540, strike: 600, helo: 570, sead: 640, soj: 500, bomber: 890, tbm: 300 };

/**
 * Time on target: an operation's packages launch so they arrive together, in at most two waves, the way a real
 * combined strike is timed: slow drones go first so they reach us with the missiles and jets, not an hour ahead.
 * Suppression (decoys, SEAD, the jammer) always leads; about a third of the rest follows in a second wave.
 */
function timeOnTarget(plan: PlannedPkg[], rng: Rng): void {
  const timed = plan.filter((p) => TRAVEL_S[p.kind] !== undefined);
  if (!timed.length) return;
  const tot = Math.max(...timed.map((p) => TRAVEL_S[p.kind]!)) + 60;
  for (const p of timed) {
    const lead = p.kind === 'decoys' || p.kind === 'sead' || p.kind === 'soj';
    const wave = !lead && rng.chance(0.35) ? WAR.waveGapS : 0;
    p.t = tot - TRAVEL_S[p.kind]! + wave + rng.range(0, WAR.totSpreadS);
  }
}
