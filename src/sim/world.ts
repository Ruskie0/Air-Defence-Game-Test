import { DT } from './constants';
import { Ciws } from './ciws';
import { Arm, Cruise, Emitter, Entity } from './entities';
import { Fighter } from './fighter';
import { V3, add, clone, dist, norm, scale, sub, v3 } from './math';
import { CATALOG, DEFENDED_ASSETS, DeployedUnit, Deployment, UnitType, sandboxDeployment } from './catalog';
import { Interceptor, LR_MSL, MR_MSL, MissileSpec, SH_MSL } from './missile';
import { CIWS_RADAR, EW_RADAR, LR_RADAR, MR_RADAR, Radar, RadarSpec, Report, SH_RADAR } from './radar';
import { Rng } from './rng';
import { Raid, Scenario } from './scenario';
import { Decoy, FireUnit, GnssJammer, Launcher, Site, SiteKind } from './sites';
import { Terrain } from './terrain';
import { Wcs, autoEngage } from './tewa';
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
  /** Threats destroyed per shooter (fire unit, fighter or gun name). */
  killsBy: Record<string, number>;
}

export interface WorldOptions {
  seed?: number;
  /** Share one terrain between worlds (campaign days, the deployment preview). */
  terrain?: Terrain;
  deployment?: Deployment;
  /** Raid plan; the six-raid sandbox scenario when omitted. */
  raids?: Raid[];
  /** Background civil traffic on the airways. */
  civil?: boolean;
}

/** What a deployed unit became in this world, so the campaign can read back its state after the day. */
export interface Fielded {
  unit: DeployedUnit;
  sites: Site[];
  fu?: FireUnit;
  ciws?: Ciws;
  fighters?: Fighter[];
  radar?: Radar;
}

