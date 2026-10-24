import { Rng } from './rng';
import type { Terrain } from './terrain';

/**
 * The enemy's side of the war: persistent installations, each with a stock of aircraft or munitions. Every
 * enemy weapon starts at one of them and flies the whole way in, nothing appears near our units, and what
 * we shoot down stays lost. Game-level numbers, not a real order of battle.
 */
export type Asset = 'strike' | 'sead' | 'recon' | 'helo' | 'drone' | 'cruise' | 'tbm' | 'bomber' | 'soj' | 'sam' | 'awacs' | 'tanker';
export type BaseKind = 'airfield' | 'farp' | 'drones' | 'tbm' | 'glcm' | 'rear' | 'sam';

export interface EnemyBase {
  id: string;
  kind: BaseKind;
  name: string;
  x: number;
  y: number;
  /** Aircraft on strength, or munitions left. Fractional while reinforcements trickle in. */
  stock: Partial<Record<Asset, number>>;
  /** Our intel has found it: it shows on the map and can be hit by a deep strike. */
  known: boolean;
  /** Overrun by our ground offensive, or written off: it launches nothing more. */
  lost?: boolean;
  /** The town it stands in, if any: taking the town overruns it. */
  town?: string;
  /** What it started the war with, for the order of battle's strength bars. */
  start?: Partial<Record<Asset, number>>;
}

/** Aircraft come back from a sortie unless shot down; munitions are used up when launched. */
export const AIRCRAFT: Asset[] = ['strike', 'sead', 'recon', 'helo', 'bomber', 'soj', 'awacs', 'tanker'];

/** Which kinds of installation launch each asset. */
export const HOSTS: Record<Asset, BaseKind[]> = {
  strike: ['airfield'], sead: ['airfield'], recon: ['airfield'], helo: ['farp'], drone: ['drones'],
  cruise: ['glcm'], tbm: ['tbm'], bomber: ['rear'], soj: ['rear'], sam: ['sam'], awacs: ['rear'], tanker: ['rear'],
};

const ASSET_NAMES: Record<Asset, [string, string]> = {
  strike: ['strike jet', 'strike jets'], sead: ['SEAD fighter', 'SEAD fighters'], recon: ['recon drone', 'recon drones'],
  helo: ['attack helicopter', 'attack helicopters'], drone: ['attack drone', 'attack drones'], cruise: ['cruise missile', 'cruise missiles'],
  tbm: ['ballistic missile', 'ballistic missiles'], bomber: ['bomber', 'bombers'], soj: ['stand-off jammer', 'stand-off jammers'], sam: ['SAM missile', 'SAM missiles'],
  awacs: ['AWACS', 'AWACS'], tanker: ['tanker', 'tankers'],
};

/** "3 strike jets", "1 bomber". */
export const assetCount = (a: Asset, n: number): string => `${n} ${ASSET_NAMES[a][n === 1 ? 0 : 1]}`;

/** What a base holds, in words: "6 strike jets, 4 SEAD fighters". */
export const stockText = (b: EnemyBase): string =>
  (Object.keys(b.stock) as Asset[]).map((a) => assetCount(a, avail(b, a))).join(', ') || 'nothing';

/** Which kind of enemy entity (World.tally) is which asset, for aircraft shot down. */
export const TALLY_ASSET: Record<string, Asset> = { strike: 'strike', sead: 'sead', recon: 'recon', helo: 'helo', bomber: 'bomber', soj: 'soj', awacs: 'awacs', tanker: 'tanker' };

interface BaseDef {
  name: string;
  /** Starting stock, at difficulty threat 1. */
  stock: Partial<Record<Asset, number>>;
  /** Reinforcements a day. */
  daily: Partial<Record<Asset, number>>;
  /** Known from the start: big fixed sites intel already has. */
  known: boolean;
}

export const BASE_DEFS: Record<BaseKind, BaseDef> = {
  airfield: { name: 'Forward airfield', stock: { strike: 8, sead: 4, recon: 3 }, daily: { strike: 1.5, sead: 0.8, recon: 1 }, known: true },
  farp: { name: 'Helicopter forward arming point', stock: { helo: 10 }, daily: { helo: 2.5 }, known: false },
  drones: { name: 'Drone launch team', stock: { drone: 22 }, daily: { drone: 10 }, known: false },
  tbm: { name: 'Ballistic missile launch area', stock: { tbm: 8 }, daily: { tbm: 2 }, known: false },
  glcm: { name: 'Cruise missile battery', stock: { cruise: 24 }, daily: { cruise: 9 }, known: false },
  sam: { name: 'SAM site', stock: { sam: 6 }, daily: { sam: 2 }, known: true },
  rear: { name: 'Rear air base (beyond the map)', stock: { bomber: 3, soj: 2, awacs: 1, tanker: 1 }, daily: { bomber: 0.4, soj: 0.3, awacs: 0.25, tanker: 0.25 }, known: true },
};

