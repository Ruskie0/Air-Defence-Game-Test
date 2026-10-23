import { RE_EFF } from './constants';
import { V3, clamp, lerp, smoothstep, v3 } from './math';
import { Rng } from './rng';

/** One mountain pass: its centre-line wanders about `u0` across the belt (local frame, metres). */
export interface PassShape {
  u0: number;
  amp: number;
  wave: number;
  phase: number;
  width: number;
}

export type MapType = 'mountain' | 'coastal' | 'peninsula' | 'lakes' | 'highlands';

export const MAP_TYPES: Record<MapType, { name: string; blurb: string }> = {
  mountain: { name: 'Mountain front', blurb: 'A defended plain under a high mountain belt cut by two passes, with the sea behind us.' },
  coastal: { name: 'Coastal plain', blurb: 'Open lowland along a coast: long radar views, and a sea flank for low-level attacks.' },
  peninsula: { name: 'Peninsula', blurb: 'A narrow peninsula with sea on three sides: everything comes in over the water.' },
  lakes: { name: 'Lake district', blurb: 'Rolling hills full of lakes that break up the ground and the radar horizon.' },
  highlands: { name: 'Highlands', blurb: 'A high basin ringed by rugged hills: short radar horizons and masked approaches everywhere.' },
};
export const MAP_TYPE_LIST = Object.keys(MAP_TYPES) as MapType[];

/** A defended asset's position on a map. */
export interface AssetSpot {
  name: string;
  x: number;
  y: number;
}

/**
 * The shape of a map, in a local frame where +v points at the enemy side and +u to its right. `rot`
 * turns that frame onto the world: the bearing of the enemy side (the mountains, on most maps).
 */
export interface MapLayout {
  /** 'legacy' reproduces the maps of saves from before map types. */
  type: MapType | 'legacy';
  rot: number;
  /** Distance from the airbase to the coast behind us, on the far side from the enemy (m). */
  coastM: number;
  /** Where the foothills start and where the belt reaches full height (m along v). */
  mtnFrom: number;
  mtnTo: number;
  mtnHeight: number;
  /** Horizontal and along-belt scales of the ridges (m). */
  ridgeU: number;
  ridgeV: number;
  /** Rolling relief of the lowlands (m). */
  hills: number;
  passes: [PassShape, PassShape];
  /** Height of the defended ground above sea level (m). */
  upland?: number;
  /** Ridged relief everywhere, not only in the belt (m). */
  rugged?: number;
  /** Radius of the flattened ground around the airbase (m). */
  plainR?: number;
  /** Lake coverage, 0..1. */
  lakes?: number;
  /** Sea on a flank: distance across the axis (m) and side (+1 right, -1 left, 0 both). */
  flankM?: number;
  flankSide?: -1 | 0 | 1;
  /** Peninsula: the land ends at tipM and the enemy shore starts at farShoreM (m along v). */
  tipM?: number;
  farShoreM?: number;
}

/** The original map: mountains north, two passes, sea to the south. */
export const CLASSIC_LAYOUT: MapLayout = {
  type: 'legacy',
  rot: 0,
  coastM: 44000,
  mtnFrom: 12000,
  mtnTo: 48000,
  mtnHeight: 2900,
  ridgeU: 21000,
  ridgeV: 13000,
  hills: 260,
  passes: [
    { u0: -18000, amp: 7000, wave: 13000, phase: 0, width: 3200 },
    { u0: 22000, amp: 6000, wave: 11000, phase: 1, width: 3000 },
  ],
};

/** Positions of the CRC and power plant on the original map (and in saves from before map types). */
export const CLASSIC_ASSETS: AssetSpot[] = [
  { name: 'Airbase', x: 0, y: 0 },
  { name: 'CRC', x: -4200, y: -3600 },
  { name: 'Power plant', x: 6500, y: -9000 },
];

