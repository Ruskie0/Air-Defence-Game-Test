import { DEG, G, toDb } from './constants';
import { V3, addScaled, bearingDeg, clamp, clone, dist, hdist, len, lerp, sub, v3, wrap180 } from './math';
import type { Report, Strobe } from './radar';
import type { World } from './world';

export type TrackClass = 'UNK' | 'FW' | 'RW' | 'CIV' | 'UAV' | 'CM' | 'MSL' | 'TBM' | 'JAM';
export type Ident = 'PEND' | 'UNK' | 'FRD' | 'NEU' | 'SUS' | 'HOS';

export class Track {
  readonly id: number;
  readonly label: string;
  pos: V3;
  vel: V3 = v3();
  t: number;
  readonly born: number;
  hits = 1;
  confirmed = false;
  /** Rough 1-sigma position error (m). */
  sigma: number;
  /** Per-axis Kalman covariance [pos var, pos-vel cov, vel var] for x, y, z (constant-velocity model). */
  readonly cov: [number, number, number][];
  /** 1-sigma speed uncertainty (m/s): kinematic classification waits until this is small. */
  velSigma = 1000;
  readonly sources = new Map<string, number>();
  iffM5 = 0;
  iffM3 = 0;
  iffNone = 0;
  /** Recent share of IFF interrogations answered with civil Mode 3/C (0..1, exponentially weighted). */
  squawk = 0;
  cls: TrackClass = 'UNK';
  ident: Ident = 'PEND';
  manual: Ident | null = null;
  hostileAct = false;
  jam = false;
  /** False for jammer tracks that exist only as strobe cross-fixes (no radar skin return). */
  skin = true;
  ballistic = false;
  rcsDb = 0;
  trail: V3[] = [];
  private nextTrail = 0;
  /** Kill assessment window after a friendly warhead detonated on this track. */
  kaUntil = 0;
  dropped = false;

  constructor(id: number, pos: V3, t: number, sigma: number, sigmaH = sigma, sigmaZ = sigma) {
    this.id = id;
    this.label = `T${String(id).padStart(3, '0')}`;
    this.pos = clone(pos);
    this.t = t;
    this.born = t;
    this.sigma = sigma;
    // Velocity starts unknown: anything up to TBM speeds.
    const v0 = 1500 * 1500;
    this.cov = [
      [sigmaH * sigmaH, 0, v0],
      [sigmaH * sigmaH, 0, v0],
      [sigmaZ * sigmaZ, 0, v0],
    ];
  }

  predict(t: number): V3 {
    const dt = t - this.t;
    const p = addScaled(this.pos, this.vel, dt);
    if (this.ballistic) p.z -= 0.5 * G * dt * dt;
    return p;
  }

  velAt(t: number): V3 {
    if (!this.ballistic) return clone(this.vel);
    return v3(this.vel.x, this.vel.y, this.vel.z - G * (t - this.t));
  }

  get speed(): number {
    return len(this.vel);
  }

  /** Sensors that updated this track in the last few seconds. */
  liveSources(t: number): string[] {
    const s: string[] = [];
    for (const [k, v] of this.sources) if (t - v < 6) s.push(k);
    return s;
  }

  recordTrail(t: number): void {
    if (t < this.nextTrail) return;
    this.nextTrail = t + 2;
    this.trail.push(clone(this.pos));
    if (this.trail.length > 24) this.trail.shift();
  }
}

/** Central track fusion: every sensor report goes through one association / alpha-beta filter stage. */
export class Tracker {
  readonly tracks: Track[] = [];
  private nextNum = 1;
  private nextHousekeeping = 0;
  private nextJam = 0;

  get(id: number): Track | undefined {
    return this.tracks.find((t) => t.id === id);
  }

  private associate(w: World, r: Report): Track | null {
    let best: Track | null = null;
    let bestCost = 1;
    for (const tr of this.tracks) {
      if (!tr.skin) continue;
      const dtp = Math.max(0, r.t - tr.t);
      const pred = tr.predict(r.t);
      const d = dist(pred, r.pos);
      const vmax = r.pos.z > 15000 || pred.z > 15000 ? 2600 : 1000;
      let g = 3.5 * r.sigma + 2 * tr.sigma + 120 + (tr.hits < 2 ? vmax * dtp : 60 * Math.min(dtp, 15));
      // A second report from the same sensor in the same scan must be a much closer fit.
      const same = tr.sources.get(r.sensor);
      if (same !== undefined && r.t - same < 0.3) g = 2 * r.sigma + 50;
      const cost = d / g;
      if (cost < bestCost) {
        bestCost = cost;
        best = tr;
      }
    }
    void w;
    return best;
  }

