import type { World } from './world';

/**
 * Auto tempo: time runs fast while the nearest threat is still minutes out, and slows to normal as it closes,
 * so the player spends real time on the engagements and decisions, not on drones crawling in from 40 km.
 * Game pacing, not part of the simulation itself.
 */
export const TEMPO = {
  max: 16,
  /** Seconds of threat travel per step of compression: a threat 60 s out allows 4x, 240 s out 16x. */
  perStepS: 15,
  /** Distance short of a site where a threat counts as arrived (m): weapons reach out about this far. */
  standoffM: 4000,
  /** Seconds a higher tempo must hold before time speeds up again, so a jittery track does not toggle it. */
  holdS: 3,
};

const LEVELS = [1, 2, 4, 8, 16];

/** Seconds until the nearest hostile or unknown track reaches our ground (Infinity with none in the picture). */
export function timeToContact(w: World): number {
  let best = Infinity;
  const sites = w.sites.filter((s) => s.alive);
  for (const t of w.tracker.tracks) {
    if (!t.confirmed || t.dropped || t.ident === 'FRD' || t.ident === 'NEU') continue;
    let d = Infinity;
    for (const s of sites) d = Math.min(d, Math.hypot(s.pos.x - t.pos.x, s.pos.y - t.pos.y));
    const speed = Math.max(40, Math.hypot(t.vel.x, t.vel.y, t.vel.z));
    best = Math.min(best, Math.max(0, d - TEMPO.standoffM) / speed);
  }
  return best;
}

/** How fast time may run right now, before hysteresis: 1 whenever something needs watching or deciding. */
export function tempoFor(w: World): number {
  if (w.missiles.length) return 1;
  // A battery just located is a decision: hold normal speed long enough for the player to take it in.
  if (w.exposure.located.some((l) => !l.moved && w.t - l.t < 20)) return 1;
  const tti = timeToContact(w);
  const raw = tti / TEMPO.perStepS;
  let lv = 1;
  for (const l of LEVELS) if (l <= raw) lv = l;
  return Math.min(TEMPO.max, lv);
}

/** Tempo with hysteresis: drops at once, rises only after holding for a few seconds of sim time. */
export class Tempo {
  level = 1;
  private want = 1;
  private since = 0;
  private w: World | null = null;

  update(w: World): number {
    if (w !== this.w) {
      this.w = w;
      this.level = this.want = 1;
      this.since = w.t;
    }
    const now = tempoFor(w);
    if (now < this.level) {
      this.level = now;
      this.want = now;
      this.since = w.t;
    } else if (now !== this.want) {
      this.want = now;
      this.since = w.t;
    } else if (now > this.level && w.t - this.since >= TEMPO.holdS) this.level = now;
    return this.level;
  }
}
