import { V3, add, addScaled, angleBetween, clamp, clone, dist, dot, hdist, norm, polar, sub, v3 } from './math';
import { Air } from './entities';
import { ENEMY_AD } from './enemyad';
import { AAM_MSL, Interceptor } from './missile';
import { AI_RADAR, Radar } from './radar';
import { wcsAllows } from './tewa';
import type { World } from './world';

export type CapState = 'station' | 'intercept' | 'sweep' | 'hunt' | 'rtb' | 'ground';

/** Friendly fighter on combat air patrol, datalinked to the fused picture, armed with active radar AAMs. */
export class Fighter extends Air {
  readonly kind = 'fighter' as const;
  readonly side = 'blue' as const;
  readonly radar: Radar;
  readonly base: V3;
  station: V3;
  missiles = 4;
  readonly maxFuel = 3600;
  fuel = 3600;
  state: CapState = 'station';
  /** Quick reaction alert: flies one sortie and stays down once it lands. */
  oneSortie = false;
  targetTrackId: number | null = null;
  groundUntil = 0;
  aam: Interceptor | null = null;
  /** Escorting the assault column: patrol over it and take on anything hostile that comes near it. */
  escort = false;
  private nextEscortLook = 0;
  /** The CAP station to go back to after an escort. */
  private home: V3 | null = null;
  /** Stand-off weapons for a sweep of an enemy-held town: one load per sortie. */
  standoff = 1;
  /** The enemy-held town being swept, and until when the fighter is popped up after releasing. */
  sweepId: string | null = null;
  private popUntil = 0;
  /** The enemy support aircraft being hunted ('awacs' or 'tanker'). */
  huntKind: string | null = null;
  private leg = 0;

  constructor(name: string, code: string, base: V3, station: V3, start: V3) {
    super(name, start, 0, 260);
    this.base = clone(base);
    this.station = clone(station);
    this.rcs = 4;
    this.hitRadius = 8;
    this.iff = 'M5';
    this.cmdAlt = station.z;
    this.turnRate = 6;
    this.climb = 120;
    this.accel = 15;
    this.radar = new Radar(code, `${name} radar`, AI_RADAR, start, 'LR');
    this.radar.platform = this;
  }

  intercept(w: World, trackId: number): void {
    if (!this.airborne) {
      w.log(`${this.name} is on the ground rearming`, 'info');
      return;
    }
    if (this.missiles === 0) {
      w.log(`${this.name} has no missiles left`, 'info');
      return;
    }
    this.state = 'intercept';
    this.targetTrackId = trackId;
    const tr = w.tracker.get(trackId);
    w.log(`${this.name} committed on ${tr?.label ?? 'track'}`, 'engage');
  }

  toStation(w: World, st?: V3): void {
    if (st) this.station = clone(st);
    if (!this.airborne || !this.alive) return;
    this.state = 'station';
    this.targetTrackId = null;
    w.log(`${this.name} returning to CAP station`, 'info');
  }

  /** Escort the assault column: patrol just ahead of it and engage hostiles closing on it. */
  escortColumn(w: World, on = true): void {
    if (on && (!w.column?.alive || !this.alive)) return;
    if (on && !this.escort) this.home = clone(this.station);
    if (!on && this.home) this.station = this.home;
    this.escort = on;
    if (on) {
      w.log(`${this.name} escorting the assault column`, 'info');
      if (this.airborne && this.state === 'station') this.leg = 0;
    } else w.log(`${this.name} released from escort`, 'info');
  }

  /** Sweep an enemy SAM site: run in low, pop up to release stand-off weapons at it, go home. */
  sweep(w: World, id: string): void {
    const why = this.sweepError(w, id);
    if (why) {
      w.log(`${this.name}: ${why}`, 'info');
      return;
    }
    this.state = 'sweep';
    this.sweepId = id;
    this.targetTrackId = null;
    w.log(`${this.name} sweeping the ${w.enemyAd.sites.find((a) => a.base.id === id)?.base.name}: running in low`, 'engage');
  }

  /** Go deep after the enemy AWACS or tanker: fly out to its racetrack and fire on it from long range. */
  hunt(w: World, kind: string): void {
    const why = this.huntError(w, kind);
    if (why) {
      w.log(`${this.name}: ${why}`, 'info');
      return;
    }
    this.state = 'hunt';
    this.huntKind = kind;
    this.targetTrackId = null;
    w.log(`${this.name} going deep after the enemy ${kind === 'awacs' ? 'AWACS' : 'tanker'}`, 'engage');
  }

