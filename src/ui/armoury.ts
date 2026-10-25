import { Showcase } from '../render/showcase';
import { ArmouryEntry, Section, armouryEntries } from './armoury-data';
import './armoury.css';

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

type Side = 'blue' | 'red';

/**
 * The armoury: every unit, missile and threat in the game with a turning 3D model, its numbers from the
 * sim and what it is good for. Opens from the main menu, the top bar and the shop's info buttons.
 */
export class Armoury {
  private readonly root: HTMLDivElement;
  private readonly list: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly caption: HTMLElement;
  private showcase: Showcase | null = null;
  private side: Side = 'blue';
  private current: ArmouryEntry | null = null;
  private onClose: (() => void) | null = null;
  /** Keys go to the armoury while it is open, not to the camera or the battle shortcuts. */
  private readonly keys = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement) return;
    e.stopImmediatePropagation();
    if (e.key === 'Escape') this.close();
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this.step(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') this.setSide(this.side === 'blue' ? 'red' : 'blue');
  };

  constructor() {
    this.root = document.createElement('div');
    this.root.id = 'armoury';
    this.root.className = 'hidden';
    this.root.innerHTML = `
      <div class="arm-top">
        <h2>ARMOURY</h2>
        <div class="arm-tabs">
          <button data-side="blue">Our forces</button>
          <button data-side="red">Enemy and civil</button>
        </div>
        <span class="grow"></span>
        <button class="close" data-arm-close title="Close (Esc)">×</button>
      </div>
      <div class="arm-main">
        <nav class="arm-list"></nav>
        <div class="arm-view">
          <div class="arm-stage"></div>
          <div class="arm-caption"></div>
        </div>
        <article class="arm-detail"></article>
      </div>`;
    document.body.appendChild(this.root);
    this.list = this.root.querySelector('.arm-list')!;
    this.detail = this.root.querySelector('.arm-detail')!;
    this.caption = this.root.querySelector('.arm-caption')!;
    this.root.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-side], [data-entry], [data-arm-close]');
      if (!el) return;
      if (el.dataset.armClose !== undefined) this.close();
      else if (el.dataset.side) this.setSide(el.dataset.side as Side);
      else if (el.dataset.entry) this.select(el.dataset.entry);
    });
  }

  get isOpen(): boolean {
    return !this.root.classList.contains('hidden');
  }

  /** Opens on an entry (`u-MR`, `e-arm`, ...) or wherever it was last. `onClose` runs once when it shuts. */
  open(id?: string, onClose?: () => void): void {
    this.onClose = onClose ?? null;
    if (!this.showcase) {
      this.showcase = new Showcase();
      this.root.querySelector('.arm-stage')!.appendChild(this.showcase.el);
    }
    this.root.classList.remove('hidden');
    window.addEventListener('keydown', this.keys, true);
    const entries = armouryEntries();
    const e = entries.find((x) => x.id === id) ?? this.current ?? entries[0];
    this.side = e.side === 'blue' ? 'blue' : 'red';
    this.renderList();
    this.select(e.id);
    this.showcase.start();
  }

  close(): void {
    if (!this.isOpen) return;
    this.root.classList.add('hidden');
    this.showcase?.stop();
    window.removeEventListener('keydown', this.keys, true);
    const cb = this.onClose;
    this.onClose = null;
    cb?.();
  }

  private setSide(side: Side): void {
    if (side === this.side) return;
    this.side = side;
    this.renderList();
    this.select(this.visible()[0].id);
  }

  private visible(): ArmouryEntry[] {
    return armouryEntries().filter((e) => (this.side === 'blue' ? e.side === 'blue' : e.side !== 'blue'));
  }

  private step(d: number): void {
    const v = this.visible();
    const i = v.findIndex((e) => e.id === this.current?.id);
    this.select(v[(i + d + v.length) % v.length].id);
  }

  private renderList(): void {
    for (const b of this.root.querySelectorAll<HTMLElement>('.arm-tabs button')) b.classList.toggle('on', b.dataset.side === this.side);
    const groups = new Map<string, ArmouryEntry[]>();
    for (const e of this.visible()) groups.set(e.group, [...(groups.get(e.group) ?? []), e]);
    this.list.innerHTML = [...groups]
      .map(
        ([g, es]) => `<h4>${esc(g)}</h4>${es
          .map((e) => `<button data-entry="${e.id}" class="${e.side}"><b>${esc(e.name)}</b><small>${esc(e.tag)}</small></button>`)
          .join('')}`,
      )
      .join('');
  }

  private select(id: string): void {
    const e = armouryEntries().find((x) => x.id === id);
    if (!e) return;
    this.current = e;
    for (const b of this.list.querySelectorAll<HTMLElement>('[data-entry]')) {
      const on = b.dataset.entry === id;
      b.classList.toggle('on', on);
      if (on) b.scrollIntoView({ block: 'nearest' });
    }
    this.showcase!.show(e.model);
    const s = this.showcase!.size;
    const dims = [s.z, s.x, s.y].map((v) => (v < 10 ? v.toFixed(1) : Math.round(v))).join(' × ');
    this.caption.innerHTML = `<span>${dims} m (length × width × height)</span><span class="dim">Drag to turn · scroll to zoom</span>`;
    this.detail.innerHTML = `
      <h3 class="${e.side}">${esc(e.name)}</h3>
      <div class="arm-tag">${esc(e.tag)}</div>
      ${e.text.map((t) => `<p>${esc(t)}</p>`).join('')}
      ${e.sections.map(section).join('')}`;
    this.detail.scrollTop = 0;
  }
}

function section(s: Section): string {
  const rows = s.rows ? `<table>${s.rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>` : '';
  const bars = s.bars
    ? `<div class="arm-bars">${s.bars
        .map(
          (b) => `<div class="arm-bar"><span class="k">${esc(b.label)}</span><span class="track"><i style="width:${Math.max(2, Math.round(b.value * 100))}%"></i></span><span class="v">${esc(b.text)}</span></div>`,
        )
        .join('')}</div>`
    : '';
  return `<section><h4>${esc(s.title)}</h4>${rows}${bars}${s.note ? `<p class="dim small">${esc(s.note)}</p>` : ''}</section>`;
}

export const armoury = new Armoury();
