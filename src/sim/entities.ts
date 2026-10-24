import { G } from './constants';
import {
  V3,
  add,
  addScaled,
  angleBetween,
  bearingDeg,
  clamp,
  clone,
  dist,
  hdist,
  norm,
  polar,
  scale,
  sub,
  v3,
  wrap180,
} from './math';
import type { World } from './world';

export type Side = 'blue' | 'red' | 'neutral';
export type Kind = 'drone' | 'cruise' | 'bomber' | 'strike' | 'bomb' | 'sead' | 'soj' | 'tbm' | 'arm' | 'airliner' | 'fighter';

export interface Warhead {
  lethalR: number;
  dmg: number;
}

export interface NoiseJammer {
  /** Effective radiated power (W) spread across bwMHz. */
  erpW: number;
  bwMHz: number;
  loGHz: number;
  hiGHz: number;
  active: boolean;
}

/** Anything that radiates and can be found by ESM / homed on by an anti-radiation missile. */
export interface Emitter {
  name: string;
  pos: V3;
  /** What the emission looks like to an ESM receiver. A decoy copies the LR radar's signature. */
  signature: 'LR' | 'MR' | 'SH' | 'CIWS' | 'EW' | 'JAM';
  alive: boolean;
  isEmitting(): boolean;
}

/**
 * How an entity left the battle. `air` kills (missile, gun, laser) leave a wreck that falls from `pos`
 * with `vel`; `impact` means its warhead functioned on the ground (or at its aim point); `exit` means it
 * flew off the map, ran out of time or landed.
 */
export interface Fate {
  how: 'missile' | 'gun' | 'laser' | 'impact' | 'exit';
  /** Shooter (fire unit, gun, fighter or laser name) for air kills; target name for impacts. */
  by: string;
  t: number;
  pos: V3;
  vel: V3;
  /** Killed in the air, so a wreck should fall. */
  air: boolean;
  /** Impacts only: a defended or AD site took damage. */
  hit?: boolean;
}

let nextId = 1;

export abstract class Entity {
  readonly id = nextId++;
  abstract readonly kind: Kind;
  abstract readonly side: Side;
  alive = true;
  /** False while a fighter sits on the ground rearming. */
  airborne = true;
  pos: V3;
  vel: V3 = v3();
  name: string;
  rcs = 1;
  hitRadius = 2;
  iff: 'M5' | 'M3C' | null = null;
  /** Red munitions (drones, cruise missiles, ARMs, TBMs) as opposed to aircraft. */
  munition = false;
  /** A decoy: looks like the real thing but has no warhead. */
  decoy = false;
  /** An enemy reconnaissance drone (it photographs our positions). */
  recon = false;
  /** Countermeasures (chaff, flares, jamming pod): multiplies the kill chance of a missile that reaches it. */
  cmPk = 1;
  warhead: Warhead | null = null;
  target: V3 | null = null;
  targetName = '';
  jammer: NoiseJammer | null = null;
  /** 0..1: how much the platform's navigation depends on GNSS. */
  gnssDep = 0;
  navErr = v3();
  navDrift = v3();
  gnssJammed = false;
  /** Sim time of the last detection by any friendly sensor (used to hide undetected truth in the 3D view). */
  lastDetected = -1e9;
  /** Campaign raid package this threat belongs to (-1 outside the campaign). */
  pkg = -1;
  /** Set once, when the entity dies or leaves (null while it is alive). */
  fate: Fate | null = null;

  constructor(name: string, pos: V3) {
    this.name = name;
    this.pos = clone(pos);
  }

  get speed(): number {
    return Math.hypot(this.vel.x, this.vel.y, this.vel.z);
  }

  abstract update(w: World, dt: number): void;
}

/** Point-mass aircraft / air-breathing weapon with heading, speed and altitude autopilots. */
export abstract class Air extends Entity {
  hdg: number;
  spd: number;
  cmdSpd: number;
  cmdAlt: number;
  /** Terrain following: hold this height above ground instead of cmdAlt. */
  tfAgl: number | null = null;
  turnRate = 3;
  climb = 30;
  accel = 5;
  waypoints: V3[] = [];
  wpIdx = 0;

