import { DEG, G } from './constants';
import { V3, add, addScaled, clamp, clone, cross, dirAzEl, dist, dot, len, norm, scale, sub, v3, wrap180 } from './math';
import type { Entity, Kind } from './entities';
import type { Radar } from './radar';
import type { Site } from './sites';
import type { World } from './world';

export interface Round {
  pos: V3;
  vel: V3;
  t0: number;
  alive: boolean;
  tracer: boolean;
}

/** Quadratic drag coefficient per metre for the visual rounds: v(s) = v0 * exp(-K * s). */
const K = 1.9e-4;
const DISPERSION = 2.2e-3; // rad, 1 sigma

export type GunKind = 'ciws' | 'gun35' | 'laser';

/**
 * Game stats of a point-defence weapon. Kill chances are balance numbers, not a model of real weapons:
 * every second the weapon is on a target at close range it kills it with probability 1 - exp(-rate),
 * falling off towards the edge of its range.
 */
export interface GunSpec {
  kind: GunKind;
  /** Name prefix of fielded units (CIWS 1, Skyburst 2, ...). */
  label: string;
  /** Furthest intercept it will fire at (m). */
  rangeM: number;
  /** Rounds per magazine (Infinity for the laser). */
  ammo: number;
  reloadS: number;
  /** Visual rounds per second (0: no rounds, the laser). */
  rof: number;
  muzzle: number;
  slew: number;
  /** Kill rate per second of fire, by target kind. Kinds not listed are not engaged. */
  killRate: Partial<Record<Kind, number>>;
  /** Laser: seconds of continuous fire before it must cool down, and how long that takes. */
  heatS?: number;
  coolS?: number;
}

export const GUNS: Record<GunKind, GunSpec> = {
  ciws: {
    kind: 'ciws', label: 'CIWS', rangeM: 2500, ammo: 1550, reloadS: 90, rof: 75, muzzle: 1100, slew: 115,
    killRate: { drone: 1.6, cruise: 1.4, arm: 1.0, tbm: 0.8, sead: 0.5, bomber: 0.3, fighter: 0.5 },
  },
  gun35: {
    kind: 'gun35', label: 'Skyburst', rangeM: 4500, ammo: 240, reloadS: 45, rof: 18, muzzle: 1050, slew: 80,
    killRate: { drone: 1.3, cruise: 0.9, arm: 0.45, sead: 0.6, bomber: 0.4, fighter: 0.6 },
  },
  laser: {
    kind: 'laser', label: 'Laser', rangeM: 3500, ammo: Infinity, reloadS: 0, rof: 0, muzzle: 0, slew: 60,
    killRate: { drone: 0.45, cruise: 0.12 }, heatS: 12, coolS: 8,
  },
};

/** How much of its close-range kill rate a weapon keeps at range R (full inside half range, 35% at max). */
const falloff = (R: number, max: number): number => (R < 0.5 * max ? 1 : 1 - (0.65 * (R - 0.5 * max)) / (0.5 * max));

/**
 * Point-defence weapon (CIWS gun, 35 mm airburst gun or laser) with its own search/track radar. It picks the
 * most urgent target inside its envelope, slews onto it and rolls a kill chance every step it fires.
 */
export class Ciws {
  readonly code: string;
  readonly name: string;
  readonly site: Site;
  readonly radar: Radar;
  readonly spec: GunSpec;
  ammo: number;
  readonly maxAmmo: number;
  reloadUntil = 0;
  /** Laser only: seconds of fire built up towards overheating, and when it is cool again (0 if not cooling). */
  heat = 0;
  coolUntil = 0;
  /** Laser only: the beam is on the target this step. */
  lasing = false;
  /** Crew rank (0 = Green): +8% kill rate per rank. */
  rank = 0;
  auto = true;
  aimAz = 0;
  aimEl = 15;
  target: Entity | null = null;
  firing = false;
  readonly rounds: Round[] = [];
  private est: { pos: V3; vel: V3 } | null = null;
  private acc = 0;
  private nextSelect = 0;
  private burst = 0;

