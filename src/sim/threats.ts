import { V3, add, bearingDeg, clone, hdist, polar, v3, wrap180 } from './math';
import { Airliner, Bomber, Cruise, Drone, Helo, ReconDrone, Sead, Soj, Striker, Tbm } from './entities';
import type { World } from './world';
import { escortStrike } from './redair';
import { type Asset, type EnemyBase, HOSTS } from './theatre';

export type ThreatType = 'drones' | 'decoys' | 'recon' | 'cruise' | 'bomber' | 'strike' | 'helo' | 'sead' | 'soj' | 'tbm' | 'airliner' | 'airliner-dark';

export const THREAT_LABELS: Record<ThreatType, string> = {
  drones: 'Drone swarm (6)',
  decoys: 'Decoy drones (10)',
  recon: 'Recon drone',
  cruise: 'Cruise missiles (4)',
  bomber: 'Strike bomber (4 ALCM)',
  strike: 'Strike jets, low level (2)',
  helo: 'Attack helicopters (2)',
  sead: 'SEAD pair (ARMs)',
  soj: 'Stand-off jammer',
  tbm: 'Ballistic missiles (2)',
  airliner: 'Civil airliner',
  'airliner-dark': 'Airliner, transponder off',
};

interface Aim {
  pos: V3;
  name: string;
}

/** Targets red planners pick from: the defended assets plus the SAM radars. */
export function strikeTargets(w: World): Aim[] {
  return w.sites
    .filter((s) => s.alive && (s.defended || s.kind === 'radar'))
    .map((s) => ({ pos: clone(s.pos), name: s.name }));
}

/** A target by site name, or a fixed map position (such as one an enemy recon drone photographed). */
export type Target = string | { x: number; y: number; name: string };

function targetsByName(w: World, names: Target[]): Aim[] {
  const all = strikeTargets(w);
  const picked = names
    .map((n) => (typeof n === 'string' ? all.find((a) => a.name === n) : { pos: v3(n.x, n.y, w.terrain.groundAt(n.x, n.y)), name: n.name }))
    .filter((a): a is Aim => !!a);
  return picked.length ? picked : all;
}

/** How much each kind of battery covers a target point against it (game-level weights). */
const COVER_W: Record<string, number> = { LR: 1.5, MR: 1, SH: 0.6 };

/**
 * The enemy planner's pick: of the usual targets for this weapon (plus batteries running low on missiles,
 * the assault column and, for a big raid, the power plant), the ones it hurts most to lose and that are worst
 * covered, most painful first. Game-level scoring of what the enemy would know from its recon and our launches.
 */
export function smartAims(w: World, defaults: string[], weapon: 'drone' | 'cruise' | 'strike' | 'bomber', n: number): Aim[] {
  const all = strikeTargets(w);
  const score = new Map<Aim, number>();
  const bump = (a: Aim | undefined, v: number): void => {
    if (a) score.set(a, (score.get(a) ?? 0) + v);
  };
  defaults.forEach((name, i) => bump(all.find((a) => a.name === name), 1 - i * 0.15));
  // A battery that has fired most of its missiles is easy prey: hit it before it reloads.
  for (const f of w.fielded) {
    const fu = f.fu;
    if (!fu || !f.sites[0]?.alive || fu.maxRounds === 0) continue;
    if (fu.rounds <= fu.maxRounds * 0.34) bump(all.find((a) => a.name === f.sites[0].name) ?? { pos: clone(f.sites[0].pos), name: f.sites[0].name }, 1.4);
  }
  // The assault column on the road: drones and strike jets go for it.
  if ((weapon === 'drone' || weapon === 'strike') && w.column?.alive && !w.assaultOutcome) bump(all.find((a) => a.name === 'Assault force'), 1.6);
  // A big missile raid takes the power out first, so the radars fight on generators.
  if ((weapon === 'cruise' || weapon === 'bomber') && n >= 4) bump(all.find((a) => a.name === 'Power plant'), 1.2);
  // Coverage gaps: the fewer batteries with missiles that reach a target, the better it looks.
  const out = [...score.keys()];
  for (const a of out) {
    let cover = 0;
    for (const f of w.fielded) {
      const fu = f.fu;
      if (!fu || fu.stowed || fu.rounds === 0 || !f.sites[0]?.alive) continue;
      if (hdist(f.sites[0].pos, a.pos) < fu.spec.maxRangeM * 0.6) cover += COVER_W[fu.type] ?? 1;
    }
    bump(a, 1.5 / (1 + cover) + w.rng.range(0, 0.3));
  }
  out.sort((a, b) => score.get(b)! - score.get(a)!);
  return out.length ? out.slice(0, 3) : all;
}