  constructor(name: string, pos: V3, hdg: number, spd: number) {
    super(name, pos);
    this.hdg = hdg;
    this.spd = spd;
    this.cmdSpd = spd;
    this.cmdAlt = pos.z;
  }

  /** Turn toward a horizontal point as the platform believes it is positioned (true position + nav error). */
  steer(tx: number, ty: number, dt: number): void {
    const px = this.pos.x + this.navErr.x;
    const py = this.pos.y + this.navErr.y;
    const want = bearingDeg(v3(px, py), v3(tx, ty));
    const d = wrap180(want - this.hdg);
    const m = this.turnRate * dt;
    this.hdg = (this.hdg + clamp(d, -m, m) + 360) % 360;
  }

  perceivedDist(p: V3): number {
    return Math.hypot(p.x - (this.pos.x + this.navErr.x), p.y - (this.pos.y + this.navErr.y));
  }

  /** Returns true once the last waypoint has been passed. */
  followWaypoints(dt: number, capture = 1500): boolean {
    const wp = this.waypoints[this.wpIdx];
    if (!wp) return true;
    if (this.perceivedDist(wp) < capture) {
      this.wpIdx++;
      return this.wpIdx >= this.waypoints.length;
    }
    this.steer(wp.x, wp.y, dt);
    return false;
  }

  integrate(w: World, dt: number): void {
    let alt = this.cmdAlt;
    if (this.tfAgl !== null) {
      // Terrain following: clear the highest ground over the next few seconds of flight.
      const hx = Math.sin((this.hdg * Math.PI) / 180) * this.spd;
      const hy = Math.cos((this.hdg * Math.PI) / 180) * this.spd;
      let g = w.terrain.groundAt(this.pos.x, this.pos.y);
      for (const s of [1, 2, 3.5, 5, 7]) g = Math.max(g, w.terrain.groundAt(this.pos.x + hx * s, this.pos.y + hy * s) - s * 6);
      alt = g + this.tfAgl;
    }
    const vz = clamp((alt - this.pos.z) * 0.5, -this.climb, this.climb);
    this.spd += clamp(this.cmdSpd - this.spd, -this.accel * dt, this.accel * dt);
    const h = Math.sqrt(Math.max(0, this.spd * this.spd - vz * vz));
    const a = (this.hdg * Math.PI) / 180;
    this.vel = v3(Math.sin(a) * h, Math.cos(a) * h, vz);
    this.pos = addScaled(this.pos, this.vel, dt);
    if (this.tfAgl !== null) {
      const gnd = w.terrain.groundAt(this.pos.x, this.pos.y);
      if (this.pos.z < gnd + 12) this.pos.z = gnd + 12;
    }
  }
}

/** One-way attack drone: slow, small, GNSS-guided, terminal dive onto its target. */
export class Drone extends Air {
  readonly kind = 'drone' as const;
  readonly side = 'red' as const;
  diving = false;

  constructor(name: string, pos: V3, route: V3[], target: V3, targetName: string, agl: number) {
    super(name, pos, bearingDeg(pos, route[0] ?? target), 50);
    this.waypoints = route;
    this.target = clone(target);
    this.targetName = targetName;
    this.rcs = 0.1;
    this.hitRadius = 1.8;
    this.munition = true;
    this.warhead = { lethalR: 22, dmg: 30 };
    this.gnssDep = 1;
    this.tfAgl = agl;
    this.turnRate = 5;
    this.climb = 8;
    this.accel = 2;
  }