/** Stocks never grow past this multiple of the starting stock. */
const STOCK_CAP = 1.6;

/** The towns the theatre needs to know about: where they are and whose they are. */
export interface TheatreTown {
  name: string;
  x: number;
  y: number;
  ours: boolean;
  airfield?: boolean;
}

/** Nearest land to a local (u, v) spot, searching outwards; the spot itself if there is none (a launch barge). */
function landNear(t: Terrain, u: number, v: number): { x: number; y: number } {
  for (const r of [0, 3000, 6000, 10000, 15000, 22000]) {
    for (let a = 0; a < 360; a += r ? 45 : 360) {
      const uu = u + Math.sin((a * Math.PI) / 180) * r;
      const vv = Math.min(t.half - 6000, v + Math.cos((a * Math.PI) / 180) * r);
      const p = t.toWorld(uu, vv);
      if (Math.abs(p.x) > t.half - 3000 || Math.abs(p.y) > t.half - 3000) continue;
      if (!t.waterAt(p.x, p.y)) return { x: Math.round(p.x), y: Math.round(p.y) };
    }
  }
  const p = t.toWorld(u, v);
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

/** Lay out the enemy's installations for a map: in its towns, along its side of the front and in its rear. */
export function makeTheatre(t: Terrain, seed: number, towns: TheatreTown[] = [], threat = 1): EnemyBase[] {
  const rng = new Rng(seed * 4219 + 61);
  const out: EnemyBase[] = [];
  const add = (kind: BaseKind, p: { x: number; y: number }, suffix = '', town?: string): void => {
    const def = BASE_DEFS[kind];
    const stock: Partial<Record<Asset, number>> = {};
    for (const [k, n] of Object.entries(def.stock)) stock[k as Asset] = Math.round(n! * threat);
    const n = out.filter((b) => b.kind === kind).length + 1;
    out.push({ id: `${kind}${n}`, kind, name: `${def.name}${suffix}`, x: p.x, y: p.y, stock, start: { ...stock }, known: def.known, town });
  };
  const enemyTowns = towns.filter((x) => !x.ours);
  const lastV = Math.max(9000, ...towns.filter((x) => x.ours).map((x) => t.toLocal(x.x, x.y).v));
  const L = t.layout;
  // Across the water on a peninsula map, everything stands on the far shore.
  const minV = L.farShoreM ? L.farShoreM + 8000 : lastV + 20000;
  const airTown = towns.find((x) => x.airfield);
  add('airfield', airTown ?? landNear(t, rng.range(-10000, 10000), Math.max(minV + 25000, 100000)), '', airTown?.name);
  // Helicopters stage from the nearest enemy-held town short of the airfield.
  const farpTown = enemyTowns.find((x) => !x.airfield);
  // Across the water the far shore is too far for drones and helicopters: they come off ships out at sea.
  const sea = L.tipM && L.farShoreM ? (u: number, v: number): { x: number; y: number } => {
    const p = t.toWorld(u, v);
    return { x: Math.round(p.x), y: Math.round(p.y) };
  } : null;
  if (farpTown) add('farp', farpTown, ` at ${farpTown.name}`, farpTown.name);
  else if (sea) add('farp', sea(rng.range(-12000, 12000), L.tipM! + rng.range(40000, 50000)), ' (assault ship)');
  else add('farp', landNear(t, rng.range(-15000, 15000), Math.max(minV, 60000)));
  // Drone teams: one in each enemy-held town short of the airfield, and one on each flank.
  for (const tn of enemyTowns.filter((x) => !x.airfield)) add('drones', { x: tn.x, y: tn.y }, ` at ${tn.name}`, tn.name);
  for (const side of [-1, 1]) {
    const name = side < 0 ? 'left' : 'right';
    if (sea) add('drones', sea(side * rng.range(22000, 32000), L.tipM! + rng.range(28000, 38000)), ` (${name} launch ship)`);
    else add('drones', landNear(t, side * rng.range(30000, 42000), Math.max(minV, 55000) + rng.range(0, 10000)), ` (${name} flank)`);
  }
  // A SAM site with its radar in every town the enemy holds, a little off the town on its far side.
  for (const tn of enemyTowns) {
    const away = Math.atan2(tn.x, tn.y);
    add('sam', { x: Math.round(tn.x + Math.sin(away + 0.9) * 1800), y: Math.round(tn.y + Math.cos(away + 0.9) * 1800) }, ` at ${tn.name}`, tn.name);
  }
  for (const side of [-1, 1]) add('tbm', landNear(t, side * rng.range(20000, 35000), rng.range(118000, 135000)), side < 0 ? ' (west)' : ' (east)');
  add('glcm', landNear(t, rng.range(-15000, 15000), rng.range(105000, 120000)));
  // The rear air base is off the map: its aircraft enter along a corridor at the map edge.
  const edge = t.toWorld(rng.range(-25000, 25000), t.half - 2000);
  const rear = { bomber: Math.round(3 * threat), soj: Math.round(2 * threat), awacs: 1, tanker: 1 };
  out.push({ id: 'rear1', kind: 'rear', name: BASE_DEFS.rear.name, x: Math.round(edge.x), y: Math.round(edge.y), stock: rear, start: { ...rear }, known: true });
  return out;
}

/** Overnight: reinforcements arrive at every installation still in the war. */
export function reinforce(bases: EnemyBase[], threat = 1): void {
  for (const b of bases) {
    if (b.lost) continue;
    const def = BASE_DEFS[b.kind];
    for (const [k, n] of Object.entries(def.daily)) {
      const a = k as Asset;
      const cap = (def.stock[a] ?? 0) * threat * STOCK_CAP;
      b.stock[a] = Math.min(cap, (b.stock[a] ?? 0) + n! * threat);
    }
  }
}

/** Whole aircraft or munitions available at a base. */
export const avail = (b: EnemyBase, a: Asset): number => (b.lost ? 0 : Math.floor((b.stock[a] ?? 0) + 1e-6));

/** Installations with at least `n` of an asset, nearest to a point first. */
export function basesWith(bases: EnemyBase[], a: Asset, n = 1, near?: { x: number; y: number }): EnemyBase[] {
  const list = bases.filter((b) => avail(b, a) >= n);
  if (near) list.sort((p, q) => Math.hypot(p.x - near.x, p.y - near.y) - Math.hypot(q.x - near.x, q.y - near.y));
  return list;
}

/** Take `n` of an asset from a base (munitions launched, or aircraft lost). */
export function draw(b: EnemyBase, a: Asset, n: number): void {
  b.stock[a] = Math.max(0, (b.stock[a] ?? 0) - n);
}

/** Installations that can pack up and move: the launch teams and batteries, not the airfield. */
const MOBILE: BaseKind[] = ['drones', 'tbm', 'glcm', 'farp'];

/**
 * Our ground offensive took `town`: what stood in it is overrun. A drone team there is lost with its stock;
 * the helicopter arming point loses half its helicopters and falls back to `next`, the enemy's next town.
 */
export function overrun(bases: EnemyBase[], town: string, next?: TheatreTown): string[] {
  const lines: string[] = [];
  for (const b of bases) {
    if (b.lost || b.town !== town) continue;
    if (b.kind === 'farp' && next) {
      for (const a of Object.keys(b.stock) as Asset[]) b.stock[a] = Math.floor((b.stock[a] ?? 0) / 2);
      b.x = next.x;
      b.y = next.y;
      b.town = next.name;
      b.name = `${BASE_DEFS.farp.name} at ${next.name}`;
      lines.push(`The helicopter arming point at ${town} was overrun: half its helicopters were caught on the ground, and the rest fell back to ${next.name}.`);
    } else {
      b.lost = true;
      lines.push(`Our troops overran the ${b.name.toLowerCase()}: ${stockText(b)} lost to the enemy for good.`);
      b.stock = {};
    }
  }
  return lines;
}

/**
 * Mobile installations that find our ground creeping up on them pack up and move about 30 km further back,
 * and our intel loses them until they launch again.
 */
export function fallBack(t: Terrain, bases: EnemyBase[], zones: { x: number; y: number; r: number }[], margin = 10000): string[] {
  const lines: string[] = [];
  const close = (x: number, y: number): boolean => zones.some((z) => Math.hypot(x - z.x, y - z.y) < z.r + margin);
  for (const b of bases) {
    if (b.lost || !MOBILE.includes(b.kind) || b.town || !close(b.x, b.y)) continue;
    const { u, v } = t.toLocal(b.x, b.y);
    for (let back = 30000; back <= 90000; back += 15000) {
      const p = landNear(t, u, v + back);
      if (close(p.x, p.y)) continue;
      b.x = p.x;
      b.y = p.y;
      break;
    }
    if (b.known) lines.push(`The ${b.name.toLowerCase()} has pulled back out of reach of our ground forces; intel has lost it until it launches again.`);
    b.known = false;
  }
  return lines;
}
