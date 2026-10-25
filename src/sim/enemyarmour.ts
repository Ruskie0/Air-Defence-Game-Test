import { V3, hdist, v3 } from './math';
import type { World } from './world';

/**
 * The enemy's own ground offensive: an armoured column that has massed short of our front town drives up the
 * road and assaults it. Its air support softens the town first. If the town is still holding (above
 * ARMOUR.takeHp) through the assault, the attack is beaten off; if the raids have knocked it down, the town
 * falls. Air defence over the town is how the player stops it. Game-level numbers.
 */
export const ARMOUR = {
  /** Where it masses, back down the road from the town (m), its road speed (m/s) and when it sets off (s). */
  startM: 8000,
  speed: 12,
  setOffS: 60,
  /** The assault on the town lasts this long once the column is there (s). */
  assaultS: 300,
  /** The town falls if its health drops below this while the assault is on. */
  takeHp: 60,
};

export type ArmourOutcome = 'taken' | 'repulsed';

export class EnemyArmour {
  readonly name = 'Enemy armour';
  readonly target: string;
  /** The town falls below this health while assaulted (lower for a dug-in town). */
  readonly takeHp: number;
  readonly start: V3;
  readonly dest: V3;
  pos: V3;
  state: 'massing' | 'moving' | 'assaulting' | 'over' = 'massing';
  outcome: ArmourOutcome | null = null;
  private assaultAt = 0;
  /** Sim time it began massing. */
  private readonly t0: number;

  constructor(target: string, from: { x: number; y: number }, to: { x: number; y: number }, takeHp = ARMOUR.takeHp, t0 = 0) {
    this.target = target;
    this.t0 = t0;
    this.takeHp = takeHp;
    const d = Math.hypot(from.x - to.x, from.y - to.y) || 1;
    const m = Math.min(ARMOUR.startM, d * 0.9);
    this.start = v3(to.x + ((from.x - to.x) * m) / d, to.y + ((from.y - to.y) * m) / d);
    this.dest = v3(to.x, to.y);
    this.pos = { ...this.start };
  }

  get over(): boolean {
    return this.state === 'over';
  }

  /** Metres to go to the town. */
  get distM(): number {
    return hdist(this.pos, this.dest);
  }

  /** The town's health, or 0 if it is gone. */
  private townHp(w: World): number {
    const s = w.site(this.target);
    return s && s.alive ? s.hp : 0;
  }

  step(w: World, dt: number): void {
    if (this.state === 'over') return;
    if (this.state === 'massing') {
      if (w.t < this.t0 + ARMOUR.setOffS) return;
      this.state = 'moving';
      w.log(`Enemy armour is moving up the road on ${this.target}, ${(this.distM / 1000).toFixed(0)} km out. Keep the town standing: if the raids knock it below ${this.takeHp}% while they assault it, it falls.`, 'alert');
    }
    if (this.state === 'moving') {
      const d = this.distM;
      const step = ARMOUR.speed * dt;
      if (d <= step + 300) {
        this.state = 'assaulting';
        this.assaultAt = w.t;
        w.log(`Enemy armour is assaulting ${this.target}`, 'alert');
      } else {
        this.pos = v3(this.pos.x + ((this.dest.x - this.pos.x) * step) / d, this.pos.y + ((this.dest.y - this.pos.y) * step) / d);
      }
    }
    if (this.state === 'assaulting') {
      if (this.townHp(w) < this.takeHp) this.finish(w, 'taken');
      else if (w.t - this.assaultAt >= ARMOUR.assaultS) this.finish(w, 'repulsed');
    }
  }

  /** The raid ended with the column still on the road: it pulls back. */
  endOfRaid(w: World): ArmourOutcome {
    if (!this.outcome) this.finish(w, this.state === 'assaulting' && this.townHp(w) < this.takeHp ? 'taken' : 'repulsed');
    return this.outcome!;
  }

  private finish(w: World, how: ArmourOutcome): void {
    this.state = 'over';
    this.outcome = how;
    w.log(how === 'taken' ? `${this.target} has been overrun by enemy armour` : `The enemy attack on ${this.target} has been beaten off: their armour is pulling back`, how === 'taken' ? 'damage' : 'info');
  }
}
