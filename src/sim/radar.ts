import { C_LIGHT, DEG, FOUR_PI, K_BOLTZ, T0, fromDb, toDb } from './constants';
import { V3, addScaled, bearingDeg, clone, dirAzEl, dist, dot, elevDeg, norm, sub, v3, wrap180, wrap360 } from './math';
import type { Emitter, Entity } from './entities';
import type { World } from './world';

export type ScanSpec =
  | { kind: 'rotating'; rpm: number }
  | { kind: 'sector'; halfWidthDeg: number; frameS: number; trackHz: number };

export interface RadarSpec {
  freqGHz: number;
  peakKW: number;
  gainDb: number;
  bwMHz: number;
  nfDb: number;
  lossDb: number;
  /** Pulses coherently integrated per look. */
  nPulses: number;
  bwAzDeg: number;
  bwElDeg: number;
  /** Average sidelobe level relative to the main beam peak (negative dB). */
  sllDb: number;
  /** Sidelobe canceller attenuation applied to jamming entering through sidelobes. */
  slcDb: number;
  maxRangeKm: number;
  minElDeg: number;
  maxElDeg: number;
  scan: ScanSpec;
  /** MTI / pulse-Doppler clutter improvement factor. */
  mtiDb: number;
  /** Radial speed below which a target in clutter falls into the zero-Doppler notch. */
  notchMps: number;
  /** Clutter-to-noise ratio at 10 km over flat terrain, before MTI. */
  cnr10Db: number;
  rangeAccM: number;
  angleAccDeg: number;
  pfa: number;
  iff: boolean;
  falseAlarmsPerScan: number;
}

export interface Report {
  sensor: string;
  t: number;
  pos: V3;
  /** Overall 1-sigma position error (m), used for gating. */
  sigma: number;
  /** Per-axis 1-sigma errors (m): horizontal (worst of range and cross-range) and vertical. */
  sigmaH: number;
  sigmaZ: number;
  sinr: number;
  rcs: number;
  iff: 'M5' | 'M3C' | 'NONE' | null;
  /** Ground truth, kept only for sensor-local bookkeeping. Fusion never reads it. */
  truth: Entity | null;
}

export interface Strobe {
  sensor: string;
  origin: V3;
  az: number;
  /** 1-sigma bearing error (deg). */
  sigmaDeg: number;
  jnrDb: number;
  t: number;
}

export class Radar implements Emitter {
  readonly code: string;
  readonly name: string;
  readonly spec: RadarSpec;
  readonly signature: Emitter['signature'];
  pos: V3;
  alive = true;
  emitting = true;
  /** Current beam azimuth (deg). */
  az = 0;
  /** Sector boresight for phased arrays / airborne radars (deg). */
  boresight = 0;
  platform: Entity | null = null;
  readonly lambda: number;
  readonly g0: number;
  readonly noiseW: number;
  private readonly kRadar: number;
  private readonly sll: number;
  private readonly slc: number;
  /** Entity id -> last detection time by this radar (sensor-level firm tracks). */
  readonly firm = new Map<number, number>();
  private readonly lastDwell = new Map<number, number>();
  private readonly jamLosCache = new Map<number, { t: number; ok: boolean }>();
  strobes: Strobe[] = [];
  /** Worst sidelobe jam-to-noise ratio (dB), for the HUD. */
  sideJnrDb = -99;
  private nextJnr = 0;
  private sectorProg = 0;

  constructor(code: string, name: string, spec: RadarSpec, pos: V3, signature: Emitter['signature']) {
    this.code = code;
    this.name = name;
    this.spec = spec;
    this.pos = clone(pos);
    this.signature = signature;
    this.lambda = C_LIGHT / (spec.freqGHz * 1e9);
    this.g0 = fromDb(spec.gainDb);
    this.noiseW = K_BOLTZ * T0 * spec.bwMHz * 1e6 * fromDb(spec.nfDb);
    // Radar range equation constant: S = K * sigma / R^4.
    this.kRadar =
      (spec.peakKW * 1e3 * this.g0 * this.g0 * this.lambda * this.lambda * spec.nPulses) /
      (FOUR_PI * FOUR_PI * FOUR_PI * fromDb(spec.lossDb));
    this.sll = fromDb(spec.sllDb);
    this.slc = fromDb(-spec.slcDb);
  }