  update(w: World, dt: number): void {
    const tgt = this.target!;
    if (!this.diving) {
      if (this.followWaypoints(dt)) {
        this.steer(tgt.x, tgt.y, dt);
        if (this.perceivedDist(tgt) < 1600) this.diving = true;
      }
      this.integrate(w, dt);
    } else {
      // Dive at where the drone believes the target is: a GNSS-induced nav error shifts the impact point.
      const aim = sub(tgt, this.navErr);
      this.vel = scale(norm(sub(aim, this.pos)), 68);
      this.pos = addScaled(this.pos, this.vel, dt);
    }
    if (this.pos.z <= w.terrain.groundAt(this.pos.x, this.pos.y) + 1) w.detonate(this);
  }
}

/** Terrain-following subsonic cruise missile (INS/TERCOM with GNSS aiding). */
export class Cruise extends Air {
  readonly kind = 'cruise' as const;
  readonly side = 'red' as const;
  terminal = false;

  constructor(name: string, pos: V3, route: V3[], target: V3, targetName: string) {
    super(name, pos, bearingDeg(pos, route[0] ?? target), 240);
    this.waypoints = route;
    this.target = clone(target);
    this.targetName = targetName;
    this.rcs = 0.05;
    this.hitRadius = 1.2;
    this.munition = true;
    this.warhead = { lethalR: 35, dmg: 70 };
    this.gnssDep = 0.15;
    this.tfAgl = 40;
    this.turnRate = 4;
    this.climb = 55;
    this.accel = 10;
  }

  update(w: World, dt: number): void {
    const tgt = this.target!;
    if (!this.terminal) {
      if (this.followWaypoints(dt, 2000)) {
        this.steer(tgt.x, tgt.y, dt);
        if (this.perceivedDist(tgt) < 3500) this.terminal = true;
      }
      this.integrate(w, dt);
    } else {
      const aim = sub(tgt, this.navErr);
      this.vel = scale(norm(sub(aim, this.pos)), 250);
      this.pos = addScaled(this.pos, this.vel, dt);
    }
    if (this.pos.z <= w.terrain.groundAt(this.pos.x, this.pos.y) + 1) w.detonate(this);
  }
}

/** Tactical ballistic missile, spawned in the descending part of its trajectory. */
export class Tbm extends Entity {
  readonly kind = 'tbm' as const;
  readonly side = 'red' as const;

  constructor(name: string, pos: V3, vel: V3, target: V3, targetName: string) {
    super(name, pos);
    this.vel = clone(vel);
    this.target = clone(target);
    this.targetName = targetName;
    this.rcs = 0.1;
    this.hitRadius = 1;
    this.munition = true;
    this.warhead = { lethalR: 90, dmg: 100 };
  }

  update(w: World, dt: number): void {
    this.vel.z -= G * dt;
    this.pos = addScaled(this.pos, this.vel, dt);
    if (this.pos.z <= w.terrain.groundAt(this.pos.x, this.pos.y)) w.detonate(this);
  }

  /** Initial state that lands on `target` after `tof` seconds starting `rangeM` away at `alt`. */
  static solve(target: V3, bearing: number, rangeM: number, alt: number, tof: number): { pos: V3; vel: V3 } {
    const pos = add(target, polar(bearing, rangeM, 0));
    pos.z = alt;
    const vh = rangeM / tof;
    const dir = norm(v3(target.x - pos.x, target.y - pos.y, 0));
    const vz = (target.z - alt + 0.5 * G * tof * tof) / tof;
    return { pos, vel: v3(dir.x * vh, dir.y * vh, vz) };
  }
}

/** Anti-radiation missile: homes on an emitter; flies to a memorised position if the emitter goes silent. */
export class Arm extends Entity {
  readonly kind = 'arm' as const;
  readonly side = 'red' as const;
  emitter: Emitter | null;
  aim: V3;
  lost = false;
  t0: number;
  private nextFix = 0;

  constructor(name: string, pos: V3, vel: V3, emitter: Emitter, t0: number) {
    super(name, pos);
    this.vel = clone(vel);
    this.emitter = emitter;
    this.aim = clone(emitter.pos);
    this.target = this.aim;
    this.targetName = emitter.name;
    this.t0 = t0;
    this.rcs = 0.03;
    this.hitRadius = 0.6;
    this.munition = true;
    this.warhead = { lethalR: 18, dmg: 100 };
  }