/** Random maps of campaigns started before map types existed (kept so their saves load unchanged). */
export function legacyLayout(seed: number): MapLayout {
  const r = new Rng(seed * 9973 + 17);
  const u0 = r.range(-26000, -10000);
  return {
    type: 'legacy',
    rot: Math.round(r.range(0, 360) / 5) * 5,
    coastM: r.range(34000, 62000),
    mtnFrom: r.range(10000, 18000),
    mtnTo: r.range(40000, 58000),
    mtnHeight: r.range(2000, 3400),
    ridgeU: r.range(15000, 28000),
    ridgeV: r.range(10000, 17000),
    hills: r.range(180, 420),
    passes: [
      { u0, amp: r.range(3000, 8000), wave: r.range(9000, 16000), phase: r.range(0, 6.28), width: r.range(2600, 3600) },
      { u0: u0 + r.range(30000, 48000), amp: r.range(3000, 8000), wave: r.range(9000, 16000), phase: r.range(0, 6.28), width: r.range(2600, 3600) },
    ],
  };
}

/** The map type a seed gets when none is chosen. */
export const typeForSeed = (seed: number): MapType => MAP_TYPE_LIST[new Rng(seed * 7 + 3).int(0, MAP_TYPE_LIST.length - 1)];

/** A random map of the given type (or of a type picked from the seed). */
export function randomLayout(seed: number, type: MapType = typeForSeed(seed)): MapLayout {
  const r = new Rng(seed * 9973 + 17);
  const u0 = r.range(-30000, -12000);
  const pass = (u: number): PassShape => ({ u0: u, amp: r.range(3000, 9000), wave: r.range(9000, 18000), phase: r.range(0, 6.28), width: r.range(2600, 3800) });
  const passes: [PassShape, PassShape] = [pass(u0), pass(u0 + r.range(32000, 55000))];
  const L: MapLayout = {
    type,
    rot: Math.round(r.range(0, 360) / 5) * 5,
    coastM: r.range(40000, 75000),
    mtnFrom: r.range(12000, 22000),
    mtnTo: r.range(45000, 70000),
    mtnHeight: r.range(2200, 3500),
    ridgeU: r.range(15000, 30000),
    ridgeV: r.range(10000, 18000),
    hills: r.range(180, 420),
    passes,
    upland: 0,
    rugged: 0,
    plainR: r.range(6500, 8500),
    lakes: 0,
    flankM: 0,
    flankSide: 0,
  };
  switch (type) {
    case 'mountain':
      break;
    case 'coastal':
      // Lowland with a coast along one flank; a modest ridge far out on the enemy side.
      Object.assign(L, {
        hills: r.range(90, 200),
        mtnFrom: r.range(60000, 80000),
        mtnTo: r.range(100000, 125000),
        mtnHeight: r.range(900, 1700),
        coastM: 400000,
        flankM: r.range(16000, 28000),
        flankSide: r.chance(0.5) ? 1 : -1,
      });
      break;
    case 'peninsula':
      // Sea on both flanks and ahead; the enemy shore is across the water, with hills behind it.
      Object.assign(L, {
        hills: r.range(120, 260),
        plainR: r.range(5000, 6000),
        flankM: r.range(15000, 22000),
        flankSide: 0,
        tipM: r.range(28000, 45000),
        farShoreM: r.range(105000, 125000),
        coastM: 400000,
      });
      L.mtnFrom = L.farShoreM! + r.range(5000, 15000);
      L.mtnTo = L.mtnFrom + r.range(25000, 40000);
      L.mtnHeight = r.range(1400, 2400);
      break;
    case 'lakes':
      Object.assign(L, {
        hills: r.range(260, 420),
        lakes: r.range(0.55, 0.85),
        mtnFrom: r.range(40000, 60000),
        mtnTo: r.range(80000, 105000),
        mtnHeight: r.range(1600, 2400),
        coastM: r.range(100000, 130000),
      });
      break;
    case 'highlands':
      Object.assign(L, {
        upland: r.range(350, 600),
        rugged: r.range(500, 850),
        hills: r.range(250, 400),
        plainR: r.range(5000, 6500),
        mtnFrom: r.range(22000, 32000),
        mtnTo: r.range(55000, 75000),
        mtnHeight: r.range(2600, 3600),
        coastM: 400000,
      });
      break;
  }
  return L;
}

/** Centre-lines of the two passes of the classic map (local frame, x as a function of y). */
export const valleyX = (which: 0 | 1, y: number): number => passU(CLASSIC_LAYOUT.passes[which], y);

