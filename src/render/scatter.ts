import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { smoothstep } from '../sim/math';
import type { Terrain } from '../sim/terrain';
import { prng, vnoise } from './noise';

/**
 * Instanced trees and buildings. Each model is built from parts: one part takes the instance colour (crown,
 * walls), the other a second per-instance colour (trunk, roof), and every vertex carries a baked shade so
 * crowns darken towards the bottom and eaves read under the roof.
 */

/** What the scatterers need to know about the land, shared with the land-cover texture. */
export interface Land {
  readonly t: Terrain;
  readonly seed: number;
  readonly towns: { x: number; y: number; r: number }[];
  slopeAt(x: number, y: number): number;
  forest(x: number, y: number, h: number, slope: number): number;
  farm(x: number, y: number, h: number, slope: number): boolean;
}

export interface Scatter {
  mesh: THREE.InstancedMesh;
  xy: Float32Array;
  hidden: Uint8Array;
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** Trees and buildings are drawn larger than life (like the units) so forests and towns read from the air. */
const TREE_SCALE = 2.2;
const BUILD_SCALE = 2;

/** Tags a part: `main` 1 takes the instance colour, 0 the second colour; shade(y) is baked per vertex. */
function part(g: THREE.BufferGeometry, main: number, shade: (x: number, y: number, z: number) => number): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  if (geo.getAttribute('uv')) geo.deleteAttribute('uv');
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  const pos = geo.getAttribute('position');
  const a = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    a[i * 2] = main;
    a[i * 2 + 1] = shade(pos.getX(i), pos.getY(i), pos.getZ(i));
  }
  geo.setAttribute('aPart', new THREE.BufferAttribute(a, 2));
  return geo;
}

/** Moves each vertex by smooth noise, for lumpy crowns. Shared vertices stay together because the noise is positional. */
function lumpy(g: THREE.BufferGeometry, amp: number, seed: number): THREE.BufferGeometry {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = vnoise(v.x * 2.1 + 7, v.z * 2.1 + v.y * 1.3, seed) - 0.5;
    v.multiplyScalar(1 + n * amp);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  return g;
}

function finish(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  return mergeGeometries(parts)!;
}

/** A standard material whose vertex colour is mix(second colour, instance colour, part) times the baked shade. */
function partMaterial(params: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial(params);
  m.customProgramCacheKey = () => 'scatter-part';
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aPart;\nattribute vec3 iColor2;')
      .replace(
        '#include <color_vertex>',
        `#include <color_vertex>
        #ifdef USE_INSTANCING_COLOR
        vColor.rgb = mix(iColor2, instanceColor, aPart.x) * aPart.y;
        #endif`,
      );
  };
  return m;
}

function scatterSet(scene: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, max: number): Scatter & { color2: THREE.InstancedBufferAttribute } {
  const mesh = new THREE.InstancedMesh(geo, mat, max);
  mesh.count = 0;
  mesh.frustumCulled = false;
  // Instance colours must exist before the first compile so the shader is built with them.
  mesh.setColorAt(0, new THREE.Color(1, 1, 1));
  const color2 = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
  geo.setAttribute('iColor2', color2);
  scene.add(mesh);
  return { mesh, xy: new Float32Array(max * 2), hidden: new Uint8Array(max), color2 };
}

// ---------------------------------------------------------------- trees

function broadleafGeometry(): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(0.06, 0.09, 0.5, 5, 1, true);
  trunk.translate(0, 0.25, 0);
  const crown = lumpy(new THREE.IcosahedronGeometry(0.5, 1), 0.35, 11);
  crown.scale(1, 0.9, 1);
  crown.translate(0, 0.82, 0);
  return finish([
    part(trunk, 0, () => 1),
    part(crown, 1, (_x, y) => 0.55 + 0.6 * smoothstep(0.4, 1.25, y)),
  ]);
}

function coniferGeometry(): THREE.BufferGeometry {
  const parts = [part(new THREE.CylinderGeometry(0.04, 0.06, 0.3, 5, 1, true).translate(0, 0.15, 0), 0, () => 1)];
  // Three stacked tiers, each narrower, so the outline steps like a spruce.
  const tiers = [
    { r: 0.42, h: 0.55, y: 0.22 },
    { r: 0.32, h: 0.5, y: 0.52 },
    { r: 0.21, h: 0.46, y: 0.8 },
  ];
  for (const t of tiers) {
    const c = new THREE.ConeGeometry(t.r, t.h, 7, 1, true);
    c.translate(0, t.y + t.h / 2, 0);
    const y0 = t.y;
    const h = t.h;
    parts.push(part(c, 1, (_x, y) => 0.5 + 0.55 * ((y - y0) / h) * 0.6 + 0.35 * smoothstep(0.2, 1.2, y)));
  }
  return finish(parts);
}

