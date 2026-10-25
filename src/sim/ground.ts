import { V3, v3 } from './math';
import type { Site } from './sites';
import type { World } from './world';

/**
 * The ground war: battalions of both sides moving along the road that runs from our airbase through the towns
 * to the enemy's rear. Where two meet they fight continuously, wearing each other down by simple attrition;
 * a town changes hands once one side has held it uncontested for half an hour. Our battalions are defended
 * sites, so the enemy's helicopters, drones and jets hunt them, and air defence over them is what keeps them
 * alive. Game-level numbers throughout, not a wargame.
 */
export const GROUND = {
  /** Road speed (m/s): a battalion on the move covers about 30 km an hour. */
  speed: 8,
  /** Battalions closer than this along the road are in contact and fighting (m). */
  contactM: 3500,
  /** Neither side drives through the other: it stops this far short (m). */
  standoffM: 1500,
  /** Within this of a town a battalion holds or contests it (m). */
  townR: 3000,
  /** A town falls after being held this long uncontested (s). */
  captureS: 1800,
  /** Strength lost per second in contact against a full-strength enemy battalion (percent). An even fight breaks one side in about 45 minutes. */
  fire: 100 / 2700,
  /** Damage taken is cut to this share for a battalion holding a town of its own side, holding in the open, or pulling back. */
  inTown: 0.35,
  holding: 0.75,
  withdrawing: 0.7,
  /** Armour hits harder than mechanised infantry. */
  armourFire: 1.25,
  /** Below this strength a battalion breaks and falls back to its depot. */
  breakAt: 20,
  /** Out of contact, at its depot or in a town of its side, a battalion refits this much per hour (percent). */
  refitPerH: 6,
  /** An enemy attack forms up this long at its staging town before it moves (s): the window to strike it. */
  formUpS: 1200,
  /** The enemy attacks once it has this many battalions above ATTACK_MIN at its staging town. */
  attackWith: 2,
  attackMin: 60,
  /** ...and calls its attack off when the attackers' average strength falls below this. */
  attackBreak: 35,
  /** After an attack ends the enemy waits at least this long before the next (s), and never attacks in the first hours. */
  attackGapS: 6 * 3600,
  firstAttackS: 5 * 3600,
  /** The enemy rethinks this often (s). */
  thinkS: 60,
  /** Fighting is shown: a burst of fire or a hit this often per contact (s). */
  fxS: 3,
  /** Our deep strike on a battalion: its cost, chance and what a hit takes off. */
  strike: { costM: 35, chance: 0.6, hit: 40 },
};

export type Side = 'blue' | 'red';
export type Order = 'advance' | 'hold' | 'withdraw';
export type BnKind = 'armour' | 'mech';

/** What the save keeps of a battalion. */
export interface BattalionState {
  id: number;
  side: Side;
  name: string;
  kind: BnKind;
  /** Distance along the road from our airbase (m). */
  s: number;
  strength: number;
  order: Order;
  /** Where along the road it is going (m), when advancing or withdrawing. */
  goal?: number;
  /** Campaign time (s) it finishes forming up for an attack (enemy). */
  formUntil?: number;
}

export interface GroundState {
  bats: BattalionState[];
  /** Capture progress per town, 0..1, by the side that does not hold it. */
  capture: number[];
  nextId: number;
  /** The player's objective: push for a town, or hold one. */
  objective?: { kind: 'push' | 'hold'; town: number };
  /** The enemy's attack under way: the town it goes for, and the battalions making it. */
  enemyGoal?: number;
  attackers?: number[];
  /** Campaign time (s) before which the enemy will not start another attack. */
  nextAttack?: number;
}

export class Battalion implements BattalionState {
  id: number;
  side: Side;
  name: string;
  kind: BnKind;
  s: number;
  order: Order;
  goal?: number;
  formUntil?: number;
  /** Our battalions are sites: whatever hits the site hits the battalion. */
  site: Site | null = null;
  private str: number;
  pos: V3 = v3();
  /** In contact this step, and with whom. */
  foe: Battalion | null = null;
  lastFx = 0;

  constructor(st: BattalionState) {
    this.id = st.id;
    this.side = st.side;
    this.name = st.name;
    this.kind = st.kind;
    this.s = st.s;
    this.str = st.strength;
    this.order = st.order;
    this.goal = st.goal;
    this.formUntil = st.formUntil;
  }