  private inFov(p: V3, halfDeg: number): boolean {
    return angleBetween(this.vel, sub(p, this.pos)) < halfDeg;
  }

  update(w: World, dt: number): void {
    const em = this.emitter;
    if (w.t >= this.nextFix) {
      this.nextFix = w.t + 0.25;
      if (em && em.alive && em.isEmitting() && this.inFov(em.pos, 35)) {
        this.aim = add(em.pos, v3(w.rng.gauss() * 6, w.rng.gauss() * 6, 0));
        this.lost = false;
      } else if (!this.lost) {
        // Emitter went silent: keep flying at the remembered position, which carries the ESM position error.
        this.lost = true;
        this.aim = add(this.aim, v3(w.rng.gauss() * 220, w.rng.gauss() * 220, 0));
        w.log(`${this.name} lost its emitter, flying on memory`, 'info');
      }
      if (this.lost) {
        // Look for any other emitter in the seeker field of view (this is how the radar decoy works).
        let best: Emitter | null = null;
        let bd = Infinity;
        for (const e of w.emitters()) {
          if (e === em || !e.alive || !e.isEmitting() || !this.inFov(e.pos, 14)) continue;
          const d = dist(e.pos, this.aim);
          if (d < bd && d < 15000) {
            bd = d;
            best = e;
          }
        }
        if (best) {
          this.emitter = best;
          this.lost = false;
          this.targetName = best.name;
          w.log(`${this.name} seeker switched to ${best.name}`, 'info');
        }
      }
      this.target = this.aim;
    }
    const hd = hdist(this.pos, this.aim);
    const loft = hd > 18000 ? Math.min(7000, hd * 0.12) : 0;
    const want = norm(sub(v3(this.aim.x, this.aim.y, this.aim.z + loft), this.pos));
    const cur = norm(this.vel);
    const ang = angleBetween(cur, want);
    const maxTurn = 22 * dt;
    const f = ang > 1e-6 ? Math.min(1, maxTurn / ang) : 1;
    const dir = norm(add(scale(cur, 1 - f), scale(want, f)));
    this.vel = scale(dir, 950);
    this.pos = addScaled(this.pos, this.vel, dt);
    const gnd = w.terrain.groundAt(this.pos.x, this.pos.y);
    if (this.pos.z <= gnd + 2 || dist(this.pos, this.aim) < 10 || w.t - this.t0 > 160) w.detonate(this);
  }
}

/** Strike bomber: flies to a stand-off launch point, releases air-launched cruise missiles, egresses. */
export class Bomber extends Air {
  readonly kind = 'bomber' as const;
  readonly side = 'red' as const;
  weapons = 4;
  readonly launchRange = 115000;
  egress = false;
  private nextLaunch = 0;
  private readonly home: V3;
  readonly strikeTargets: { pos: V3; name: string }[];

  constructor(name: string, pos: V3, targets: { pos: V3; name: string }[]) {
    super(name, pos, bearingDeg(pos, targets[0].pos), 230);
    this.home = clone(pos);
    this.strikeTargets = targets;
    this.rcs = 25;
    this.hitRadius = 15;
    this.cmdAlt = 9500;
    this.turnRate = 2;
  }

  update(w: World, dt: number): void {
    const aim = this.strikeTargets[0].pos;
    if (!this.egress) {
      this.steer(aim.x, aim.y, dt);
      if (hdist(this.pos, aim) < this.launchRange && w.t >= this.nextLaunch) {
        const t = this.strikeTargets[(4 - this.weapons) % this.strikeTargets.length];
        w.launchAlcm(this, t.pos, t.name);
        this.weapons--;
        this.nextLaunch = w.t + 4;
        if (this.weapons === 0) {
          this.egress = true;
          w.log(`${this.name} weapons away, egressing`, 'info');
        }
      }
    } else {
      // Head out past the start point and off the map.
      this.steer(this.home.x * 2, this.home.y * 2, dt);
      if (Math.hypot(this.pos.x, this.pos.y) > 210000) this.alive = false;
    }
    this.integrate(w, dt);
  }
}