const passU = (p: PassShape, v: number): number => p.u0 + p.amp * Math.sin(v / p.wave + p.phase);

/**
 * 300 x 300 km procedural heightmap at 500 m, centred on the airbase. The layout decides what is where:
 * plains, a mountain belt on the enemy side cut by two passes, lakes, highlands, and the sea.
 */
export class Terrain {
  readonly half = 150000;
  readonly n = 601;
  readonly cell: number;
  readonly h: Float32Array;
  readonly rough: Float32Array;
  maxH = 0;
  readonly seed: number;
  readonly layout: MapLayout;
  /** Where the airbase, CRC and power plant stand on this map. */
  readonly assets: AssetSpot[];
  /** World-coordinate centre-lines of the passes, from the far end of the belt to the plain (500 m steps). */
  readonly valleys: { x: number; y: number }[][];
  private readonly cosR: number;
  private readonly sinR: number;

  /** `layout` may be a map type (a random map of that type for this seed) or a full layout. */
  constructor(seed: number, layout: MapLayout | MapType = CLASSIC_LAYOUT) {
    this.seed = seed | 0;
    this.layout = typeof layout === 'string' ? randomLayout(seed, layout) : layout;
    const a = (this.layout.rot * Math.PI) / 180;
    // Exact for the classic map so its heights do not move by rounding.
    this.cosR = this.layout.rot === 0 ? 1 : Math.cos(a);
    this.sinR = this.layout.rot === 0 ? 0 : Math.sin(a);
    const L = this.layout;
    const vTop = Math.min(this.half, L.mtnTo + 30000);
    const vEnd = L.type === 'legacy' ? 9000 : Math.max(9000, L.mtnFrom - 4000);
    this.valleys = ([0, 1] as const).map((which) => {
      const pts: { x: number; y: number }[] = [];
      for (let v = vTop; v >= vEnd; v -= 500) {
        const p = this.toWorld(this.passU(which, v), v);
        pts.push({ x: p.x, y: p.y });
      }
      return pts;
    });
    this.cell = (2 * this.half) / (this.n - 1);
    this.h = new Float32Array(this.n * this.n);
    this.rough = new Float32Array(this.n * this.n);
    this.generate();
    this.assets = L.type === 'legacy' ? CLASSIC_ASSETS.map((x) => ({ ...x })) : this.placeAssets();
  }

  get typeName(): string {
    return this.layout.type === 'legacy' ? MAP_TYPES.mountain.name : MAP_TYPES[this.layout.type].name;
  }

  asset(name: string): AssetSpot {
    return this.assets.find((a) => a.name === name) ?? { name, x: 0, y: 0 };
  }

  /** Level, dry ground? */
  buildable(x: number, y: number, maxSlope = 90): boolean {
    if (this.groundAt(x, y) < 3 || this.heightAt(x, y) < 3) return false;
    const slope = Math.abs(this.groundAt(x + 150, y) - this.groundAt(x - 150, y)) + Math.abs(this.groundAt(x, y + 150) - this.groundAt(x, y - 150));
    return slope <= maxSlope;
  }

