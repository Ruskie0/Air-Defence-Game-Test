import { G, rho } from './constants';
import { V3, add, addScaled, angleBetween, clamp, clone, dirAzEl, dist, dot, len, len2, lerp, norm, scale, sub, v3 } from './math';
import type { Entity } from './entities';
import type { FireUnit } from './sites';
import type { Track } from './tracker';
import type { World } from './world';

export type Seeker = 'tvm' | 'arh' | 'cmd';

export interface MissileSpec {
  code: 'LR' | 'MR' | 'SH' | 'AAM';
  name: string;
  maxRangeM: number;
  minRangeM: number;
  /** Maximum intercept range against ballistic targets (0 = not TBM capable). */
  tbmRangeM: number;
  maxAltM: number;
  boostAcc: number;
  boostT: number;
  dragK: number;
  maxG: number;
  lethalR: number;
  pk: number;
  seeker: Seeker;
  seekerRangeM: number;
  maxTof: number;
  /** Mean speed used for predicted-intercept-point planning. */
  avgSpd: number;
  nav: number;
  launchElDeg: number;
  costM: number;
}

/** Long-range SAM: track-via-missile guidance, TBM capable. */
export const LR_MSL: MissileSpec = {
  code: 'LR', name: 'LR SAM', maxRangeM: 120000, minRangeM: 3000, tbmRangeM: 40000, maxAltM: 24000,
  boostAcc: 330, boostT: 4.5, dragK: 1.6e-5, maxG: 30, lethalR: 12, pk: 0.85, seeker: 'tvm', seekerRangeM: 0,
  maxTof: 150, avgSpd: 960, nav: 4, launchElDeg: 38, costM: 3.5,
};

/** Medium-range SAM: active radar homing, can engage on any fused track (engage on remote). */
export const MR_MSL: MissileSpec = {
  code: 'MR', name: 'MR SAM', maxRangeM: 32000, minRangeM: 1500, tbmRangeM: 0, maxAltM: 16000,
  boostAcc: 280, boostT: 4, dragK: 2.2e-5, maxG: 35, lethalR: 8, pk: 0.8, seeker: 'arh', seekerRangeM: 12000,
  maxTof: 60, avgSpd: 820, nav: 4, launchElDeg: 30, costM: 1.2,
};

/** SHORAD: command to line of sight from the fire unit tracker. */
export const SH_MSL: MissileSpec = {
  code: 'SH', name: 'SHORAD', maxRangeM: 10000, minRangeM: 500, tbmRangeM: 0, maxAltM: 6000,
  boostAcc: 420, boostT: 2, dragK: 3e-5, maxG: 40, lethalR: 5, pk: 0.75, seeker: 'cmd', seekerRangeM: 0,
  maxTof: 22, avgSpd: 680, nav: 4, launchElDeg: 12, costM: 0.25,
};

/** Fighter-launched active radar AAM. */
export const AAM_MSL: MissileSpec = {
  code: 'AAM', name: 'AAM', maxRangeM: 70000, minRangeM: 1500, tbmRangeM: 0, maxAltM: 20000,
  boostAcc: 250, boostT: 5, dragK: 1.8e-5, maxG: 35, lethalR: 9, pk: 0.8, seeker: 'arh', seekerRangeM: 15000,
  maxTof: 90, avgSpd: 900, nav: 4, launchElDeg: 0, costM: 1.1,
};

let nextMid = 1;

export class Interceptor {
  readonly id = nextMid++;
  readonly spec: MissileSpec;
  /** Launching fire unit (null for air-launched missiles); its radar guides TVM and command missiles. */
  readonly fu: FireUnit | null;
  readonly unit: string;
  alive = true;
  pos: V3;
  vel: V3;
  readonly t0: number;
  trackId: number;
  home: Entity | null = null;
  missed = false;
  trail: V3[] = [];
  private lastEst: { pos: V3; vel: V3; t: number } | null = null;
  private noise = v3();
  private nextAcq = 0;
  private nextTrail = 0;
  private missT = 0;
  private targetGone = false;