  huntError(w: World, kind: string): string | null {
    if (!this.alive || !this.airborne) return 'not airborne';
    if (this.missiles === 0) return 'no missiles left';
    if (!w.redSupport.target(kind)) return 'not flying';
    return null;
  }

  sweepError(w: World, id: string): string | null {
    if (!this.alive || !this.airborne) return 'not airborne';
    if (this.standoff <= 0) return 'no stand-off weapons left this sortie';
    if (!w.enemyAd.targets().some((a) => a.base.id === id)) return 'that site is gone or not located';
    return null;
  }

  /** Low enough to stay under an enemy SAM radar's horizon until it pops up. */
  get low(): boolean {
    return this.state === 'sweep' && this.tfAgl !== null && this.tfAgl < 300;
  }

  rtb(w: World): void {
    if (!this.airborne) return;
    this.state = 'rtb';
    this.targetTrackId = null;
    w.log(`${this.name} RTB`, 'info');
  }

  private stepEscort(w: World): void {
    const col = w.column;
    if (!col?.alive) {
      this.escort = false;
      if (this.home) this.station = this.home;
      return;
    }
    // Patrol a few km ahead of the column, towards the enemy.
    const ahead = add(col.pos, polar(w.terrain.layout.rot, 6000));
    this.station = v3(ahead.x, ahead.y, Math.max(this.station.z, w.terrain.groundAt(ahead.x, ahead.y) + 4000));
    if (this.state !== 'station' || w.t < this.nextEscortLook || this.missiles === 0) return;
    this.nextEscortLook = w.t + 2;
    let best: { id: number; d: number } | null = null;
    for (const tr of w.tracker.tracks) {
      if (!tr.confirmed || tr.dropped || tr.ident !== 'HOS' || tr.cls === 'TBM') continue;
      const d = hdist(tr.predict(w.t), col.pos);
      if (d < 25000 && (!best || d < best.d)) best = { id: tr.id, d };
    }
    if (best && !w.fighters.some((f) => f !== this && f.targetTrackId === best!.id)) this.intercept(w, best.id);
  }

  /** On CAP: take on a hostile fast jet that comes within 35 km (enemy fighters sweeping our CAP). */
  private selfDefence(w: World): void {
    if (this.state !== 'station' || !this.airborne || w.t < this.nextEscortLook || this.missiles === 0) return;
    this.nextEscortLook = w.t + 2;
    for (const tr of w.tracker.tracks) {
      if (!tr.confirmed || tr.dropped || tr.ident !== 'HOS' || tr.cls !== 'FW') continue;
      if (hdist(tr.predict(w.t), this.pos) < 35000 && !w.fighters.some((f) => f !== this && f.targetTrackId === tr.id)) {
        this.intercept(w, tr.id);
        return;
      }
    }
  }

  /** Launch range: long against closing targets, short in a tail chase. */
  private aamRange(tgtPos: V3, tgtVel: V3): number {
    const los = norm(sub(tgtPos, this.pos));
    const closing = dot(los, sub(this.vel, tgtVel));
    return clamp(32000 + closing * 70, 15000, AAM_MSL.maxRangeM);
  }

