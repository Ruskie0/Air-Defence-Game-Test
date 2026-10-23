import { DEG } from '../sim/constants';
import type { Ident } from '../sim/tracker';
import type { World } from '../sim/world';
import { IDENT_COLOR } from './colors';

const RANGES = [20, 50, 100, 200];

/** Plan position indicator: north-up, centred on the airbase, showing the fused air picture. */
export class Ppi {
  readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private world: World;
  private relief: HTMLCanvasElement;
  rangeKm = 100;
  selected: number | null = null;
  onSelect: (id: number | null) => void = () => {};
  private size = 300;

  constructor(canvas: HTMLCanvasElement, world: World) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d')!;
    this.world = world;
    this.relief = this.buildRelief();
    canvas.addEventListener('pointerdown', (e) => this.click(e));
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.cycleRange(e.deltaY > 0 ? 1 : -1);
    });
  }

  setWorld(w: World): void {
    const newMap = w.terrain !== this.world.terrain;
    this.world = w;
    if (newMap) this.relief = this.buildRelief();
    this.selected = null;
  }

  cycleRange(dir: number): void {
    const i = RANGES.indexOf(this.rangeKm);
    this.rangeKm = RANGES[Math.max(0, Math.min(RANGES.length - 1, i + dir))];
  }

  private buildRelief(): HTMLCanvasElement {
    const t = this.world.terrain;
    const n = 256;
    const c = document.createElement('canvas');
    c.width = c.height = n;
    const g = c.getContext('2d')!;
    const img = g.createImageData(n, n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = -t.half + ((i + 0.5) / n) * 2 * t.half;
        const y = t.half - ((j + 0.5) / n) * 2 * t.half;
        const h = t.heightAt(x, y);
        const hx = t.heightAt(x + 600, y) - h;
        const shade = Math.max(0, Math.min(1, 0.5 - hx / 400));
        const k = (j * n + i) * 4;
        if (h <= 0) {
          img.data[k] = 8;
          img.data[k + 1] = 22;
          img.data[k + 2] = 38;
        } else {
          const v = 18 + Math.min(1, h / 2800) * 46 + shade * 22;
          img.data[k] = v * 0.55;
          img.data[k + 1] = v * 0.8;
          img.data[k + 2] = v * 0.5;
        }
        img.data[k + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  private toScreen(x: number, y: number): [number, number] {
    const s = this.size / 2 / (this.rangeKm * 1000);
    return [this.size / 2 + x * s, this.size / 2 - y * s];
  }

  private click(e: PointerEvent): void {
    const r = this.canvas.getBoundingClientRect();
    const mx = ((e.clientX - r.left) / r.width) * this.size;
    const my = ((e.clientY - r.top) / r.height) * this.size;
    let best: number | null = null;
    let bd = 14;
    for (const tr of this.world.tracker.tracks) {
      if (!tr.confirmed) continue;
      const p = tr.predict(this.world.t);
      const [sx, sy] = this.toScreen(p.x, p.y);
      const d = Math.hypot(sx - mx, sy - my);
      if (d < bd) {
        bd = d;
        best = tr.id;
      }
    }
    this.onSelect(best);
  }

  private symbol(x: number, y: number, id: Ident, sel: boolean): void {
    const g = this.g;
    const c = IDENT_COLOR[id];
    g.strokeStyle = c;
    g.fillStyle = c;
    g.lineWidth = 1.6;
    g.beginPath();
    const r = 5;
    if (id === 'HOS' || id === 'SUS') {
      g.moveTo(x, y - r);
      g.lineTo(x + r, y);
      g.lineTo(x, y + r);
      g.lineTo(x - r, y);
      g.closePath();
    } else if (id === 'FRD') g.arc(x, y, r, 0, Math.PI * 2);
    else g.rect(x - r * 0.8, y - r * 0.8, r * 1.6, r * 1.6);
    g.stroke();
    if (sel) {
      g.strokeStyle = '#ffffff';
      g.strokeRect(x - 9, y - 9, 18, 18);
    }
  }

  draw(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const css = this.canvas.clientWidth || 300;
    if (this.canvas.width !== Math.round(css * dpr)) {
      this.canvas.width = Math.round(css * dpr);
      this.canvas.height = Math.round(css * dpr);
    }
    this.size = css;
    const g = this.g;
    const w = this.world;
    const S = this.size;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#050a07';
    g.fillRect(0, 0, S, S);

    // Terrain relief (the map covers +/-80 km).
    const half = w.terrain.half;
    const [rx0, ry0] = this.toScreen(-half, half);
    const [rx1, ry1] = this.toScreen(half, -half);
    g.globalAlpha = 0.85;
    g.drawImage(this.relief, rx0, ry0, rx1 - rx0, ry1 - ry0);
    g.globalAlpha = 1;

    g.save();
    g.beginPath();
    g.arc(S / 2, S / 2, S / 2 - 1, 0, Math.PI * 2);
    g.clip();

    // Range rings and bearing ticks.
    g.strokeStyle = 'rgba(120,255,160,0.22)';
    g.lineWidth = 1;
    g.font = '9px ui-monospace, monospace';
    g.fillStyle = 'rgba(140,255,170,0.55)';
    for (let i = 1; i <= 4; i++) {
      g.beginPath();
      g.arc(S / 2, S / 2, (S / 2) * (i / 4), 0, Math.PI * 2);
      g.stroke();
      g.fillText(`${(this.rangeKm * i) / 4}`, S / 2 + 2, S / 2 - (S / 2) * (i / 4) + 10);
    }
    for (let a = 0; a < 360; a += 30) {
      g.beginPath();
      g.moveTo(S / 2, S / 2);
      g.lineTo(S / 2 + Math.sin(a * DEG) * S, S / 2 - Math.cos(a * DEG) * S);
      g.stroke();
    }

    // Weapon zones.
    const zone = (x: number, y: number, rKm: number, col: string, a0?: number, a1?: number): void => {
      const [cx, cy] = this.toScreen(x, y);
      const r = (rKm / this.rangeKm) * (S / 2);
      g.strokeStyle = col;
      g.setLineDash([4, 4]);
      g.beginPath();
      if (a0 !== undefined && a1 !== undefined) {
        g.moveTo(cx, cy);
        g.arc(cx, cy, r, (a0 - 90) * DEG, (a1 - 90) * DEG);
        g.closePath();
      } else g.arc(cx, cy, r, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
    };
    for (const u of w.units) {
      const r = u.radar!;
      if (u.type === 'LR') {
        zone(r.pos.x, r.pos.y, 120, 'rgba(111,182,255,0.55)', r.boresight - 60, r.boresight + 60);
        zone(r.pos.x, r.pos.y, 40, 'rgba(180,140,255,0.45)', r.boresight - 60, r.boresight + 60);
      } else if (u.type === 'MR') zone(r.pos.x, r.pos.y, 32, 'rgba(88,214,141,0.45)');
      else zone(r.pos.x, r.pos.y, 10, 'rgba(247,220,111,0.5)');
    }
    for (const j of w.gnss) if (j.active) zone(j.site.pos.x, j.site.pos.y, j.rangeM / 1000, 'rgba(255,140,66,0.5)');

    // Rotating radar sweeps.
    for (const r of w.radars) {
      if (!r.isEmitting() || r.spec.scan.kind !== 'rotating' || r.code.startsWith('C')) continue;
      const [cx, cy] = this.toScreen(r.pos.x, r.pos.y);
      const len = (r.spec.maxRangeKm / this.rangeKm) * (S / 2);
      for (let k = 0; k < 10; k++) {
        const a = (r.az - k * 2.5) * DEG;
        g.strokeStyle = `rgba(120,255,160,${0.35 * (1 - k / 10)})`;
        g.beginPath();
        g.moveTo(cx, cy);
        g.lineTo(cx + Math.sin(a) * len, cy - Math.cos(a) * len);
        g.stroke();
      }
    }

    // Jam strobes.
    g.lineWidth = 2;
    for (const r of w.allRadars()) {
      for (const s of r.strobes) {
        const [cx, cy] = this.toScreen(s.origin.x, s.origin.y);
        g.strokeStyle = `rgba(255,150,40,${Math.min(0.8, 0.25 + s.jnrDb / 80)})`;
        g.beginPath();
        g.moveTo(cx, cy);
        g.lineTo(cx + Math.sin(s.az * DEG) * S * 1.5, cy - Math.cos(s.az * DEG) * S * 1.5);
        g.stroke();
      }
    }
    g.lineWidth = 1;

    // Friendly sites.
    for (const s of w.sites) {
      const [x, y] = this.toScreen(s.pos.x, s.pos.y);
      g.fillStyle = s.alive ? (s.defended ? '#7fc1ff' : '#4d7fae') : '#555';
      const r = s.defended ? 3 : 2;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }

    // Interceptors in flight.
    g.fillStyle = '#ffffff';
    for (const m of w.missiles) {
      const [x, y] = this.toScreen(m.pos.x, m.pos.y);
      g.fillRect(x - 1, y - 1, 2, 2);
    }

    // Tracks.
    for (const tr of w.tracker.tracks) {
      const p = tr.predict(w.t);
      const [x, y] = this.toScreen(p.x, p.y);
      if (!tr.confirmed) {
        g.fillStyle = 'rgba(200,200,200,0.5)';
        g.fillRect(x - 1, y - 1, 2, 2);
        continue;
      }
      const sel = tr.id === this.selected;
      // History dots and 60 s velocity leader.
      g.fillStyle = IDENT_COLOR[tr.ident];
      g.globalAlpha = 0.4;
      for (const h of tr.trail) {
        const [hx, hy] = this.toScreen(h.x, h.y);
        g.fillRect(hx - 0.7, hy - 0.7, 1.4, 1.4);
      }
      g.globalAlpha = 1;
      const [vx, vy] = this.toScreen(p.x + tr.vel.x * 60, p.y + tr.vel.y * 60);
      g.strokeStyle = IDENT_COLOR[tr.ident];
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(vx, vy);
      g.stroke();
      this.symbol(x, y, tr.ident, sel);
      if (sel || this.rangeKm <= 50 || tr.ident === 'HOS') {
        g.fillStyle = IDENT_COLOR[tr.ident];
        g.fillText(`${tr.label} ${tr.cls}`, x + 7, y - 6);
      }
    }
    g.restore();

    g.fillStyle = 'rgba(140,255,170,0.8)';
    g.font = '10px ui-monospace, monospace';
    g.fillText(`PPI  ${this.rangeKm} km`, 6, 12);
    g.fillText('N', S / 2 - 3, 11);
  }
}