/**
 * Where a raid launches from. Omitted: the enemy installation for that weapon best placed for the approach
 * bearing (sandbox and Last Stand), so nothing appears near our units. A point: that installation (the
 * campaign picks the base and draws on its stock). 'range': the old placement `rangeM` out on the bearing,
 * kept for the scripted tutorial only.
 */
export type LaunchFrom = { x: number; y: number } | 'range' | undefined;

/** The installation (of those that launch `a`) whose bearing from the airbase is closest to `bearing`. */
export function launchBase(w: World, a: Asset, bearing: number): EnemyBase | null {
  let best: EnemyBase | null = null;
  let score = Infinity;
  for (const b of w.theatre) {
    if (b.lost || !HOSTS[a].includes(b.kind)) continue;
    const d = Math.abs(wrap180(bearingDeg(v3(), v3(b.x, b.y)) - bearing));
    if (d < score) {
      score = d;
      best = b;
    }
  }
  return best;
}

/** Launch point for a weapon, or null for the legacy placement. */
function launchPoint(w: World, a: Asset, bearing: number, from: LaunchFrom): V3 | null {
  if (from === 'range') return null;
  if (from) return v3(from.x, from.y, w.terrain.groundAt(from.x, from.y));
  const b = launchBase(w, a, bearing);
  return b ? v3(b.x, b.y, w.terrain.groundAt(b.x, b.y)) : null;
}

/** Recon drones: high, slow, orbiting 32 km out on their bearing and photographing our units, then home. */
export function spawnRecon(w: World, n: number, bearing: number, from?: LaunchFrom): void {
  const base = launchPoint(w, 'recon', bearing, from);
  for (let i = 0; i < n; i++) {
    const b = bearing + (i - (n - 1) / 2) * 25;
    const start = base ? add(base, polar(b + 90, i * 1500, 900)) : polar(b, 85000, 9000);
    w.spawn(new ReconDrone(w.nextName('UAV'), start, polar(b, 32000)));
  }
}

/**
 * Cheap decoy drones: on radar they look like attack drones, but they carry no warhead. They exist to soak
 * up missiles and pull fire units into tying up their channels.
 */
export function spawnDecoyDrones(w: World, n: number, bearing: number, rangeM: number, from?: LaunchFrom): void {
  const before = w.entities.length;
  spawnDrones(w, n, bearing, rangeM, undefined, undefined, from);
  for (const e of w.entities.slice(before)) {
    if (e.kind !== 'drone') continue;
    e.warhead = null;
    e.decoy = true;
  }
}

/**
 * One-way attack drones. From a launch site they fly out to an approach point on `bearing` and turn in from
 * there; `origin` is a point they attack round instead of the airbase (a counter-attack on the assault force).
 */
