import { V3, clone, dist } from './math';
import type { Emitter } from './entities';
import { Interceptor, MissileSpec } from './missile';
import type { Radar } from './radar';
import type { Track } from './tracker';
import type { World } from './world';

export type SiteKind = 'asset' | 'radar' | 'launcher' | 'ciws' | 'gnss' | 'decoy' | 'jammer';

/** A ground object that can be damaged: a defended asset or a piece of air defence equipment. */
export class Site {
  readonly name: string;
  readonly kind: SiteKind;
  readonly pos: V3;
  readonly radius: number;
  readonly defended: boolean;
  hp = 100;
  /** Damage multiplier: area targets like an airbase need several hits. */
  vuln = 1;
  alive = true;
  /** A town on the campaign front line, or the day's assault force (both are defended assets). */
  role?: 'town' | 'assault';
  onDestroyed: (() => void) | null = null;

  constructor(name: string, kind: SiteKind, pos: V3, radius: number, defended = false) {
    this.name = name;
    this.kind = kind;
    this.pos = clone(pos);
    this.radius = radius;
    this.defended = defended;
  }

  damage(w: World, amount: number, by: string): void {
    if (!this.alive) return;
    const before = this.hp;
    this.hp = Math.max(0, this.hp - amount * this.vuln);
    w.noteHurt(by, before - this.hp, this.name);
    w.log(`${this.name} hit by ${by} (${Math.round(this.hp)}% remaining)`, 'damage');
    if (this.hp <= 0) {
      this.alive = false;
      w.log(`${this.name} DESTROYED`, 'damage');
      this.onDestroyed?.();
    }
  }
}

/** Emitter that mimics the LR radar's signature to draw anti-radiation missiles. */
export class Decoy implements Emitter {
  readonly name: string;
  readonly signature = 'LR' as const;
  readonly site: Site;
  on = false;
  /** Packed up for a move. */
  stowed = false;

  constructor(site: Site) {
    this.site = site;
    this.name = site.name;
  }

  get pos(): V3 {
    return this.site.pos;
  }

  get alive(): boolean {
    return this.site.alive;
  }

  isEmitting(): boolean {
    return this.site.alive && this.on && !this.stowed;
  }
}

/**
 * Our EW jammer truck: noise-jams enemy aircraft sensors within 90 km (line of sight). SEAD fighters there can
 * only find radars close by, strike aircraft release their weapons less accurately and recon drones take no
 * pictures. It is loud, so SEAD can home on it.
 */
export class EwJammer implements Emitter {
  readonly name: string;
  readonly signature = 'JAM' as const;
  readonly site: Site;
  readonly rangeM = 90000;
  on = false;
  /** Packed up for a move. */
  stowed = false;

  constructor(site: Site) {
    this.site = site;
    this.name = site.name;
  }

  get pos(): V3 {
    return this.site.pos;
  }

  get alive(): boolean {
    return this.site.alive;
  }

  isEmitting(): boolean {
    return this.site.alive && this.on && !this.stowed;
  }
}

/** Ground GNSS jammer: degrades navigation of GNSS-dependent threats inside its radius (with line of sight). */
export class GnssJammer {
  readonly site: Site;
  readonly rangeM = 30000;
  on = false;
  /** Packed up for a move. */
  stowed = false;

  constructor(site: Site) {
    this.site = site;
  }

  get active(): boolean {
    return this.on && this.site.alive && !this.stowed;
  }
}

export interface Launcher {
  site: Site;
  rounds: number;
  max: number;
  reloadAt: number;
}

export interface Feasibility {
  ok: boolean;
  reason: string;
  pip?: V3;
  tof?: number;
  rangeM?: number;
}

const no = (reason: string): Feasibility => ({ ok: false, reason });

