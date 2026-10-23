import { dist, dot, norm, sub } from './math';
import type { Ident, Track, TrackClass } from './tracker';
import type { World } from './world';

export type Wcs = 'HOLD' | 'TIGHT' | 'FREE';

/** Which identities each weapon control status lets the system engage automatically. */
export function wcsAllows(wcs: Wcs, id: Ident): boolean {
  if (wcs === 'HOLD') return false;
  if (wcs === 'TIGHT') return id === 'HOS';
  return id !== 'FRD' && id !== 'NEU';
}

const PREFERENCE: Record<TrackClass, ('LR' | 'MR' | 'SH')[]> = {
  TBM: ['LR'],
  MSL: ['SH', 'MR', 'LR'],
  CM: ['SH', 'MR', 'LR'],
  UAV: ['SH', 'MR'],
  FW: ['MR', 'LR', 'SH'],
  JAM: ['LR', 'MR'],
  CIV: ['MR', 'LR', 'SH'],
  UNK: ['MR', 'SH'],
};

export const salvoFor = (tr: Track): number => (tr.cls === 'TBM' ? 2 : 1);

/** Seconds until the track reaches its nearest defended site, or Infinity if it is not inbound. */
export function timeToGo(w: World, tr: Track): number {
  let best = Infinity;
  for (const s of w.sites) {
    if (!s.alive || (!s.defended && s.kind !== 'radar')) continue;
    const rel = sub(s.pos, tr.pos);
    const closing = dot(norm(rel), tr.vel);
    if (closing > 15) best = Math.min(best, dist(s.pos, tr.pos) / closing);
  }
  return best;
}

export function missilesOnTrack(w: World, id: number): number {
  let n = 0;
  for (const m of w.missiles) if (m.alive && m.trackId === id && !m.missed) n++;
  return n;
}

/** Threat evaluation and weapon assignment, run once a second unless weapons are on HOLD. */
export function autoEngage(w: World): void {
  if (w.wcs === 'HOLD') return;
  const cands = w.tracker.tracks
    .filter((tr) => tr.confirmed && !tr.dropped && w.t - tr.t < 3 && w.t > tr.kaUntil && wcsAllows(w.wcs, tr.ident))
    .map((tr) => ({ tr, tgo: timeToGo(w, tr) * (tr.cls === 'TBM' ? 0.3 : 1) }))
    .sort((a, b) => a.tgo - b.tgo);
  for (const { tr, tgo } of cands) {
    if (missilesOnTrack(w, tr.id) > 0) continue;
    if (w.fighters.some((f) => f.alive && f.state === 'intercept' && f.targetTrackId === tr.id)) continue;
    const prefs = [...PREFERENCE[tr.cls]];
    if (tr.cls === 'UAV' && tgo < 90) prefs.push('LR');
    for (const code of prefs) {
      const u = w.unit(code);
      if (u && u.feasibility(w, tr).ok) {
        u.fire(w, tr, salvoFor(tr));
        break;
      }
    }
  }
  // Commit CAP on hostile aircraft and jammers well forward of the SAM belt.
  for (const tr of w.tracker.tracks) {
    if (!tr.confirmed || tr.dropped || tr.ident !== 'HOS' || (tr.cls !== 'FW' && tr.cls !== 'JAM')) continue;
    if (Math.hypot(tr.pos.x, tr.pos.y) < 25000) continue;
    if (w.fighters.some((f) => f.state === 'intercept' && f.targetTrackId === tr.id)) continue;
    const free = w.fighters
      .filter((f) => f.alive && f.airborne && f.state === 'station' && f.missiles > 0 && f.fuel > 1200)
      .sort((a, b) => dist(a.pos, tr.pos) - dist(b.pos, tr.pos))[0];
    if (free) free.intercept(w, tr.id);
  }
}
