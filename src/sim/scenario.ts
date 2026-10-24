import {
  spawnAirliner,
  spawnBombers,
  spawnCruise,
  spawnDarkAirliner,
  spawnDrones,
  spawnSead,
  spawnSoj,
  spawnTbm,
} from './threats';
import type { World } from './world';

export interface Raid {
  name: string;
  desc: string;
  t: number;
  launched: boolean;
  spawn: (w: World) => void;
  /** Campaign package id, tagged on everything the raid spawns. */
  pkg?: number;
  /** Not reported by intel: no warning when it launches. */
  unreported?: boolean;
}

/** Sandbox scenario: six scripted raids of rising difficulty, plus background civil traffic. */
export class Scenario {
  readonly raids: Raid[];
  private nextCivil = 120;
  private civil = false;
  done = false;
  /** Logged when the last raid is over. */
  doneMsg = 'All raids complete. The sandbox keeps running: use the spawn panel for more.';

  /** `rot` turns the sandbox raids to come from this map's enemy side (they are written for a threat from the north). */
  constructor(raids?: Raid[], rot = 0) {
    if (raids) {
      this.raids = raids;
      return;
    }
    const b = (deg: number): number => (deg + rot) % 360;
    this.raids = [
      {
        name: 'Raid 1: Drone swarm',
        desc: '8 one-way attack drones from the enemy side, low and slow, aimed at the airbase, power plant and CRC.',
        t: 20,
        launched: false,
        spawn: (w) => spawnDrones(w, 8, b(40), 50000),
      },
      {
        name: 'Raid 2: Cruise missiles in the passes',
        desc: '6 terrain-following cruise missiles from the enemy side, down the mountain passes where there are any, timed to arrive with the drones.',
        t: 480,
        launched: false,
        spawn: (w) => spawnCruise(w, 6, b(0), 130000),
      },
      {
        name: 'Raid 3: SEAD under jamming',
        desc: 'A stand-off jammer sets up 125 km out while a SEAD pair hunts emitting radars with anti-radiation missiles.',
        t: 900,
        launched: false,
        spawn: (w) => {
          spawnSoj(w, b(352), 125000);
          spawnSead(w, 2, b(330), 165000);
        },
      },
      {
        name: 'Raid 4: Stand-off bomber strike',
        desc: 'Two bombers launch 8 air-launched cruise missiles from beyond SAM range.',
        t: 1380,
        launched: false,
        spawn: (w) => spawnBombers(w, 2, b(12), 195000),
      },
      {
        name: 'Raid 5: Ballistic missile salvo',
        desc: '4 short-range ballistic missiles on the airbase, LR radar and CRC. Only the LR SAM can intercept them.',
        t: 1950,
        launched: false,
        spawn: (w) => spawnTbm(w, 4, b(358), ['Airbase', 'LR radar', 'CRC', 'Airbase']),
      },
      {
        name: 'Raid 6: Combined strike',
        desc: 'Drones from a flank, cruise missiles from behind us, TBMs, another SEAD pair, and an airliner with its transponder off.',
        t: 2450,
        launched: false,
        spawn: (w) => {
          spawnDrones(w, 10, b(95), 48000, ['Airbase', 'Power plant', 'SHORAD', 'CRC']);
          spawnCruise(w, 4, b(172), 120000, ['Power plant', 'Airbase', 'CRC']);
          spawnTbm(w, 2, b(5), ['Airbase', 'MR radar']);
          spawnSead(w, 2, b(318), 160000);
          spawnDarkAirliner(w);
        },
      },
    ];
  }

  start(w: World): void {
    this.civil = true;
    // Background traffic already en route.
    spawnAirliner(w, true, 0, 0.35);
    spawnAirliner(w, true, 2, 0.45);
    spawnAirliner(w, true, 3, 0.25);
  }

  get next(): Raid | undefined {
    return this.raids.find((r) => !r.launched);
  }

  /** Bring the next raid forward to now. */
  launchNext(w: World): void {
    const r = this.next;
    if (!r) return;
    const shift = r.t - w.t;
    for (const x of this.raids) if (!x.launched) x.t -= shift;
  }

  update(w: World): void {
    for (const r of this.raids) {
      if (!r.launched && w.t >= r.t) {
        r.launched = true;
        w.spawnTag = r.pkg ?? -1;
        r.spawn(w);
        w.spawnTag = -1;
        if (!r.unreported) w.log(`${r.name}: ${r.desc}`, 'raid');
      }
    }
    if (this.civil && w.t >= this.nextCivil) {
      this.nextCivil = w.t + w.rng.range(170, 260);
      spawnAirliner(w, true);
    }
    const last = this.raids.length ? Math.max(...this.raids.map((r) => r.t)) : 0;
    if (!this.done && this.raids.every((r) => r.launched) && w.t > last + 60) {
      const threats = w.pendingCount > 0 || w.entities.some((e) => e.alive && e.side === 'red') || (!!w.enemyArmour && !w.enemyArmour.over);
      if (!threats) {
        this.done = true;
        w.log(this.doneMsg, 'raid');
      }
    }
  }
}