/**
 * Strike fighter: comes in high, drops to treetop height about 95 km out, pops up near the target to release
 * two GNSS-guided glide bombs, then runs for home low. Carries chaff, flares and a jamming pod (`cmPk`).
 */
export class Striker extends Air {
  readonly kind = 'strike' as const;
  readonly side = 'red' as const;
  bombs = 2;
  phase: 'transit' | 'low' | 'popup' | 'egress' = 'transit';
  private readonly home: V3;
  readonly aim: { pos: V3; name: string };

  constructor(name: string, pos: V3, aim: { pos: V3; name: string }) {
    super(name, pos, bearingDeg(pos, aim.pos), 250);
    this.home = clone(pos);
    this.aim = aim;
    this.rcs = 3;
    this.hitRadius = 8;
    this.cmPk = 0.7;
    this.cmdAlt = 8000;
    this.turnRate = 5;
    this.climb = 90;
    this.accel = 12;
  }

  update(w: World, dt: number): void {
    const tgt = this.aim.pos;
    const d = hdist(this.pos, tgt);
    switch (this.phase) {
      case 'transit':
        this.steer(tgt.x, tgt.y, dt);
        if (d < 95000) {
          this.phase = 'low';
          this.tfAgl = 90;
          this.cmdSpd = 280;
          this.climb = 160;
        }
        break;
      case 'low':
        this.steer(tgt.x, tgt.y, dt);
        if (d < 15000) {
          this.phase = 'popup';
          this.tfAgl = null;
          this.cmdAlt = w.terrain.groundAt(this.pos.x, this.pos.y) + 3000;
        }
        break;
      case 'popup':
        this.steer(tgt.x, tgt.y, dt);
        if (d < 10500) {
          for (let i = 0; i < this.bombs; i++) {
            const p = add(tgt, v3(w.rng.gauss() * 30, w.rng.gauss() * 30, 0));
            w.launchBomb(this, p, this.aim.name, i * 0.6);
          }
          this.bombs = 0;
          this.phase = 'egress';
          this.tfAgl = 90;
          this.cmdSpd = 300;
          w.log(`${this.name} bombs away, egressing low`, 'info');
        }
        break;
      case 'egress':
        this.steer(this.home.x, this.home.y, dt);
        if (Math.hypot(this.pos.x, this.pos.y) > 150000) w.retire(this);
        break;
    }
    this.integrate(w, dt);
  }
}

/** Glide bomb: unpowered, GNSS-guided, glides from its release point onto where it believes the target is. */
export class GlideBomb extends Entity {
  readonly kind = 'bomb' as const;
  readonly side = 'red' as const;
  private readonly t0: number;

  constructor(name: string, pos: V3, vel: V3, target: V3, targetName: string, t0: number) {
    super(name, pos);
    this.vel = clone(vel);
    this.target = clone(target);
    this.targetName = targetName;
    this.t0 = t0;
    this.rcs = 0.05;
    this.hitRadius = 1;
    this.munition = true;
    this.warhead = { lethalR: 28, dmg: 45 };
    this.gnssDep = 0.6;
  }

  update(w: World, dt: number): void {
    const aim = sub(this.target!, this.navErr);
    // Glide at a steady 220 m/s along a line that steepens as it closes, with a little lift-limited turn rate.
    const want = scale(norm(sub(aim, this.pos)), 220);
    const k = Math.min(1, dt * 1.5);
    this.vel = v3(this.vel.x + (want.x - this.vel.x) * k, this.vel.y + (want.y - this.vel.y) * k, this.vel.z + (want.z - this.vel.z) * k);
    this.pos = addScaled(this.pos, this.vel, dt);
    const gnd = w.terrain.groundAt(this.pos.x, this.pos.y);
    if (this.pos.z <= gnd + 2 || dist(this.pos, aim) < 8 || w.t - this.t0 > 120) w.detonate(this);
  }
}

