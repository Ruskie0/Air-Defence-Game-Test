import { EnemyBase, makeTheatre } from './theatre';
import { EnemyArmour } from './enemyarmour';
import type { Ground } from './ground';
import { DT } from './constants';
import { Ciws, GUNS } from './ciws';
import { MoveOrder, orderMove, scoot, stepMoves } from './mobility';
import { SupportCall, stepSupport } from './support';
import { Modifiers, modifiers } from '../campaign/upgrades';
import { WEATHER, Weather, WeatherId } from '../campaign/weather';
import { Arm, Atgm, Cruise, Drone, Emitter, Entity, Fate, GlideBomb, Helo, ReconDrone, Sighting } from './entities';
import { Fighter } from './fighter';
import { V3, add, bearingDeg, clone, dist, hdist, norm, polar, scale, sub, v3 } from './math';
import { CATALOG, DEFENDED_ASSETS, DeployedUnit, Deployment, UnitType, rankOf } from './catalog';
import { DEFAULT_ZONES, DeployZone, sandboxDeployment } from './deploy';
import { AssaultOutcome, Column } from './column';
import { EnemyAd } from './enemyad';
import { Exposure } from './exposure';
import { RedSupport, sweepCap } from './redair';
import { Interceptor, LR_MSL, MR_MSL, MissileSpec, SH_MSL } from './missile';
import { EMCON_TEXT, CIWS_RADAR, EW_RADAR, LR_RADAR, MR_RADAR, Radar, RadarSpec, Report, SH_RADAR } from './radar';
import { Rng } from './rng';
import { Raid, Scenario } from './scenario';
import { Decoy, EwJammer, FireUnit, GnssJammer, Launcher, Site, SiteKind } from './sites';
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
  /** Decoy drones shot down by missiles (missiles the enemy tricked us into spending). */
  decoyMissiles: number;
  /** Red entities spawned and shot down, by kind (recon drones count as 'recon'). */
  spawnedKind: Record<string, number>;
  killedKind: Record<string, number>;
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
  /** Campaign upgrades in force (see src/campaign/upgrades.ts). */
  upgrades?: readonly string[];
  /** Money available for support calls during the battle ($M); unlimited in the sandbox. */
  budgetM?: number;
  /** The day's weather (clear when omitted). */
  weather?: WeatherId;
  /** Level of the enemy's counter-battery fire (campaign day); 0 turns it off. 4 when omitted. */
  counterBattery?: number;
  /** The enemy's AWACS was shot down recently and has not been replaced: none flies in this battle. */
  awacsDenied?: boolean;
  /** Campaign clock (minutes since midnight before day 1, as in campaign/clock.ts) at t = 0; absent outside the campaign. */
  clockStart?: number;
  /** The kind of operation this battle is ('probe', 'strike', 'night'); only combined strikes are timed on target. */
  pulse?: string;
  /** Campaign front line: the towns we hold (defended), and today's assault force if an offensive is on. */
  towns?: { name: string; x: number; y: number; hp: number }[];
  /** Today's assault force: its start line, the town it goes for, and where its column sets off from (it starts on its start line when omitted). */
  assault?: { x: number; y: number; target: string; from?: { x: number; y: number } };
  /** The enemy's ground offensive on one of our towns, if one is on: the town, and the enemy town it comes from. */
  enemyAssault?: { target: string; from: { x: number; y: number }; to: { x: number; y: number }; takeHp?: number };
  /** Where ground units may stand (the sandbox's 60 km circle when omitted). */
  zones?: DeployZone[];
  /** The enemy's installations, which every enemy weapon launches from (a fresh default theatre when omitted). */
  theatre?: EnemyBase[];
}

/** What a deployed unit became in this world, so the campaign can read back its state after the day. */
export interface Fielded {
  unit: DeployedUnit;
  sites: Site[];
  fu?: FireUnit;
  ciws?: Ciws;
  fighters?: Fighter[];
  radar?: Radar;
  /** Set while the unit is packing up, moving or setting up again. */
  move?: MoveOrder | null;
  /** How much of its position the enemy has worked out from its launches and emissions, 0 to 100. */
  heat?: number;
}

/** Terrain seed of the one map every mode is fought over. */
/** What dealt damage to our sites, for the debrief. */
export type HurtBy = 'drones' | 'cruise' | 'tbm' | 'arm' | 'helo' | 'strike' | 'artillery' | 'other';

const HURT_PREFIX: [RegExp, HurtBy][] = [
  [/^(DRN|LM)-/, 'drones'], [/^(CM|ALCM)-/, 'cruise'], [/^TBM-/, 'tbm'], [/^ARM-/, 'arm'],
  [/^(HEL|ATGM)-/, 'helo'], [/^(GB|STK)-/, 'strike'], [/^artillery/, 'artillery'],
];

export function hurtBy(by: string): HurtBy {
  return HURT_PREFIX.find(([re]) => re.test(by))?.[1] ?? 'other';
}

/** Campaign reward for each enemy recon drone shot down with photos aboard ($M). */
export const RECON_BOUNTY_M = 6;

