import { ROUND_COST } from './catalog';
import { Drone, Entity } from './entities';
import { V3, add, clone, hdist, norm, polar, scale, v3 } from './math';
import type { Site } from './sites';
import type { FireUnit } from './sites';
import type { World } from './world';

/**
 * Support calls during a battle: things the commander can buy with the campaign budget while the raid is on.
 * Game stats only: a flat delay and price for each.
 */
export const RESUPPLY = { rounds: 4, feeM: 3, loadS: 30 };
/** Supply trucks drive at about 65 km/h on the roads (m/s). */
export const CONVOY_SPEED = 18;

export const FIELD_REPAIR = { delayS: 120, hp: 30, costM: 10 };

export interface SupportCall {
  kind: 'repair';
  /** Sim time it arrives. */
  t: number;
  fu?: FireUnit;
  site?: Site;
}

export const resupplyCost = (fu: FireUnit): number => RESUPPLY.feeM + RESUPPLY.rounds * (ROUND_COST[fu.type] ?? 0);

/** Money left for support calls (Infinity in the sandbox). */
export const budgetLeft = (w: World): number => w.budgetM - w.supportSpentM;

/**
 * A resupply convoy: trucks that drive from a depot (the airbase, or a town we hold) to a battery. They are on
 * the map and the enemy hunts them: the further forward they drive, the likelier loitering munitions come
 * for them. Our air defence can shoot those down like any other drone. Game-level numbers.
 */
export class Convoy extends Entity {
  readonly kind = 'convoy' as const;
  readonly side = 'blue' as const;
  readonly fu: FireUnit;
  readonly from: string;
  private readonly dest: V3;
  private readonly startT: number;
  private nextRoll: number;
  private hunted = false;
  private readonly hunters: Drone[] = [];

  constructor(name: string, pos: V3, fu: FireUnit, from: string, t: number) {
    super(name, pos);
    this.fu = fu;
    this.from = from;
    this.dest = clone(batteryPos(fu));
    this.startT = t;
    this.nextRoll = t + RESUPPLY.loadS + 40;
    this.airborne = false;
    this.rcs = 0;
  }

  /** Seconds until it arrives. */
  eta(w: World): number {
    return Math.max(0, this.startT + RESUPPLY.loadS - w.t) + hdist(this.pos, this.dest) / CONVOY_SPEED;
  }

  update(w: World, dt: number): void {
    // Loitering munitions hunting it home on where it is now.
    for (const h of this.hunters) if (h.alive) h.target = v3(this.pos.x, this.pos.y, this.pos.z);
    if (w.t < this.startT + RESUPPLY.loadS) return;
    const d = hdist(this.pos, this.dest);
    if (d < 250) {
      deliver(w, this.fu);
      w.setFate(this, 'exit', this.fu.name);
      this.alive = false;
      return;
    }
    const dir = norm(v3(this.dest.x - this.pos.x, this.dest.y - this.pos.y, 0));
    this.vel = scale(dir, CONVOY_SPEED);
    this.pos = add(this.pos, scale(this.vel, dt));
    this.pos.z = w.terrain.groundAt(this.pos.x, this.pos.y) + 2;
    if (!this.hunted && w.t >= this.nextRoll) {
      this.nextRoll = w.t + 40;
      if (w.exposure.level >= 2 && w.rng.chance(huntChance(this.pos))) this.hunt(w);
    }
  }

  private hunt(w: World): void {
    this.hunted = true;
    const brg = w.terrain.layout.rot + w.rng.range(-40, 40);
    for (let i = 0; i < 2; i++) {
      const start = add(this.pos, polar(brg + (i - 0.5) * 25, 6000));
      start.z = w.terrain.groundAt(start.x, start.y) + 150;
      const h = new Drone(w.nextName('LM'), start, [], this.pos, this.name, 150);
      this.hunters.push(h);
      w.spawn(h);
    }
    w.log(`${this.name} spotted on the road: 2 loitering munitions hunting it`, 'alert');
  }
}

/** Where a convoy unloads: the battery's first launcher. */
export const batteryPos = (fu: FireUnit): V3 => fu.launchers[0]?.site.pos ?? fu.radar!.pos;

/** Chance per 40 s of driving that the enemy spots a convoy: low near the airbase, high up the front. */
export const huntChance = (p: V3): number => 0.08 + 0.32 * Math.min(1, Math.hypot(p.x, p.y) / 50000);

