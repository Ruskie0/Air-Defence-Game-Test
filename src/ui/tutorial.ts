import { spawnCruise, spawnDrones, spawnSead } from '../sim/threats';
import type { World } from '../sim/world';
import type { GameControl, Hud } from './hud';

/** One step of the training mission: what to read, what to do, and how to tell it has been done. */
interface Step {
  title: string;
  text: string;
  /** Run once when the step starts (spawn threats, set the scene). */
  enter?: (w: World) => void;
  /** Done when this returns true; steps without it wait for the Next button. */
  done?: (w: World, hud: Hud, ctl: GameControl) => boolean;
}

/** No enemy aircraft or weapons left in the air, and none still to come. */
const clear = (w: World): boolean => w.pendingCount === 0 && !w.entities.some((e) => e.alive && e.side === 'red');

/** No enemy weapons left in the air and every enemy aircraft gone or on its way home. */
const leaving = (w: World): boolean =>
  w.pendingCount === 0 && !w.entities.some((e) => e.alive && e.side === 'red' && (e.munition || !(e as { egress?: boolean }).egress));

const firedTotal = (w: World): number => w.stats.fired.LR + w.stats.fired.MR + w.stats.fired.SH + w.stats.fired.AAM;

/**
 * A short guided battle for new players: camera and time, tracks, weapons control status, a manual engagement
 * and radar emission control against SEAD. Each step waits for the player to do the thing it describes.
 */
export class Tutorial {
  private readonly el: HTMLElement;
  private i = 0;
  private doneAt = -1;
  private firedAtStart = 0;
  private readonly steps: Step[];

  constructor(
    private readonly w: World,
    private readonly hud: Hud,
    private readonly ctl: GameControl,
    private readonly finish: (to: 'campaign' | 'menu') => void,
  ) {
    const enemy = w.terrain.layout.rot;
    this.steps = [
      {
        title: 'Welcome, commander',
        text: 'You defend the <b>airbase</b>, the <b>CRC</b> (command and reporting centre) and the <b>power plant</b> with an MR SAM battery, a SHORAD unit, a CIWS gun and an early warning radar. Drag to orbit the camera, scroll to zoom, WASD to pan. The round scope at the bottom right (the PPI) is the radar picture from above. The enemy is to the <b>' + compass(enemy) + '</b>.',
      },
      {
        title: 'Time',
        text: 'Real battles have long quiet spells. Speed up time with the buttons at the top (or the keys 1 to 5); Space pauses. <b>Set the speed to 4× or more.</b>',
        done: (_w, _h, ctl) => ctl.speed >= 4 && !ctl.paused,
      },
      {
        title: 'Tracks',
        text: 'Three attack drones are coming in low. As radars see them they appear as <b>tracks</b> in the table on the right, in red once identified hostile. <b>Click a track</b> in the table, on the PPI or on its label in the 3D view.',
        enter: (w) => spawnDrones(w, 3, enemy, 32000, undefined, undefined, 'range'),
        done: (_w, hud) => hud.selected !== null,
      },
      {
        title: 'Weapons control status',
        text: 'Weapons are on <b>HOLD</b>: nothing fires on its own. <b>TIGHT</b> lets the system engage anything identified hostile automatically; <b>FREE</b> also engages suspects. <b>Set WCS to TIGHT</b> in the top bar.',
        done: (w) => w.wcs === 'TIGHT',
      },
      {
        title: 'Let them work',
        text: 'The SHORAD and MR SAM now pick their targets themselves. Watch the missiles fly; the log at the bottom tells you what happens. <b>Wait until the drones are gone.</b>',
        done: clear,
      },
      {
        title: 'Fire by hand',
        text: 'Weapons are back on HOLD. Two cruise missiles are coming in fast and low. Select one of their tracks, then press the <b>MR SAM</b> button in the panel on the right to fire. Grey buttons say why that unit cannot shoot yet (out of range, no line of sight).',
        enter: (w) => {
          w.setWcs('HOLD');
          this.firedAtStart = firedTotal(w);
          spawnCruise(w, 2, enemy, 60000, ['Airbase'], 'range');
        },
        done: (w) => firedTotal(w) > this.firedAtStart,
      },
      {
        title: 'Finish the job',
        text: 'Good shot. <b>Set WCS to TIGHT</b> again and let the defence take care of the rest. The CIWS on the airbase is the last line of defence.',
        done: (w) => w.wcs !== 'HOLD' && clear(w),
      },
      {
        title: 'SEAD: radars are targets too',
        text: 'Two SEAD fighters are hunting radiating radars with anti-radiation missiles (ARMs). Radars with <b>ARM auto</b> on go silent when an ARM is seen coming; you can also select a radar in the left panel and press <b>EMCON</b> to silence it yourself. An MR battery can still fire on tracks from the early warning radar. <b>Survive the attack.</b>',
        enter: (w) => spawnSead(w, 2, enemy, 150000, 'range'),
        done: leaving,
      },
      {
        title: 'Ready',
        text: 'That is the core of it. In the campaign you also buy and place units, earn money from what still stands, and face an enemy that learns from what worked. Press <b>?</b> in the top bar at any time for the full guide.',
      },
    ];
    this.el = document.createElement('div');
    this.el.id = 'coach';
    this.el.className = 'panel';
    document.body.appendChild(this.el);
    this.el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('[data-coach]') as HTMLElement | null;
      if (!b) return;
      const act = b.dataset.coach;
      if (act === 'next') this.go(this.i + 1);
      else if (act === 'campaign' || act === 'menu') {
        this.close();
        this.finish(act);
      }
    });
    w.setWcs('HOLD');
    this.go(0);
  }

  private go(i: number): void {
    this.i = Math.min(i, this.steps.length - 1);
    this.doneAt = -1;
    this.steps[this.i].enter?.(this.w);
    this.render(false);
  }

  private render(ticked: boolean): void {
    const s = this.steps[this.i];
    const last = this.i === this.steps.length - 1;
    const btns = last
      ? '<button data-coach="campaign" class="go">Start a campaign</button><button data-coach="menu">Main menu</button>'
      : s.done
        ? '<button data-coach="next" class="skip" title="Skip this step">Skip</button>'
        : '<button data-coach="next" class="go">Next</button>';
    this.el.innerHTML = `<div class="coach-h"><span class="lbl">TRAINING ${this.i + 1}/${this.steps.length}</span><b>${s.title}</b>${ticked ? '<span class="ok">✓</span>' : ''}</div>
      <p>${s.text}</p><div class="coach-b">${btns}${last ? '' : '<button data-coach="menu" class="skip">Leave</button>'}</div>`;
  }

  /** Called every frame: advance a step a moment after its goal is met. */
  update(): void {
    const s = this.steps[this.i];
    if (!s.done) return;
    const now = performance.now();
    if (this.doneAt < 0) {
      if (s.done(this.w, this.hud, this.ctl)) {
        this.doneAt = now;
        this.render(true);
      }
    } else if (now - this.doneAt > 1500) this.go(this.i + 1);
  }

  close(): void {
    this.el.remove();
  }
}

function compass(deg: number): string {
  return ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}