/** SEAD fighter: finds emitting radars with ESM and fires anti-radiation missiles at them. */
export class Sead extends Air {
  readonly kind = 'sead' as const;
  readonly side = 'red' as const;
  arms = 2;
  readonly armRange = 80000;
  egress = false;
  private nextEsm = 0;
  private nextLaunch = 0;
  private quiet = 0;
  private emitter: Emitter | null = null;
  private readonly home: V3;

  constructor(name: string, pos: V3) {
    super(name, pos, bearingDeg(pos, v3()), 270);
    this.home = clone(pos);
    this.rcs = 4;
    this.hitRadius = 8;
    this.cmdAlt = 7500;
    this.turnRate = 4;
  }

  private esm(w: World): void {
    const rank = { LR: 0, MR: 1, EW: 1, JAM: 1, SH: 2, CIWS: 3 };
    // Inside our EW jammer's reach the ESM receiver is swamped: it only finds radars close by, and the jammer itself.
    const blinded = w.ewJammed(this.pos);
    let best: Emitter | null = null;
    let score = Infinity;
    for (const e of w.emitters()) {
      if (!e.alive || !e.isEmitting()) continue;
      const d = dist(e.pos, this.pos);
      if (d > (blinded && e.signature !== 'JAM' ? 30000 : 190000) || !w.terrain.los(this.pos, e.pos)) continue;
      const s = rank[e.signature] * 1e6 + d;
      if (s < score) {
        score = s;
        best = e;
      }
    }
    this.emitter = best;
  }

  update(w: World, dt: number): void {
    if (w.t >= this.nextEsm) {
      this.nextEsm = w.t + 2;
      if (!this.egress) this.esm(w);
    }
    if (!this.egress) {
      const em = this.emitter;
      if (em) {
        this.quiet = 0;
        const d = hdist(this.pos, em.pos);
        if (d > this.armRange - 8000) this.steer(em.pos.x, em.pos.y, dt);
        else this.steer(this.pos.x * 2, this.pos.y * 2, dt); // hold off at launch range
        if (d < this.armRange && w.t >= this.nextLaunch && this.arms > 0) {
          w.launchArm(this, em);
          this.arms--;
          this.nextLaunch = w.t + 6;
          if (this.arms === 0) this.egress = true;
        }
      } else {
        // Nothing radiating: hold outside launch range waiting for a radar to come up.
        const d = Math.hypot(this.pos.x, this.pos.y);
        if (d > 95000) this.steer(0, 0, dt);
        else this.steer(this.pos.x * 2, this.pos.y * 2, dt);
        this.quiet += dt;
        if (this.quiet > 150) {
          this.egress = true;
          w.log(`${this.name} found no emitters, egressing`, 'info');
        }
      }
    } else {
      // Head out past the start point and off the map.
      this.steer(this.home.x * 2, this.home.y * 2, dt);
      if (Math.hypot(this.pos.x, this.pos.y) > 210000) this.alive = false;
    }
    this.integrate(w, dt);
  }
}

/** Stand-off jammer flying a racetrack outside SAM range and noise-jamming every friendly radar band. */
export class Soj extends Air {
  readonly kind = 'soj' as const;
  readonly side = 'red' as const;
  private readonly legs: [V3, V3];
  private leg = 0;

  constructor(name: string, center: V3, bearingFromCenter: number) {
    const across = bearingFromCenter + 90;
    const a = add(center, polar(across, 22000));
    const b = add(center, polar(across + 180, 22000));
    super(name, v3(a.x, a.y, 9500), across + 180, 210);
    this.legs = [a, b];
    this.rcs = 15;
    this.hitRadius = 14;
    this.cmdAlt = 9500;
    this.turnRate = 2.5;
    this.jammer = { erpW: 4.0e5, bwMHz: 400, loGHz: 2, hiGHz: 18, active: true };
  }

