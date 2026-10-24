import { V3, add, addScaled, angleBetween, clamp, clone, dist, dot, hdist, norm, polar, sub, v3 } from './math';
import { Air } from './entities';
import { AAM_MSL, Interceptor } from './missile';
import { AI_RADAR, Radar } from './radar';
import { wcsAllows } from './tewa';
import type { World } from './world';

export type CapState = 'station' | 'intercept' | 'rtb' | 'ground';

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
  targetTrackId: number | null = null;
  groundUntil = 0;
  aam: Interceptor | null = null;
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
    if (!this.airborne) return;
    this.state = 'station';
    this.targetTrackId = null;
    w.log(`${this.name} returning to CAP station`, 'info');
  }

  rtb(w: World): void {
    if (!this.airborne) return;
    this.state = 'rtb';
    this.targetTrackId = null;
    w.log(`${this.name} RTB`, 'info');
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
      case 'rtb': {
        this.steer(this.base.x, this.base.y, dt);
        this.cmdAlt = this.base.z + 1500;
        this.cmdSpd = 280;
        if (hdist(this.pos, this.base) < 3000) {
          this.state = 'ground';
          this.airborne = false;
          this.groundUntil = w.t + 240;
          this.pos = clone(this.base);
          this.vel = v3();
          w.log(`${this.name} landed, rearming and refuelling (4 min)`, 'info');
          return;
        }
        break;
      }
    }
    this.integrate(w, dt);
  }
}
