import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { airModel, groundGeometry, interceptorModel } from './models';
import type { ModelSpec } from '../ui/armoury-data';

/** Paint for ground units, the same as View3D gives a live site. */
const UNIT_MAT = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.15, roughness: 0.8 });

function part(name: string, parent: THREE.Object3D, x = 0, y = 0, z = 0, ry = 0): THREE.Mesh {
  const m = new THREE.Mesh(groundGeometry(name), UNIT_MAT);
  m.position.set(x, y, z);
  m.rotation.y = ry;
  parent.add(m);
  return m;
}

function box(parent: THREE.Object3D, sx: number, sy: number, sz: number, c: number, x = 0, y = 0, z = 0): void {
  const b = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), new THREE.MeshStandardMaterial({ color: c, roughness: 0.85 }));
  b.position.set(x, y + sy / 2, z);
  parent.add(b);
}

/** A radar on its base, with a mast up to `hm` metres when it stands higher than the deck (as View3D builds it). */
function radar(root: THREE.Object3D, base: string, sig: string, hm: number, deck = 3.4, x = 0, z = 0): void {
  part(base, root, x, 0, z);
  if (hm - deck > 1) part(`mast-${Math.round(hm - deck)}`, root, x, deck, z);
  const face = part(`antenna-${sig}`, root, x, Math.max(hm, deck + 1), z);
  face.rotation.x = sig === 'LR' ? -0.35 : sig === 'EW' ? -0.12 : -0.2;
}

/** A point-defence mount: base, traversing mount and elevating gun, posed slightly up and to one side. */
function gun(root: THREE.Object3D, kind: 'ciws' | 'gun35' | 'laser'): void {
  const [yawAt, pitchY] = kind === 'gun35' ? [[0, 1.6, 0], 1.3] : kind === 'laser' ? [[0, 3.3, 1.6], 1.35] : [[0, 2.3, 1.2], 1.4];
  part(`${kind}-base`, root);
  const yaw = new THREE.Group();
  yaw.position.set(yawAt[0], yawAt[1], yawAt[2]);
  yaw.rotation.y = 0.5;
  part(`${kind}-yaw`, yaw);
  const pitch = new THREE.Group();
  pitch.position.y = pitchY;
  pitch.rotation.x = -0.45;
  part(`${kind}-gun`, pitch);
  yaw.add(pitch);
  root.add(yaw);
}

/** The model the armoury shows for an entry, at true scale in metres, standing on y = 0. */
export function showcaseModel(spec: ModelSpec): THREE.Object3D {
  const root = new THREE.Group();
  switch (spec.kind) {
    case 'air': {
      const m = airModel(spec.key, true);
      root.add(m);
      break;
    }
    case 'missile':
      root.add(interceptorModel(spec.code));
      break;
    case 'enemy-sam':
      radar(root, 'radar-base', 'MR', 4.4);
      part('launcher-MR', root, -16, 0, -14, 0.5);
      part('launcher-MR', root, 16, 0, -14, -0.5);
      break;
    case 'armour':
      part('tank', root, -3, 0, 0);
      part('ifv', root, 4, 0, -6, 0.3);
      break;
    case 'unit':
      switch (spec.type) {
        case 'LR':
          radar(root, 'radar-base-LR', 'LR', 8);
          part('launcher-LR', root, -14, 0, -18, 0.25);
          break;
        case 'MR':
          radar(root, 'radar-base', 'MR', 12);
          part('launcher-MR', root, 14, 0, -14, -0.3);
          break;
        case 'SH':
          radar(root, 'shorad-hull', 'SH', 6, 3.0);
          break;
        case 'CIWS':
          gun(root, 'ciws');
          break;
        case 'GUN':
          gun(root, 'gun35');
          break;
        case 'LASER':
          gun(root, 'laser');
          break;
        case 'EWR':
          radar(root, 'radar-base', 'EW', 14);
          break;
        case 'GAP':
          radar(root, 'radar-base', 'SH', 30);
          break;
        case 'JAM': {
          const truck = part('jammer-base', root);
          part('jammer-head', truck, 0, 9.5, 1.5);
          break;
        }
        case 'GNSS':
          box(root, 3, 2, 3, 0x5b6236);
          box(root, 0.4, 14, 0.4, 0x777777);
          break;
        case 'DECOY':
          box(root, 4, 2, 3, 0x5b6236);
          box(root, 5, 5, 0.4, 0x4b5230, 0, 2, 0);
          break;
        case 'CAP':
          root.add(airModel('fighter'));
          break;
      }
  }
  // Air models are built around their centre of mass: stand them on the floor.
  root.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(root);
  if (spec.kind === 'air' || spec.kind === 'missile') root.position.y = -bb.min.y;
  return root;
}

