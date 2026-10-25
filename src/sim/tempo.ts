import type { World } from './world';

/**
 * Auto tempo: time runs fast while the nearest threat is still minutes out, and slows to normal as it closes,
 * so the player spends real time on the engagements and decisions, not on drones crawling in from 40 km.
 * Game pacing, not part of the simulation itself.
 */
export const TEMPO = {
  max: 16,
  /** The campaign's living war runs through quiet hours faster still. */
  warMax: 64,
  /** Seconds of threat travel per step of compression: a threat 60 s out allows 4x, 240 s out 16x. */
  perStepS: 15,
  /** Distance short of a site where a threat counts as arrived (m): weapons reach out about this far. */
  standoffM: 4000,
  /** Living war: a track whose course passes further than this from all our sites does not slow time (m). */
  passM: 20000,
  /** ...and neither does an unidentified track above this height (m), which is most likely an airliner. */
  civilAltM: 5000,
  /** Living war: a track slower than this (m/s) is loitering rather than closing. */
  loiterMS: 15,
  /** Seconds a higher tempo must hold before time speeds up again, so a jittery track does not toggle it. */
  holdS: 3,
};

const LEVELS = [1, 2, 4, 8, 16, 32, 64];

/** Seconds until the nearest hostile or unknown track reaches our ground (Infinity with none in the picture). */
export function timeToContact(w: World, closingOnly = false): number {
  let best = Infinity;
  const sites = w.sites.filter((s) => s.alive);
  for (const t of w.tracker.tracks) {
    if (!t.confirmed || t.dropped || t.ident === 'FRD' || t.ident === 'NEU') continue;
    // Living war: an unidentified track up at airliner height is most likely civil traffic until shown otherwise.
    if (closingOnly && t.ident !== 'HOS' && t.ident !== 'SUS' && t.pos.z > TEMPO.civilAltM) continue;
    let d = Infinity;
    let near = !closingOnly;
    for (const s of sites) {
      const rx = s.pos.x - t.pos.x;
      const ry = s.pos.y - t.pos.y;
      d = Math.min(d, Math.hypot(rx, ry));
      if (near) continue;
      // Where its course passes closest to the site: a track flying past us (an airliner on its airway) does not count.
      const v2 = t.vel.x * t.vel.x + t.vel.y * t.vel.y;
      const k = v2 > 1 ? Math.max(0, (rx * t.vel.x + ry * t.vel.y) / v2) : 0;
      if (Math.hypot(rx - t.vel.x * k, ry - t.vel.y * k) < TEMPO.passM || Math.hypot(rx, ry) < TEMPO.passM) near = true;
    }
    if (!near) continue;
    // Living war: something hovering or loitering (a helicopter, a drone on station) is watched at 4x, not 1x for hours.
    if (closingOnly && Math.hypot(t.vel.x, t.vel.y) < TEMPO.loiterMS) {
      best = Math.min(best, 4 * TEMPO.perStepS);
      continue;
    }
    const speed = Math.max(40, Math.hypot(t.vel.x, t.vel.y, t.vel.z));
    best = Math.min(best, Math.max(0, d - TEMPO.standoffM) / speed);
  }
  return best;
}

/** How fast time may run right now, before hysteresis: 1 whenever something needs watching or deciding. */
export function tempoFor(w: World, max: number = TEMPO.max): number {
  if (w.missiles.length) return 1;
  // A battery just located is a decision: hold normal speed long enough for the player to take it in.
  if (w.exposure.located.some((l) => !l.moved && w.t - l.t < 20)) return 1;
  // So is artillery about to land on one of our positions.
  if (w.exposure.barrages.some((b) => b.at - w.t < 20)) return 1;
  const tti = timeToContact(w, max > TEMPO.max);
  const raw = tti / TEMPO.perStepS;
  let lv = 1;
  for (const l of LEVELS) if (l <= raw) lv = l;
  return Math.min(max, lv);
}

/** Tempo with hysteresis: drops at once, rises only after holding for a few seconds of sim time. */
export class Tempo {
  level = 1;
  /** Fastest compression allowed (the living war allows more). */
  max = TEMPO.max;
  private want = 1;
  private since = 0;
  private w: World | null = null;

  update(w: World): number {
    if (w !== this.w) {
      this.w = w;
      this.level = this.want = 1;
      this.since = w.t;
    }
    const now = tempoFor(w, this.max);
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
