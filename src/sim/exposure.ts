import { Cruise, Drone } from './entities';
import { ENEMY_AD } from './enemyad';
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
  /** Living war: emissions are only heard by an enemy aircraft within this range (m). */
  esmM: 200000,
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

/**
 * The living war's retaliation: a fix is the enemy's picture of where a unit stands, from its launches and
 * emissions or a recon photograph. Nothing launches at it straight away: its sortie planner aims the next
 * raid at it. Only artillery near the front can react within minutes. Game-level numbers.
 */
export const ARTY = {
  /** Reach of an enemy artillery base (m): long-range rocket artillery. */
  rangeM: 60000,
  /** From the fix to the first shell landing (s): the call for fire and the guns laying on, then the flight. */
  callS: [100, 200] as [number, number],
  /** Shells in a barrage, seconds between them, their spread round the aim point (m), and their effect. */
  shells: 8,
  gapS: 4,
  spreadM: 120,
  blastM: 70,
  dmg: 14,
  /** Shortest gap between two barrages from the same base (s). */
  cooldownS: 600,
  /** A fix older than this is dropped (s); so is one on a unit that has moved more than DRIFT_M from it. */
  fixAgeS: 18 * 3600,
  driftM: 400,
};

/** A position the enemy has fixed: where, and when. */
export interface Fix {
  uid: number;
  unit: string;
  x: number;
  y: number;
  /** Sim time it was fixed. */
  t: number;
  /** How: by its launches and emissions, or from a recon drone's photographs. */
  how: 'elint' | 'recon';
}

/** A barrage on its way to a fixed position. */
export interface Barrage {
  uid: number;
  unit: string;
  x: number;
  y: number;
  base: string;
  /** Sim time the first shell lands, and how many are still to land. */
  at: number;
  left: number;
}

