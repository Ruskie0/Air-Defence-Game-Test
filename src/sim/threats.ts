import { V3, add, clone, polar, v3 } from './math';
import { Airliner, Bomber, Cruise, Drone, Sead, Soj, Tbm } from './entities';
import type { World } from './world';

export type ThreatType = 'drones' | 'cruise' | 'bomber' | 'sead' | 'soj' | 'tbm' | 'airliner' | 'airliner-dark';

export const THREAT_LABELS: Record<ThreatType, string> = {
  drones: 'Drone swarm (6)',
  cruise: 'Cruise missiles (4)',
  bomber: 'Strike bomber (4 ALCM)',
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

function targetsByName(w: World, names: string[]): Aim[] {
  const all = strikeTargets(w);
  const picked = names.map((n) => all.find((a) => a.name === n)).filter((a): a is Aim => !!a);
  return picked.length ? picked : all;
}

export function spawnDrones(w: World, n: number, bearing: number, rangeM: number, targets?: string[]): void {
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

export function spawnCruise(w: World, n: number, bearing: number, rangeM: number, targets?: string[]): void {
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

export function spawnTbm(w: World, n: number, bearing: number, targets?: string[]): void {
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
    case 'cruise':
      return spawnCruise(w, 4, bearing, 120000);
    case 'bomber':
      return spawnBombers(w, 1, bearing, 190000);
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