export function spawnDrones(w: World, n: number, bearing: number, rangeM: number, targets?: Target[], origin?: { x: number; y: number }, from?: LaunchFrom): void {
  const aims = targets ? targetsByName(w, targets) : origin ? targetsByName(w, ['Airbase', 'Power plant', 'CRC']) : smartAims(w, ['Airbase', 'Power plant', 'CRC'], 'drone', n);
  const o = v3(origin?.x ?? 0, origin?.y ?? 0);
  const base = launchPoint(w, 'drone', bearing, from);
  for (let i = 0; i < n; i++) {
    const lateral = (i - (n - 1) / 2) * 900 + w.rng.gauss() * 300;
    const aim = aims[i % aims.length];
    let start: V3;
    let route: V3[];
    if (base) {
      // Launched a few seconds apart from the team's rails, then out to the approach point and in.
      start = add(base, polar(w.rng.range(0, 360), w.rng.range(100, 600)));
      const approach = add(o, add(polar(bearing + w.rng.range(-15, 15), origin ? 9000 : 22000), polar(bearing + 90, lateral)));
      route = hdist(base, approach) > 8000 ? [approach] : [];
    } else {
      start = add(o, add(polar(bearing, rangeM + w.rng.range(-2000, 2000)), polar(bearing + 90, lateral)));
      // One dogleg to approach from an off-axis direction.
      route = [add(o, add(polar(bearing + w.rng.range(-25, 25), rangeM * 0.45), polar(bearing + 90, lateral)))];
    }
    start.z = w.terrain.groundAt(start.x, start.y) + (base ? 30 : 250);
    const d = new Drone(w.nextName('DRN'), start, route, aim.pos, aim.name, w.rng.range(120, 380));
    if (w.rng.chance(0.3)) d.gnssDep = 0.15; // some airframes carry an anti-jam antenna
    if (base) w.spawnLater(d, i * 4);
    else w.spawn(d);
  }
}

export function spawnCruise(w: World, n: number, bearing: number, rangeM: number, targets?: Target[], from?: LaunchFrom): void {
  const aims = targets ? targetsByName(w, targets) : smartAims(w, ['Airbase', 'CRC', 'LR radar', 'MR radar'], 'cruise', n);
  const t = w.terrain;
  const base = launchPoint(w, 'cruise', bearing, from);
  // From the mountain side they come down the passes; elsewhere in low over the plain or the sea.
  const viaPasses = t.mountainSide(bearing);
  for (let i = 0; i < n; i++) {
    const aim = aims[i % aims.length];
    let start: V3;
    let route: V3[];
    const which = (i % 2) as 0 | 1;
    if (base) {
      start = add(base, polar(w.rng.range(0, 360), w.rng.range(200, 1500)));
      const v = t.toLocal(start.x, start.y).v;
      route = viaPasses ? [t.toWorld(t.passU(which, Math.min(v, rangeM)), Math.min(v, rangeM)), ...t.passRoute(which, Math.min(v, rangeM))] : [add(polar(bearing + w.rng.range(-30, 30), rangeM * 0.4), v3())];
    } else if (viaPasses) {
      const v = rangeM + i * 2500;
      start = t.toWorld(t.passU(which, v) + w.rng.gauss() * 400, v);
      route = t.passRoute(which, v);
    } else {
      start = add(polar(bearing, rangeM + i * 2500), polar(bearing + 90, w.rng.gauss() * 3000));
      route = [add(polar(bearing + w.rng.range(-30, 30), rangeM * 0.4), v3())];
    }
    start.z = w.terrain.groundAt(start.x, start.y) + 60;
    const cm = new Cruise(w.nextName('CM'), start, route, aim.pos, aim.name);
    if (base) w.spawnLater(cm, i * 6);
    else w.spawn(cm);
  }
}

export function spawnBombers(w: World, n: number, bearing: number, rangeM: number, from?: LaunchFrom): void {
  const aims = smartAims(w, ['Airbase', 'CRC', 'Power plant', 'LR radar'], 'bomber', n * 4);
  const base = launchPoint(w, 'bomber', bearing, from);
  for (let i = 0; i < n; i++) {
    const start = add(base ?? polar(bearing, rangeM), polar(bearing + 90, (i - (n - 1) / 2) * 6000));
    start.z = 9500;
    const rot = aims.slice(i % aims.length).concat(aims.slice(0, i % aims.length));
    w.spawn(new Bomber(w.nextName('BMR'), start, rot));
  }
}