  isEmitting(): boolean {
    if (!this.alive || !this.emitting) return false;
    return !this.platform || (this.platform.alive && this.platform.airborne);
  }

  get period(): number {
    return this.spec.scan.kind === 'rotating' ? 60 / this.spec.scan.rpm : this.spec.scan.frameS;
  }

  /** Range (m) at which a target of `rcs` gives `snrDb` with no jamming or clutter. */
  rangeFor(rcs: number, snrDb = 13): number {
    return Math.pow((this.kRadar * rcs) / (this.noiseW * fromDb(snrDb)), 0.25);
  }

  /** Two-way-independent receive pattern relative to boresight, floored at the sidelobe level. */
  pattern(dAz: number, dEl: number): number {
    const a = dAz / this.spec.bwAzDeg;
    const e = dEl / this.spec.bwElDeg;
    return Math.max(this.sll, Math.exp(-2.776 * (a * a + e * e)));
  }

  private jamLos(w: World, e: Entity): boolean {
    const c = this.jamLosCache.get(e.id);
    if (c && w.t - c.t < 1) return c.ok;
    const ok = w.terrain.los(this.pos, e.pos);
    this.jamLosCache.set(e.id, { t: w.t, ok });
    return ok;
  }

  /** Received noise-jamming power (W) with the beam pointed at (az, el). */
  jamming(w: World, az: number, el: number, mainOnly?: Entity): number {
    let J = 0;
    for (const e of w.jammers()) {
      if (mainOnly && e !== mainOnly) continue;
      const jm = e.jammer!;
      if (this.spec.freqGHz < jm.loGHz || this.spec.freqGHz > jm.hiGHz) continue;
      if (!this.jamLos(w, e)) continue;
      const rj = dist(this.pos, e.pos);
      let g = this.pattern(wrap180(bearingDeg(this.pos, e.pos) - az), elevDeg(this.pos, e.pos) - el);
      if (g <= this.sll * 1.0001) g *= this.slc;
      J += (jm.erpW * Math.min(1, this.spec.bwMHz / jm.bwMHz) * this.g0 * g * this.lambda * this.lambda) / (FOUR_PI * FOUR_PI * rj * rj);
    }
    return J;
  }

  private clutter(w: World, e: Entity, R: number): number {
    const gnd = w.terrain.groundAt(e.pos.x, e.pos.y);
    const agl = e.pos.z - gnd;
    const footprint = R * Math.tan((this.spec.bwElDeg / 2) * DEG) + 30;
    if (agl > footprint) return 0;
    const rough = w.terrain.roughAt(e.pos.x, e.pos.y);
    const cnrDb = this.spec.cnr10Db + 20 * Math.log10(rough) - 30 * Math.log10(Math.max(R, 500) / 10000) - this.spec.mtiDb;
    return this.noiseW * fromDb(cnrDb);
  }

  private inSector(az: number): number | null {
    if (this.spec.scan.kind !== 'sector') return 0;
    const off = wrap180(az - this.boresight);
    return Math.abs(off) <= this.spec.scan.halfWidthDeg ? off : null;
  }

