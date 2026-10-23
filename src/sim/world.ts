import { DT } from './constants';
import { Ciws } from './ciws';
import { Arm, Cruise, Emitter, Entity } from './entities';
import { Fighter } from './fighter';
import { V3, add, clone, dist, norm, scale, sub, v3 } from './math';
import { Interceptor, LR_MSL, MR_MSL, SH_MSL } from './missile';
import { CIWS_RADAR, LR_RADAR, MR_RADAR, Radar, Report, SH_RADAR } from './radar';
import { Rng } from './rng';
import { Scenario } from './scenario';
import { Decoy, FireUnit, GnssJammer, Launcher, Site, SiteKind } from './sites';
import { Terrain } from './terrain';
import { Wcs, autoEngage } from './tewa';
import { valleyRoute } from './threats';
import { Ident, Track, Tracker } from './tracker';

export type LogLevel = 'info' | 'alert' | 'engage' | 'kill' | 'damage' | 'raid';

export interface LogEntry {
  t: number;
  msg: string;
  level: LogLevel;
}

export interface Effect {
  id: number;
  pos: V3;
  t0: number;
  kind: 'small' | 'blast' | 'big' | 'ground';
}

export interface Stats {
  fired: { LR: number; MR: number; SH: number; AAM: number };
  ciwsRounds: number;
  costM: number;
  kills: number;
  leakers: number;
  fratricide: number;
  civilian: number;
}

/** The whole simulation. Stepped at a fixed 60 Hz; all randomness comes from one seeded stream. */
export class World {
  t = 0;
  readonly seed: number;
  readonly rng: Rng;
  readonly terrain: Terrain;
  entities: Entity[] = [];
  missiles: Interceptor[] = [];
  readonly sites: Site[] = [];
  readonly radars: Radar[] = [];
  readonly units: FireUnit[] = [];
  readonly ciws: Ciws[] = [];
  readonly fighters: Fighter[] = [];
  readonly gnss: GnssJammer;
  readonly decoy: Decoy;
  readonly tracker = new Tracker();
  readonly scenario = new Scenario();
  wcs: Wcs = 'TIGHT';
  readonly logEntries: LogEntry[] = [];
  /** Total log entries ever written (the list itself is capped). */
  logSeq = 0;
  effects: Effect[] = [];
  readonly stats: Stats = {
    fired: { LR: 0, MR: 0, SH: 0, AAM: 0 },
    ciwsRounds: 0,
    costM: 0,
    kills: 0,
    leakers: 0,
    fratricide: 0,
    civilian: 0,
  };
  /** Track id remaps from fusion merges, so the UI can follow a selected track. */
  readonly remapped = new Map<number, number>();
  private readonly byId = new Map<number, Entity>();
  private pending: { t: number; e: Entity }[] = [];
  private jammerCache: Entity[] = [];
  private nextEffect = 1;
  private nextTewa = 0;
  private nextGnss = 0;
  private readonly names = new Map<string, number>();

  constructor(seed = 20261023) {
    this.seed = seed;
    this.rng = new Rng(seed);
    this.terrain = new Terrain(seed);
    this.layout();
    this.gnss = new GnssJammer(this.addSite('GNSS jammer', 'gnss', 0, 2500, 15, 8));
    this.decoy = new Decoy(this.addSite('Radar decoy', 'decoy', 4800, 8600, 8, 10));
    this.scenario.start(this);
  }

  // ---------------------------------------------------------------- set-up

  private addSite(name: string, kind: SiteKind, x: number, y: number, mast: number, radius: number, defended = false): Site {
    const s = new Site(name, kind, v3(x, y, this.terrain.groundAt(x, y) + mast), radius, defended);
    this.sites.push(s);
    return s;
  }

  private addRadar(code: string, name: string, spec: typeof LR_RADAR, site: Site, sig: Emitter['signature']): Radar {
    const r = new Radar(code, name, spec, site.pos, sig);
    r.az = this.rng.range(0, 360);
    site.onDestroyed = () => {
      r.alive = false;
    };
    this.radars.push(r);
    return r;
  }