  constructor(w: World, spec: MissileSpec, fu: FireUnit | null, unit: string, from: V3, aimAt: V3, launchVel: V3 | null, trackId: number) {
    this.spec = spec;
    this.fu = fu;
    this.unit = unit;
    this.pos = clone(from);
    this.t0 = w.t;
    this.trackId = trackId;
    if (launchVel) this.vel = clone(launchVel);
    else {
      const az = (Math.atan2(aimAt.x - from.x, aimAt.y - from.y) * 180) / Math.PI;
      const el = Math.max(spec.launchElDeg, (Math.atan2(aimAt.z - from.z, Math.hypot(aimAt.x - from.x, aimAt.y - from.y)) * 180) / Math.PI);
      this.vel = scale(dirAzEl(az, el), 40);
    }
    this.trail.push(clone(this.pos));
  }

  get speed(): number {
    return len(this.vel);
  }

  /** Can the guidance source currently see the homing target? */
  private homeValid(w: World, e: Entity): boolean {
    switch (this.spec.seeker) {
      case 'tvm':
      case 'cmd': {
        const r = this.fu?.radar;
        return !!r && r.isEmitting() && w.terrain.los(r.pos, e.pos);
      }
      case 'arh':
        return angleBetween(this.vel, sub(e.pos, this.pos)) < 55;
    }
  }

  /** Midcourse uplink: TVM needs the LR radar tracking the target, ARH accepts any fused track. */
  private uplink(w: World, tr: Track): boolean {
    if (this.spec.seeker === 'tvm') {
      const r = this.fu?.radar;
      const lrT = r ? (tr.sources.get(r.code) ?? -1e9) : -1e9;
      return !!r && r.isEmitting() && (w.t - lrT < 4 || (tr.jam && (tr.sources.get('ESM') ?? -1e9) > w.t - 4));
    }
    if (this.spec.seeker === 'cmd') {
      const r = this.fu?.radar;
      return !!r && r.isEmitting();
    }
    return true;
  }

  private tryAcquire(w: World, est: V3, tr: Track | undefined): void {
    if (w.t < this.nextAcq) return;
    this.nextAcq = w.t + 0.2;
    const d = dist(this.pos, est);
    const closing = Math.max(300, this.speed);
    let inRange: boolean;
    if (this.spec.seeker === 'arh') inRange = d < this.spec.seekerRangeM;
    else if (this.spec.seeker === 'tvm') inRange = d < closing * 12;
    else inRange = true;
    if (!inRange) return;
    if (this.spec.seeker === 'arh' && !w.rng.chance(0.5)) return;
    const gate = Math.max(700, 3 * (tr?.sigma ?? 300));
    let best: Entity | null = null;
    let bd = gate;
    // A jam-only track has no skin return to home on: the seeker can only home on the jamming itself.
    const hojOnly = !!tr?.jam && !tr.skin;
    for (const e of w.entities) {
      if (!e.alive || !e.airborne) continue;
      if (hojOnly && !e.jammer?.active) continue;
      let dd = dist(e.pos, est);
      // Home-on-jam: prefer a radiating jammer inside a jam track's large gate.
      if (tr?.jam && e.jammer?.active) dd *= 0.2;
      if (dd < bd && this.homeValid(w, e)) {
        bd = dd;
        best = e;
      }
    }
    if (best) this.home = best;
  }

  private estimate(w: World): { pos: V3; vel: V3 } | null {
    const tr = w.tracker.get(this.trackId);
    let est: { pos: V3; vel: V3 } | null = null;
    if (tr && w.t - tr.t < 10 && this.uplink(w, tr)) est = { pos: tr.predict(w.t), vel: tr.velAt(w.t) };
    else if (this.lastEst) {
      const dt = w.t - this.lastEst.t;
      est = { pos: addScaled(this.lastEst.pos, this.lastEst.vel, dt), vel: this.lastEst.vel };
    }
    if (!this.home && est) this.tryAcquire(w, est.pos, tr);
    if (this.home) {
      if (!this.home.alive || !this.homeValid(w, this.home)) {
        if (!this.home.alive) {
          // Target destroyed by another round of the salvo: nothing left to guide on.
          this.home = null;
          this.targetGone = true;
        }
      } else {
        const ref = this.spec.seeker === 'cmd' ? (this.fu?.radar?.pos ?? this.pos) : this.pos;
        // Angle noise grows with range from the guidance sensor; the floor is glint and fuze timing.
        const sigma = (this.spec.seeker === 'cmd' ? 0.0004 : this.spec.seeker === 'tvm' ? 0.0008 : 0.001) * dist(ref, this.home.pos) + 1.5;
        this.noise = v3(
          lerp(this.noise.x, w.rng.gauss() * sigma, 0.1),
          lerp(this.noise.y, w.rng.gauss() * sigma, 0.1),
          lerp(this.noise.z, w.rng.gauss() * sigma, 0.1),
        );
        est = { pos: add(this.home.pos, this.noise), vel: clone(this.home.vel) };
      }
    }
    if (est) this.lastEst = { pos: clone(est.pos), vel: clone(est.vel), t: w.t };
    return est;
  }