  constructor(code: string, name: string, site: Site, radar: Radar, spec: GunSpec = GUNS.ciws) {
    this.code = code;
    this.name = name;
    this.site = site;
    this.radar = radar;
    this.spec = spec;
    this.ammo = spec.ammo;
    this.maxAmmo = spec.ammo;
  }

  /** Can this weapon engage that kind of target at all? */
  engages(kind: Kind): boolean {
    return (this.spec.killRate[kind] ?? 0) > 0;
  }

  get gun(): V3 {
    return v3(this.site.pos.x, this.site.pos.y, this.site.pos.z + 3);
  }

  private select(w: World): void {
    let best: Entity | null = null;
    let bestTgo = Infinity;
    const gun = this.gun;
    for (const [id, t] of this.radar.firm) {
      if (w.t - t > 1.5) continue;
      const e = w.entityById(id);
      if (!e || !e.alive || !e.airborne || e.side !== 'red' || !this.engages(e.kind)) continue;
      const r = sub(e.pos, gun);
      const R = len(r);
      if (R > this.spec.rangeM * 1.8) continue;
      const closing = -dot(r, e.vel) / Math.max(R, 1);
      if (closing < 10 && R > this.spec.rangeM * 0.5) continue;
      const tgo = R / Math.max(closing, 10);
      if (tgo < bestTgo) {
        bestTgo = tgo;
        best = e;
      }
    }
    if (best !== this.target) {
      this.est = null;
      this.burst = 0;
      if (best) w.log(`${this.name} tracking ${best.name}`, 'engage');
    }
    this.target = best;
  }

