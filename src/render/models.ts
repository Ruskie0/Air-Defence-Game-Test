import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Procedural aircraft, missile and ground-unit models at real size in metres. Each model is one merged,
 * vertex-coloured geometry, built once and shared. Air models point their nose along +Z with +Y up;
 * ground models face -Z (north) with the origin on the ground.
 */

type Pt = [number, number];

/** Right half of a symmetric outline, mirrored into the full polygon. */
const sym = (pts: Pt[]): Pt[] => [...pts, ...pts.slice().reverse().map(([x, z]): Pt => [-x, z])];

class Kit {
  private readonly parts: THREE.BufferGeometry[] = [];
  private readonly c = new THREE.Color();
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();

  /** Adds a part in the given colour, moved to (x, y, z) after rotating by (rx, ry, rz). */
  add(g: THREE.BufferGeometry, color: number, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): this {
    const geo = g.index ? g.toNonIndexed() : g;
    for (const name of Object.keys(geo.attributes)) if (name !== 'position' && name !== 'normal') geo.deleteAttribute(name);
    geo.clearGroups();
    if (!geo.getAttribute('normal')) geo.computeVertexNormals();
    this.q.setFromEuler(this.e.set(rx, ry, rz));
    geo.applyMatrix4(this.m.compose(new THREE.Vector3(x, y, z), this.q, new THREE.Vector3(1, 1, 1)));
    this.c.setHex(color);
    const n = geo.getAttribute('position').count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      col[i * 3] = this.c.r;
      col[i * 3 + 1] = this.c.g;
      col[i * 3 + 2] = this.c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.parts.push(geo);
    return this;
  }

  /** Body of revolution along Z: profile points are [z, radius], tail to nose. */
  lathe(profile: Pt[], color: number, segs = 14, x = 0, y = 0, sx = 1, sy = 1): this {
    const g = new THREE.LatheGeometry(
      profile.map(([z, r]) => new THREE.Vector2(r, z)),
      segs,
    );
    g.rotateX(Math.PI / 2);
    g.scale(sx, sy, 1);
    return this.add(g, color, x, y);
  }

  /** Flat surface in the XZ plane (wings, stabilisers) from an outline of [x, z] points. */
  plate(outline: Pt[], thick: number, color: number, y = 0, rz = 0): this {
    const s = new THREE.Shape(outline.map(([x, z]) => new THREE.Vector2(x, -z)));
    const g = new THREE.ExtrudeGeometry(s, { depth: thick, bevelEnabled: false });
    g.rotateX(-Math.PI / 2);
    g.translate(0, -thick / 2 + y, 0);
    if (rz) g.rotateZ(rz);
    return this.add(g, color);
  }

  /** Flat surface in the YZ plane (fins) from an outline of [z, y] points, rolled by rz about the body axis. */
  fin(outline: Pt[], thick: number, color: number, x = 0, rz = 0): this {
    const s = new THREE.Shape(outline.map(([z, y]) => new THREE.Vector2(z, y)));
    const g = new THREE.ExtrudeGeometry(s, { depth: thick, bevelEnabled: false });
    g.rotateY(-Math.PI / 2);
    g.translate(thick / 2 + x, 0, 0);
    if (rz) g.rotateZ(rz);
    return this.add(g, color);
  }

  /** The same fin at four roll angles: cruciform (+) or, with offset π/4, an X. */
  cross(outline: Pt[], thick: number, color: number, offset = 0): this {
    for (let i = 0; i < 4; i++) this.fin(outline, thick, color, 0, offset + (i * Math.PI) / 2);
    return this;
  }

  box(w: number, h: number, l: number, color: number, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): this {
    return this.add(new THREE.BoxGeometry(w, h, l), color, x, y, z, rx, ry, rz);
  }

  /** Cylinder along Z (r0 at the front). */
  tube(r0: number, r1: number, len: number, color: number, x = 0, y = 0, z = 0, segs = 10): this {
    const g = new THREE.CylinderGeometry(r0, r1, len, segs);
    g.rotateX(Math.PI / 2);
    return this.add(g, color, x, y, z);
  }

  /** Cylinder along X, for wheels and axles. */
  wheel(r: number, w: number, color: number, x: number, y: number, z: number): this {
    const g = new THREE.CylinderGeometry(r, r, w, 12);
    g.rotateZ(Math.PI / 2);
    return this.add(g, color, x, y, z);
  }

  ellipsoid(rx: number, ry: number, rz: number, color: number, x = 0, y = 0, z = 0): this {
    const g = new THREE.SphereGeometry(1, 14, 8);
    g.scale(rx, ry, rz);
    return this.add(g, color, x, y, z);
  }

  build(): THREE.BufferGeometry {
    const g = mergeGeometries(this.parts)!;
    g.computeBoundingSphere();
    return g;
  }
}

// ------------------------------------------------------------------ aircraft

const GLASS = 0x1c2733;
const NOZZLE = 0x3b3835;
const DARK = 0x262626;

function fighter(): THREE.BufferGeometry {
  const c = 0x8794a0;
  const k = new Kit();
  k.lathe([[-7.6, 0], [-7.5, 0.5], [-5, 0.66], [0, 0.72], [3, 0.64], [5, 0.48], [6.6, 0.24], [7.6, 0]], c);
  k.tube(0.5, 0.45, 1.1, NOZZLE, 0, 0, -7.9);
  k.ellipsoid(0.42, 0.42, 1.5, GLASS, 0, 0.55, 3.8);
  k.box(1.05, 0.75, 4, 0x7d8a96, 0, -0.6, 1.2);
  k.plate(sym([[0.45, 4.6], [0.95, 1.6], [4.8, -2.2], [4.8, -3.1], [0.6, -3.7]]), 0.14, c);
  k.plate(sym([[0.45, -5.3], [2.9, -6.7], [2.9, -7.4], [0.45, -7.3]]), 0.1, c);
  k.fin([[-4.4, 0.55], [-6.9, 3.7], [-7.6, 3.7], [-7.5, 0.55]], 0.12, c);
  // Wingtip and underwing missiles.
  for (const x of [-4.9, 4.9]) k.tube(0.08, 0.08, 3.6, 0xdedede, x, 0, -2.4, 6);
  for (const x of [-2.8, 2.8]) k.tube(0.09, 0.09, 3.6, 0xdedede, x, -0.35, -1.6, 6);
  k.lathe([[-1.8, 0], [-1.7, 0.36], [1.6, 0.36], [1.8, 0]], 0x9aa4ad, 10, 0, -0.95);
  return k.build();
}

