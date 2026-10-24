import * as THREE from 'three';
import type { WeatherId } from '../campaign/weather';
import { clamp, smoothstep } from '../sim/math';
import type { Terrain } from '../sim/terrain';
import type { World } from '../sim/world';
import type { Effects } from './effects';
import { tileNoise } from './noise';
import type { SkyRig } from './terrain3d';

/**
 * The day's weather on screen: sky and light, haze, a ground fog layer, the cloud deck, rain, lightning and
 * blowing dust. Presentation only; what the weather does to the battle lives in campaign/weather.ts.
 */

// ---------------------------------------------------------------- ground fog

/**
 * Ground fog shared by every fogged material: density at the base height (1/m), scale height (m) and base
 * height (m, three.js y). The density falls off exponentially with height, so fog fills the low ground and
 * aircraft above it stay clear. A plain object (not a Vector3) so cloned material uniforms all share it.
 */
const GROUND_FOG = { x: 0, y: 150, z: 0 };

for (const shader of Object.values(THREE.ShaderLib)) {
  if ('fogDensity' in shader.uniforms) shader.uniforms.groundFog = { value: GROUND_FOG };
}
(THREE.UniformsLib.fog as Record<string, THREE.IUniform>).groundFog = { value: GROUND_FOG };

THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogWorld;
#endif`;

THREE.ShaderChunk.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  // The view matrix is a rigid transform, so its inverse rotation is the transpose.
  vFogWorld = cameraPosition + transpose( mat3( viewMatrix ) ) * mvPosition.xyz;
#endif`;

THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  uniform vec3 groundFog;
  varying float vFogDepth;
  varying vec3 vFogWorld;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif`;

THREE.ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  if ( groundFog.x > 0.0 ) {
    // Optical depth along the ray through density a * exp(-(h - base) / H), integrated in closed form.
    float lo = - 2.0;
    float hc = max( ( cameraPosition.y - groundFog.z ) / groundFog.y, lo );
    float hp = max( ( vFogWorld.y - groundFog.z ) / groundFog.y, lo );
    float dh = hp - hc;
    float avg = abs( dh ) < 1e-3 ? exp( - hc ) : ( exp( - hc ) - exp( - hp ) ) / dh;
    float tau = groundFog.x * length( vFogWorld - cameraPosition ) * avg;
    fogFactor = 1.0 - ( 1.0 - fogFactor ) * exp( - tau );
  }
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif`;

// ---------------------------------------------------------------- looks

interface Look {
  zenith: string;
  horizon: string;
  below: string;
  sunCol: string;
  sun: number;
  hemi: number;
  /** Haze (FogExp2) multiplier near the ground. */
  haze: number;
  /** Ground fog density at the base (1/m) and scale height (m). */
  fog: [number, number];
  /** Cloud deck: height above the base (m), cover 0..1, colour seen from below. */
  cloud: { alt: number; cover: number; color: string } | null;
  /** Rain strength 0..1 and how wet the ground looks 0..1. */
  rain: number;
  wet: number;
  /** Smoke drift multiplier and blowing dust 0..1. */
  wind: number;
  dust: number;
  lightning: boolean;
}

const CLEAR: Look = {
  zenith: '#3f6ea8',
  horizon: '#aebfcc',
  below: '#9aa89f',
  sunCol: '#fff1d6',
  sun: 2.6,
  hemi: 0.7,
  haze: 1,
  fog: [0, 150],
  cloud: null,
  rain: 0,
  wet: 0,
  wind: 1,
  dust: 0,
  lightning: false,
};

