import * as THREE from 'three';
import type { Entity } from '../sim/entities';
import type { Effect, World } from '../sim/world';
import type { FrameEvents } from './events';
import { vnoise } from './noise';
import { ParticlePool, ParticleSpec } from './particles';

type RGB = [number, number, number];

function canvasTex(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d')!, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const glowTex = canvasTex(64, (g, s) => {
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.2, 'rgba(255,255,255,0.75)');
  grd.addColorStop(0.5, 'rgba(255,255,255,0.22)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
});

/** Lumpy smoke puff: overlapping soft blobs with a noisy alpha. */
const smokeTex = canvasTex(128, (g, s) => {
  const img = g.createImageData(s, s);
  for (let j = 0; j < s; j++) {
    for (let i = 0; i < s; i++) {
      const x = (i + 0.5) / s - 0.5;
      const y = (j + 0.5) / s - 0.5;
      const r = Math.hypot(x, y) * 2;
      const n = vnoise(i / 14, j / 14, 5) * 0.6 + vnoise(i / 6, j / 6, 6) * 0.4;
      const a = Math.max(0, 1 - r * (0.8 + n * 0.5)) ** 1.4;
      const shade = 0.82 + 0.18 * (1 - y - 0.5) * n;
      const o = (j * s + i) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = 255 * Math.min(1, shade);
      img.data[o + 3] = 255 * a;
    }
  }
  g.putImageData(img, 0, 0);
});

const WIND_X = 5;
const WIND_Z = -2.5;

const rnd = Math.random;
const sym = (a: number): number => (rnd() * 2 - 1) * a;

interface Debris {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  life: number;
  nextSmoke: number;
  fire: boolean;
}

const MISSILE_SMOKE: Record<string, { s0: number; s1: number; life: number; flame: number }> = {
  LR: { s0: 10, s1: 75, life: 35, flame: 9 },
  MR: { s0: 8, s1: 60, life: 30, flame: 7 },
  SH: { s0: 5, s1: 36, life: 18, flame: 4 },
  AAM: { s0: 4, s1: 40, life: 24, flame: 4 },
};

const CONTRAIL_KINDS = new Set(['fighter', 'bomber', 'sead', 'soj', 'airliner']);