/** Strike fighters: take off, come in high, down to treetop height for the last 95 km, pop up and glide-bomb. */
export function spawnStrike(w: World, n: number, bearing: number, rangeM: number, targets?: Target[], from?: LaunchFrom): void {
  const aims = targets ? targetsByName(w, targets) : smartAims(w, ['Airbase', 'Power plant', 'CRC', 'MR radar'], 'strike', n);
  const first = w.rng.int(0, aims.length - 1);
  const base = launchPoint(w, 'strike', bearing, from);
  const jets: Striker[] = [];
  for (let i = 0; i < n; i++) {
    const aim = aims[(first + i) % aims.length];
    if (base) {
      const start = add(base, polar(bearing + 90, (i - (n - 1) / 2) * 3000, 600));
      start.z += w.terrain.groundAt(start.x, start.y);
      const s = new Striker(w.nextName('STK'), start, aim);
      // Swing out to come in on the planned bearing when it is well off the line from the airfield.
      const off = Math.abs(wrap180(bearingDeg(aim.pos, start) - bearing));
      if (off > 40 && off < 110) s.waypoints = [add(aim.pos, polar(bearing, 60000))];
      w.spawnLater(s, i * 8);
      jets.push(s);
    } else {
      const start = add(polar(bearing, rangeM), polar(bearing + 90, (i - (n - 1) / 2) * 3000));
      start.z = 8000;
      w.spawn(new Striker(w.nextName('STK'), start, aim));
    }
  }
  // From day 5 the package brings fighter escorts along.
  if (base) escortStrike(w, jets, base, 0);
}

/**
 * Attack helicopters at treetop height, a few km apart. With an `origin` they creep towards that point
 * (a counter-attack on the assault force) instead of the airbase.
 */
export function spawnHelos(w: World, n: number, bearing: number, rangeM: number, origin?: { x: number; y: number }, from?: LaunchFrom): void {
  const o = v3(origin?.x ?? 0, origin?.y ?? 0);
  const base = launchPoint(w, 'helo', bearing, from);
  for (let i = 0; i < n; i++) {
    const start = base ? add(base, polar(bearing + 90, (i - (n - 1) / 2) * 800)) : add(o, add(polar(bearing, rangeM), polar(bearing + 90, (i - (n - 1) / 2) * 2500)));
    start.z = w.terrain.groundAt(start.x, start.y) + 25;
    w.spawn(new Helo(w.nextName('HEL'), start, origin ? o : undefined));
  }
}

/** From which campaign day SEAD pairs send decoys ahead and fire from stand-off range at radars that keep radiating. */
export const SEAD_DECOY_LEVEL = 5;

export function spawnSead(w: World, n: number, bearing: number, rangeM: number, from?: LaunchFrom, aims?: Target[]): void {
  const base = launchPoint(w, 'sead', bearing, from);
  // Aimed at a battery their recon found: go for the radars there first.
  const a = aims?.find((x) => typeof x !== 'string');
  const focus = a && typeof a !== 'string' ? v3(a.x, a.y) : undefined;
  // From day 5 decoys fly ahead of the shooters to make our radars light up and fire.
  if (base && w.exposure.level >= SEAD_DECOY_LEVEL) {
    const aim = focus ?? v3();
    for (let i = 0; i < 3; i++) {
      const start = add(base, polar(w.rng.range(0, 360), w.rng.range(200, 900)));
      start.z = w.terrain.groundAt(start.x, start.y) + 3000;
      const d = new Cruise(w.nextName('DCY'), start, [], v3(aim.x + w.rng.gauss() * 1500, aim.y + w.rng.gauss() * 1500, w.terrain.groundAt(aim.x, aim.y)), 'decoy');
      d.warhead = null;
      d.decoy = true;
      w.spawnLater(d, i * 3);
    }
  }
  for (let i = 0; i < n; i++) {
    const start = add(base ?? polar(bearing, rangeM), polar(bearing + 90, (i - (n - 1) / 2) * 4000));
    start.z = base ? start.z + 800 : 7500;
    w.spawnLater(new Sead(w.nextName('SEAD'), start, focus), base && w.exposure.level >= SEAD_DECOY_LEVEL ? 40 : 0);
  }
}

