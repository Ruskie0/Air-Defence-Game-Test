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

/**
 * The shape of a map, in a local frame where +v points at the mountains (the enemy side) and +u to its
 * right. `rot` turns that frame onto the world: the bearing of the mountain side.
 */
export interface MapLayout {
  rot: number;
  /** Distance from the airbase to the coast on the far side from the mountains (m). */
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
}

/** The original map: mountains north, two passes, sea to the south. The sandbox is always fought here. */
export const CLASSIC_LAYOUT: MapLayout = {
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

/** A random map for a campaign: the threat axis, passes, coast and relief all vary with the seed. */
export function randomLayout(seed: number): MapLayout {
  const r = new Rng(seed * 9973 + 17);
  const u0 = r.range(-26000, -10000);
  return {
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

/** Centre-lines of the two passes of the classic map (local frame, x as a function of y). */
export const valleyX = (which: 0 | 1, y: number): number => passU(CLASSIC_LAYOUT.passes[which], y);

const passU = (p: PassShape, v: number): number => p.u0 + p.amp * Math.sin(v / p.wave + p.phase);

/**
 * 160 x 160 km procedural heightmap centred on the defended area.
 * Plains around the airbase, a mountain belt on the enemy side cut by two passes, sea on the far side.
 */
export class Terrain {
  readonly half = 80000;
  readonly n = 321;
  readonly cell: number;
  readonly h: Float32Array;
  readonly rough: Float32Array;
  maxH = 0;
  readonly seed: number;
  readonly layout: MapLayout;
  /** World-coordinate centre-lines of the passes, from the far end of the belt to the plain (500 m steps). */
  readonly valleys: { x: number; y: number }[][];
  private readonly cosR: number;
  private readonly sinR: number;

  constructor(seed: number, layout: MapLayout = CLASSIC_LAYOUT) {
    this.seed = seed | 0;
    this.layout = layout;
    const a = (layout.rot * Math.PI) / 180;
    // Exact for the classic map so its heights do not move by rounding.
    this.cosR = layout.rot === 0 ? 1 : Math.cos(a);
    this.sinR = layout.rot === 0 ? 0 : Math.sin(a);
    this.valleys = ([0, 1] as const).map((which) => {
      const pts: { x: number; y: number }[] = [];
      for (let v = 80000; v >= 9000; v -= 500) {
        const p = this.toWorld(this.passU(which, v), v);
        pts.push({ x: p.x, y: p.y });
      }
      return pts;
    });
    this.cell = (2 * this.half) / (this.n - 1);
    this.h = new Float32Array(this.n * this.n);
    this.rough = new Float32Array(this.n * this.n);
    this.generate();
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

  /** Does a bearing from the airbase point into the mountain belt (where the passes are)? */
  mountainSide(bearing: number): boolean {
    const d = (((bearing - this.layout.rot) % 360) + 540) % 360 - 180;
    return Math.abs(d) < 45;
  }

  /** Route down one pass, staying low in the valley, from local distance `fromV` towards the plain. */
  passRoute(which: 0 | 1, fromV: number): V3[] {
    const pts: V3[] = [];
    for (const v of [78000, 62000, 46000, 32000, 20000]) if (v < fromV) pts.push(this.toWorld(this.passU(which, v), v));
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
    // Coastline on the far side from the mountains.
    const coast = smoothstep(-L.coastM, -L.coastM - 16000, y + 7000 * Math.sin(x / 19000) + 3000 * Math.sin(x / 5100));
    h = lerp(h, -80, coast);
    // Flatten the defended plain around the airbase.
    const r = Math.hypot(x, y + 2000);
    const f = smoothstep(17000, 7000, r);
    h = lerp(h, 55 + base * 0.15, f);
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
