export const DT = 1 / 60;
export const G = 9.80665;
export const DEG = Math.PI / 180;
export const RE_EFF = (6371000 * 4) / 3; // 4/3 earth radius for radar propagation
export const C_LIGHT = 299792458;
export const K_BOLTZ = 1.380649e-23;
export const T0 = 290;
export const FOUR_PI = 4 * Math.PI;

/** ISA-ish exponential atmosphere, kg/m^3. */
export function rho(alt: number): number {
  return 1.225 * Math.exp(-Math.max(0, alt) / 8500);
}

export const toDb = (x: number): number => 10 * Math.log10(Math.max(x, 1e-30));
export const fromDb = (d: number): number => Math.pow(10, d / 10);