  private launchers(prefix: string, pts: [number, number][], rounds: number): Launcher[] {
    return pts.map(([x, y], i) => {
      const site = this.addSite(`${prefix} launcher ${i + 1}`, 'launcher', x, y, 2, 6);
      const l: Launcher = { site, rounds, max: rounds, reloadAt: 0 };
      site.onDestroyed = () => {
        l.rounds = 0;
      };
      return l;
    });
  }

  private layout(): void {
    this.addSite('Airbase', 'asset', 0, 0, 0, 320, true);
    this.addSite('CRC', 'asset', -4200, -3600, 0, 40, true);
    this.addSite('Power plant', 'asset', 6500, -9000, 0, 160, true);

    const lrSite = this.addSite('LR radar', 'radar', 2500, 7000, 8, 12);
    const lr = this.addRadar('LR', 'LR SAM radar', LR_RADAR, lrSite, 'LR');
    lr.boresight = 0;
    this.units.push(
      new FireUnit('LR', 'LR SAM', LR_MSL, lr, this.launchers('LR', [[1700, 6300], [3400, 6200], [2000, 7900], [3200, 7800]], 4), 9, 600, false),
    );

    const mrSite = this.addSite('MR radar', 'radar', -9000, 9000, 12, 10);
    const mr = this.addRadar('MR', 'MR SAM radar', MR_RADAR, mrSite, 'MR');
    this.units.push(
      new FireUnit('MR', 'MR SAM', MR_MSL, mr, this.launchers('MR', [[-7500, 7000], [-3000, 2600], [-11000, 10500]], 6), 8, 300, true),
    );

    const shSite = this.addSite('SHORAD', 'radar', 1500, -1600, 6, 8);
    const sh = this.addRadar('SH', 'SHORAD radar', SH_RADAR, shSite, 'SH');
    const shLauncher: Launcher = { site: shSite, rounds: 8, max: 8, reloadAt: 0 };
    this.units.push(new FireUnit('SH', 'SHORAD', SH_MSL, sh, [shLauncher], 1, 120, false));

    const c1 = this.addSite('CIWS 1', 'ciws', -700, 600, 4, 6);
    const c2 = this.addSite('CIWS 2', 'ciws', 3000, 6500, 4, 6);
    const r1 = this.addRadar('C1', 'CIWS 1 radar', CIWS_RADAR, c1, 'CIWS');
    const r2 = this.addRadar('C2', 'CIWS 2 radar', CIWS_RADAR, c2, 'CIWS');
    this.ciws.push(new Ciws('C1', 'CIWS 1', c1, r1), new Ciws('C2', 'CIWS 2', c2, r2));

    const base = v3(0, 0, this.terrain.groundAt(0, 0));
    const station = v3(0, 50000, 8000);
    for (const [i, x] of [-12000, 12000].entries()) {
      const f = new Fighter(`Viper ${i + 1}`, `F${i + 1}`, base, station, v3(x, 45000 + i * 3000, 8000));
      f.hdg = i === 0 ? 90 : 270;
      this.fighters.push(f);
      this.spawn(f);
    }
  }

  // ---------------------------------------------------------------- queries

  radarByCode(code: string): Radar | undefined {
    return this.radars.find((r) => r.code === code);
  }

  unit(code: 'LR' | 'MR' | 'SH'): FireUnit | undefined {
    return this.units.find((u) => u.code === code);
  }

  allRadars(): Radar[] {
    return [...this.radars, ...this.fighters.map((f) => f.radar)];
  }

  emitters(): Emitter[] {
    return [...this.radars, this.decoy];
  }

  jammers(): Entity[] {
    return this.jammerCache;
  }

  entityById(id: number): Entity | undefined {
    return this.byId.get(id);
  }

  site(name: string): Site | undefined {
    return this.sites.find((s) => s.name === name);
  }

  nextName(prefix: string): string {
    const n = (this.names.get(prefix) ?? 0) + 1;
    this.names.set(prefix, n);
    return `${prefix}-${String(n).padStart(2, '0')}`;
  }

  // ---------------------------------------------------------------- events

