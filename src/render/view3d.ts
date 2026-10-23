import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { DEG } from '../sim/constants';
import type { Entity, Kind } from '../sim/entities';
import { V3, clamp, polar } from '../sim/math';
import type { Radar } from '../sim/radar';
import type { Ciws } from '../sim/ciws';
import type { Site } from '../sim/sites';
import type { World } from '../sim/world';
import { IDENT_COLOR } from '../ui/colors';

/** Sim frame (x east, y north, z up) to three.js frame (x east, y up, z south). */
export const toThree = (p: V3, out = new THREE.Vector3()): THREE.Vector3 => out.set(p.x, p.z, -p.y);

function canvasTexture(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  draw(g, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const glowTex = canvasTexture(64, (g, s) => {
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, 'rgba(255,255,230,1)');
  grd.addColorStop(0.25, 'rgba(255,190,90,0.9)');
  grd.addColorStop(0.6, 'rgba(200,80,20,0.35)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
});

const smokeTex = canvasTexture(64, (g, s) => {
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, 'rgba(120,110,100,0.8)');
  grd.addColorStop(1, 'rgba(80,70,60,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
});

function markerTex(color: string, shape: 'circle' | 'diamond' | 'square' | 'dot' | 'ring'): THREE.CanvasTexture {
  return canvasTexture(64, (g, s) => {
    g.strokeStyle = color;
    g.fillStyle = color;
    g.lineWidth = 6;
    g.beginPath();
    const m = s / 2;
    const r = s * 0.36;
    if (shape === 'circle') g.arc(m, m, r, 0, Math.PI * 2);
    else if (shape === 'ring') {
      g.lineWidth = 4;
      g.arc(m, m, r + 4, 0, Math.PI * 2);
    } else if (shape === 'diamond') {
      g.moveTo(m, m - r);
      g.lineTo(m + r, m);
      g.lineTo(m, m + r);
      g.lineTo(m - r, m);
      g.closePath();
    } else if (shape === 'square') g.rect(m - r * 0.8, m - r * 0.8, r * 1.6, r * 1.6);
    else g.arc(m, m, r * 0.45, 0, Math.PI * 2);
    if (shape === 'dot') g.fill();
    else g.stroke();
  });
}

const MARKERS = {
  red: markerTex('#ff5050', 'diamond'),
  blue: markerTex('#4da6ff', 'circle'),
  neutral: markerTex('#5ee07a', 'square'),
  site: markerTex('#7fc1ff', 'square'),
  dead: markerTex('#666666', 'square'),
  msl: markerTex('#ffffff', 'dot'),
  sel: markerTex('#ffffff', 'ring'),
};

const mat = (c: number): THREE.MeshLambertMaterial => new THREE.MeshLambertMaterial({ color: c });

/** Build a small procedural model with +Z as the nose direction. */
function model(kind: Kind | 'interceptor'): THREE.Object3D {
  const g = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0, rx = 0): void => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    mesh.rotation.x = rx;
    g.add(mesh);
  };
  switch (kind) {
    case 'fighter':
    case 'sead':
    case 'bomber':
    case 'soj':
    case 'airliner': {
      const L = kind === 'airliner' ? 40 : kind === 'bomber' ? 45 : kind === 'soj' ? 35 : 15;
      const color = kind === 'fighter' ? 0x8899aa : kind === 'airliner' ? 0xeeeeee : 0x6b5a50;
      const m = mat(color);
      add(new THREE.CylinderGeometry(L * 0.05, L * 0.07, L, 8), m, 0, 0, 0, Math.PI / 2);
      add(new THREE.BoxGeometry(L * (kind === 'fighter' || kind === 'sead' ? 0.7 : 1.0), L * 0.02, L * 0.18), m, 0, 0, -L * 0.05);
      add(new THREE.BoxGeometry(L * 0.3, L * 0.02, L * 0.08), m, 0, 0, -L * 0.45);
      add(new THREE.BoxGeometry(L * 0.02, L * 0.15, L * 0.1), m, 0, L * 0.08, -L * 0.45);
      if (kind === 'soj') add(new THREE.CylinderGeometry(L * 0.25, L * 0.25, L * 0.04, 16), mat(0x332222), 0, L * 0.1, -L * 0.1);
      break;
    }
    case 'drone': {
      const shape = new THREE.Shape();
      shape.moveTo(0, 1.8);
      shape.lineTo(1.8, -1.2);
      shape.lineTo(-1.8, -1.2);
      shape.closePath();
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.25, bevelEnabled: false });
      geo.rotateX(Math.PI / 2);
      add(geo, mat(0x4a4a3a));
      break;
    }
    case 'cruise':
      add(new THREE.CylinderGeometry(0.3, 0.3, 6, 8), mat(0x777777), 0, 0, 0, Math.PI / 2);
      add(new THREE.BoxGeometry(2.6, 0.05, 0.5), mat(0x777777));
      break;
    case 'tbm':
      add(new THREE.ConeGeometry(0.5, 4, 10), mat(0x553333), 0, 0, 0, Math.PI / 2);
      break;
    case 'arm':
      add(new THREE.CylinderGeometry(0.15, 0.15, 4.2, 8), mat(0xaa6633), 0, 0, 0, Math.PI / 2);
      break;
    case 'interceptor':
      add(new THREE.CylinderGeometry(0.2, 0.2, 5, 8), mat(0xffffff), 0, 0, 0, Math.PI / 2);
      break;
  }
  return g;
}