  /** Kalman update, decoupled per axis, with white-acceleration process noise. */
  private update(tr: Track, r: Report): void {
    const dtp = Math.max(0, r.t - tr.t);
    const pred = tr.predict(r.t);
    const vp = tr.velAt(r.t);
    const q = tr.ballistic ? 20 : 50;
    const m = [r.pos.x, r.pos.y, r.pos.z];
    const p = [pred.x, pred.y, pred.z];
    const v = [vp.x, vp.y, vp.z];
    for (let i = 0; i < 3; i++) {
      const c = tr.cov[i];
      // Predict.
      const pp = c[0] + 2 * dtp * c[1] + dtp * dtp * c[2] + (q * dtp * dtp * dtp) / 3;
      const pv = c[1] + dtp * c[2] + (q * dtp * dtp) / 2;
      const vv = c[2] + q * dtp;
      // Update.
      const R = i < 2 ? r.sigmaH * r.sigmaH : r.sigmaZ * r.sigmaZ;
      const S = pp + R;
      const kp = pp / S;
      const kv = pv / S;
      const res = m[i] - p[i];
      p[i] += kp * res;
      v[i] += kv * res;
      c[0] = (1 - kp) * pp;
      c[1] = (1 - kp) * pv;
      c[2] = Math.max(vv - kv * pv, 1);
    }
    tr.pos = v3(p[0], p[1], p[2]);
    tr.vel = v3(v[0], v[1], v[2]);
    tr.t = Math.max(tr.t, r.t);
    tr.sigma = clamp(Math.sqrt(tr.cov[0][0] + tr.cov[1][0] + tr.cov[2][0]), 5, 20000);
    tr.velSigma = Math.sqrt(tr.cov[0][2] + tr.cov[1][2] + tr.cov[2][2]);
    tr.hits++;
    tr.sources.set(r.sensor, r.t);
    if (r.iff === 'M5') tr.iffM5++;
    else if (r.iff === 'M3C') tr.iffM3++;
    else if (r.iff === 'NONE') tr.iffNone++;
    if (r.iff !== null) tr.squawk = lerp(tr.squawk, r.iff === 'M3C' ? 1 : 0, 0.25);
    tr.rcsDb = tr.hits === 2 ? toDb(r.rcs) : lerp(tr.rcsDb, toDb(r.rcs), 0.12);
    if (!tr.confirmed && tr.hits >= 3) tr.confirmed = true;
  }

  private create(r: Report): Track {
    const tr = new Track(this.nextNum++, r.pos, r.t, r.sigma, r.sigmaH, r.sigmaZ);
    tr.sources.set(r.sensor, r.t);
    tr.rcsDb = toDb(r.rcs);
    if (r.iff === 'M5') tr.iffM5++;
    else if (r.iff === 'M3C') tr.iffM3++;
    else if (r.iff === 'NONE') tr.iffNone++;
    this.tracks.push(tr);
    return tr;
  }

  process(w: World, reports: Report[]): void {
    for (const r of reports) {
      const tr = this.associate(w, r);
      if (tr) this.update(tr, r);
      else this.create(r);
    }
    if (w.t >= this.nextJam) {
      this.nextJam = w.t + 1;
      this.triangulate(w);
    }
    if (w.t >= this.nextHousekeeping) {
      this.nextHousekeeping = w.t + 0.5;
      this.housekeeping(w);
    }
  }

