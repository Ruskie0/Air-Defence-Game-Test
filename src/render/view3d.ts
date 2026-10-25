import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { gfx } from './gfx';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SoundEngine } from '../audio/sound';
import { DEG } from '../sim/constants';
import type { Entity } from '../sim/entities';
import type { Column } from '../sim/column';
import { V3, clamp, polar } from '../sim/math';
import type { Radar } from '../sim/radar';
import type { Ciws } from '../sim/ciws';
import type { Site } from '../sim/sites';
import type { EnemyBase } from '../sim/theatre';
import { MAP_SEED, type World } from '../sim/world';
import { IDENT_COLOR } from '../ui/colors';
import { CATALOG } from '../sim/catalog';
import { hhmm } from '../campaign/clock';
import { CameraRig } from './camera';
import { Effects } from './effects';
import { type FrameEvents, WorldEvents } from './events';
import { MODEL_LEN, airModel, groundGeometry, interceptorModel, townGeometry } from './models';
import { Scenery, type SkyRig, buildScenery, buildSky, terrainSeed, updateHaze } from './terrain3d';
import { WeatherView } from './weather';
import { Wrecks } from './wrecks';

/** Sim frame (x east, y north, z up) to three.js frame (x east, y up, z south). */
export const toThree = (p: V3, out = new THREE.Vector3()): THREE.Vector3 => out.set(p.x, p.z, -p.y);

/** A stable number from a name, to vary procedural layouts per site. */
const hashName = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

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
  e: Entity;
  root: THREE.Group;
  body: THREE.Object3D;
  marker: THREE.Sprite;
  trail: TrailObj | null;
  hist: V3[];
  nextHist: number;
}

/** Reads the sim's death record (Entity.fate): `air` is true for kills in the air, which leave a falling wreck. */
function isKill(fate: unknown): boolean {
  if (!fate) return false;
  if (typeof fate === 'string') return fate === 'killed';
  const f = fate as Record<string, unknown>;
  if (typeof f.air === 'boolean') return f.air;
  const how = String(f.how ?? f.cause ?? f.kind ?? f.type ?? 'killed');
  return !/detonat|impact|exit|left|leak/i.test(how);
}