  update(w: World, dt: number): void {
    if (this.state === 'ground') {
      if (w.t >= this.groundUntil) {
        this.airborne = true;
        this.missiles = 4;
        this.standoff = 1;
        this.fuel = this.maxFuel;
        this.pos = v3(this.base.x, this.base.y, this.base.z + 300);
        this.spd = 160;
        this.hdg = 0;
        this.state = 'station';
        w.log(`${this.name} airborne, proceeding to CAP`, 'info');
      }
      return;
    }
    this.fuel -= dt * (this.spd > 340 ? 2.4 : 1);
    if (this.fuel < 420 && this.state !== 'rtb') {
      this.state = 'rtb';
      w.log(`${this.name} bingo fuel, RTB`, 'info');
    }
    if (this.aam && !this.aam.alive) this.aam = null;
    if (this.escort) this.stepEscort(w);
    else this.selfDefence(w);
    if (this.state !== 'sweep') this.tfAgl = null;
    if (this.state !== 'hunt') this.huntKind = null;

    switch (this.state) {
      case 'station': {
        const legs = [add(this.station, polar(90, 15000)), add(this.station, polar(270, 15000))];
        const p = legs[this.leg];
        if (hdist(this.pos, p) < 2500) this.leg = 1 - this.leg;
        this.steer(p.x, p.y, dt);
        this.cmdAlt = this.station.z;
        this.cmdSpd = 260;
        break;
      }
      case 'intercept': {
        const tr = this.targetTrackId !== null ? w.tracker.get(this.targetTrackId) : undefined;
        if (!tr) {
          this.toStation(w);
          break;
        }
        const p = tr.predict(w.t);
        const v = tr.velAt(w.t);
        const lead = Math.min(dist(this.pos, p) / 700, 40);
        const aim = addScaled(p, v, lead);
        this.steer(aim.x, aim.y, dt);
        this.cmdAlt = clamp(p.z + 300, 1500, 12500);
        this.cmdSpd = 420;
        const R = dist(this.pos, p);
        const off = angleBetween(this.vel, sub(p, this.pos));
        // Rules of engagement: hold the shot unless the weapons control status allows this identity.
        const cleared = wcsAllows(w.wcs, tr.ident);
        if (!cleared && (tr.ident === 'NEU' || tr.ident === 'FRD')) {
          this.toStation(w);
          break;
        }
        if (cleared && !this.aam && this.missiles > 0 && tr.confirmed && w.t - tr.t < 3 && w.t > tr.kaUntil && R < this.aamRange(p, v) && R > AAM_MSL.minRangeM && off < 45) {
          this.missiles--;
          this.aam = new Interceptor(w, AAM_MSL, null, this.name, this.pos, p, clone(this.vel), tr.id);
          w.missiles.push(this.aam);
          w.stats.fired.AAM++;
          w.stats.costM += AAM_MSL.costM;
          w.log(`${this.name} Fox 3 on ${tr.label} at ${(R / 1000).toFixed(0)} km`, 'engage');
        }
        if (this.missiles === 0 && !this.aam) this.rtb(w);
        break;
      }
      case 'sweep': {
        const ad = w.enemyAd;
        const tgts = ad.sites.filter((a) => a.base.id === this.sweepId && a.site.alive);
        if (w.t < this.popUntil) {
          // Popped up to release, then turns for home.
          this.tfAgl = 1500;
          this.cmdSpd = 300;
          this.steer(this.base.x, this.base.y, dt);
          break;
        }
        if (this.popUntil > 0) {
          this.popUntil = 0;
          this.sweepId = null;
          this.rtb(w);
          break;
        }
        if (!tgts.length) {
          this.sweepId = null;
          this.toStation(w);
          break;
        }
        const aim = tgts[0].site.pos;
        this.steer(aim.x, aim.y, dt);
        this.tfAgl = 150;
        this.cmdSpd = 300;
        if (hdist(this.pos, aim) < ENEMY_AD.sweepReleaseM) {
          ad.release(w, this, this.sweepId!);
          this.standoff--;
          this.popUntil = w.t + 15;
          w.log(`${this.name} pops up and releases on the ${tgts[0].base.name}`, 'engage');
        }
        break;
      }
      case 'hunt': {
        const tgt = w.redSupport.target(this.huntKind ?? '');
        if (!tgt || (this.missiles === 0 && !this.aam)) {
          this.huntKind = null;
          if (this.missiles === 0) this.rtb(w);
          else this.toStation(w);
          break;
        }
        this.steer(tgt.pos.x, tgt.pos.y, dt);
        this.cmdAlt = clamp(tgt.pos.z, 1500, 12500);
        this.cmdSpd = 320;
        const R = dist(this.pos, tgt.pos);
        const off = angleBetween(this.vel, sub(tgt.pos, this.pos));
        // A big target that sees it coming and runs: the fighter has to close well inside its usual range to make the shot stick.
        if (!this.aam && this.missiles > 0 && R < clamp(this.aamRange(tgt.pos, tgt.vel) * 0.6, 15000, 35000) && off < 45) {
          this.missiles--;
          this.aam = new Interceptor(w, AAM_MSL, null, this.name, this.pos, tgt.pos, clone(this.vel), -1);
          this.aam.home = tgt;
          w.missiles.push(this.aam);
          w.stats.fired.AAM++;
          w.stats.costM += AAM_MSL.costM;
          w.log(`${this.name} Fox 3 on the enemy ${this.huntKind === 'awacs' ? 'AWACS' : 'tanker'} at ${(R / 1000).toFixed(0)} km`, 'engage');
        }
        break;
      }
      case 'rtb': {
        this.steer(this.base.x, this.base.y, dt);
        this.cmdAlt = this.base.z + 1500;
        this.cmdSpd = 280;
        if (hdist(this.pos, this.base) < 3000) {
          this.state = 'ground';
          this.airborne = false;
          this.groundUntil = this.oneSortie ? Infinity : w.t + 240;
          this.pos = clone(this.base);
          this.vel = v3();
          w.log(this.oneSortie ? `${this.name} landed, alert sortie over` : `${this.name} landed, rearming and refuelling (4 min)`, 'info');
          return;
        }
        break;
      }
    }
    this.integrate(w, dt);
  }
}
