import { DoctrineId, doctrineOf } from './doctrine';
import { Rng } from '../sim/rng';
import type { Raid } from '../sim/scenario';
import type { Sighting } from '../sim/entities';
import { type Target, spawnBombers, spawnCruise, spawnDarkAirliner, spawnDecoyDrones, spawnDrones, spawnRecon, spawnSead, spawnSoj, spawnStrike, spawnTbm } from '../sim/threats';

export type PkgKind = 'drones' | 'decoys' | 'recon' | 'cruise' | 'strike' | 'sead' | 'soj' | 'bomber' | 'tbm' | 'dark';

/** One enemy package in a day's raid plan. */
export interface PlannedPkg {
  id: number;
  kind: PkgKind;
  /** Bearing from the airbase the package comes from (deg). */
  bearing: number;
  size: number;
  /** Launch time, sim seconds after the day starts. */
  t: number;
  /** Whether intel reported this package in the briefing. */
  reported: boolean;
  /** Aimed at positions an enemy recon drone photographed, instead of the usual targets. */
  aims?: Sighting[];
}

/** What the enemy has learned: which kinds of attack and which approach sectors have worked. */
export interface EnemyModel {
  kindW: Record<PkgKind, number>;
  /** Weight per 45° approach sector, index = round(bearing / 45) % 8. */
  axisW: number[];
  /** Our positions its recon drones photographed yesterday: today's strikes go for them. */
  known?: Sighting[];
  /** Kinds of attack our deep strikes have knocked back, with the days left until they recover. */
  suppressed?: Partial<Record<PkgKind, number>>;
  /** The enemy commander's style; absent in old saves. */
  doctrine?: DoctrineId;
}

interface PkgDef {
  name: string;
  /** Threat points per package at size 1 plus per unit of size. */
  cost: (size: number) => number;
  minDay: number;
  size: (day: number, rng: Rng) => number;
  /** Approach sectors this kind may use. */
  sectors: number[];
  spawn: (w: Parameters<Raid['spawn']>[0], bearing: number, size: number, aims?: Target[]) => void;
  describe: (size: number) => string;
}

