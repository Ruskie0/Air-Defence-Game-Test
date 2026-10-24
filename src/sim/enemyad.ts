import { Entity } from './entities';
import type { Fighter } from './fighter';
import { V3, add, clone, dist, hdist, norm, scale, sub, v3 } from './math';
import { Site } from './sites';
import { type EnemyBase, avail, draw } from './theatre';
import type { World } from './world';

/**
 * Enemy air defence in battle: the theatre's SAM sites (BaseKind 'sam', one in each town the enemy holds). Each
 * has a radar and a stock of missiles. The SAM fires at our fighters in reach; while the radar stands, our
 * batteries it can see give themselves away faster, and it spots for artillery on an assault force near it.
 * Fighters sweep a site (run in low, pop up, release stand-off weapons, go home) to knock it out for good.
 * Game-level numbers.
 */
export const ENEMY_AD = {
  samRangeM: 35000,
  /** It only sees a fighter running in low this close. */
  lowSeenM: 12000,
  samCooldownS: 25,
  /** Kill chance of an enemy SAM that reaches our fighter. */
  samPk: 0.45,
  radarRangeM: 45000,
  /** Exposure builds this much faster for our batteries the radar can see. */
  exposureMult: 1.3,
  /** Damage to the assault force per artillery barrage the radar spots, and how often; spotting range. */
  artilleryDmg: 1.5,
  artilleryS: 75,
  spotM: 15000,
  /** Stand-off weapons: release range from the target, flight time, and kill chance. */
  sweepReleaseM: 18000,
  sweepFlightS: 25,
  sweepPk: 0.75,
};

/** A SAM site in this battle: its theatre base and the ground target our weapons aim at. */
export interface AdSite {
  base: EnemyBase;
  site: Site;
  nextShot: number;
}

interface Strike {
  t: number;
  ad: AdSite;
  by: string;
}

export class EnemyAd {
  readonly sites: AdSite[] = [];
  private readonly strikes: Strike[] = [];
  private nextStep = 0;
  private nextBarrage = 0;
  private barrages = 0;

  /** Every SAM site still in the war; its Site is kept apart from our own sites. */
  constructor(w: World) {
    for (const b of w.theatre) {
      if (b.kind !== 'sam' || b.lost) continue;
      const site = new Site(b.name, 'launcher', v3(b.x, b.y, w.terrain.groundAt(b.x, b.y)), 60);
      this.sites.push({ base: b, site, nextShot: 0 });
    }
  }

  get missiles(): number {
    return this.sites.reduce((n, a) => n + (a.site.alive ? avail(a.base, 'sam') : 0), 0);
  }

  /** Sites still standing that our intel has found: the ones a fighter can sweep. */
  targets(): AdSite[] {
    return this.sites.filter((a) => a.site.alive && a.base.known);
  }

  /** Whether an enemy radar can see this spot (our batteries there give themselves away faster). */
  watched(w: World, p: V3): boolean {
    return this.sites.some((a) => a.site.alive && hdist(a.site.pos, p) < ENEMY_AD.radarRangeM && w.terrain.los(add(a.site.pos, v3(0, 0, 15)), add(p, v3(0, 0, 10))));
  }

  /** A fighter releases stand-off weapons at a site. */
  release(w: World, f: Fighter, id: string): void {
    const ad = this.sites.find((a) => a.base.id === id && a.site.alive);
    if (ad) this.strikes.push({ t: w.t + ENEMY_AD.sweepFlightS, ad, by: f.name });
  }

