import { DEG, G, toDb } from './constants';
import { V3, addScaled, clamp, clone, dist, hdist, len, lerp, sub, v3 } from './math';
import type { Report, Strobe } from './radar';
import type { World } from './world';

export type TrackClass = 'UNK' | 'FW' | 'CIV' | 'UAV' | 'CM' | 'MSL' | 'TBM' | 'JAM';
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
  readonly sources = new Map<string, number>();
  iffM5 = 0;
  iffM3 = 0;
  iffNone = 0;
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

  constructor(id: number, pos: V3, t: number, sigma: number) {
    this.id = id;
    this.label = `T${String(id).padStart(3, '0')}`;
    this.pos = clone(pos);
    this.t = t;
    this.born = t;
    this.sigma = sigma;
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

  private update(tr: Track, r: Report): void {
    const dtp = r.t - tr.t;
    const pred = tr.predict(r.t);
    const sp = tr.sigma + 15 * Math.max(0, dtp);
    if (dtp < 0.05) {
      tr.pos = v3(lerp(pred.x, r.pos.x, 0.35), lerp(pred.y, r.pos.y, 0.35), lerp(pred.z, r.pos.z, 0.35));
    } else if (tr.hits === 1) {
      tr.vel = sub(r.pos, tr.pos);
      tr.vel.x /= dtp;
      tr.vel.y /= dtp;
      tr.vel.z /= dtp;
      tr.pos = clone(r.pos);
      tr.t = r.t;
    } else {
      const k = Math.min(tr.hits, 30);
      const wq = clamp((1.5 * sp * sp) / (sp * sp + r.sigma * r.sigma), 0.15, 1);
      const a = Math.max(0.3, (2 * (2 * k - 1)) / (k * (k + 1))) * wq;
      const b = Math.max(0.06, 6 / (k * (k + 1))) * wq;
      const res = sub(r.pos, pred);
      const v = tr.velAt(r.t);
      tr.pos = addScaled(pred, res, a);
      tr.vel = addScaled(v, res, b / dtp);
      tr.t = r.t;
    }
    tr.sigma = clamp(1.3 / Math.sqrt(1 / (sp * sp) + 1 / (r.sigma * r.sigma)), 5, 20000);
    tr.hits++;
    tr.sources.set(r.sensor, r.t);
    if (r.iff === 'M5') tr.iffM5++;
    else if (r.iff === 'M3C') tr.iffM3++;
    else if (r.iff === 'NONE') tr.iffNone++;
    tr.rcsDb = tr.hits === 2 ? toDb(r.rcs) : lerp(tr.rcsDb, toDb(r.rcs), 0.12);
    if (!tr.confirmed && tr.hits >= 3) tr.confirmed = true;
  }

  private create(r: Report): Track {
    const tr = new Track(this.nextNum++, r.pos, r.t, r.sigma);
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
    // A skin track that coincides with a triangulated jammer becomes the jammer.
    for (const jt of live.filter((t) => t.jam && !t.skin && !t.dropped)) {
      for (const st of live) {
        if (!st.skin || st.dropped || st.cls === 'CIV') continue;
        if (hdist(st.predict(w.t), jt.predict(w.t)) < Math.max(8000, jt.sigma * 2)) {
          st.jam = true;
          this.mergeInto(w, st, jt);
          w.log(`${st.label} correlated with jam strobes: jammer skin-tracked`, 'alert');
          break;
        }
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
    const alt = tr.pos.z;
    const agl = alt - w.terrain.groundAt(tr.pos.x, tr.pos.y);
    let cls: TrackClass;
    if (tr.jam) cls = 'JAM';
    else if (tr.hits < 4) cls = 'UNK';
    else if (spd > 1300 || (alt > 22000 && spd > 600)) cls = 'TBM';
    else if (spd > 520) cls = 'MSL';
    else if (spd < 85 && alt < 6000) cls = 'UAV';
    else if (agl < 350 && spd > 150 && tr.rcsDb < -6) cls = 'CM';
    else if (tr.iffM3 >= 2 && alt > 6000 && spd > 170 && spd < 300) cls = 'CIV';
    else cls = 'FW';
    if (cls !== tr.cls && tr.confirmed && tr.cls !== 'UNK' && (cls === 'TBM' || cls === 'MSL' || cls === 'CM')) {
      w.log(`${tr.label} reclassified ${cls}`, 'alert');
    }
    tr.cls = cls;
    tr.ballistic = cls === 'TBM';

    let id: Ident;
    if (tr.manual) id = tr.manual;
    else if (tr.iffM5 >= 2 && tr.iffM5 >= 0.3 * (tr.iffM5 + tr.iffNone)) id = 'FRD';
    else if (tr.jam || tr.hostileAct || cls === 'TBM' || cls === 'MSL' || cls === 'CM' || cls === 'UAV') id = 'HOS';
    else if (cls === 'CIV') id = 'NEU';
    else if (tr.iffNone >= 3) id = 'SUS';
    else id = 'PEND';
    if (id !== tr.ident && tr.confirmed && id === 'HOS') w.log(`${tr.label} identified HOSTILE (${cls})`, 'alert');
    tr.ident = id;
  }

  /** Mark the track nearest to a launching platform as having committed a hostile act. */
  markHostileAct(w: World, p: V3): void {
    let best: Track | null = null;
    let bd = 6000;
    for (const tr of this.tracks) {
      if (!tr.confirmed || tr.dropped || w.t - tr.t > 8) continue;
      const d = dist(tr.predict(w.t), p);
      if (d < bd) {
        bd = d;
        best = tr;
      }
    }
    if (best && !best.hostileAct) {
      best.hostileAct = true;
      w.log(`${best.label} observed launching a weapon`, 'alert');
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
        if (fix) fixes.push(fix);
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
  const s = (Math.max(ta, tb) * 0.4 * DEG) / sinAng;
  return { p, s };
}