  log(msg: string, level: LogLevel = 'info'): void {
    this.logSeq++;
    this.logEntries.push({ t: this.t, msg, level });
    if (this.logEntries.length > 400) this.logEntries.splice(0, this.logEntries.length - 400);
  }

  effect(pos: V3, kind: Effect['kind']): void {
    this.effects.push({ id: this.nextEffect++, pos: clone(pos), t0: this.t, kind });
  }

  spawn(e: Entity): void {
    this.entities.push(e);
    this.byId.set(e.id, e);
  }

  spawnLater(e: Entity, delay: number): void {
    this.pending.push({ t: this.t + delay, e });
  }

  /** A red warhead functions: damage every site inside its lethal radius. */
  detonate(e: Entity): void {
    e.alive = false;
    const wh = e.warhead;
    if (!wh) return;
    const nearGround = e.pos.z - this.terrain.groundAt(e.pos.x, e.pos.y) < 60;
    this.effect(e.pos, e.kind === 'tbm' || e.kind === 'cruise' ? 'big' : nearGround ? 'ground' : 'blast');
    let hit = false;
    for (const s of this.sites) {
      if (!s.alive) continue;
      const d = dist(e.pos, s.pos);
      const R = wh.lethalR + s.radius;
      if (d < R) {
        s.damage(this, wh.dmg * (1 - (0.5 * d) / R), e.name);
        hit = true;
      }
    }
    if (hit) this.stats.leakers++;
    else if (e.target) {
      this.log(`${e.name} impacted ${Math.round(dist(e.pos, e.target))} m from ${e.targetName}`, e.gnssJammed ? 'info' : 'alert');
    }
  }

  /** Destroy an entity in the air (missile kill, gun kill). */
  killEntity(e: Entity, by: string): void {
    if (!e.alive) return;
    e.alive = false;
    this.effect(e.pos, 'blast');
    if (e.side === 'red') this.stats.kills++;
    if (e.side === 'blue') {
      this.stats.fratricide++;
      this.log(`FRATRICIDE: ${e.name} shot down by ${by}`, 'damage');
    } else if (e.side === 'neutral') {
      this.stats.civilian++;
      this.log(`CIVILIAN AIRLINER ${e.name} SHOT DOWN by ${by}`, 'damage');
    } else {
      this.log(`Splash ${e.name} (${e.kind}) by ${by}`, 'kill');
    }
  }

  launchAlcm(from: Entity, target: V3, name: string): void {
    const start = clone(from.pos);
    const fromNorth = from.pos.y > 60000 && Math.abs(from.pos.x) < 60000;
    const route = fromNorth ? valleyRoute(from.pos.x < 0 ? 0 : 1, from.pos.y) : [];
    const cm = new Cruise(this.nextName('ALCM'), start, route, target, name);
    cm.hdg = (from as unknown as { hdg: number }).hdg ?? 180;
    this.spawn(cm);
    this.tracker.markHostileAct(this, from.pos);
  }

  launchArm(from: Entity, em: Emitter): void {
    const dir = norm(add(sub(em.pos, from.pos), v3(0, 0, 4000)));
    const arm = new Arm(this.nextName('ARM'), from.pos, add(from.vel, scale(dir, 300)), em, this.t);
    this.spawn(arm);
    this.tracker.markHostileAct(this, from.pos);
  }

  onMissileDetonation(m: Interceptor, tgt: Entity, miss: number, kill: boolean): void {
    this.effect(m.pos, 'small');
    const tr = this.tracker.get(m.trackId);
    if (tr) tr.kaUntil = this.t + 5;
    const label = tr?.label ?? tgt.name;
    if (kill) this.killEntity(tgt, `${m.spec.name} (${label}, miss ${miss.toFixed(0)} m)`);
    else this.log(`${m.spec.name} detonated ${miss.toFixed(0)} m from ${label}: target survived`, 'engage');
  }

  onMissileMiss(m: Interceptor, miss: number): void {
    const tr = this.tracker.get(m.trackId);
    this.log(`${m.spec.name} #${m.id} missed ${tr?.label ?? 'target'} by ${miss.toFixed(0)} m`, 'engage');
  }

  onTrackDropped(tr: Track): void {
    for (const f of this.fighters) if (f.targetTrackId === tr.id) f.toStation(this);
  }