function sead(): THREE.BufferGeometry {
  const c = 0x7c898c;
  const k = new Kit();
  k.lathe([[-11, 0], [-10.6, 0.8], [-6, 1.15], [0, 1.25], [5, 1.05], [8, 0.75], [10.2, 0.35], [11, 0]], c, 14, 0, 0, 1.25, 0.8);
  for (const x of [-1.1, 1.1]) {
    k.tube(0.72, 0.72, 9, c, x, -0.15, -5.2);
    k.tube(0.62, 0.55, 1.1, NOZZLE, x, -0.15, -10.2);
  }
  k.ellipsoid(0.75, 0.5, 2, GLASS, 0, 0.75, 6.2);
  k.plate(sym([[1.2, 3.6], [1.9, 1], [7.4, -4.3], [7.4, -5.4], [1.4, -6.6]]), 0.2, c);
  k.plate(sym([[1.4, -8.4], [4.8, -10.1], [4.8, -11], [1.4, -11]]), 0.14, c);
  for (const x of [-1.7, 1.7]) k.fin([[-6.4, 0.7], [-9.8, 4.6], [-10.9, 4.6], [-10.7, 0.7]], 0.14, c, x);
  // Anti-radiation missiles under the wings.
  for (const x of [-3.6, 3.6]) {
    k.lathe([[-2.35, 0], [-2.3, 0.18], [1.9, 0.18], [2.35, 0]], 0xc9c9c0, 8, x, -0.65);
    k.box(0.08, 0.5, 0.8, 0xc9c9c0, x, -0.65, -1.8);
  }
  return k.build();
}

function bomber(): THREE.BufferGeometry {
  const c = 0xa9aeb0;
  const k = new Kit();
  k.lathe([[-21, 0], [-20.4, 1.2], [-12, 1.65], [0, 1.85], [10, 1.65], [16, 1.25], [19.6, 0.6], [21, 0]], c, 16);
  for (const x of [-2.1, 2.1]) {
    k.tube(1.15, 1.15, 17, c, x, -0.2, -5);
    k.tube(1.0, 0.9, 1.4, NOZZLE, x, -0.2, -14.1);
    k.box(1.6, 2.2, 3, 0x939899, x, -0.2, 4.6);
  }
  k.ellipsoid(0.9, 0.6, 2.4, GLASS, 0, 1.3, 15.2);
  k.plate(sym([[1.6, 9], [5.6, 0], [17.2, -9.4], [17.2, -10.8], [5.6, -6.2], [2, -6.6]]), 0.3, c);
  k.plate(sym([[1.5, -14], [8, -18.6], [8, -20.6], [1.5, -20.2]]), 0.2, c);
  k.fin([[-9.5, 1.6], [-18, 9.2], [-21, 9.2], [-20.6, 1.6]], 0.25, c);
  return k.build();
}

function soj(): THREE.BufferGeometry {
  const c = 0x8e969b;
  const k = new Kit();
  k.lathe([[-18, 0], [-17, 0.8], [-12, 1.8], [-4, 2], [10, 2], [15, 1.65], [17.4, 0.85], [18, 0]], c, 16);
  k.ellipsoid(1.0, 0.45, 1.3, GLASS, 0, 1.25, 15.2);
  k.plate(sym([[1.5, 3.6], [18.5, 1.6], [18.5, -0.9], [1.5, -1.6]]), 0.32, c, 1.6);
  for (const x of [-11.5, -6, 6, 11.5]) {
    k.tube(0.55, 0.65, 5.2, c, x, 1.3, 2.4);
    k.box(0.22, 4.2, 0.07, DARK, x, 1.3, 5.1, 0, 0, 0.6);
    k.box(0.22, 4.2, 0.07, DARK, x, 1.3, 5.1, 0, 0, -0.95);
  }
  k.plate(sym([[0.9, -12.6], [7, -14.8], [7, -16.8], [0.9, -17]]), 0.2, c, 0.6);
  k.fin([[-10.8, 1.9], [-16.4, 8.2], [-18.2, 8.2], [-17.8, 1.9]], 0.25, c);
  // Jamming gear: the long belly canoe and wingtip pods.
  k.lathe([[-6, 0], [-5.5, 0.75], [5, 0.75], [6, 0]], 0x6f7579, 10, 0, -1.9, 1.2, 1);
  for (const x of [-18.6, 18.6]) k.lathe([[-1.8, 0], [-1.6, 0.42], [1.4, 0.42], [1.9, 0]], 0x6f7579, 8, x, 1.6);
  return k.build();
}

function airliner(): THREE.BufferGeometry {
  const body = 0xf1f1ef;
  const wing = 0xc3c8cc;
  const k = new Kit();
  k.lathe([[-18.8, 0], [-18, 0.55], [-12, 1.9], [-6, 2], [12, 2], [16, 1.62], [18.1, 0.9], [18.8, 0]], body, 16);
  k.box(4.04, 0.6, 30, 0x3a5c8a, 0, -1.0, -1);
  k.box(4.06, 0.22, 26, 0x2a3138, 0, 0.55, 0.5);
  k.box(1.6, 0.35, 0.6, GLASS, 0, 1.1, 16.6, -0.5);
  k.plate(sym([[1.8, 3.6], [17.1, -5.6], [17.1, -6.7], [6, -3.6], [1.8, -3.8]]), 0.3, wing, -1.25);
  for (const x of [-5.8, 5.8]) {
    k.tube(0.98, 0.85, 4.2, wing, x, -2.4, 3.3);
    k.tube(0.8, 0.8, 0.1, DARK, x, -2.4, 5.42);
  }
  k.plate(sym([[1, -14.4], [6.2, -17.8], [6.2, -18.8], [1, -18.6]]), 0.18, body, 0.4);
  k.fin([[-11, 1.85], [-17.2, 8.3], [-18.8, 8.3], [-18.6, 1.85]], 0.25, 0x1f4f8f);
  return k.build();
}

// ------------------------------------------------------------------ munitions

function drone(): THREE.BufferGeometry {
  const c = 0x4b4c46;
  const k = new Kit();
  k.lathe([[-1.6, 0], [-1.5, 0.16], [-0.6, 0.22], [1.0, 0.21], [1.6, 0.1], [1.75, 0]], c, 10);
  k.plate(sym([[0.12, 1.05], [1.25, -1.1], [1.25, -1.5], [0.12, -1.45]]), 0.06, c);
  for (const x of [-1.25, 1.25]) k.fin([[-1.0, -0.28], [-1.2, 0.36], [-1.55, 0.36], [-1.5, -0.28]], 0.04, c, x);
  k.box(0.07, 0.9, 0.03, DARK, 0, 0, -1.66, 0, 0, 0.5);
  k.box(0.07, 0.9, 0.03, DARK, 0, 0, -1.66, 0, 0, 0.5 + Math.PI / 2);
  return k.build();
}

