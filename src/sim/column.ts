import { Entity } from './entities';
import { V3, add, clone, hdist, norm, scale, v3 } from './math';
import type { Site } from './sites';
import type { World } from './world';

/**
 * The assault column: the ground force of an offensive, driving up the road from our front town to its start
 * line short of the objective. It halts while enemy weapons or aircraft are close or it has just been hit, so
 * the defence has to clear the air over it to keep it moving. The 'Assault force' site rides with it: whatever
 * hits the site hits the column. Game-level numbers.
 */
export const COLUMN = {
  /** Road speed (m/s), and how long it forms up before setting off (s). */
  speed: 14,
  formUpS: 45,
  /** It halts while an enemy weapon or aircraft is this close, and for this long after being hit. */
  haltR: 5000,
  haltAfterHitS: 25,
  /** In position when this close to the start line. */
  arriveM: 150,
  /** It sets off at most this far back down the road from its start line (m). */
  maxRunM: 11000,
};

export type ColumnState = 'forming' | 'moving' | 'halted' | 'arrived' | 'destroyed';
/** What the column's outcome hook reports: it reached its start line, or it was destroyed on the way or there. */
export type AssaultOutcome = 'arrived' | 'destroyed';

export class Column extends Entity {
  readonly kind = 'column' as const;
  readonly side = 'blue' as const;
  readonly site: Site;
  readonly start: V3;
  readonly dest: V3;
  readonly objective: string;
  state: ColumnState = 'forming';
  /** Why it is halted, for the HUD. */
  haltWhy = '';
  private readonly t0: number;
  private lastHp: number;
  private hitAt = -1e9;

  constructor(name: string, start: V3, dest: V3, site: Site, objective: string, t0: number) {
    super(name, start);
    this.start = clone(start);
    this.dest = clone(dest);
    this.site = site;
    this.objective = objective;
    this.t0 = t0;
    this.lastHp = site.hp;
    this.airborne = false;
    this.rcs = 0;
  }

  /** 0 at the start, 1 at the start line. */
  get progress(): number {
    const total = hdist(this.start, this.dest);
    return total < 1 ? 1 : Math.min(1, 1 - hdist(this.pos, this.dest) / total);
  }

  /** Seconds to the start line at road speed, not counting halts. */
  eta(w: World): number {
    return Math.max(0, this.t0 + COLUMN.formUpS - w.t) + hdist(this.pos, this.dest) / COLUMN.speed;
  }

  update(w: World, dt: number): void {
    const s = this.site;
    if (!s.alive) {
      this.finish(w, 'destroyed');
      return;
    }
    if (s.hp < this.lastHp) this.hitAt = w.t;
    this.lastHp = s.hp;
    this.vel = v3();
    // Drones sent at the assault force are flown onto it: their operators see where it is now. Missiles
    // keep the aim point they were launched at, so a column that keeps moving makes them miss.
    for (const e of w.entities) if (e.alive && e.kind === 'drone' && e.targetName === s.name && e.target) e.target = v3(this.pos.x, this.pos.y, s.pos.z);
    if (this.state === 'arrived') return;
    if (w.t < this.t0 + COLUMN.formUpS) return;
    const threat = w.entities.find((e) => e.alive && e.side === 'red' && (e.munition || e.airborne) && hdist(e.pos, this.pos) < COLUMN.haltR);
    if (threat || w.t - this.hitAt < COLUMN.haltAfterHitS) {
      if (this.state !== 'halted') w.log(`${this.name} halted: ${threat ? 'enemy overhead' : 'under fire'}, taking cover`, 'alert');
      this.state = 'halted';
      this.haltWhy = threat ? 'enemy overhead' : 'under fire';
      return;
    }
    if (this.state !== 'moving') w.log(`${this.name} moving up the road to ${this.objective}`, 'info');
    this.state = 'moving';
    this.haltWhy = '';
    const d = hdist(this.pos, this.dest);
    const step = Math.min(d, COLUMN.speed * dt);
    this.vel = scale(norm(v3(this.dest.x - this.pos.x, this.dest.y - this.pos.y, 0)), COLUMN.speed);
    this.pos = add(this.pos, scale(norm(v3(this.dest.x - this.pos.x, this.dest.y - this.pos.y, 0)), step));
    this.pos.z = w.terrain.groundAt(this.pos.x, this.pos.y) + 2;
    // The site rides with the column, so raids aimed at the assault force find it where it is now.
    s.pos.x = this.pos.x;
    s.pos.y = this.pos.y;
    s.pos.z = this.pos.z - 2;
    w.layoutSeq++;
    if (d - step < COLUMN.arriveM) {
      this.state = 'arrived';
      w.log(`${this.name} is on its start line before ${this.objective}. Keep it alive until the day ends and the town is ours.`, 'kill');
      w.assaultEvent('arrived');
    }
  }

  private finish(w: World, o: AssaultOutcome): void {
    this.state = 'destroyed';
    this.alive = false;
    w.setFate(this, 'exit', this.objective);
    w.assaultEvent(o);
  }
}