  get strength(): number {
    return this.site ? this.site.hp : this.str;
  }

  set strength(v: number) {
    const x = Math.max(0, Math.min(100, v));
    if (this.site) {
      this.site.hp = x;
      if (x <= 0) this.site.alive = false;
    } else this.str = x;
  }

  get alive(): boolean {
    return this.strength > 0 && (!this.site || this.site.alive);
  }

  get broken(): boolean {
    return this.strength < GROUND.breakAt;
  }

  /** Which way is forward for it along the road: our side advances up the road, the enemy down it. */
  get dir(): number {
    return this.side === 'blue' ? 1 : -1;
  }

  save(): BattalionState {
    return { id: this.id, side: this.side, name: this.name, kind: this.kind, s: Math.round(this.s), strength: Math.round(this.strength * 10) / 10, order: this.order, goal: this.goal, formUntil: this.formUntil };
  }
}

/** What the ground war needs to know of the campaign around it. */
export interface GroundHooks {
  /** Who holds town i now. */
  owner(i: number): Side;
  /** One side has taken town i. */
  captured(i: number, by: Side): void;
  /** Something the player should know about (the game may stop the clock for it). */
  event(msg: string): void;
}

/** Campaign time in seconds: survives the world being rebuilt from a save, unlike sim time. */
export const now = (w: World): number => (w.clockStart ?? 0) * 60 + w.t;

const ORD = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th', '11th', '12th'];

export class Ground {
  /** The road: our airbase, the towns in order, and on into the enemy's rear. */
  readonly road: { x: number; y: number }[];
  private readonly cum: number[];
  /** Where each town stands along the road (m). */
  readonly townS: number[];
  readonly townNames: string[];
  bats: Battalion[] = [];
  capture: number[];
  nextId: number;
  objective?: GroundState['objective'];
  enemyGoal?: number;
  attackers: number[];
  nextAttack: number;
  hooks: GroundHooks;
  private nextThink = 0;