  /** One dwell on entity e. Returns true on detection. */
  private look(w: World, e: Entity, out: Report[]): boolean {
    const R = dist(this.pos, e.pos);
    if (R > this.spec.maxRangeKm * 1000 || R < 50) return false;
    const el = elevDeg(this.pos, e.pos);
    if (el < this.spec.minElDeg || el > this.spec.maxElDeg) return false;
    const az = bearingDeg(this.pos, e.pos);
    const off = this.inSector(az);
    if (off === null) return false;
    if (!w.terrain.los(this.pos, e.pos)) return false;
    // Phased-array scan loss, two-way.
    const scanLoss = this.spec.scan.kind === 'sector' ? Math.pow(Math.cos(off * DEG), 2.5) : 1;
    const S = (this.kRadar * scanLoss * e.rcs) / (R * R * R * R);
    const J = this.jamming(w, az, el);
    const C = this.clutter(w, e, R);
    let sinr = S / (this.noiseW + J + C);
    if (C > 0) {
      const platVel = this.platform ? this.platform.vel : v3();
      const vr = dot(sub(e.vel, platVel), norm(sub(e.pos, this.pos)));
      if (Math.abs(vr) < this.spec.notchMps) sinr *= 0.003;
    }
    // Swerling 1: Pd = Pfa^(1 / (1 + SNR)).
    const pd = Math.pow(this.spec.pfa, 1 / (1 + sinr));
    if (!w.rng.chance(pd)) return false;

    const sR = this.spec.rangeAccM + 150 / Math.sqrt(2 * sinr);
    const sA = (this.spec.bwAzDeg / (1.6 * Math.sqrt(2 * sinr)) + this.spec.angleAccDeg) * DEG;
    const sE = (this.spec.bwElDeg / (1.6 * Math.sqrt(2 * sinr)) + this.spec.angleAccDeg) * DEG;
    const Rm = R + w.rng.gauss() * sR;
    const azm = az + (w.rng.gauss() * sA) / DEG;
    const elm = el + (w.rng.gauss() * sE) / DEG;
    let iff: Report['iff'] = null;
    if (this.spec.iff) {
      if (e.iff === 'M5') iff = w.rng.chance(0.97) ? 'M5' : 'NONE';
      else if (e.iff === 'M3C') iff = w.rng.chance(0.95) ? 'M3C' : 'NONE';
      else iff = 'NONE';
    }
    out.push({
      sensor: this.code,
      t: w.t,
      pos: addScaled(this.pos, dirAzEl(azm, elm), Rm),
      sigma: Math.hypot(sR, R * sA, R * sE * 0.5),
      sigmaH: Math.max(sR, R * sA),
      sigmaZ: Math.hypot(R * sE, sR * Math.sin(el * DEG)),
      sinr,
      rcs: e.rcs * w.rng.exp(),
      iff,
      truth: e,
    });
    e.lastDetected = w.t;
    this.firm.set(e.id, w.t);
    return true;
  }

  private strobeCheck(w: World, e: Entity): void {
    const jm = e.jammer!;
    if (this.spec.freqGHz < jm.loGHz || this.spec.freqGHz > jm.hiGHz) return;
    const az = bearingDeg(this.pos, e.pos);
    if (this.inSector(az) === null) return;
    const J = this.jamming(w, az, elevDeg(this.pos, e.pos), e);
    const jnr = toDb(J / this.noiseW);
    if (jnr < 10) return;
    this.strobes = this.strobes.filter((s) => Math.abs(wrap180(s.az - az)) > 3 * this.spec.bwAzDeg);
    const sigmaDeg = this.spec.bwAzDeg * 0.15;
    this.strobes.push({
      sensor: this.code,
      origin: clone(this.pos),
      az: wrap360(az + w.rng.gauss() * sigmaDeg),
      sigmaDeg,
      jnrDb: jnr,
      t: w.t,
    });
  }