/** Broadleaf and conifer trees in the forests around the defended area; conifers take over with height. */
export function buildTrees(scene: THREE.Object3D, lc: Land): Scatter[] {
  const t = lc.t;
  const rnd = prng(lc.seed ^ 0x7ee5);
  const mat = partMaterial({ roughness: 0.95, metalness: 0 });
  const MAX_LEAF = 52000;
  const MAX_PINE = 44000;
  const leaf = scatterSet(scene, broadleafGeometry(), mat, MAX_LEAF);
  const pine = scatterSet(scene, coniferGeometry(), mat, MAX_PINE);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  const p = new THREE.Vector3();
  const col = new THREE.Color();
  const trunk = new THREE.Color();
  const R = 40000;
  const plant = (x: number, y: number, f: number, conifer: boolean): void => {
    const set = conifer ? pine : leaf;
    const n = set.mesh.count;
    if (n >= set.xy.length / 2) return;
    // Trees on the forest edge and alone in the open grow lower and wider.
    const open = f < 0.05 ? 1 : 0;
    const hgt = conifer ? 14 + rnd() * 12 : 11 + rnd() * 9 - open * 3;
    const wid = conifer ? hgt * (0.42 + rnd() * 0.12) : hgt * (0.8 + rnd() * 0.3 + open * 0.2);
    sc.set(wid, hgt, wid * (0.85 + rnd() * 0.3)).multiplyScalar(TREE_SCALE);
    q.setFromAxisAngle(Y_AXIS, rnd() * 6.28);
    p.set(x, t.groundAt(x, y) - 0.5, -y);
    m.compose(p, q, sc);
    set.mesh.setMatrixAt(n, m);
    if (conifer) col.setHSL(0.3 + rnd() * 0.06, 0.4 + rnd() * 0.2, 0.03 + rnd() * 0.02);
    else {
      // A few broadleaves already turning, as on an autumn afternoon.
      const turning = rnd() < 0.07;
      col.setHSL(turning ? 0.09 + rnd() * 0.05 : 0.19 + rnd() * 0.1, 0.45 + rnd() * 0.25, turning ? 0.06 + rnd() * 0.04 : 0.035 + rnd() * 0.035);
    }
    set.mesh.setColorAt(n, col);
    trunk.setHSL(0.07, 0.25, 0.025 + rnd() * 0.015);
    set.color2.setXYZ(n, trunk.r, trunk.g, trunk.b);
    set.xy[n * 2] = x;
    set.xy[n * 2 + 1] = y;
    set.mesh.count = n + 1;
  };
  for (let i = 0; i < 500000 && (leaf.mesh.count < MAX_LEAF || pine.mesh.count < MAX_PINE); i++) {
    // Density falls off with range from the base, where the camera spends most of its time.
    const a = rnd() * Math.PI * 2;
    const r = (0.04 + 0.96 * rnd()) * R;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r - 2000;
    const h = t.heightAt(x, y);
    if (h < 10) continue;
    const slope = lc.slopeAt(x, y);
    const f = lc.forest(x, y, h, slope);
    const conifer = rnd() < 0.25 + smoothstep(300, 1200, h) * 0.65;
    if (f < 0) {
      // The odd lone tree along field edges and hedgerows.
      if (f > -0.1 && rnd() < 0.012) plant(x, y, f, conifer);
      continue;
    }
    // Most groves go along the forest edge, where trees stand out against the fields; the canopy inside is
    // also drawn into the ground texture.
    if (f > 0.12 && rnd() < 0.6) continue;
    const k = 5 + Math.floor(rnd() * 9);
    for (let j = 0; j < k; j++) {
      const ga = rnd() * Math.PI * 2;
      const gr = Math.sqrt(rnd()) * 32 * TREE_SCALE;
      const gx = x + Math.cos(ga) * gr;
      const gy = y + Math.sin(ga) * gr;
      plant(gx, gy, f, rnd() < 0.8 ? conifer : !conifer);
    }
  }
  return [leaf, pine];
}

// ---------------------------------------------------------------- buildings