const LOOKS: Record<WeatherId, Look> = {
  clear: CLEAR,
  overcast: {
    ...CLEAR,
    zenith: '#77818c',
    horizon: '#aeb4b9',
    below: '#8b928d',
    sunCol: '#2c2a26',
    sun: 0.9,
    hemi: 1.3,
    haze: 1.8,
    fog: [1 / 9000, 300],
    cloud: { alt: 1600, cover: 0.85, color: '#9aa1a8' },
    wind: 1.5,
  },
  rain: {
    ...CLEAR,
    zenith: '#5c6570',
    horizon: '#8d959c',
    below: '#78807b',
    sunCol: '#141414',
    sun: 0.45,
    hemi: 1.15,
    haze: 3,
    fog: [1 / 3200, 280],
    cloud: { alt: 1100, cover: 0.95, color: '#7b838a' },
    rain: 0.6,
    wet: 0.75,
    wind: 2,
  },
  fog: {
    ...CLEAR,
    zenith: '#a6aeb4',
    horizon: '#c5cbce',
    below: '#b5bbbc',
    sunCol: '#3a362e',
    sun: 0.8,
    hemi: 1.25,
    haze: 2.5,
    fog: [1 / 520, 140],
    wet: 0.2,
    wind: 0.3,
  },
  wind: {
    ...CLEAR,
    zenith: '#4a78ad',
    horizon: '#c0b9a4',
    below: '#a29c86',
    sun: 2.4,
    hemi: 0.75,
    haze: 2,
    fog: [1 / 12000, 450],
    cloud: { alt: 2400, cover: 0.45, color: '#c3c8cd' },
    wind: 4,
    dust: 1,
  },
  storm: {
    ...CLEAR,
    zenith: '#2d333b',
    horizon: '#5f666d',
    below: '#525853',
    sunCol: '#0a0a0a',
    sun: 0.22,
    hemi: 0.75,
    haze: 4,
    fog: [1 / 2400, 300],
    cloud: { alt: 900, cover: 1, color: '#4b525a' },
    rain: 1,
    wet: 0.9,
    wind: 4.5,
    lightning: true,
  },
};

// ---------------------------------------------------------------- cloud texture

const CLOUD_TILE = 14000;
const cloudTex = new Map<number, THREE.CanvasTexture>();