/** Terrain seed of the one map every mode is fought over. */
export const MAP_SEED = 20261023;

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
  readonly gnss: GnssJammer[] = [];
  readonly decoys: Decoy[] = [];
  readonly fielded: Fielded[] = [];
  readonly tracker = new Tracker();
  readonly scenario: Scenario;
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
    killsBy: {},
  };
  /** Hits on defended sites per campaign raid package. */
  readonly pkgHits = new Map<number, number>();
  /** Seconds each radar spent radiating (by radar code). */
  readonly radiating = new Map<string, number>();
  /** Package tag given to everything spawned while it is set. */
  spawnTag = -1;
  /** Track id remaps from fusion merges, so the UI can follow a selected track. */
  readonly remapped = new Map<number, number>();
  private readonly byId = new Map<number, Entity>();
  private pending: { t: number; e: Entity }[] = [];
  private jammerCache: Entity[] = [];
  private nextEffect = 1;
  private nextTewa = 0;
  private nextGnss = 0;
  private nextArmWatch = 0;
  private readonly names = new Map<string, number>();
  private readonly typeCount = new Map<string, number>();

  constructor(opts: WorldOptions | number = {}) {
    const o: WorldOptions = typeof opts === 'number' ? { seed: opts } : opts;
    this.seed = o.seed ?? MAP_SEED;
    this.rng = new Rng(this.seed);
    this.terrain = o.terrain ?? new Terrain(MAP_SEED);
    const dep = o.deployment ?? sandboxDeployment();
    for (const a of DEFENDED_ASSETS) {
      const s = this.addSite(a.name, 'asset', a.x, a.y, 0, a.radius, true);
      s.hp = dep.assets.find((x) => x.name === a.name)?.hp ?? 100;
      s.vuln = a.vuln;
      s.alive = s.hp > 0;
    }
    for (const u of dep.units) this.field(u);
    this.scenario = new Scenario(o.raids);
    if (o.civil ?? true) this.scenario.start(this);
  }

  // ---------------------------------------------------------------- set-up

  private addSite(name: string, kind: SiteKind, x: number, y: number, mast: number, radius: number, defended = false): Site {
    const s = new Site(name, kind, v3(x, y, this.terrain.groundAt(x, y) + mast), radius, defended);
    this.sites.push(s);
    return s;
  }

  private addRadar(code: string, name: string, spec: RadarSpec, site: Site, sig: Emitter['signature']): Radar {
    const r = new Radar(code, name, spec, site.pos, sig);
    r.az = this.rng.range(0, 360);
    site.onDestroyed = () => {
      r.alive = false;
    };
    this.radars.push(r);
    return r;
  }

  /** Sequence number of this unit among its type, and a unique code / display name. */
  private ident(type: UnitType, code: string, name: string): { n: number; code: string; name: string } {
    const n = (this.typeCount.get(type) ?? 0) + 1;
    this.typeCount.set(type, n);
    return { n, code: n === 1 ? code : `${code}${n}`, name: n === 1 ? name : `${name} ${n}` };
  }

  /** Instantiate one deployed unit: its sites, radar, launchers, gun or aircraft. */
  field(u: DeployedUnit): Fielded {
    const f: Fielded = { unit: u, sites: [] };
    const site = (name: string, kind: SiteKind, x: number, y: number, mast: number, radius: number): Site => {
      const s = this.addSite(name, kind, x, y, mast, radius);
      f.sites.push(s);
      return s;
    };
    const sam = (type: 'LR' | 'MR' | 'SH', spec: RadarSpec, missile: MissileSpec, unitName: string, radarName: string, mast: number): void => {
      const id = this.ident(type, type, unitName);
      const radarSite = site(id.n === 1 ? radarName : `${radarName} ${id.n}`, 'radar', u.x, u.y, mast, type === 'SH' ? 8 : 12);
      const r = this.addRadar(id.code, `${id.name} radar`, spec, radarSite, type);
      r.boresight = u.facing;
      f.radar = r;
      const launchers: Launcher[] = u.launchers.map((l, i) => {
        const ls = type === 'SH' ? radarSite : site(`${id.name} launcher ${i + 1}`, 'launcher', l.x, l.y, 2, 6);
        const launcher: Launcher = { site: ls, rounds: l.rounds, max: l.max, reloadAt: 0 };
        if (type !== 'SH') {
          ls.onDestroyed = () => {
            launcher.rounds = 0;
          };
        }
        return launcher;
      });
      const info = CATALOG[type];
      const fu = new FireUnit(type, id.code, u.uid, id.name, missile, r, launchers, info.channels!, info.reloadS!, type === 'MR');
      fu.spares = u.spares;
      // A launch with rounds already missing starts the reload clock straight away.
      for (const l of launchers) if (l.rounds < l.max && fu.spares > 0) l.reloadAt = info.reloadS!;
      this.units.push(fu);
      f.fu = fu;
    };
    switch (u.type) {
      case 'LR':
        sam('LR', LR_RADAR, LR_MSL, 'LR SAM', 'LR radar', 8);
        break;
      case 'MR':
        sam('MR', MR_RADAR, MR_MSL, 'MR SAM', 'MR radar', 12);
        break;
      case 'SH':
        sam('SH', SH_RADAR, SH_MSL, 'SHORAD', 'SHORAD', 6);
        break;
      case 'CIWS': {
        const id = this.ident('CIWS', 'C', 'CIWS');
        const code = `C${id.n}`;
        const name = `CIWS ${id.n}`;
        const s = site(name, 'ciws', u.x, u.y, 4, 6);
        const r = this.addRadar(code, `${name} radar`, CIWS_RADAR, s, 'CIWS');
        f.radar = r;
        const c = new Ciws(code, name, s, r);
        this.ciws.push(c);
        f.ciws = c;
        break;
      }
      case 'EWR': {
        const id = this.ident('EWR', 'EW', 'EW radar');
        const s = site(id.name, 'radar', u.x, u.y, 14, 14);
        f.radar = this.addRadar(id.code, id.name, EW_RADAR, s, 'EW');
        break;
      }
      case 'GNSS': {
        const id = this.ident('GNSS', 'GJ', 'GNSS jammer');
        this.gnss.push(new GnssJammer(site(id.name, 'gnss', u.x, u.y, 15, 8)));
        break;
      }
      case 'DECOY': {
        const id = this.ident('DECOY', 'DC', 'Radar decoy');
        this.decoys.push(new Decoy(site(id.name, 'decoy', u.x, u.y, 8, 10)));
        break;
      }
      case 'CAP': {
        const base = v3(0, 0, this.terrain.groundAt(0, 0));
        const station = v3(u.x, u.y, 8000);
        f.fighters = [];
        for (let i = 0; i < u.aircraft; i++) {
          const n = this.fighters.length + 1;
          const start = v3(u.x + (i === 0 ? -12000 : 12000), u.y - 5000 + i * 3000, 8000);
          const fi = new Fighter(`Viper ${n}`, `F${n}`, base, station, start);
          fi.hdg = i === 0 ? 90 : 270;
          this.fighters.push(fi);
          this.spawn(fi);
          f.fighters.push(fi);
        }
        break;
      }
    }
    if (f.radar && u.armWatch) f.radar.armWatch = true;
    this.fielded.push(f);
    return f;
  }

  // ---------------------------------------------------------------- queries

  radarByCode(code: string): Radar | undefined {
    return this.radars.find((r) => r.code === code);
  }

  /** Fire unit by its unique code (LR, LR2, MR, SH, ...). */
  unit(code: string): FireUnit | undefined {
    return this.units.find((u) => u.code === code);
  }

  allRadars(): Radar[] {
    return [...this.radars, ...this.fighters.map((f) => f.radar)];
  }

  emitters(): Emitter[] {
    return [...this.radars, ...this.decoys];
  }

  jammers(): Entity[] {
    return this.jammerCache;
  }

  entityById(id: number): Entity | undefined {
    return this.byId.get(id);
  }

  get pendingCount(): number {
    return this.pending.length;
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
    if (this.spawnTag >= 0 && e.pkg < 0) e.pkg = this.spawnTag;
    this.entities.push(e);
    this.byId.set(e.id, e);
  }

  spawnLater(e: Entity, delay: number): void {
    if (this.spawnTag >= 0 && e.pkg < 0) e.pkg = this.spawnTag;
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
    if (hit) {
      this.stats.leakers++;
      if (e.pkg >= 0) this.pkgHits.set(e.pkg, (this.pkgHits.get(e.pkg) ?? 0) + 1);
    }
    else if (e.target) {
      this.log(`${e.name} impacted ${Math.round(dist(e.pos, e.target))} m from ${e.targetName}`, e.gnssJammed ? 'info' : 'alert');
    }
  }

  /** Destroy an entity in the air (missile kill, gun kill). */
  killEntity(e: Entity, by: string, shooter = by): void {
    if (!e.alive) return;
    e.alive = false;
    this.effect(e.pos, 'blast');
    if (e.side === 'red') {
      this.stats.kills++;
      this.stats.killsBy[shooter] = (this.stats.killsBy[shooter] ?? 0) + 1;
    }
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
    const loc = this.terrain.toLocal(from.pos.x, from.pos.y);
    const overMountains = loc.v > 60000 && Math.abs(loc.u) < 60000;
    const route = overMountains ? this.terrain.passRoute(loc.u < this.terrain.passU(0, loc.v) / 2 + this.terrain.passU(1, loc.v) / 2 ? 0 : 1, loc.v) : [];
    const cm = new Cruise(this.nextName('ALCM'), start, route, target, name);
    cm.hdg = (from as unknown as { hdg: number }).hdg ?? 180;
    cm.pkg = from.pkg;
    this.spawn(cm);
    this.tracker.markHostileAct(this, from.pos);
  }

  launchArm(from: Entity, em: Emitter): void {
    const dir = norm(add(sub(em.pos, from.pos), v3(0, 0, 4000)));
    const arm = new Arm(this.nextName('ARM'), from.pos, add(from.vel, scale(dir, 300)), em, this.t);
    arm.pkg = from.pkg;
    this.spawn(arm);
    this.tracker.markHostileAct(this, from.pos);
  }

  onMissileDetonation(m: Interceptor, tgt: Entity, miss: number, kill: boolean): void {
    this.effect(m.pos, 'small');
    const tr = this.tracker.get(m.trackId);
    if (tr) tr.kaUntil = this.t + 5;
    const label = tr?.label ?? tgt.name;
    if (kill) this.killEntity(tgt, `${m.spec.name} (${label}, miss ${miss.toFixed(0)} m)`, m.unit);
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

  engage(trackId: number, code: string): string {
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
    r.armSilent = false;
    this.log(`${r.name} ${r.emitting ? 'radiating' : 'EMCON (silent)'}`, 'info');
  }

  toggleArmWatch(code: string): void {
    const r = this.radarByCode(code);
    if (!r) return;
    r.armWatch = !r.armWatch;
    if (!r.armWatch && r.armSilent) {
      r.armSilent = false;
      r.emitting = true;
    }
    this.log(`${r.name} automatic ARM response ${r.armWatch ? 'ON' : 'OFF'}`, 'info');
  }

  // ---------------------------------------------------------------- stepping

  /** Radars on automatic ARM response go silent while a hostile missile track is closing on them. */
  private stepArmWatch(): void {
    if (this.t < this.nextArmWatch) return;
    this.nextArmWatch = this.t + 0.5;
    for (const r of this.radars) {
      if (!r.armWatch || !r.alive || r.platform) continue;
      // Time until the closest inbound missile arrives, or Infinity if none is closing on this radar.
      let tgo = Infinity;
      for (const tr of this.tracker.tracks) {
        if (tr.dropped || !tr.confirmed || tr.cls !== 'MSL' || tr.ident !== 'HOS' || this.t - tr.t > 6) continue;
        const p = tr.predict(this.t);
        const v = tr.velAt(this.t);
        const dx = r.pos.x - p.x;
        const dy = r.pos.y - p.y;
        const R = Math.hypot(dx, dy);
        const vh = Math.hypot(v.x, v.y);
        if (vh < 100) continue;
        const closing = (v.x * dx + v.y * dy) / Math.max(1, R);
        const miss = Math.abs(v.x * dy - v.y * dx) / vh;
        if (closing > 0.8 * vh && R / closing < 90 && miss < 4000) tgo = Math.min(tgo, R / closing);
      }
      if (tgo < Infinity) {
        // Stay silent until well after the missile would have arrived: once the radars go quiet it may drop out of the picture.
        r.armClearAt = Math.max(r.armClearAt, this.t + tgo + 8);
        if (r.emitting) {
          r.emitting = false;
          r.armSilent = true;
          this.log(`${r.name} ARM warning: radar shut down`, 'alert');
        }
      } else if (r.armSilent && this.t >= r.armClearAt) {
        r.emitting = true;
        r.armSilent = false;
        this.log(`${r.name} ARM threat passed, radiating`, 'info');
      }
    }
  }

  private stepGnss(dt: number): void {
    const check = this.t >= this.nextGnss;
    if (check) this.nextGnss = this.t + 1;
    const live = this.gnss.filter((j) => j.active);
    for (const e of this.entities) {
      if (!e.alive || e.gnssDep <= 0) continue;
      if (check) {
        const was = e.gnssJammed;
        e.gnssJammed = live.some((j) => dist(e.pos, j.site.pos) < j.rangeM && this.terrain.los(j.site.pos, e.pos));
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
    this.stepArmWatch();

    const reports: Report[] = [];
    for (const r of this.allRadars()) {
      r.step(this, dt, reports);
      if (r.isEmitting()) this.radiating.set(r.code, (this.radiating.get(r.code) ?? 0) + dt);
    }
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
