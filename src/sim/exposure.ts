import { Cruise, Drone } from './entities';
import { add, hdist, polar, v3 } from './math';
import { type Asset, type EnemyBase, basesWith, draw } from './theatre';
import { tbmFrom, tbmFlightS } from './threats';
import type { Fielded, World } from './world';

/**
 * Shoot and scoot. Every missile a battery launches, and every minute its big radar radiates, gives its
 * position away a little more. When its exposure fills, the enemy has located it and sends a counter-battery
 * strike at that spot about a minute later. The player can move the battery, go silent, or defend it.
 * Game-level numbers, not real sensor physics.
 */
export const EXPOSURE = {
  /** Exposure per missile launched, by fire unit type. */
  launch: { LR: 16, MR: 16, SH: 9 } as Record<string, number>,
  /** Per second while radiating: the big radars, and SHORAD's small search radar. */
  radiate: { LR: 0.1, MR: 0.1, EWR: 0.1, SH: 0.03 } as Record<string, number>,
  /** Lost per second while silent. */
  decay: 0.5,
  threshold: 100,
  /** Shortest gap between two counter-battery strikes (s). */
  cooldownS: 120,
};

/** A battery the enemy has located, and the strike on its way to where it stood. */
export interface Located {
  uid: number;
  unit: string;
  x: number;
  y: number;
  /** When it was located, and when the strike is due (sim s). */
  t: number;
  eta: number;
  weapon: string;
  /** The battery has moved away from the spot since. */
  moved: boolean;
  /** The strike has landed (or should have): the marker comes off the map. */
  over?: boolean;
}

/** Counter-battery strikes the enemy has for a battle at this level (campaign day, or a Last Stand wave). */
export const cbStrikes = (level: number): number => (level <= 0 ? 0 : 1 + Math.floor(level / 3));

export class Exposure {
  /** Campaign day (or equivalent) that sets the strike's weapons; 0 turns counter-battery fire off. */
  level: number;
  strikesLeft: number;
  /** Shortest gap between two strikes (s): Last Stand shortens it wave by wave. */
  cooldownS = EXPOSURE.cooldownS;
  readonly located: Located[] = [];
  private nextAt = 0;
  private nextStep = 0;
  private readonly fired = new Map<Fielded, number>();

  constructor(level: number) {
    this.level = level;
    this.strikesLeft = cbStrikes(level);
  }

  /** A new wave (Last Stand): stronger strikes, and a fresh allowance of them. */
  rearm(level: number): void {
    this.level = level;
    this.strikesLeft = cbStrikes(level);
  }

  /** Units that build exposure: SAM batteries and early warning radars. */
  static tracked(f: Fielded): boolean {
    return !!f.fu || f.unit.type === 'EWR';
  }

  /** The newest strike still coming at this unit, if any. */
  pending(w: World, uid: number): Located | undefined {
    return this.located.find((l) => l.uid === uid && w.t < l.eta + 20);
  }

  step(w: World): void {
    if (w.t < this.nextStep) return;
    const dt = 0.5;
    this.nextStep = w.t + dt;
    for (const f of w.fielded) {
      if (!Exposure.tracked(f) || !f.sites[0]?.alive) continue;
      const type = f.unit.type;
      let heat = f.heat ?? 0;
      const n = f.fu?.launched ?? 0;
      const before = this.fired.get(f) ?? 0;
      if (n > before) heat += (n - before) * (EXPOSURE.launch[type] ?? 0) * w.mods.exposureMult;
      this.fired.set(f, n);
      if (f.move) heat = 0;
      else if (f.radar?.isEmitting()) heat += (EXPOSURE.radiate[type] ?? 0) * dt * w.mods.exposureMult;
      else heat -= EXPOSURE.decay * dt;
      f.heat = Math.min(EXPOSURE.threshold, Math.max(0, heat));
      if (f.heat >= EXPOSURE.threshold && this.canStrike(w, f)) this.locate(w, f);
    }
    for (const l of this.located) {
      if (!l.over && w.t > l.eta + 5) {
        l.over = true;
        w.layoutSeq++;
      }
      if (l.moved || w.t > l.eta) continue;
      const f = w.fielded.find((x) => x.unit.uid === l.uid);
      if (f && (f.move || Math.hypot(f.unit.x - l.x, f.unit.y - l.y) > 500)) {
        l.moved = true;
        w.log(`${l.unit} is off the spot the enemy located: the strike will hit empty ground`, 'info');
      }
    }
  }

