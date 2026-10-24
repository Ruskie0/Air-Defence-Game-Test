import { CATALOG, UnitType } from '../sim/catalog';
import { Rng } from '../sim/rng';
import { MapType, typeForSeed } from '../sim/terrain';
import type { World } from '../sim/world';
import { Campaign } from './campaign';
import { DOCTRINES } from './doctrine';
import { award, battleMedals } from './medals';
import { planDay, toRaids } from './raidgen';

/**
 * Last Stand: one long battle against endless waves that grow every time. After each wave held, pick one of
 * three reinforcements. It ends when the airbase falls or too many airliners are shot down; the score is the
 * number of waves held.
 */
export type CardId = UnitType | 'resupply' | 'repair' | 'funds';

export interface Card {
  id: CardId;
  name: string;
  desc: string;
}

/** Reinforcements and the first wave each can be offered on. */
const POOL: [CardId, number][] = [
  ['MR', 1], ['SH', 1], ['CIWS', 1], ['GUN', 1], ['EWR', 1], ['GNSS', 2], ['GAP', 2], ['DECOY', 2],
  ['LASER', 3], ['CAP', 3], ['JAM', 4], ['LR', 4],
  ['resupply', 2], ['repair', 2], ['funds', 1],
];

const EXTRA: Record<'resupply' | 'repair' | 'funds', Omit<Card, 'id'>> = {
  resupply: { name: 'Ammunition train', desc: 'Every SAM launcher refilled at once, and 4 more spare missiles for each battery.' },
  repair: { name: 'Engineer battalion', desc: 'Every damaged defended asset and site patched up by 40%.' },
  funds: { name: 'War chest', desc: '+$60M for support calls: resupply convoys, field repairs and the alert pair.' },
};

const UNIT_DESC: Partial<Record<UnitType, string>> = {
  LR: 'Long range SAM: the only answer to ballistic missiles.',
  MR: 'Medium range SAM battery, the backbone of the defence.',
  SH: 'Short range missiles against drones, cruise missiles and low jets.',
  CIWS: 'Last-ditch gun against anything that gets close.',
  GUN: 'Airburst 35 mm gun, cheap and deadly to drones.',
  LASER: 'Burns drones down for free, if the weather allows.',
  EWR: 'Long range early warning radar: see raids sooner.',
  GAP: 'A radar on a mast that sees low fliers in the valleys.',
  GNSS: 'Jams satellite navigation: drones and cruise missiles miss by more.',
  DECOY: 'Radiates like a SAM radar to soak up anti-radiation missiles.',
  JAM: 'Jams the SEAD aircraft and strike jets hunting your radars.',
  CAP: 'A fighter pair on patrol, out in front of the defence.',
};

export const STAND_BEST_KEY = 'airdefence.laststand.best';

export function loadBest(): number {
  try {
    return Number(localStorage.getItem(STAND_BEST_KEY)) || 0;
  } catch {
    return 0;
  }
}

/** Waves between the first and the last get harder by more than a campaign day does. */
const waveScale = (n: number): number => 1 + 0.04 * Math.max(0, n - 4);
/** Waves run faster than a campaign day: packages come half as far apart. */
const PACE = 0.5;
export const START_BUDGET_M = 60;
export const WAVE_PAY_M = 25;
/** Spare missiles every surviving battery gets after each wave held. */
export const WAVE_SPARES = 2;
/** Seconds after a wave's last package before the next wave comes anyway. */
export const WAVE_MAX_S = 900;
/** Extra support budget for calling the next wave in while this one is still in the air. */
export const EARLY_BONUS_M = 15;

export class LastStand {
  readonly c: Campaign;
  /** Waves launched so far (the current one, while it is running). */
  wave = 0;
  /** Waves held: the score. */
  held = 0;
  best: number;
  /** Reinforcements on offer while waiting for a pick, else null. */
  offer: Card[] | null = null;
  over: string | null = null;
  w: World;
  /** Waves called in early this run. */
  early = 0;
  private callNow = false;

  constructor(seed: number, mapType: MapType = typeForSeed(seed)) {
    this.c = Campaign.create(seed, 'normal', mapType);
    // A modest defence to start: what the campaign starts with, plus early warning, a gun and spares.
    for (const t of ['EWR', 'GUN', 'SH'] as UnitType[]) this.c.add(t);
    for (const u of this.c.units) u.spares = u.launchers.length ? 4 : 0;
    this.c.s.plan = [];
    // One battle round the airbase: no front line.
    this.c.s.front = undefined;
    this.w = this.c.makeWorld(false);
    this.w.budgetM = START_BUDGET_M;
    // Civil traffic keeps flying through it all.
    this.w.scenario.start(this.w);
    this.best = loadBest();
    const doc = DOCTRINES[this.c.s.enemy.doctrine!];
    this.w.log(`Last Stand on ${this.c.terrain.describe()}. Enemy commander: ${doc.name}. ${doc.desc}`, 'raid');
    this.nextWave();
  }