  update(w: World, dt: number): void {
    this.updateRounds(w, dt);
    this.firing = false;
    this.lasing = false;
    if (!this.site.alive) return;
    const spec = this.spec;
    if (spec.heatS && this.coolUntil > 0 && w.t >= this.coolUntil) {
      this.coolUntil = 0;
      this.heat = 0;
    }
    if (spec.heatS && this.coolUntil === 0) this.heat = Math.max(0, this.heat - dt * 0.5);
    if (this.ammo === 0 && w.t >= this.reloadUntil) {
      this.ammo = this.maxAmmo;
      w.log(`${this.name} reloaded`, 'info');
    }
    if (!this.auto || !this.radar.isEmitting()) {
      this.target = null;
      return;
    }
    if (w.t >= this.nextSelect) {
      this.nextSelect = w.t + 0.25;
      this.select(w);
    }
    const tgt = this.target;
    if (!tgt || !tgt.alive) {
      this.target = null;
      return;
    }
    const gun = this.gun;
    // Fire-control radar track: noisy measurements smoothed by an alpha-beta filter.
    const R = dist(gun, tgt.pos);
    const s = 0.0015 * R + 0.3;
    const meas = v3(tgt.pos.x + w.rng.gauss() * s, tgt.pos.y + w.rng.gauss() * s, tgt.pos.z + w.rng.gauss() * s);
    if (!this.est) this.est = { pos: meas, vel: clone(tgt.vel) };
    else {
      const pred = addScaled(this.est.pos, this.est.vel, dt);
      const res = sub(meas, pred);
      this.est.pos = addScaled(pred, res, 0.25);
      this.est.vel = addScaled(this.est.vel, res, 0.03 / dt);
    }
    // Lead the target by the time of flight (a laser points straight at it).
    let tof = spec.muzzle ? R / spec.muzzle : 0;
    let p = this.est.pos;
    if (spec.muzzle) {
      // A diving target reaches the ground first: aim a barrage just above the ground in its path.
      const e = this.est;
      const tHit = e.vel.z < -1 ? Math.max(0, (e.pos.z - w.terrain.groundAt(e.pos.x, e.pos.y) - 30) / -e.vel.z) : Infinity;
      for (let i = 0; i < 6; i++) {
        p = addScaled(e.pos, e.vel, Math.min(tof, tHit));
        const arg = K * dist(gun, p);
        tof = arg < 0.95 ? (Math.exp(arg) - 1) / (K * spec.muzzle) : 99;
      }
    }
    const aim = sub(p, gun);
    aim.z += 0.5 * G * tof * tof;
    const wantAz = (Math.atan2(aim.x, aim.y) / DEG + 360) % 360;
    const wantEl = Math.atan2(aim.z, Math.hypot(aim.x, aim.y)) / DEG;
    const m = spec.slew * dt;
    this.aimAz = (this.aimAz + clamp(wrap180(wantAz - this.aimAz), -m, m) + 360) % 360;
    this.aimEl = this.aimEl + clamp(wantEl - this.aimEl, -m, m);
    const err = Math.hypot(wrap180(wantAz - this.aimAz) * Math.cos(this.aimEl * DEG), wantEl - this.aimEl);
    const interceptR = dist(gun, p);
    const canFire = err < 0.6 && interceptR < spec.rangeM && tof < 4 && this.ammo > 0 && this.aimEl > -2 && this.coolUntil === 0;
    if (canFire && spec.kind === 'laser') {
      this.lasing = true;
      this.heat += dt * 1.5;
      if (this.heat >= spec.heatS!) {
        this.coolUntil = w.t + spec.coolS!;
        w.log(`${this.name} overheated, cooling down`, 'info');
      }
      this.roll(w, tgt, R, dt);
      return;
    }
    if (canFire) {
      this.firing = true;
      this.roll(w, tgt, R, dt);
      this.acc += spec.rof * dt;
      const dir = dirAzEl(this.aimAz, this.aimEl);
      const u = norm(cross(dir, v3(0, 0, 1)));
      const vv = cross(u, dir);
      while (this.acc >= 1 && this.ammo > 0) {
        this.acc -= 1;
        this.ammo--;
        this.burst++;
        w.stats.ciwsRounds++;
        const d = add(dir, add(scale(u, w.rng.gauss() * DISPERSION), scale(vv, w.rng.gauss() * DISPERSION)));
        this.rounds.push({ pos: clone(gun), vel: scale(norm(d), spec.muzzle), t0: w.t, alive: true, tracer: this.burst % 4 === 0 });
      }
      if (this.ammo === 0) {
        this.reloadUntil = w.t + spec.reloadS;
        w.log(`${this.name} Winchester, reloading`, 'alert');
      }
    } else {
      this.acc = 0;
    }
  }

  /** One step of fire on the target: a kill chance from the weapon's rate for its kind and the range. */
  private roll(w: World, tgt: Entity, R: number, dt: number): void {
    const rate = (this.spec.killRate[tgt.kind] ?? 0) * falloff(R, this.spec.rangeM) * w.mods.pdBonus * (1 + 0.08 * this.rank);
    if (w.rng.chance(1 - Math.exp(-rate * dt))) w.killEntity(tgt, this.name, this.name, this.spec.kind === 'laser' ? 'laser' : 'gun');
  }

  /** The rounds in flight are for show: kills are decided by roll(). */
  private updateRounds(w: World, dt: number): void {
    if (!this.rounds.length) return;
    for (const r of this.rounds) {
      const sp = len(r.vel);
      r.vel = scale(r.vel, 1 - K * sp * dt);
      r.vel.z -= G * dt;
      r.pos = addScaled(r.pos, r.vel, dt);
      if (w.t - r.t0 > 4.5 || r.pos.z < w.terrain.groundAt(r.pos.x, r.pos.y)) r.alive = false;
    }
    for (let i = this.rounds.length - 1; i >= 0; i--) if (!this.rounds[i].alive) this.rounds.splice(i, 1);
  }
}