  update(w: World, dt: number): void {
    const age = w.t - this.t0;
    const est = this.estimate(w);
    const spd = this.speed;
    const vhat = norm(this.vel);

    // Proximity fuze against the homing target (closest approach within this step).
    if (this.home && this.home.alive) {
      const r0 = sub(this.home.pos, this.pos);
      const vr = sub(this.home.vel, this.vel);
      const v2 = len2(vr);
      const tcaRaw = v2 > 1 ? -dot(r0, vr) / v2 : 0;
      if (tcaRaw <= dt) {
        const miss = len(addScaled(r0, vr, clamp(tcaRaw, 0, dt)));
        if (miss < this.spec.lethalR * 3) {
          this.detonate(w, miss);
          return;
        }
        if (len(r0) < 3000 && !this.missed) {
          this.missed = true;
          this.missT = w.t;
          w.onMissileMiss(this, miss);
        }
      }
    }

    let acmd = v3();
    if (est && age > 0.6) {
      const r = sub(est.pos, this.pos);
      const R = len(r);
      const v = sub(est.vel, this.vel);
      const vc = -dot(r, v) / Math.max(R, 1);
      const tgo = vc > 50 ? R / vc : R / Math.max(spd, 300);
      // Loft long shots to fly the midcourse in thin air.
      let loft = 0;
      if (this.spec.seeker !== 'cmd' && R > 20000 && est.pos.z < 15000) loft = Math.min(14000, (R - 20000) * 0.3);
      const zem = addScaled(r, v, tgo);
      zem.z += loft;
      const rhat = scale(r, 1 / Math.max(R, 1));
      const zp = sub(zem, scale(rhat, dot(zem, rhat)));
      acmd = scale(zp, this.spec.nav / Math.max(tgo * tgo, 0.25));
      acmd.z += G;
    } else if (age <= 0.6) {
      acmd = v3(0, 0, G);
    }
    acmd = sub(acmd, scale(vhat, dot(acmd, vhat)));
    const dens = rho(this.pos.z);
    const amax = this.spec.maxG * G * clamp((spd / 900) ** 2, 0.08, 1) * clamp(Math.sqrt(dens / 1.225) * 1.6, 0.25, 1);
    const am = len(acmd);
    if (am > amax) acmd = scale(acmd, amax / am);
    const thrust = age < this.spec.boostT ? this.spec.boostAcc : 0;
    const along = thrust - this.spec.dragK * dens * spd * spd;
    this.vel = addScaled(addScaled(this.vel, acmd, dt), vhat, along * dt);
    this.vel.z -= G * dt;
    this.pos = addScaled(this.pos, this.vel, dt);

    if (w.t >= this.nextTrail) {
      this.nextTrail = w.t + 0.25;
      this.trail.push(clone(this.pos));
      if (this.trail.length > 160) this.trail.shift();
    }
    const gnd = w.terrain.groundAt(this.pos.x, this.pos.y);
    if (this.pos.z < gnd && age > 1) this.selfDestruct(w, 'impacted terrain');
    else if (age > this.spec.maxTof) this.selfDestruct(w, 'time of flight exceeded');
    else if (age > this.spec.boostT + 2 && spd < 280) this.selfDestruct(w, 'out of energy');
    else if (this.missed && w.t - this.missT > 1.5) this.selfDestruct(w, '');
    else if (this.targetGone) this.selfDestruct(w, 'target already destroyed');
  }

  private detonate(w: World, miss: number): void {
    this.alive = false;
    const tgt = this.home!;
    let pk = this.spec.pk * Math.exp(-((miss / this.spec.lethalR) ** 2));
    if (tgt.kind === 'tbm') pk *= 0.9;
    const kill = w.rng.chance(pk);
    w.onMissileDetonation(this, tgt, miss, kill);
  }

  private selfDestruct(w: World, why: string): void {
    this.alive = false;
    w.effect(this.pos, 'small');
    if (why && !this.missed) w.log(`${this.spec.name} #${this.id} self-destructed: ${why}`, 'info');
  }
}
