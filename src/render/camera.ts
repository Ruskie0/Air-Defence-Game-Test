import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const PAN_KEYS: Record<string, [number, number]> = {
  KeyW: [1, 0],
  ArrowUp: [1, 0],
  KeyS: [-1, 0],
  ArrowDown: [-1, 0],
  KeyA: [0, -1],
  ArrowLeft: [0, -1],
  KeyD: [0, 1],
  ArrowRight: [0, 1],
};
const OTHER_KEYS = new Set(['KeyQ', 'KeyE', 'KeyR', 'KeyF', 'ShiftLeft', 'ShiftRight']);

const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * RTS-style keyboard camera on top of OrbitControls: WASD/arrows pan over the ground, Q/E rotate,
 * R/F zoom, Shift for speed. Keeps the pivot on the terrain and the camera above it, and animates view changes.
 */
export class CameraRig {
  /** Called when the player moves the camera by hand (cancels track follow). */
  onManual: () => void = () => {};
  onHome: () => void = () => {};
  /** While following a track the pivot is in the air, so do not pull it to the ground. */
  following = false;
  private readonly keys = new Set<string>();
  private readonly vel = new THREE.Vector3();
  private fly: { p0: THREE.Vector3; t0: THREE.Vector3; p1: THREE.Vector3; t1: THREE.Vector3; k: number; dur: number } | null = null;
  private readonly fwd = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly off = new THREE.Vector3();

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly controls: OrbitControls,
    /** Ground height at a three.js (x, z) position. */
    private readonly ground: (x: number, z: number) => number,
  ) {
    controls.screenSpacePanning = false;
    controls.zoomToCursor = true;
    controls.addEventListener('start', () => {
      this.fly = null;
    });
    const typing = (e: KeyboardEvent): boolean => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.ctrlKey || e.metaKey || e.altKey;
    };
    window.addEventListener('keydown', (e) => {
      if (typing(e)) return;
      if (e.code === 'Home') {
        this.onHome();
        e.preventDefault();
        return;
      }
      if (e.code in PAN_KEYS || OTHER_KEYS.has(e.code)) {
        this.keys.add(e.code);
        if (e.code.startsWith('Arrow')) e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  /** Animate to a new camera position and pivot. */
  flyTo(pos: THREE.Vector3, target: THREE.Vector3, dur = 1.3): void {
    this.fly = { p0: this.camera.position.clone(), t0: this.controls.target.clone(), p1: pos.clone(), t1: target.clone(), k: 0, dur };
  }

  /** Call once per frame with real (not sim) seconds, before controls.update(). */
  update(dt: number): void {
    dt = Math.min(dt, 0.1);
    const cam = this.camera;
    const tgt = this.controls.target;
    let fx = 0;
    let fr = 0;
    for (const k of this.keys) {
      const p = PAN_KEYS[k];
      if (p) {
        fx += p[0];
        fr += p[1];
      }
    }
    const fast = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 3 : 1;
    const rot = (this.keys.has('KeyQ') ? 1 : 0) - (this.keys.has('KeyE') ? 1 : 0);
    const zoom = (this.keys.has('KeyF') ? 1 : 0) - (this.keys.has('KeyR') ? 1 : 0);
    const manual = fx !== 0 || fr !== 0 || rot !== 0 || zoom !== 0;
    if (manual) {
      this.fly = null;
      this.onManual();
    }

    if (this.fly) {
      const f = this.fly;
      f.k = Math.min(1, f.k + dt / f.dur);
      const e = ease(f.k);
      cam.position.lerpVectors(f.p0, f.p1, e);
      tgt.lerpVectors(f.t0, f.t1, e);
      // Arc up a little on long moves so the camera does not skim the terrain.
      cam.position.y += Math.sin(f.k * Math.PI) * f.p0.distanceTo(f.p1) * 0.15;
      if (f.k >= 1) this.fly = null;
    }

    const dist = cam.position.distanceTo(tgt);
    this.fwd.set(tgt.x - cam.position.x, 0, tgt.z - cam.position.z);
    if (this.fwd.lengthSq() < 1e-6) this.fwd.set(0, 0, -1);
    this.fwd.normalize();
    this.right.set(-this.fwd.z, 0, this.fwd.x);
    const speed = THREE.MathUtils.clamp(dist * 0.9, 250, 80000) * fast;
    const want = this.off.set(0, 0, 0).addScaledVector(this.fwd, fx * speed).addScaledVector(this.right, fr * speed);
    if (fx && fr) want.multiplyScalar(Math.SQRT1_2);
    this.vel.lerp(want, Math.min(1, dt * 9));
    if (this.vel.lengthSq() > 1) {
      cam.position.addScaledVector(this.vel, dt);
      tgt.addScaledVector(this.vel, dt);
      const lim = 130000;
      const cx = THREE.MathUtils.clamp(tgt.x, -lim, lim) - tgt.x;
      const cz = THREE.MathUtils.clamp(tgt.z, -lim, lim) - tgt.z;
      tgt.x += cx;
      tgt.z += cz;
      cam.position.x += cx;
      cam.position.z += cz;
    }
    if (rot) {
      this.off.subVectors(cam.position, tgt).applyAxisAngle(Y, rot * 1.3 * fast * dt);
      cam.position.copy(tgt).add(this.off);
    }
    if (zoom) {
      this.off.subVectors(cam.position, tgt);
      const d = THREE.MathUtils.clamp(this.off.length() * Math.exp(zoom * 1.6 * fast * dt), this.controls.minDistance, this.controls.maxDistance);
      this.off.setLength(d);
      cam.position.copy(tgt).add(this.off);
    }

    // Keep the pivot on the ground (it drifts off when panning over hills) unless following a track.
    if (!this.following && !this.fly) {
      const g = this.ground(tgt.x, tgt.z);
      const dy = (g - tgt.y) * Math.min(1, dt * 4);
      tgt.y += dy;
      cam.position.y += dy;
    }
  }

  /** Call after controls.update(): never let the camera sink into the terrain. */
  clampAboveGround(): void {
    const cam = this.camera.position;
    const g = this.ground(cam.x, cam.z) + 25;
    if (cam.y < g) cam.y = g;
  }
}

const Y = new THREE.Vector3(0, 1, 0);