/** Smoke, fire, debris, contrails and tracers, all driven by sim time so they freeze when paused. */
export class Effects {
  private readonly fire = new ParticlePool(7000, glowTex, true);
  private readonly smoke = new ParticlePool(16000, smokeTex, false);
  private readonly tracers: THREE.LineSegments;
  private readonly trPos: Float32Array;
  private readonly trCol: Float32Array;
  private readonly debris: Debris[] = [];
  private readonly lastEmit = new Map<number, { x: number; y: number; z: number }>();
  private readonly siteAcc = new Map<object, number>();
  private readonly v = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    scene.add(this.smoke.points, this.fire.points);
    const cap = 3000;
    this.trPos = new Float32Array(cap * 6);
    this.trCol = new Float32Array(cap * 6);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.trPos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.trCol, 3).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    this.tracers = new THREE.LineSegments(
      g,
      new THREE.LineBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false }),
    );
    this.tracers.frustumCulled = false;
    this.tracers.renderOrder = 4;
    scene.add(this.tracers);
  }

  /** Point-size scale: drawing-buffer height over the vertical field of view. */
  setViewport(heightPx: number, fovDeg: number): void {
    const k = heightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
    this.fire.material.uniforms.uScale.value = k;
    this.smoke.material.uniforms.uScale.value = k;
  }

  reset(): void {
    this.fire.clear();
    this.smoke.clear();
    this.debris.length = 0;
    this.lastEmit.clear();
    this.siteAcc.clear();
  }

  update(w: World, ev: FrameEvents, visible: (e: Entity) => boolean): void {
    if (ev.reset) this.reset();
    const dt = Math.min(ev.simDt, 0.5);
    for (const m of ev.launches) if (m.spec.code !== 'AAM') this.launchCloud(m.trail[0] ?? m.pos);
    for (const f of ev.blasts) this.explosion(w, f);
    this.exhaust(w, dt);
    this.aircraft(w, dt, visible);
    this.burning(w, dt);
    this.updateDebris(w, dt);
    this.guns(w, dt);
    this.fire.update(dt, WIND_X, WIND_Z);
    this.smoke.update(dt, WIND_X, WIND_Z);
  }

  // ---------------------------------------------------------------- emitters

  private puff(s: ParticleSpec): void {
    this.smoke.spawn(s);
  }

  private flash(x: number, y: number, z: number, size: number, life: number, c: RGB, minPx = 0): void {
    this.fire.spawn({ x, y, z, life, size0: size, size1: size * 1.4, c0: c, c1: [c[0] * 0.2, c[1] * 0.1, c[2] * 0.05], minPx, windK: 0 });
  }

  private launchCloud(p: { x: number; y: number; z: number }): void {
    const x = p.x;
    const y = p.z;
    const z = -p.y;
    this.flash(x, y + 3, z, 35, 0.35, [12, 7, 3], 6);
    for (let i = 0; i < 44; i++) {
      const a = rnd() * Math.PI * 2;
      const sp = 8 + rnd() * 30;
      this.puff({
        x: x + sym(4),
        y: y + rnd() * 6,
        z: z + sym(4),
        vx: Math.cos(a) * sp,
        vy: 1 + rnd() * 5,
        vz: Math.sin(a) * sp,
        life: 18 + rnd() * 14,
        size0: 14 + rnd() * 10,
        size1: 70 + rnd() * 60,
        alpha: 0.6,
        c0: [0.62, 0.58, 0.5],
        c1: [0.7, 0.69, 0.66],
        drag: 0.6,
        lift: 0.4,
      });
    }
  }

  private explosion(w: World, f: Effect): void {
    const x = f.pos.x;
    const y = f.pos.z;
    const z = -f.pos.y;
    const ground = w.terrain.groundAt(f.pos.x, f.pos.y);
    const low = y - ground < 90;
    const scale = f.kind === 'small' ? 1 : f.kind === 'blast' ? 2.2 : 4;
    this.flash(x, y, z, 30 * scale, 0.14, [20, 13, 7], 10);
    this.flash(x, y, z, 55 * scale, 0.45, [1.6, 0.8, 0.3], 0);
    const nFire = f.kind === 'small' ? 8 : f.kind === 'blast' ? 26 : 55;
    for (let i = 0; i < nFire; i++) {
      this.v.set(sym(1), low ? rnd() : sym(1), sym(1)).normalize().multiplyScalar((4 + rnd() * 16) * scale);
      this.fire.spawn({
        x,
        y,
        z,
        vx: this.v.x,
        vy: this.v.y,
        vz: this.v.z,
        life: (0.45 + rnd() * 0.5) * Math.sqrt(scale),
        size0: 9 * scale,
        size1: (26 + rnd() * 18) * scale,
        c0: [9, 4.5, 1.6],
        c1: [0.5, 0.12, 0.02],
        drag: 1.8,
        lift: 6,
        windK: 0.3,
      });
    }
    const nSmoke = f.kind === 'small' ? 9 : f.kind === 'blast' ? 20 : 34;
    for (let i = 0; i < nSmoke; i++) {
      this.v.set(sym(1), low ? rnd() * 0.6 : sym(1), sym(1)).normalize().multiplyScalar((2 + rnd() * 7) * scale);
      this.puff({
        x: x + sym(4 * scale),
        y: y + sym(4 * scale),
        z: z + sym(4 * scale),
        vx: this.v.x,
        vy: this.v.y,
        vz: this.v.z,
        life: (14 + rnd() * 10) * (f.kind === 'small' ? 1 : 1.6),
        size0: 16 * scale,
        size1: (55 + rnd() * 30) * scale,
        alpha: 0.8,
        minPx: 2.5,
        c0: [0.07, 0.065, 0.06],
        c1: [0.3, 0.3, 0.31],
        drag: 0.9,
        lift: f.kind === 'small' ? 0.3 : 1.2,
      });
    }
    const nSpark = f.kind === 'small' ? 22 : 45;
    for (let i = 0; i < nSpark; i++) {
      this.v.set(sym(1), sym(1) + (low ? 0.6 : 0), sym(1)).normalize().multiplyScalar(70 + rnd() * 160);
      this.fire.spawn({
        x,
        y,
        z,
        vx: this.v.x,
        vy: this.v.y,
        vz: this.v.z,
        life: 0.8 + rnd() * 1.4,
        size0: 2,
        size1: 1,
        c0: [7, 4, 1.4],
        c1: [1.6, 0.3, 0.02],
        drag: 0.7,
        lift: -9.8,
        minPx: 1.6,
        windK: 0,
      });
    }
    if (f.kind !== 'small') {
      const nDeb = f.kind === 'blast' ? 4 + Math.floor(rnd() * 4) : 8;
      for (let i = 0; i < nDeb; i++) {
        this.v.set(sym(1), rnd() * 0.8 + 0.1, sym(1)).normalize().multiplyScalar(30 + rnd() * 70);
        this.debris.push({ x, y, z, vx: this.v.x, vy: this.v.y, vz: this.v.z, age: 0, life: 3 + rnd() * 8, nextSmoke: 0, fire: rnd() < 0.7 });
      }
    }
    if (low) this.dust(x, ground, z, scale, f.kind === 'big' || f.kind === 'ground');
  }

  /** Dust ring and, for heavy warheads, a rising smoke column. */
  private dust(x: number, ground: number, z: number, scale: number, column: boolean): void {
    for (let i = 0; i < 16 * scale; i++) {
      const a = rnd() * Math.PI * 2;
      const sp = (25 + rnd() * 40) * scale;
      this.puff({
        x,
        y: ground + 4,
        z,
        vx: Math.cos(a) * sp,
        vy: 2 + rnd() * 6,
        vz: Math.sin(a) * sp,
        life: 16 + rnd() * 12,
        size0: 10 * scale,
        size1: (40 + rnd() * 30) * scale,
        alpha: 0.6,
        c0: [0.42, 0.36, 0.28],
        c1: [0.55, 0.52, 0.47],
        drag: 1.4,
        lift: 0.3,
      });
    }
    if (!column) return;
    for (let i = 0; i < 26; i++) {
      this.puff({
        x: x + sym(30),
        y: ground + rnd() * 60,
        z: z + sym(30),
        vx: sym(3),
        vy: 12 + rnd() * 20,
        vz: sym(3),
        life: 40 + rnd() * 25,
        size0: 40,
        size1: 180 + rnd() * 90,
        alpha: 0.75,
        c0: [0.06, 0.055, 0.05],
        c1: [0.33, 0.33, 0.34],
        drag: 0.25,
        lift: 1.5,
      });
    }
  }

  private updateDebris(w: World, dt: number): void {
    if (dt <= 0) return;
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.age += dt;
      const drag = Math.exp(-0.35 * dt);
      d.vx *= drag;
      d.vz *= drag;
      d.vy = d.vy * drag - 9.8 * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.z += d.vz * dt;
      const ground = w.terrain.groundAt(d.x, -d.z);
      if (d.y <= ground || d.age > d.life * 3) {
        if (d.y <= ground + 5) this.dust(d.x, ground, d.z, 0.4, false);
        this.debris.splice(i, 1);
        continue;
      }
      const burning = d.age < d.life;
      d.nextSmoke -= dt;
      while (d.nextSmoke <= 0) {
        d.nextSmoke += burning ? 0.07 : 0.2;
        this.puff({
          x: d.x,
          y: d.y,
          z: d.z,
          life: burning ? 10 : 6,
          size0: 4,
          size1: burning ? 28 : 16,
          alpha: burning ? 0.6 : 0.3,
          c0: [0.09, 0.085, 0.08],
          c1: [0.35, 0.35, 0.36],
          drag: 0.5,
          lift: 0.6,
        });
      }
      if (burning && d.fire) {
        this.fire.spawn({ x: d.x, y: d.y, z: d.z, life: Math.max(0.12, dt * 1.6), size0: 6, size1: 4, c0: [8, 3.6, 1], minPx: 2.2, windK: 0 });
      }
    }
  }

  /** Rocket motor smoke and flame while each interceptor is boosting. */
  private exhaust(w: World, dt: number): void {
    const seen = new Set<number>();
    for (const m of w.missiles) {
      seen.add(m.id);
      const cfg = MISSILE_SMOKE[m.spec.code] ?? MISSILE_SMOKE.MR;
      const x = m.pos.x;
      const y = m.pos.z;
      const z = -m.pos.y;
      const last = this.lastEmit.get(m.id);
      const burning = w.t - m.t0 < m.spec.boostT;
      if (!last) {
        this.lastEmit.set(m.id, { x, y, z });
        continue;
      }
      if (!burning) {
        this.lastEmit.set(m.id, { x, y, z });
        continue;
      }
      const dx = x - last.x;
      const dy = y - last.y;
      const dz = z - last.z;
      const seg = Math.hypot(dx, dy, dz);
      const spacing = Math.max(cfg.s0 * 0.7, seg / 40);
      const n = Math.floor(seg / spacing);
      if (n > 0) {
        for (let k = 1; k <= n; k++) {
          const f = k / n;
          this.puff({
            x: last.x + dx * f + sym(1),
            y: last.y + dy * f + sym(1),
            z: last.z + dz * f + sym(1),
            vx: sym(1.5),
            vy: sym(1.5),
            vz: sym(1.5),
            life: cfg.life * (0.8 + rnd() * 0.4),
            size0: Math.max(cfg.s0, spacing * 0.9),
            size1: cfg.s1 * (0.8 + rnd() * 0.4),
            alpha: 0.55,
            c0: [0.95, 0.94, 0.9],
            c1: [0.78, 0.79, 0.81],
            drag: 0.4,
            minPx: 1.5,
          });
        }
        this.lastEmit.set(m.id, { x, y, z });
      }
      const sp = Math.max(1, Math.hypot(m.vel.x, m.vel.y, m.vel.z));
      const bx = x - (m.vel.x / sp) * 3;
      const by = y - (m.vel.z / sp) * 3;
      const bz = z + (m.vel.y / sp) * 3;
      const life = Math.max(0.05, dt * 1.5);
      this.fire.spawn({ x: bx, y: by, z: bz, life, size0: cfg.flame, size1: cfg.flame, c0: [14, 8, 3.5], minPx: 4, windK: 0 });
      this.fire.spawn({ x: bx, y: by, z: bz, life, size0: cfg.flame * 4, size1: cfg.flame * 4, alpha: 0.5, c0: [1.6, 0.8, 0.3], windK: 0 });
    }
    for (const id of this.lastEmit.keys()) if (!seen.has(id) && id > 0) this.lastEmit.delete(id);
  }

  /** Contrails at altitude and re-entry glow on ballistic missiles. Entity ids are stored negated. */
  private aircraft(w: World, dt: number, visible: (e: Entity) => boolean): void {
    const seen = new Set<number>();
    for (const e of w.entities) {
      if (!e.alive || !visible(e)) continue;
      const contrail = CONTRAIL_KINDS.has(e.kind) && e.pos.z > 7800;
      const tbm = e.kind === 'tbm' && e.pos.z < 70000 && e.speed > 900;
      if (!contrail && !tbm) continue;
      const key = -e.id;
      seen.add(key);
      const x = e.pos.x;
      const y = e.pos.z;
      const z = -e.pos.y;
      if (tbm) this.fire.spawn({ x, y, z, life: Math.max(0.05, dt * 1.5), size0: 14, size1: 14, c0: [12, 6, 2.5], minPx: 4, windK: 0 });
      const last = this.lastEmit.get(key);
      if (!last) {
        this.lastEmit.set(key, { x, y, z });
        continue;
      }
      const seg = Math.hypot(x - last.x, y - last.y, z - last.z);
      const spacing = Math.max(tbm ? 150 : 70, seg / 10);
      const n = Math.floor(seg / spacing);
      if (n === 0) continue;
      for (let k = 1; k <= n; k++) {
        const f = k / n;
        this.puff({
          x: last.x + (x - last.x) * f,
          y: last.y + (y - last.y) * f,
          z: last.z + (z - last.z) * f,
          life: tbm ? 20 : 70,
          size0: tbm ? 10 : 6,
          size1: tbm ? 50 : 75,
          alpha: tbm ? 0.3 : 0.32,
          c0: [0.98, 0.98, 1],
          c1: [0.9, 0.92, 0.96],
          drag: 0.2,
        });
      }
      this.lastEmit.set(key, { x, y, z });
    }
    for (const id of this.lastEmit.keys()) if (id < 0 && !seen.has(id)) this.lastEmit.delete(id);
  }

  /** Destroyed sites keep burning: a fire at the base and a smoke column drifting downwind. */
  private burning(w: World, dt: number): void {
    if (dt <= 0) return;
    let count = 0;
    for (const s of w.sites) {
      if (s.alive || count++ > 24) continue;
      const big = s.radius > 100;
      const acc = (this.siteAcc.get(s) ?? 0) + dt;
      const step = big ? 0.12 : 0.3;
      let k = Math.floor(acc / step);
      this.siteAcc.set(s, acc - k * step);
      const g = w.terrain.groundAt(s.pos.x, s.pos.y);
      const spread = big ? s.radius * 0.5 : Math.max(4, s.radius * 0.6);
      for (; k > 0; k--) {
        const x = s.pos.x + sym(spread);
        const z = -s.pos.y + sym(spread);
        this.puff({
          x,
          y: g + 5,
          z,
          vx: sym(2),
          vy: 5 + rnd() * 6,
          vz: sym(2),
          life: 45 + rnd() * 20,
          size0: big ? 30 : 12,
          size1: big ? 240 : 120,
          alpha: 0.72,
          c0: [0.05, 0.045, 0.04],
          c1: [0.3, 0.3, 0.31],
          drag: 0.3,
          lift: 1.6,
        });
        for (let f = 0; f < 3; f++) {
          this.fire.spawn({
            x: x + sym(spread * 0.3),
            y: g + 2,
            z: z + sym(spread * 0.3),
            vx: sym(2),
            vy: 4 + rnd() * 8,
            vz: sym(2),
            life: 0.6 + rnd() * 0.8,
            size0: big ? 22 : 9,
            size1: big ? 10 : 4,
            c0: [6, 2.6, 0.7],
            c1: [0.6, 0.1, 0.01],
            minPx: 1.5,
            windK: 0.4,
          });
        }
      }
    }
  }

  // ---------------------------------------------------------------- wrecks

  /**
   * Fire and a thick smoke trail behind a falling wreck. `acc` carries the emission clock between frames;
   * size is about 1 for a cruise missile and 3 for an airliner.
   */
  wreckTrail(x: number, y: number, z: number, size: number, dt: number, acc: { t: number }): void {
    if (dt <= 0) return;
    acc.t += dt;
    const step = 0.06 / Math.sqrt(size);
    for (; acc.t >= step; acc.t -= step) {
      this.puff({
        x: x + sym(size),
        y: y + sym(size),
        z: z + sym(size),
        vx: sym(1.5),
        vy: sym(1.5),
        vz: sym(1.5),
        life: 22 + rnd() * 14,
        size0: 5 * size,
        size1: (30 + rnd() * 20) * size,
        alpha: 0.75,
        minPx: 1.5,
        c0: [0.05, 0.045, 0.04],
        c1: [0.28, 0.28, 0.29],
        drag: 0.6,
        lift: 0.5,
      });
    }
    const life = Math.max(0.08, dt * 1.6);
    this.fire.spawn({ x, y, z, life, size0: 7 * size, size1: 5 * size, c0: [9, 4, 1.1], minPx: 3, windK: 0 });
    this.fire.spawn({ x: x + sym(size), y: y + sym(size), z: z + sym(size), life: life * 2, size0: 12 * size, size1: 4 * size, alpha: 0.6, c0: [3, 1.1, 0.25], windK: 0 });
  }

  /** A wreck hits the ground (or the sea): fuel fireball, dirt and debris, or a splash. */
  crash(x: number, g: number, z: number, size: number, water: boolean): void {
    if (water) {
      for (let i = 0; i < 30 * size; i++) {
        const a = rnd() * Math.PI * 2;
        const sp = (2 + rnd() * 8) * size;
        this.puff({
          x,
          y: g + 1,
          z,
          vx: Math.cos(a) * sp,
          vy: (10 + rnd() * 25) * Math.sqrt(size),
          vz: Math.sin(a) * sp,
          life: 3 + rnd() * 3,
          size0: 3 * size,
          size1: (12 + rnd() * 10) * size,
          alpha: 0.85,
          c0: [0.95, 0.97, 1],
          c1: [0.85, 0.88, 0.9],
          drag: 0.8,
          lift: -9.8,
        });
      }
      return;
    }
    const s = 0.7 + size * 0.6;
    this.flash(x, g + 3, z, 26 * s, 0.2, [18, 10, 4], 6);
    for (let i = 0; i < 14 + 10 * size; i++) {
      this.v.set(sym(1), rnd() * 0.9 + 0.1, sym(1)).normalize().multiplyScalar((5 + rnd() * 12) * s);
      this.fire.spawn({
        x,
        y: g + 2,
        z,
        vx: this.v.x,
        vy: this.v.y,
        vz: this.v.z,
        life: (0.8 + rnd() * 0.9) * Math.sqrt(s),
        size0: 10 * s,
        size1: (24 + rnd() * 16) * s,
        c0: [8, 3.8, 1.2],
        c1: [0.45, 0.1, 0.02],
        drag: 1.6,
        lift: 5,
        windK: 0.3,
      });
    }
    for (let i = 0; i < 8 + 6 * size; i++) {
      this.puff({
        x: x + sym(4 * s),
        y: g + 3 + rnd() * 6 * s,
        z: z + sym(4 * s),
        vx: sym(3),
        vy: 4 + rnd() * 8,
        vz: sym(3),
        life: 18 + rnd() * 12,
        size0: 14 * s,
        size1: (50 + rnd() * 30) * s,
        alpha: 0.8,
        c0: [0.05, 0.045, 0.04],
        c1: [0.3, 0.3, 0.31],
        drag: 0.8,
        lift: 1,
      });
    }
    this.dust(x, g, z, Math.min(1.6, 0.35 + size * 0.35), false);
    if (size >= 1) {
      for (let i = 0; i < Math.round(size * 2); i++) {
        this.v.set(sym(1), 0.5 + rnd() * 0.6, sym(1)).normalize().multiplyScalar(20 + rnd() * 35);
        this.debris.push({ x, y: g + 2, z, vx: this.v.x, vy: this.v.y, vz: this.v.z, age: 0, life: 1.5 + rnd() * 3, nextSmoke: 0, fire: true });
      }
    }
  }

  /** A wreck burning on the ground; k fades from 1 (fully alight) to 0 (cold). */
  groundFire(x: number, g: number, z: number, size: number, k: number, dt: number, acc: { t: number }): void {
    if (dt <= 0 || k <= 0) return;
    acc.t += dt;
    const step = (0.2 / Math.sqrt(size)) / Math.max(0.15, k);
    const spread = 1.5 * size;
    for (; acc.t >= step; acc.t -= step) {
      this.puff({
        x: x + sym(spread),
        y: g + 2,
        z: z + sym(spread),
        vx: sym(1.5),
        vy: 3 + rnd() * 4,
        vz: sym(1.5),
        life: 30 + rnd() * 20,
        size0: 6 * size,
        size1: (40 + rnd() * 30) * size,
        alpha: 0.45 + 0.3 * k,
        c0: k > 0.4 ? [0.05, 0.045, 0.04] : [0.2, 0.2, 0.2],
        c1: [0.32, 0.32, 0.33],
        drag: 0.3,
        lift: 1.2,
      });
      if (k > 0.3) {
        for (let f = 0; f < 2; f++) {
          this.fire.spawn({
            x: x + sym(spread * 0.6),
            y: g + 0.5,
            z: z + sym(spread * 0.6),
            vx: sym(1),
            vy: 2 + rnd() * 4,
            vz: sym(1),
            life: 0.5 + rnd() * 0.6,
            size0: 4 * size * k,
            size1: 1.5 * size,
            c0: [6, 2.6, 0.7],
            c1: [0.6, 0.1, 0.01],
            minPx: 1.2,
            windK: 0.4,
          });
        }
      }
    }
  }

  /** CIWS tracer streaks, muzzle flash and gun smoke. */
  private guns(w: World, dt: number): void {
    let n = 0;
    const max = this.trPos.length / 6;
    for (const c of w.ciws) {
      if (c.firing && c.site.alive) {
        const g = c.gun;
        const az = (c.aimAz * Math.PI) / 180;
        const el = (c.aimEl * Math.PI) / 180;
        const fx = Math.sin(az) * Math.cos(el);
        const fy = Math.cos(az) * Math.cos(el);
        const fz = Math.sin(el);
        const x = g.x + fx * 3;
        const y = g.z + fz * 3;
        const z = -(g.y + fy * 3);
        this.fire.spawn({ x, y, z, life: Math.max(0.04, dt * 1.2), size0: 3.5, size1: 3.5, c0: [16, 9, 3.5], minPx: 3, windK: 0 });
        this.puff({ x, y, z, vx: fx * 6, vy: fz * 6 + 1, vz: -fy * 6, life: 4, size0: 2, size1: 16, alpha: 0.25, c0: [0.6, 0.6, 0.6], drag: 0.8 });
      }
      for (const r of c.rounds) {
        if (!r.tracer || n >= max) continue;
        const o = n * 6;
        this.trPos[o] = r.pos.x;
        this.trPos[o + 1] = r.pos.z;
        this.trPos[o + 2] = -r.pos.y;
        this.trPos[o + 3] = r.pos.x - r.vel.x * 0.035;
        this.trPos[o + 4] = r.pos.z - r.vel.z * 0.035;
        this.trPos[o + 5] = -(r.pos.y - r.vel.y * 0.035);
        // Tracer compound burns out after about 3 s of flight.
        const k = Math.max(0, 1 - (w.t - r.t0) / 3.2);
        this.trCol[o] = 9 * k;
        this.trCol[o + 1] = 3 * k;
        this.trCol[o + 2] = 0.8 * k;
        this.trCol[o + 3] = this.trCol[o + 4] = this.trCol[o + 5] = 0;
        n++;
      }
    }
    const g = this.tracers.geometry;
    g.setDrawRange(0, n * 2);
    (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }
}