/**
 * A small turntable: its own renderer and scene, a model on a floor disc, drag to turn it, wheel to zoom.
 * It renders only while running, so a closed armoury costs nothing.
 */
export class Showcase {
  readonly el: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(32, 1, 0.05, 2000);
  private readonly holder = new THREE.Group();
  private readonly floor: THREE.Mesh;
  private readonly grid: THREE.GridHelper;
  private model: THREE.Object3D | null = null;
  private yaw = 0.7;
  private pitch = 0.32;
  private zoom = 1;
  private radius = 10;
  private centreY = 2;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private idleSince = 0;
  private raf = 0;
  private last = 0;
  /** Overall size of the shown model (m), for the caption. */
  size = new THREE.Vector3();

  constructor() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.el = this.renderer.domElement;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();
    this.scene.add(new THREE.HemisphereLight(0xdfeee6, 0x2a3328, 1.1));
    const sun = new THREE.DirectionalLight(0xfff3e0, 2.2);
    sun.position.set(30, 50, 25);
    this.scene.add(sun);
    this.floor = new THREE.Mesh(
      new THREE.CircleGeometry(1, 64).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x1b2a22, roughness: 0.95, transparent: true, opacity: 0.85 }),
    );
    this.grid = new THREE.GridHelper(2, 20, 0x3f7a58, 0x24402f);
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.5;
    this.grid.position.y = 0.01;
    this.scene.add(this.floor, this.grid, this.holder);

    this.el.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.el.setPointerCapture(e.pointerId);
    });
    this.el.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.yaw -= (e.clientX - this.lastX) * 0.01;
      this.pitch = Math.min(1.35, Math.max(-0.05, this.pitch + (e.clientY - this.lastY) * 0.008));
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
    const up = (): void => {
      this.dragging = false;
      this.idleSince = performance.now();
    };
    this.el.addEventListener('pointerup', up);
    this.el.addEventListener('pointercancel', up);
    this.el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoom = Math.min(2.5, Math.max(0.35, this.zoom * Math.exp(e.deltaY * 0.001)));
      },
      { passive: false },
    );
  }

  show(spec: ModelSpec): void {
    if (this.model) this.holder.remove(this.model);
    this.model = showcaseModel(spec);
    this.holder.add(this.model);
    this.model.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(this.model);
    bb.getSize(this.size);
    const sphere = bb.getBoundingSphere(new THREE.Sphere());
    this.radius = Math.max(0.8, sphere.radius);
    this.centreY = sphere.center.y;
    this.holder.position.set(-sphere.center.x, 0, -sphere.center.z);
    const fr = Math.max(this.size.x, this.size.z) * 0.62 + 0.5;
    this.floor.scale.setScalar(fr);
    this.grid.scale.setScalar(fr);
    this.zoom = 1;
    this.pitch = 0.32;
  }

  start(): void {
    if (this.raf) return;
    this.last = performance.now();
    const tick = (now: number): void => {
      this.raf = requestAnimationFrame(tick);
      this.frame(now);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private frame(now: number): void {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    if (!w || !h) return;
    if (this.el.width !== Math.round(w * this.renderer.getPixelRatio()) || this.el.height !== Math.round(h * this.renderer.getPixelRatio())) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
    }
    // Turn slowly by itself, pausing a moment after the player lets go.
    if (!this.dragging && now - this.idleSince > 2500) this.yaw += dt * 0.35;
    // Rotors spin.
    this.model?.traverse((o) => {
      if (o.name === 'rotor') o.rotation.y += dt * 25;
      if (o.name === 'tailrotor') o.rotation.x += dt * 40;
    });
    const fit = this.radius / Math.sin((this.camera.fov * Math.PI) / 360) / Math.min(1, this.camera.aspect);
    const d = fit * 0.78 * this.zoom;
    this.camera.near = Math.max(0.02, d / 200);
    this.camera.far = d * 20;
    this.camera.position.set(Math.sin(this.yaw) * Math.cos(this.pitch) * d, this.centreY + Math.sin(this.pitch) * d, Math.cos(this.yaw) * Math.cos(this.pitch) * d);
    this.camera.lookAt(0, this.centreY, 0);
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
  }
}