  update(w: World, dt: number): void {
    const p = this.legs[this.leg];
    if (hdist(this.pos, p) < 3000) this.leg = 1 - this.leg;
    this.steer(p.x, p.y, dt);
    this.integrate(w, dt);
  }
}

/** A ground position the enemy has seen (unit id, where, what). */
export interface Sighting {
  uid: number;
  x: number;
  y: number;
  name: string;
}

/**
 * Enemy reconnaissance drone: flies high to a stand-off orbit about 32 km from the airbase, photographs every
 * unit it can see within 40 km, then flies home. Its pictures only count if it gets away.
 */
export class ReconDrone extends Air {
  readonly kind = 'drone' as const;
  readonly side = 'red' as const;
  readonly photos = new Map<number, Sighting>();
  private readonly orbit: V3;
  private readonly home: V3;
  private phase: 'inbound' | 'orbit' | 'egress' = 'inbound';
  private orbitUntil = 0;
  private nextPhoto = 0;

  constructor(name: string, start: V3, orbit: V3) {
    super(name, start, bearingDeg(start, orbit), 70);
    this.home = clone(start);
    this.orbit = clone(orbit);
    this.recon = true;
    this.rcs = 0.3;
    this.hitRadius = 4;
    this.cmdAlt = 9000;
    this.turnRate = 3;
  }

  update(w: World, dt: number): void {
    if (this.phase === 'inbound') {
      this.steer(this.orbit.x, this.orbit.y, dt);
      if (hdist(this.pos, this.orbit) < 4000) {
        this.phase = 'orbit';
        this.orbitUntil = w.t + 300;
      }
    } else if (this.phase === 'orbit') {
      // Circle the orbit point by steering a little ahead along the tangent.
      const a = bearingDeg(this.orbit, this.pos) + 25;
      const p = add(this.orbit, polar(a, 6000));
      this.steer(p.x, p.y, dt);
      if (w.t >= this.orbitUntil) this.phase = 'egress';
    } else {
      this.steer(this.home.x, this.home.y, dt);
      if (hdist(this.pos, this.home) < 5000) {
        w.reconHome(this);
        return;
      }
    }
    // Our EW jammer swamps its imaging radar and downlink: no pictures inside its reach.
    if (this.phase !== 'inbound' && w.t >= this.nextPhoto && !w.ewJammed(this.pos)) {
      this.nextPhoto = w.t + 5;
      for (const f of w.fielded) {
        const site = f.sites[0];
        if (!site?.alive || hdist(site.pos, this.pos) > 40000 || !w.terrain.los(this.pos, site.pos)) continue;
        if (!this.photos.has(f.unit.uid)) this.photos.set(f.unit.uid, { uid: f.unit.uid, x: Math.round(site.pos.x), y: Math.round(site.pos.y), name: w.unitName(f) });
      }
    }
    this.integrate(w, dt);
  }

  /** Photographs so far, as the enemy would get them if the drone escaped now. */
  get seen(): Sighting[] {
    return [...this.photos.values()];
  }
}

/** Civil airliner on an airway. Squawks Mode 3/C unless its transponder has failed. */
export class Airliner extends Air {
  readonly kind = 'airliner' as const;
  readonly side = 'neutral' as const;
  private readonly exit: V3;

  constructor(name: string, from: V3, to: V3, transponder: boolean) {
    super(name, v3(from.x, from.y, 10500), bearingDeg(from, to), 235);
    this.exit = clone(to);
    this.rcs = 40;
    this.hitRadius = 25;
    this.cmdAlt = 10500;
    this.iff = transponder ? 'M3C' : null;
    this.turnRate = 1.5;
  }

  update(w: World, dt: number): void {
    this.steer(this.exit.x, this.exit.y, dt);
    this.integrate(w, dt);
    if (hdist(this.pos, this.exit) < 4000) this.alive = false;
  }
}