  private canStrike(w: World, f: Fielded): boolean {
    return this.strikesLeft > 0 && w.t >= this.nextAt && !this.pending(w, f.unit.uid);
  }

  /**
   * The enemy has located a battery: it remembers the spot and tasks whatever it has ready and in range to
   * hit it. The strike launches from that installation and flies the whole way, so its flight time is real.
   */
  private locate(w: World, f: Fielded): void {
    this.nextAt = w.t + this.cooldownS;
    f.heat = 0;
    const pos = f.sites[0].pos;
    const name = w.unitName(f);
    const aim = v3(pos.x, pos.y, w.terrain.groundAt(pos.x, pos.y));
    const lv = this.level;
    const near = (a: Asset, n: number, maxM: number): EnemyBase | undefined => basesWith(w.theatre, a, n, pos).find((b) => Math.hypot(b.x - pos.x, b.y - pos.y) < maxM);
    // Ballistic missiles from day 5, cruise missiles from day 3, drones always: the fastest it has ready.
    const nTbm = lv >= 8 ? 2 : 1;
    const nCm = Math.min(4, 2 + Math.floor(lv / 4));
    const tbm = lv >= 5 ? near('tbm', nTbm, 300000) : undefined;
    const glcm = !tbm && lv >= 3 ? near('cruise', nCm, 300000) : undefined;
    const team = !tbm && !glcm ? near('drone', 3, 110000) : undefined;
    const base = tbm ?? glcm ?? team;
    if (!base) {
      w.log(`The enemy has located ${name}, but has nothing ready in range to strike it`, 'info');
      return;
    }
    this.strikesLeft--;
    w.revealBase(base);
    const from = v3(base.x, base.y, w.terrain.groundAt(base.x, base.y));
    const d = hdist(from, aim);
    let weapon: string;
    let eta: number;
    if (tbm) {
      draw(tbm, 'tbm', nTbm);
      weapon = nTbm > 1 ? `${nTbm} ballistic missiles` : 'a ballistic missile';
      for (let i = 0; i < nTbm; i++) {
        const impact = add(aim, v3(w.rng.gauss() * 50, w.rng.gauss() * 50, 0));
        impact.z = w.terrain.groundAt(impact.x, impact.y);
        w.spawnLater(tbmFrom(w, impact, name, from, 0), i * 5);
      }
      eta = w.t + tbmFlightS(d);
    } else if (glcm) {
      draw(glcm, 'cruise', nCm);
      weapon = `${nCm} cruise missiles`;
      for (let i = 0; i < nCm; i++) {
        const start = add(from, polar(w.rng.range(0, 360), w.rng.range(200, 1200)));
        start.z = w.terrain.groundAt(start.x, start.y) + 60;
        w.spawnLater(new Cruise(w.nextName('CM'), start, [], aim, name), i * 6);
      }
      eta = w.t + d / 240;
    } else {
      draw(team!, 'drone', 3);
      weapon = '3 attack drones';
      for (let i = 0; i < 3; i++) {
        const start = add(from, polar(w.rng.range(0, 360), w.rng.range(100, 500)));
        start.z = w.terrain.groundAt(start.x, start.y) + 30;
        w.spawnLater(new Drone(w.nextName('LM'), start, [], aim, name, 150), i * 4);
      }
      eta = w.t + d / 50;
    }
    this.located.push({ uid: f.unit.uid, unit: name, x: pos.x, y: pos.y, t: w.t, eta, weapon, moved: false });
    w.layoutSeq++;
    const mins = Math.round((eta - w.t) / 60);
    w.log(`${name} LOCATED: the enemy has fired ${weapon} at it from the ${base.name.toLowerCase()}, ${Math.round(d / 1000)} km away; impact in about ${mins >= 2 ? `${mins} min` : `${Math.round(eta - w.t)} s`}. Move it, or defend it.`, 'alert');
  }
}