function cruise(): THREE.BufferGeometry {
  const c = 0x8c9295;
  const k = new Kit();
  k.lathe([[-3.1, 0], [-3.1, 0.2], [-2.9, 0.27], [2.2, 0.27], [2.75, 0.19], [3.1, 0]], c, 12);
  k.plate(sym([[0.2, 0.35], [1.35, 0.1], [1.35, -0.18], [0.2, -0.2]]), 0.03, c, -0.05);
  k.cross([[-2.4, 0.2], [-2.95, 0.62], [-3.1, 0.62], [-3.1, 0.2]], 0.03, c, Math.PI / 4);
  k.box(0.32, 0.22, 0.9, 0x5f6366, 0, -0.3, -1.7);
  return k.build();
}

function tbm(): THREE.BufferGeometry {
  const k = new Kit();
  k.lathe([[-3.65, 0], [-3.65, 0.46], [1.0, 0.46], [1.2, 0.44]], 0x56634a, 16);
  k.lathe([[1.2, 0.44], [2.4, 0.34], [3.3, 0.14], [3.65, 0]], 0x6b6d62, 16);
  k.cross([[-2.5, 0.45], [-3.25, 1.0], [-3.65, 1.0], [-3.65, 0.45]], 0.05, 0x4a5540, Math.PI / 4);
  return k.build();
}

function arm(): THREE.BufferGeometry {
  const c = 0xbdbdb4;
  const k = new Kit();
  k.lathe([[-2.35, 0], [-2.35, 0.17], [1.7, 0.18], [2.15, 0.1], [2.35, 0]], c, 10);
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    k.tube(0.09, 0.09, 1.9, 0xa5a59c, Math.cos(a) * 0.25, Math.sin(a) * 0.25, -0.9, 6);
  }
  k.cross([[0.9, 0.17], [0.1, 0.58], [-0.35, 0.58], [-0.35, 0.17]], 0.03, c);
  k.cross([[-1.8, 0.17], [-2.25, 0.45], [-2.35, 0.45], [-2.35, 0.17]], 0.03, c);
  return k.build();
}

/** Surface-to-air and air-to-air missiles by spec code. */
function interceptor(code: string): THREE.BufferGeometry {
  const k = new Kit();
  if (code === 'LR') {
    k.lathe([[-2.65, 0], [-2.65, 0.2], [1.6, 0.2], [2.3, 0.13], [2.65, 0]], 0xe9e8e1, 12);
    k.cross([[-1.75, 0.2], [-2.45, 0.78], [-2.65, 0.78], [-2.65, 0.2]], 0.04, 0xd8d7cf);
    k.cross([[0.9, 0.2], [0.5, 0.36], [0.2, 0.36], [0.2, 0.2]], 0.02, 0xd8d7cf);
  } else if (code === 'SH') {
    k.lathe([[-1.45, 0], [-1.45, 0.07], [1.1, 0.07], [1.35, 0.04], [1.45, 0]], 0xe0ded5, 8);
    k.cross([[1.0, 0.07], [0.85, 0.2], [0.75, 0.2], [0.75, 0.07]], 0.015, 0xc9c7be);
    k.cross([[-1.15, 0.07], [-1.42, 0.24], [-1.45, 0.24], [-1.45, 0.07]], 0.015, 0xc9c7be, Math.PI / 4);
  } else {
    const c = code === 'AAM' ? 0xc9ced2 : 0xe2e1da;
    k.lathe([[-1.83, 0], [-1.83, 0.09], [1.45, 0.09], [1.7, 0.05], [1.83, 0]], c, 10);
    k.cross([[0.25, 0.09], [-0.25, 0.32], [-0.45, 0.32], [-0.45, 0.09]], 0.015, c);
    k.cross([[-1.42, 0.09], [-1.74, 0.34], [-1.83, 0.34], [-1.83, 0.09]], 0.015, c);
  }
  return k.build();
}

/** High-altitude recon UAV: long slender fuselage, sensor bulge, high-aspect wing, V-tail and a dorsal jet engine. */
function recon(): THREE.BufferGeometry {
  const c = 0xb9bdc0;
  const k = new Kit();
  k.lathe([[-6.8, 0], [-6.5, 0.35], [-3, 0.6], [2, 0.75], [4.6, 0.7], [6.0, 0.45], [6.8, 0]], c, 14, 0, 0, 1, 1.1);
  k.ellipsoid(0.5, 0.45, 0.8, 0x2a2f33, 0, -0.75, 3.8);
  k.lathe([[-2.6, 0], [-2.4, 0.45], [0.8, 0.55], [1.5, 0.3], [1.7, 0]], c, 12, 0, 0.85);
  k.tube(0.4, 0.38, 0.4, NOZZLE, 0, 0.85, -2.8);
  k.plate(sym([[0.6, 1.4], [12, 0.3], [12, -0.5], [0.6, -0.9]]), 0.16, c, 0.35);
  for (const s of [-1, 1]) k.fin([[-4.6, 0.3], [-6.4, 2.6], [-7.1, 2.6], [-6.8, 0.3]], 0.1, c, 0, s * 0.8);
  return k.build();
}

/** Low-level strike jet: two-seat cockpit, wings fully swept for the dash, twin engines, single tall fin, two bombs. */
function strike(): THREE.BufferGeometry {
  const c = 0x6c7464;
  const k = new Kit();
  k.lathe([[-10.5, 0], [-10.2, 0.8], [-5, 1.15], [1, 1.2], [5, 1.0], [8.2, 0.6], [10.5, 0]], c, 14, 0, 0, 1.2, 0.85);
  for (const x of [-0.9, 0.9]) k.tube(0.62, 0.55, 1.0, NOZZLE, x, -0.1, -10.6);
  k.ellipsoid(0.75, 0.55, 2.2, GLASS, 0, 0.8, 5.0);
  k.box(1.4, 0.18, 0.08, c, 0, 0.95, 4.9);
  k.plate(sym([[1.2, 4.5], [2.4, 0.8], [5.6, 0.2], [2.2, -1.2]]), 0.25, c);
  k.plate(sym([[1.2, 1.2], [8.0, -5.6], [8.0, -6.6], [1.4, -3.4]]), 0.16, c, 0.1);
  k.plate(sym([[1.0, -7.6], [4.4, -9.6], [4.4, -10.4], [1.0, -10.2]]), 0.14, c, -0.1);
  k.fin([[-5.8, 0.9], [-9.6, 5.2], [-10.8, 5.2], [-10.4, 0.9]], 0.16, c);
  for (const x of [-0.75, 0.75]) {
    k.lathe([[-1.9, 0], [-1.7, 0.26], [1.3, 0.26], [1.9, 0]], 0x4f5a40, 8, x, -1.25);
    k.cross([[-1.5, 0.26], [-1.9, 0.45], [-1.9, 0.26]], 0.02, 0x4f5a40, Math.PI / 4);
  }
  return k.build();
}

