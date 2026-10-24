import { V3, add, clone, polar, v3 } from './math';
import { Airliner, Bomber, Cruise, Drone, Helo, ReconDrone, Sead, Soj, Striker, Tbm } from './entities';
import type { World } from './world';

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

/** Recon drones: high, slow, orbiting 32 km out on their bearing and photographing our units. */
export function spawnRecon(w: World, n: number, bearing: number): void {
  for (let i = 0; i < n; i++) {
    const b = bearing + (i - (n - 1) / 2) * 25;
    const start = polar(b, 85000);
    start.z = 9000;
    w.spawn(new ReconDrone(w.nextName('UAV'), start, polar(b, 32000)));
  }
}

/**
 * Cheap decoy drones: on radar they look like attack drones, but they carry no warhead. They exist to soak
 * up missiles and pull fire units into tying up their channels.
 */
export function spawnDecoyDrones(w: World, n: number, bearing: number, rangeM: number): void {
  const before = w.entities.length;
  spawnDrones(w, n, bearing, rangeM);
  for (const e of w.entities.slice(before)) {
    if (e.kind !== 'drone') continue;
    e.warhead = null;
    e.decoy = true;
  }
}

export function spawnDrones(w: World, n: number, bearing: number, rangeM: number, targets?: Target[]): void {
  const aims = targets ? targetsByName(w, targets) : targetsByName(w, ['Airbase', 'Power plant', 'CRC']);
  for (let i = 0; i < n; i++) {
    const lateral = (i - (n - 1) / 2) * 900 + w.rng.gauss() * 300;
    const start = add(polar(bearing, rangeM + w.rng.range(-2000, 2000)), polar(bearing + 90, lateral));
    start.z = w.terrain.groundAt(start.x, start.y) + 250;
    const aim = aims[i % aims.length];
    // One dogleg to approach from an off-axis direction.
    const mid = add(polar(bearing + w.rng.range(-25, 25), rangeM * 0.45), polar(bearing + 90, lateral));
    const d = new Drone(w.nextName('DRN'), start, [mid], aim.pos, aim.name, w.rng.range(120, 380));
    if (w.rng.chance(0.3)) d.gnssDep = 0.15; // some airframes carry an anti-jam antenna
    w.spawn(d);
  }
}

export function spawnCruise(w: World, n: number, bearing: number, rangeM: number, targets?: Target[]): void {
  const aims = targets ? targetsByName(w, targets) : targetsByName(w, ['Airbase', 'CRC', 'LR radar', 'MR radar']);
  const t = w.terrain;
  // From the mountain side they come down the passes; elsewhere straight in, low over the plain or the sea.
  const viaPasses = t.mountainSide(bearing);
  for (let i = 0; i < n; i++) {
    const aim = aims[i % aims.length];
    let start: V3;
    let route: V3[];
    if (viaPasses) {
      const which = (i % 2) as 0 | 1;
      const v = rangeM + i * 2500;
      start = t.toWorld(t.passU(which, v) + w.rng.gauss() * 400, v);
      route = t.passRoute(which, v);
    } else {
      start = add(polar(bearing, rangeM + i * 2500), polar(bearing + 90, w.rng.gauss() * 3000));
      route = [add(polar(bearing + w.rng.range(-30, 30), rangeM * 0.4), v3())];
    }
    start.z = w.terrain.groundAt(start.x, start.y) + 60;
    w.spawn(new Cruise(w.nextName('CM'), start, route, aim.pos, aim.name));
  }
}

export function spawnBombers(w: World, n: number, bearing: number, rangeM: number): void {
  const aims = targetsByName(w, ['Airbase', 'CRC', 'Power plant', 'LR radar']);
  for (let i = 0; i < n; i++) {
    const start = add(polar(bearing, rangeM), polar(bearing + 90, (i - (n - 1) / 2) * 6000));
    start.z = 9500;
    const rot = aims.slice(i % aims.length).concat(aims.slice(0, i % aims.length));
    w.spawn(new Bomber(w.nextName('BMR'), start, rot));
  }
}

/** Strike fighters: in high, down to treetop height for the last 75 km, pop up and glide-bomb their target. */
export function spawnStrike(w: World, n: number, bearing: number, rangeM: number, targets?: Target[]): void {
  const aims = targets ? targetsByName(w, targets) : targetsByName(w, ['Airbase', 'Power plant', 'CRC', 'MR radar']);
  const first = w.rng.int(0, aims.length - 1);
  for (let i = 0; i < n; i++) {
    const start = add(polar(bearing, rangeM), polar(bearing + 90, (i - (n - 1) / 2) * 3000));
    start.z = 8000;
    w.spawn(new Striker(w.nextName('STK'), start, aims[(first + i) % aims.length]));
  }
}

/** Attack helicopters, starting `rangeM` out at treetop height, a few km apart. */
export function spawnHelos(w: World, n: number, bearing: number, rangeM: number): void {
  for (let i = 0; i < n; i++) {
    const start = add(polar(bearing, rangeM), polar(bearing + 90, (i - (n - 1) / 2) * 2500));
    start.z = w.terrain.groundAt(start.x, start.y) + 25;
    w.spawn(new Helo(w.nextName('HEL'), start));
  }
}

export function spawnSead(w: World, n: number, bearing: number, rangeM: number): void {
  for (let i = 0; i < n; i++) {
    const start = add(polar(bearing, rangeM), polar(bearing + 90, (i - (n - 1) / 2) * 4000));
    start.z = 7500;
    w.spawn(new Sead(w.nextName('SEAD'), start));
  }
}

export function spawnSoj(w: World, bearing: number, rangeM: number): void {
  w.spawn(new Soj(w.nextName('SOJ'), polar(bearing, rangeM, 9500), bearing));
}

export function spawnTbm(w: World, n: number, bearing: number, targets?: Target[]): void {
  const aims = targets ? targetsByName(w, targets) : targetsByName(w, ['Airbase', 'LR radar', 'CRC']);
  for (let i = 0; i < n; i++) {
    const aim = aims[i % aims.length];
    // Ballistic CEP around the aim point.
    const impact = add(aim.pos, v3(w.rng.gauss() * 60, w.rng.gauss() * 60, 0));
    impact.z = w.terrain.groundAt(impact.x, impact.y);
    const s = Tbm.solve(impact, bearing + w.rng.gauss() * 2, 175000 + w.rng.range(-10000, 10000), 85000, 105 + w.rng.range(-5, 5));
    const tbm = new Tbm(w.nextName('TBM'), s.pos, s.vel, impact, aim.name);
    w.spawnLater(tbm, i * 7);
  }
}

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