/** Walls from 0 to 1, gable roof above with eaves overhanging the walls. */
function houseGeometry(): THREE.BufferGeometry {
  const walls = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const ox = 0.56;
  const oz = 0.58;
  const r = 0.55;
  // Ridge along x: two sloped faces and two gable ends.
  // prettier-ignore
  const v = [
    -ox, 0.97, -oz,  ox, 0.97, -oz,  ox, 1 + r, 0,   -ox, 0.97, -oz,  ox, 1 + r, 0,  -ox, 1 + r, 0,
    -ox, 0.97, oz,  -ox, 1 + r, 0,   ox, 1 + r, 0,   -ox, 0.97, oz,   ox, 1 + r, 0,   ox, 0.97, oz,
    -0.5, 1, -0.5,  -0.5, 1, 0.5,   -0.5, 1 + r * 0.9, 0,
     0.5, 1, -0.5,   0.5, 1 + r * 0.9, 0,  0.5, 1, 0.5,
  ];
  const roof = new THREE.BufferGeometry();
  roof.setAttribute('position', new THREE.Float32BufferAttribute(v.slice(0, 36), 3));
  const gableEnds = new THREE.BufferGeometry();
  gableEnds.setAttribute('position', new THREE.Float32BufferAttribute(v.slice(36), 3));
  return finish([
    part(walls, 1, (_x, y) => 0.8 + 0.2 * y),
    part(gableEnds, 1, () => 0.95),
    part(roof, 0, (_x, y) => (y < 1 ? 0.75 : 1)),
  ]);
}

/** Flat-roofed block: walls, a parapet line and a darker roof slab. */
function blockGeometry(): THREE.BufferGeometry {
  const walls = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const slab = new THREE.BoxGeometry(0.94, 0.03, 0.94).translate(0, 1.005, 0);
  const plant = new THREE.BoxGeometry(0.22, 0.08, 0.18).translate(0.18, 1.05, -0.12);
  return finish([
    part(walls, 1, (_x, y) => 0.72 + 0.28 * y),
    part(slab, 0, () => 1),
    part(plant, 0, () => 1.3),
  ]);
}

const WALLS = ['#d8d0bf', '#cfc4ae', '#e3dccd', '#b9ab92', '#a9714f', '#c9b48e', '#bfc0b8'].map((c) => new THREE.Color(c));
const ROOFS = ['#8e3f2a', '#9f4a30', '#6e3326', '#4a4a4c', '#3c4148', '#5b4a3e'].map((c) => new THREE.Color(c));
const BARN_ROOFS = ['#5d6266', '#7b3a2b', '#4d5a4a', '#6a6f72'].map((c) => new THREE.Color(c));
const BLOCK_WALLS = ['#bdbab2', '#a7a49c', '#c9c2b4', '#9a9d9f', '#b7a68e'].map((c) => new THREE.Color(c));
const BLOCK_ROOFS = ['#4b4c4d', '#59595a', '#3f4143'].map((c) => new THREE.Color(c));