export class Exposure {
  /**
   * 'strike': a located battery draws a counter-battery strike within minutes (Last Stand, sandbox, training).
   * 'intel': the campaign's living war, where a full bar only gives the enemy a fix for its next sorties.
   */
  mode: 'strike' | 'intel' = 'strike';
  /** Positions the enemy has fixed (intel mode). */
  fixes: Fix[] = [];
  /** Artillery barrages on their way (intel mode). */
  readonly barrages: Barrage[] = [];
  private readonly artyReady = new Map<string, number>();
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
    // In the living war emissions only give a unit away while something of the enemy's is listening: an
    // aircraft up within ESM range, or a SAM site's radar watching. Through the quiet hours it holds steady.
    const ears = this.mode === 'intel' ? w.entities.filter((e) => e.alive && e.side === 'red' && e.airborne && !e.munition) : [];
    for (const f of w.fielded) {
      if (!Exposure.tracked(f) || !f.sites[0]?.alive) continue;
      const type = f.unit.type;
      let heat = f.heat ?? 0;
      const n = f.fu?.launched ?? 0;
      const before = this.fired.get(f) ?? 0;
      // An enemy SAM site's radar watching the spot pins launches and emissions down faster.
      const seen = w.enemyAd.watched(w, f.sites[0].pos) ? ENEMY_AD.exposureMult : 1;
      if (n > before) heat += (n - before) * (EXPOSURE.launch[type] ?? 0) * w.mods.exposureMult * seen;
      this.fired.set(f, n);
      if (f.move) heat = 0;
      else if (f.radar?.isEmitting()) {
        const heard = this.mode !== 'intel' || seen > 1 || ears.some((e) => hdist(e.pos, f.sites[0].pos) < EXPOSURE.esmM);
        if (heard) heat += (EXPOSURE.radiate[type] ?? 0) * dt * w.mods.exposureMult * seen;
      }
      else heat -= EXPOSURE.decay * dt;
      f.heat = Math.min(EXPOSURE.threshold, Math.max(0, heat));
      if (this.mode === 'intel') {
        if (f.heat >= EXPOSURE.threshold && this.level > 0) this.fix(w, f);
      } else if (f.heat >= EXPOSURE.threshold && this.canStrike(w, f)) this.locate(w, f);
    }
    if (this.mode === 'intel') {
      this.stepFixes(w);
      return;
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

  /** The enemy's fix on a unit, if it has a current one. */
  fixOn(uid: number): Fix | undefined {
    return this.fixes.find((x) => x.uid === uid);
  }

  /**
   * What our own ELINT makes of it: whether the enemy has probably fixed this unit. It reads the enemy's
   * emissions and recon flights, not its plans, so it misses about one fix in seven and now and then flags a
   * unit that is only close to being fixed.
   */
  compromised(f: Fielded): boolean {
    const fx = this.fixOn(f.unit.uid);
    // A steady per-unit, per-fix roll, so the estimate does not flicker.
    const roll = ((f.unit.uid * 2654435761 + (fx ? Math.floor(fx.t) : 0) * 40503) >>> 0) % 1000 / 1000;
    if (fx) return roll >= 0.15;
    return (f.heat ?? 0) >= 70 && roll < 0.2;
  }

  /** Record a fix (recon photographs come in this way too); a newer one replaces the old. */
  addFix(w: World, fx: Fix): void {
    this.fixes = this.fixes.filter((x) => x.uid !== fx.uid);
    this.fixes.push(fx);
    w.layoutSeq++;
  }

  /** A unit's position has given itself away: the enemy fixes it, and artillery in reach may shell it. */
  private fix(w: World, f: Fielded): void {
    f.heat = 0;
    const pos = f.sites[0].pos;
    const name = w.unitName(f);
    this.addFix(w, { uid: f.unit.uid, unit: name, x: Math.round(pos.x), y: Math.round(pos.y), t: w.t, how: 'elint' });
    if (this.barrages.some((b) => b.uid === f.unit.uid)) return;
    const arty = basesWith(w.theatre, 'shell', 1, pos).find((b) => Math.hypot(b.x - pos.x, b.y - pos.y) <= ARTY.rangeM && (this.artyReady.get(b.id) ?? 0) <= w.t);
    if (!arty) return;
    draw(arty, 'shell', 1);
    this.artyReady.set(arty.id, w.t + ARTY.cooldownS);
    this.barrages.push({ uid: f.unit.uid, unit: name, x: pos.x, y: pos.y, base: arty.id, at: w.t + w.rng.range(...ARTY.callS), left: ARTY.shells });
  }

  /** Fixes go stale when the unit moves off the spot or after most of a day; barrages land. */
  private stepFixes(w: World): void {
    const before = this.fixes.length;
    this.fixes = this.fixes.filter((fx) => {
      if (w.t - fx.t > ARTY.fixAgeS) return false;
      const f = w.fielded.find((x) => x.unit.uid === fx.uid);
      if (!f || !f.sites[0]?.alive) return false;
      return Math.hypot(f.unit.x - fx.x, f.unit.y - fx.y) <= ARTY.driftM;
    });
    if (this.fixes.length !== before) w.layoutSeq++;
    for (let i = this.barrages.length - 1; i >= 0; i--) {
      const b = this.barrages[i];
      if (w.t < b.at) continue;
      if (b.left === ARTY.shells) {
        const base = w.theatre.find((x) => x.id === b.base);
        if (base) w.revealBase(base);
        w.log(`Artillery fire from the ${base?.name.toLowerCase() ?? 'enemy guns'} is falling on the ${b.unit}'s position`, 'alert');
      }
      const p = v3(b.x + w.rng.gauss() * ARTY.spreadM, b.y + w.rng.gauss() * ARTY.spreadM, 0);
      p.z = w.terrain.groundAt(p.x, p.y);
      w.effect(p, 'ground');
      for (const s of w.sites) {
        if (!s.alive || s.role === 'town') continue;
        const d = hdist(s.pos, p);
        if (d < ARTY.blastM + s.radius) s.damage(w, ARTY.dmg * (1 - d / (ARTY.blastM + s.radius + 1)), 'artillery');
      }
      b.left--;
      b.at = w.t + ARTY.gapS;
      if (b.left <= 0) this.barrages.splice(i, 1);
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