/** A SAM fire unit: its own radar (if any), launchers and fire channels. */
export class FireUnit {
  readonly type: 'LR' | 'MR' | 'SH';
  /** Unique code, also the code of the unit's radar (LR, LR2, MR, ...). */
  readonly code: string;
  readonly name: string;
  /** Campaign unit id. */
  readonly uid: number;
  readonly spec: MissileSpec;
  readonly radar: Radar | null;
  readonly launchers: Launcher[];
  readonly channels: number;
  readonly reloadS: number;
  /** MR can fire on any fused track; LR (TVM) and SHORAD (command guidance) need their own radar. */
  readonly remote: boolean;
  /** Spare missiles held at the battery for reloading launchers. */
  spares = Infinity;
  /** Hold fire: no automatic engagements. Direct orders from the player still fire. */
  hold = false;
  /** Packed up or on the move: cannot fire. */
  stowed = false;
  /** Missiles launched this battle (each one gives the battery's position away a little more). */
  launched = 0;
  /** Crew rank (0 = Green): each rank gives a missile that misses a second chance to kill. */
  rank = 0;
  private queue: { t: number; trackId: number; manual: boolean }[] = [];

  constructor(
    type: 'LR' | 'MR' | 'SH',
    code: string,
    uid: number,
    name: string,
    spec: MissileSpec,
    radar: Radar | null,
    launchers: Launcher[],
    channels: number,
    reloadS: number,
    remote: boolean,
  ) {
    this.type = type;
    this.code = code;
    this.uid = uid;
    this.name = name;
    this.spec = spec;
    this.radar = radar;
    this.launchers = launchers;
    this.channels = channels;
    this.reloadS = reloadS;
    this.remote = remote;
  }

  get rounds(): number {
    return this.launchers.reduce((s, l) => s + (l.site.alive ? l.rounds : 0), 0);
  }

  get maxRounds(): number {
    return this.launchers.reduce((s, l) => s + l.max, 0);
  }

  activeTargets(w: World): Set<number> {
    const s = new Set<number>();
    for (const m of w.missiles) if (m.alive && m.fu === this) s.add(m.trackId);
    for (const q of this.queue) s.add(q.trackId);
    return s;
  }

  /**
   * Earliest predicted intercept point from `from`: the first time along the target's predicted path
   * (below the missile ceiling and before a ballistic target lands) that the missile can reach in time.
   * Returns tof = Infinity when there is no intercept inside the missile's time of flight.
   */
  pip(w: World, tr: Track, from: V3): { pip: V3; tof: number } {
    const s = this.spec;
    const late = (tau: number): number => dist(from, tr.predict(w.t + tau)) / s.avgSpd - tau;
    let prev = -1;
    for (let tau = 0; tau <= s.maxTof; tau += 0.5) {
      const p = tr.predict(w.t + tau);
      if (tr.ballistic && p.z < w.terrain.groundAt(p.x, p.y)) break;
      if (p.z > s.maxAltM) {
        prev = -1;
        continue;
      }
      if (late(tau) <= 0) {
        // Refine between the last sample that was too late and this one.
        let lo = prev < 0 ? tau : prev;
        let hi = tau;
        for (let i = 0; i < 8 && hi - lo > 0.02; i++) {
          const mid = (lo + hi) / 2;
          if (late(mid) <= 0) hi = mid;
          else lo = mid;
        }
        return { pip: tr.predict(w.t + hi), tof: hi };
      }
      prev = tau;
    }
    return { pip: tr.predict(w.t), tof: Infinity };
  }