  step(w: World): void {
    for (let i = this.strikes.length - 1; i >= 0; i--) {
      const s = this.strikes[i];
      if (w.t < s.t) continue;
      this.strikes.splice(i, 1);
      const { site, base } = s.ad;
      if (!site.alive) continue;
      w.effect(site.pos, 'ground');
      if (w.rng.chance(ENEMY_AD.sweepPk)) {
        site.hp = 0;
        site.alive = false;
        base.lost = true;
        base.known = true;
        w.log(`${s.by}'s weapons destroyed the ${base.name}`, 'kill');
        base.stock = {};
      } else w.log(`${s.by}'s weapons missed the ${base.name}`, 'info');
    }
    if (w.t < this.nextStep) return;
    this.nextStep = w.t + 1;
    for (const a of this.sites) {
      if (!a.site.alive || avail(a.base, 'sam') <= 0 || w.t < a.nextShot) continue;
      const eye = add(a.site.pos, v3(0, 0, 12));
      // Fighters running in low stay under its horizon until they are close.
      const tgt = w.fighters.find((f) => f.alive && f.airborne && hdist(f.pos, eye) < (f.low ? ENEMY_AD.lowSeenM : ENEMY_AD.samRangeM) && w.terrain.los(eye, f.pos));
      if (!tgt) continue;
      draw(a.base, 'sam', 1);
      a.nextShot = w.t + ENEMY_AD.samCooldownS;
      w.spawn(new RedSam(w.nextName('SA'), eye, tgt, w.t));
      w.tracker.markHostileAct(w, eye);
      if (!a.base.known) {
        a.base.known = true;
        w.log(`Enemy SAM site located by its launch: ${a.base.name}`, 'alert');
        w.layoutSeq++;
      }
      w.log(`Enemy SAM launch from the ${a.base.name} at ${tgt.name}!`, 'alert');
    }
    // A radar near the assault force spots for artillery on it.
    const assault = w.sites.find((x) => x.role === 'assault' && x.alive);
    if (assault && w.t >= this.nextBarrage) {
      this.nextBarrage = w.t + ENEMY_AD.artilleryS;
      const spotter = this.sites.find((a) => a.site.alive && hdist(a.site.pos, assault.pos) < ENEMY_AD.spotM);
      if (spotter) {
        assault.damage(w, ENEMY_AD.artilleryDmg / assault.vuln, 'artillery');
        w.effect(assault.pos, 'ground');
        if (this.barrages++ === 0) w.log(`The ${spotter.base.name} is spotting for artillery: the assault force is under fire until it is knocked out`, 'alert');
      }
    }
  }
}

/** Enemy surface-to-air missile: flies a pure pursuit at one of our fighters. */
export class RedSam extends Entity {
  readonly kind = 'rsam' as const;
  readonly side = 'red' as const;
  private readonly tgt: Fighter;
  private readonly t0: number;
  private readonly pk: number;
  /** What fired it, for the log: 'an enemy SAM' or 'an enemy fighter'. */
  private readonly by: string;

  constructor(name: string, pos: V3, tgt: Fighter, t0: number, pk = ENEMY_AD.samPk, by = 'an enemy SAM') {
    super(name, pos);
    this.tgt = tgt;
    this.t0 = t0;
    this.pk = pk;
    this.by = by;
    this.vel = scale(norm(sub(tgt.pos, pos)), 300);
    // Not for our radars to track: it is over in seconds and nothing of ours shoots at it.
    this.rcs = 0;
    this.hitRadius = 1;
    this.munition = true;
  }

  update(w: World, dt: number): void {
    const t = this.tgt;
    const spd = Math.min(800, 300 + (w.t - this.t0) * 150);
    this.vel = scale(norm(sub(t.pos, this.pos)), spd);
    this.pos = add(this.pos, scale(this.vel, dt));
    if (t.alive && t.airborne && dist(this.pos, t.pos) < 60) {
      this.alive = false;
      w.effect(clone(this.pos), 'blast');
      if (w.rng.chance(this.pk)) {
        t.alive = false;
        w.setFate(t, 'missile', this.name);
        w.log(`${t.name} SHOT DOWN by ${this.by}`, 'damage');
      } else w.log(`${t.name} defeated ${this.by.replace('an ', 'a missile from an ')} with chaff and a hard turn`, 'info');
      w.setFate(this, 'exit', t.name);
      return;
    }
    if (w.t - this.t0 > 60 || !t.alive || !t.airborne) {
      this.alive = false;
      w.setFate(this, 'exit', t.name);
    }
  }
}