  private housekeeping(w: World): void {
    for (const tr of this.tracks) {
      const age = w.t - tr.t;
      const coast = tr.jam ? 20 : tr.confirmed ? 14 : 8;
      if (age > coast) tr.dropped = true;
      tr.recordTrail(w.t);
      this.classify(w, tr);
    }
    // Merge duplicate tracks (e.g. one target seen by two radars with a bias).
    const live = this.tracks.filter((t) => !t.dropped && t.confirmed);
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i];
        const b = live[j];
        if (a.dropped || b.dropped || a.jam !== b.jam || a.skin !== b.skin) continue;
        const pa = a.predict(w.t);
        const pb = b.predict(w.t);
        const gate = a.jam ? 15000 : Math.max(300, 2 * (a.sigma + b.sigma));
        if (dist(pa, pb) < gate && len(sub(a.vel, b.vel)) < (a.jam ? 400 : 80)) {
          const [keep, gone] = a.born <= b.born ? [a, b] : [b, a];
          this.mergeInto(w, keep, gone);
        }
      }
    }
    // A skin track that coincides with a triangulated jammer becomes the jammer. Friends and civil
    // traffic are never correlated: a CAP fighter pressing the jammer must not inherit its identity.
    for (const jt of live.filter((t) => t.jam && !t.skin && !t.dropped)) {
      let best: Track | null = null;
      let bd = clamp(jt.sigma * 2, 5000, 12000);
      for (const st of live) {
        if (!st.skin || st.dropped || st.jam || st.cls === 'CIV' || st.ident === 'FRD' || st.ident === 'NEU' || st.iffM5 > 0 || st.iffM3 > 0) continue;
        const d = hdist(st.predict(w.t), jt.predict(w.t));
        if (d < bd) {
          bd = d;
          best = st;
        }
      }
      if (best) {
        best.jam = true;
        this.mergeInto(w, best, jt);
        w.log(`${best.label} correlated with jam strobes: jammer skin-tracked`, 'alert');
      }
    }
    for (const tr of this.tracks) if (tr.dropped) w.onTrackDropped(tr);
    for (let i = this.tracks.length - 1; i >= 0; i--) if (this.tracks[i].dropped) this.tracks.splice(i, 1);
  }

  private mergeInto(w: World, keep: Track, gone: Track): void {
    for (const [k, v] of gone.sources) keep.sources.set(k, Math.max(v, keep.sources.get(k) ?? 0));
    keep.iffM5 += gone.iffM5;
    keep.iffM3 += gone.iffM3;
    keep.iffNone += gone.iffNone;
    keep.hostileAct ||= gone.hostileAct;
    keep.manual ??= gone.manual;
    keep.kaUntil = Math.max(keep.kaUntil, gone.kaUntil);
    if (gone.t > keep.t && !gone.jam) {
      keep.pos = gone.predict(gone.t);
      keep.t = gone.t;
    }
    gone.dropped = true;
    w.remapTrack(gone.id, keep.id);
  }

  private classify(w: World, tr: Track): void {
    const spd = tr.speed;
    // Speeds the track is confidently above / below (2 sigma).
    const lo = spd - 2 * tr.velSigma;
    const hi = spd + 2 * tr.velSigma;
    const alt = tr.pos.z;
    const agl = alt - w.terrain.groundAt(tr.pos.x, tr.pos.y);
    let cls: TrackClass;
    if (tr.jam) cls = 'JAM';
    else if (tr.hits < 4) cls = 'UNK';
    else if (tr.hits >= 6 && w.t - tr.born > 2.5 && (lo > 1300 || (alt > 22000 && lo > 600))) cls = 'TBM';
    else if (tr.hits >= 6 && w.t - tr.born > 2.5 && lo > 520) cls = 'MSL';
    else if (hi > 520) cls = tr.cls === 'TBM' || tr.cls === 'MSL' ? tr.cls : 'UNK';
    // Slow, low and big on radar: a helicopter, not a drone.
    else if (spd < 100 && agl < 300 && tr.rcsDb > 3) cls = 'RW';
    // Nothing with wings flies below ~75 m/s: slower than that is a drone, low (attack) or high (recon).
    else if (spd < 75 && hi < 140) cls = 'UAV';
    else if (agl < 350 && spd > 150 && tr.velSigma < 80 && tr.rcsDb < -6) cls = 'CM';
    // A small object descending steadily at speed is a guided munition (glide bomb, cruise missile in its dive).
    else if (spd > 150 && tr.velSigma < 80 && tr.rcsDb < -6 && tr.vel.z < -25) cls = 'CM';
    else if (tr.iffM3 >= 2 && alt > 6000 && lo > 150 && hi < 320) cls = 'CIV';
    else if (lo > 75 && tr.velSigma < 60) cls = 'FW';
    else cls = tr.cls;
    if (cls !== tr.cls && tr.confirmed && tr.cls !== 'UNK' && (cls === 'TBM' || cls === 'MSL' || cls === 'CM')) {
      w.log(`${tr.label} reclassified ${cls}`, 'alert');
    }
    tr.cls = cls;
    tr.ballistic = cls === 'TBM';

    let id: Ident;
    if (tr.manual) id = tr.manual;
    else if (tr.iffM5 >= 2 && tr.iffM5 >= 0.3 * (tr.iffM5 + tr.iffNone)) id = 'FRD';
    // Squawking civil Mode 3/C now: after a track swap, a hostile act seen earlier no longer applies.
    else if (!tr.jam && tr.squawk > 0.6 && tr.hits > 8 && (cls === 'CIV' || cls === 'FW' || cls === 'UNK')) {
      id = 'NEU';
      tr.hostileAct = false;
    }
    else if (cls === 'FW' && !tr.hostileAct && tr.iffNone >= 3 && agl < 400 && lo > 200 && inbound(tr, 45000)) {
      // Criteria-based ID: a fast jet with no IFF running in at low level towards our sites is treated as hostile.
      tr.hostileAct = true;
      id = 'HOS';
      w.log(`${tr.label} low-level fast mover inbound, no IFF: declared hostile`, 'alert');
    }
    else if (tr.jam || tr.hostileAct || cls === 'TBM' || cls === 'MSL' || cls === 'CM' || cls === 'UAV' || cls === 'RW') id = 'HOS';
    else if (cls === 'CIV') id = 'NEU';
    else if (tr.iffNone >= 3) id = 'SUS';
    else id = 'PEND';
    if (id !== tr.ident && tr.confirmed && id === 'HOS') w.log(`${tr.label} identified HOSTILE (${cls})`, 'alert');
    tr.ident = id;
  }

  /** Mark the track at a launching platform as having committed a hostile act. */
  markHostileAct(w: World, p: V3): void {
    const near: Track[] = [];
    for (const tr of this.tracks) {
      if (!tr.confirmed || tr.dropped || w.t - tr.t > 8) continue;
      if (dist(tr.predict(w.t), p) < Math.max(2500, 3 * tr.sigma)) near.push(tr);
    }
    if (!near.length) return;
    // A formation flying together shares the blame; two unrelated tracks crossing cannot be told apart.
    const v0 = near[0].velAt(w.t);
    if (near.some((tr) => dist(tr.velAt(w.t), v0) > 80)) {
      w.log('Weapon launch observed between crossing tracks, launcher ambiguous', 'alert');
      return;
    }
    for (const tr of near) {
      if (tr.hostileAct) continue;
      tr.hostileAct = true;
      w.log(`${tr.label} observed launching a weapon`, 'alert');
    }
  }

  /** Cross-fix jam strobes from pairs of separated sensors into jammer position tracks. */
  private triangulate(w: World): void {
    const strobes: Strobe[] = [];
    for (const r of w.allRadars()) strobes.push(...r.strobes);
    const fixes: { p: V3; s: number }[] = [];
    for (let i = 0; i < strobes.length; i++) {
      for (let j = i + 1; j < strobes.length; j++) {
        const a = strobes[i];
        const b = strobes[j];
        if (a.sensor === b.sensor || hdist(a.origin, b.origin) < 2000) continue;
        const fix = intersect(a, b);
        // Poor crossing geometry gives fixes that are tens of km out in range: only use good ones.
        if (!fix || fix.s > 12000) continue;
        // Inside burn-through range a real jammer would also give a skin return, so a close-in
        // strobe crossing with no skin track is a ghost from two different jammers.
        if (Math.min(hdist(a.origin, fix.p), hdist(b.origin, fix.p)) < BURN_THROUGH_M) continue;
        if (!isGhost(fix, a, b, strobes)) fixes.push(fix);
      }
    }
    for (const f of fixes) {
      const skinJam = this.tracks.find((t) => t.jam && t.skin && !t.dropped && hdist(t.predict(w.t), f.p) < Math.max(20000, f.s * 3));
      if (skinJam) {
        skinJam.sources.set('ESM', w.t);
        continue;
      }
      let best: Track | null = null;
      let bd = Math.max(20000, f.s * 3);
      for (const tr of this.tracks) {
        if (tr.skin || tr.dropped) continue;
        const d = hdist(tr.predict(w.t), f.p);
        if (d < bd) {
          bd = d;
          best = tr;
        }
      }
      if (best) {
        const dtp = w.t - best.t;
        const pred = best.predict(w.t);
        const res = sub(f.p, pred);
        res.z = 0;
        best.pos = addScaled(pred, res, 0.3);
        if (dtp > 0.5) best.vel = addScaled(best.vel, res, 0.05 / dtp);
        best.vel.z = 0;
        if (len(best.vel) > 350) best.vel = v3(best.vel.x * 0.5, best.vel.y * 0.5, 0);
        best.t = w.t;
        best.sigma = lerp(best.sigma, f.s, 0.3);
        best.hits++;
        best.confirmed = best.hits >= 2;
        best.sources.set('ESM', w.t);
      } else {
        const tr = new Track(this.nextNum++, f.p, w.t, f.s);
        tr.jam = true;
        tr.skin = false;
        tr.cls = 'JAM';
        tr.ident = 'HOS';
        tr.sources.set('ESM', w.t);
        this.tracks.push(tr);
        w.log(`${tr.label} jammer located by strobe triangulation`, 'alert');
      }
    }
  }
}