export const PKG: Record<PkgKind, PkgDef> = {
  drones: {
    name: 'Drone swarm', cost: (n) => 1 + n * 0.9, minDay: 1, sectors: [0, 1, 2, 3, 4, 5, 6, 7],
    size: (d, r) => Math.min(14, 4 + d + r.int(0, 2)),
    spawn: (w, b, n, aims) => spawnDrones(w, n, b, 50000, aims),
    describe: (n) => `${n} one-way attack drones, low and slow`,
  },
  decoys: {
    name: 'Decoy drones', cost: (n) => 2 + n * 0.5, minDay: 3, sectors: [0, 1, 2, 6, 7],
    size: (d, r) => Math.min(16, 6 + d + r.int(0, 3)),
    spawn: (w, b, n) => spawnDecoyDrones(w, n, b, 50000),
    describe: (n) => `${n} drones that our intel thinks are mostly unarmed decoys, sent to drain our missiles`,
  },
  recon: {
    name: 'Recon drone', cost: () => 3, minDay: 2, sectors: [0, 1, 7, 2, 6],
    size: (d) => (d >= 6 ? 2 : 1),
    spawn: (w, b, n) => spawnRecon(w, n, b),
    describe: (n) => `${n > 1 ? `${n} high-flying reconnaissance drones` : 'a high-flying reconnaissance drone'} orbiting about 32 km out to photograph our positions. If it gets home, tomorrow's strikes will go for what it saw`,
  },
  cruise: {
    name: 'Cruise missiles', cost: (n) => 2 + n * 2, minDay: 1, sectors: [0, 2, 3, 4, 5, 6],
    size: (d, r) => Math.min(8, 2 + Math.floor(d / 2) + r.int(0, 1)),
    spawn: (w, b, n, aims) => spawnCruise(w, n, b, 130000, aims),
    describe: (n) => `${n} terrain-following cruise missiles`,
  },
  strike: {
    name: 'Strike jets', cost: (n) => 2 + n * 3.5, minDay: 4, sectors: [0, 1, 7, 2, 6, 3, 5],
    size: (d, r) => Math.min(4, 2 + (d >= 7 ? 1 : 0) + (d >= 9 ? r.int(0, 1) : 0)),
    spawn: (w, b, n, aims) => spawnStrike(w, n, b, 150000, aims),
    describe: (n) => `${n} strike fighters that will come in at treetop height, pop up and glide-bomb a site. Low-flying jets with no IFF are declared hostile inside 45 km`,
  },
  sead: {
    name: 'SEAD pair', cost: () => 10, minDay: 3, sectors: [7, 0, 1, 6, 2],
    size: () => 2,
    spawn: (w, b, n) => spawnSead(w, n, b, 160000),
    describe: () => '2 SEAD fighters hunting radiating radars with anti-radiation missiles',
  },
  soj: {
    name: 'Stand-off jammer', cost: () => 7, minDay: 4, sectors: [7, 0, 1],
    size: () => 1,
    spawn: (w, b) => spawnSoj(w, b, 125000),
    describe: () => 'a stand-off jammer orbiting 125 km out',
  },
  bomber: {
    name: 'Bomber strike', cost: (n) => 6 + n * 6, minDay: 5, sectors: [7, 0, 1, 2, 6],
    size: (d) => (d >= 8 ? 2 : 1),
    spawn: (w, b, n) => spawnBombers(w, n, b, 195000),
    describe: (n) => `${n} bomber${n > 1 ? 's' : ''} launching cruise missiles from 115 km`,
  },
  tbm: {
    name: 'Ballistic missiles', cost: (n) => 4 + n * 4, minDay: 5, sectors: [7, 0, 1],
    size: (d, r) => Math.min(6, 2 + Math.floor((d - 5) / 2) + r.int(0, 1)),
    spawn: (w, b, n, aims) => spawnTbm(w, n, b, aims),
    describe: (n) => `${n} short-range ballistic missiles`,
  },
  dark: {
    name: 'Airliner without transponder', cost: () => 0, minDay: 3, sectors: [2, 6],
    size: () => 1,
    spawn: (w) => spawnDarkAirliner(w),
    describe: () => 'a civil airliner crossing with its transponder off',
  },
};

export const SECTOR_NAMES = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const sectorOf = (bearing: number): number => Math.round((((bearing % 360) + 360) % 360) / 45) % 8;

/** A fresh enemy whose preferred axis is the map's mountain side (`rot`, deg). */
export function newEnemy(rot = 0, doctrine?: DoctrineId): EnemyModel {
  const rel = [1.3, 1, 1, 0.8, 0.8, 0.7, 0.9, 1];
  const k = sectorOf(rot);
  return {
    kindW: { drones: 1.4, decoys: 0.8, recon: 1, cruise: 1, strike: 1, sead: 1, soj: 0.8, bomber: 0.9, tbm: 1, dark: 0.5 },
    axisW: rel.map((_x, a) => rel[(a - k + 8) % 8]),
    doctrine,
  };
}

/** Threat points the enemy can spend on a given day. */
export const threatBudget = (day: number, scale = 1): number => (8 + day * 11.5) * scale;

/**
 * Build a day's raid plan from the enemy's budget and what it has learned. Package sectors are listed
 * relative to the enemy side of the map (sector 0 = the mountains, bearing `rot`).
 */