export const MAP_SEED = 20261023;

/** The whole simulation. Stepped at a fixed 60 Hz; all randomness comes from one seeded stream. */
export class World {
  t = 0;
  readonly seed: number;
  /** Campaign clock at t = 0 (minutes); the time of day is clockStart + t / 60. Undefined outside the campaign. */
  readonly clockStart?: number;
  readonly pulse?: string;
  readonly rng: Rng;
  readonly terrain: Terrain;
  /** Enemy installations: where every enemy weapon starts. Shared with the campaign, which keeps the stocks. */
  theatre: EnemyBase[];
  entities: Entity[] = [];
  missiles: Interceptor[] = [];
  readonly sites: Site[] = [];
  readonly radars: Radar[] = [];
  readonly units: FireUnit[] = [];
  readonly ciws: Ciws[] = [];
  readonly fighters: Fighter[] = [];
  readonly gnss: GnssJammer[] = [];
  readonly decoys: Decoy[] = [];
  readonly ewj: EwJammer[] = [];
  readonly fielded: Fielded[] = [];
  readonly tracker = new Tracker();
  readonly scenario: Scenario;
  wcs: Wcs = 'TIGHT';
  /** Game-stat multipliers from campaign upgrades. */
  mods: Modifiers;
  weatherId: WeatherId;
  weather: Weather;
  /** Support calls budget ($M) and what has been spent from it. */
  budgetM: number;
  supportSpentM = 0;
  /** Shoot and scoot: exposure of our batteries and the enemy's counter-battery strikes. */
  readonly exposure: Exposure;
  /** The theatre's SAM sites in this battle (kept apart from our own sites). */
  readonly enemyAd: EnemyAd;
  /** The enemy's AWACS and tanker, and what they give it while they fly. */
  readonly redSupport = new RedSupport();
  /** The offensive's assault column driving to its start line, if there is one. */
  column: Column | null = null;
  /** What has happened to the assault force so far ('arrived' or 'destroyed'), or null. */
  assaultOutcome: AssaultOutcome | null = null;
  /**
   * Outcome hook for the offensive: called once when the column reaches its start line and once if the
   * assault force is destroyed. The campaign connects it; nothing listens by default.
   */
  onAssault: ((outcome: AssaultOutcome, w: World) => void) | null = null;
  /** Where ground units may stand. */
  zones: readonly DeployZone[];
  /** The quick reaction alert pair has been scrambled this battle. */
  qraUsed = false;
  /** Resupply convoys and repair teams on their way. */
  support: SupportCall[] = [];
  /** Units bought and still on their way to the depot (campaign): where they will go, and when they arrive (clock min). */
  incoming: { uid: number; type: UnitType; x: number; y: number; eta: number; depot: { x: number; y: number } }[] = [];
  /** Bumped whenever a unit's position changes, so views can redraw coverage. */
  layoutSeq = 0;
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
    decoyMissiles: 0,
    spawnedKind: {},
    killedKind: {},
  };
  /** Our positions enemy recon drones got home with, by unit id. */
  readonly reconSeen = new Map<number, Sighting>();
  /** Damage our sites took this battle, by what dealt it ("what hurt you"). */
  readonly hurt = new Map<HurtBy, { dmg: number; hits: number; sites: Set<string> }>();
  /** Enemy recon drones shot down with photos aboard: the intel they carried never got home. */
  reconDenied = 0;
  /** Every site's health when the battle started (for the day's objectives). */
  readonly startHp = new Map<string, number>();
  /** Hits on defended sites per campaign raid package. */
  readonly pkgHits = new Map<number, number>();
  /** Per raid package, for the after-action timeline: what it put in the air and how each one ended. */
  readonly pkgTally = new Map<number, { spawned: number; down: number; hits: number; missed: number; home: number }>();
  /** Seconds each radar spent radiating (by radar code). */
  readonly radiating = new Map<string, number>();
  /** Package tag given to everything spawned while it is set. */
  spawnTag = -1;
  /** The enemy's armoured column, when it is attacking one of our towns in this raid. */
  enemyArmour: EnemyArmour | null = null;
  /** The living war's ground war: battalions of both sides on the road, stepped once a second. */
  ground: Ground | null = null;
  private groundAcc = 0;
  /** Everything that died or left in the last 20 s, newest last (for wrecks and kill feeds). */
  deaths: Entity[] = [];
  /** Enemy aircraft shot down this battle, keyed "package|kind" (the campaign takes them off their bases' strength). */
  readonly redAirLost = new Map<string, number>();
  /** Track id remaps from fusion merges, so the UI can follow a selected track. */
  readonly remapped = new Map<number, number>();
  private readonly byId = new Map<number, Entity>();
  private pending: { t: number; e: Entity }[] = [];
  private jammerCache: Entity[] = [];
  private nextEffect = 1;
  private nextTewa = 0;
  private nextGnss = 0;
  private nextEmcon = 0;
  private nextArmWatch = 0;
  private readonly names = new Map<string, number>();
  private readonly typeCount = new Map<string, number>();

  constructor(opts: WorldOptions | number = {}) {
    const o: WorldOptions = typeof opts === 'number' ? { seed: opts } : opts;
    this.seed = o.seed ?? MAP_SEED;
    this.clockStart = o.clockStart;
    this.pulse = o.pulse;
    this.rng = new Rng(this.seed);
    this.mods = modifiers(o.upgrades);
    this.weatherId = o.weather ?? 'clear';
    this.weather = WEATHER[this.weatherId];
    this.budgetM = o.budgetM ?? Infinity;
    this.terrain = o.terrain ?? new Terrain(MAP_SEED);
    const dep = o.deployment ?? sandboxDeployment(this.terrain);
    for (const a of DEFENDED_ASSETS) {
      const p = this.terrain.asset(a.name);
      const s = this.addSite(a.name, 'asset', p.x, p.y, 0, a.radius, true);
      s.hp = dep.assets.find((x) => x.name === a.name)?.hp ?? 100;
      s.vuln = a.vuln;
      s.alive = s.hp > 0;
    }
    for (const tn of o.towns ?? []) {
      const s = this.addSite(tn.name, 'asset', tn.x, tn.y, 0, 450, true);
      s.role = 'town';
      // A town is a big area target: it takes several hits to knock flat.
      s.vuln = 0.5;
      s.hp = tn.hp;
      s.alive = s.hp > 0;
    }
    if (o.assault) {
      const a = o.assault;
      const at = a.from ?? a;
      const s = this.addSite('Assault force', 'asset', at.x, at.y, 0, 250, true);
      s.role = 'assault';
      s.onDestroyed = () => this.assaultEvent('destroyed');
      if (a.from) {
        const dest = v3(a.x, a.y, this.terrain.groundAt(a.x, a.y) + 2);
        this.column = new Column('Assault column', v3(at.x, at.y, this.terrain.groundAt(at.x, at.y) + 2), dest, s, a.target, 0);
      }
    }
    this.zones = o.zones ?? DEFAULT_ZONES;
    this.theatre = o.theatre ?? makeTheatre(this.terrain, this.seed);
    this.exposure = new Exposure(o.counterBattery ?? 4);
    this.enemyAd = new EnemyAd(this);
    for (const u of dep.units) this.field(u);
    const wx = Math.pow(10, this.weather.radarLossDb / 10);
    for (const r of this.allRadars()) if (r.spec.freqGHz >= 8) r.wxLoss = wx;
    for (const s of this.sites) {
      s.vuln *= this.mods.damageMult;
      this.startHp.set(s.name, s.hp);
    }
    if (this.column) this.spawn(this.column);
    if (o.enemyAssault) this.enemyArmour = new EnemyArmour(o.enemyAssault.target, o.enemyAssault.from, o.enemyAssault.to, o.enemyAssault.takeHp);
    this.redSupport.denied = !!o.awacsDenied;
    this.redSupport.launch(this, o.counterBattery ?? 0);
    sweepCap(this);
    this.scenario = new Scenario(o.raids, this.terrain.layout.rot);
    this.redSupport.coordinate(this);
    if (this.redSupport.down) this.log('Enemy AWACS down: raids uncoordinated. Its packages will arrive staggered and its fighters fly blind', 'info');
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
    const f: Fielded = { unit: u, sites: [], heat: u.heat };
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
      const rank = rankOf(u.xp);
      const reloadS = info.reloadS! * this.mods.reloadMult * (1 - 0.07 * rank);
      const fu = new FireUnit(type, id.code, u.uid, id.name, missile, r, launchers, info.channels!, reloadS, type === 'MR');
      fu.spares = u.spares;
      fu.hold = !!u.holdFire;
      fu.rank = rank;
      // A launch with rounds already missing starts the reload clock straight away.
      for (const l of launchers) if (l.rounds < l.max && fu.spares > 0) l.reloadAt = reloadS;
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
      case 'CIWS':
      case 'GUN':
      case 'LASER': {
        const spec = GUNS[u.type === 'CIWS' ? 'ciws' : u.type === 'GUN' ? 'gun35' : 'laser'];
        const prefix = u.type === 'CIWS' ? 'C' : u.type === 'GUN' ? 'G' : 'HL';
        const id = this.ident(u.type, prefix, spec.label);
        const code = `${prefix}${id.n}`;
        const name = `${spec.label} ${id.n}`;
        const s = site(name, 'ciws', u.x, u.y, 4, 6);
        const r = this.addRadar(code, `${name} radar`, CIWS_RADAR, s, 'CIWS');
        f.radar = r;
        const c = new Ciws(code, name, s, r, spec);
        c.auto = !u.holdFire;
        c.rank = rankOf(u.xp);
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
      case 'GAP': {
        const id = this.ident('GAP', 'GF', 'Gap-filler');
        const s = site(id.name, 'radar', u.x, u.y, 30, 8);
        f.radar = this.addRadar(id.code, id.name, SH_RADAR, s, 'SH');
        break;
      }
      case 'GNSS': {
        const id = this.ident('GNSS', 'GJ', 'GNSS jammer');
        const j = new GnssJammer(site(id.name, 'gnss', u.x, u.y, 15, 8));
        j.on = !!u.on;
        this.gnss.push(j);
        break;
      }
      case 'DECOY': {
        const id = this.ident('DECOY', 'DC', 'Radar decoy');
        const dc = new Decoy(site(id.name, 'decoy', u.x, u.y, 8, 10));
        dc.on = !!u.on;
        this.decoys.push(dc);
        break;
      }
      case 'JAM': {
        const id = this.ident('JAM', 'EJ', 'EW jammer');
        const js = site(id.name, 'jammer', u.x, u.y, 10, 8);
        // A hardened shelter: it is built to be shot at, and takes two or three ARMs.
        js.vuln = 0.6;
        const j = new EwJammer(js);
        j.on = !!u.on;
        this.ewj.push(j);
        break;
      }
      case 'CAP': {
        const base = v3(0, 0, this.terrain.groundAt(0, 0));
        const station = v3(u.x, u.y, 8000);
        f.fighters = [];
        // An airbase knocked out cannot launch or recover fighters.
        const flying = this.site('Airbase')?.alive === false ? 0 : u.aircraft;
        for (let i = 0; i < flying; i++) {
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
    // Emission control as the crew left it.
    if (f.radar && u.emcon) f.radar.emcon = u.emcon;
    if (f.radar && u.silent) f.radar.emitting = false;
    // Damage from an earlier raid that the crews have not yet repaired.
    if (u.hp !== undefined && f.sites[0]) f.sites[0].hp = Math.max(1, u.hp);
    f.fu?.launchers.forEach((l, i) => {
      const hp = u.launchers[i]?.hp;
      if (hp !== undefined && l.site !== f.sites[0]) l.site.hp = Math.max(1, hp);
    });
    this.fielded.push(f);
    return f;
  }

  /** A unit that arrives during the battle (Last Stand reinforcements): field it as the constructor would. */
  reinforce(u: DeployedUnit): Fielded {
    const n = this.sites.length;
    const f = this.field(u);
    if (f.radar && f.radar.spec.freqGHz >= 8) f.radar.wxLoss = Math.pow(10, this.weather.radarLossDb / 10);
    for (const s of this.sites.slice(n)) {
      s.vuln *= this.mods.damageMult;
      this.startHp.set(s.name, s.hp);
    }
    this.layoutSeq++;
    return f;
  }

  // ---------------------------------------------------------------- the living war (campaign)
  // The campaign keeps one world for the whole war, so the map changes under it: towns change hands, the
  // assault force sets off and is done with, units are bought, scrapped and refitted, and the weather turns.

  /** A defended site added during the war (a town just taken). */
  addTown(tn: { name: string; x: number; y: number; hp: number }): Site {
    const s = this.addSite(tn.name, 'asset', tn.x, tn.y, 0, 450, true);
    s.role = 'town';
    s.vuln = 0.5 * this.mods.damageMult;
    s.hp = tn.hp;
    s.alive = s.hp > 0;
    this.startHp.set(s.name, s.hp);
    this.layoutSeq++;
    return s;
  }

  /** Take a site off the map altogether (a town lost, the assault force stood down, a unit scrapped). */
  removeSite(s: Site): void {
    const i = this.sites.indexOf(s);
    if (i >= 0) this.sites.splice(i, 1);
    this.layoutSeq++;
  }

  /** One of our battalions as a site: enemy weapons and helicopters hunt it, and its health is its strength. */
  addBattalionSite(name: string, x: number, y: number, hp: number): Site {
    const s = this.addSite(name, 'asset', x, y, 0, 250, true);
    s.role = 'assault';
    s.hp = hp;
    // Dispersed vehicles: one warhead knocks out a few of them, not a fifth of the battalion.
    s.vuln *= 0.2 * this.mods.damageMult;
    this.layoutSeq++;
    return s;
  }

  /** Send an assault force up the road during the war, as the constructor does for a battle's offensive. */
  startAssault(a: { x: number; y: number; target: string; from: { x: number; y: number } }): void {
    const s = this.addSite('Assault force', 'asset', a.from.x, a.from.y, 0, 250, true);
    s.role = 'assault';
    s.vuln *= this.mods.damageMult;
    s.onDestroyed = () => this.assaultEvent('destroyed');
    this.assaultOutcome = null;
    const dest = v3(a.x, a.y, this.terrain.groundAt(a.x, a.y) + 2);
    this.column = new Column('Assault column', v3(a.from.x, a.from.y, this.terrain.groundAt(a.from.x, a.from.y) + 2), dest, s, a.target, this.t);
    this.spawn(this.column);
    this.layoutSeq++;
  }

  /** The offensive is over either way: the column and its site leave the map. */
  endAssault(): void {
    const s = this.site('Assault force');
    if (s) this.removeSite(s);
    if (this.column) this.column.alive = false;
    this.column = null;
  }

  /** The enemy's armour sets off for one of our towns. */
  startEnemyAssault(e: { target: string; from: { x: number; y: number }; to: { x: number; y: number }; takeHp?: number }): void {
    this.enemyArmour = new EnemyArmour(e.target, e.from, e.to, e.takeHp, this.t);
  }

  /** The day's weather turns. */
  setWeather(id: WeatherId): void {
    this.weatherId = id;
    this.weather = WEATHER[id];
    const wx = Math.pow(10, this.weather.radarLossDb / 10);
    for (const r of this.allRadars()) r.wxLoss = r.spec.freqGHz >= 8 ? wx : 1;
  }

  /** Scrap a unit: its sites, radar, weapons and aircraft leave the war. */
  removeUnit(f: Fielded): void {
    for (const s of f.sites) this.removeSite(s);
    const drop = <T>(list: T[], x: T | undefined): void => {
      const i = x === undefined ? -1 : list.indexOf(x);
      if (i >= 0) list.splice(i, 1);
    };
    drop(this.radars, f.radar);
    drop(this.units, f.fu);
    drop(this.ciws, f.ciws);
    for (const fi of f.fighters ?? []) {
      drop(this.fighters, fi);
      fi.alive = false;
    }
    for (const list of [this.gnss, this.decoys, this.ewj] as { site: Site }[][]) {
      for (let i = list.length - 1; i >= 0; i--) if (f.sites.includes(list[i].site)) list.splice(i, 1);
    }
    drop(this.fielded, f);
    this.layoutSeq++;
  }

  /** One more loaded launcher for a SAM battery, standing at (x, y). */
  addLauncher(f: Fielded, x: number, y: number, rounds: number): void {
    const fu = f.fu;
    if (!fu || fu.type === 'SH') return;
    const s = this.addSite(`${fu.name} launcher ${fu.launchers.length + 1}`, 'launcher', x, y, 2, 6);
    s.vuln *= this.mods.damageMult;
    const launcher: Launcher = { site: s, rounds, max: rounds, reloadAt: 0 };
    s.onDestroyed = () => {
      launcher.rounds = 0;
    };
    fu.launchers.push(launcher);
    f.sites.push(s);
    this.layoutSeq++;
  }

  /** A replacement fighter joins a CAP pair from the airbase. */
  addFighter(f: Fielded): void {
    if (!f.fighters || this.site('Airbase')?.alive === false) return;
    const base = v3(0, 0, this.terrain.groundAt(0, 0));
    const n = this.fighters.length + 1;
    const fi = new Fighter(`Viper ${n}`, `F${n}`, base, v3(f.unit.x, f.unit.y, 8000), v3(base.x, base.y, 1500));
    this.fighters.push(fi);
    this.spawn(fi);
    f.fighters.push(fi);
  }

  /** Launch the quick reaction alert pair from the airbase, on station 20 km out towards the enemy. */
  addQra(missiles: number, fuelS: number): void {
    const ab = this.site('Airbase')!.pos;
    const base = v3(ab.x, ab.y, ab.z);
    const station = add(base, polar(this.terrain.layout.rot, 20000, 7000));
    for (let i = 0; i < 2; i++) {
      const n = this.fighters.length + 1;
      const fi = new Fighter(`Alert ${i + 1}`, `F${n}`, base, station, add(base, v3(i * 400, 0, 300)));
      fi.hdg = this.terrain.layout.rot;
      fi.spd = 200;
      fi.missiles = missiles;
      fi.fuel = fuelS;
      fi.oneSortie = true;
      this.fighters.push(fi);
      this.spawn(fi);
    }
    this.log('Quick reaction alert pair scrambled from the airbase', 'engage');
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
    return [...this.radars, ...this.decoys, ...this.ewj];
  }

  /** Is a point inside the reach (and line of sight) of one of our EW jammers that is on? */
  ewJammed(p: V3): boolean {
    return this.ewj.some((j) => j.isEmitting() && dist(p, j.pos) < j.rangeM && this.terrain.los(j.pos, p));
  }

  /** A weapon released under our jamming lands some way off its aim point. */
  private spoilAim(from: Entity, target: V3): V3 {
    if (!this.ewJammed(from.pos)) return target;
    this.log(`${from.name} targeting jammed: weapon released off aim`, 'info');
    const off = add(target, polar(this.rng.range(0, 360), this.rng.range(150, 400)));
    off.z = this.terrain.groundAt(off.x, off.y);
    return off;
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

  /** Display name of a fielded unit. */
  unitName(f: Fielded): string {
    return f.fu?.name ?? f.ciws?.name ?? f.radar?.name ?? f.sites[0]?.name ?? CATALOG[f.unit.type].name;
  }

  // ---------------------------------------------------------------- events

  /** A recon drone made it home: the enemy now knows what it photographed. */
  reconHome(d: ReconDrone): void {
    for (const p of d.seen) this.reconSeen.set(p.uid, p);
    if (d.seen.length) this.log(`${d.name} got away with pictures of ${d.seen.length} of our positions`, 'alert');
    this.retire(d);
  }

  /** Record and announce what happened to the assault force (see onAssault). */
  assaultEvent(o: AssaultOutcome): void {
    if (this.assaultOutcome === o || this.assaultOutcome === 'destroyed') return;
    this.assaultOutcome = o;
    this.onAssault?.(o, this);
  }

  log(msg: string, level: LogLevel = 'info'): void {
    this.logSeq++;
    this.logEntries.push({ t: this.t, msg, level });
    if (this.logEntries.length > 400) this.logEntries.splice(0, this.logEntries.length - 400);
  }

  effect(pos: V3, kind: Effect['kind']): void {
    this.effects.push({ id: this.nextEffect++, pos: clone(pos), t0: this.t, kind });
  }

  /** Kind used for objective counts: recon drones are told apart from attack drones. */
  static tally(e: Entity): string {
    return e.recon ? 'recon' : e.kind;
  }

  spawn(e: Entity): void {
    if (this.spawnTag >= 0 && e.pkg < 0) e.pkg = this.spawnTag;
    if (e.side === 'red') this.stats.spawnedKind[World.tally(e)] = (this.stats.spawnedKind[World.tally(e)] ?? 0) + 1;
    if (e.side === 'red' && e.pkg >= 0) this.tallyOf(e.pkg).spawned++;
    // A headwind slows the attack drones down.
    if (e instanceof Drone && this.weather.droneSpeed !== 1) {
      e.spd *= this.weather.droneSpeed;
      e.cmdSpd *= this.weather.droneSpeed;
    }
    this.entities.push(e);
    this.byId.set(e.id, e);
  }

  spawnLater(e: Entity, delay: number): void {
    if (this.spawnTag >= 0 && e.pkg < 0) e.pkg = this.spawnTag;
    this.pending.push({ t: this.t + delay, e });
  }

  /** An enemy installation has given itself away by launching: it goes on our map. */
  revealBase(b: EnemyBase): void {
    if (b.known || b.lost) return;
    b.known = true;
    this.layoutSeq++;
    this.log(`Launches detected from the ${b.name.toLowerCase()}: it is on the map now, and a deep strike can find it`, 'info');
  }

  private tallyOf(pkg: number): { spawned: number; down: number; hits: number; missed: number; home: number } {
    let t = this.pkgTally.get(pkg);
    if (!t) this.pkgTally.set(pkg, (t = { spawned: 0, down: 0, hits: 0, missed: 0, home: 0 }));
    return t;
  }

  /** A site of ours took `dmg` points of damage from `by` (an entity name, or 'artillery'). */
  noteHurt(by: string, dmg: number, site: string): void {
    if (dmg <= 0) return;
    const k = hurtBy(by);
    const h = this.hurt.get(k) ?? { dmg: 0, hits: 0, sites: new Set<string>() };
    h.dmg += dmg;
    h.hits++;
    h.sites.add(site);
    this.hurt.set(k, h);
  }

  /** Record how an entity died or left, once. */
  setFate(e: Entity, how: Fate['how'], by: string, extra: Partial<Fate> = {}): void {
    if (e.fate) return;
    e.fate = { how, by, t: this.t, pos: clone(e.pos), vel: clone(e.vel), air: how === 'missile' || how === 'gun' || how === 'laser', ...extra };
    this.deaths.push(e);
    if (e.side === 'red' && e.pkg >= 0) {
      const t = this.tallyOf(e.pkg);
      if (e.fate.air) t.down++;
      else if (how === 'exit') t.home++;
      else if (how === 'impact') {
        if (e.fate.hit) t.hits++;
        else t.missed++;
      }
    }
    // Enemy aircraft shot down are lost to their base for good.
    if (e.side === 'red' && !e.munition && e.fate.air) {
      const key = `${e.pkg}|${World.tally(e)}`;
      this.redAirLost.set(key, (this.redAirLost.get(key) ?? 0) + 1);
      this.redSupport.lost(this, e.kind);
      if (e instanceof ReconDrone && e.photos.size) {
        this.reconDenied++;
        this.log(`${e.name} shot down with ${e.photos.size} of our positions photographed: that intel never gets home (+$${RECON_BOUNTY_M}M in the campaign)`, 'engage');
      }
    }
  }

  /** An entity leaves the battle without being destroyed (egress, landing, end of flight). */
  retire(e: Entity): void {
    e.alive = false;
    this.setFate(e, 'exit', '');
  }

  /** A red warhead functions: damage every site inside its lethal radius. */
  detonate(e: Entity): void {
    e.alive = false;
    const wh = e.warhead;
    if (!wh) {
      this.setFate(e, 'impact', e.targetName, { hit: false });
      return;
    }
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
    // Supply trucks caught in the blast.
    for (const c of this.entities) {
      if (c.kind !== 'convoy' || !c.alive || dist(e.pos, c.pos) > wh.lethalR + 15) continue;
      c.alive = false;
      this.setFate(c, 'impact', e.name);
      this.log(`${c.name} destroyed on the road by ${e.name}: its missiles are lost`, 'damage');
      hit = true;
    }
    this.setFate(e, 'impact', e.targetName, { hit });
    if (hit) {
      this.stats.leakers++;
      if (e.pkg >= 0) this.pkgHits.set(e.pkg, (this.pkgHits.get(e.pkg) ?? 0) + 1);
    }
    else if (e.target) {
      this.log(`${e.name} impacted ${Math.round(dist(e.pos, e.target))} m from ${e.targetName}`, e.gnssJammed ? 'info' : 'alert');
    }
  }

  /** Destroy an entity in the air (missile kill, gun kill). */
  killEntity(e: Entity, by: string, shooter = by, how: 'missile' | 'gun' | 'laser' = 'missile'): void {
    if (!e.alive) return;
    e.alive = false;
    this.setFate(e, how, shooter);
    this.effect(e.pos, 'blast');
    if (e.decoy && how === 'missile') this.stats.decoyMissiles++;
    if (e.side === 'red') {
      this.stats.kills++;
      this.stats.killedKind[World.tally(e)] = (this.stats.killedKind[World.tally(e)] ?? 0) + 1;
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
    const overMountains = this.terrain.mountainSide(bearingDeg(v3(), from.pos)) && loc.v > this.terrain.layout.mtnFrom + 10000 && Math.abs(loc.u) < 60000;
    const route = overMountains ? this.terrain.passRoute(loc.u < this.terrain.passU(0, loc.v) / 2 + this.terrain.passU(1, loc.v) / 2 ? 0 : 1, loc.v) : [];
    const cm = new Cruise(this.nextName('ALCM'), start, route, this.spoilAim(from, target), name);
    cm.hdg = (from as unknown as { hdg: number }).hdg ?? 180;
    cm.pkg = from.pkg;
    this.spawn(cm);
    this.tracker.markHostileAct(this, from.pos);
  }

  /** A strike fighter releases a glide bomb at `target` (after `delay` s, for a stick of bombs). */
  launchBomb(from: Entity, target: V3, name: string, delay = 0): void {
    const b = new GlideBomb(this.nextName('GB'), from.pos, from.vel, this.spoilAim(from, target), name, this.t + delay);
    b.pkg = from.pkg;
    if (delay > 0) this.spawnLater(b, delay);
    else this.spawn(b);
    this.tracker.markHostileAct(this, from.pos);
  }

  /** An attack helicopter fires a guided missile at one of our sites. */
  launchAtgm(from: Entity, target: Site): void {
    const m = new Atgm(this.nextName('ATGM'), clone(from.pos), target, this.t);
    m.pkg = from.pkg;
    if (from instanceof Helo) {
      m.shooter = from;
      from.inFlight++;
      // Fired from the edge of its reach while tracked: the aim point is off.
      if (from.standoff && this.rng.chance(0.4)) m.target = v3(target.pos.x + this.rng.range(-40, 40), target.pos.y + this.rng.range(-40, 40), target.pos.z);
    }
    this.spawn(m);
    this.tracker.markHostileAct(this, from.pos);
  }

  /** A live enemy that keeps the raid open: anything attacking, but not the AWACS, the tanker or the AWACS's
   *  own guard fighters, which orbit far out and never come in. */
  isThreat(e: Entity): boolean {
    if (!e.alive || e.side !== 'red') return false;
    if (e.kind === 'awacs' || e.kind === 'tanker') return false;
    if (e.kind === 'redfighter' && (e as unknown as { guard: boolean }).guard) return false;
    return true;
  }

  /** The player ends the raid early: every enemy munition still in the air, and every attack aircraft still
   *  inbound, counts as a leaker. Returns how many. */
  abandonRaid(): number {
    let n = 0;
    for (const e of this.entities) {
      if (!this.isThreat(e) || e.kind === 'drone' && (e as { recon?: boolean }).recon) continue;
      if (e.munition || ((e.kind === 'strike' || e.kind === 'bomber' || e.kind === 'helo' || e.kind === 'drone') && Math.hypot(e.vel.x, e.vel.y) > 1 && e.pos.x * e.vel.x + e.pos.y * e.vel.y < 0)) n++;
    }
    this.stats.leakers += n;
    return n;
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
    // Experienced crews squeeze a kill out of some near misses.
    if (!kill && m.fu && m.fu.rank > 0 && this.rng.chance(0.08 * m.fu.rank)) kill = true;
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
    u.fire(this, tr, tr.cls === 'TBM' ? 2 : 1, true);
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
    if (r.stowed) {
      this.log(`${r.name} is packed up for a move`, 'info');
      return;
    }
    r.emitting = !r.emitting;
    r.armSilent = false;
    // A direct order takes the radar off its automatic preset.
    r.emcon = 'on';
    this.log(`${r.name} ${r.emitting ? 'radiating' : 'EMCON (silent)'}`, 'info');
  }

  /** Cycle a radar's emission control preset: always on, on when a threat is near, silent until engaged. */
  cycleEmcon(code: string): void {
    const r = this.radarByCode(code);
    if (!r) return;
    r.emcon = r.emcon === 'on' ? 'near' : r.emcon === 'near' ? 'engaged' : 'on';
    if (r.emcon === 'on' && !r.armSilent) r.emitting = true;
    this.log(`${r.name} emission control: ${EMCON_TEXT[r.emcon]}`, 'info');
  }

  /** Set a radar's emission preset directly, so a whole selection can share one. */
  setEmcon(code: string, preset: Radar['emcon']): void {
    const r = this.radarByCode(code);
    if (!r || r.emcon === preset) return;
    r.emcon = preset;
    if (preset === 'on' && !r.armSilent) r.emitting = true;
    this.log(`${r.name} emission control: ${EMCON_TEXT[preset]}`, 'info');
  }

  /** Hold fire on a SAM battery or gun, or release it, to a given state. */
  setHold(code: string, hold: boolean): void {
    const fu = this.unit(code);
    if (fu) {
      if (fu.hold !== hold) fu.setHold(this, hold);
      return;
    }
    const c = this.ciws.find((x) => x.code === code);
    if (c && c.auto === hold) this.toggleHold(code);
  }

  /** Radars on an automatic emission preset: radiate only while a hostile is close enough to matter. */
  private stepEmcon(): void {
    if (this.t < this.nextEmcon) return;
    this.nextEmcon = this.t + 1;
    for (const f of this.fielded) {
      const r = f.fu?.radar ?? f.radar;
      if (!r || r.emcon === 'on' || !r.alive || r.stowed || r.armSilent) continue;
      const weapon = f.fu?.spec.maxRangeM ?? 0;
      const reach = r.emcon === 'engaged' && weapon ? weapon * 0.9 : Math.max(60000, weapon * 1.6);
      const threat = this.tracker.tracks.some((tr) => tr.confirmed && !tr.dropped && tr.ident === 'HOS' && hdist(tr.predict(this.t), r.pos) < reach);
      if (threat) r.emconHold = this.t + 20;
      const want = this.t < r.emconHold;
      if (want !== r.emitting) {
        r.emitting = want;
        this.log(`${r.name} ${want ? 'radiating: threat within reach' : 'back to EMCON: no threat near'}`, 'info');
      }
    }
  }

  /** Order a unit (by any of its codes) to move to (x, y). Returns why it cannot, or null. */
  moveUnit(code: string, x: number, y: number): string | null {
    const f = this.fieldedByCode(code);
    if (!f) return 'no such unit';
    const err = orderMove(this, f, x, y);
    if (!err) this.layoutSeq++;
    return err;
  }

  /** The fielded unit a HUD code (fire unit, gun, radar, or F<index> for a fighter) belongs to. */
  fieldedByCode(code: string): Fielded | undefined {
    if (/^F\d+$/.test(code)) {
      const fi = this.fighters[Number(code.slice(1))];
      return this.fielded.find((f) => f.fighters?.includes(fi));
    }
    return this.fielded.find((f) => f.fu?.code === code || f.ciws?.code === code || f.radar?.code === code);
  }

  /** Shoot and scoot: move a unit (by any of its codes) to good ground a few km away. */
  scootUnit(code: string): string | null {
    const f = this.fieldedByCode(code);
    if (!f) return 'no such unit';
    const err = scoot(this, f);
    if (!err) this.layoutSeq++;
    return err;
  }

  /** Hold fire on a SAM battery or gun (by code), or release it. */
  toggleHold(code: string): void {
    const fu = this.unit(code);
    if (fu) return fu.setHold(this, !fu.hold);
    const c = this.ciws.find((x) => x.code === code);
    if (c) {
      c.auto = !c.auto;
      this.log(`${c.name} ${c.auto ? 'AUTO' : 'HOLD FIRE'}`, 'info');
    }
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
    if (stepMoves(this, dt)) this.layoutSeq++;
    stepSupport(this);
    this.stepGnss(dt);
    this.stepArmWatch();
    this.stepEmcon();

    const reports: Report[] = [];
    for (const r of this.allRadars()) {
      r.step(this, dt, reports);
      if (r.isEmitting()) this.radiating.set(r.code, (this.radiating.get(r.code) ?? 0) + dt);
    }
    this.tracker.process(this, reports);

    for (const u of this.units) u.update(this);
    this.exposure.step(this);
    this.enemyAd.step(this);
    this.enemyArmour?.step(this, dt);
    if (this.ground && (this.groundAcc += dt) >= 1) {
      this.ground.step(this, this.groundAcc);
      this.groundAcc = 0;
    }
    if (this.t >= this.nextTewa) {
      this.nextTewa = this.t + 1;
      autoEngage(this);
    }
    for (const m of this.missiles) if (m.alive) m.update(this, dt);
    for (const c of this.ciws) c.update(this, dt);

    if (this.entities.some((e) => !e.alive)) {
      this.entities = this.entities.filter((e) => {
        if (e.alive || e instanceof Fighter) return true;
        if (!e.fate) this.setFate(e, 'exit', '');
        this.byId.delete(e.id);
        return false;
      });
    }
    if (this.missiles.some((m) => !m.alive)) this.missiles = this.missiles.filter((m) => m.alive);
    if (this.deaths.length && this.t - this.deaths[0].fate!.t > 20) this.deaths = this.deaths.filter((e) => this.t - e.fate!.t <= 20);
    if (this.effects.length && this.t - this.effects[0].t0 > 6) this.effects = this.effects.filter((f) => this.t - f.t0 <= 6);
  }
}
