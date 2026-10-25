import { Rng } from '../sim/rng';
import { type Asset, type BaseKind, type EnemyBase, AIRCRAFT, assetCount, avail } from '../sim/theatre';
import type { Campaign } from './campaign';
import { PKG } from './raidgen';

/**
 * Deep strikes: before a day's battle the player can pay for one raid of our own on an enemy installation
 * that our intel has located. If it goes in, the installation loses half of what it holds, for good, and
 * today's packages from it are cut down. It can also miss. Game-level numbers.
 */
export type DeepStrikeId = string;

interface DeepStrikeDef {
  /** What the strike does, in a few words. */
  desc: string;
  costM: number;
  /** Chance of success. */
  chance: number;
  unlockDay: number;
}

/** What a strike on each kind of installation costs and how often it works. The rear air base is out of reach. */
export const DEEP_STRIKES: Partial<Record<BaseKind, DeepStrikeDef>> = {
  drones: { desc: 'Hit the launch rails and the drones stacked beside them.', costM: 30, chance: 0.7, unlockDay: 2 },
  farp: { desc: 'Catch the attack helicopters on the ground while they rearm.', costM: 35, chance: 0.6, unlockDay: 3 },
  airfield: { desc: 'Crater the runway and hit the jets in their shelters.', costM: 55, chance: 0.5, unlockDay: 4 },
  glcm: { desc: 'Hunt the cruise missile launchers and their reloads.', costM: 40, chance: 0.5, unlockDay: 3 },
  tbm: { desc: 'Hunt the ballistic missile launchers in their hides.', costM: 45, chance: 0.45, unlockDay: 5 },
  sam: { desc: 'Hit the SAM site\'s launchers and its reloads.', costM: 35, chance: 0.55, unlockDay: 2 },
  arty: { desc: 'Counter-battery fire on the guns and their ammunition.', costM: 30, chance: 0.6, unlockDay: 1 },
};

/** Share of an installation's stock a successful strike destroys. */
export const STRIKE_LOSS = 0.5;
/** Hours a hit craters an airfield's runway. */
export const RUNWAY_DOWN_H = 24;

/** Installations a deep strike could go for today: located, still in the war and within reach. */
export function strikeTargets(c: Campaign): EnemyBase[] {
  return c.theatre.filter((b) => b.known && !b.lost && DEEP_STRIKES[b.kind]);
}

export function deepStrikeError(c: Campaign, id: DeepStrikeId): string | null {
  const b = c.theatre.find((x) => x.id === id);
  const d = b ? DEEP_STRIKES[b.kind] : undefined;
  if (!b || !d) return 'No such target';
  if (!b.known) return 'Not located yet';
  if (b.lost) return 'Already out of the war';
  if (c.s.day < d.unlockDay) return `From day ${d.unlockDay}`;
  if (c.s.deepStrike) return 'One deep strike a day';
  if (d.costM > c.s.money) return 'Not enough budget';
  return null;
}

/** Fly the strike: pay, roll, and on success destroy half the installation's stock and cut today's packages from it. */
export function deepStrike(c: Campaign, id: DeepStrikeId): string | null {
  if (deepStrikeError(c, id)) return null;
  const b = c.theatre.find((x) => x.id === id)!;
  const d = DEEP_STRIKES[b.kind]!;
  const s = c.s;
  s.money -= d.costM;
  const rng = new Rng(s.seed * 6151 + s.day * 389 + c.theatre.indexOf(b) * 17);
  const name = b.name.toLowerCase();
  if (!rng.chance(d.chance)) {
    s.deepStrike = { id, ok: false, text: `Strike on the ${name} failed: the launchers had moved or the bombs missed. Nothing was destroyed.` };
    return s.deepStrike.text;
  }
  const lost = (s.enemyLost ??= {});
  const gone: string[] = [];
  for (const a of Object.keys(b.stock) as Asset[]) {
    const n = Math.round(avail(b, a) * STRIKE_LOSS);
    if (n <= 0) continue;
    b.stock[a] = Math.max(0, (b.stock[a] ?? 0) - n);
    lost[a] = (lost[a] ?? 0) + n;
    gone.push(assetCount(a, n));
  }
  // Today's packages from there: half are called off, the rest go in smaller. Munitions already on the
  // launchers burn with them; aircraft can only fly if they are still there.
  let cut = 0;
  s.plan = s.plan.filter((p) => {
    if (p.base !== id) return true;
    if (rng.chance(0.5)) {
      cut++;
      return false;
    }
    const a = PKG[p.kind].asset!;
    const left = AIRCRAFT.includes(a) ? avail(b, a) : p.size;
    const smaller = Math.min(left, Math.max(1, Math.round(p.size * 0.5)));
    if (smaller < p.size) cut++;
    p.size = smaller;
    return smaller > 0;
  });
  c.refreshObjectives();
  // A hit on an airfield craters its runway for a day: nothing flies from it until it is fixed.
  const crater = b.kind === 'airfield';
  if (crater) {
    (s.runwayUntil ??= {})[id] = c.clock + RUNWAY_DOWN_H * 60;
    s.plan = s.plan.filter((p) => p.base !== id || !AIRCRAFT.includes(PKG[p.kind].asset!));
  }
  s.deepStrike = {
    id,
    ok: true,
    text: `Strike on the ${name} went in: ${gone.length ? `${gone.join(', ')} destroyed for good` : 'it was empty'}.${crater ? ` The runway is cratered for ${RUNWAY_DOWN_H} h: no jets fly from it.` : ''}${cut ? ` ${cut} of today's packages from there were called off or cut down.` : ''}`,
  };
  return s.deepStrike.text;
}
