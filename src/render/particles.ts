import * as THREE from 'three';

/** Everything a particle does over its life, set once at spawn. Colours may exceed 1 (HDR, feeds bloom). */
export interface ParticleSpec {
  x: number;
  y: number;
  z: number;
  vx?: number;
  vy?: number;
  vz?: number;
  life: number;
  size0: number;
  size1: number;
  alpha?: number;
  /** Colour at birth and at death (linear RGB). */
  c0: [number, number, number];
  c1?: [number, number, number];
  /** Fraction of velocity lost per second. */
  drag?: number;
  /** Vertical acceleration (m/s^2): positive for hot smoke, negative for debris. */
  lift?: number;
  /** Minimum on-screen size in pixels, so bright sources stay visible from far away. */
  minPx?: number;
  /** How strongly the particle drifts with the wind (0..1). */
  windK?: number;
}

const VERT = /* glsl */ `
attribute vec4 pdata;
attribute vec3 pcolor;
uniform float uScale;
varying vec4 vColor;
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  float dist = max(-mvPosition.z, 1.0);
  // Exaggerate distant particles a little (up to 2x at 25 km) so smoke and bursts still read from the overview.
  float px = pdata.x * uScale / dist * mix(1.0, 2.0, smoothstep(3000.0, 25000.0, dist));
  float a = pdata.y;
  float minPx = pdata.z;
  if (minPx < 0.5) a *= clamp(px, 0.0, 1.0);
  gl_PointSize = clamp(px, max(minPx, 1.0), 2048.0);
  vColor = vec4(pcolor, a);
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}`;

const FRAG = /* glsl */ `
uniform sampler2D map;
varying vec4 vColor;
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  vec4 t = texture2D(map, gl_PointCoord);
  gl_FragColor = vec4(vColor.rgb * t.rgb, vColor.a * t.a);
  if (gl_FragColor.a < 0.003) discard;
  #include <fog_fragment>
}`;

/** A fixed-capacity CPU particle pool drawn as one point cloud. */
export class ParticlePool {
  readonly points: THREE.Points;
  readonly material: THREE.ShaderMaterial;
  n = 0;
  private readonly cap: number;
  private readonly p: Float32Array;
  private readonly v: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly sz: Float32Array;
  private readonly a0: Float32Array;
  private readonly c: Float32Array;
  private readonly phys: Float32Array;
  private readonly gpos: Float32Array;
  private readonly gcol: Float32Array;
  private readonly gdat: Float32Array;

  constructor(cap: number, map: THREE.Texture, additive: boolean) {
    this.cap = cap;
    this.p = new Float32Array(cap * 3);
    this.v = new Float32Array(cap * 3);
    this.age = new Float32Array(cap);
    this.life = new Float32Array(cap);
    this.sz = new Float32Array(cap * 2);
    this.a0 = new Float32Array(cap);
    this.c = new Float32Array(cap * 6);
    this.phys = new Float32Array(cap * 4);
    this.gpos = new Float32Array(cap * 3);
    this.gcol = new Float32Array(cap * 3);
    this.gdat = new Float32Array(cap * 4);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.gpos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('pcolor', new THREE.BufferAttribute(this.gcol, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('pdata', new THREE.BufferAttribute(this.gdat, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { map: { value: null }, uScale: { value: 500 } }]),
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      fog: !additive,
    });
    this.material.uniforms.map.value = map;
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 3 : 2;
  }

  get full(): boolean {
    return this.n >= this.cap;
  }

  spawn(s: ParticleSpec): void {
    if (this.n >= this.cap) return;
    const i = this.n++;
    this.p[i * 3] = s.x;
    this.p[i * 3 + 1] = s.y;
    this.p[i * 3 + 2] = s.z;
    this.v[i * 3] = s.vx ?? 0;
    this.v[i * 3 + 1] = s.vy ?? 0;
    this.v[i * 3 + 2] = s.vz ?? 0;
    this.age[i] = 0;
    this.life[i] = s.life;
    this.sz[i * 2] = s.size0;
    this.sz[i * 2 + 1] = s.size1;
    this.a0[i] = s.alpha ?? 1;
    const c1 = s.c1 ?? s.c0;
    this.c.set(s.c0, i * 6);
    this.c.set(c1, i * 6 + 3);
    this.phys[i * 4] = s.drag ?? 0;
    this.phys[i * 4 + 1] = s.lift ?? 0;
    this.phys[i * 4 + 2] = s.minPx ?? 0;
    this.phys[i * 4 + 3] = s.windK ?? 1;
  }

  clear(): void {
    this.n = 0;
    this.points.geometry.setDrawRange(0, 0);
  }

  private kill(i: number): void {
    const j = --this.n;
    if (i === j) return;
    this.p.copyWithin(i * 3, j * 3, j * 3 + 3);
    this.v.copyWithin(i * 3, j * 3, j * 3 + 3);
    this.age[i] = this.age[j];
    this.life[i] = this.life[j];
    this.sz.copyWithin(i * 2, j * 2, j * 2 + 2);
    this.a0[i] = this.a0[j];
    this.c.copyWithin(i * 6, j * 6, j * 6 + 6);
    this.phys.copyWithin(i * 4, j * 4, j * 4 + 4);
  }

  /** Advance by dt seconds of sim time (0 while paused) and upload to the GPU. */
  update(dt: number, windX: number, windZ: number): void {
    for (let i = 0; i < this.n; i++) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        this.kill(i);
        i--;
        continue;
      }
      if (dt > 0) {
        const drag = Math.exp(-this.phys[i * 4] * dt);
        const wk = this.phys[i * 4 + 3];
        const o = i * 3;
        this.v[o] = (this.v[o] - windX * wk) * drag + windX * wk;
        this.v[o + 1] = this.v[o + 1] * drag + this.phys[i * 4 + 1] * dt;
        this.v[o + 2] = (this.v[o + 2] - windZ * wk) * drag + windZ * wk;
        this.p[o] += this.v[o] * dt;
        this.p[o + 1] += this.v[o + 1] * dt;
        this.p[o + 2] += this.v[o + 2] * dt;
      }
    }
    for (let i = 0; i < this.n; i++) {
      const k = this.age[i] / this.life[i];
      const grow = 1 - (1 - k) * (1 - k) * (1 - k) * (1 - k);
      const fadeIn = Math.min(1, k * 25);
      const fade = (1 - k) * (1 - k * 0.5);
      this.gpos[i * 3] = this.p[i * 3];
      this.gpos[i * 3 + 1] = this.p[i * 3 + 1];
      this.gpos[i * 3 + 2] = this.p[i * 3 + 2];
      const o = i * 6;
      this.gcol[i * 3] = this.c[o] + (this.c[o + 3] - this.c[o]) * k;
      this.gcol[i * 3 + 1] = this.c[o + 1] + (this.c[o + 4] - this.c[o + 1]) * k;
      this.gcol[i * 3 + 2] = this.c[o + 2] + (this.c[o + 5] - this.c[o + 2]) * k;
      this.gdat[i * 4] = this.sz[i * 2] + (this.sz[i * 2 + 1] - this.sz[i * 2]) * grow;
      this.gdat[i * 4 + 1] = this.a0[i] * fadeIn * fade;
      this.gdat[i * 4 + 2] = this.phys[i * 4 + 2];
    }
    const g = this.points.geometry;
    g.setDrawRange(0, this.n);
    for (const name of ['position', 'pcolor', 'pdata']) {
      const a = g.getAttribute(name) as THREE.BufferAttribute;
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.n * a.itemSize);
      a.needsUpdate = true;
    }
  }
}
