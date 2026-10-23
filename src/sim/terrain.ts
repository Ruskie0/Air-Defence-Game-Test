import { RE_EFF } from './constants';
import { V3, clamp, lerp, smoothstep } from './math';

/** Centre-lines of the two mountain passes the cruise missiles use (x as a function of y). */
export const valleyX = (which: 0 | 1, y: number): number =>
  which === 0 ? -18000 + 7000 * Math.sin(y / 13000) : 22000 + 6000 * Math.sin(y / 11000 + 1);

/**
 * 160 x 160 km procedural heightmap centred on the defended area.
 * Plains around the airbase, a mountain belt to the north cut by two passes, sea to the south.
 */
export class Terrain {
  readonly half = 80000;
  readonly n = 321;
  readonly cell: number;
  readonly h: Float32Array;
  readonly rough: Float32Array;
  maxH = 0;
  private readonly seed: number;

  constructor(seed: number) {
    this.seed = seed | 0;
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

  private rawHeight(x: number, y: number): number {
    const base = this.fbm(x / 18000, y / 18000, 5, 1) * 260 + 40;
    const north = smoothstep(12000, 48000, y);
    const ridge = this.ridged(x / 21000, y / 13000, 6, 7);
    let mtn = north * (Math.pow(ridge, 1.5) * 2900 + this.fbm(x / 6000, y / 6000, 4, 3) * 450);
    const v0 = Math.exp(-Math.pow((x - valleyX(0, y)) / 3200, 2));
    const v1 = Math.exp(-Math.pow((x - valleyX(1, y)) / 3000, 2));
    mtn *= 1 - 0.88 * Math.max(v0, v1);
    let h = base + mtn;
    // Coastline to the south.
    const coast = smoothstep(-44000, -60000, y + 7000 * Math.sin(x / 19000) + 3000 * Math.sin(x / 5100));
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