/** Town houses and blocks, plus farmsteads (house and barns) out in the fields. */
export function buildBuildings(scene: THREE.Object3D, lc: Land): Scatter[] {
  const t = lc.t;
  const rnd = prng(lc.seed ^ 0x70e1);
  // Double-sided so the hand-built roof faces light correctly whichever way they wind.
  const mat = partMaterial({ roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
  const MAX_HOUSE = 20000;
  const MAX_BLOCK = 2500;
  const houses = scatterSet(scene, houseGeometry(), mat, MAX_HOUSE);
  const blocks = scatterSet(scene, blockGeometry(), mat, MAX_BLOCK);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  const p = new THREE.Vector3();
  const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)];
  const tint = new THREE.Color();

  const place = (
    set: typeof houses,
    max: number,
    x: number,
    y: number,
    w: number,
    hgt: number,
    d: number,
    yaw: number,
    wall: THREE.Color,
    roof: THREE.Color,
  ): void => {
    const n = set.mesh.count;
    if (n >= max) return;
    sc.set(w, hgt, d).multiplyScalar(BUILD_SCALE);
    q.setFromAxisAngle(Y_AXIS, yaw);
    // Sink the footing into the slope so no building floats on its downhill side.
    p.set(x, t.groundAt(x, y) - 0.15 * Math.max(w, d) * lc.slopeAt(x, y) - 0.3, -y);
    m.compose(p, q, sc);
    set.mesh.setMatrixAt(n, m);
    set.mesh.setColorAt(n, tint.copy(wall).multiplyScalar(0.85 + rnd() * 0.2));
    tint.copy(roof).multiplyScalar(0.85 + rnd() * 0.25);
    set.color2.setXYZ(n, tint.r, tint.g, tint.b);
    set.xy[n * 2] = x;
    set.xy[n * 2 + 1] = y;
    set.mesh.count = n + 1;
  };

  // Towns: houses in plots along a street grid (rows 70 m apart, cross streets every 150 m), blocks in the centre.
  // Everything in town is drawn at BUILD_SCALE: streets, plots and buildings alike, so it reads from altitude.
  const ROW = 70 * BUILD_SCALE;
  const CROSS = 150 * BUILD_SCALE;
  const PLOT = 19 * BUILD_SCALE;
  for (const tw of lc.towns) {
    const g = rnd() * Math.PI;
    const cg = Math.cos(g);
    const sg = Math.sin(g);
    const taken = new Set<string>();
    const count = Math.round((tw.r * tw.r) / (1600 * BUILD_SCALE));
    for (let k = 0; k < count; k++) {
      const a = rnd() * Math.PI * 2;
      const r = Math.abs(rnd() + rnd() - 1) * tw.r * 1.1;
      let u = Math.cos(a) * r;
      const v0 = Math.sin(a) * r;
      const row = Math.round(v0 / ROW);
      const side = v0 > row * ROW ? 1 : -1;
      const centre = 1 - r / (tw.r * 1.1);
      const big = tw.r > 2000 && centre > 0.68 && rnd() < 0.3;
      const plot = big ? PLOT * 3 : PLOT;
      const slot = Math.floor(u / plot);
      u = (slot + 0.5) * plot;
      // Leave the cross streets clear.
      const cu = ((u % CROSS) + CROSS) % CROSS;
      if (cu < 12 * BUILD_SCALE || cu > CROSS - 12 * BUILD_SCALE) continue;
      const key = `${row},${side},${big ? 'b' : 'h'}${slot}`;
      if (taken.has(key)) continue;
      taken.add(key);
      const setback = (big ? 24 : 12 + rnd() * 3) * BUILD_SCALE;
      const v = row * ROW + side * setback;
      const x = tw.x + u * cg - v * sg;
      const y = tw.y + u * sg + v * cg;
      if (lc.slopeAt(x, y) > 0.15 || t.heightAt(x, y) < 6) continue;
      const yaw = g + (rnd() < 0.15 ? Math.PI / 2 : 0) + (rnd() - 0.5) * 0.06;
      if (big) {
        // Town centre: flats, offices and the odd warehouse.
        place(blocks, MAX_BLOCK, x, y, 24 + rnd() * 20, 9 + rnd() * 16 * centre, 16 + rnd() * 10, g, pick(BLOCK_WALLS), pick(BLOCK_ROOFS));
      } else if (rnd() < 0.04) {
        place(blocks, MAX_BLOCK, x, y, 16, 6 + rnd() * 3, 14, g, pick(BLOCK_WALLS), pick(BLOCK_ROOFS));
      } else {
        place(houses, MAX_HOUSE, x, y, 10 + rnd() * 5, 5 + rnd() * 3.5, 7.5 + rnd() * 3, yaw, pick(WALLS), pick(ROOFS));
      }
    }
  }

  // Farmsteads: a house and one or two barns around a yard, scattered over the farmland near the base.
  const R = 32000;
  let farms = 0;
  for (let i = 0; i < 60000 && farms < 700; i++) {
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(rnd()) * R;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r - 2000;
    const h = t.heightAt(x, y);
    const slope = lc.slopeAt(x, y);
    if (!lc.farm(x, y, h, slope) || lc.forest(x, y, h, slope) > 0) continue;
    if (Math.hypot(x, y) < 2500) continue;
    farms++;
    const yaw = rnd() * Math.PI;
    const ca = Math.cos(yaw);
    const sa = Math.sin(yaw);
    const at = (u: number, v: number): [number, number] => [x + u * ca - v * sa, y + u * sa + v * ca];
    const [hx, hy] = at(0, 0);
    place(houses, MAX_HOUSE, hx, hy, 12 + rnd() * 4, 5.5 + rnd() * 1.5, 8 + rnd() * 2, -yaw, pick(WALLS), pick(ROOFS));
    const barns = 1 + Math.floor(rnd() * 2);
    for (let b = 0; b < barns; b++) {
      const [bx, by] = at(b === 0 ? 26 + rnd() * 6 : 4 + rnd() * 8, b === 0 ? rnd() * 8 : -(22 + rnd() * 8));
      const along = b === 0 ? -yaw + Math.PI / 2 : -yaw;
      place(houses, MAX_HOUSE, bx, by, 24 + rnd() * 16, 6 + rnd() * 3, 12 + rnd() * 5, along, pick(BLOCK_WALLS), pick(BARN_ROOFS));
    }
  }
  for (const s of [houses, blocks]) {
    s.mesh.instanceMatrix.needsUpdate = true;
    if (s.mesh.instanceColor) s.mesh.instanceColor.needsUpdate = true;
    s.color2.needsUpdate = true;
  }
  return [houses, blocks];
}