/** A tiling cloud layer: fractal noise thresholded by cover, alpha in the texture. */
function cloudTexture(cover: number): THREE.CanvasTexture {
  const hit = cloudTex.get(cover);
  if (hit) return hit;
  const s = 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  const img = g.createImageData(s, s);
  const edge = 1 - cover;
  for (let j = 0; j < s; j++) {
    for (let i = 0; i < s; i++) {
      let n = 0;
      let amp = 0.5;
      let norm = 0;
      for (let o = 0; o < 5; o++) {
        const p = 4 << o;
        n += amp * tileNoise((i / s) * p, (j / s) * p, p, 71 + o * 13);
        norm += amp;
        amp *= 0.5;
      }
      n /= norm;
      const a = smoothstep(edge * 0.75 + 0.12, edge * 0.75 + 0.42, n);
      const shade = 0.8 + 0.2 * n;
      const k = (j * s + i) * 4;
      img.data[k] = img.data[k + 1] = img.data[k + 2] = 255 * shade;
      img.data[k + 3] = 255 * a;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  cloudTex.set(cover, t);
  return t;
}

// ---------------------------------------------------------------- view

const RAIN_N = 5000;
const RAIN_R = 110;
const RAIN_H = 80;
const rnd = Math.random;
const sym = (a: number): number => (rnd() * 2 - 1) * a;

export class WeatherView {
  /** Haze multiplier for updateHaze. */
  haze = 1;
  private look = CLEAR;
  private base = 0;
  private readonly cloud: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly cloudBelow = new THREE.Color();
  private readonly cloudAbove = new THREE.Color('#c9ced2');
  private readonly rain: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private readonly drops = new Float32Array(RAIN_N * 3);
  private readonly rainPos = new Float32Array(RAIN_N * 6);
  private rainSeeded = false;
  private readonly bolt: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private boltT = -1;
  private nextStrike = 6;
  private flash = 0;
  private hemi = 0.7;
  /** The look the sky was last painted with. */
  private painted: Look | null = null;

  constructor(
    scene: THREE.Scene,
    private readonly sky: SkyRig,
  ) {
    this.cloud = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true }),
    );
    this.cloud.renderOrder = -1;
    this.cloud.frustumCulled = false;
    this.cloud.visible = false;
    scene.add(this.cloud);

    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(this.rainPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.rain = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0xc8d0d8, transparent: true, opacity: 0.4, depthWrite: false, fog: false }));
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    scene.add(this.rain);

    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(64 * 6), 3).setUsage(THREE.DynamicDrawUsage));
    this.bolt = new THREE.LineSegments(bg, new THREE.LineBasicMaterial({ color: new THREE.Color(9, 9, 12), transparent: true, depthWrite: false, fog: false }));
    this.bolt.frustumCulled = false;
    this.bolt.visible = false;
    scene.add(this.bolt);
  }

  /** Set up a world's weather: sky, light, fog, clouds and how wet the ground is. */
  apply(w: World, terrainMesh: THREE.Mesh | null, fx: Effects): void {
    const L = LOOKS[w.weatherId] ?? CLEAR;
    const sky = this.sky;
    // Fog settles relative to the defended area's ground, so valleys fill and high ground pokes out.
    const assets = w.sites.filter((s) => s.kind === 'asset');
    this.base = assets.length ? assets.reduce((a, s) => a + w.terrain.groundAt(s.pos.x, s.pos.y), 0) / assets.length : w.terrain.groundAt(0, 0);
    if (L !== this.painted) {
      this.painted = L;
      sky.colors.zenith.set(L.zenith);
      sky.colors.horizon.set(L.horizon);
      sky.colors.below.set(L.below);
      sky.colors.sunCol.set(L.sunCol);
      sky.fog.color.set(L.horizon);
      sky.refresh();
    }
    this.look = L;
    sky.sun.intensity = L.sun;
    sky.hemi.intensity = this.hemi = L.hemi;
    this.haze = L.haze;
    GROUND_FOG.x = L.fog[0];
    GROUND_FOG.y = L.fog[1];
    GROUND_FOG.z = this.base;

    const half = w.terrain.half;
    if (L.cloud) {
      const m = this.cloud.material;
      m.map = cloudTexture(L.cloud.cover);
      m.map.repeat.setScalar((half * 4) / CLOUD_TILE);
      m.needsUpdate = true;
      this.cloudBelow.set(L.cloud.color);
      this.cloud.scale.set(half * 4, 1, half * 4);
      this.cloud.position.set(0, this.base + L.cloud.alt, 0);
    }
    this.cloud.visible = !!L.cloud;

    const mat = terrainMesh?.material;
    if (mat instanceof THREE.MeshStandardMaterial) {
      mat.color.setScalar(1 - 0.3 * L.wet);
      mat.roughness = 0.95 - 0.4 * L.wet;
    }
    fx.wind.x = 5 * L.wind;
    fx.wind.z = -2.5 * L.wind;
    this.nextStrike = 4 + rnd() * 6;
    this.rainSeeded = false;
  }

  /**
   * Animate rain, clouds, lightning and dust. `dt` is real time while the sim runs and 0 while paused, so
   * the weather freezes with everything else. Returns lightning strikes (three.js positions) for thunder.
   */
  update(dt: number, cam: THREE.Camera, target: THREE.Vector3, terrain: Terrain, w: World, fx: Effects): THREE.Vector3[] {
    const L = this.look;
    const cp = cam.position;
    const agl = cp.y - terrain.groundAt(cp.x, -cp.z);
    const strikes: THREE.Vector3[] = [];

    if (L.cloud) {
      // Seen from below the deck is solid grey; from above it thins to a pale veil so the battle stays visible.
      const above = smoothstep(-200, 400, cp.y - this.cloud.position.y);
      const m = this.cloud.material;
      m.opacity = L.cloud.cover * (1 - 0.86 * above);
      m.color.copy(this.cloudBelow).lerp(this.cloudAbove, above);
      if (this.flash > 0) m.color.multiplyScalar(1 + 2.5 * this.flash);
      if (m.map && dt > 0) {
        m.map.offset.x += (dt * 2 * this.cloudSpeed().x) / CLOUD_TILE;
        m.map.offset.y -= (dt * 2 * this.cloudSpeed().z) / CLOUD_TILE;
      }
    }

    this.updateRain(dt, cp, agl);

    if (L.lightning && dt > 0) {
      this.nextStrike -= dt;
      if (this.nextStrike <= 0) {
        this.nextStrike = 5 + rnd() * 12;
        strikes.push(this.strike(target, terrain));
      }
    }
    if (this.boltT >= 0) {
      this.boltT += dt;
      // Two or three return strokes flicker over a quarter of a second.
      const on = this.boltT < 0.07 || (this.boltT > 0.12 && this.boltT < 0.17) || (this.boltT > 0.24 && this.boltT < 0.3);
      this.bolt.visible = on;
      this.flash = on ? 1 : Math.max(0, 1 - (this.boltT - 0.3) * 4);
      if (this.boltT > 0.6) {
        this.boltT = -1;
        this.bolt.visible = false;
        this.flash = 0;
      }
    }
    this.sky.hemi.intensity = this.hemi + 3 * this.flash;

    if (L.dust > 0 && agl < 20000) fx.windDust(w, target.x, target.z, dt, L.dust);
    return strikes;
  }

  private cloudSpeed(): { x: number; z: number } {
    return { x: 5 * this.look.wind, z: -2.5 * this.look.wind };
  }

  /** Streaks in a box that travels with the camera; they wrap around it rather than respawning. */
  private updateRain(dt: number, cp: THREE.Vector3, agl: number): void {
    const L = this.look;
    const k = L.rain * (1 - smoothstep(600, 2500, agl));
    this.rain.visible = k > 0.01;
    if (!this.rain.visible) return;
    const d = this.drops;
    if (!this.rainSeeded) {
      for (let i = 0; i < RAIN_N; i++) {
        d[i * 3] = cp.x + sym(RAIN_R);
        d[i * 3 + 1] = cp.y + sym(RAIN_H);
        d[i * 3 + 2] = cp.z + sym(RAIN_R);
      }
      this.rainSeeded = true;
    }
    const n = Math.round(RAIN_N * L.rain);
    const vx = 1.2 * L.wind;
    const vz = -0.6 * L.wind;
    const vy = -9.5;
    const len = 0.11;
    const p = this.rainPos;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      d[o] += vx * dt;
      d[o + 1] += vy * dt;
      d[o + 2] += vz * dt;
      d[o] = cp.x + wrap(d[o] - cp.x, RAIN_R);
      d[o + 1] = cp.y + wrap(d[o + 1] - cp.y, RAIN_H);
      d[o + 2] = cp.z + wrap(d[o + 2] - cp.z, RAIN_R);
      const q = i * 6;
      p[q] = d[o];
      p[q + 1] = d[o + 1];
      p[q + 2] = d[o + 2];
      p[q + 3] = d[o] - vx * len;
      p[q + 4] = d[o + 1] - vy * len;
      p[q + 5] = d[o + 2] - vz * len;
    }
    const g = this.rain.geometry;
    g.setDrawRange(0, n * 2);
    g.attributes.position.needsUpdate = true;
    this.rain.material.opacity = 0.42 * clamp(k / Math.max(L.rain, 1e-3), 0, 1);
  }

  /** A cloud-to-ground stroke somewhere within about 25 km of where the camera looks. */
  private strike(target: THREE.Vector3, terrain: Terrain): THREE.Vector3 {
    const a = rnd() * Math.PI * 2;
    const r = 2000 + rnd() * 23000;
    const x = target.x + Math.cos(a) * r;
    const z = target.z + Math.sin(a) * r;
    const g = terrain.groundAt(x, -z);
    const top = Math.max(this.cloud.position.y, g + 400);
    const pos = this.bolt.geometry.attributes.position as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    let n = 0;
    const seg = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void => {
      if (n >= 64) return;
      arr.set([x0, y0, z0, x1, y1, z1], n * 6);
      n++;
    };
    // Main channel: a jagged walk down to the ground, with a couple of forks that die out.
    const steps = 30;
    let px = x + sym(300);
    let py = top;
    let pz = z + sym(300);
    const jag = (top - g) / steps;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const nx = i === steps ? x : px + sym(jag * 0.9) + (x - px) * 0.15;
      const nz = i === steps ? z : pz + sym(jag * 0.9) + (z - pz) * 0.15;
      const ny = top + (g - top) * t;
      seg(px, py, pz, nx, ny, nz);
      if ((i === 8 || i === 15) && n < 56) {
        let bx = nx;
        let by = ny;
        let bz = nz;
        const dir = sym(1);
        for (let j = 0; j < 7; j++) {
          const cx = bx + dir * jag * (0.6 + rnd()) + sym(jag * 0.4);
          const cz = bz + sym(jag);
          const cy = by - jag * (0.5 + rnd() * 0.5);
          seg(bx, by, bz, cx, cy, cz);
          bx = cx;
          by = cy;
          bz = cz;
        }
      }
      px = nx;
      py = ny;
      pz = nz;
    }
    this.bolt.geometry.setDrawRange(0, n * 2);
    pos.needsUpdate = true;
    this.boltT = 0;
    return new THREE.Vector3(x, (g + top) / 2, z);
  }
}

/** Wrap an offset into [-r, r), however far the camera jumped. */
const wrap = (v: number, r: number): number => v - 2 * r * Math.floor((v + r) / (2 * r));
