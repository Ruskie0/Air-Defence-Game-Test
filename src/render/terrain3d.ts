import * as THREE from 'three';
import { clamp, smoothstep } from '../sim/math';
import { Terrain, valleyX } from '../sim/terrain';
import { fbm, hash2, prng, tileNoise, vnoise } from './noise';
import { buildBuildings, buildTrees } from './scatter';

/**
 * Presentation-only scenery: sky, lighting, land cover, water, trees and towns.
 * The terrain mesh uses the simulation heightmap unchanged, so line of sight on screen matches the sim;
 * everything else here is decoration.
 */

/** Afternoon sun from the south-west, as a three.js direction (x east, y up, z south). */
export const SUN_DIR = (() => {
  const az = 215 * (Math.PI / 180);
  const el = 36 * (Math.PI / 180);
  return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
})();

/** Haze colour at the horizon, shared by fog and the far edge of the world. */
export const HAZE = new THREE.Color('#aebfcc');

const SKY_VS = `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const SKY_FS = `
uniform vec3 zenith;
uniform vec3 horizon;
uniform vec3 below;
uniform vec3 sunDir;
uniform vec3 sunCol;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 c = mix(horizon, zenith, pow(clamp(h, 0.0, 1.0), 0.5));
  c = mix(c, below, smoothstep(0.0, -0.06, h));
  float s = max(dot(d, sunDir), 0.0);
  c += sunCol * (pow(s, 6.0) * 0.18 + pow(s, 80.0) * 0.5) * smoothstep(-0.1, 0.05, h);
  c += sunCol * smoothstep(0.99955, 0.9998, s) * 6.0;
  gl_FragColor = vec4(c, 1.0);
}`;

/**
 * A clear afternoon sky: a gradient from haze at the horizon to blue overhead, with the sun.
 * Kept below the bloom threshold apart from the sun disc, so the sky never glows.
 */
export function buildSky(renderer: THREE.WebGLRenderer, scene: THREE.Scene): void {
  const mat = new THREE.ShaderMaterial({
    vertexShader: SKY_VS,
    fragmentShader: SKY_FS,
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      zenith: { value: new THREE.Color('#3f6ea8') },
      horizon: { value: HAZE.clone() },
      below: { value: new THREE.Color('#9aa89f') },
      sunDir: { value: SUN_DIR.clone() },
      sunCol: { value: new THREE.Color('#fff1d6') },
    },
  });
  const skyScene = new THREE.Scene();
  skyScene.add(new THREE.Mesh(new THREE.SphereGeometry(1000, 64, 32), mat));

  const cube = new THREE.WebGLCubeRenderTarget(512, { type: THREE.HalfFloatType });
  const cubeCam = new THREE.CubeCamera(1, 5000, cube);
  cubeCam.update(renderer, skyScene);
  scene.background = cube.texture;
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(skyScene, 0, 1, 5000).texture;
  scene.environmentIntensity = 0.5;
  pmrem.dispose();

  scene.fog = new THREE.FogExp2(HAZE.getHex(), 1e-5);
  scene.add(new THREE.HemisphereLight(0xc6d8ea, 0x5d5443, 0.7));
  const sun = new THREE.DirectionalLight(0xfff0d8, 2.6);
  sun.position.copy(SUN_DIR).multiplyScalar(100000);
  scene.add(sun);
}

/** Aerial perspective is a low-level effect: thin the haze as the camera climbs so the overview stays clear. */
export function updateHaze(scene: THREE.Scene, cameraY: number): void {
  const f = scene.fog as THREE.FogExp2 | null;
  if (f) f.density = 1.15e-5 / (1 + Math.max(0, cameraY) / 22000);
}

// ---------------------------------------------------------------- land cover

/** Land-cover texture size: about 80-100 m per texel on the 160 km and 300 km maps. */
const texSize = (t: Terrain): number => (t.half > 100000 ? 3072 : 2048);

type RGB = [number, number, number];
const hex = (h: string): RGB => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const C = {
  deep: hex('#183745'),
  shallow: hex('#3d6d70'),
  sand: hex('#c4b58a'),
  grass: hex('#6a7a3c'),
  grass2: hex('#83894b'),
  scrub: hex('#7a7350'),
  forest: hex('#2b3f22'),
  forest2: hex('#3a4c27'),
  rock: hex('#776f63'),
  rock2: hex('#8f897f'),
  alpine: hex('#7a8256'),
  snow: hex('#eef1f4'),
  town: hex('#8d8981'),
  town2: hex('#a69d8e'),
};
const CROPS: RGB[] = ['#a89a62', '#6c7c40', '#7f8a4c', '#77684f', '#958f66', '#b0a752', '#5d6f36', '#8c7d58', '#868d58'].map(hex);

export interface Town {
  x: number;
  y: number;
  r: number;
}

const GRID = 513;

/** Shared land-cover rules, so the texture and the 3D trees and buildings agree. */
class LandCover {
  readonly towns: Town[] = [];
  /** Low-frequency noise fields cached on a coarse grid (they vary over kilometres, the texture over 80 m). */
  private readonly forestN = new Float32Array(GRID * GRID);
  private readonly farmN = new Float32Array(GRID * GRID);
  private readonly scrubN = new Float32Array(GRID * GRID);

  constructor(
    readonly t: Terrain,
    readonly seed: number,
  ) {
    const step = (2 * t.half) / (GRID - 1);
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const x = -t.half + i * step;
        const y = -t.half + j * step;
        const k = j * GRID + i;
        this.forestN[k] = fbm(x / 4300, y / 4300, 4, seed + 101);
        this.farmN[k] = fbm(x / 11000, y / 11000, 3, seed + 55);
        this.scrubN[k] = fbm(x / 7000, y / 7000, 2, seed + 13);
      }
    }
    this.placeTowns();
  }

  private sample(f: Float32Array, x: number, y: number): number {
    const step = (2 * this.t.half) / (GRID - 1);
    const gx = clamp((x + this.t.half) / step, 0, GRID - 1.0001);
    const gy = clamp((y + this.t.half) / step, 0, GRID - 1.0001);
    const i = Math.floor(gx);
    const j = Math.floor(gy);
    const fx = gx - i;
    const fy = gy - j;
    const k = j * GRID + i;
    const a = f[k] + (f[k + 1] - f[k]) * fx;
    const b = f[k + GRID] + (f[k + GRID + 1] - f[k + GRID]) * fx;
    return a + (b - a) * fy;
  }

  scrub(x: number, y: number): number {
    return this.sample(this.scrubN, x, y);
  }

  slopeAt(x: number, y: number): number {
    const d = 120;
    const t = this.t;
    return Math.hypot(t.heightAt(x + d, y) - t.heightAt(x - d, y), t.heightAt(x, y + d) - t.heightAt(x, y - d)) / (2 * d);
  }

  /** > 0 inside forest. */
  forest(x: number, y: number, h: number, slope: number): number {
    if (h < 12 || h > 1950) return -1;
    const n = this.sample(this.forestN, x, y);
    const elev = smoothstep(60, 500, h) * 0.16 - smoothstep(1500, 1950, h) * 0.5;
    return n + elev + Math.min(slope, 0.5) * 0.45 - 0.6 - this.townness(x, y) * 0.6;
  }

  /** True where the plains are farmed. */
  farm(x: number, y: number, h: number, slope: number): boolean {
    return h > 8 && h < 650 && slope < 0.11 && this.sample(this.farmN, x, y) > 0.33;
  }

  townness(x: number, y: number): number {
    let best = 0;
    for (const tw of this.towns) {
      const d = Math.hypot(x - tw.x, y - tw.y) / tw.r;
      if (d < 1.6) best = Math.max(best, 1 - smoothstep(0.55, 1.4, d + (vnoise(x / 500, y / 500, this.seed + 3) - 0.5) * 0.5));
    }
    return best;
  }

  private placeTowns(): void {
    const rnd = prng(this.seed ^ 0x51ed);
    for (let i = 0; i < 5000 && this.towns.length < 13; i++) {
      const x = (rnd() * 2 - 1) * 72000;
      const y = (rnd() * 2 - 1) * 72000;
      const h = this.t.heightAt(x, y);
      if (h < 12 || h > 420 || this.slopeAt(x, y) > 0.04) continue;
      if (Math.hypot(x, y) < 6500) continue;
      if (this.towns.some((tw) => Math.hypot(tw.x - x, tw.y - y) < 10000)) continue;
      const big = this.towns.length < 2;
      this.towns.push({ x, y, r: big ? 2200 + rnd() * 600 : 800 + rnd() * 900 });
    }
  }
}

/** Newer terrains carry their pass valleys and orientation; the original map has them as fixed functions. */
interface TerrainFeatures {
  seed?: number;
  valleys?: { x: number; y: number }[][];
  layout?: { rot: number };
}

/** Each pass river: down its valley to the plain, then meandering on towards the sea. */
function riverPaths(t: Terrain): [number, number][][] {
  const f = t as unknown as TerrainFeatures;
  if (f.valleys && f.layout) {
    // The sea lies opposite the mountains: rot is the bearing of the mountain side (0 = north).
    const away = ((f.layout.rot + 180) * Math.PI) / 180;
    const dx = Math.sin(away);
    const dy = Math.cos(away);
    return f.valleys.map((v, which) => {
      const pts: [number, number][] = v.map((p, i) => [p.x + 250 * Math.sin(i / 2.6) * -dy, p.y + 250 * Math.sin(i / 2.6) * dx]);
      const [x0, y0] = pts[pts.length - 1];
      const spread = which === 0 ? -0.07 : 0.06;
      for (let d = 500; d < 4 * t.half; d += 500) {
        const side = spread * d + 2600 * Math.sin(d / 7000 + which) * Math.min(1, d / 20000) + 300 * Math.sin(d / 1100);
        const x = x0 + dx * d - dy * side;
        const y = y0 + dy * d + dx * side;
        pts.push([x, y]);
        if (Math.max(Math.abs(x), Math.abs(y)) > t.half * 1.05) break;
      }
      return pts;
    });
  }
  return ([0, 1] as const).map((which) => {
    const pts: [number, number][] = [];
    for (let y = 78000; y > 14000; y -= 500) pts.push([valleyX(which, y) + 250 * Math.sin(y / 1300), y]);
    const x0 = pts[pts.length - 1][0];
    for (let y = 14000; y > -72000; y -= 500) {
      const k = (14000 - y) / 86000;
      const drift = which === 0 ? -6000 * k : 5000 * k;
      pts.push([x0 + drift + 2600 * Math.sin((14000 - y) / 7000 + which) * Math.min(1, k * 4) + 300 * Math.sin(y / 1100), y]);
    }
    return pts;
  });
}

/** A road up each pass, beside its river. */
function passRoads(t: Terrain): [number, number][][] {
  const f = t as unknown as TerrainFeatures;
  if (f.valleys) {
    return f.valleys.map((v) =>
      v.map((p, i): [number, number] => {
        const q = v[Math.min(i + 1, v.length - 1)];
        const r = v[Math.max(i - 1, 0)];
        const len = Math.hypot(q.x - r.x, q.y - r.y) || 1;
        return [p.x + ((q.y - r.y) / len) * 420, p.y - ((q.x - r.x) / len) * 420];
      }),
    );
  }
  return ([0, 1] as const).map((which) => {
    const pts: [number, number][] = [];
    for (let y = 9000; y < 80000; y += 600) pts.push([valleyX(which, y) + 420, y]);
    return pts;
  });
}

/** The seed for land cover: the terrain's own where it has one. */
export function terrainSeed(t: Terrain, fallback: number): number {
  return (t as unknown as TerrainFeatures).seed ?? fallback;
}

/** Paints the land-cover texture; also returns a forest mask (row 0 south, as a DataTexture expects). */
function paintLandCover(lc: LandCover): { canvas: HTMLCanvasElement; mask: Uint8Array } {
  const t = lc.t;
  const N = texSize(t);
  const half = t.half;
  const px = (2 * half) / N;
  const H = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    const y = half - (j + 0.5) * px;
    for (let i = 0; i < N; i++) H[j * N + i] = t.heightAt(-half + (i + 0.5) * px, y);
  }
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = N;
  const g = canvas.getContext('2d')!;
  const img = g.createImageData(N, N);
  const d = img.data;
  const mask = new Uint8Array(N * N);
  const at = (i: number, j: number): number => H[clamp(j, 0, N - 1) * N + clamp(i, 0, N - 1)];
  const s = lc.seed;
  const c: RGB = [0, 0, 0];
  const mix = (a: RGB, b: RGB, k: number): void => {
    c[0] = a[0] + (b[0] - a[0]) * k;
    c[1] = a[1] + (b[1] - a[1]) * k;
    c[2] = a[2] + (b[2] - a[2]) * k;
  };
  const toward = (b: RGB, k: number): void => {
    c[0] += (b[0] - c[0]) * k;
    c[1] += (b[1] - c[1]) * k;
    c[2] += (b[2] - c[2]) * k;
  };
  for (let j = 0; j < N; j++) {
    const y = half - (j + 0.5) * px;
    for (let i = 0; i < N; i++) {
      const x = -half + (i + 0.5) * px;
      const h = H[j * N + i];
      const slope = Math.hypot(at(i + 1, j) - at(i - 1, j), at(i, j + 1) - at(i, j - 1)) / (2 * px);
      const n1 = vnoise(x / 900, y / 900, s + 11);
      const n2 = vnoise(x / 170, y / 170, s + 12);
      if (h < -1) {
        mix(C.shallow, C.deep, clamp(-h / 70, 0, 1));
      } else if (h < 7 + n1 * 7) {
        mix(C.sand, C.grass2, clamp((h - 4) / 10, 0, 0.4));
      } else {
        // Base: lowland grass and scrub.
        mix(C.grass, C.grass2, n1 * 0.8);
        toward(C.scrub, clamp(lc.scrub(x, y) - 0.45, 0, 0.5));
        const forest = lc.forest(x, y, h, slope);
        const town = lc.townness(x, y);
        if (lc.farm(x, y, h, slope) && forest < 0.02) {
          // Fields: rows of strips whose length varies per row, in a slowly turning grid.
          const a = (vnoise(x / 30000, y / 30000, s + 5) - 0.5) * 1.4;
          const ca = Math.cos(a);
          const sa = Math.sin(a);
          const fv = (-x * sa + y * ca) / 420;
          const cv = Math.floor(fv);
          const fu = (x * ca + y * sa) / (300 + 650 * hash2(cv, 7, s)) + hash2(cv, 8, s) * 9;
          const cu = Math.floor(fu);
          const r = hash2(cu, cv, s + 9);
          // About a third of the parcels are pasture, the rest a muted mix of crops and bare soil.
          if (r < 0.33) toward(C.grass2, 0.3 + r);
          else mix(CROPS[Math.floor(((r - 0.33) / 0.67) * CROPS.length)], c, 0.3);
          // Field edges read as hedgerows and tracks.
          const edge = Math.min(fu - cu, 1 - (fu - cu)) < 0.06 || Math.min(fv - cv, 1 - (fv - cv)) < 0.08;
          if (edge) toward(C.forest2, 0.35);
          toward(C.grass2, (n2 - 0.5) * 0.25);
        }
        if (forest > 0) {
          mix(C.forest, C.forest2, n2 * 0.6 + clamp(1 - forest * 8, 0, 0.4));
          if (town <= 0) mask[(N - 1 - j) * N + i] = 255 * clamp(forest * 10, 0, 1);
        }
        else if (forest > -0.05) toward(C.forest2, 0.35);
        if (h > 1250) toward(C.alpine, smoothstep(1250, 1600, h) * (forest > 0 ? 0.3 : 1));
        const rocky = smoothstep(0.28, 0.6, slope) + smoothstep(1700, 2300, h) * 0.8;
        if (rocky > 0) {
          const rk: RGB = n2 > 0.5 ? C.rock2 : C.rock;
          toward(rk, clamp(rocky, 0, 1));
        }
        const snowLine = 2200 + (n1 - 0.5) * 500;
        if (h > snowLine && slope < 1.1) toward(C.snow, clamp((h - snowLine) / 220, 0, 1) * (1 - smoothstep(0.7, 1.1, slope)));
        // Built-up ground stays part garden: houses and blocks stand on it in 3D.
        if (town > 0) mix(n2 > 0.55 ? C.town2 : C.town, c, 1 - clamp(town * 0.9, 0, 0.7));
      }
      // Cheap ambient occlusion: valleys darker, ridges brighter.
      const avg = (at(i - 3, j) + at(i + 3, j) + at(i, j - 3) + at(i, j + 3)) * 0.25;
      const ao = h > 0 ? 1 + clamp((h - avg) / 90, -0.16, 0.1) : 1;
      const grain = 0.94 + n2 * 0.12;
      const o = (j * N + i) * 4;
      d[o] = clamp(c[0] * ao * grain, 0, 255);
      d[o + 1] = clamp(c[1] * ao * grain, 0, 255);
      d[o + 2] = clamp(c[2] * ao * grain, 0, 255);
      d[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);

  // Vector features: rivers and roads.
  const P = (x: number, y: number): [number, number] => [(x + half) / px, (half - y) / px];
  const stroke = (pts: [number, number][], color: string, width: number): void => {
    g.beginPath();
    pts.forEach(([x, y], k) => {
      const [u, v] = P(x, y);
      if (k === 0) g.moveTo(u, v);
      else g.lineTo(u, v);
    });
    g.strokeStyle = color;
    g.lineWidth = width;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.stroke();
  };
  for (const pts of riverPaths(t)) stroke(pts, '#3c6879', 1.6);
  // Roads: each town to its two nearest neighbours (the airbase counts as one), plus a road up each pass.
  const nodes = [{ x: 0, y: -1500 }, ...lc.towns];
  const roads = new Set<string>();
  const road = (a: { x: number; y: number }, b: { x: number; y: number }, k: number): void => {
    const pts: [number, number][] = [];
    const nx = -(b.y - a.y);
    const ny = b.x - a.x;
    const bend = (hash2(k, 1, s) - 0.5) * 0.25;
    for (let q = 0; q <= 24; q++) {
      const f = q / 24;
      const w = Math.sin(f * Math.PI) * bend + Math.sin(f * Math.PI * 3) * 0.02;
      pts.push([a.x + (b.x - a.x) * f + nx * w, a.y + (b.y - a.y) * f + ny * w]);
    }
    stroke(pts, 'rgba(92,88,80,0.9)', 1.1);
  };
  nodes.forEach((a, ia) => {
    const near = nodes
      .map((b, ib) => ({ ib, dd: Math.hypot(a.x - b.x, a.y - b.y) }))
      .filter((o) => o.ib !== ia)
      .sort((p, q) => p.dd - q.dd)
      .slice(0, 2);
    for (const { ib, dd } of near) {
      const key = ia < ib ? `${ia}-${ib}` : `${ib}-${ia}`;
      if (roads.has(key) || dd > 45000) continue;
      roads.add(key);
      road(a, nodes[ib], ia * 31 + ib);
    }
  });
  for (const pts of passRoads(t)) stroke(pts, 'rgba(92,88,80,0.9)', 1.0);
  return { canvas, mask };
}

function detailTexture(): THREE.DataTexture {
  const n = 256;
  const data = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const v =
        tileNoise(i / 16, j / 16, 16, 71) * 0.5 + tileNoise(i / 8, j / 8, 32, 72) * 0.3 + tileNoise(i / 3, j / 3, 86, 73) * 0.2;
      const o = (j * n + i) * 4;
      data[o] = data[o + 1] = data[o + 2] = v * 255;
      data[o + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, n, n);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

function waterNormals(): THREE.DataTexture {
  const n = 256;
  const hgt = new Float32Array(n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) hgt[j * n + i] = tileNoise(i / 16, j / 16, 16, 91) + 0.5 * tileNoise(i / 6, j / 6, 43, 92) + 0.25 * tileNoise(i / 2.5, j / 2.5, 103, 93);
  const data = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const dx = hgt[j * n + ((i + 1) % n)] - hgt[j * n + ((i + n - 1) % n)];
      const dy = hgt[((j + 1) % n) * n + i] - hgt[((j + n - 1) % n) * n + i];
      const v = new THREE.Vector3(-dx * 3, -dy * 3, 1).normalize();
      const o = (j * n + i) * 4;
      data[o] = (v.x * 0.5 + 0.5) * 255;
      data[o + 1] = (v.y * 0.5 + 0.5) * 255;
      data[o + 2] = (v.z * 0.5 + 0.5) * 255;
      data[o + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, n, n);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/**
 * Adds world-space detail noise to a terrain material, faded out with distance. With `edge`, the colour also
 * fades towards haze beyond that distance from the centre, for the mirrored skirt.
 */
function addDetail(m: THREE.MeshStandardMaterial, detail: THREE.Texture, forest: THREE.Texture, edge = 0): void {
  m.customProgramCacheKey = () => `terrain-detail-${edge}`;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.detailMap = { value: detail };
    sh.uniforms.forestMask = { value: forest };
    sh.uniforms.edgeHaze = { value: new THREE.Color('#7f8a73') };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nuniform sampler2D detailMap;\nuniform sampler2D forestMask;\nuniform vec3 edgeHaze;')
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        float camD = distance(vWPos, cameraPosition);
        float dn = texture2D(detailMap, vWPos.xz / 260.0).r * 0.55 + texture2D(detailMap, vWPos.xz / 41.0).r * 0.45;
        diffuseColor.rgb *= mix(1.0, 0.72 + 0.56 * dn, 1.0 - smoothstep(3000.0, 26000.0, camD));
        // Inside forests, break the flat green into lit and shadowed crowns.
        float fm = texture2D(forestMask, vMapUv).r;
        float cn = texture2D(detailMap, vWPos.xz / 170.0).r * 0.65 + texture2D(detailMap, vWPos.xz / 430.0).r * 0.35;
        diffuseColor.rgb *= mix(1.0, 0.45 + 0.95 * smoothstep(0.36, 0.72, cn), fm * (1.0 - smoothstep(1500.0, 14000.0, camD)));
        ${edge > 0 ? `float edgeK = smoothstep(${(edge * 1.02).toFixed(1)}, ${(edge * 1.7).toFixed(1)}, max(abs(vWPos.x), abs(vWPos.z)));
        diffuseColor.rgb = mix(diffuseColor.rgb, edgeHaze, edgeK * 0.9);` : ''}`,
      );
  };
}