  feasibility(w: World, tr: Track): Feasibility {
    const s = this.spec;
    if (this.stowed) return no('packed up to move');
    if (this.radar && !this.radar.alive && !this.remote) return no('radar destroyed');
    if (this.radar && !this.remote && !this.radar.emitting) return no('radar in EMCON');
    const ready = this.launchers.filter((l) => l.site.alive && l.rounds > 0);
    if (!ready.length) return no('no missiles ready');
    if (!tr.confirmed) return no('track not firm');
    if (w.t - tr.t > (this.remote ? 5 : 3)) return no('track stale');
    if (tr.cls === 'TBM' && !s.tbmRangeM) return no('not TBM capable');
    if (!tr.skin && tr.sigma > 3000) return no(`jammer fix too coarse (${(tr.sigma / 1000).toFixed(0)} km)`);
    if (!tr.skin && tr.hits < 8) return no('jammer fix not yet confirmed');
    if (this.type === 'LR') {
      const lr = tr.sources.get(this.code) ?? -1e9;
      const esm = tr.sources.get('ESM') ?? -1e9;
      if (w.t - lr > 4 && !(tr.jam && w.t - esm < 4)) return no('LR radar not tracking');
    }
    if (this.type === 'SH' && this.radar && !w.terrain.los(this.radar.pos, tr.predict(w.t))) return no('no tracker line of sight');
    const active = this.activeTargets(w);
    if (!active.has(tr.id) && active.size >= this.channels) return no('all fire channels busy');
    let best = ready[0];
    for (const l of ready) if (dist(l.site.pos, tr.pos) < dist(best.site.pos, tr.pos)) best = l;
    const { pip, tof } = this.pip(w, tr, best.site.pos);
    const range = dist(best.site.pos, pip);
    const maxR = tr.cls === 'TBM' ? s.tbmRangeM : s.maxRangeM;
    if (!Number.isFinite(tof)) {
      if (range > maxR) return no(`out of range (${(range / 1000).toFixed(0)} km)`);
      return no(pip.z > s.maxAltM ? 'above ceiling' : 'cannot catch target');
    }
    if (tof > s.maxTof * 0.85) return no('cannot catch target');
    if (range > maxR) return no(`out of range (${(range / 1000).toFixed(0)} km)`);
    if (range < s.minRangeM) return no('inside minimum range');
    if (pip.z > s.maxAltM) return no('above ceiling');
    if (tr.cls === 'TBM' && pip.z < 3000) return no('too late for TBM intercept');
    return { ok: true, reason: `PIP ${(range / 1000).toFixed(1)} km, TOF ${tof.toFixed(0)} s`, pip, tof, rangeM: range };
  }

  fire(w: World, tr: Track, salvo: number, manual = false): boolean {
    const f = this.feasibility(w, tr);
    if (!f.ok) return false;
    const n = Math.min(salvo, this.rounds);
    for (let i = 0; i < n; i++) this.queue.push({ t: w.t + i * 1.2, trackId: tr.id, manual });
    w.log(`${this.name} engaging ${tr.label} (${tr.cls}) with ${n}: ${f.reason}`, 'engage');
    return true;
  }

  /** Pack up for a move (cancelling queued launches) or come back into action. */
  stow(stowed: boolean): void {
    this.stowed = stowed;
    if (stowed) this.queue = [];
  }

  /** Toggle hold fire; going to hold cancels launches that are queued but not yet away. */
  setHold(w: World, hold: boolean): void {
    this.hold = hold;
    if (hold) this.queue = this.queue.filter((q) => q.manual);
    w.log(`${this.name} ${hold ? 'HOLD FIRE' : 'weapons free to engage automatically'}`, 'info');
  }

  remap(from: number, to: number): void {
    for (const q of this.queue) if (q.trackId === from) q.trackId = to;
  }

  update(w: World): void {
    for (const l of this.launchers) {
      if (l.reloadAt > 0 && w.t >= l.reloadAt && l.site.alive) {
        const n = Math.min(l.max - l.rounds, this.spares);
        l.rounds += n;
        this.spares -= n;
        l.reloadAt = 0;
        if (n > 0) w.log(`${this.name} launcher reloaded${Number.isFinite(this.spares) ? ` (${this.spares} spares left)` : ''}`, 'info');
      }
    }
    while (this.queue.length && this.queue[0].t <= w.t) {
      const q = this.queue.shift()!;
      const tr = w.tracker.get(q.trackId);
      if (!tr) continue;
      const ready = this.launchers.filter((l) => l.site.alive && l.rounds > 0);
      if (!ready.length) continue;
      let l = ready[0];
      for (const c of ready) if (dist(c.site.pos, tr.pos) < dist(l.site.pos, tr.pos)) l = c;
      const { pip } = this.pip(w, tr, l.site.pos);
      l.rounds--;
      // The reload crew starts on a launcher as soon as it has fired.
      if (l.reloadAt === 0 && this.spares > 0) l.reloadAt = w.t + this.reloadS;
      const from = clone(l.site.pos);
      from.z += 4;
      w.missiles.push(new Interceptor(w, this.spec, this, this.name, from, pip, null, tr.id));
      w.stats.fired[this.type]++;
      this.launched++;
      w.stats.costM += this.spec.costM;
    }
  }
}