  /** Launch the next wave, starting 30 seconds from now. */
  private nextWave(): void {
    const w = this.w;
    this.wave++;
    const s = this.c.s;
    const plan = planDay(this.wave, s.seed, s.enemy, s.nextPkg, this.c.layout.rot, waveScale(this.wave));
    s.nextPkg += plan.length;
    for (const p of plan) p.t = Math.round(w.t + 30 + p.t * PACE);
    w.scenario.raids.push(...toRaids(plan));
    w.scenario.done = false;
    w.scenario.doneMsg = `Wave ${this.wave} held.`;
    w.qraUsed = false;
    w.exposure.rearm(this.wave);
    w.log(`Wave ${this.wave}: ${plan.length} packages inbound`, 'raid');
  }

  /** Called every frame: notices the end of a wave or of the stand. Returns true when something changed. */
  update(): boolean {
    if (this.over || this.offer) return false;
    const w = this.w;
    if (!w.site('Airbase')?.alive) return this.end('The airbase was destroyed.');
    if (w.stats.civilian >= 3) return this.end(`${w.stats.civilian} civil airliners shot down: you have been relieved of command.`);
    // A wave is held once every package is in and no drone or missile is still flying: jammers, recon and
    // aircraft heading home do not hold up the next wave. After a long while it comes anyway.
    const raids = w.scenario.raids;
    const last = Math.max(...raids.map((r) => r.t));
    const quiet = w.pendingCount === 0 && !w.entities.some((e) => e.alive && e.side === 'red' && e.munition);
    if (!raids.every((r) => r.launched) || !(this.callNow || (quiet && w.t > last + 90) || w.t > last + WAVE_MAX_S)) return false;
    this.held = this.wave;
    w.budgetM += WAVE_PAY_M;
    if (this.callNow) {
      this.callNow = false;
      this.early++;
      w.budgetM += EARLY_BONUS_M;
      w.log(`Next wave called in early: +$${EARLY_BONUS_M}M`, 'info');
      if (this.early >= 3) award('bravado', w);
    }
    battleMedals(w);
    if (this.held >= 5) award('wave5', w);
    if (this.held >= 10) award('wave10', w);
    // The depot sends a little forward after every wave held.
    for (const fu of w.units) if (fu.launchers.some((l) => l.site.alive)) fu.spares = (Number.isFinite(fu.spares) ? fu.spares : 0) + WAVE_SPARES;
    this.saveBest();
    this.offer = this.deal();
    return true;
  }

  /** Whether the player can call the next wave in now: every package of this one has launched. */
  get canCallEarly(): boolean {
    return !this.over && !this.offer && this.w.scenario.raids.every((r) => r.launched);
  }

  /** Count this wave as held now, for a bonus, while what is left of it is still flying. */
  callEarly(): void {
    if (this.canCallEarly) this.callNow = true;
  }

  /** Three different reinforcements for the wave just held. */
  private deal(): Card[] {
    const rng = new Rng(this.c.s.seed * 337 + this.wave * 41);
    const ids = POOL.filter(([, from]) => this.wave >= from).map(([id]) => id);
    const out: CardId[] = [];
    // Ballistic missiles come from wave 5 and only the LR SAM stops them: until there is one, it is always offered.
    const lr = this.wave >= 4 && !this.c.units.some((u) => u.type === 'LR');
    if (lr) ids.splice(ids.indexOf('LR'), 1);
    while (out.length < (lr ? 2 : 3) && ids.length) out.push(ids.splice(rng.int(0, ids.length - 1), 1)[0]);
    if (lr) out.splice(rng.int(0, out.length), 0, 'LR');
    return out.map((id) => card(id));
  }

  /** Take a reinforcement and start the next wave. */
  choose(i: number): void {
    const card = this.offer?.[i];
    if (!card) return;
    this.offer = null;
    const w = this.w;
    if (card.id === 'resupply') {
      for (const fu of w.units) {
        for (const l of fu.launchers) if (l.site.alive) l.rounds = l.max;
        fu.spares = (Number.isFinite(fu.spares) ? fu.spares : 0) + 4;
      }
    } else if (card.id === 'repair') {
      for (const s of w.sites) if (s.alive && s.hp < 100) s.hp = Math.min(100, s.hp + 40);
    } else if (card.id === 'funds') {
      w.budgetM += 60;
    } else {
      const u = this.c.add(card.id);
      u.spares = u.launchers.length ? 4 : 0;
      w.reinforce(u);
    }
    w.log(`Reinforcement: ${card.name}`, 'info');
    this.nextWave();
  }

  private end(reason: string): boolean {
    this.over = `${reason} You held ${this.held} wave${this.held === 1 ? '' : 's'}.`;
    this.saveBest();
    return true;
  }

  private saveBest(): void {
    if (this.held <= this.best) return;
    this.best = this.held;
    try {
      localStorage.setItem(STAND_BEST_KEY, String(this.best));
    } catch {
      // No storage (private window): the best score just is not kept.
    }
  }
}

export function card(id: CardId): Card {
  if (id === 'resupply' || id === 'repair' || id === 'funds') return { id, ...EXTRA[id] };
  return { id, name: CATALOG[id].name, desc: UNIT_DESC[id] ?? '' };
}