/** Winged glide bomb: a heavy bomb body with a strap-on kit of long folding wings and an X tail. */
function bomb(): THREE.BufferGeometry {
  const c = 0x4f5a40;
  const k = new Kit();
  k.lathe([[-1.7, 0], [-1.6, 0.18], [-1.1, 0.24], [0.8, 0.24], [1.4, 0.16], [1.7, 0]], c, 10);
  k.box(0.3, 0.12, 1.1, 0x3b4430, 0, 0.27, 0.1);
  k.plate(sym([[0.1, 0.3], [1.35, 0.0], [1.35, -0.18], [0.1, -0.05]]), 0.025, 0x3b4430, 0.34);
  k.cross([[-1.15, 0.2], [-1.6, 0.48], [-1.75, 0.48], [-1.72, 0.18]], 0.02, c, Math.PI / 4);
  return k.build();
}

/** Attack helicopter (Apache / Mi-28 class): narrow tandem-cockpit fuselage, stub wings with missile racks, tail boom. */
function helo(): THREE.BufferGeometry {
  const c = 0x4a5238;
  const k = new Kit();
  k.lathe([[-3.2, 0], [-2.8, 0.75], [-0.5, 1.0], [2.6, 0.95], [4.4, 0.72], [5.6, 0.32], [5.9, 0]], c, 12, 0, 0, 0.72, 1.15);
  k.ellipsoid(0.5, 0.62, 2.0, GLASS, 0, 0.75, 3.1);
  k.box(0.08, 0.5, 0.08, DARK, 0, 1.15, 2.4);
  k.tube(0.42, 0.2, 7.2, c, 0, 0.35, -6.4);
  k.fin([[-9.0, 0.3], [-9.9, 2.6], [-10.6, 2.6], [-10.3, 0.3]], 0.12, c);
  k.plate(sym([[0.1, -9.3], [1.5, -9.5], [1.5, -10.1], [0.1, -10.1]]), 0.08, c, 0.45);
  // Engines either side of the rotor mast, with exhausts angled out.
  for (const x of [-0.92, 0.92]) {
    k.tube(0.4, 0.36, 2.8, c, x, 0.85, 0.2);
    k.tube(0.3, 0.3, 0.5, NOZZLE, x * 1.1, 0.85, -1.4);
  }
  k.box(0.9, 0.5, 1.6, c, 0, 1.15, 0.4);
  k.box(0.22, 0.75, 0.22, DARK, 0, 1.7, 0.4);
  // Stub wings with a rocket pod and a four-round missile rack on each side.
  k.plate(sym([[0.5, 1.0], [2.5, 0.85], [2.5, 0.0], [0.5, -0.15]]), 0.12, c, 0.15);
  for (const x of [-2.25, 2.25]) {
    k.lathe([[-0.8, 0], [-0.75, 0.24], [0.7, 0.24], [0.8, 0.1]], 0x3d442e, 8, x, -0.2);
    for (const [dx, dy] of [[-0.12, -0.08], [0.12, -0.08], [-0.12, -0.3], [0.12, -0.3]]) k.tube(0.07, 0.07, 1.6, 0x5c6346, x * 0.62 + dx, dy, 0.55, 6);
  }
  // Chin gun, landing gear and tail wheel.
  k.ellipsoid(0.28, 0.24, 0.28, DARK, 0, -0.85, 4.1);
  k.box(0.06, 0.06, 1.5, DARK, 0, -0.95, 4.9);
  for (const x of [-1.05, 1.05]) {
    k.box(0.08, 0.9, 0.08, DARK, x * 0.85, -0.85, 1.9);
    k.wheel(0.32, 0.2, TYRE, x, -1.3, 1.9);
  }
  k.wheel(0.18, 0.12, TYRE, 0, -0.35, -9.4);
  return k.build();
}

/** Main rotor (four blades and hub), spun about Y. */
function heloRotor(): THREE.BufferGeometry {
  const k = new Kit();
  k.ellipsoid(0.35, 0.18, 0.35, DARK, 0, 0, 0);
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + 0.2;
    k.box(0.5, 0.05, 7.2, 0x2f322b, Math.sin(a) * 3.75, 0, Math.cos(a) * 3.75, 0, a, 0);
  }
  return k.build();
}

/** Tail rotor on the left of the fin, spun about X. */
function heloTail(): THREE.BufferGeometry {
  const k = new Kit();
  k.box(0.04, 2.6, 0.22, 0x2f322b);
  k.box(0.04, 0.22, 2.6, 0x2f322b);
  return k.build();
}

/** Small anti-tank guided missile: slim body, four mid-body wings and tail fins. */
function atgm(): THREE.BufferGeometry {
  const c = 0x6b6e5c;
  const k = new Kit();
  k.lathe([[-0.8, 0], [-0.8, 0.09], [0.6, 0.09], [0.75, 0.06], [0.8, 0]], c, 8);
  k.cross([[0.1, 0.09], [-0.15, 0.24], [-0.3, 0.24], [-0.3, 0.09]], 0.01, c, Math.PI / 4);
  k.cross([[-0.6, 0.09], [-0.75, 0.17], [-0.8, 0.17], [-0.8, 0.09]], 0.01, c);
  return k.build();
}

/** Resupply convoy: four canvas-backed trucks in column, nose along +Z like the air models (it is steered the same way). */
function convoy(): THREE.BufferGeometry {
  const k = new Kit();
  const c = 0x5b6236;
  for (let i = 0; i < 4; i++) {
    const z0 = 22 - i * 15;
    k.box(2.5, 0.5, 8.6, 0x2c2e26, 0, 1.0, z0);
    k.box(2.5, 2.2, 2.2, c, 0, 2.2, z0 + 3.1);
    k.box(2.2, 0.8, 0.06, GLASS, 0, 2.7, z0 + 4.22);
    k.box(2.5, 2.4, 5.6, i % 2 ? 0x6b6a4c : 0x626447, 0, 2.6, z0 - 1.3);
    for (const x of [-1.2, 1.2]) for (const dz of [3.1, -0.6, -2.4]) k.wheel(0.55, 0.4, TYRE, x, 0.55, z0 + dz);
  }
  // The sim carries the convoy 2 m above the road.
  return k.build().translate(0, -2, 0);
}