/** The air model for an entity: recon jets and SEAD decoys look different from the rest of their kind. */
const modelKind = (e: Entity): string => (e.recon ? 'recon' : e.kind === 'cruise' && e.decoy ? 'decoy' : e.kind);

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
  /** A friendly site's name on the map was clicked. */
  onSelectSite: (site: Site, add: boolean) => void = () => {};
  /** Shift-drag box on the ground: the friendly sites inside it. */
  onBoxSelect: (sites: Site[], add: boolean) => void = () => {};
  /** Right click without dragging: the ground point, and whether Alt was held. */
  onRightClick: ((p: V3, alt: boolean) => void) | null = null;
  /** A plain click on the map that hit nothing selectable (used to deselect). */
  onEmptyClick: () => void = () => {};
  /** Friendly site to mark as selected. */
  selectedSite: Site | null = null;
  /** Further friendly sites in a multi-selection, each marked with its own ring. */
  selectedSites: Site[] = [];
  private readonly groupRings: THREE.Sprite[] = [];
  private boxEl: HTMLDivElement | null = null;
  private readonly container: HTMLElement;
  private world: World;
  private terrainMesh: THREE.Mesh | null = null;
  private scenery!: Scenery;
  private readonly fx: Effects;
  private readonly wrecks: Wrecks;
  private readonly sky: SkyRig;
  private readonly weather: WeatherView;
  private readonly events = new WorldEvents();
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private lastFrame = performance.now();
  private clearedKey = '';
  /** The terrain the scenery was built for; a world on a different map rebuilds it. */
  private sceneryTerrain: World['terrain'] | null = null;
  private readonly preview = new THREE.Group();
  /** World.layoutSeq the coverage rings were drawn for. */
  private coverageSeq = -1;
  private readonly raycaster = new THREE.Raycaster();
  private down: { x: number; y: number; b: number } | null = null;
  /** Set while the planning screen wants map clicks: called with the ground point clicked. */
  onGroundClick: ((p: V3) => void) | null = null;
  /** Called with the ground point under the pointer while onGroundClick is set. */
  onGroundHover: ((p: V3 | null) => void) | null = null;
  private readonly entityObjs = new Map<number, EntityObj>();
  private readonly missileObjs = new Map<number, { body: THREE.Object3D; trail: TrailObj }>();
  private readonly trackLabels = new Map<number, { obj: CSS2DObject; el: HTMLDivElement; last: string }>();
  private readonly siteObjs: { site: Site; root: THREE.Group; mats: { color: THREE.Color }[]; label: CSS2DObject; dead: boolean }[] = [];
  /** Enemy installations our intel has located: placeholder models and labels, rebuilt when that set changes. */
  private readonly baseObjs: { base: EnemyBase; site: Site | null; root: THREE.Group; label: CSS2DObject; mats: { color: THREE.Color }[]; dead: boolean }[] = [];
  private readonly antennas: { radar: Radar; obj: THREE.Object3D }[] = [];
  private readonly turrets: { ciws: Ciws; yaw: THREE.Object3D; pitch: THREE.Object3D }[] = [];
  private readonly coverage = new THREE.Group();
  private readonly selRing: THREE.Sprite;
  private readonly siteRing: THREE.Sprite;
  private readonly tmp = new THREE.Vector3();
  private sceneryRes = 1;
  /** The enemy's armoured column attacking one of our towns (World.enemyArmour), built when first seen. */
  /** Living war: battalions on the road (enemy models; labels with strength for both sides) and the hulks they leave. */
  private readonly bnObjs = new Map<number, { root: THREE.Group; label: CSS2DObject; el: HTMLDivElement; last: string; hulkAt: number }>();
  private readonly hulks: THREE.Mesh[] = [];
  /** Capture bars over towns changing hands. */
  private readonly capObjs = new Map<number, { obj: CSS2DObject; el: HTMLDivElement; bar: HTMLElement }>();
  private readonly hulkMat = new THREE.MeshStandardMaterial({ color: 0x1c1a18, roughness: 1, metalness: 0 });
  private readonly redBnMat = new THREE.MeshStandardMaterial({ color: 0x8a5a4a, roughness: 0.85, metalness: 0.1 });
  /** Living war: ghosts of units on order, at the spot they were placed, with the road from the depot. */
  private readonly ghosts = new Map<number, { root: THREE.Group; line: THREE.Line; label: CSS2DObject; eta: number }>();
  private armourObj: { root: THREE.Group; body: THREE.Mesh; label: CSS2DObject } | null = null;
  /** The campaign clock (minutes) while planning, when the shown world has no battle clock of its own. */
  planClock: (() => number | undefined) | null = null;

  constructor(container: HTMLElement, world: World) {
    this.container = container;
    this.world = world;
    // No canvas antialiasing: the scene is drawn off-screen and multisampled there (see the composer below).
    this.renderer = new THREE.WebGLRenderer({ antialias: false, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, gfx.spec.pixelRatio));
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

    this.sky = buildSky(this.renderer, this.scene);
    this.buildTerrain();
    this.buildSites();
    this.buildCoverage();
    this.fx = new Effects(this.scene);
    this.wrecks = new Wrecks(this.scene, this.fx);
    this.weather = new WeatherView(this.scene, this.sky);
    this.weather.apply(world, this.terrainMesh, this.fx);

    // The composer renders off-screen, so the canvas's own antialiasing does not apply: multisample the target.
    this.composer = new EffectComposer(this.renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: gfx.spec.samples }));
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.5, 1.6);
    this.bloom.enabled = gfx.spec.bloom;
    this.composer.addPass(this.bloom);
    gfx.onChange(() => this.applyGraphics());
    this.composer.addPass(new OutputPass());

    this.selRing = new THREE.Sprite(new THREE.SpriteMaterial({ map: MARKERS.sel, depthTest: false, transparent: true }));
    this.selRing.scale.setScalar(0.045);
    this.selRing.material.sizeAttenuation = false;
    this.selRing.renderOrder = 10;
    this.selRing.visible = false;
    this.scene.add(this.selRing);
    this.siteRing = this.selRing.clone();
    this.siteRing.material = new THREE.SpriteMaterial({ map: MARKERS.sel, depthTest: false, transparent: true, color: 0x7fd4ff, sizeAttenuation: false });
    this.scene.add(this.siteRing);

    this.scene.add(this.preview);
    const el = this.renderer.domElement;
    // Shift-drag draws a selection box. It is caught on the way down to the canvas so the orbit controls never see it.
    el.parentElement!.addEventListener(
      'pointerdown',
      (e) => {
        if (e.target !== el || !e.shiftKey || e.button !== 0 || this.onGroundClick) return;
        e.stopPropagation();
        e.preventDefault();
        const x0 = e.clientX;
        const y0 = e.clientY;
        const box = (this.boxEl ??= Object.assign(document.createElement('div'), { className: 'sel-box' }));
        document.body.appendChild(box);
        const draw = (x: number, y: number): void => {
          Object.assign(box.style, { left: `${Math.min(x, x0)}px`, top: `${Math.min(y, y0)}px`, width: `${Math.abs(x - x0)}px`, height: `${Math.abs(y - y0)}px` });
        };
        draw(x0, y0);
        const move = (ev: PointerEvent): void => draw(ev.clientX, ev.clientY);
        const up = (ev: PointerEvent): void => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          box.remove();
          if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) {
            // A shift-click on a unit adds it to the selection.
            const site = this.pickSite(ev.clientX, ev.clientY);
            if (site) this.onSelectSite(site, true);
            return;
          }
          this.onBoxSelect(this.sitesInRect(x0, y0, ev.clientX, ev.clientY), ev.ctrlKey);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      },
      { capture: true },
    );
    el.addEventListener('pointerdown', (e) => (this.down = { x: e.clientX, y: e.clientY, b: e.button }));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerup', (e) => {
      if (this.down && e.button === 2 && this.down.b === 2) {
        const moved = Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y);
        this.down = null;
        const p = moved < 6 && this.onRightClick ? this.pickGround(e.clientX, e.clientY) : null;
        if (p) this.onRightClick!(p, e.altKey);
        return;
      }
      if (!this.down || e.button !== 0) return;
      const moved = Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y);
      this.down = null;
      if (moved > 5) return;
      if (!this.onGroundClick) {
        const id = this.pickTrack(e.clientX, e.clientY);
        if (id !== null) {
          this.onSelect(id);
          this.focusTrack(id);
        } else this.onEmptyClick();
        return;
      }
      const p = this.pickGround(e.clientX, e.clientY);
      if (p) this.onGroundClick(p);
    });
    el.addEventListener('pointermove', (e) => {
      if (this.onGroundHover) this.onGroundHover(this.pickGround(e.clientX, e.clientY));
    });

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  /** The confirmed track drawn nearest a screen position, within 30 px. */
  pickTrack(clientX: number, clientY: number): number | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    let best: number | null = null;
    let bd = 30;
    for (const [id, l] of this.trackLabels) {
      const p = this.tmp.copy(l.obj.position).project(this.camera);
      if (p.z > 1) continue;
      const d = Math.hypot(r.left + ((p.x + 1) / 2) * r.width - clientX, r.top + ((1 - p.y) / 2) * r.height - clientY);
      if (d < bd) {
        bd = d;
        best = id;
      }
    }
    return best;
  }

  /** Screen position of a sim point, or null when it is behind the camera. */
  private screenOf(x: number, y: number, z: number): [number, number] | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const p = this.tmp.set(x, z, -y).project(this.camera);
    if (p.z > 1) return null;
    return [r.left + ((p.x + 1) / 2) * r.width, r.top + ((1 - p.y) / 2) * r.height];
  }

  /** Our living sites drawn inside a screen rectangle. */
  sitesInRect(x0: number, y0: number, x1: number, y1: number): Site[] {
    const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)];
    const [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
    return this.world.sites.filter((s) => {
      if (!s.alive) return false;
      const p = this.screenOf(s.pos.x, s.pos.y, s.pos.z);
      return !!p && p[0] >= ax && p[0] <= bx && p[1] >= ay && p[1] <= by;
    });
  }

  /** Our site drawn nearest a screen position, within 24 px. */
  pickSite(clientX: number, clientY: number): Site | null {
    let best: Site | null = null;
    let bd = 24;
    for (const s of this.world.sites) {
      const p = s.alive ? this.screenOf(s.pos.x, s.pos.y, s.pos.z) : null;
      const d = p ? Math.hypot(p[0] - clientX, p[1] - clientY) : Infinity;
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best;
  }

  /** Fly in to a track and follow it: close enough to see the aircraft, keeping the current viewing direction. */
  /** Fly the camera to look down on a ground position (sim x, y) from about 2.5 km off, keeping the bearing. */
  flyToGround(x: number, y: number): void {
    const t = new THREE.Vector3(x, this.world.terrain.groundAt(x, y), -y);
    const dir = this.tmp.copy(this.camera.position).sub(this.controls.target).setY(0);
    if (dir.lengthSq() < 1) dir.set(0, 0, 1);
    dir.normalize().multiplyScalar(0.8).setY(0.6).normalize();
    const pos = t.clone().addScaledVector(dir, 2500);
    this.follow = false;
    this.rig.flyTo(pos, t, 1);
  }

  focusTrack(id: number): void {
    const l = this.trackLabels.get(id);
    if (!l) return;
    const t = l.obj.position.clone();
    const dir = this.tmp.copy(this.camera.position).sub(this.controls.target);
    const dist = clamp(dir.length(), 900, 3000);
    dir.normalize();
    // Look from at least 15 degrees above the horizon.
    if (dir.y < 0.26) {
      dir.y = 0.26;
      dir.normalize();
    }
    const pos = t.clone().addScaledVector(dir, dist);
    const g = this.world.terrain.groundAt(pos.x, -pos.z);
    if (pos.y < g + 80) pos.y = g + 80;
    this.follow = true;
    this.rig.flyTo(pos, t, 1);
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
    if (w.terrain !== this.sceneryTerrain) {
      this.scenery.dispose();
      this.buildTerrain();
      this.clearedKey = '';
    }
    for (const s of this.siteObjs) {
      this.scene.remove(s.root);
      // CSS2D labels only clean up their DOM element when removed directly, not with a parent.
      s.label.element.remove();
    }
    this.siteObjs.length = 0;
    this.clearBases();
    if (this.armourObj) {
      this.scene.remove(this.armourObj.root);
      this.armourObj.label.element.remove();
      this.armourObj = null;
    }
    this.antennas.length = 0;
    this.turrets.length = 0;
    this.clearCoverage();
    for (const o of this.entityObjs.values()) {
      this.scene.remove(o.root);
      if (o.trail) this.scene.remove(o.trail.line);
    }
    this.entityObjs.clear();
    for (const o of this.missileObjs.values()) this.scene.remove(o.body, o.trail.line);
    this.missileObjs.clear();
    // Sound state resets on its own when it sees a different world.
    this.fx.reset();
    this.wrecks.reset();
    for (const l of this.trackLabels.values()) {
      this.scene.remove(l.obj);
      l.el.remove();
    }
    this.trackLabels.clear();
    this.clearGhosts();
    this.clearGround();
    this.selected = null;
    this.buildSites();
    this.buildBases();
    this.buildCoverage();
    this.weather.apply(w, this.terrainMesh, this.fx);
  }

  /** The graphics quality changed: resolution, antialiasing, bloom, scatter density and the terrain mesh. */
  private applyGraphics(): void {
    const q = gfx.spec;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatio));
    for (const rt of [this.composer.renderTarget1, this.composer.renderTarget2]) {
      if (rt.samples !== q.samples) {
        rt.samples = q.samples;
        rt.dispose();
      }
    }
    this.bloom.enabled = q.bloom;
    if (q.terrain !== this.sceneryRes) {
      this.scenery.dispose();
      this.buildTerrain();
      this.clearedKey = '';
      this.weather.apply(this.world, this.terrainMesh, this.fx);
    } else this.scenery.setDensity(q.scatter);
    this.resize();
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
    // The overview frames the whole map, which is 160 or 300 km across.
    const big = this.world.terrain.half / 80000;
    const views = {
      defended: { pos: [6000, 14000, 30000], tgt: [0, 0, -6000] },
      overview: { pos: [0, 190000 * big, 120000 * big], tgt: [0, 0, -15000 * big] },
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
    this.sceneryRes = gfx.spec.terrain;
    this.scenery = buildScenery(this.scene, this.world.terrain, terrainSeed(this.world.terrain, MAP_SEED), this.sceneryRes);
    this.scenery.setDensity(gfx.spec.scatter);
    this.sceneryTerrain = this.world.terrain;
    this.rig.limit = this.world.terrain.half * 0.95;
    this.controls.maxDistance = 420000 * Math.max(1, this.world.terrain.half / 80000);
    this.terrainMesh = this.scenery.terrainMesh;
  }

  private siteLabel(text: string, site?: Site): CSS2DObject {
    const el = document.createElement('div');
    el.className = 'site-label';
    el.textContent = text;
    if (site) {
      el.classList.add('pickable');
      el.addEventListener('pointerdown', (ev) => {
        ev.stopPropagation();
        this.onSelectSite(site, ev.shiftKey);
      });
    }
    const o = new CSS2DObject(el);
    o.center.set(0.5, -0.4);
    return o;
  }

  private clearGround(): void {
    for (const o of this.bnObjs.values()) {
      this.scene.remove(o.root);
      o.el.remove();
    }
    this.bnObjs.clear();
    for (const o of this.capObjs.values()) {
      this.scene.remove(o.obj);
      o.el.remove();
    }
    this.capObjs.clear();
    for (const h of this.hulks) this.scene.remove(h);
    this.hulks.length = 0;
  }

  /** The ground war: enemy battalions as a cluster of vehicles with a marker, a label with strength on every battalion, hulks where they bleed. */
  private syncGround(): void {
    const g = this.world.ground;
    if (!g) return;
    const live = new Set<number>();
    for (const b of g.bats) {
      if (!b.alive) continue;
      live.add(b.id);
      let o = this.bnObjs.get(b.id);
      if (!o) {
        const root = new THREE.Group();
        if (b.side === 'red') {
          for (let i = 0; i < 6; i++) {
            const m = new THREE.Mesh(groundGeometry(i < 3 ? 'tank' : 'ifv'), this.redBnMat);
            m.position.set((i % 3) * 26 - 26, 0, Math.floor(i / 3) * 24 - 12);
            root.add(m);
          }
          const marker = new THREE.Sprite(new THREE.SpriteMaterial({ map: MARKERS.red, depthTest: false, transparent: true, sizeAttenuation: false }));
          marker.scale.setScalar(0.016);
          marker.position.y = 25;
          marker.renderOrder = 6;
          root.add(marker);
        }
        const el = document.createElement('div');
        el.className = `site-label bn ${b.side === 'red' ? 'enemy' : ''}`;
        const label = new CSS2DObject(el);
        label.center.set(0.5, -0.6);
        label.position.y = 40;
        root.add(label);
        this.scene.add(root);
        o = { root, label, el, last: '', hulkAt: b.strength };
        this.bnObjs.set(b.id, o);
      }
      const y = this.world.terrain.groundAt(b.pos.x, b.pos.y);
      o.root.position.set(b.pos.x, y, -b.pos.y);
      const a = g.at(b.s + 50 * b.dir);
      o.root.rotation.y = Math.atan2(a.x - b.pos.x, a.y - b.pos.y) + Math.PI;
      const tag = b.foe ? ' ⚔' : b.broken ? ' (broken)' : '';
      const cover = b.side === 'blue' ? (g.covered(this.world, b) ? ' · COVERED' : ' · EXPOSED') : '';
      const txt = `${b.name} · ${Math.round(b.strength)}%${tag}${cover}`;
      if (txt !== o.last) {
        o.el.textContent = txt;
        o.el.classList.toggle('fighting', !!b.foe);
        o.el.classList.toggle('exposed', cover === ' · EXPOSED');
        o.last = txt;
      }
      o.label.visible = this.showLabels;
      // Every few percent lost leaves a burnt-out vehicle by the road.
      if (o.hulkAt - b.strength >= 7) {
        o.hulkAt = b.strength;
        const h = new THREE.Mesh(groundGeometry(this.hulks.length % 2 ? 'ifv' : 'tank'), this.hulkMat);
        const hx = b.pos.x + (Math.random() - 0.5) * 500;
        const hy = b.pos.y + (Math.random() - 0.5) * 500;
        h.position.set(hx, this.world.terrain.groundAt(hx, hy) - 0.5, -hy);
        h.rotation.set((Math.random() - 0.5) * 0.3, Math.random() * 6.3, (Math.random() - 0.5) * 0.3);
        this.scene.add(h);
        this.hulks.push(h);
        if (this.hulks.length > 90) this.scene.remove(this.hulks.shift()!);
      } else if (b.strength > o.hulkAt) o.hulkAt = b.strength;
    }
    g.capture.forEach((cap, i) => {
      let o = this.capObjs.get(i);
      if (cap <= 0) {
        if (o) {
          this.scene.remove(o.obj);
          o.el.remove();
          this.capObjs.delete(i);
        }
        return;
      }
      if (!o) {
        const el = document.createElement('div');
        el.className = 'cap-bar';
        el.innerHTML = '<span></span><i><b></b></i>';
        const obj = new CSS2DObject(el);
        obj.center.set(0.5, 2.2);
        const p = g.at(g.townS[i]);
        obj.position.set(p.x, this.world.terrain.groundAt(p.x, p.y) + 60, -p.y);
        this.scene.add(obj);
        o = { obj, el, bar: el.querySelector('b')! };
        this.capObjs.set(i, o);
      }
      o.el.querySelector('span')!.textContent = `${g.townNames[i]} changing hands ${Math.round(cap * 100)}%`;
      o.bar.style.width = `${Math.round(cap * 100)}%`;
    });
    for (const [id, o] of this.bnObjs) {
      if (live.has(id)) continue;
      this.scene.remove(o.root);
      o.el.remove();
      this.bnObjs.delete(id);
    }
  }

  private clearGhosts(): void {
    for (const g of this.ghosts.values()) {
      this.scene.remove(g.root, g.line);
      g.label.element.remove();
    }
    this.ghosts.clear();
  }

  /** Deliveries on their way: a faint marker where the unit will stand, a dashed road from the depot, and its arrival time. */
  private syncGhosts(): void {
    const w = this.world;
    const live = new Set<number>();
    for (const g of w.incoming) {
      live.add(g.uid);
      let o = this.ghosts.get(g.uid);
      if (o && o.eta !== g.eta) {
        this.scene.remove(o.root, o.line);
        o.label.element.remove();
        this.ghosts.delete(g.uid);
        o = undefined;
      }
      if (!o) {
        const t = w.terrain;
        const y = t.groundAt(g.x, g.y);
        const root = new THREE.Group();
        const marker = new THREE.Sprite(new THREE.SpriteMaterial({ map: MARKERS.site, depthTest: false, transparent: true, opacity: 0.45, sizeAttenuation: false }));
        marker.scale.setScalar(0.022);
        marker.renderOrder = 6;
        root.add(marker);
        const el = document.createElement('div');
        el.className = 'site-label ghost';
        el.textContent = `${CATALOG[g.type].name} arrives ${hhmm(g.eta)}`;
        const label = new CSS2DObject(el);
        label.center.set(0.5, -0.4);
        label.position.y = 30;
        root.add(label);
        root.position.set(g.x, y + 15, -g.y);
        const pts = [new THREE.Vector3(g.depot.x, t.groundAt(g.depot.x, g.depot.y) + 15, -g.depot.y), new THREE.Vector3(g.x, y + 15, -g.y)];
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: 0x7fc1ff, dashSize: 300, gapSize: 200, transparent: true, opacity: 0.5, depthTest: false }));
        line.computeLineDistances();
        line.renderOrder = 5;
        this.scene.add(root, line);
        o = { root, line, label, eta: g.eta };
        this.ghosts.set(g.uid, o);
      }
      o.label.visible = this.showLabels;
    }
    for (const [uid, o] of this.ghosts) {
      if (live.has(uid)) continue;
      this.scene.remove(o.root, o.line);
      o.label.element.remove();
      this.ghosts.delete(uid);
    }
  }

  private clearBases(): void {
    for (const b of this.baseObjs) {
      this.scene.remove(b.root);
      b.label.element.remove();
    }
    this.baseObjs.length = 0;
  }

  /**
   * Enemy installations we know about: SAM batteries, missile and drone launchers in their hides, helicopter
   * FARPs and air bases, in the enemy's tan-tinted paint, with a red label. The rear air base is off the map
   * and has none. A lost base, or a SAM site knocked out in battle, is drawn burnt out.
   */
  private buildBases(): void {
    const w = this.world;
    const shown = w.theatre.filter((b) => b.known && b.kind !== 'rear');
    this.clearBases();
    for (const b of shown) {
      const root = new THREE.Group();
      const ground = w.terrain.groundAt(b.x, b.y);
      root.position.set(b.x, ground, -b.y);
      const mats: { color: THREE.Color }[] = [];
      const paint = new THREE.MeshStandardMaterial({ vertexColors: true, color: 0xd9b89a, metalness: 0.15, roughness: 0.8 });
      const plain = (c: number): THREE.MeshLambertMaterial => {
        const m = new THREE.MeshLambertMaterial({ color: c });
        mats.push(m);
        return m;
      };
      mats.push(paint);
      // Everything sits on the ground under it, turned to face away from our side.
      const away = Math.atan2(-b.x, b.y);
      const at = (o: THREE.Object3D, x: number, z: number, yaw = 0): THREE.Object3D => {
        const ca = Math.cos(away);
        const sa = Math.sin(away);
        const wx = x * ca + z * sa;
        const wz = -x * sa + z * ca;
        o.position.set(wx, w.terrain.groundAt(b.x + wx, b.y - wz) - ground + o.position.y, wz);
        o.rotation.y = away + yaw;
        root.add(o);
        return o;
      };
      const unit = (name: string, x: number, z: number, yaw = 0): THREE.Object3D => at(new THREE.Mesh(groundGeometry(name), paint), x, z, yaw);
      const box = (sx: number, sy: number, sz: number, c: number, x: number, z: number, yaw = 0): THREE.Object3D => {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz).translate(0, sy / 2, 0), plain(c));
        return at(mesh, x, z, yaw);
      };
      const parked = (kind: string, x: number, z: number, yaw = 0): void => {
        const m = airModel(kind);
        m.material = paint;
        m.getObjectByName('blur')?.removeFromParent();
        for (const c of m.children) if (c instanceof THREE.Mesh) c.material = paint;
        const g = new THREE.Group();
        g.add(m);
        m.position.y = kind === 'helo' ? 0.2 : 1.6;
        at(g, x, z, yaw);
      };
      // Bases out at sea are ships: an assault ship for the helicopters, launch ships for the drones.
      const ship = w.terrain.heightAt(b.x, b.y) < 0;
      if (ship) {
        root.position.y = 0;
        const grey = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.3, roughness: 0.6 });
        mats.push(grey);
        const hull = new THREE.Mesh(groundGeometry(b.kind === 'farp' ? 'ship-lhd' : 'ship-frigate'), grey);
        hull.rotation.y = away + Math.PI;
        root.add(hull);
        if (b.kind === 'farp') for (let i = 0; i < 3; i++) {
          const g = new THREE.Group();
          const m = airModel('helo');
          m.getObjectByName('blur')?.removeFromParent();
          m.material = paint;
          for (const c of m.children) if (c instanceof THREE.Mesh) c.material = paint;
          g.add(m);
          g.position.set(-6, 12.6, -40 + i * 35).applyAxisAngle(new THREE.Vector3(0, 1, 0), away + Math.PI);
          g.rotation.y = away;
          root.add(g);
        }
      }
      if (!ship) switch (b.kind) {
        case 'sam': {
          // A battery: tracking radar in the middle, launchers spread round it, a command post and a reload truck.
          const radar = unit('radar-base', 0, 0);
          const ant = new THREE.Mesh(groundGeometry('antenna-MR'), paint);
          ant.position.y = 4.4;
          ant.rotation.x = -0.2;
          radar.add(ant);
          for (let i = 0; i < 3; i++) {
            const a = (i - 1) * 0.9;
            unit('launcher-MR', Math.sin(a) * 140, Math.cos(a) * 140 - 30, (i - 1) * 0.5);
          }
          unit('ifv', -60, -90, 0.3);
          box(8, 3, 3, 0x5a4a3c, 70, -110, -0.2);
          break;
        }
        case 'tbm':
        case 'glcm':
          // Erector-launchers and reload trucks dispersed in a hide.
          for (let i = 0; i < 3; i++) {
            const a = (i / 3) * Math.PI * 2 + 0.4;
            unit(b.kind === 'tbm' ? 'launcher-LR' : 'launcher-MR', Math.cos(a) * 130, Math.sin(a) * 130, a);
          }
          box(10, 3.2, 3, 0x5a4a3c, 0, 0);
          box(10, 3.2, 3, 0x5a4a3c, 18, 8, 0.4);
          break;
        case 'drones':
          // Launch rails on trailers, ground control shelters and a few airframes ready on the rails.
          for (let i = 0; i < 4; i++) {
            at(new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.3, 9).rotateX(-0.25).translate(0, 1.8, 0), plain(0x6a5a48)), -60 + i * 40, 40);
            parked('drone', -60 + i * 40, 40);
          }
          box(6, 2.6, 2.6, 0x5a4a3c, -20, -40);
          box(6, 2.6, 2.6, 0x5a4a3c, 20, -40);
          unit('ifv', 60, -50, 0.4);
          break;
        case 'farp':
          // Forward arming and refuelling point: helicopters on pads, a fuel bladder and an ammunition stack.
          for (let i = 0; i < 4; i++) {
            const x = (i % 2) * 90 - 45;
            const z = Math.floor(i / 2) * 90 - 45;
            box(24, 0.3, 24, 0x8a7c66, x, z);
            parked('helo', x, z, 0.2 * i);
          }
          box(14, 1.6, 9, 0x2e2a26, 120, 0);
          box(8, 2, 4, 0x5a4a3c, -120, 20);
          break;
        case 'airfield':
          // Runway, taxiway, hardened shelters and jets on the apron.
          box(2400, 0.6, 50, 0x3a3836, 0, 0);
          box(1600, 0.5, 22, 0x44403c, 0, 140);
          for (let i = 0; i < 6; i++) {
            const shelter = new THREE.Mesh(new THREE.CylinderGeometry(16, 16, 36, 12, 1, false, 0, Math.PI).rotateZ(Math.PI / 2).rotateY(Math.PI / 2), plain(0x8d8172));
            at(shelter, -900 + i * 360, 220);
          }
          for (let i = 0; i < 4; i++) parked(i % 2 ? 'sead' : 'strike', -600 + i * 120, 175, Math.PI);
          box(20, 30, 20, 0x9a8c7a, 900, 260);
          break;
        default:
          box(20, 6, 10, 0x4a3a32, 0, 0);
      }
      const el = document.createElement('div');
      el.className = 'site-label enemy';
      el.textContent = b.name;
      const label = new CSS2DObject(el);
      label.center.set(0.5, -0.4);
      label.position.y = 40;
      root.add(label);
      this.scene.add(root);
      const ad = w.enemyAd?.sites.find((a) => a.base === b);
      this.baseObjs.push({ base: b, site: ad?.site ?? null, root, label, mats, dead: false });
    }
  }

  /** Models for the world's sites from index `from` on (units that arrive mid-battle are added later). */
  private buildSites(from = 0): void {
    const w = this.world;
    for (const s of w.sites.slice(from)) {
      const root = new THREE.Group();
      const ground = w.terrain.groundAt(s.pos.x, s.pos.y);
      root.position.set(s.pos.x, ground, -s.pos.y);
      const mats: { color: THREE.Color }[] = [];
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
      // Vertex-coloured unit models get a material of their own per site, so a destroyed one can be darkened.
      let unitMat: THREE.MeshStandardMaterial | null = null;
      const part = (name: string, parent: THREE.Object3D = root, y = 0, geo?: THREE.BufferGeometry): THREE.Mesh => {
        if (!unitMat) {
          unitMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.15, roughness: 0.8 });
          mats.push(unitMat);
        }
        const mesh = new THREE.Mesh(geo ?? groundGeometry(name), unitMat);
        mesh.position.y = y;
        parent.add(mesh);
        return mesh;
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
          } else if (s.role === 'town') {
            // A front-line town; every building sits on the ground under it.
            part('', root, 0, townGeometry(hashName(s.name), (x, z) => w.terrain.groundAt(s.pos.x + x, s.pos.y - z) - ground));
          } else if (s.role === 'assault') {
            // The assault force in laager: two rows of tanks and fighting vehicles, and a command post. While
            // its column is on the road the column entity is drawn instead (see syncStatic).
            const laager = new THREE.Group();
            laager.name = 'laager';
            root.add(laager);
            const yaw = -(w.terrain.layout.rot ?? 0) * DEG;
            for (let i = 0; i < 8; i++) {
              const lx = (i % 4) * 24 - 36;
              const lz = Math.floor(i / 4) * 22 - 11;
              const x = lx * Math.cos(yaw) + lz * Math.sin(yaw);
              const z = -lx * Math.sin(yaw) + lz * Math.cos(yaw);
              const v = part(i < 4 ? 'tank' : 'ifv', laager, w.terrain.groundAt(s.pos.x + x, s.pos.y - z) - ground);
              v.position.x = x;
              v.position.z = z;
              v.rotation.y = yaw + (((i * 37) % 11) - 5) * 0.02;
            }
            laager.add(box(1, 14, 1, 0xdddddd, 0, 0, -30));
          } else {
            box(30, 8, 22, 0x6a6e58);
            box(2, 25, 2, 0x999999, 12, 0, 8);
          }
          break;
        case 'radar': {
          const radar = w.radars.find((r) => r.pos === s.pos || (r.pos.x === s.pos.x && r.pos.y === s.pos.y));
          const sig = radar?.signature ?? 'MR';
          const hm = s.pos.z - ground;
          // A SHORAD fire unit's radar rides on its vehicle; a gap-filler with the same radar stands on a trailer and mast.
          const shorad = sig === 'SH' && w.units.some((u) => u.radar === radar);
          const base = part(shorad ? 'shorad-hull' : sig === 'LR' ? 'radar-base-LR' : 'radar-base');
          base.rotation.y = -(radar?.boresight ?? 0) * DEG;
          const deck = shorad ? 3.0 : 3.4;
          if (hm - deck > 1) part(`mast-${Math.round(hm - deck)}`, root, deck);
          const ant = new THREE.Group();
          ant.position.y = Math.max(hm, deck + 1);
          const face = part(`antenna-${sig}`, ant);
          face.rotation.x = sig === 'LR' ? -0.35 : sig === 'EW' ? -0.12 : -0.2;
          root.add(ant);
          if (radar) this.antennas.push({ radar, obj: ant });
          break;
        }
        case 'launcher': {
          const fu = w.units.find((u) => u.launchers.some((l) => l.site === s));
          const l = part(fu?.type === 'LR' ? 'launcher-LR' : 'launcher-MR');
          l.rotation.y = -(fu?.radar?.boresight ?? 0) * DEG;
          break;
        }
        case 'ciws': {
          const c = w.ciws.find((x) => x.site === s);
          // CIWS on a trailer, the towed 35 mm gun, or the laser truck: base, traversing mount and elevating mass.
          const kind = c?.spec.kind ?? 'ciws';
          const [yawAt, pitchY] = kind === 'gun35' ? [[0, 1.6, 0], 1.3] : kind === 'laser' ? [[0, 3.3, 1.6], 1.35] : [[0, 2.3, 1.2], 1.4];
          part(`${kind}-base`);
          const yaw = new THREE.Group();
          yaw.position.set(yawAt[0], yawAt[1], yawAt[2]);
          part(`${kind}-yaw`, yaw);
          const pitch = new THREE.Group();
          pitch.position.y = pitchY;
          part(`${kind}-gun`, pitch);
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
        case 'jammer': {
          // EW jammer truck: shelter and telescopic mast carrying the emitter head (it glows while jamming, see Effects).
          const truck = part('jammer-base');
          truck.rotation.y = -(w.terrain.layout.rot ?? 0) * DEG;
          part('jammer-head', truck, 9.5).position.z = 1.5;
          break;
        }
      }
      const icon = new THREE.Sprite(new THREE.SpriteMaterial({ map: MARKERS.site, depthTest: false, transparent: true, sizeAttenuation: false }));
      icon.scale.setScalar(s.defended ? 0.018 : 0.011);
      icon.position.y = s.pos.z - ground + 10;
      icon.renderOrder = 5;
      root.add(icon);
      const label = this.siteLabel(s.name, s.kind === 'asset' ? undefined : s);
      label.position.y = s.pos.z - ground + 10;
      if (s.kind === 'launcher') label.visible = false;
      root.add(label);
      this.scene.add(root);
      this.siteObjs.push({ site: s, root, mats, label, dead: false });
    }
  }

  private clearCoverage(): void {
    for (const c of [...this.coverage.children]) {
      this.coverage.remove(c);
      if (c instanceof THREE.Line) c.geometry.dispose();
    }
  }

  /** Weapon engagement zones and the LR radar sector, draped over the terrain. */
  private buildCoverage(): void {
    const w = this.world;
    this.coverageSeq = w.layoutSeq;
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
    // The ground we hold (campaign front line): where units may deploy.
    if (w.zones.length > 1) for (const z of w.zones) ring({ x: z.x, y: z.y, z: 0 }, z.r, 0xd8d8c0);
    // Spots the enemy has located, until the counter-battery strike has landed.
    for (const l of w.exposure.located) if (w.t < l.eta + 5) ring({ x: l.x, y: l.y, z: 0 }, 700, 0xff4040);
    // Enemy installations we have located.
    for (const b of w.theatre) if (b.known && !b.lost && b.kind !== 'rear') ring({ x: b.x, y: b.y, z: 0 }, 1500, 0xff6040);
    this.scene.add(this.coverage);
  }

  private entityObj(e: Entity): EntityObj {
    let o = this.entityObjs.get(e.id);
    if (o) return o;
    const root = new THREE.Group();
    const body = airModel(modelKind(e), e.munition);
    root.add(body);
    const tex = e.side === 'red' ? MARKERS.red : e.side === 'blue' ? MARKERS.blue : MARKERS.neutral;
    const marker = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, sizeAttenuation: false }));
    marker.scale.setScalar(e.munition ? 0.012 : 0.018);
    marker.renderOrder = 6;
    root.add(marker);
    const trail = e.kind === 'tbm' || e.kind === 'arm' ? makeTrail(e.kind === 'tbm' ? 0xffa060 : 0xff7040, 240, 0.8) : null;
    if (trail) this.scene.add(trail.line);
    this.scene.add(root);
    o = { e, root, body, marker, trail, hist: [], nextHist: 0 };
    this.entityObjs.set(e.id, o);
    return o;
  }

  /** The enemy armour: the column model in enemy paint at its position, facing the town it is going for. */
  private syncArmour(): void {
    const ea = this.world.enemyArmour;
    if (!ea || ea.state === 'over') {
      if (this.armourObj) this.armourObj.root.visible = false;
      return;
    }
    if (!this.armourObj) {
      const root = new THREE.Group();
      const body = airModel('column');
      body.material = new THREE.MeshStandardMaterial({ vertexColors: true, color: 0xd9b89a, metalness: 0.15, roughness: 0.8 });
      root.add(body);
      const marker = new THREE.Sprite(new THREE.SpriteMaterial({ map: MARKERS.red, depthTest: false, transparent: true, sizeAttenuation: false }));
      marker.scale.setScalar(0.018);
      marker.position.y = 20;
      marker.renderOrder = 6;
      root.add(marker);
      const el = document.createElement('div');
      el.className = 'site-label enemy';
      el.textContent = `${ea.name} → ${ea.target}`;
      const label = new CSS2DObject(el);
      label.center.set(0.5, -0.4);
      label.position.y = 30;
      root.add(label);
      this.scene.add(root);
      this.armourObj = { root, body, label };
    }
    const o = this.armourObj;
    o.root.visible = true;
    o.label.visible = this.showLabels;
    const g = this.world.terrain.groundAt(ea.pos.x, ea.pos.y);
    o.root.position.set(ea.pos.x, g + 2, -ea.pos.y);
    if (Math.hypot(ea.dest.x - ea.pos.x, ea.dest.y - ea.pos.y) > 1) o.body.lookAt(this.tmp.set(ea.dest.x, g + 2, -ea.dest.y));
    // Like our own units, it grows a little with distance so it can be found from the overview.
    const d = this.camera.position.distanceTo(o.root.position);
    o.body.scale.setScalar(clamp((d * 0.021) / 150, 1, 8));
  }

  /** The assault column faces along the road, even halted or forming up; in position it is the laager instead. */
  private driveColumn(c: Column, o: EntityObj): void {
    const to = c.speed > 1 ? { x: c.pos.x + c.vel.x, y: c.pos.y + c.vel.y } : c.dest;
    if (Math.hypot(to.x - c.pos.x, to.y - c.pos.y) > 1) o.body.lookAt(this.tmp.set(to.x, o.root.position.y, -to.y));
    if (c.state === 'arrived') o.root.visible = false;
  }

  /** Helicopters face their heading even in a hover, dip the nose with speed, and spin their rotors. */
  private flyHelo(e: Entity, o: EntityObj, dt: number): void {
    const hdg = ((e as { hdg?: number }).hdg ?? 0) * DEG;
    this.tmp.set(e.pos.x + Math.sin(hdg), e.pos.z, -(e.pos.y + Math.cos(hdg)));
    o.body.lookAt(this.tmp);
    o.body.rotateX(0.14 * clamp(e.speed / 70, 0, 1.2));
    const rotor = o.body.getObjectByName('rotor');
    if (rotor) rotor.rotation.y += dt * 30;
    const tail = o.body.getObjectByName('tailrotor');
    if (tail) tail.rotation.x += dt * 140;
  }

  private syncEntities(ev: FrameEvents): void {
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
      // Grow with distance so aircraft span about 1.2 degrees and munitions 0.8 on screen, never smaller than real.
      const d = camPos.distanceTo(o.root.position);
      const len = MODEL_LEN[modelKind(e)] ?? (e.munition ? 6 : 16);
      o.body.scale.setScalar(clamp((d * (e.munition ? 0.014 : 0.021)) / len, 1, 800));
      if (e.kind === 'helo') this.flyHelo(e, o, ev.simDt);
      else if (e.kind === 'column') this.driveColumn(e as Column, o);
      else if (e.speed > 1) {
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
      if (o.root.visible && this.shotDown(o.e, ev)) {
        o.root.remove(o.body);
        this.wrecks.add(o.e, o.body, o.root.position);
      }
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
        const body = interceptorModel(m.spec.code);
        // Thin guide line over the whole flight; the motor smoke and flame come from Effects.
        const trail = makeTrail(m.spec.code === 'AAM' ? 0xcfe8ff : 0xf0f0f0, 170, 0.28);
        this.scene.add(body, trail.line);
        o = { body, trail };
        this.missileObjs.set(m.id, o);
      }
      toThree(m.pos, o.body.position);
      const d = camPos.distanceTo(o.body.position);
      o.body.scale.setScalar(clamp((d * 0.012) / 4, 1, 500));
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
    const ss = this.selectedSite;
    this.siteRing.visible = !!ss;
    if (ss) this.siteRing.position.set(ss.pos.x, ss.pos.z + 10, -ss.pos.y);
    const extra = this.selectedSites.filter((x) => x !== ss);
    while (this.groupRings.length < extra.length) {
      const ring = this.siteRing.clone();
      this.scene.add(ring);
      this.groupRings.push(ring);
    }
    this.groupRings.forEach((ring, i) => {
      const s = extra[i];
      ring.visible = !!s;
      if (s) ring.position.set(s.pos.x, s.pos.z + 10, -s.pos.y);
    });
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
          this.focusTrack(tr.id);
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
    this.syncArmour();
    for (const b of this.baseObjs) {
      b.label.visible = this.showLabels;
      if ((b.base.lost || (b.site && !b.site.alive)) && !b.dead) {
        b.dead = true;
        for (const m of b.mats) m.color.multiplyScalar(0.25);
        b.label.element.classList.add('dead');
      }
    }
    for (const s of this.siteObjs) {
      // Mobile units move their site: keep the model on it.
      const p = s.site.pos;
      if (p.x !== s.root.position.x || -p.y !== s.root.position.z) s.root.position.set(p.x, this.world.terrain.groundAt(p.x, p.y), -p.y);
      if (!s.site.alive && !s.dead) {
        s.dead = true;
        for (const m of s.mats) m.color.multiplyScalar(0.25);
        s.label.element.classList.add('dead');
      }
      s.label.visible = this.showLabels && s.site.kind !== 'launcher' && !(this.world.ground && s.site.role === 'assault');
      if (s.site.role === 'assault') {
        const laager = s.root.getObjectByName('laager');
        const col = this.world.column;
        if (laager) laager.visible = !col || !col.alive || col.state === 'arrived';
      }
    }
    this.coverage.visible = this.showCoverage;
    // Reinforcements arrived (Last Stand): build their models.
    if (this.siteObjs.length < this.world.sites.length) this.buildSites(this.siteObjs.length);
    // A unit moved during the battle, or an enemy base gave itself away: redraw the rings.
    if (this.world.layoutSeq !== this.coverageSeq) {
      this.clearCoverage();
      this.buildCoverage();
      this.buildBases();
    }
  }

  /**
   * Whether an entity that just disappeared was shot down (and should fall as a wreck) rather than having
   * reached its target or left the map. Uses the sim's record of how it died when there is one, otherwise
   * an air burst at its last position this frame (detonations on target are 'ground' or 'big' effects).
   */
  private shotDown(e: Entity, ev: FrameEvents): boolean {
    if (e.alive) return false;
    const fate = (e as { fate?: unknown }).fate;
    if (fate !== undefined) return isKill(fate);
    return ev.blasts.some((f) => f.kind === 'blast' && Math.hypot(f.pos.x - e.pos.x, f.pos.y - e.pos.y, f.pos.z - e.pos.z) < 300);
  }

  /** What the player can see of an entity: own side, recent detections, or everything with "show undetected". */
  isVisible(e: Entity): boolean {
    return (e.airborne || e.kind === 'convoy' || e.kind === 'column') && (this.showTruth || e.side === 'blue' || this.world.t - e.lastDetected < 12);
  }

  /** Clear trees and houses around every site whenever the set of sites changes, so nothing is buried in a forest. */
  private syncClearings(): void {
    const bases = this.world.theatre.filter((b) => b.known && b.kind !== 'rear');
    const key = this.world.sites.map((s) => `${Math.round(s.pos.x)},${Math.round(s.pos.y)}`).join(';') + `|${bases.length}`;
    if (key === this.clearedKey) return;
    this.clearedKey = key;
    for (const s of this.world.sites) this.scenery.clearAround(s.pos.x, s.pos.y, s.radius + (s.kind === 'asset' ? 250 : 60));
    // Enemy installations stand in the open too (the air base clears its whole runway).
    for (const b of bases) this.scenery.clearAround(b.x, b.y, b.kind === 'airfield' ? 1300 : 220);
  }

  render(): void {
    const now = performance.now();
    const realDt = Math.min(0.25, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const ev = this.events.poll(this.world);
    const visible = (e: Entity): boolean => this.isVisible(e);
    this.syncClearings();
    this.syncStatic();
    if (ev.reset) this.wrecks.reset();
    this.syncEntities(ev);
    this.syncMissiles();
    this.syncTrackLabels();
    this.syncGhosts();
    this.syncGround();
    this.rig.following = this.follow && this.selected !== null;
    this.rig.update(realDt);
    this.controls.update();
    this.rig.clampAboveGround();
    this.fx.update(this.world, ev, visible);
    this.wrecks.update(ev.simDt, this.world.terrain, this.camera.position);
    // Time of day from the campaign clock (minutes since midnight before day 1) plus the battle's own time.
    const clock = this.world.clockStart !== undefined ? this.world.clockStart + this.world.t / 60 : this.planClock?.();
    if (clock !== undefined) this.weather.setHour(clock / 60);
    this.renderer.toneMappingExposure = 0.9 + 0.7 * this.weather.night;
    const strikes = this.weather.update(ev.simDt > 0 ? realDt : 0, this.camera, this.controls.target, this.world.terrain, this.world, this.fx);
    for (const p of strikes) this.sound.thunder(p, this.camera);
    this.scenery.update(realDt);
    updateHaze(this.scene, this.camera.position.y, this.weather.haze);
    this.camera.updateMatrixWorld();
    this.sound.update(this.world, ev, this.camera, visible, realDt);
    this.composer.render();
    this.labels.render(this.scene, this.camera);
  }
}