  constructor(towns: { name: string; x: number; y: number }[], st: GroundState, hooks: GroundHooks) {
    const pts = [{ x: 0, y: 0 }, ...towns.map((t) => ({ x: t.x, y: t.y }))];
    const a = pts[pts.length - 2] ?? { x: 0, y: 0 };
    const b = pts[pts.length - 1];
    const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    pts.push({ x: b.x + ((b.x - a.x) / d) * 20000, y: b.y + ((b.y - a.y) / d) * 20000 });
    this.road = pts;
    this.cum = [0];
    for (let i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    this.townS = towns.map((_, i) => this.cum[i + 1]);
    this.townNames = towns.map((t) => t.name);
    this.capture = towns.map((_, i) => st.capture[i] ?? 0);
    this.nextId = st.nextId;
    this.objective = st.objective;
    this.enemyGoal = st.enemyGoal;
    this.attackers = st.attackers ?? [];
    this.nextAttack = st.nextAttack ?? -1;
    this.hooks = hooks;
    this.bats = st.bats.map((x) => new Battalion(x));
    for (const b of this.bats) this.place(b);
  }

  /** Where a battalion stands: spread out, so battalions on the same stretch of road are apart and one strike cannot catch them all. */
  place(b: Battalion): { x: number; y: number } {
    const p = this.at(b.s - b.dir * (b.id % 4) * 450, ((b.id % 3) - 1) * 700);
    b.pos = v3(p.x, p.y, b.pos.z);
    return p;
  }

  /** Length of the road (m): the enemy's depot is at the far end. */
  get length(): number {
    return this.cum[this.cum.length - 1];
  }

  /** Where our battalions muster and new ones arrive: just up the road from the airbase. */
  get blueDepot(): number {
    return 3000;
  }

  get redDepot(): number {
    return this.length - 2000;
  }

  /** A point on the road, with a sideways offset so battalions on the same spot do not sit on each other. */
  at(s: number, side = 0): { x: number; y: number } {
    const c = this.cum;
    const x = Math.max(0, Math.min(this.length, s));
    let i = 1;
    while (i < c.length - 1 && c[i] < x) i++;
    const a = this.road[i - 1];
    const b = this.road[i];
    const seg = c[i] - c[i - 1] || 1;
    const k = (x - c[i - 1]) / seg;
    const nx = -(b.y - a.y) / seg;
    const ny = (b.x - a.x) / seg;
    return { x: a.x + (b.x - a.x) * k + nx * side, y: a.y + (b.y - a.y) * k + ny * side };
  }

  /** Nearest point along the road to (x, y), as road distance. */
  project(x: number, y: number): number {
    let best = 0;
    let bd = Infinity;
    for (let i = 1; i < this.road.length; i++) {
      const a = this.road[i - 1];
      const b = this.road[i];
      const L = this.cum[i] - this.cum[i - 1] || 1;
      const k = Math.max(0, Math.min(1, ((x - a.x) * (b.x - a.x) + (y - a.y) * (b.y - a.y)) / (L * L)));
      const d = Math.hypot(a.x + (b.x - a.x) * k - x, a.y + (b.y - a.y) * k - y);
      if (d < bd) {
        bd = d;
        best = this.cum[i - 1] + k * L;
      }
    }
    return best;
  }

  /** The town nearest road distance s, if a battalion there would be in it. */
  townAt(s: number): number {
    return this.townS.findIndex((t) => Math.abs(t - s) < GROUND.townR);
  }

  /** A new battalion of `side` at road distance s. */
  add(side: Side, kind: BnKind, s: number, order: Order = 'hold', goal?: number): Battalion {
    const name = side === 'blue' ? `${ORD[this.nextId % ORD.length]} ${kind === 'armour' ? 'Armoured' : 'Mech'} Bn` : `Enemy ${kind === 'armour' ? 'tank' : 'motor rifle'} bn ${this.nextId}`;
    const b = new Battalion({ id: this.nextId++, side, name, kind, s, strength: 100, order, goal });
    this.bats.push(b);
    this.place(b);
    return b;
  }

  /** Our front line: the furthest any of our battalions or towns reaches up the road (m). */
  frontS(side: Side): number {
    const own = this.townS.filter((_, i) => this.hooks.owner(i) === side);
    const bs = this.bats.filter((b) => b.side === side && b.alive).map((b) => b.s);
    const all = [...own, ...bs];
    if (side === 'blue') return all.length ? Math.max(...all) : 0;
    return all.length ? Math.min(...all) : this.length;
  }

  save(): GroundState {
    return { bats: this.bats.filter((b) => b.alive).map((b) => b.save()), capture: this.capture.map((x) => Math.round(x * 1000) / 1000), nextId: this.nextId, objective: this.objective, enemyGoal: this.enemyGoal, attackers: this.attackers, nextAttack: this.nextAttack };
  }

  step(w: World, dt: number): void {
    const live = this.bats.filter((b) => b.alive);
    // Contact: each battalion fights the nearest enemy within reach along the road.
    for (const b of live) {
      b.foe = null;
      let bd = GROUND.contactM;
      for (const o of live) {
        if (o.side === b.side) continue;
        const d = Math.abs(o.s - b.s);
        if (d < bd) {
          bd = d;
          b.foe = o;
        }
      }
    }
    for (const b of live) {
      if (!b.foe) continue;
      const f = b.foe;
      const t = this.townAt(f.s);
      let cut = 1;
      if (t >= 0 && this.hooks.owner(t) === f.side && f.order !== 'advance') cut = GROUND.inTown;
      else if (f.order === 'hold') cut = GROUND.holding;
      else if (f.order === 'withdraw') cut = GROUND.withdrawing;
      const hit = GROUND.fire * dt * (b.strength / 100) * (b.kind === 'armour' ? GROUND.armourFire : 1) * cut;
      f.strength -= hit;
      if (w.t - b.lastFx > GROUND.fxS) {
        b.lastFx = w.t + w.rng.range(0, 2);
        const p = this.at(f.s + w.rng.gauss() * 300, w.rng.gauss() * 400);
        w.effect(v3(p.x, p.y, w.terrain.groundAt(p.x, p.y)), 'ground');
      }
    }
    for (const b of live) {
      if (b.strength <= 0) {
        if (b.site) b.site.alive = false;
        w.log(`${b.name} has been destroyed`, b.side === 'blue' ? 'damage' : 'kill');
        if (b.side === 'blue') this.hooks.event(`${b.name} has been destroyed`);
        continue;
      }
      // Broken: it falls back to its depot to refit.
      if (b.broken && b.order !== 'withdraw') {
        b.order = 'withdraw';
        b.goal = b.side === 'blue' ? this.blueDepot : this.redDepot;
        b.formUntil = undefined;
        w.log(`${b.name} is broken (${Math.round(b.strength)}%) and falling back`, b.side === 'blue' ? 'alert' : 'kill');
        if (b.side === 'blue') this.hooks.event(`${b.name} is broken and falling back`);
      }
      this.move(b, live, dt, w);
      // Refit out of contact, at the depot or in a town of its own.
      const t = this.townAt(b.s);
      const home = Math.abs(b.s - (b.side === 'blue' ? this.blueDepot : this.redDepot)) < 3000 || (t >= 0 && this.hooks.owner(t) === b.side);
      if (!b.foe && home && b.strength < 100) b.strength = Math.min(100, b.strength + (GROUND.refitPerH / 3600) * dt);
      if (b.order === 'withdraw' && b.goal !== undefined && Math.abs(b.s - b.goal) < 200 && b.strength >= 60) b.order = 'hold';
      const p = this.place(b);
      b.pos.z = w.terrain.groundAt(p.x, p.y);
      if (b.site) {
        b.site.pos.x = p.x;
        b.site.pos.y = p.y;
        b.site.pos.z = b.pos.z;
      }
      // Drones sent at one of ours are flown onto it: their operators see where it is now.
      if (b.site) for (const e of w.entities) if (e.alive && e.kind === 'drone' && e.targetName === b.name && e.target) e.target = v3(p.x, p.y, b.pos.z);
    }
    this.captureStep(w, dt);
    if (w.t >= this.nextThink) {
      this.nextThink = w.t + GROUND.thinkS;
      this.enemyThinks(w);
    }
    if (live.some((b) => b.site && b.site.hp <= 0)) w.layoutSeq++;
  }

  /** Along the road towards its goal, never through an enemy battalion and never past the objective. */
  private move(b: Battalion, live: Battalion[], dt: number, w: World): void {
    if (b.formUntil !== undefined) {
      if (now(w) < b.formUntil) return;
      b.formUntil = undefined;
    }
    if (b.order === 'hold' || b.goal === undefined) return;
    const d = b.goal - b.s;
    if (Math.abs(d) < 50) {
      if (b.order === 'advance') b.order = 'hold';
      return;
    }
    let step = Math.sign(d) * Math.min(Math.abs(d), GROUND.speed * dt);
    // In contact it can only pull back; it cannot drive through the enemy.
    for (const o of live) {
      if (o.side === b.side) continue;
      const gap = (o.s - b.s) * Math.sign(step);
      if (gap >= 0 && gap - Math.abs(step) < GROUND.standoffM) step = Math.sign(step) * Math.max(0, gap - GROUND.standoffM);
    }
    b.s += step;
  }

  /** Towns held uncontested by the other side for long enough change hands; contest pauses the bar. */
  private captureStep(w: World, dt: number): void {
    for (let i = 0; i < this.townS.length; i++) {
      const holder = this.hooks.owner(i);
      const near = this.bats.filter((b) => b.alive && Math.abs(b.s - this.townS[i]) < GROUND.townR);
      const att = near.filter((b) => b.side !== holder && !b.broken);
      const def = near.filter((b) => b.side === holder);
      if (att.length && !def.length) {
        if (this.capture[i] === 0) {
          const by = att[0].side;
          w.log(`${by === 'blue' ? 'Our troops are' : 'The enemy is'} taking ${this.townNames[i]}: it falls in ${Math.round(GROUND.captureS / 60)} minutes unless contested`, by === 'blue' ? 'info' : 'alert');
          if (by === 'red') this.hooks.event(`the enemy is taking ${this.townNames[i]}`);
        }
        this.capture[i] = Math.min(1, this.capture[i] + dt / GROUND.captureS);
        if (this.capture[i] >= 1) {
          this.capture[i] = 0;
          this.hooks.captured(i, att[0].side);
        }
      } else if (!att.length && this.capture[i] > 0) this.capture[i] = Math.max(0, this.capture[i] - dt / (GROUND.captureS * 2));
    }
  }

  /**
   * The enemy's ground plan: garrison its front town, bring new battalions up from the depot, and when it has
   * enough at the staging town, form up and attack our front town. An attack worn down too far is called off.
   */
  private enemyThinks(w: World): void {
    const red = this.bats.filter((b) => b.side === 'red' && b.alive);
    const redTowns = this.townS.map((_, i) => i).filter((i) => this.hooks.owner(i) === 'red');
    const blueTowns = this.townS.map((_, i) => i).filter((i) => this.hooks.owner(i) === 'blue');
    const stage = redTowns.length ? Math.min(...redTowns) : -1;
    const stageS = stage >= 0 ? this.townS[stage] : this.redDepot;
    const target = blueTowns.length ? Math.max(...blueTowns) : -1;
    // An attack under way: called off if worn down, or over once the town is ours to keep or theirs.
    if (this.enemyGoal !== undefined) {
      const att = red.filter((b) => this.attackers.includes(b.id) && !b.broken);
      const avg = att.length ? att.reduce((t, b) => t + b.strength, 0) / att.length : 0;
      const done = this.hooks.owner(this.enemyGoal) === 'red';
      if (!att.length || avg < GROUND.attackBreak || done) {
        if (!done && att.length) {
          w.log(`The enemy attack on ${this.townNames[this.enemyGoal]} has been beaten off: its battalions are pulling back`, 'kill');
          this.hooks.event(`the enemy attack on ${this.townNames[this.enemyGoal]} has been beaten off`);
        }
        for (const b of att) {
          b.order = 'withdraw';
          b.goal = stageS;
          b.formUntil = undefined;
        }
        this.enemyGoal = undefined;
        this.attackers = [];
        this.nextAttack = now(w) + GROUND.attackGapS;
      } else for (const b of att) if (b.order === 'hold') {
        // Arrived: it stays on the town until it falls or the attack is called off.
        b.order = 'advance';
        b.goal = this.townS[this.enemyGoal];
      }
      return;
    }
    // Idle battalions gather at the staging town.
    for (const b of red) if (b.order === 'hold' && Math.abs(b.s - stageS) > GROUND.townR && !b.broken) {
      b.order = 'withdraw';
      b.goal = stageS;
    }
    if (this.nextAttack < 0) this.nextAttack = now(w) + GROUND.firstAttackS;
    if (target < 0 || now(w) < this.nextAttack) return;
    const ready = red.filter((b) => b.order === 'hold' && Math.abs(b.s - stageS) <= GROUND.townR && b.strength >= GROUND.attackMin);
    // One stays behind to hold the staging town.
    if (ready.length < GROUND.attackWith + 1 && !(ready.length >= GROUND.attackWith && stage < 0)) return;
    const go = ready.sort((a, b) => b.strength - a.strength).slice(0, ready.length - 1);
    this.enemyGoal = target;
    this.attackers = go.map((b) => b.id);
    for (const b of go) {
      b.order = 'advance';
      b.goal = this.townS[target];
      b.formUntil = now(w) + GROUND.formUpS;
    }
    const where = stage >= 0 ? this.townNames[stage] : 'its depot';
    w.log(`Intel: ${go.length} enemy battalions are forming up at ${where} to attack ${this.townNames[target]}. They move in about ${Math.round(GROUND.formUpS / 60)} minutes: a deep strike can hit them while they form up.`, 'alert');
    this.hooks.event(`${go.length} enemy battalions are forming up at ${where} to attack ${this.townNames[target]}`);
  }

  /** Set our objective: every battalion told to advance heads for it. */
  setObjective(kind: 'push' | 'hold', town: number): void {
    this.objective = { kind, town };
    for (const b of this.bats) if (b.side === 'blue' && b.alive && b.order === 'advance') b.goal = this.townS[town];
  }

  /** An order to one of our battalions. */
  order(b: Battalion, o: Order): string | null {
    if (b.side !== 'blue' || !b.alive) return 'Not one of ours';
    if (o === 'advance') {
      if (!this.objective) return 'Set an objective first';
      if (b.broken) return 'It is broken and must refit first';
      b.goal = this.townS[this.objective.town];
    } else if (o === 'withdraw') {
      // Back to the nearest town of ours behind it, or the depot.
      const behind = this.townS.map((s, i) => ({ s, i })).filter((x) => x.s < b.s - 500 && this.hooks.owner(x.i) === 'blue').map((x) => x.s);
      b.goal = behind.length ? Math.max(...behind) : this.blueDepot;
    } else b.goal = undefined;
    b.order = o;
    return null;
  }
}
