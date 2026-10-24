import { Cruise, Drone, Tbm } from './entities';
import { ENEMY_AD } from './enemyad';
import { add, polar, v3 } from './math';
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
      // An enemy radar watching the spot pins launches and emissions down faster.
      const seen = w.enemyAd?.watched(w, f.sites[0].pos) ? ENEMY_AD.exposureMult : 1;
      if (n > before) heat += (n - before) * (EXPOSURE.launch[type] ?? 0) * w.mods.exposureMult * (seen - 1);
      if (f.move) heat = 0;
      else if (f.radar?.isEmitting()) heat += (EXPOSURE.radiate[type] ?? 0) * dt * w.mods.exposureMult * seen;
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

  private locate(w: World, f: Fielded): void {
    this.strikesLeft--;
    this.nextAt = w.t + EXPOSURE.cooldownS;
    f.heat = 0;
    const pos = f.sites[0].pos;
    const name = w.unitName(f);
    const aim = v3(pos.x, pos.y, w.terrain.groundAt(pos.x, pos.y));
    const bearing = w.terrain.layout.rot + w.rng.range(-35, 35);
    const lv = this.level;
    let weapon: string;
    let eta: number;
    if (lv >= 5 && w.rng.chance(0.5)) {
      const n = lv >= 8 ? 2 : 1;
      weapon = n > 1 ? `${n} ballistic missiles` : 'a ballistic missile';
      const tof = 75;
      for (let i = 0; i < n; i++) {
        const impact = add(aim, v3(w.rng.gauss() * 50, w.rng.gauss() * 50, 0));
        impact.z = w.terrain.groundAt(impact.x, impact.y);
        const s = Tbm.solve(impact, bearing + w.rng.gauss() * 2, 120000, 60000, tof);
        w.spawnLater(new Tbm(w.nextName('TBM'), s.pos, s.vel, impact, name), i * 5);
      }
      eta = w.t + tof;
    } else if (lv >= 3) {
      const n = Math.min(4, 2 + Math.floor(lv / 4));
      weapon = `${n} strike missiles`;
      const range = 20000;
      for (let i = 0; i < n; i++) {
        const start = add(aim, polar(bearing + (i - (n - 1) / 2) * 8, range + i * 600));
        start.z = w.terrain.groundAt(start.x, start.y) + 60;
        w.spawn(new Cruise(w.nextName('CM'), start, [], aim, name));
      }
      eta = w.t + range / 240;
    } else {
      const n = 3;
      weapon = `${n} loitering munitions`;
      const range = 4500;
      for (let i = 0; i < n; i++) {
        const start = add(aim, polar(bearing + (i - 1) * 20, range));
        start.z = w.terrain.groundAt(start.x, start.y) + 150;
        w.spawn(new Drone(w.nextName('LM'), start, [], aim, name, 150));
      }
      eta = w.t + range / 50;
    }
    this.located.push({ uid: f.unit.uid, unit: name, x: pos.x, y: pos.y, t: w.t, eta, weapon, moved: false });
    w.layoutSeq++;
    w.log(`${name} LOCATED: counter-battery strike of ${weapon} inbound, about ${Math.round(eta - w.t)} s. Move it, or defend it.`, 'alert');
  }
}
