import { DEG } from './constants';

export interface V3 {
  x: number;
  y: number;
  z: number;
}

// Sim frame: x = east, y = north, z = up (metres, z is altitude above sea level).
export const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
export const clone = (a: V3): V3 => ({ x: a.x, y: a.y, z: a.z });
export const add = (a: V3, b: V3): V3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a: V3, b: V3): V3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (a: V3, s: number): V3 => v3(a.x * s, a.y * s, a.z * s);
export const addScaled = (a: V3, b: V3, s: number): V3 => v3(a.x + b.x * s, a.y + b.y * s, a.z + b.z * s);
export const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: V3, b: V3): V3 => v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const len2 = (a: V3): number => a.x * a.x + a.y * a.y + a.z * a.z;
export const len = (a: V3): number => Math.sqrt(len2(a));
export const dist = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const hdist = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.y - b.y);
export const norm = (a: V3): V3 => {
  const l = len(a);
  return l > 1e-9 ? scale(a, 1 / l) : v3(0, 1, 0);
};
export const copyTo = (out: V3, a: V3): V3 => {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
};

export const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Wrap an angle in degrees to (-180, 180]. */
export const wrap180 = (d: number): number => {
  d = ((d + 180) % 360 + 360) % 360 - 180;
  return d === -180 ? 180 : d;
};
export const wrap360 = (d: number): number => ((d % 360) + 360) % 360;

/** Compass bearing from a to b in degrees (0 = north, clockwise). */
export const bearingDeg = (a: V3, b: V3): number => wrap360(Math.atan2(b.x - a.x, b.y - a.y) / DEG);
export const elevDeg = (a: V3, b: V3): number => Math.atan2(b.z - a.z, hdist(a, b)) / DEG;
export const dirAzEl = (azDeg: number, elDeg: number): V3 => {
  const a = azDeg * DEG;
  const e = elDeg * DEG;
  return v3(Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e));
};
export const headingOf = (v: V3): number => wrap360(Math.atan2(v.x, v.y) / DEG);
export const polar = (bearing: number, rangeM: number, z = 0): V3 =>
  v3(Math.sin(bearing * DEG) * rangeM, Math.cos(bearing * DEG) * rangeM, z);
/** Angle between two vectors in degrees. */
export const angleBetween = (a: V3, b: V3): number => {
  const la = len(a);
  const lb = len(b);
  if (la < 1e-9 || lb < 1e-9) return 0;
  return Math.acos(clamp(dot(a, b) / (la * lb), -1, 1)) / DEG;
};