export function planDay(day: number, seed: number, enemy: EnemyModel, firstId: number, rot = 0, threatScale = 1, noDrones = false): PlannedPkg[] {
  const k = sectorOf(rot);
  const rng = new Rng(seed * 7919 + day * 104729);
  let budget = threatBudget(day, threatScale);
  const out: PlannedPkg[] = [];
  const kinds = (Object.keys(PKG) as PkgKind[]).filter((k) => day >= PKG[k].minDay && k !== 'dark' && !(noDrones && (k === 'drones' || k === 'decoys' || k === 'recon')));
  const doc = doctrineOf(enemy.doctrine);
  let guard = 0;
  while (budget > 2 && guard++ < 40) {
    const affordable = kinds.filter((k) => PKG[k].cost(PKG[k].size(day, rng)) <= budget + 2);
    if (!affordable.length) break;
    // Weighted pick of a kind, then of an approach sector that kind can use.
    // At most two decoy packages a day: they are there to thin out a real attack, not to be the attack.
    const decoys = out.filter((p) => p.kind === 'decoys').length;
    const recon = out.some((p) => p.kind === 'recon');
    const kind = pick(rng, affordable, (k) =>
      (k === 'decoys' && decoys >= 2) || (k === 'recon' && recon) ? 0 : enemy.kindW[k] * (doc?.bias[k] ?? 1) * ((enemy.suppressed?.[k] ?? 0) > 0 ? 0.25 : 1),
    );
    const def = PKG[kind];
    const sector = (pick(rng, def.sectors, (s) => enemy.axisW[(s + k) % 8] ** (doc?.axisFocus ?? 1)) + k) % 8;
    const bearing = (sector * 45 + rng.range(-18, 18) + 360) % 360;
    const size = def.size(day, rng);
    budget -= def.cost(size);
    out.push({ id: firstId + out.length, kind, bearing, size, t: 0, reported: false });
  }
  // Strike what yesterday's recon saw, radars first.
  const known = [...(enemy.known ?? [])].sort((a, b) => Number(/radar|SAM/.test(b.name)) - Number(/radar|SAM/.test(a.name)));
  if (known.length) {
    for (const p of out) {
      if ((p.kind === 'cruise' || p.kind === 'tbm' || p.kind === 'drones' || p.kind === 'strike') && rng.chance(0.65)) p.aims = known.slice(0, Math.max(1, p.size));
    }
  }
  if (day >= PKG.dark.minDay && rng.chance(0.45)) {
    out.push({ id: firstId + out.length, kind: 'dark', bearing: 270, size: 1, t: 0, reported: false });
  }
  // Waves: two or three packages each, a few minutes apart; jammers and SEAD lead their wave.
  const order = (k: PkgKind): number => (k === 'soj' ? 0 : k === 'sead' ? 1 : 2);
  const shuffled = out.map((p) => ({ p, r: rng.next() })).sort((a, b) => a.r - b.r).map((x) => x.p);
  const perWave = 2 + (day >= 6 ? 1 : 0);
  shuffled.forEach((p, i) => {
    const wave = Math.floor(i / perWave);
    p.t = Math.round(20 + wave * 270 + order(p.kind) * 15 + rng.range(0, 60));
    // Most packages are seen coming; intel misses more as the enemy grows more careful.
    // A kind of attack seen for the first time is always reported, so it is never a blind surprise.
    p.reported = rng.chance(Math.max(0.5, 0.9 - day * 0.03)) || day === PKG[p.kind].minDay;
  });
  return shuffled.sort((a, b) => a.t - b.t);
}

function pick<T>(rng: Rng, items: T[], weight: (x: T) => number): T {
  const total = items.reduce((s, x) => s + weight(x), 0);
  let r = rng.next() * total;
  for (const x of items) {
    r -= weight(x);
    if (r <= 0 && weight(x) > 0) return x;
  }
  return items.filter((x) => weight(x) > 0).pop() ?? items[items.length - 1];
}

/** Turn a plan into scenario raids the world can run. */
export function toRaids(plan: PlannedPkg[]): Raid[] {
  return plan.map((p) => {
    const def = PKG[p.kind];
    return {
      name: `${def.name} from the ${SECTOR_NAMES[sectorOf(p.bearing)]}`,
      desc: def.describe(p.size) + (p.aims ? ', aimed at our positions their recon photographed' : ''),
      t: p.t,
      launched: false,
      pkg: p.id,
      unreported: !p.reported,
      spawn: (w) => def.spawn(w, p.bearing, p.size, p.aims),
    };
  });
}