  /** Distance (m) from (x, y) to the nearest water within `maxR`, or Infinity. */
  waterDist(x: number, y: number, maxR: number): number {
    for (let r = 500; r <= maxR; r += 500) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        if (this.heightAt(x + Math.sin(a) * r, y + Math.cos(a) * r) < 0) return r;
      }
    }
    return Infinity;
  }

  /** The CRC and the power plant go somewhere different on every map: on level, dry ground near the airbase. */
  private placeAssets(): AssetSpot[] {
    const r = new Rng(this.seed * 131 + 977);
    const out: AssetSpot[] = [{ name: 'Airbase', x: 0, y: 0 }];
    const spot = (rMin: number, rMax: number, score: (x: number, y: number) => number): AssetSpot => {
      let best: { x: number; y: number; s: number } | null = null;
      for (let i = 0; i < 80; i++) {
        const a = r.range(0, Math.PI * 2);
        const d = r.range(rMin, rMax);
        const x = Math.round(Math.sin(a) * d);
        const y = Math.round(Math.cos(a) * d);
        if (!this.buildable(x, y, 60)) continue;
        if (out.some((o) => Math.hypot(o.x - x, o.y - y) < 2500)) continue;
        const s = score(x, y) + r.next();
        if (!best || s > best.s) best = { x, y, s };
      }
      return best ? { name: '', x: best.x, y: best.y } : { name: '', x: Math.round(rMin), y: -Math.round(rMin) };
    };
    // The CRC sits back from the enemy side; the power plant wants cooling water if there is any nearby.
    const back = (x: number, y: number): number => -this.toLocal(x, y).v / 8000;
    out.push({ ...spot(3500, 8000, back), name: 'CRC' });
    out.push({ ...spot(6000, 15000, (x, y) => (this.waterDist(x, y, 5000) < Infinity ? 1.5 : 0) + back(x, y) * 0.5), name: 'Power plant' });
    return out;
  }

  /** A short description of the ground for the briefing. */
  describe(): string {
    const L = this.layout;
    const names = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
    const dir = (b: number): string => names[Math.round((((b % 360) + 360) % 360) / 45) % 8];
    const km = (m: number): number => Math.round(m / 1000);
    const enemy = dir(L.rot);
    const plant = this.asset('Power plant');
    const crc = this.asset('CRC');
    const where = (a: AssetSpot): string => `${(Math.hypot(a.x, a.y) / 1000).toFixed(0)} km ${dir((Math.atan2(a.x, a.y) * 180) / Math.PI)}`;
    const assets = `The CRC is ${where(crc)} of the airbase and the power plant ${where(plant)}.`;
    switch (L.type) {
      case 'legacy':
      case 'mountain':
        return `${this.typeName}. The enemy is beyond the mountains to the ${enemy}, which two passes cut through towards us, starting about ${km(L.mtnFrom)} km out. The coast is about ${km(L.coastM)} km to the ${dir(L.rot + 180)}. Expect low-level attacks down the passes and in from the sea. ${assets}`;
      case 'coastal':
        return `${this.typeName}. Open, low ground with long radar views to the ${enemy}, where the enemy is; a low ridge rises about ${km(L.mtnFrom)} km out. The sea is ${km(L.flankM!)} km to the ${dir(L.rot + 90 * (L.flankSide || 1))}: expect sea-skimming cruise missiles up the coast. ${assets}`;
      case 'peninsula':
        return `${this.typeName}. We hold a peninsula with the sea ${km(L.flankM!)} km away on both flanks. The land ends ${km(L.tipM!)} km to the ${enemy}, and the enemy shore is ${km(L.farShoreM!)} km out across the water. Everything arrives over the sea, low and unmasked, but from many directions. ${assets}`;
      case 'lakes':
        return `${this.typeName}. Rolling hills and lakes around the airbase limit where units can stand and mask low flyers. Mountains rise about ${km(L.mtnFrom)} km to the ${enemy}, with two passes through them. ${assets}`;
      case 'highlands':
        return `${this.typeName}. The airbase sits in a basin about ${Math.round(L.upland! + 55)} m up, ringed by rugged hills that cut radar horizons short in every direction. Higher mountains start about ${km(L.mtnFrom)} km to the ${enemy}. Put sensors on high ground. ${assets}`;
    }
  }

  private hash(ix: number, iy: number, salt: number): number {
    let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(this.seed + salt, 1442695041)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  private vnoise(x: number, y: number, salt: number): number {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const a = this.hash(ix, iy, salt);
    const b = this.hash(ix + 1, iy, salt);
    const c = this.hash(ix, iy + 1, salt);
    const d = this.hash(ix + 1, iy + 1, salt);
    return lerp(lerp(a, b, ux), lerp(c, d, ux), uy);
  }

  private fbm(x: number, y: number, oct: number, salt: number): number {
    let s = 0;
    let amp = 0.5;
    let f = 1;
    let norm = 0;
    for (let i = 0; i < oct; i++) {
      s += amp * this.vnoise(x * f, y * f, salt + i * 17);
      norm += amp;
      amp *= 0.5;
      f *= 2.03;
    }
    return s / norm;
  }

  private ridged(x: number, y: number, oct: number, salt: number): number {
    let s = 0;
    let amp = 0.5;
    let f = 1;
    let norm = 0;
    for (let i = 0; i < oct; i++) {
      const n = 1 - Math.abs(2 * this.vnoise(x * f, y * f, salt + i * 31) - 1);
      s += amp * n * n;
      norm += amp;
      amp *= 0.5;
      f *= 2.1;
    }
    return s / norm;
  }

  // ------------------------------------------------------------- layout frame

  /** World point from local (u across the threat axis, v towards the mountains). */
  toWorld(u: number, v: number, z = 0): V3 {
    return v3(u * this.cosR + v * this.sinR, -u * this.sinR + v * this.cosR, z);
  }

  /** Local (u, v) of a world point. */
  toLocal(x: number, y: number): { u: number; v: number } {
    return { u: x * this.cosR - y * this.sinR, v: x * this.sinR + y * this.cosR };
  }

  /** Pass centre-line, local frame: u as a function of v. */
  passU(which: 0 | 1, v: number): number {
    return passU(this.layout.passes[which], v);
  }

  /** Does a bearing from the airbase point into a mountain belt that low flyers would use the passes through? */
  mountainSide(bearing: number): boolean {
    const L = this.layout;
    if (L.tipM || L.mtnHeight < 1200 || L.mtnFrom > 70000) return false;
    const d = (((bearing - L.rot) % 360) + 540) % 360 - 180;
    return Math.abs(d) < 45;
  }

  /** Route down one pass, staying low in the valley, from local distance `fromV` towards the plain. */
  passRoute(which: 0 | 1, fromV: number): V3[] {
    const L = this.layout;
    const pts: V3[] = [];
    const vs = L.type === 'legacy' ? [78000, 62000, 46000, 32000, 20000] : [L.mtnTo + 20000, L.mtnTo, (L.mtnFrom + L.mtnTo) / 2, L.mtnFrom, L.mtnFrom * 0.6];
    for (const v of vs) if (v < fromV) pts.push(this.toWorld(this.passU(which, v), v));
    return pts;
  }

  waterAt(x: number, y: number): boolean {
    return this.heightAt(x, y) < 0;
  }

  private rawHeight(wx: number, wy: number): number {
    const L = this.layout;
    const { u: x, v: y } = this.toLocal(wx, wy);
    const base = this.fbm(x / 18000, y / 18000, 5, 1) * L.hills + 40;
    const north = smoothstep(L.mtnFrom, L.mtnTo, y);
    const ridge = this.ridged(x / L.ridgeU, y / L.ridgeV, 6, 7);
    let mtn = north * (Math.pow(ridge, 1.5) * L.mtnHeight + this.fbm(x / 6000, y / 6000, 4, 3) * 450);
    const p0 = L.passes[0];
    const p1 = L.passes[1];
    const v0 = Math.exp(-Math.pow((x - passU(p0, y)) / p0.width, 2));
    const v1 = Math.exp(-Math.pow((x - passU(p1, y)) / p1.width, 2));
    mtn *= 1 - 0.88 * Math.max(v0, v1);
    let h = base + mtn;
    if (L.rugged) {
      // Highland relief everywhere, also cut by the valleys.
      const rr = this.ridged(x / 9000, y / 9000, 5, 21);
      h += (L.upland ?? 0) + Math.pow(rr, 1.7) * L.rugged * (1 - 0.7 * Math.max(v0, v1));
    }
    // Coastline on the far side from the enemy.
    const coast = smoothstep(-L.coastM, -L.coastM - 16000, y + 7000 * Math.sin(x / 19000) + 3000 * Math.sin(x / 5100));
    h = lerp(h, -80, coast);
    if (L.lakes) {
      // Long glacial lakes in the lowland valleys, none up in the mountains.
      const n = this.fbm(x / 6000 + y / 30000, y / 16000, 4, 41);
      const thr = 0.7 - 0.07 * L.lakes;
      h = lerp(h, -12, smoothstep(thr, thr + 0.02, n) * (1 - north) * (h < 260 + L.hills * 0.6 ? 1 : 0.3));
    }
    // Flatten the defended plain around the airbase.
    const pr = L.plainR ?? 7000;
    const r = Math.hypot(x, y + 2000);
    const f = smoothstep(pr * 2.4, pr, r);
    h = lerp(h, (L.upland ?? 0) + 55 + base * 0.15, f);
    if (L.flankM) {
      // Sea along one or both flanks, its shore wandering a few kilometres.
      const wob = 3500 * Math.sin(y / 13000 + 1.3) + 1500 * Math.sin(y / 4300);
      const side = L.flankSide ?? 0;
      const d = side === 0 ? Math.abs(x) : side * x;
      let width = L.flankM;
      // A peninsula widens into the mainland behind us.
      if (L.tipM) width += smoothstep(-40000, -75000, y) * 200000;
      let sea = smoothstep(width + wob, width + wob + 5000, d);
      if (L.tipM && L.farShoreM) {
        // Open water beyond the tip until the enemy shore.
        const tip = smoothstep(L.tipM - 3000, L.tipM + 3000, y + 0.15 * Math.abs(x) + 2500 * Math.sin(x / 7000)) * smoothstep(L.farShoreM + 3000, L.farShoreM - 3000, y + 4000 * Math.sin(x / 15000));
        sea = Math.max(sea, tip);
        if (y > L.farShoreM - 3000) sea *= smoothstep(L.farShoreM + 3000, L.farShoreM - 3000, y + 4000 * Math.sin(x / 15000));
      }
      h = lerp(h, -60, sea);
    }
    return h;
  }

  private generate(): void {
    const { n, half, cell } = this;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const h = this.rawHeight(-half + i * cell, -half + j * cell);
        this.h[j * n + i] = h;
        if (h > this.maxH) this.maxH = h;
      }
    }
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        let lo = Infinity;
        let hi = -Infinity;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const v = this.h[clamp(j + dj, 0, n - 1) * n + clamp(i + di, 0, n - 1)];
            lo = Math.min(lo, v);
            hi = Math.max(hi, v);
          }
        }
        // Local relief, used as a clutter roughness factor (0 = sea/flat, ~3 = steep mountains).
        this.rough[j * n + i] = this.h[j * n + i] <= 0 ? 0.1 : clamp((hi - lo) / 150, 0.2, 3);
      }
    }
  }

  /** Terrain height (m ASL, sea floor is negative) by bilinear interpolation; clamps outside the map. */
  heightAt(x: number, y: number): number {
    const { n, half, cell } = this;
    const gx = clamp((x + half) / cell, 0, n - 1.0001);
    const gy = clamp((y + half) / cell, 0, n - 1.0001);
    const i = Math.floor(gx);
    const j = Math.floor(gy);
    const fx = gx - i;
    const fy = gy - j;
    const k = j * n + i;
    const a = this.h[k];
    const b = this.h[k + 1];
    const c = this.h[k + n];
    const d = this.h[k + n + 1];
    return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
  }

  /** Ground or sea surface height. */
  groundAt(x: number, y: number): number {
    return Math.max(0, this.heightAt(x, y));
  }

  roughAt(x: number, y: number): number {
    const { n, half, cell } = this;
    const i = clamp(Math.round((x + half) / cell), 0, n - 1);
    const j = clamp(Math.round((y + half) / cell), 0, n - 1);
    return this.rough[j * n + i];
  }

  /**
   * Line of sight over terrain with a 4/3-earth bulge: the effective obstacle height at a point d1 from A
   * and d2 from B is terrain + d1*d2 / (2 * Re_eff).
   */
  los(a: V3, b: V3): boolean {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const D = Math.hypot(dx, dy);
    if (D < 1) return true;
    const bulgeMax = (D * D) / (8 * RE_EFF);
    if (Math.min(a.z, b.z) > this.maxH + bulgeMax + 5) return true;
    const steps = Math.min(600, Math.ceil(D / 280));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const d1 = D * t;
      const ray = a.z + (b.z - a.z) * t;
      const ground = this.groundAt(a.x + dx * t, a.y + dy * t) + (d1 * (D - d1)) / (2 * RE_EFF);
      if (ground > ray) return false;
    }
    return true;
  }
}
