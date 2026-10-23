/** Small deterministic value noise for presentation-only detail (never used by the simulation). */

export function hash2(ix: number, iy: number, salt: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(salt, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function vnoise(x: number, y: number, salt: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, salt);
  const b = hash2(ix + 1, iy, salt);
  const c = hash2(ix, iy + 1, salt);
  const d = hash2(ix + 1, iy + 1, salt);
  const top = a + (b - a) * ux;
  return top + (c + (d - c) * ux - top) * uy;
}

export function fbm(x: number, y: number, oct: number, salt: number): number {
  let s = 0;
  let amp = 0.5;
  let f = 1;
  let norm = 0;
  for (let i = 0; i < oct; i++) {
    s += amp * vnoise(x * f, y * f, salt + i * 17);
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return s / norm;
}

/** Value noise that tiles with the given period (for repeating textures). */
export function tileNoise(x: number, y: number, period: number, salt: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const w = (i: number): number => ((i % period) + period) % period;
  const a = hash2(w(ix), w(iy), salt);
  const b = hash2(w(ix + 1), w(iy), salt);
  const c = hash2(w(ix), w(iy + 1), salt);
  const d = hash2(w(ix + 1), w(iy + 1), salt);
  const top = a + (b - a) * ux;
  return top + (c + (d - c) * ux - top) * uy;
}

/** Simple seeded PRNG (mulberry32) for scattering scenery. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