const AIR: Record<string, () => THREE.BufferGeometry> = {
  convoy,
  helo,
  atgm,
  strike,
  bomb,
  recon,
  fighter,
  sead,
  bomber,
  soj,
  airliner,
  drone,
  cruise,
  tbm,
  arm,
};

const geoCache = new Map<string, THREE.BufferGeometry>();

function cached(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = geoCache.get(key);
  if (!g) {
    g = make();
    geoCache.set(key, g);
  }
  return g;
}

/** Painted metal for live models; the charred variant replaces it on wrecks. */
export const MODEL_MAT = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.35, roughness: 0.5 });
export const CHARRED_MAT = new THREE.MeshStandardMaterial({ vertexColors: true, color: 0x2b2826, metalness: 0.1, roughness: 0.95 });

/**
 * The model for an entity kind, or for an interceptor by spec code. Unknown kinds fall back to a cruise
 * missile for munitions and a fighter for aircraft, so new kinds from the sim still draw something sensible.
 */
export function airModel(kind: string, munition = false): THREE.Mesh {
  const key = AIR[kind] ? kind : /drone|decoy|uav|loiter/i.test(kind) ? 'drone' : munition ? 'cruise' : 'fighter';
  const body = new THREE.Mesh(cached(key, AIR[key]), MODEL_MAT);
  if (key === 'helo') {
    // Rotors are children so View3D can spin them; the blur disc goes when it becomes a wreck.
    const rotor = new THREE.Mesh(cached('helo-rotor', heloRotor), MODEL_MAT);
    rotor.name = 'rotor';
    rotor.position.set(0, 2.1, 0.4);
    const disc = new THREE.Mesh(ROTOR_DISC, ROTOR_BLUR_MAT);
    disc.name = 'blur';
    rotor.add(disc);
    const tail = new THREE.Mesh(cached('helo-tail', heloTail), MODEL_MAT);
    tail.name = 'tailrotor';
    tail.position.set(-0.22, 1.9, -10.1);
    body.add(rotor, tail);
  }
  return body;
}

const ROTOR_DISC = new THREE.CircleGeometry(7.4, 32).rotateX(-Math.PI / 2);
const ROTOR_BLUR_MAT = new THREE.MeshBasicMaterial({ color: 0x2f322b, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide });

export function interceptorModel(code: string): THREE.Mesh {
  return new THREE.Mesh(
    cached(`msl-${code}`, () => interceptor(code)),
    MODEL_MAT,
  );
}

/** Overall length of each air model in metres, so View3D can keep every kind a readable size on screen. */
export const MODEL_LEN: Record<string, number> = {
  convoy: 60,
  fighter: 16,
  sead: 17,
  strike: 21,
  bomber: 42,
  soj: 36,
  airliner: 40,
  recon: 10,
  helo: 17,
  drone: 3.5,
  cruise: 6,
  tbm: 12,
  arm: 4.2,
  bomb: 3.4,
  atgm: 1.6,
};

/** Rough size of each kind, for wreck fires and crash effects (1 = a cruise missile). */
export const WRECK_SIZE: Record<string, number> = {
  helo: 1.5,
  atgm: 0.3,
  strike: 1.8,
  bomb: 0.7,
  recon: 1.4,
  drone: 0.6,
  arm: 0.5,
  cruise: 1,
  tbm: 1.2,
  fighter: 1.6,
  sead: 1.8,
  soj: 2.2,
  bomber: 2.6,
  airliner: 3,
};

// ------------------------------------------------------------------ ground units

const OLIVE = 0x56603a;
const OLIVE_D = 0x454d2e;
const TYRE = 0x1f1f1d;

/** A wheeled chassis of length len with axles at the given z positions and the cab at the cab end (-1 is -Z). */
function chassis(k: Kit, len: number, w: number, axles: number[], cab: -1 | 1 = -1, color = OLIVE): void {
  k.box(w * 0.9, 0.5, len, OLIVE_D, 0, 1.0, 0);
  for (const z of axles) for (const x of [-w / 2 + 0.2, w / 2 - 0.2]) k.wheel(0.55, 0.4, TYRE, x, 0.55, z);
  k.box(w, 2.0, 2.2, color, 0, 2.2, cab * (len / 2 - 1.1));
  k.box(w * 0.8, 0.5, 0.05, GLASS, 0, 2.6, cab * (len / 2 + 0.01));
}

/** Canisters of the given cross-section pivoting at z = pz, raised by el with their far end towards -Z (the threat). */
function canisters(k: Kit, xs: number[], dys: number[], size: number, len: number, el: number, pz: number, py: number, color: number): void {
  const cy = py + Math.sin(el) * (len / 2);
  const cz = pz - Math.cos(el) * (len / 2);
  for (const x of xs) for (const dy of dys) k.box(size, size, len, color, x, cy + dy * Math.cos(el), cz + dy * Math.sin(el), el);
}

/** LR: semi-trailer with four large canisters raised towards the threat, tractor at the back. */
function launcherLR(): THREE.BufferGeometry {
  const k = new Kit();
  chassis(k, 12, 2.6, [-4.8, -3.6, 1.0, 4.2, 5.2], 1);
  k.box(2.6, 0.6, 9.2, OLIVE, 0, 1.5, -1.4);
  canisters(k, [-0.55, 0.55], [-0.55, 0.55], 1.0, 6.2, 0.66, 3.2, 2.9, OLIVE);
  k.box(0.3, 3.2, 0.3, OLIVE_D, 0, 2.6, -0.4, -0.5);
  return k.build();
}

/** MR: trailer with a 2 x 3 pack of small canisters. */
function launcherMR(): THREE.BufferGeometry {
  const k = new Kit();
  chassis(k, 9, 2.5, [-3.0, -1.8, 3.2], 1);
  k.box(2.4, 0.6, 6.4, OLIVE, 0, 1.5, -1.2);
  canisters(k, [-0.75, 0, 0.75], [-0.36, 0.36], 0.68, 4.4, 0.5, 1.8, 2.5, 0x5f6a40);
  return k.build();
}

/** SHORAD: tracked carrier with a turret (the radar mast is the rotating antenna) and two missile pods. */
function shoradHull(): THREE.BufferGeometry {
  const k = new Kit();
  k.box(3.2, 1.3, 7, OLIVE, 0, 1.25, 0);
  k.box(3.0, 0.5, 2.0, OLIVE, 0, 1.6, -3.3, -0.5);
  for (const x of [-1.45, 1.45]) {
    k.box(0.55, 0.9, 6.8, TYRE, x, 0.55, 0);
    for (let i = 0; i < 6; i++) k.wheel(0.38, 0.5, 0x2b2b28, x, 0.45, -2.6 + i * 1.04);
  }
  k.box(2.2, 1.1, 2.6, OLIVE_D, 0, 2.45, 0.6);
  for (const x of [-1.5, 1.5]) for (const dy of [0, 0.42]) k.box(0.4, 0.4, 2.2, 0x5f6a40, x, 2.5 + dy, 0.4);
  return k.build();
}

