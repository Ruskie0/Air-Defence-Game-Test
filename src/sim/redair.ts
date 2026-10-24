import { Air } from './entities';
import { V3, add, bearingDeg, hdist, polar, v3 } from './math';
import { type EnemyBase, avail } from './theatre';
import type { World } from './world';

/**
 * The enemy's high-value aircraft: an AWACS and a tanker flying racetracks well back, over its own SAM
 * umbrella. While the AWACS is up its raids are better coordinated (its aircraft get warned of our shots);
 * while the tanker is up its jammers and SEAD fighters stay on station longer. Shooting either down means
 * sending fighters deep, into reach of the enemy's SAMs. Game-level numbers.
 */
export const RED_SUPPORT = {
  /** Kill chance of our missiles on enemy aircraft while the AWACS is up. */
  warnPk: 0.9,
  /** Time on station of jammers and SEAD fighters while the tanker is up. */
  stationMult: 1.4,
  /** From which campaign day (or Last Stand wave) each flies. */
  awacsLevel: 4,
  tankerLevel: 5,
  /** Racetrack distance from the map centre when there is no SAM umbrella to sit over (m). */
  orbitM: 100000,
  /** How far behind the SAM sites the racetrack sits (m), and its half length. */
  behindM: 12000,
  legM: 18000,
  /** It turns for home when one of our fighters closes inside this range, and runs this long before coming back. */
  runM: 70000,
  runS: 120,
  /** Chaff and its own self-protection: a missile that reaches it kills this often. */
  cmPk: 0.75,
};

/** A racetrack-flying support aircraft that comes on from the rear base and stays until shot down. */
abstract class Orbiter extends Air {
  readonly side = 'red' as const;
  private readonly legs: [V3, V3];
  private leg = 0;
  private readonly entry: V3;
  private runUntil = 0;
  private nextLook = 0;

  constructor(name: string, entry: V3, center: V3, alt: number) {
    const across = bearingDeg(v3(), center) + 90;
    const a = add(center, polar(across, RED_SUPPORT.legM));
    const b = add(center, polar(across + 180, RED_SUPPORT.legM));
    super(name, v3(entry.x, entry.y, alt), bearingDeg(entry, a), 200);
    this.legs = [v3(a.x, a.y, alt), v3(b.x, b.y, alt)];
    this.cmdAlt = alt;
    this.turnRate = 2;
    this.hitRadius = 18;
    this.cmPk = RED_SUPPORT.cmPk;
    this.entry = v3(entry.x, entry.y, alt);
  }

  update(w: World, dt: number): void {
    if (w.t >= this.nextLook) {
      this.nextLook = w.t + 2;
      // Its controllers see our fighters coming: it turns for home and comes back once they have gone.
      if (w.fighters.some((f) => f.alive && f.airborne && hdist(f.pos, this.pos) < RED_SUPPORT.runM)) {
        if (w.t >= this.runUntil) w.log(`${this.name} sees our fighters coming and turns for home`, 'info');
        this.runUntil = w.t + RED_SUPPORT.runS;
      }
    }
    if (w.t < this.runUntil) {
      this.steer(this.entry.x, this.entry.y, dt);
      this.cmdSpd = 230;
      this.integrate(w, dt);
      return;
    }
    this.cmdSpd = 200;
    const p = this.legs[this.leg];
    if (hdist(this.pos, p) < 3000) this.leg = 1 - this.leg;
    this.steer(p.x, p.y, dt);
    this.integrate(w, dt);
  }
}

export class Awacs extends Orbiter {
  readonly kind = 'awacs' as const;
  constructor(name: string, entry: V3, center: V3) {
    super(name, entry, center, 10000);
    this.rcs = 40;
  }
}

export class Tanker extends Orbiter {
  readonly kind = 'tanker' as const;
  constructor(name: string, entry: V3, center: V3) {
    super(name, entry, center, 9000);
    this.rcs = 30;
  }
}

/** What the enemy's support aircraft give it in this battle. */
export class RedSupport {
  private awacs: Awacs | null = null;
  private tanker: Tanker | null = null;

  get awacsUp(): boolean {
    return !!this.awacs?.alive;
  }

  get tankerUp(): boolean {
    return !!this.tanker?.alive;
  }

  /** The support aircraft of this kind still flying, if any. */
  target(kind: string): Awacs | Tanker | null {
    const e = kind === 'awacs' ? this.awacs : kind === 'tanker' ? this.tanker : null;
    return e?.alive ? e : null;
  }

  get warnPk(): number {
    return this.awacsUp ? RED_SUPPORT.warnPk : 1;
  }

  get stationMult(): number {
    return this.tankerUp ? RED_SUPPORT.stationMult : 1;
  }

  /** Put up whatever the rear base has for this level that is not already flying. */
  launch(w: World, level: number): void {
    const rear = w.theatre.find((b) => b.kind === 'rear' && !b.lost);
    if (!rear) return;
    const center = orbitCenter(w, rear);
    const entry = v3(rear.x, rear.y);
    if (level >= RED_SUPPORT.awacsLevel && !this.awacsUp && avail(rear, 'awacs') > 0) {
      this.awacs = new Awacs(w.nextName('AEW'), entry, center);
      w.spawn(this.awacs);
      w.log('An enemy AWACS is coming on station far back: while it is up, its raids are warned of our shots', 'alert');
    }
    if (level >= RED_SUPPORT.tankerLevel && !this.tankerUp && avail(rear, 'tanker') > 0) {
      this.tanker = new Tanker(w.nextName('TKR'), entry, add(center, polar(bearingDeg(v3(), center) + 90, 25000)));
      w.spawn(this.tanker);
      w.log('An enemy tanker is on station far back: while it is up, its jammers and SEAD fighters stay longer', 'alert');
    }
  }

  /** An aircraft shot down: tell the player what it costs the enemy. Its stock is written off at settle. */
  lost(w: World, kind: string): void {
    if (kind === 'awacs') w.log('Enemy AWACS shot down: its raids lose their early warning', 'engage');
    if (kind === 'tanker') w.log('Enemy tanker shot down: its jammers and SEAD fighters will go home sooner', 'engage');
  }
}

/** Over the enemy's SAM sites, a little behind them; straight back towards the rear base when there are none. */
function orbitCenter(w: World, rear: EnemyBase): V3 {
  const sams = w.enemyAd.sites.filter((a) => a.site.alive);
  if (!sams.length) {
    const d = Math.hypot(rear.x, rear.y) || 1;
    return v3((rear.x / d) * RED_SUPPORT.orbitM, (rear.y / d) * RED_SUPPORT.orbitM);
  }
  const c = sams.reduce((s, a) => v3(s.x + a.site.pos.x / sams.length, s.y + a.site.pos.y / sams.length), v3());
  return add(c, polar(bearingDeg(c, v3(rear.x, rear.y)), RED_SUPPORT.behindM));
}