function deliver(w: World, fu: FireUnit): void {
  fu.spares = (Number.isFinite(fu.spares) ? fu.spares : 0) + RESUPPLY.rounds;
  // Crews start reloading the empty rails straight away.
  for (const l of fu.launchers) if (l.site.alive && l.rounds < l.max && l.reloadAt === 0) l.reloadAt = w.t + fu.reloadS;
  w.log(`Resupply convoy reached ${fu.name}: +${RESUPPLY.rounds} spare missiles`, 'info');
}

/** The day is over: convoys still on the road arrive overnight. */
export function finishConvoys(w: World): void {
  for (const e of w.entities) {
    if (!(e instanceof Convoy) || !e.alive) continue;
    deliver(w, e.fu);
    e.alive = false;
  }
}

/** Where convoys can load: the airbase and every town we still hold, nearest to the battery first. */
export function depots(w: World, fu: FireUnit): Site[] {
  return w.sites
    .filter((s) => s.alive && (s.name === 'Airbase' || s.role === 'town'))
    .sort((a, b) => hdist(a.pos, batteryPos(fu)) - hdist(b.pos, batteryPos(fu)));
}

/** Why a resupply convoy cannot be sent to this battery now, or null. */
export function resupplyError(w: World, fu: FireUnit): string | null {
  if (w.entities.some((e) => e instanceof Convoy && e.alive && e.fu === fu)) return 'convoy on its way';
  if (!depots(w, fu).length) return 'no depot left';
  if (!fu.launchers.some((l) => l.site.alive)) return 'no launchers left';
  if (resupplyCost(fu) > budgetLeft(w)) return 'not enough budget';
  return null;
}

/** Why a field repair team cannot go to this site now, or null. */
export function repairError(w: World, site: Site): string | null {
  if (!site.alive) return 'destroyed';
  if (site.hp >= 100) return 'undamaged';
  if (w.support.some((c) => c.site === site)) return 'team on its way';
  if (FIELD_REPAIR.costM > budgetLeft(w)) return 'not enough budget';
  return null;
}

/** Send a convoy from `depot` (by name; the nearest one when omitted). */
export function callResupply(w: World, fu: FireUnit, depot?: string): string | null {
  const err = resupplyError(w, fu);
  if (err) return err;
  const from = depots(w, fu).find((s) => !depot || s.name === depot);
  if (!from) return 'no such depot';
  w.supportSpentM += resupplyCost(fu);
  const c = new Convoy(w.nextName('Convoy'), v3(from.pos.x, from.pos.y, from.pos.z + 2), fu, from.name, w.t);
  w.spawn(c);
  const s = Math.round(c.eta(w));
  w.log(`Resupply convoy with ${RESUPPLY.rounds} missiles leaving ${from.name} for ${fu.name}, about ${(s / 60) | 0}:${String(s % 60).padStart(2, '0')} on the road`, 'info');
  return null;
}

export function callRepair(w: World, site: Site): string | null {
  const err = repairError(w, site);
  if (err) return err;
  w.supportSpentM += FIELD_REPAIR.costM;
  w.support.push({ kind: 'repair', t: w.t + FIELD_REPAIR.delayS, site });
  w.log(`Field repair team sent to ${site.name}`, 'info');
  return null;
}

/** Deliver support calls that have arrived. */
export function stepSupport(w: World): void {
  if (!w.support.length || w.support[0].t > w.t) return;
  w.support.sort((a, b) => a.t - b.t);
  while (w.support.length && w.support[0].t <= w.t) {
    const c = w.support.shift()!;
    if (c.kind === 'repair' && c.site) {
      if (!c.site.alive) continue;
      c.site.hp = Math.min(100, c.site.hp + FIELD_REPAIR.hp);
      w.log(`Field repair on ${c.site.name} done (${Math.round(c.site.hp)}%)`, 'info');
    }
  }
}

/** Quick reaction alert: a fighter pair kept on the airbase that can be scrambled once a battle. */
export const QRA = { costM: 25, missiles: 2, fuelS: 1500 };

/** Why the alert pair cannot be scrambled now, or null. */
export function qraError(w: World): string | null {
  if (w.qraUsed) return 'already scrambled today';
  if (!w.site('Airbase')?.alive) return 'the airbase is out of action';
  if (QRA.costM > budgetLeft(w)) return 'not enough budget';
  return null;
}

/** Scramble the alert pair from the airbase. Returns why it cannot, or null. */
export function scrambleQra(w: World): string | null {
  const err = qraError(w);
  if (err) return err;
  w.qraUsed = true;
  w.supportSpentM += QRA.costM;
  w.addQra(QRA.missiles, QRA.fuelS);
  return null;
}
