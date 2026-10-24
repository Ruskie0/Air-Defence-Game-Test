import * as THREE from 'three';
import type { Entity } from '../sim/entities';
import { clamp } from '../sim/math';
import type { Terrain } from '../sim/terrain';
import type { Effects } from './effects';
import { CHARRED_MAT, WRECK_SIZE } from './models';

const G = 9.81;
/** Terminal velocity of each falling wreck in m/s; aircraft break up and tumble, so they fall slower than intact. */
const TERMINAL: Record<string, number> = { bomb: 200, recon: 70, drone: 40, arm: 160, cruise: 150, tbm: 260 };
const AIRCRAFT_TERMINAL = 120;
/** Wrecks on the ground are removed this long after landing (sim seconds). */
const KEEP_S = 300;
const MAX_WRECKS = 80;

const rnd = Math.random;
const sym = (a: number): number => (rnd() * 2 - 1) * a;

interface Wreck {
  obj: THREE.Object3D;
  size: number;
  /** Position and velocity in the three.js frame (y up). */
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  /** Quadratic drag coefficient, g / vt^2. */
  drag: number;
  /** Aircraft roll into a spiral along their flight path; munitions tumble freely. */
  spiral: boolean;
  spin: THREE.Vector3;
  roll: number;
  age: number;
  /** Sim seconds on the ground, or -1 while falling. */
  landed: number;
  burnS: number;
  ground: number;
  trail: { t: number };
  fire: { t: number };
}

/**
 * Shot-down aircraft and munitions: the model keeps its momentum, falls under gravity and drag while
 * burning, crashes with a fireball, and lies charred and smoking on the ground for a few minutes.
 * Driven by sim time, so wrecks freeze while paused.
 */
export class Wrecks {
  private readonly list: Wreck[] = [];
  private readonly group = new THREE.Group();
  private readonly fx: Effects;
  private readonly v = new THREE.Vector3();

  constructor(scene: THREE.Scene, fx: Effects) {
    this.fx = fx;
    scene.add(this.group);
  }

  /** Take over the body of a killed entity; `at` is its last drawn position. */
  add(e: Entity, body: THREE.Object3D, at: THREE.Vector3): void {
    const munition = e.munition;
    const kind = e.recon ? 'recon' : e.kind;
    const vt = TERMINAL[kind] ?? (munition ? 150 : AIRCRAFT_TERMINAL);
    // The sim's death record holds the state at the moment of the kill; older builds fall back to the entity.
    const fate = (e as { fate?: { pos?: Entity['pos']; vel?: Entity['vel'] } | null }).fate;
    const p = fate?.pos ?? e.pos;
    const v0 = fate?.vel ?? e.vel;
    body.position.set(p.x, p.z, -p.y);
    if (!Number.isFinite(body.position.y)) body.position.copy(at);
    // The blast throws the wreck off its line a little.
    const vel = new THREE.Vector3(v0.x, v0.z, -v0.y).multiplyScalar(0.8 + rnd() * 0.2);
    const kick = Math.min(40, vel.length() * 0.15 + 8);
    vel.add(this.v.set(sym(kick), sym(kick) * 0.6, sym(kick)));
    const spinK = e.kind === 'drone' ? 2.5 : munition ? 3 : 1;
    this.group.add(body);
    this.list.push({
      obj: body,
      size: WRECK_SIZE[kind] ?? (munition ? 1 : 1.6),
      pos: body.position,
      vel,
      drag: G / (vt * vt),
      spiral: !munition,
      spin: new THREE.Vector3(sym(spinK), sym(spinK), sym(spinK)),
      roll: sym(2.5) + (rnd() < 0.5 ? -1.2 : 1.2),
      age: 0,
      landed: -1,
      burnS: 0,
      ground: 0,
      trail: { t: 0 },
      fire: { t: 0 },
    });
    while (this.list.length > MAX_WRECKS) this.remove(this.oldestIndex());
  }

  update(dt: number, terrain: Terrain, cam: THREE.Vector3): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const w = this.list[i];
      const s = w.landed < 0 ? clamp(cam.distanceTo(w.pos) / 1400, 1, 80) : clamp(cam.distanceTo(w.pos) / 1400, 1, 20);
      w.obj.scale.set(s, w.landed < 0 ? s : s * 0.55, s);
      if (dt <= 0) continue;
      w.age += dt;
      if (w.landed >= 0) {
        w.landed += dt;
        const k = w.landed < w.burnS * 0.6 ? 1 : clamp(1 - (w.landed - w.burnS * 0.6) / (w.burnS * 0.4), 0, 1);
        const smoulder = w.landed < w.burnS + 40 ? Math.max(k, 0.12) : 0;
        this.fx.groundFire(w.pos.x, w.ground, w.pos.z, w.size, smoulder, dt, w.fire);
        if (w.landed > KEEP_S) this.remove(i);
        continue;
      }
      this.fall(w, dt);
      const ground = terrain.groundAt(w.pos.x, -w.pos.z);
      if (w.pos.y <= ground) {
        this.land(w, ground, terrain.waterAt(w.pos.x, -w.pos.z));
        if (w.landed < 0) this.remove(i);
        continue;
      }
      // Give up on anything still falling after four minutes (a ballistic missile killed very high).
      if (w.age > 240) this.remove(i);
      else this.fx.wreckTrail(w.pos.x, w.pos.y, w.pos.z, w.size, dt, w.trail);
    }
  }

  reset(): void {
    for (let i = this.list.length - 1; i >= 0; i--) this.remove(i);
  }

  private fall(w: Wreck, dt: number): void {
    const steps = Math.ceil(dt / 0.05);
    const h = dt / steps;
    for (let k = 0; k < steps; k++) {
      const sp = w.vel.length();
      const a = w.drag * sp;
      w.vel.x -= a * w.vel.x * h;
      w.vel.z -= a * w.vel.z * h;
      w.vel.y -= (a * w.vel.y + G) * h;
      w.pos.addScaledVector(w.vel, h);
    }
    if (w.spiral) {
      // Nose follows the flight path while the airframe rolls.
      w.obj.lookAt(this.v.copy(w.pos).add(w.vel));
      w.obj.rotateZ(w.roll * w.age);
    } else {
      w.obj.rotateX(w.spin.x * dt);
      w.obj.rotateY(w.spin.y * dt);
      w.obj.rotateZ(w.spin.z * dt);
    }
  }

  /** Crash: fireball and dirt, then the wreck lies flattened and charred, burning for a while. Lost at sea it sinks. */
  private land(w: Wreck, ground: number, water: boolean): void {
    w.pos.y = ground;
    this.fx.crash(w.pos.x, ground, w.pos.z, w.size, water);
    if (water) return;
    w.landed = 0;
    w.ground = ground;
    w.burnS = 40 + 25 * w.size + rnd() * 20;
    const yaw = Math.atan2(w.vel.x, w.vel.z);
    w.obj.rotation.set(sym(0.12), yaw, sym(0.35), 'YXZ');
    w.obj.traverse((o) => {
      if (o instanceof THREE.Mesh) o.material = CHARRED_MAT;
    });
  }

  private oldestIndex(): number {
    let best = 0;
    for (let i = 1; i < this.list.length; i++) if (this.list[i].landed > this.list[best].landed) best = i;
    return best;
  }

  private remove(i: number): void {
    this.group.remove(this.list[i].obj);
    this.list.splice(i, 1);
  }
}
