import { Rng } from '../sim/rng';
import type { Campaign } from './campaign';
import { PKG, PkgKind } from './raidgen';

/**
 * Deep strikes: before a day's battle the player can pay for one raid of our own on the enemy's rear. If it
 * succeeds, today's packages of the kinds it hits are cut down and the enemy sends fewer of them for the next
 * two days while it rebuilds. It can also fail.
 */
export type DeepStrikeId = 'drones' | 'tbm' | 'airfield' | 'recon';

interface DeepStrikeDef {
  name: string;
  desc: string;
  costM: number;
  /** Chance of success. */
  chance: number;
  unlockDay: number;
  /** Package kinds it hits. */
  kinds: PkgKind[];
}

export const DEEP_STRIKES: Record<DeepStrikeId, DeepStrikeDef> = {
  drones: {
    name: 'Drone workshops',
    desc: 'Hit the sheds where the attack and decoy drones are assembled.',
    costM: 30, chance: 0.7, unlockDay: 2, kinds: ['drones', 'decoys'],
  },
  recon: {
    name: 'Recon drone base',
    desc: 'Hit the strip the high-flying recon drones fly from.',
    costM: 25, chance: 0.7, unlockDay: 3, kinds: ['recon'],
  },
  airfield: {
    name: 'Forward airfield',
    desc: 'Crater the runway and helipads the SEAD, strike, jammer and helicopter crews use.',
    costM: 55, chance: 0.5, unlockDay: 4, kinds: ['sead', 'strike', 'soj', 'bomber', 'helo'],
  },
  tbm: {
    name: 'Missile launch sites',
    desc: 'Hunt the ballistic missile launchers in their hides.',
    costM: 45, chance: 0.45, unlockDay: 5, kinds: ['tbm'],
  },
};

/** Days a hit target stays weakened (today's battle plus the next two). */
export const SUPPRESS_DAYS = 3;
/** How much less often the enemy picks a suppressed kind of attack. */
export const SUPPRESS_WEIGHT = 0.25;

export function deepStrikeError(c: Campaign, id: DeepStrikeId): string | null {
  const d = DEEP_STRIKES[id];
  if (c.s.day < d.unlockDay) return `From day ${d.unlockDay}`;
  if (c.s.deepStrike) return 'One deep strike a day';
  if (d.costM > c.s.money) return 'Not enough budget';
  return null;
}

/** Fly the strike: pay, roll, and on success cut today's plan and suppress those kinds for a few days. */
export function deepStrike(c: Campaign, id: DeepStrikeId): string | null {
  if (deepStrikeError(c, id)) return null;
  const d = DEEP_STRIKES[id];
  const s = c.s;
  s.money -= d.costM;
  const rng = new Rng(s.seed * 6151 + s.day * 389 + Object.keys(DEEP_STRIKES).indexOf(id) * 17);
  if (!rng.chance(d.chance)) {
    s.deepStrike = { id, ok: false, text: `Strike on the ${d.name.toLowerCase()} failed: the target was empty or the bombs missed. Today's plan is unchanged.` };
    return s.deepStrike.text;
  }
  const sup = (s.enemy.suppressed ??= {});
  for (const k of d.kinds) sup[k] = SUPPRESS_DAYS;
  // Today's packages of those kinds: half are called off, the rest go in smaller.
  let cut = 0;
  s.plan = s.plan.filter((p) => {
    if (!d.kinds.includes(p.kind)) return true;
    if (rng.chance(0.5)) {
      cut++;
      return false;
    }
    const smaller = Math.max(1, Math.round(p.size * 0.5));
    if (smaller < p.size) cut++;
    p.size = smaller;
    return true;
  });
  c.refreshObjectives();
  const names = d.kinds.map((k) => PKG[k].name.toLowerCase()).join(', ');
  s.deepStrike = {
    id,
    ok: true,
    text: `Strike on the ${d.name.toLowerCase()} went in. ${cut ? `${cut} of today's packages were called off or cut down` : 'None of today\'s packages came from there'}, and expect fewer ${names} for the next two days.`,
  };
  return s.deepStrike.text;
}