interface TrailObj {
  line: THREE.Line;
  pos: Float32Array;
  max: number;
}

function makeTrail(color: number, max = 200, opacity = 0.7): TrailObj {
  const pos = new Float32Array(max * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setDrawRange(0, 0);
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
  line.frustumCulled = false;
  return { line, pos, max };
}

function setTrail(t: TrailObj, pts: V3[], head?: V3): void {
  const n = Math.min(t.max - 1, pts.length);
  const start = pts.length - n;
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    toThree(pts[start + i], v);
    t.pos[i * 3] = v.x;
    t.pos[i * 3 + 1] = v.y;
    t.pos[i * 3 + 2] = v.z;
  }
  let count = n;
  if (head) {
    toThree(head, v);
    t.pos[n * 3] = v.x;
    t.pos[n * 3 + 1] = v.y;
    t.pos[n * 3 + 2] = v.z;
    count++;
  }
  t.line.geometry.setDrawRange(0, count);
  (t.line.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
}

interface EntityObj {
  root: THREE.Group;
  body: THREE.Object3D;
  marker: THREE.Sprite;
  trail: TrailObj | null;
  hist: V3[];
  nextHist: number;
}

export class View3D {
  readonly renderer: THREE.WebGLRenderer;
  readonly labels: CSS2DRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  showTruth = false;
  showLabels = true;
  showCoverage = true;
  follow = false;
  selected: number | null = null;
  onSelect: (trackId: number) => void = () => {};
  private readonly container: HTMLElement;
  private world: World;
  private terrainMesh: THREE.Mesh | null = null;
  private readonly preview = new THREE.Group();
  private readonly raycaster = new THREE.Raycaster();
  private down: { x: number; y: number } | null = null;
  /** Set while the planning screen wants map clicks: called with the ground point clicked. */
  onGroundClick: ((p: V3) => void) | null = null;
  /** Called with the ground point under the pointer while onGroundClick is set. */
  onGroundHover: ((p: V3 | null) => void) | null = null;
  private readonly entityObjs = new Map<number, EntityObj>();
  private readonly missileObjs = new Map<number, { body: THREE.Object3D; trail: TrailObj; flame: THREE.Sprite }>();
  private readonly effectObjs = new Map<number, THREE.Sprite>();
  private readonly trackLabels = new Map<number, { obj: CSS2DObject; el: HTMLDivElement; last: string }>();
  private readonly siteObjs: { site: Site; root: THREE.Group; mats: THREE.MeshLambertMaterial[]; label: CSS2DObject; dead: boolean }[] = [];
  private readonly antennas: { radar: Radar; obj: THREE.Object3D }[] = [];
  private readonly turrets: { ciws: Ciws; yaw: THREE.Object3D; pitch: THREE.Object3D }[] = [];
  private readonly tracers: THREE.Points;
  private readonly tracerPos: Float32Array;
  private readonly coverage = new THREE.Group();
  private readonly selRing: THREE.Sprite;
  private readonly tmp = new THREE.Vector3();

  constructor(container: HTMLElement, world: World) {
    this.container = container;
    this.world = world;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);
    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'labels3d';
    container.appendChild(this.labels.domElement);

    this.camera = new THREE.PerspectiveCamera(50, 1, 5, 900000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 60;
    this.controls.maxDistance = 420000;
    this.setView('defended');

    const sky = new THREE.Color('#a9bccb');
    this.scene.background = sky;
    this.scene.fog = new THREE.Fog(sky, 90000, 340000);
    this.scene.add(new THREE.HemisphereLight(0xdfe9f3, 0x4a4535, 1.1));
    const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
    sun.position.set(-60000, 90000, 50000);
    this.scene.add(sun);

    this.buildTerrain();
    this.buildSites();
    this.buildCoverage();

    const cap = 6000;
    this.tracerPos = new Float32Array(cap * 3);
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(this.tracerPos, 3));
    tg.setDrawRange(0, 0);
    this.tracers = new THREE.Points(tg, new THREE.PointsMaterial({ color: 0xffd27a, size: 2.5, sizeAttenuation: false }));
    this.tracers.frustumCulled = false;
    this.scene.add(this.tracers);

    this.selRing = new THREE.Sprite(new THREE.SpriteMaterial({ map: MARKERS.sel, depthTest: false, transparent: true }));
    this.selRing.scale.setScalar(0.045);
    this.selRing.material.sizeAttenuation = false;
    this.selRing.renderOrder = 10;
    this.selRing.visible = false;
    this.scene.add(this.selRing);

    this.scene.add(this.preview);
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => (this.down = { x: e.clientX, y: e.clientY }));
    el.addEventListener('pointerup', (e) => {
      if (!this.down || !this.onGroundClick || e.button !== 0) return;
      const moved = Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y);
      this.down = null;
      if (moved > 5) return;
      const p = this.pickGround(e.clientX, e.clientY);
      if (p) this.onGroundClick(p);
    });
    el.addEventListener('pointermove', (e) => {
      if (this.onGroundHover) this.onGroundHover(this.pickGround(e.clientX, e.clientY));
    });

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  /** Ground point under a screen position, in sim coordinates. */
  pickGround(clientX: number, clientY: number): V3 | null {
    if (!this.terrainMesh) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.terrainMesh, false)[0];
    if (!hit) return null;
    return { x: hit.point.x, y: -hit.point.z, z: hit.point.y };
  }

  /** Placement preview: a ring of the unit's reach and a marker, or nothing. */
  setPreview(p: V3 | null, rangeKm = 0, ok = true, sector?: { facing: number; half: number }): void {
    for (const c of [...this.preview.children]) {
      this.preview.remove(c);
      if (c instanceof THREE.Line) c.geometry.dispose();
    }
    if (!p) return;
    const color = ok ? 0x9cffc4 : 0xff6060;
    const w = this.world;
    const arc = (r: number, from: number, to: number, closed: boolean): void => {
      const pts: THREE.Vector3[] = [];
      if (closed) pts.push(new THREE.Vector3(p.x, w.terrain.groundAt(p.x, p.y) + 60, -p.y));
      const step = Math.max(0.5, (to - from) / 240);
      for (let a = from; a <= to + 0.01; a += step) {
        const q = polar(a, r);
        const x = p.x + q.x;
        const y = p.y + q.y;
        pts.push(new THREE.Vector3(x, Math.max(0, w.terrain.groundAt(x, y)) + 60, -y));
      }
      if (closed) pts.push(pts[0].clone());
      this.preview.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 })));
    };
    if (rangeKm > 0) {
      if (sector) arc(rangeKm * 1000, sector.facing - sector.half, sector.facing + sector.half, true);
      else arc(rangeKm * 1000, 0, 360, false);
    }
    arc(Math.max(250, rangeKm * 25), 0, 360, false);
  }

  /** Show another world (a new day, the deployment preview) over the same terrain. */
  setWorld(w: World): void {
    this.world = w;
    for (const s of this.siteObjs) {
      this.scene.remove(s.root);
      // CSS2D labels only clean up their DOM element when removed directly, not with a parent.
      s.label.element.remove();
    }
    this.siteObjs.length = 0;
    this.antennas.length = 0;
    this.turrets.length = 0;
    for (const c of [...this.coverage.children]) {
      this.coverage.remove(c);
      if (c instanceof THREE.Line) c.geometry.dispose();
    }
    for (const o of this.entityObjs.values()) {
      this.scene.remove(o.root);
      if (o.trail) this.scene.remove(o.trail.line);
    }
    this.entityObjs.clear();
    for (const o of this.missileObjs.values()) this.scene.remove(o.body, o.trail.line);
    this.missileObjs.clear();
    for (const o of this.effectObjs.values()) this.scene.remove(o);
    this.effectObjs.clear();
    for (const l of this.trackLabels.values()) {
      this.scene.remove(l.obj);
      l.el.remove();
    }
    this.trackLabels.clear();
    this.selected = null;
    this.buildSites();
    this.buildCoverage();
  }

  resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / Math.max(h, 1);
    this.camera.updateProjectionMatrix();
  }

  setView(v: 'defended' | 'overview' | 'north' | 'deploy'): void {
    const views = {
      defended: { pos: [6000, 14000, 30000], tgt: [0, 0, -6000] },
      overview: { pos: [0, 190000, 120000], tgt: [0, 0, -15000] },
      deploy: { pos: [0, 62000, 38000], tgt: [0, 0, -2000] },
      north: { pos: [-15000, 9000, -15000], tgt: [0, 1500, -60000] },
    } as const;
    const s = views[v];
    this.camera.position.set(s.pos[0], s.pos[1], s.pos[2]);
    this.controls.target.set(s.tgt[0], s.tgt[1], s.tgt[2]);
    this.follow = false;
    this.controls.update();
  }

  private buildTerrain(): void {
    const t = this.world.terrain;
    const size = t.half * 2;
    const seg = t.n - 1;
    const geo = new THREE.PlaneGeometry(size, size, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) pos.setY(i, t.heightAt(pos.getX(i), -pos.getZ(i)));
    geo.computeVertexNormals();
    const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    const plains = new THREE.Color('#6e7446');
    const plains2 = new THREE.Color('#857b52');
    const rock = new THREE.Color('#7b7262');
    const highRock = new THREE.Color('#8f8b86');
    const snow = new THREE.Color('#eef2f5');
    const sand = new THREE.Color('#b9a77a');
    const seabed = new THREE.Color('#304a52');
    for (let i = 0; i < pos.count; i++) {
      const h = pos.getY(i);
      const slope = 1 - nrm.getY(i);
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const n = 0.5 + 0.5 * Math.sin(x / 2300 + Math.sin(z / 3100) * 2) * Math.sin(z / 1900);
      if (h < -5) c.copy(seabed);
      else if (h < 8) c.copy(sand);
      else if (h < 450) c.copy(plains).lerp(plains2, n * 0.7);
      else if (h < 1400) c.copy(plains2).lerp(rock, clamp((h - 450) / 900, 0, 1));
      else if (h < 2300) c.copy(rock).lerp(highRock, clamp((h - 1400) / 900, 0, 1));
      else c.copy(highRock).lerp(snow, clamp((h - 2300) / 300, 0, 1));
      if (slope > 0.25 && h > 100) c.lerp(rock, clamp((slope - 0.25) * 2.5, 0, 0.8));
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const terrain = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    this.scene.add(terrain);
    this.terrainMesh = terrain;

    // Low-resolution skirt so the world does not end at the map edge.
    const sk = new THREE.PlaneGeometry(size * 4, size * 4, 120, 120);
    sk.rotateX(-Math.PI / 2);
    const sp = sk.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < sp.count; i++) {
      const x = sp.getX(i);
      const y = -sp.getZ(i);
      const out = Math.max(Math.abs(x), Math.abs(y));
      const fade = clamp(1 - (out - t.half) / (size * 1.2), 0, 1);
      sp.setY(i, Math.max(-60, t.heightAt(x, y)) * fade - 25);
    }
    sk.computeVertexNormals();
    const skirt = new THREE.Mesh(sk, new THREE.MeshLambertMaterial({ color: 0x606846 }));
    this.scene.add(skirt);

    const sea = new THREE.Mesh(
      new THREE.PlaneGeometry(size * 4, size * 1.6),
      new THREE.MeshPhongMaterial({ color: 0x24506e, transparent: true, opacity: 0.9, shininess: 80, specular: 0x557799 }),
    );
    sea.rotateX(-Math.PI / 2);
    sea.position.set(0, 0, 48000 + size * 0.8);
    this.scene.add(sea);
  }

  private siteLabel(text: string): CSS2DObject {
    const el = document.createElement('div');
    el.className = 'site-label';
    el.textContent = text;
    const o = new CSS2DObject(el);
    o.center.set(0.5, -0.4);
    return o;
  }

  private buildSites(): void {
    const w = this.world;
    for (const s of w.sites) {
      const root = new THREE.Group();
      const ground = w.terrain.groundAt(s.pos.x, s.pos.y);
      root.position.set(s.pos.x, ground, -s.pos.y);
      const mats: THREE.MeshLambertMaterial[] = [];
      const m = (c: number): THREE.MeshLambertMaterial => {
        const x = mat(c);
        mats.push(x);
        return x;
      };
      const box = (sx: number, sy: number, sz: number, c: number, x = 0, y = 0, z = 0): THREE.Mesh => {
        const b = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), m(c));
        b.position.set(x, y + sy / 2, z);
        root.add(b);
        return b;
      };
      const olive = 0x5b6236;
      switch (s.kind) {
        case 'asset':
          if (s.name === 'Airbase') {
            box(60, 0.6, 3000, 0x3a3a3a, 0, 0, 0);
            box(25, 0.5, 1800, 0x444444, 120, 0, 200);
            for (let i = 0; i < 5; i++) box(45, 14, 35, 0x8a8a80, 260, 0, -600 + i * 120);
            box(14, 30, 14, 0xb0aea0, -150, 0, 300);
          } else if (s.name === 'Power plant') {
            for (const x of [-60, 60]) {
              const ct = new THREE.Mesh(new THREE.CylinderGeometry(30, 42, 110, 20, 1, true), m(0xc8c4bc));
              ct.position.set(x, 55, 0);
              root.add(ct);
            }
            box(90, 30, 60, 0x9a958c, 0, 0, 110);
            box(6, 120, 6, 0xa05050, 80, 0, 120);
          } else {
            box(30, 8, 22, 0x6a6e58);
            box(2, 25, 2, 0x999999, 12, 0, 8);
          }
          break;
        case 'radar': {
          box(8, 3, 6, olive);
          const radar = w.radars.find((r) => r.pos === s.pos || (r.pos.x === s.pos.x && r.pos.y === s.pos.y));
          const ant = new THREE.Group();
          ant.position.y = s.pos.z - ground;
          const kind = radar?.signature;
          const [pw, ph] = kind === 'LR' ? [6, 6] : kind === 'EW' ? [14, 5] : [7, 3];
          const plate = new THREE.Mesh(new THREE.BoxGeometry(pw, ph, 0.5), m(0x4b5230));
          plate.rotation.x = kind === 'LR' ? -0.4 : -0.2;
          ant.add(plate);
          const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, s.pos.z - ground, 6), m(0x555555));
          mast.position.y = (s.pos.z - ground) / 2;
          root.add(mast);
          root.add(ant);
          if (radar) this.antennas.push({ radar, obj: ant });
          break;
        }
        case 'launcher': {
          box(7, 2.5, 3, olive);
          const can = new THREE.Mesh(new THREE.BoxGeometry(2.6, 2, 7), m(0x50572f));
          can.position.set(0, 3.6, 0);
          can.rotation.x = -0.6;
          root.add(can);
          break;
        }
        case 'ciws': {
          const c = w.ciws.find((x) => x.site === s);
          box(4, 2, 4, olive);
          const yaw = new THREE.Group();
          yaw.position.y = 2;
          const dome = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.1, 2.6, 12), m(0xdddddd));
          dome.position.y = 1.6;
          yaw.add(dome);
          const pitch = new THREE.Group();
          pitch.position.y = 1.2;
          const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 3.5, 6), m(0x333333));
          barrel.rotation.x = Math.PI / 2;
          barrel.position.z = 1.8;
          pitch.add(barrel);
          yaw.add(pitch);
          root.add(yaw);
          if (c) this.turrets.push({ ciws: c, yaw, pitch });
          break;
        }
        case 'gnss':
          box(3, 2, 3, olive);
          box(0.4, 14, 0.4, 0x777777);
          break;
        case 'decoy':
          box(4, 2, 3, olive);
          box(5, 5, 0.4, 0x4b5230, 0, 2, 0);
          break;
      }
      const icon = new THREE.Sprite(new THREE.SpriteMaterial({ map: MARKERS.site, depthTest: false, transparent: true, sizeAttenuation: false }));
      icon.scale.setScalar(s.defended ? 0.018 : 0.011);
      icon.position.y = s.pos.z - ground + 10;
      icon.renderOrder = 5;
      root.add(icon);
      const label = this.siteLabel(s.name);
      label.position.y = s.pos.z - ground + 10;
      if (s.kind === 'launcher') label.visible = false;
      root.add(label);
      this.scene.add(root);
      this.siteObjs.push({ site: s, root, mats, label, dead: false });
    }
  }

  /** Weapon engagement zones and the LR radar sector, draped over the terrain. */
  private buildCoverage(): void {
    const w = this.world;
    const ring = (cx: V3, r: number, color: number, from = 0, to = 360): void => {
      const pts: THREE.Vector3[] = [];
      for (let a = from; a <= to + 0.01; a += 1) {
        const p = polar(a, r);
        const x = cx.x + p.x;
        const y = cx.y + p.y;
        pts.push(new THREE.Vector3(x, Math.max(0, w.terrain.groundAt(x, y)) + 40, -y));
      }
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55 }),
      );
      this.coverage.add(line);
    };
    for (const u of w.units) {
      const r = u.radar!;
      if (u.type === 'LR') {
        ring(r.pos, 120000, 0x6fb6ff, r.boresight - 60, r.boresight + 60);
        ring(r.pos, 40000, 0xb48cff, r.boresight - 60, r.boresight + 60);
        for (const a of [r.boresight - 60, r.boresight + 60]) {
          const pts: THREE.Vector3[] = [];
          for (let d = 0; d <= 120000; d += 1000) {
            const p = polar(a, d);
            const x = r.pos.x + p.x;
            const y = r.pos.y + p.y;
            pts.push(new THREE.Vector3(x, w.terrain.groundAt(x, y) + 40, -y));
          }
          this.coverage.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x6fb6ff, transparent: true, opacity: 0.4 })));
        }
      } else if (u.type === 'MR') {
        for (const l of u.launchers) ring(l.site.pos, 32000, 0x58d68d);
      } else ring(r.pos, 10000, 0xf7dc6f);
    }
    for (const j of w.gnss) ring(j.site.pos, j.rangeM, 0xff8c42);
    for (const f of w.fielded) if (f.unit.type === 'CAP') ring({ x: f.unit.x, y: f.unit.y, z: 0 }, 15000, 0x4da6ff);
    this.scene.add(this.coverage);
  }

  private entityObj(e: Entity): EntityObj {
    let o = this.entityObjs.get(e.id);
    if (o) return o;
    const root = new THREE.Group();
    const body = model(e.kind);
    root.add(body);
    const tex = e.side === 'red' ? MARKERS.red : e.side === 'blue' ? MARKERS.blue : MARKERS.neutral;
    const marker = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, sizeAttenuation: false }));
    marker.scale.setScalar(e.munition ? 0.012 : 0.018);
    marker.renderOrder = 6;
    root.add(marker);
    const trail = e.kind === 'tbm' || e.kind === 'arm' ? makeTrail(e.kind === 'tbm' ? 0xffa060 : 0xff7040, 240, 0.8) : null;
    if (trail) this.scene.add(trail.line);
    this.scene.add(root);
    o = { root, body, marker, trail, hist: [], nextHist: 0 };
    this.entityObjs.set(e.id, o);
    return o;
  }

  private syncEntities(): void {
    const w = this.world;
    const seen = new Set<number>();
    const camPos = this.camera.position;
    for (const e of w.entities) {
      if (!e.alive) continue;
      seen.add(e.id);
      const o = this.entityObj(e);
      const visible = e.airborne && (this.showTruth || e.side === 'blue' || w.t - e.lastDetected < 12);
      o.root.visible = visible;
      toThree(e.pos, o.root.position);
      const d = camPos.distanceTo(o.root.position);
      o.body.scale.setScalar(clamp(d / 1400, 1, 80));
      if (e.speed > 1) {
        this.tmp.set(e.pos.x + e.vel.x, e.pos.z + e.vel.z, -(e.pos.y + e.vel.y));
        o.body.lookAt(this.tmp);
      }
      if (o.trail) {
        if (w.t >= o.nextHist) {
          o.nextHist = w.t + 0.5;
          o.hist.push({ ...e.pos });
          if (o.hist.length > 230) o.hist.shift();
        }
        setTrail(o.trail, o.hist, e.pos);
        o.trail.line.visible = visible;
      }
    }
    for (const [id, o] of this.entityObjs) {
      if (seen.has(id)) continue;
      this.scene.remove(o.root);
      if (o.trail) this.scene.remove(o.trail.line);
      this.entityObjs.delete(id);
    }
  }

  private syncMissiles(): void {
    const w = this.world;
    const seen = new Set<number>();
    const camPos = this.camera.position;
    for (const m of w.missiles) {
      seen.add(m.id);
      let o = this.missileObjs.get(m.id);
      if (!o) {
        const body = model('interceptor');
        const trail = makeTrail(m.spec.code === 'AAM' ? 0xcfe8ff : 0xf0f0f0, 170, 0.65);
        const flame = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, sizeAttenuation: false }));
        flame.scale.setScalar(0.01);
        body.add(flame);
        this.scene.add(body, trail.line);
        o = { body, trail, flame };
        this.missileObjs.set(m.id, o);
      }
      toThree(m.pos, o.body.position);
      const d = camPos.distanceTo(o.body.position);
      o.body.scale.setScalar(clamp(d / 1400, 1, 80));
      this.tmp.set(m.pos.x + m.vel.x, m.pos.z + m.vel.z, -(m.pos.y + m.vel.y));
      o.body.lookAt(this.tmp);
      o.flame.visible = w.t - m.t0 < m.spec.boostT;
      setTrail(o.trail, m.trail, m.pos);
    }
    for (const [id, o] of this.missileObjs) {
      if (seen.has(id)) continue;
      this.scene.remove(o.body, o.trail.line);
      this.missileObjs.delete(id);
    }
  }

  private syncEffects(): void {
    const w = this.world;
    const seen = new Set<number>();
    for (const f of w.effects) {
      seen.add(f.id);
      let s = this.effectObjs.get(f.id);
      if (!s) {
        const smoke = f.kind === 'ground';
        s = new THREE.Sprite(
          new THREE.SpriteMaterial({ map: smoke ? smokeTex : glowTex, blending: smoke ? THREE.NormalBlending : THREE.AdditiveBlending, depthWrite: false, transparent: true }),
        );
        toThree(f.pos, s.position);
        this.scene.add(s);
        this.effectObjs.set(f.id, s);
      }
      const age = w.t - f.t0;
      const dur = f.kind === 'big' ? 4 : f.kind === 'ground' ? 5 : 2.2;
      const base = f.kind === 'small' ? 40 : f.kind === 'blast' ? 90 : f.kind === 'big' ? 260 : 140;
      const k = clamp(age / dur, 0, 1);
      s.scale.setScalar(base * (0.4 + 2.2 * Math.sqrt(k)));
      s.material.opacity = 1 - k;
      s.visible = k < 1;
    }
    for (const [id, s] of this.effectObjs) {
      if (seen.has(id)) continue;
      this.scene.remove(s);
      s.material.dispose();
      this.effectObjs.delete(id);
    }
  }

  private syncTracers(): void {
    let n = 0;
    const max = this.tracerPos.length / 3;
    for (const c of this.world.ciws) {
      for (const r of c.rounds) {
        if (n >= max) break;
        this.tracerPos[n * 3] = r.pos.x;
        this.tracerPos[n * 3 + 1] = r.pos.z;
        this.tracerPos[n * 3 + 2] = -r.pos.y;
        n++;
      }
    }
    this.tracers.geometry.setDrawRange(0, n);
    (this.tracers.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  private syncTrackLabels(): void {
    const w = this.world;
    const seen = new Set<number>();
    this.selRing.visible = false;
    for (const tr of w.tracker.tracks) {
      if (!tr.confirmed) continue;
      seen.add(tr.id);
      let l = this.trackLabels.get(tr.id);
      if (!l) {
        const el = document.createElement('div');
        el.className = 'track-label';
        el.addEventListener('pointerdown', (ev) => {
          ev.stopPropagation();
          this.onSelect(tr.id);
        });
        const obj = new CSS2DObject(el);
        obj.center.set(-0.1, 0.5);
        this.scene.add(obj);
        l = { obj, el, last: '' };
        this.trackLabels.set(tr.id, l);
      }
      const p = tr.predict(w.t);
      toThree(p, l.obj.position);
      const text = `${tr.label} ${tr.ident} ${tr.cls}`;
      const key = `${text}|${this.selected === tr.id}`;
      if (key !== l.last) {
        l.last = key;
        l.el.textContent = text;
        l.el.style.color = IDENT_COLOR[tr.ident];
        l.el.classList.toggle('sel', this.selected === tr.id);
      }
      l.obj.visible = this.showLabels || this.selected === tr.id;
      if (this.selected === tr.id) {
        this.selRing.position.copy(l.obj.position);
        this.selRing.visible = true;
        if (this.follow) this.controls.target.lerp(l.obj.position, 0.08);
      }
    }
    for (const [id, l] of this.trackLabels) {
      if (seen.has(id)) continue;
      this.scene.remove(l.obj);
      l.el.remove();
      this.trackLabels.delete(id);
    }
  }

  private syncStatic(): void {
    for (const a of this.antennas) {
      const r = a.radar;
      const az = r.spec.scan.kind === 'rotating' ? r.az : r.boresight;
      a.obj.rotation.y = Math.PI - az * DEG;
    }
    for (const t of this.turrets) {
      t.yaw.rotation.y = Math.PI - t.ciws.aimAz * DEG;
      t.pitch.rotation.x = -t.ciws.aimEl * DEG;
    }
    for (const s of this.siteObjs) {
      if (!s.site.alive && !s.dead) {
        s.dead = true;
        for (const m of s.mats) m.color.multiplyScalar(0.25);
        s.label.element.classList.add('dead');
      }
      s.label.visible = this.showLabels && s.site.kind !== 'launcher';
    }
    this.coverage.visible = this.showCoverage;
  }

  render(): void {
    this.syncStatic();
    this.syncEntities();
    this.syncMissiles();
    this.syncEffects();
    this.syncTracers();
    this.syncTrackLabels();
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }
}