function radarBase(trailer: number): THREE.BufferGeometry {
  const k = new Kit();
  chassis(k, trailer, 2.5, [-trailer / 2 + 1.0, trailer / 2 - 2.0, trailer / 2 - 0.9]);
  k.box(2.4, 2.2, trailer - 2.6, OLIVE, 0, 2.3, 1.2);
  for (const x of [-1.6, 1.6]) for (const z of [-trailer / 2 + 0.5, trailer / 2 - 0.5]) k.box(0.2, 1.2, 0.2, OLIVE_D, x * 1.2, 0.6, z);
  return k.build();
}

/** Antenna faces for the rotating or sector radars; the face points along +Z of its group. */
function antenna(sig: string): THREE.BufferGeometry {
  const k = new Kit();
  if (sig === 'LR') {
    k.box(4.2, 4.2, 0.6, OLIVE, 0, 0, 0);
    k.add(new THREE.CylinderGeometry(1.8, 1.8, 0.1, 28), 0x6c7552, 0, 0, 0.33, Math.PI / 2);
    for (const x of [-1.8, 1.8]) k.add(new THREE.CylinderGeometry(0.35, 0.35, 0.1, 12), 0x6c7552, x, -1.6, 0.33, Math.PI / 2);
  } else if (sig === 'EW') {
    k.box(14, 4.6, 0.4, 0x4f5636, 0, 0, 0);
    for (let i = -6; i <= 6; i += 1.5) k.box(0.12, 4.6, 0.1, 0x3d432a, i, 0, 0.24);
    k.box(10, 0.4, 1.6, OLIVE_D, 0, -2.2, -0.8);
    k.box(0.4, 4.4, 1.6, OLIVE_D, 0, 0, -0.8);
  } else if (sig === 'CIWS') {
    k.box(1.2, 0.6, 0.2, 0x444444);
  } else {
    // MR and SHORAD: a lighter rotating planar array with a back frame.
    const [w, h] = sig === 'SH' ? [2.2, 1.0] : [6.4, 2.6];
    k.box(w, h, 0.35, 0x4f5636, 0, 0, 0);
    k.box(w * 0.92, h * 0.85, 0.06, 0x606a44, 0, 0, 0.2);
    k.box(w * 0.5, 0.25, 0.8, OLIVE_D, 0, -h / 2, -0.4);
  }
  return k.build();
}

/** A tapered lattice mast of the given height, as four legs and cross bracing. */
function mast(hgt: number): THREE.BufferGeometry {
  const k = new Kit();
  const b = Math.max(0.5, hgt * 0.07);
  const t = b * 0.45;
  const lean = Math.atan2(b - t, hgt);
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) k.box(0.16, hgt, 0.16, 0x5a5d58, (sx * (b + t)) / 2, hgt / 2, (sz * (b + t)) / 2, -sz * lean, 0, sx * lean);
  const rungs = Math.max(2, Math.round(hgt / 2.5));
  for (let i = 1; i <= rungs; i++) {
    const y = (i / rungs) * hgt * 0.98;
    const w = 2 * (b + (t - b) * (y / hgt));
    k.box(w, 0.1, 0.1, 0x5a5d58, 0, y, w / 2).box(w, 0.1, 0.1, 0x5a5d58, 0, y, -w / 2);
    k.box(0.1, 0.1, w, 0x5a5d58, w / 2, y, 0).box(0.1, 0.1, w, 0x5a5d58, -w / 2, y, 0);
  }
  return k.build();
}

/** CIWS: trailer mount; the turret is separate so it can traverse. */
function ciwsBase(): THREE.BufferGeometry {
  const k = new Kit();
  chassis(k, 8, 2.5, [-2.8, 2.2, 3.2]);
  k.box(2.6, 0.7, 5, OLIVE, 0, 1.5, 1.2);
  k.add(new THREE.CylinderGeometry(1.1, 1.3, 0.5, 16), OLIVE_D, 0, 2.05, 1.2);
  return k.build();
}

/**
 * The traversing part of the CIWS: a pedestal on the yaw axis, and the elevating mass (magazine drum,
 * radome and six-barrel gun) built around the pitch axis with the gun along +Z.
 */
function ciwsTurret(): { yaw: THREE.BufferGeometry; gun: THREE.BufferGeometry } {
  const y = new Kit();
  y.box(1.6, 0.9, 1.6, 0xc9cbc6, 0, 0.45, 0);
  for (const x of [-0.85, 0.85]) y.box(0.22, 1.3, 0.7, 0xc9cbc6, x, 1.2, 0);
  const g = new Kit();
  g.tube(0.55, 0.55, 1.7, 0xe6e7e3, 0, 0, -0.35, 16);
  g.ellipsoid(0.62, 0.72, 0.62, 0xeeeeea, 0, 1.0, -0.1);
  g.box(0.5, 0.35, 0.08, 0x3a3a3a, 0, 1.55, 0.25);
  g.tube(0.24, 0.24, 0.45, 0x8a8c88, 0, -0.1, 0.7, 12);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    g.tube(0.045, 0.045, 2.2, 0x2e2e2e, Math.cos(a) * 0.12, -0.1 + Math.sin(a) * 0.12, 1.9, 6);
  }
  return { yaw: y.build(), gun: g.build() };
}

/** Skyburst: towed four-wheel trailer with levelling jacks; the twin 35 mm turret is separate. */
function gun35Base(): THREE.BufferGeometry {
  const k = new Kit();
  k.box(2.4, 0.7, 6.0, OLIVE, 0, 0.95, 0);
  k.box(0.25, 0.25, 2.2, OLIVE_D, 0, 0.75, -4.0);
  for (const z of [-1.7, 1.7]) for (const x of [-1.15, 1.15]) k.wheel(0.5, 0.35, TYRE, x, 0.5, z);
  for (const x of [-2.2, 2.2]) for (const z of [-2.4, 2.4]) {
    k.box(2.0, 0.15, 0.2, OLIVE_D, x / 2, 0.8, z);
    k.box(0.5, 0.1, 0.5, OLIVE_D, x, 0.05, z);
  }
  k.add(new THREE.CylinderGeometry(1.0, 1.1, 0.3, 16), OLIVE_D, 0, 1.45, 0);
  return k.build();
}

