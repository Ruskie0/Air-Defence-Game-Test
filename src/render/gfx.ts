import './gfx.css';

/** Graphics settings: a quality preset and a frame-rate cap, kept in local storage. */
export type Quality = 'low' | 'medium' | 'high';

export interface QualitySpec {
  /** Upper limit on the device pixel ratio. */
  pixelRatio: number;
  /** Multisampling of the off-screen scene target. */
  samples: number;
  bloom: boolean;
  /** Share of the scattered trees and buildings drawn. */
  scatter: number;
  /** Terrain mesh resolution relative to the heightmap (1 = one vertex per sample). */
  terrain: number;
}

export const QUALITY: Record<Quality, QualitySpec> = {
  low: { pixelRatio: 1, samples: 0, bloom: false, scatter: 0.35, terrain: 0.5 },
  medium: { pixelRatio: 1.25, samples: 2, bloom: true, scatter: 0.7, terrain: 1 },
  high: { pixelRatio: 2, samples: 4, bloom: true, scatter: 1, terrain: 1 },
};

/** Frame-rate caps on offer; 0 renders at the display's refresh rate. */
const FPS = [30, 60, 120, 0];
/** While paused, in a menu or on the planning screen nothing moves fast, so the view redraws at this rate. */
export const IDLE_FPS = 30;
const STORE_KEY = 'ad-graphics';

export class Graphics {
  quality: Quality = 'medium';
  fps = 60;
  private readonly listeners: (() => void)[] = [];

  constructor() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as { quality?: Quality; fps?: number } | null;
      if (s?.quality && QUALITY[s.quality]) this.quality = s.quality;
      if (s && FPS.includes(s.fps ?? -1)) this.fps = s.fps!;
    } catch {
      /* storage unavailable */
    }
  }

  get spec(): QualitySpec {
    return QUALITY[this.quality];
  }

  onChange(f: () => void): void {
    this.listeners.push(f);
  }

  private set(q: Quality, fps: number): void {
    const changed = q !== this.quality;
    this.quality = q;
    this.fps = fps;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ quality: q, fps }));
    } catch {
      /* storage unavailable */
    }
    if (changed) for (const f of this.listeners) f();
  }

  /** Display button in the top bar, next to the sound button; it opens the quality and frame-rate choices. */
  mount(): void {
    const wrap = document.createElement('div');
    wrap.className = 'gfx';
    const btn = document.createElement('button');
    btn.id = 'gfx-btn';
    btn.title = 'Graphics: quality and frame-rate cap';
    btn.setAttribute('aria-haspopup', 'true');
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.5 14h5M8 11.5V14" stroke="currentColor" stroke-width="1.4"/></svg>`;
    const panel = document.createElement('div');
    panel.id = 'gfx-panel';
    panel.hidden = true;
    const row = (label: string, opts: [string, string][], cur: string, pick: (v: string) => void): HTMLElement => {
      const r = document.createElement('div');
      r.innerHTML = `<span class="lbl">${label}</span><div class="seg"></div>`;
      const seg = r.querySelector('.seg')!;
      for (const [v, text] of opts) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = text;
        b.classList.toggle('on', v === cur);
        b.addEventListener('click', () => {
          for (const o of seg.children) o.classList.toggle('on', o === b);
          pick(v);
        });
        seg.append(b);
      }
      return r;
    };
    panel.append(
      row('Quality', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], this.quality, (v) => this.set(v as Quality, this.fps)),
      row('Frame cap', FPS.map((f) => [String(f), f ? `${f}` : 'Off']), String(this.fps), (v) => this.set(this.quality, Number(v))),
    );
    const note = document.createElement('p');
    note.textContent = 'Low drops bloom and antialiasing and thins the trees. The view redraws more slowly while paused or in menus.';
    panel.append(note);
    wrap.append(btn, panel);
    const snd = document.querySelector('.snd') ?? document.getElementById('help-btn');
    if (snd) snd.before(wrap);
    else document.body.append(wrap);
    btn.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
      btn.setAttribute('aria-expanded', String(!panel.hidden));
    });
    document.addEventListener('pointerdown', (e) => {
      if (!panel.hidden && !wrap.contains(e.target as Node)) panel.hidden = true;
    });
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        panel.hidden = true;
        btn.focus();
      }
    });
  }
}

export const gfx = new Graphics();
