import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SoundEngine } from '../audio/sound';
import { DEG } from '../sim/constants';
import type { Entity, Kind } from '../sim/entities';
import { V3, clamp, polar } from '../sim/math';
import type { Radar } from '../sim/radar';
import type { Ciws } from '../sim/ciws';
import type { Site } from '../sim/sites';
import { MAP_SEED, type World } from '../sim/world';
import { IDENT_COLOR } from '../ui/colors';
import { CameraRig } from './camera';
import { Effects } from './effects';
import { WorldEvents } from './events';
import { Scenery, buildScenery, buildSky, updateHaze } from './terrain3d';

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
  readonly rig: CameraRig;
  readonly sound = new SoundEngine();
  showTruth = false;
  showLabels = true;
  showCoverage = true;
  follow = false;
  selected: number | null = null;
  onSelect: (trackId: number) => void = () => {};
  private readonly container: HTMLElement;
  private world: World;
  private terrainMesh: THREE.Mesh | null = null;
  private scenery!: Scenery;
  private readonly fx: Effects;
  private readonly events = new WorldEvents();
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private lastFrame = performance.now();
  private clearedKey = '';
  private readonly preview = new THREE.Group();
  private readonly raycaster = new THREE.Raycaster();
  private down: { x: number; y: number } | null = null;
  /** Set while the planning screen wants map clicks: called with the ground point clicked. */
  onGroundClick: ((p: V3) => void) | null = null;
  /** Called with the ground point under the pointer while onGroundClick is set. */
  onGroundHover: ((p: V3 | null) => void) | null = null;
  private readonly entityObjs = new Map<number, EntityObj>();
  private readonly missileObjs = new Map<number, { body: THREE.Object3D; trail: TrailObj }>();
  private readonly trackLabels = new Map<number, { obj: CSS2DObject; el: HTMLDivElement; last: string }>();
  private readonly siteObjs: { site: Site; root: THREE.Group; mats: THREE.MeshLambertMaterial[]; label: CSS2DObject; dead: boolean }[] = [];
  private readonly antennas: { radar: Radar; obj: THREE.Object3D }[] = [];
  private readonly turrets: { ciws: Ciws; yaw: THREE.Object3D; pitch: THREE.Object3D }[] = [];
  private readonly coverage = new THREE.Group();
  private readonly selRing: THREE.Sprite;
  private readonly tmp = new THREE.Vector3();

  constructor(container: HTMLElement, world: World) {
    this.container = container;
    this.world = world;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.9;
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
    this.rig = new CameraRig(this.camera, this.controls, (x, z) => this.world.terrain.groundAt(x, -z));
    this.rig.onManual = () => {
      this.follow = false;
    };
    this.rig.onHome = () => this.setView('defended');
    this.setView('defended', true);

    buildSky(this.renderer, this.scene);
    this.buildTerrain();
    this.buildSites();
    this.buildCoverage();
    this.fx = new Effects(this.scene);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.5, 1.6);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

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
    // Sound state resets on its own when it sees a different world.
    this.fx.reset();
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
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w / 2, h / 2);
    this.labels.setSize(w, h);
    this.camera.aspect = w / Math.max(h, 1);
    this.camera.updateProjectionMatrix();
    this.fx.setViewport(h * this.renderer.getPixelRatio(), this.camera.fov);
  }

  setView(v: 'defended' | 'overview' | 'north' | 'deploy', instant = false): void {
    const views = {
      defended: { pos: [6000, 14000, 30000], tgt: [0, 0, -6000] },
      overview: { pos: [0, 190000, 120000], tgt: [0, 0, -15000] },
      deploy: { pos: [0, 62000, 38000], tgt: [0, 0, -2000] },
      north: { pos: [-15000, 9000, -15000], tgt: [0, 1500, -60000] },
    } as const;
    const s = views[v];
    const pos = new THREE.Vector3(s.pos[0], s.pos[1], s.pos[2]);
    const tgt = new THREE.Vector3(s.tgt[0], s.tgt[1], s.tgt[2]);
    this.follow = false;
    if (instant) {
      this.camera.position.copy(pos);
      this.controls.target.copy(tgt);
      this.controls.update();
    } else this.rig.flyTo(pos, tgt);
  }

  private buildTerrain(): void {
    this.scenery = buildScenery(this.scene, this.world.terrain, MAP_SEED);
    this.terrainMesh = this.scenery.terrainMesh;
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
      const visible = this.isVisible(e);
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
        // Thin guide line over the whole flight; the motor smoke and flame come from Effects.
        const trail = makeTrail(m.spec.code === 'AAM' ? 0xcfe8ff : 0xf0f0f0, 170, 0.28);
        this.scene.add(body, trail.line);
        o = { body, trail };
        this.missileObjs.set(m.id, o);
      }
      toThree(m.pos, o.body.position);
      const d = camPos.distanceTo(o.body.position);
      o.body.scale.setScalar(clamp(d / 1400, 1, 80));
      this.tmp.set(m.pos.x + m.vel.x, m.pos.z + m.vel.z, -(m.pos.y + m.vel.y));
      o.body.lookAt(this.tmp);
      setTrail(o.trail, m.trail, m.pos);
    }
    for (const [id, o] of this.missileObjs) {
      if (seen.has(id)) continue;
      this.scene.remove(o.body, o.trail.line);
      this.missileObjs.delete(id);
    }
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
        if (this.follow) {
          // Carry the camera along with the pivot so following keeps the same viewing angle.
          this.tmp.copy(l.obj.position).sub(this.controls.target).multiplyScalar(0.08);
          this.controls.target.add(this.tmp);
          this.camera.position.add(this.tmp);
        }
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

  /** What the player can see of an entity: own side, recent detections, or everything with "show undetected". */
  isVisible(e: Entity): boolean {
    return e.airborne && (this.showTruth || e.side === 'blue' || this.world.t - e.lastDetected < 12);
  }

  /** Clear trees and houses around every site whenever the set of sites changes, so nothing is buried in a forest. */
  private syncClearings(): void {
    const key = this.world.sites.map((s) => `${Math.round(s.pos.x)},${Math.round(s.pos.y)}`).join(';');
    if (key === this.clearedKey) return;
    this.clearedKey = key;
    for (const s of this.world.sites) this.scenery.clearAround(s.pos.x, s.pos.y, s.radius + (s.kind === 'asset' ? 250 : 60));
  }

  render(): void {
    const now = performance.now();
    const realDt = Math.min(0.25, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const ev = this.events.poll(this.world);
    const visible = (e: Entity): boolean => this.isVisible(e);
    this.syncClearings();
    this.syncStatic();
    this.syncEntities();
    this.syncMissiles();
    this.syncTrackLabels();
    this.rig.following = this.follow && this.selected !== null;
    this.rig.update(realDt);
    this.controls.update();
    this.rig.clampAboveGround();
    this.fx.update(this.world, ev, visible);
    this.scenery.update(realDt);
    updateHaze(this.scene, this.camera.position.y);
    this.camera.updateMatrixWorld();
    this.sound.update(this.world, ev, this.camera, visible, realDt);
    this.composer.render();
    this.labels.render(this.scene, this.camera);
  }
}