/** Closest range at which a noise jammer is still heard but not seen by the fire-control radars. */
const BURN_THROUGH_M = 40000;

/**
 * With several jammers, strobes from two sensors also cross where there is no jammer (ghosts).
 * A third sensor that hears jamming in that direction but has no strobe through the fix rules it out.
 */
function isGhost(f: { p: V3; s: number }, a: Strobe, b: Strobe, strobes: Strobe[]): boolean {
  let contradicted = false;
  for (const c of strobes) {
    if (c.sensor === a.sensor || c.sensor === b.sensor) continue;
    if (hdist(c.origin, a.origin) < 2000 || hdist(c.origin, b.origin) < 2000) continue;
    const R = hdist(c.origin, f.p);
    const brg = bearingDeg(c.origin, f.p);
    const off = Math.abs(wrap180(c.az - brg));
    const tol = 3 * c.sigmaDeg + Math.atan2(f.s, R) / DEG + 0.5;
    if (off < tol) return false;
    if (off < 25) contradicted = true;
  }
  return contradicted;
}

function intersect(a: Strobe, b: Strobe): { p: V3; s: number } | null {
  const da = { x: Math.sin(a.az * DEG), y: Math.cos(a.az * DEG) };
  const db = { x: Math.sin(b.az * DEG), y: Math.cos(b.az * DEG) };
  const den = da.x * db.y - da.y * db.x;
  const sinAng = Math.abs(den);
  if (sinAng < Math.sin(3 * DEG)) return null;
  const ox = b.origin.x - a.origin.x;
  const oy = b.origin.y - a.origin.y;
  const ta = (ox * db.y - oy * db.x) / den;
  const tb = (ox * da.y - oy * da.x) / den;
  if (ta < 5000 || tb < 5000 || ta > 320000 || tb > 320000) return null;
  const p = v3(a.origin.x + da.x * ta, a.origin.y + da.y * ta, 9000);
  // Position error of a two-bearing fix: each bearing error displaces the fix along the other line.
  const s = Math.hypot(ta * a.sigmaDeg * DEG, tb * b.sigmaDeg * DEG) / sinAng;
  return { p, s };
}

/** Within `rangeM` of the airbase and heading roughly towards it. */
function inbound(tr: Track, rangeM: number): boolean {
  const R = Math.hypot(tr.pos.x, tr.pos.y);
  if (R > rangeM) return false;
  const vh = Math.hypot(tr.vel.x, tr.vel.y);
  return vh > 1 && -(tr.pos.x * tr.vel.x + tr.pos.y * tr.vel.y) / (R * vh) > 0.7;
}