function gun35Turret(): { yaw: THREE.BufferGeometry; gun: THREE.BufferGeometry } {
  const y = new Kit();
  y.box(2.1, 1.2, 2.4, 0x5f6a40, 0, 0.6, -0.2);
  y.box(1.7, 0.5, 1.4, 0x56603a, 0, 1.45, 0.3);
  y.add(new THREE.CylinderGeometry(0.35, 0.35, 0.25, 12), 0x3d432a, 0.6, 1.8, 0.2);
  const g = new Kit();
  g.box(1.3, 0.7, 1.4, 0x56603a, 0, 0, -0.2);
  for (const x of [-0.42, 0.42]) {
    g.tube(0.16, 0.16, 1.0, 0x4a4f36, x, 0, 0.9, 10);
    g.tube(0.06, 0.07, 3.0, 0x2e2e2e, x, 0, 2.9, 8);
    g.tube(0.1, 0.1, 0.35, 0x2e2e2e, x, 0, 4.4, 8);
  }
  return { yaw: y.build(), gun: g.build() };
}

/** Counter-drone laser: a 6x6 truck; the beam director turret is separate. */
function laserBase(): THREE.BufferGeometry {
  const k = new Kit();
  chassis(k, 9, 2.55, [-2.9, 1.6, 3.0]);
  k.box(2.5, 2.0, 5.2, OLIVE, 0, 2.3, 1.6);
  k.box(1.0, 0.6, 1.2, 0x3d432a, 0.6, 3.6, 3.4);
  for (let i = 0; i < 4; i++) k.box(0.05, 0.9, 1.0, 0x2f3424, 1.28, 2.3, 0.6 + i * 1.1);
  return k.build();
}

function laserTurret(): { yaw: THREE.BufferGeometry; gun: THREE.BufferGeometry } {
  const y = new Kit();
  y.add(new THREE.CylinderGeometry(0.55, 0.7, 0.8, 14), 0x6f7552, 0, 0.4, 0);
  for (const x of [-0.75, 0.75]) y.box(0.2, 1.3, 0.6, 0x6f7552, x, 1.0, 0);
  const g = new Kit();
  g.box(1.2, 1.1, 1.3, 0x7a8160, 0, 0, 0);
  g.tube(0.42, 0.42, 0.2, 0x7a8160, 0, 0.05, 0.72, 20);
  g.tube(0.34, 0.34, 0.05, 0x101820, 0, 0.05, 0.84, 20);
  g.box(0.35, 0.3, 0.5, 0x3d432a, 0.45, 0.62, 0.15);
  g.add(new THREE.SphereGeometry(0.12, 10, 6), 0x101820, 0.45, 0.62, 0.42);
  return { yaw: y.build(), gun: g.build() };
}

/** EW jammer: a shelter truck with a telescopic mast; the emitter head is built separately at the mast top. */
function jammerBase(): THREE.BufferGeometry {
  const k = new Kit();
  chassis(k, 9, 2.55, [-2.9, 1.6, 3.0]);
  k.box(2.5, 2.4, 5.4, 0x5a6440, 0, 2.5, 1.5);
  k.box(0.9, 0.8, 0.9, OLIVE_D, -0.6, 4.1, 3.5);
  for (const x of [-1.3, 1.3]) k.box(0.05, 1.6, 0.9, 0x3d432a, x, 2.5, 0.2);
  // Telescopic mast in three sections from the shelter roof.
  const sec: [number, number, number][] = [[0.22, 3.7, 2.4], [0.16, 6.0, 2.4], [0.11, 8.3, 2.4]];
  for (const [r, y, h] of sec) k.add(new THREE.CylinderGeometry(r, r, h, 8), 0x6a6d66, 0, y, 1.5);
  return k.build();
}

/** Jammer emitter head: a horizontal boom of four log-periodic antennas and a flat panel array. */
function jammerHead(): THREE.BufferGeometry {
  const k = new Kit();
  k.box(3.2, 0.14, 0.14, 0x5a5d58, 0, 0, 0);
  for (const x of [-1.5, -0.5, 0.5, 1.5]) {
    k.box(0.06, 0.06, 1.2, 0x5a5d58, x, 0, 0.6);
    for (let i = 0; i < 5; i++) k.box(0.9 - i * 0.15, 0.03, 0.03, 0x8a8c86, x, 0, 0.15 + i * 0.22);
  }
  k.box(1.6, 1.0, 0.12, 0x4b5230, 0, 0.7, -0.15);
  return k.build();
}

/** Main battle tank: hull with a sloped glacis, tracks, a turret and a long gun. Faces -Z like the other ground units. */
function tank(): THREE.BufferGeometry {
  const k = new Kit();
  const c = 0x5a6138;
  k.box(3.4, 1.0, 6.8, c, 0, 1.15, 0);
  k.box(3.4, 0.5, 1.2, c, 0, 1.4, -3.6, -0.5, 0, 0);
  for (const x of [-1.55, 1.55]) {
    k.box(0.6, 0.95, 7.0, TYRE, x, 0.5, 0);
    k.box(0.7, 0.12, 7.0, c, x, 1.05, 0);
  }
  k.box(2.4, 0.75, 3.2, c, 0, 2.0, 0.4);
  k.box(1.8, 0.6, 0.9, c, 0, 1.95, -1.4, -0.4, 0, 0);
  k.tube(0.09, 0.11, 4.8, 0x4a4f30, 0, 2.05, -3.6, 8);
  k.box(0.5, 0.3, 0.5, OLIVE_D, 0.6, 2.5, 0.8);
  return k.build();
}

/** Infantry fighting vehicle: a taller, boxier hull with a small turret and autocannon. */
function ifv(): THREE.BufferGeometry {
  const k = new Kit();
  const c = 0x5f6640;
  k.box(3.1, 1.5, 6.2, c, 0, 1.35, 0);
  k.box(3.1, 0.5, 1.0, c, 0, 1.6, -3.25, -0.6, 0, 0);
  for (const x of [-1.45, 1.45]) k.box(0.5, 0.85, 6.2, TYRE, x, 0.45, 0);
  k.box(1.5, 0.55, 1.8, c, -0.3, 2.35, -0.2);
  k.tube(0.05, 0.05, 2.6, 0x3d4228, -0.3, 2.4, -2.2, 6);
  k.box(0.9, 0.9, 0.08, OLIVE_D, 0, 1.4, 3.1);
  return k.build();
}

