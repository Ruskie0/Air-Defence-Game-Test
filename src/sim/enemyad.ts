import { Entity } from './entities';
import type { Fighter } from './fighter';
import { V3, add, clone, dist, hdist, norm, polar, scale, sub, v3 } from './math';
import type { Site, SiteKind } from './sites';
import type { World } from './world';

/**
 * Enemy air defences in the towns the enemy holds up the front line: a SAM site that shoots at our fighters
 * and a radar that watches our side. While the radar stands, our batteries within its reach give themselves
 * away faster, and if our assault force is attacking its town it calls artillery onto it. Fighters can sweep
 * a town (fly in low, release stand-off weapons, get out) to knock them out. Game-level numbers.
 */
export const ENEMY_AD = {
  samRangeM: 35000,
  samCooldownS: 25,
  samShots: 6,
  /** Kill chance of an enemy SAM that reaches our fighter. */
  samPk: 0.45,
  /** It only sees a fighter running in low this close. */
  lowSeenM: 12000,
  radarRangeM: 45000,
  /** Exposure builds this much faster for our batteries the radar can see. */
  exposureMult: 1.3,
  /** Damage to the assault force per artillery barrage the radar spots, and how often. */
  artilleryDmg: 1.5,
  artilleryS: 75,
  /** Stand-off weapons: release range from the target, flight time, and kill chance. */
  sweepReleaseM: 18000,
  sweepFlightS: 25,
  sweepPk: 0.75,
};

export interface EnemyTownAd {
  name: string;
  x: number;
  y: number;
  sam: boolean;
  radar: boolean;
}

interface AdSite {
  town: string;
  site: Site;
  kind: 'sam' | 'radar';
  shots: number;
  nextShot: number;
}

/** A stand-off weapon in flight from a sweep, decided when it arrives. */
interface Strike {
  t: number;
  site: Site;
  by: string;
}

export class EnemyAd {
  readonly sites: AdSite[] = [];
  private readonly strikes: Strike[] = [];
  private nextStep = 0;
  private nextBarrage = 0;
  private barrages = 0;

  /** Place each town's SAM and radar a little apart, on its far side from us. */
  constructor(w: World, towns: EnemyTownAd[], addSite: (name: string, kind: SiteKind, x: number, y: number) => Site) {
    for (const tn of towns) {
      const away = Math.atan2(tn.x, tn.y) * (180 / Math.PI);
      if (tn.sam) {
        const p = add(v3(tn.x, tn.y), polar(away + 50, 1800));
        this.sites.push({ town: tn.name, kind: 'sam', site: addSite(`${tn.name} SAM`, 'launcher', p.x, p.y), shots: ENEMY_AD.samShots, nextShot: 0 });
      }
      if (tn.radar) {
        const p = add(v3(tn.x, tn.y), polar(away - 50, 1800));
        this.sites.push({ town: tn.name, kind: 'radar', site: addSite(`${tn.name} radar`, 'radar', p.x, p.y), shots: 0, nextShot: 0 });
      }
    }
    void w;
  }

  /** The enemy-held towns that still have something standing. */
  towns(): string[] {
    return [...new Set(this.sites.filter((s) => s.site.alive).map((s) => s.town))];
  }

  /** Whether an enemy radar can see this spot (our batteries there give themselves away faster). */
  watched(w: World, p: V3): boolean {
    return this.sites.some((s) => s.kind === 'radar' && s.site.alive && hdist(s.site.pos, p) < ENEMY_AD.radarRangeM && w.terrain.los(s.site.pos, add(p, v3(0, 0, 10))));
  }

  /** A fighter releases stand-off weapons at what stands in a town. */
  release(w: World, f: Fighter, town: string): number {
    const targets = this.sites.filter((s) => s.town === town && s.site.alive).sort((a, b) => (a.kind === 'sam' ? -1 : 1) - (b.kind === 'sam' ? -1 : 1));
    for (const s of targets) this.strikes.push({ t: w.t + ENEMY_AD.sweepFlightS, site: s.site, by: f.name });
    return targets.length;
  }

  step(w: World): void {
    for (let i = this.strikes.length - 1; i >= 0; i--) {
      const s = this.strikes[i];
      if (w.t < s.t) continue;
      this.strikes.splice(i, 1);
      if (!s.site.alive) continue;
      if (w.rng.chance(ENEMY_AD.sweepPk)) {
        s.site.hp = 0;
        s.site.alive = false;
        w.effect(s.site.pos, 'ground');
        w.log(`${s.by}'s weapons destroyed the ${s.site.name}`, 'kill');
      } else {
        w.effect(s.site.pos, 'ground');
        w.log(`${s.by}'s weapon missed the ${s.site.name}`, 'info');
      }
    }
    if (w.t < this.nextStep) return;
    this.nextStep = w.t + 1;
    for (const s of this.sites) {
      if (s.kind !== 'sam' || !s.site.alive || s.shots <= 0 || w.t < s.nextShot) continue;
      const eye = add(s.site.pos, v3(0, 0, 12));
      // Fighters running in low stay under its horizon until they are close.
      const tgt = w.fighters.find((f) => f.alive && f.airborne && hdist(f.pos, eye) < (f.low ? ENEMY_AD.lowSeenM : ENEMY_AD.samRangeM) && w.terrain.los(eye, f.pos));
      if (!tgt) continue;
      s.shots--;
      s.nextShot = w.t + ENEMY_AD.samCooldownS;
      w.spawn(new RedSam(w.nextName('SA'), eye, tgt, w.t));
      w.tracker.markHostileAct(w, eye);
      w.log(`Enemy SAM launch from ${s.town} at ${tgt.name}!`, 'alert');
    }
    // The radar in the town our assault force is attacking calls artillery onto it.
    const assault = w.sites.find((x) => x.role === 'assault' && x.alive);
    if (assault && w.t >= this.nextBarrage) {
      this.nextBarrage = w.t + ENEMY_AD.artilleryS;
      const spotter = this.sites.find((s) => s.kind === 'radar' && s.site.alive && hdist(s.site.pos, assault.pos) < 15000);
      if (spotter) {
        assault.damage(w, ENEMY_AD.artilleryDmg / assault.vuln, `${spotter.town} artillery`);
        w.effect(assault.pos, 'ground');
        if (this.barrages++ === 0) w.log(`The ${spotter.site.name} is spotting for artillery: the assault force is under fire until it is knocked out`, 'alert');
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

  constructor(name: string, pos: V3, tgt: Fighter, t0: number) {
    super(name, pos);
    this.tgt = tgt;
    this.t0 = t0;
    this.vel = scale(norm(sub(tgt.pos, pos)), 300);
    this.rcs = 0.1;
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
      if (w.rng.chance(ENEMY_AD.samPk)) {
        t.alive = false;
        w.setFate(t, 'missile', this.name);
        w.log(`${t.name} SHOT DOWN by an enemy SAM`, 'damage');
      } else w.log(`${t.name} defeated an enemy SAM with chaff and a hard turn`, 'info');
      w.setFate(this, 'exit', t.name);
      return;
    }
    if (w.t - this.t0 > 60 || !t.alive || !t.airborne) {
      this.alive = false;
      w.setFate(this, 'exit', t.name);
    }
  }
}