  private falseAlarms(w: World, out: Report[]): void {
    const n = w.rng.poisson(this.spec.falseAlarmsPerScan);
    for (let i = 0; i < n; i++) {
      const R = w.rng.range(4000, this.spec.maxRangeKm * 1000);
      const half = this.spec.scan.kind === 'sector' ? this.spec.scan.halfWidthDeg : 180;
      const az = this.boresight + w.rng.range(-half, half);
      const p = addScaled(this.pos, dirAzEl(az, 0), R);
      p.z = w.terrain.groundAt(p.x, p.y) + w.rng.range(60, 3000);
      out.push({ sensor: this.code, t: w.t, pos: p, sigma: 300, sigmaH: 300, sigmaZ: 300, sinr: 12, rcs: w.rng.range(0.05, 2), iff: this.spec.iff ? 'NONE' : null, truth: null });
    }
  }

  step(w: World, dt: number, out: Report[]): void {
    if (this.platform) {
      this.pos = clone(this.platform.pos);
      this.boresight = bearingDeg(v3(), this.platform.vel);
    }
    if (!this.isEmitting()) {
      this.strobes = [];
      this.firm.clear();
      return;
    }
    const sc = this.spec.scan;
    let prev: number;
    let width: number;
    let wrapped = false;
    if (sc.kind === 'rotating') {
      prev = this.az;
      width = sc.rpm * 6 * dt;
      this.az = wrap360(this.az + width);
      wrapped = this.az < prev;
    } else {
      const p0 = this.sectorProg;
      this.sectorProg += dt / sc.frameS;
      if (this.sectorProg >= 1) {
        this.sectorProg -= 1;
        wrapped = true;
      }
      prev = wrap360(this.boresight - sc.halfWidthDeg + p0 * 2 * sc.halfWidthDeg);
      width = (2 * sc.halfWidthDeg * dt) / sc.frameS;
      this.az = wrap360(this.boresight - sc.halfWidthDeg + this.sectorProg * 2 * sc.halfWidthDeg);
    }
    const swept = (b: number): boolean => wrap360(b - prev) < width;

    for (const e of w.entities) {
      if (!e.alive || !e.airborne || e === this.platform) continue;
      const b = bearingDeg(this.pos, e.pos);
      if (swept(b)) {
        this.look(w, e, out);
      } else if (sc.kind === 'sector') {
        // Phased array: revisit sensor-level firm tracks at the track rate between search dwells.
        const last = this.firm.get(e.id);
        if (last !== undefined && w.t - last < 4) {
          const ld = this.lastDwell.get(e.id) ?? -1e9;
          if (w.t - ld >= 1 / sc.trackHz) {
            this.lastDwell.set(e.id, w.t);
            this.look(w, e, out);
          }
        }
      }
      if (e.jammer && e.jammer.active && swept(b)) this.strobeCheck(w, e);
    }
    if (wrapped) this.falseAlarms(w, out);
    const keep = this.period * 1.6;
    this.strobes = this.strobes.filter((s) => w.t - s.t < keep);
    for (const [id, t] of this.firm) if (w.t - t > 8) this.firm.delete(id);

    if (w.t >= this.nextJnr) {
      this.nextJnr = w.t + 1;
      let worst = 0;
      for (const e of w.jammers()) {
        const off = bearingDeg(this.pos, e.pos) + 90;
        worst = Math.max(worst, this.jamming(w, off, 1, e));
      }
      this.sideJnrDb = worst > 0 ? toDb(worst / this.noiseW) : -99;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Sensor catalogue. Numbers are representative of each class, not of any specific system.

/** LR SAM multifunction phased array (C-band), 120 deg sector, sidelobe cancellers. */
export const LR_RADAR: RadarSpec = {
  freqGHz: 5.5, peakKW: 650, gainDb: 40, bwMHz: 1, nfDb: 4, lossDb: 8, nPulses: 12,
  bwAzDeg: 1.7, bwElDeg: 1.7, sllDb: -32, slcDb: 22, maxRangeKm: 180, minElDeg: -1, maxElDeg: 85,
  scan: { kind: 'sector', halfWidthDeg: 60, frameS: 4, trackHz: 2 },
  mtiDb: 50, notchMps: 15, cnr10Db: 58, rangeAccM: 20, angleAccDeg: 0.05, pfa: 1e-6, iff: true, falseAlarmsPerScan: 0.15,
};

/** MR SAM 3D surveillance radar (X-band), rotating 30 rpm. No sidelobe canceller. */
export const MR_RADAR: RadarSpec = {
  freqGHz: 9.5, peakKW: 25, gainDb: 35, bwMHz: 1, nfDb: 4, lossDb: 8, nPulses: 32,
  bwAzDeg: 2, bwElDeg: 2.5, sllDb: -27, slcDb: 0, maxRangeKm: 75, minElDeg: -2, maxElDeg: 60,
  scan: { kind: 'rotating', rpm: 30 },
  mtiDb: 52, notchMps: 12, cnr10Db: 58, rangeAccM: 30, angleAccDeg: 0.1, pfa: 1e-6, iff: true, falseAlarmsPerScan: 0.25,
};

/** SHORAD search-on-the-move radar (S-band), fan beam, rotating 60 rpm. */
export const SH_RADAR: RadarSpec = {
  freqGHz: 3.2, peakKW: 12, gainDb: 28, bwMHz: 2, nfDb: 4, lossDb: 7, nPulses: 32,
  bwAzDeg: 3, bwElDeg: 25, sllDb: -25, slcDb: 0, maxRangeKm: 25, minElDeg: -3, maxElDeg: 60,
  scan: { kind: 'rotating', rpm: 60 },
  mtiDb: 50, notchMps: 10, cnr10Db: 55, rangeAccM: 25, angleAccDeg: 0.3, pfa: 1e-6, iff: true, falseAlarmsPerScan: 0.15,
};

/** CIWS search radar (Ku-band), rotating 90 rpm. */
export const CIWS_RADAR: RadarSpec = {
  freqGHz: 15, peakKW: 3, gainDb: 30, bwMHz: 5, nfDb: 5, lossDb: 7, nPulses: 16,
  bwAzDeg: 2.5, bwElDeg: 10, sllDb: -25, slcDb: 0, maxRangeKm: 9, minElDeg: -3, maxElDeg: 80,
  scan: { kind: 'rotating', rpm: 90 },
  mtiDb: 55, notchMps: 6, cnr10Db: 50, rangeAccM: 5, angleAccDeg: 0.2, pfa: 1e-6, iff: false, falseAlarmsPerScan: 0.02,
};

/** Fighter fire-control radar (X-band), +/-60 deg mechanically scanned. */
export const AI_RADAR: RadarSpec = {
  freqGHz: 10, peakKW: 12, gainDb: 36, bwMHz: 1, nfDb: 4, lossDb: 8, nPulses: 128,
  bwAzDeg: 3.3, bwElDeg: 3.3, sllDb: -28, slcDb: 0, maxRangeKm: 150, minElDeg: -30, maxElDeg: 30,
  scan: { kind: 'sector', halfWidthDeg: 60, frameS: 3, trackHz: 1 },
  mtiDb: 45, notchMps: 25, cnr10Db: 55, rangeAccM: 40, angleAccDeg: 0.2, pfa: 1e-6, iff: true, falseAlarmsPerScan: 0.1,
};

/** Early warning radar (L-band), rotating 6 rpm. Long reach, coarse angles, below most jammers' bands. */
export const EW_RADAR: RadarSpec = {
  freqGHz: 1.3, peakKW: 60, gainDb: 36, bwMHz: 1, nfDb: 3, lossDb: 9, nPulses: 24,
  bwAzDeg: 2.2, bwElDeg: 4, sllDb: -35, slcDb: 20, maxRangeKm: 250, minElDeg: -1, maxElDeg: 30,
  scan: { kind: 'rotating', rpm: 6 },
  mtiDb: 45, notchMps: 20, cnr10Db: 55, rangeAccM: 120, angleAccDeg: 0.25, pfa: 1e-6, iff: true, falseAlarmsPerScan: 0.3,
};
