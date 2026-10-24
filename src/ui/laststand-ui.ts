import { LastStand, WAVE_PAY_M } from '../campaign/laststand';
import type { GameControl } from './hud';

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** The Last Stand panel: the reinforcement pick between waves and the result at the end. */
export class StandUi {
  private readonly el: HTMLDivElement;

  constructor(
    private readonly st: LastStand,
    private readonly ctl: GameControl,
    private readonly host: { again: () => void; menu: () => void },
  ) {
    this.el = document.createElement('div');
    this.el.id = 'stand';
    this.el.className = 'panel';
    this.el.hidden = true;
    document.body.appendChild(this.el);
    this.el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('[data-stand]') as HTMLElement | null;
      if (!b) return;
      const act = b.dataset.stand;
      if (act === 'pick') {
        this.st.choose(Number(b.dataset.i));
        this.ctl.paused = false;
        this.render();
      } else if (act === 'again') this.host.again();
      else if (act === 'menu') this.host.menu();
    });
  }

  /** Show whatever the stand is waiting on: a pick, the result, or nothing while a wave runs. */
  render(): void {
    const st = this.st;
    if (st.over) {
      const record = st.held > 0 && st.held >= st.best;
      this.el.innerHTML = `<div class="coach-h"><span class="lbl">LAST STAND</span><b>The line has broken</b></div>
        <p>${esc(st.over)}${record ? ' <b class="ok">A new best!</b>' : ` Your best is ${st.best}.`}</p>
        <div class="coach-b"><button data-stand="again" class="go">Try again</button><button data-stand="menu">Main menu</button></div>`;
      this.el.hidden = false;
      this.ctl.paused = true;
      return;
    }
    if (st.offer) {
      this.el.innerHTML = `<div class="coach-h"><span class="lbl">WAVE ${st.wave} HELD</span><b>Pick a reinforcement</b><span class="dim" style="margin-left:auto">+$${WAVE_PAY_M}M support budget</span></div>
        <p class="dim">Wave ${st.wave + 1} launches 30 seconds after you choose. New units arrive at a free default spot: move them where you need them.</p>
        <div class="cards">${st.offer
          .map((c, i) => `<button data-stand="pick" data-i="${i}"><b>${esc(c.name)}</b><small>${esc(c.desc)}</small></button>`)
          .join('')}</div>`;
      this.el.hidden = false;
      this.ctl.paused = true;
      return;
    }
    this.el.hidden = true;
  }

  close(): void {
    this.el.remove();
  }
}
