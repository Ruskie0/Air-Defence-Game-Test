import type { Engagement, War } from '../campaign/war';
import { hhmm } from '../campaign/clock';
import type { GameControl } from './hud';

const esc = (s: string): string => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

/**
 * Campaign days: the card that opens each engagement (Command or Delegate), the bar while one is commanded
 * (End engagement once the sky is clear), and the line while a delegated one runs or the clock cuts forward.
 */
export class EngagementCard {
  private readonly el: HTMLDivElement;
  private last = '';
  private note = '';
  private noteUntil = 0;

  constructor(
    private readonly ctl: GameControl,
    private readonly war: () => War | null,
  ) {
    this.el = document.createElement('div');
    this.el.id = 'eng-card';
    document.body.appendChild(this.el);
    this.el.addEventListener('click', (ev) => {
      const b = (ev.target as HTMLElement).closest('button');
      const w = this.war();
      if (!b || !w) return;
      const a = b.dataset.eng;
      if (a === 'command' || a === 'delegate') {
        w.decide(a === 'command');
        this.ctl.paused = false;
        if (a === 'command') this.ctl.speed = 1;
      } else if (a === 'end') {
        this.show(`Engagement over: ${w.endEngagement()}`);
      }
      this.last = '';
    });
  }

  prompt(_e: Engagement): void {
    this.last = '';
  }

  done(e: Engagement): void {
    this.show(`Delegated engagement over: ${e.summary ?? ''}`);
  }

  private show(msg: string): void {
    this.note = msg;
    this.noteUntil = performance.now() + 12000;
    this.last = '';
  }

  update(w: War): void {
    const e = w.eng;
    let html = '';
    if (w.phase === 'prompt' && e) {
      html = `<div class="eng-prompt"><h3>Enemy operation launched, ${hhmm(e.start)}</h3><ul>${e.brief.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
        <p class="dim">Command: you fight it in real time, from the first vague tracks until you call it over. Delegate: the same battle runs at full speed under your standing orders, and you get the result.</p>
        <button data-eng="command" class="primary">Command</button> <button data-eng="delegate">Delegate</button></div>`;
    } else if (w.phase === 'live' && e) {
      const clear = w.engagementClear();
      html = `<div class="eng-bar"><b>Engagement</b> since ${hhmm(e.start)} · ${e.brief.length} package${e.brief.length > 1 ? 's' : ''}${e.fired ? '' : ' · approach (up to 4x)'}
        <button data-eng="end" ${clear ? '' : 'disabled'} title="${clear ? 'Close the engagement and see the summary; the clock then rolls on to the next one' : 'Hostiles still in the air or on their way'}">End engagement</button></div>`;
    } else if (w.phase === 'delegate') {
      html = `<div class="eng-bar"><b>Delegated engagement</b> running under standing orders · ${hhmm(w.clock)}</div>`;
    } else if (performance.now() < this.noteUntil) {
      html = `<div class="eng-bar">${esc(this.note)}</div>`;
    } else if (w.phase === 'cut' && !this.ctl.paused) {
      html = `<div class="eng-bar dim">No engagement · ${hhmm(w.clock)} · the clock runs on to the next enemy operation (P for orders)</div>`;
    }
    if (html !== this.last) {
      this.el.innerHTML = html;
      this.last = html;
    }
  }
}