const GROUND: Record<string, () => THREE.BufferGeometry> = {
  tank,
  ifv,
  'jammer-base': jammerBase,
  'jammer-head': jammerHead,
  'gun35-base': gun35Base,
  'gun35-yaw': () => gun35Turret().yaw,
  'gun35-gun': () => gun35Turret().gun,
  'laser-base': laserBase,
  'laser-yaw': () => laserTurret().yaw,
  'laser-gun': () => laserTurret().gun,
  'launcher-LR': launcherLR,
  'launcher-MR': launcherMR,
  'shorad-hull': shoradHull,
  'radar-base-LR': () => radarBase(10),
  'radar-base': () => radarBase(8),
  'ciws-base': ciwsBase,
  'ciws-yaw': () => ciwsTurret().yaw,
  'ciws-gun': () => ciwsTurret().gun,
};

/** A ground-unit part by name; antennas take `antenna-<signature>` and masts `mast-<height>`. */
const WALLS = [0xd8d0bc, 0xcfc4a8, 0xe4ddd0, 0xc9b58f, 0xb9a98a, 0xd6c7b0];
const ROOFS = [0x8e4a32, 0x7a3d2a, 0x9a5a3c, 0x5c5a58, 0x6b4a3a];

/** A gabled house or church nave: walls, and a pitched roof as an extruded triangle, along local Z. */
function house(k: Kit, w: number, h: number, l: number, wall: number, roof: number, x: number, y: number, z: number, ry: number): void {
  k.box(w, h, l, wall, x, y + h / 2, z, 0, ry, 0);
  const pitch = w * 0.42;
  const tri = new THREE.Shape([new THREE.Vector2(-w / 2 - 0.4, 0), new THREE.Vector2(w / 2 + 0.4, 0), new THREE.Vector2(0, pitch)]);
  const g = new THREE.ExtrudeGeometry(tri, { depth: l + 0.6, bevelEnabled: false });
  g.translate(0, 0, -(l + 0.6) / 2);
  k.add(g, roof, x, y + h, z, 0, ry, 0);
}

/**
 * A front-line town about 700 m across: a main street and a cross street of houses with pitched roofs, a
 * square with a church and spire, and outlying farms. Each building sits on the ground under it
 * (`ground` gives the height relative to the site's origin), and `seed` varies the layout.
 */
export function townGeometry(seed: number, ground: (x: number, z: number) => number): THREE.BufferGeometry {
  let a = seed >>> 0 || 1;
  const rnd = (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
  const k = new Kit();
  const rot = rnd() * Math.PI;
  const cs = Math.cos(rot);
  const sn = Math.sin(rot);
  // Local street frame (u along the main street, v across) to site coordinates.
  const at = (u: number, v: number): [number, number] => [u * cs + v * sn, -u * sn + v * cs];
  const street = (len: number, wid: number, angle: number): void => {
    for (let u = -len / 2; u < len / 2; u += 40) {
      const [x, z] = at(Math.cos(angle) * (u + 20), Math.sin(angle) * (u + 20));
      k.box(wid, 0.3, 42, 0x4a4844, x, ground(x, z) + 0.15, z, 0, rot + angle + Math.PI / 2, 0);
    }
  };
  street(760, 8, 0);
  street(480, 6, Math.PI / 2);
  // The square and its church.
  k.box(46, 0.25, 46, 0x8d8780, 0, ground(0, 0) + 0.12, 0, 0, rot, 0);
  const [cx, cz] = at(-34, 24);
  const cy = ground(cx, cz);
  house(k, 12, 11, 26, 0xd9d2c3, 0x5c5a58, cx, cy, cz, rot + Math.PI / 2);
  const [tx, tz] = at(-50, 24);
  k.box(7, 26, 7, 0xd9d2c3, tx, cy + 13, tz, 0, rot, 0);
  k.add(new THREE.ConeGeometry(4.6, 16, 4).rotateY(Math.PI / 4), 0x4f5d55, tx, cy + 34, tz, 0, rot, 0);
  // Houses lining both sides of both streets, with gaps.
  const lineStreet = (len: number, angle: number, setback: number): void => {
    for (const side of [-1, 1]) {
      for (let u = -len / 2; u < len / 2; u += 13 + rnd() * 10) {
        if (Math.abs(u) < 32 || rnd() < 0.15) continue;
        const off = setback + rnd() * 6;
        const uu = Math.cos(angle) * u - Math.sin(angle) * side * off;
        const vv = Math.sin(angle) * u + Math.cos(angle) * side * off;
        const [x, z] = at(uu, vv);
        const w = 7 + rnd() * 4;
        house(k, w, 5 + rnd() * 3 + (rnd() < 0.2 ? 3 : 0), 9 + rnd() * 5, pick(WALLS), pick(ROOFS), x, ground(x, z), z, rot + angle + (rnd() < 0.5 ? 0 : Math.PI / 2));
      }
    }
  };
  lineStreet(700, 0, 15);
  lineStreet(440, Math.PI / 2, 13);
  // A second row behind the main street, then the old town filling in the blocks round the square.
  lineStreet(520, 0, 38);
  for (let u = -230; u <= 230; u += 21) {
    for (let v = -200; v <= 200; v += 21) {
      if (Math.abs(v) < 24 || Math.abs(u) < 22 || (Math.abs(u) < 70 && Math.abs(v) < 70)) continue;
      const r = Math.hypot(u, v * 1.2);
      if (r > 240 || rnd() > 0.55 * (1 - r / 260)) continue;
      const [x, z] = at(u + (rnd() - 0.5) * 6, v + (rnd() - 0.5) * 6);
      house(k, 7 + rnd() * 4, 5 + rnd() * 4, 9 + rnd() * 5, pick(WALLS), pick(ROOFS), x, ground(x, z), z, rot + (rnd() < 0.5 ? 0 : Math.PI / 2));
    }
  }
  // Farms on the edge, each a house and a barn.
  for (let i = 0; i < 7; i++) {
    const ang = rnd() * Math.PI * 2;
    const r = 330 + rnd() * 120;
    const x = Math.cos(ang) * r;
    const z = Math.sin(ang) * r;
    const y = ground(x, z);
    const ry = rnd() * Math.PI;
    house(k, 9, 6, 13, pick(WALLS), pick(ROOFS), x, y, z, ry);
    house(k, 14, 7, 24, 0x7a6450, 0x5c5a58, x + Math.cos(ry) * 22, ground(x + Math.cos(ry) * 22, z - Math.sin(ry) * 22), z - Math.sin(ry) * 22, ry);
  }
  return k.build();
}

export function groundGeometry(name: string): THREE.BufferGeometry {
  if (name.startsWith('antenna-')) return cached(name, () => antenna(name.slice(8)));
  if (name.startsWith('mast-')) return cached(name, () => mast(Number(name.slice(5))));
  return cached(name, GROUND[name]);
}
