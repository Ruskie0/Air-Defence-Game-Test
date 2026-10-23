import { DEG, G } from './constants';
import { V3, add, addScaled, clamp, clone, cross, dirAzEl, dist, dot, len, len2, norm, scale, sub, v3, wrap180 } from './math';
import type { Entity } from './entities';
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

const MUZZLE = 1100;
/** Quadratic drag coefficient per metre: v(s) = v0 * exp(-K * s). */
const K = 1.9e-4;
const ROF = 75; // rounds per second (4500 rpm)
const DISPERSION = 2.2e-3; // rad, 1 sigma
const SLEW = 115; // deg/s

/** Close-in weapon system: own search/track radar, lead-computing gun with per-round ballistics. */
export class Ciws {
  readonly code: string;
  readonly name: string;
  readonly site: Site;
  readonly radar: Radar;
  ammo = 1550;
  readonly maxAmmo = 1550;
  reloadUntil = 0;
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

  constructor(code: string, name: string, site: Site, radar: Radar) {
    this.code = code;
    this.name = name;
    this.site = site;
    this.radar = radar;
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
      if (!e || !e.alive || !e.airborne || e.side !== 'red') continue;
      if (e.speed > 1300) continue; // ballistic re-entry vehicles are outside the fire-control envelope
      const r = sub(e.pos, gun);
      const R = len(r);
      if (R > 4500) continue;
      const closing = -dot(r, e.vel) / Math.max(R, 1);
      if (closing < 10 && R > 1200) continue;
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
    if (!this.site.alive) return;
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
    // Lead: solve time of flight with drag, then add gravity drop.
    let tof = R / MUZZLE;
    let p = this.est.pos;
    for (let i = 0; i < 6; i++) {
      p = addScaled(this.est.pos, this.est.vel, tof);
      const d = dist(gun, p);
      const arg = K * d;
      tof = arg < 0.95 ? (Math.exp(arg) - 1) / (K * MUZZLE) : 99;
    }
    const aim = sub(p, gun);
    aim.z += 0.5 * G * tof * tof;
    const wantAz = (Math.atan2(aim.x, aim.y) / DEG + 360) % 360;
    const wantEl = Math.atan2(aim.z, Math.hypot(aim.x, aim.y)) / DEG;
    const m = SLEW * dt;
    this.aimAz = (this.aimAz + clamp(wrap180(wantAz - this.aimAz), -m, m) + 360) % 360;
    this.aimEl = this.aimEl + clamp(wantEl - this.aimEl, -m, m);
    const err = Math.hypot(wrap180(wantAz - this.aimAz) * Math.cos(this.aimEl * DEG), wantEl - this.aimEl);
    const interceptR = dist(gun, p);
    if (err < 0.6 && interceptR < 2300 && tof < 4 && this.ammo > 0 && this.aimEl > -2) {
      this.firing = true;
      this.acc += ROF * dt;
      const dir = dirAzEl(this.aimAz, this.aimEl);
      const u = norm(cross(dir, v3(0, 0, 1)));
      const vv = cross(u, dir);
      while (this.acc >= 1 && this.ammo > 0) {
        this.acc -= 1;
        this.ammo--;
        this.burst++;
        w.stats.ciwsRounds++;
        const d = add(dir, add(scale(u, w.rng.gauss() * DISPERSION), scale(vv, w.rng.gauss() * DISPERSION)));
        this.rounds.push({ pos: clone(gun), vel: scale(norm(d), MUZZLE), t0: w.t, alive: true, tracer: this.burst % 4 === 0 });
      }
      if (this.ammo === 0) {
        this.reloadUntil = w.t + 90;
        w.log(`${this.name} Winchester, reloading`, 'alert');
      }
    } else {
      this.acc = 0;
    }
  }

  private updateRounds(w: World, dt: number): void {
    if (!this.rounds.length) return;
    const gun = this.gun;
    const cands = w.entities.filter((e) => e.alive && e.airborne && e.side !== 'blue' && dist(e.pos, gun) < 4500);
    for (const r of this.rounds) {
      if (!r.alive) continue;
      const prev = r.pos;
      const sp = len(r.vel);
      r.vel = scale(r.vel, 1 - K * sp * dt);
      r.vel.z -= G * dt;
      r.pos = addScaled(r.pos, r.vel, dt);
      for (const e of cands) {
        if (!e.alive) continue;
        // Closest approach of round and target over this step, in the target's frame.
        const r0 = sub(sub(e.pos, scale(e.vel, dt)), prev);
        const vr = sub(e.vel, r.vel);
        const v2 = len2(vr);
        const tca = v2 > 1 ? clamp(-dot(r0, vr) / v2, 0, dt) : 0;
        const miss = len(addScaled(r0, vr, tca));
        if (miss < e.hitRadius) {
          r.alive = false;
          const pk = e.kind === 'drone' ? 0.5 : e.kind === 'cruise' ? 0.35 : e.kind === 'arm' ? 0.3 : 0.12;
          if (w.rng.chance(pk)) w.killEntity(e, this.name);
          break;
        }
      }
      if (!r.alive) continue;
      if (w.t - r.t0 > 4.5) {
        r.alive = false; // self-destruct tracer
      } else if (r.pos.z < w.terrain.groundAt(r.pos.x, r.pos.y)) {
        r.alive = false;
      }
    }
    for (let i = this.rounds.length - 1; i >= 0; i--) if (!this.rounds[i].alive) this.rounds.splice(i, 1);
  }
}