/** Stand-off jammer: enters from the rear and flies a racetrack 125 km out on its bearing. */
export function spawnSoj(w: World, bearing: number, rangeM: number, from?: LaunchFrom): void {
  const base = launchPoint(w, 'soj', bearing, from);
  w.spawn(new Soj(w.nextName('SOJ'), polar(bearing, rangeM, 9500), bearing, base ? v3(base.x, base.y, 9500) : undefined));
}

/** Ballistic missiles, fired from a launch area at targets; CEP round each aim point. */
export function spawnTbm(w: World, n: number, bearing: number, targets?: Target[], from?: LaunchFrom): void {
  const aims = targets ? targetsByName(w, targets) : targetsByName(w, ['Airbase', 'LR radar', 'CRC']);
  const base = launchPoint(w, 'tbm', bearing, from);
  for (let i = 0; i < n; i++) {
    const aim = aims[i % aims.length];
    const impact = add(aim.pos, v3(w.rng.gauss() * 60, w.rng.gauss() * 60, 0));
    impact.z = w.terrain.groundAt(impact.x, impact.y);
    w.spawnLater(tbmFrom(w, impact, aim.name, base, bearing), i * 7);
  }
}

/** One ballistic missile from a launch point (or the old fixed 175 km on a bearing) to an impact point. */
export function tbmFrom(w: World, impact: V3, aimName: string, base: V3 | null, bearing: number): Tbm {
  const range = base ? Math.max(40000, hdist(base, impact)) : 175000 + w.rng.range(-10000, 10000);
  const b = base ? bearingDeg(impact, base) : bearing + w.rng.gauss() * 2;
  const s = Tbm.solve(impact, b, range, range * 0.48, tbmFlightS(range) + w.rng.range(-5, 5));
  return new Tbm(w.nextName('TBM'), s.pos, s.vel, impact, aimName);
}

/** Time of flight of a short-range ballistic missile over a ground range (s): 105 s at 175 km. */
export const tbmFlightS = (rangeM: number): number => Math.max(55, rangeM * 0.0006);

const AIRWAYS: [V3, V3][] = [
  [v3(-210000, -28000), v3(210000, -20000)],
  [v3(200000, -35000), v3(-200000, -40000)],
  [v3(-160000, -160000), v3(160000, 140000)],
  [v3(60000, 210000), v3(-40000, -210000)],
];

export function spawnAirliner(w: World, transponder: boolean, airway?: number, progress = 0): void {
  const [a, b] = AIRWAYS[airway ?? w.rng.int(0, AIRWAYS.length - 1)];
  const from = v3(a.x + (b.x - a.x) * progress, a.y + (b.y - a.y) * progress, 0);
  w.spawn(new Airliner(w.nextName('CIV'), from, b, transponder));
}

/** Airliner whose route crosses the defended area (used to test identification discipline). */
export function spawnDarkAirliner(w: World): void {
  w.spawn(new Airliner(w.nextName('CIV'), v3(-190000, 12000), v3(190000, -6000), false));
}

export function spawnThreat(w: World, type: ThreatType, bearing: number): void {
  switch (type) {
    case 'drones':
      return spawnDrones(w, 6, bearing, 45000);
    case 'decoys':
      return spawnDecoyDrones(w, 10, bearing, 45000);
    case 'recon':
      return spawnRecon(w, 1, bearing);
    case 'cruise':
      return spawnCruise(w, 4, bearing, 120000);
    case 'bomber':
      return spawnBombers(w, 1, bearing, 190000);
    case 'strike':
      return spawnStrike(w, 2, bearing, 150000);
    case 'helo':
      return spawnHelos(w, 2, bearing, 40000);
    case 'sead':
      return spawnSead(w, 2, bearing, 160000);
    case 'soj':
      return spawnSoj(w, bearing, 125000);
    case 'tbm':
      return spawnTbm(w, 2, bearing);
    case 'airliner':
      return spawnAirliner(w, true);
    case 'airliner-dark':
      return spawnDarkAirliner(w);
  }
}
