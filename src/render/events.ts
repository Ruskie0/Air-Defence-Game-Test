import type { Interceptor } from '../sim/missile';
import type { Effect, LogEntry, World } from '../sim/world';

export interface FrameEvents {
  /** Sim seconds since the last frame (0 while paused). */
  simDt: number;
  /** True when the world was replaced or rewound: drop anything carried over. */
  reset: boolean;
  launches: Interceptor[];
  blasts: Effect[];
  logs: LogEntry[];
}

/**
 * Turns per-frame world state into discrete presentation events (launches, detonations, new log lines)
 * by diffing, so effects and sound need no hooks in the simulation.
 */
export class WorldEvents {
  private world: World | null = null;
  private lastT = 0;
  private seenMissiles = new Set<number>();
  private lastEffect = 0;
  private lastLog = 0;

  poll(w: World): FrameEvents {
    const reset = w !== this.world || w.t < this.lastT;
    if (reset) {
      this.world = w;
      this.seenMissiles = new Set(w.missiles.map((m) => m.id));
      this.lastEffect = w.effects.reduce((a, f) => Math.max(a, f.id), 0);
      this.lastLog = w.logSeq;
      this.lastT = w.t;
      return { simDt: 0, reset, launches: [], blasts: [], logs: [] };
    }
    const simDt = w.t - this.lastT;
    this.lastT = w.t;
    const launches: Interceptor[] = [];
    const live = new Set<number>();
    for (const m of w.missiles) {
      live.add(m.id);
      if (!this.seenMissiles.has(m.id)) launches.push(m);
    }
    this.seenMissiles = live;
    const blasts: Effect[] = [];
    for (const f of w.effects) {
      if (f.id > this.lastEffect) {
        blasts.push(f);
        this.lastEffect = f.id;
      }
    }
    const fresh = Math.min(w.logSeq - this.lastLog, w.logEntries.length);
    const logs = fresh > 0 ? w.logEntries.slice(-fresh) : [];
    this.lastLog = w.logSeq;
    return { simDt, reset, launches, blasts, logs };
  }
}