export interface Scenery {
  terrainMesh: THREE.Mesh;
  /** Town centres and radii in sim coordinates. */
  towns: readonly Town[];
  /** Hide trees and buildings within r metres of a sim position, so units placed there stay visible. */
  clearAround(x: number, y: number, r: number): void;
  update(dt: number): void;
  /** Remove everything from the scene and free GPU memory, before building a new map. */
  dispose(): void;
}

export function buildScenery(parent: THREE.Scene, t: Terrain, seed: number): Scenery {
  const scene = new THREE.Group();
  parent.add(scene);
  const lc = new LandCover(t, seed);
  const { canvas, mask } = paintLandCover(lc);
  const forestTex = new THREE.DataTexture(mask, canvas.width, canvas.height, THREE.RedFormat);
  forestTex.magFilter = THREE.LinearFilter;
  forestTex.minFilter = THREE.LinearMipmapLinearFilter;
  forestTex.generateMipmaps = true;
  forestTex.wrapS = forestTex.wrapT = THREE.MirroredRepeatWrapping;
  forestTex.needsUpdate = true;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const detail = detailTexture();

  const size = t.half * 2;
  const seg = t.n - 1;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) pos.setY(i, t.heightAt(pos.getX(i), -pos.getZ(i)));
  geo.computeVertexNormals();
  const terrainMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0 });
  addDetail(terrainMat, detail, forestTex);
  const terrainMesh = new THREE.Mesh(geo, terrainMat);
  scene.add(terrainMesh);

  // Low-resolution skirt so the world does not end at the map edge: the heightmap and land cover mirrored
  // outwards, faded into haze so the copy does not read as one.
  tex.wrapS = tex.wrapT = THREE.MirroredRepeatWrapping;
  const k = 20;
  const sk = new THREE.PlaneGeometry(size * 5, size * 5, k * 5, k * 5);
  sk.rotateX(-Math.PI / 2);
  const sp = sk.getAttribute('position') as THREE.BufferAttribute;
  const suv = sk.getAttribute('uv') as THREE.BufferAttribute;
  const mirror = (v: number): number => {
    const p = (((v + t.half) % (2 * size)) + 2 * size) % (2 * size);
    return (p < size ? p : 2 * size - p) - t.half;
  };
  for (let i = 0; i < sp.count; i++) {
    const x = sp.getX(i);
    const y = -sp.getZ(i);
    const out = Math.max(Math.abs(x), Math.abs(y)) - t.half;
    const h = t.heightAt(mirror(x), mirror(y));
    // Inside the map the skirt hides under the real terrain; along the edge it meets it.
    sp.setY(i, out < -1 ? -400 : out < 1 ? h - 4 : Math.max(-60, h) * (1 - clamp(out / size, 0, 0.7)));
    suv.setXY(i, (x + t.half) / size, (y + t.half) / size);
  }
  sk.computeVertexNormals();
  const skirtMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 1, metalness: 0 });
  addDetail(skirtMat, detail, forestTex, t.half);
  const skirt = new THREE.Mesh(sk, skirtMat);
  scene.add(skirt);

  const normals = waterNormals();
  normals.repeat.set(2700, 2700);
  const seaMat = new THREE.MeshStandardMaterial({
    color: 0x1b4253,
    roughness: 0.12,
    metalness: 0.1,
    transparent: true,
    opacity: 0.9,
    normalMap: normals,
    normalScale: new THREE.Vector2(0.35, 0.35),
  });
  // Sea level is 0 everywhere: the terrain hides the plane on land, so lakes and any coast get water.
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(size * 12, size * 12), seaMat);
  sea.rotateX(-Math.PI / 2);
  scene.add(sea);

  const trees = buildTrees(scene, lc);
  const buildings = buildBuildings(scene, lc);

  let time = 0;
  return {
    terrainMesh,
    towns: lc.towns,
    clearAround(x, y, r) {
      for (const set of [...trees, ...buildings]) {
        let changed = false;
        for (let i = 0; i < set.mesh.count; i++) {
          if (set.hidden[i]) continue;
          if (Math.hypot(set.xy[i * 2] - x, set.xy[i * 2 + 1] - y) < r) {
            set.hidden[i] = 1;
            set.mesh.setMatrixAt(i, ZERO);
            changed = true;
          }
        }
        if (changed) set.mesh.instanceMatrix.needsUpdate = true;
      }
    },
    update(dt) {
      time += dt;
      normals.offset.set(time * 0.004, time * 0.0025);
    },
    dispose() {
      parent.remove(scene);
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
      for (const tx of [tex, detail, forestTex, normals]) tx.dispose();
    },
  };
}

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
