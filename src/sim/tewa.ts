import { dist, dot, norm, sub } from './math';
import type { FireUnit } from './sites';
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
  RW: ['SH', 'MR'],
  FW: ['MR', 'LR', 'SH'],
  JAM: ['LR', 'MR'],
  CIV: ['MR', 'LR', 'SH'],
  UNK: ['MR', 'SH'],
};

/** Share of an MR battery's rounds held back from drones. */
export const MR_RESERVE = 1 / 3;

/** Inside this time to go (s) a second weapon backs up a missile already in flight. */
export const BACKUP_TGO_S = 30;

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
  const friends = w.tracker.tracks.filter((t) => t.ident === 'FRD' && !t.dropped);
  for (const { tr, tgo } of cands) {
    // Shoot-look-shoot, but not to the point of letting a threat through: once a target is close to a defended
    // site, a second weapon (from another battery) goes up even with one missile already on it, since not every
    // shot kills.
    const onIt = missilesOnTrack(w, tr.id);
    if (onIt >= 2 || (onIt === 1 && tgo > BACKUP_TGO_S)) continue;
    const firing = new Set(w.missiles.filter((m) => m.alive && m.trackId === tr.id && !m.missed).map((m) => m.fu));
    // Hold fire while a friendly is close enough to the target to be taken by the seeker or the fuze.
    const p = tr.predict(w.t);
    if (friends.some((f) => dist(f.predict(w.t), p) < Math.max(6000, 3 * tr.sigma))) continue;
    if (w.fighters.some((f) => f.alive && f.state === 'intercept' && f.targetTrackId === tr.id)) continue;
    const prefs = [...PREFERENCE[tr.cls]];
    if (tr.cls === 'UAV' && tgo < 90) prefs.push('LR');
    for (const type of prefs) {
      // Of the batteries of this type that can take the shot, the one with the earliest intercept.
      let best: { u: FireUnit; tof: number } | null = null;
      for (const u of w.units) {
        if (u.type !== type || u.hold || firing.has(u)) continue;
        // Magazine discipline: keep the last MR rounds for cruise missiles, ARMs and aircraft.
        if (type === 'MR' && tr.cls === 'UAV' && u.rounds <= Math.ceil(u.maxRounds * MR_RESERVE)) continue;
        const f = u.feasibility(w, tr);
        if (f.ok && (!best || f.tof! < best.tof)) best = { u, tof: f.tof! };
      }
      if (best) {
        best.u.fire(w, tr, salvoFor(tr));
        break;
      }
    }
  }
  // Commit CAP on hostile aircraft and jammers well forward of the SAM belt.
  for (const tr of w.tracker.tracks) {
    // High drones are recon platforms, worth a fighter too.
    const highDrone = tr.cls === 'UAV' && tr.pos.z > 5000;
    if (!tr.confirmed || tr.dropped || tr.ident !== 'HOS' || (tr.cls !== 'FW' && tr.cls !== 'JAM' && !highDrone)) continue;
    if (Math.hypot(tr.pos.x, tr.pos.y) < 25000) continue;
    if (w.fighters.some((f) => f.state === 'intercept' && f.targetTrackId === tr.id)) continue;
    const free = w.fighters
      .filter((f) => f.alive && f.airborne && f.state === 'station' && f.missiles > 0 && f.fuel > 700)
      .sort((a, b) => dist(a.pos, tr.pos) - dist(b.pos, tr.pos))[0];
    if (free) free.intercept(w, tr.id);
  }
}