  remapTrack(from: number, to: number): void {
    this.remapped.set(from, to);
    for (const m of this.missiles) if (m.trackId === from) m.trackId = to;
    for (const f of this.fighters) if (f.targetTrackId === from) f.targetTrackId = to;
    for (const u of this.units) u.remap(from, to);
  }

  // ---------------------------------------------------------------- player commands

  engage(trackId: number, code: 'LR' | 'MR' | 'SH'): string {
    const tr = this.tracker.get(trackId);
    const u = this.unit(code);
    if (!tr || !u) return 'no such track';
    const f = u.feasibility(this, tr);
    if (!f.ok) return f.reason;
    u.fire(this, tr, tr.cls === 'TBM' ? 2 : 1);
    return 'engaging';
  }

  setIdent(trackId: number, id: Ident | null): void {
    const tr = this.tracker.get(trackId);
    if (!tr) return;
    tr.manual = id;
    this.log(`${tr.label} identity ${id ? `set to ${id}` : 'returned to automatic'} by operator`, 'info');
  }

  setWcs(w: Wcs): void {
    this.wcs = w;
    this.log(`Weapons control status: ${w}`, 'alert');
  }

  toggleEmcon(code: string): void {
    const r = this.radarByCode(code);
    if (!r) return;
    r.emitting = !r.emitting;
    this.log(`${r.name} ${r.emitting ? 'radiating' : 'EMCON (silent)'}`, 'info');
  }

  // ---------------------------------------------------------------- stepping

  private stepGnss(dt: number): void {
    const check = this.t >= this.nextGnss;
    if (check) this.nextGnss = this.t + 1;
    const j = this.gnss;
    for (const e of this.entities) {
      if (!e.alive || e.gnssDep <= 0) continue;
      if (check) {
        const was = e.gnssJammed;
        e.gnssJammed = j.active && dist(e.pos, j.site.pos) < j.rangeM && this.terrain.los(j.site.pos, e.pos);
        if (e.gnssJammed && !was) {
          const a = this.rng.range(0, Math.PI * 2);
          const m = e.gnssDep * this.rng.range(0.5, 2);
          e.navDrift = v3(Math.cos(a) * m, Math.sin(a) * m, 0);
        }
      }
      if (e.gnssJammed) {
        const s = 0.05 * e.gnssDep * Math.sqrt(dt);
        e.navDrift.x += this.rng.gauss() * s;
        e.navDrift.y += this.rng.gauss() * s;
        e.navErr.x += e.navDrift.x * dt;
        e.navErr.y += e.navDrift.y * dt;
      } else if (e.navErr.x || e.navErr.y) {
        const k = 1 - dt / 3;
        e.navErr.x *= k;
        e.navErr.y *= k;
      }
    }
  }

  step(dt = DT): void {
    this.t += dt;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i].t <= this.t) {
        this.spawn(this.pending[i].e);
        this.pending.splice(i, 1);
      }
    }
    this.scenario.update(this);
    this.jammerCache = this.entities.filter((e) => e.alive && e.jammer?.active);

    for (const e of this.entities) if (e.alive) e.update(this, dt);
    this.stepGnss(dt);

    const reports: Report[] = [];
    for (const r of this.allRadars()) r.step(this, dt, reports);
    this.tracker.process(this, reports);

    for (const u of this.units) u.update(this);
    if (this.t >= this.nextTewa) {
      this.nextTewa = this.t + 1;
      autoEngage(this);
    }
    for (const m of this.missiles) if (m.alive) m.update(this, dt);
    for (const c of this.ciws) c.update(this, dt);

    if (this.entities.some((e) => !e.alive)) {
      this.entities = this.entities.filter((e) => {
        if (e.alive || e instanceof Fighter) return true;
        this.byId.delete(e.id);
        return false;
      });
    }
    if (this.missiles.some((m) => !m.alive)) this.missiles = this.missiles.filter((m) => m.alive);
    if (this.effects.length && this.t - this.effects[0].t0 > 6) this.effects = this.effects.filter((f) => this.t - f.t0 <= 6);
  }
}
