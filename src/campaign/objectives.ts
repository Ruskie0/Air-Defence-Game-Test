import { DEFENDED_ASSETS } from '../sim/catalog';
import { Rng } from '../sim/rng';
import type { World } from '../sim/world';
import type { PkgKind, PlannedPkg } from './raidgen';

/** Bonus objectives: optional goals for a campaign day that pay out on top of the day's income. */
export type ObjectiveId = 'clean' | 'lights' | 'jammer' | 'bombers' | 'recon' | 'strikers' | 'thrift' | 'intact';

export interface DayObjective {
  id: ObjectiveId;
  rewardM: number;
  /** Missile discipline: the most missiles that may be fired. */
  limit?: number;
}

export type ObjectiveStatus = 'open' | 'done' | 'failed';

const DEFS: Record<ObjectiveId, { name: string; desc: (o: DayObjective) => string; needs?: PkgKind }> = {
  clean: { name: 'Clean sheet', desc: () => 'No hits on the airbase, the CRC or the power plant.' },
  lights: { name: 'Keep the lights on', desc: () => 'The power plant takes no damage.' },
  jammer: { name: 'Splash the jammer', desc: () => 'Shoot down the stand-off jammer.', needs: 'soj' },
  bombers: { name: 'Bomber hunt', desc: () => 'Shoot down every bomber.', needs: 'bomber' },
  strikers: { name: 'Jet hunt', desc: () => 'Shoot down every strike fighter.', needs: 'strike' },
  recon: { name: 'Blind them', desc: () => 'Shoot down every enemy recon drone.', needs: 'recon' },
  thrift: { name: 'Missile discipline', desc: (o) => `Fire no more than ${o.limit} missiles.` },
  intact: { name: 'No losses', desc: () => 'Lose no air defence equipment.' },
};

export const objectiveName = (o: DayObjective): string => DEFS[o.id].name;
export const objectiveDesc = (o: DayObjective): string => DEFS[o.id].desc(o);

/** Two objectives for the day, picked from those that make sense against its raid plan. */
export function pickObjectives(plan: PlannedPkg[], day: number, seed: number): DayObjective[] {
  const rng = new Rng(seed * 31337 + day * 7);
  const kinds = new Set(plan.map((p) => p.kind));
  // Real threats in the plan, for the missile budget: decoys count for nothing.
  const threats = plan.filter((p) => p.kind !== 'decoys' && p.kind !== 'dark').reduce((n, p) => n + (p.kind === 'bomber' ? 4 * p.size : p.kind === 'sead' ? 4 : p.kind === 'strike' ? 3 * p.size : p.size), 0);
  const pool: DayObjective[] = [
    { id: 'clean', rewardM: 15 + 2 * day },
    { id: 'lights', rewardM: 10 + day },
    { id: 'intact', rewardM: 12 + day },
    { id: 'thrift', rewardM: 12 + day, limit: Math.max(6, Math.round(threats * 1.1)) },
  ];
  if (kinds.has('soj')) pool.push({ id: 'jammer', rewardM: 25 }, { id: 'jammer', rewardM: 25 });
  if (kinds.has('bomber')) pool.push({ id: 'bombers', rewardM: 30 }, { id: 'bombers', rewardM: 30 });
  if (kinds.has('strike')) pool.push({ id: 'strikers', rewardM: 25 }, { id: 'strikers', rewardM: 25 });
  if (kinds.has('recon')) pool.push({ id: 'recon', rewardM: 20 }, { id: 'recon', rewardM: 20 });
  const out: DayObjective[] = [];
  while (out.length < 2 && pool.length) {
    const o = pool.splice(rng.int(0, pool.length - 1), 1)[0];
    if (!out.some((x) => x.id === o.id)) out.push(o);
  }
  return out;
}

/** Where an objective stands in a battle; `final` once the day is over (open goals that only need holding are then met). */
export function objectiveStatus(o: DayObjective, w: World, final = false): ObjectiveStatus {
  const s = w.stats;
  const hurt = (name: string): boolean => (w.site(name)?.hp ?? 0) < (w.startHp.get(name) ?? 0);
  const allKilled = (kind: string): ObjectiveStatus => {
    const n = s.spawnedKind[kind] ?? 0;
    const k = s.killedKind[kind] ?? 0;
    if (n > 0 && k >= n && !w.entities.some((e) => e.alive && e.kind === kind)) return 'done';
    if (final || (n > k && w.deaths.some((e) => e.kind === kind && e.fate?.how === 'exit'))) return 'failed';
    return 'open';
  };
  const hold = (failed: boolean): ObjectiveStatus => (failed ? 'failed' : final ? 'done' : 'open');
  switch (o.id) {
    case 'clean':
      return hold(DEFENDED_ASSETS.some((a) => hurt(a.name)));
    case 'lights':
      return hold(hurt('Power plant'));
    case 'intact':
      return hold(w.sites.some((x) => !x.defended && !x.alive));
    case 'thrift':
      return hold(s.fired.LR + s.fired.MR + s.fired.SH + s.fired.AAM > (o.limit ?? 0));
    case 'jammer':
      return allKilled('soj');
    case 'bombers':
      return allKilled('bomber');
    case 'strikers':
      return allKilled('strike');
    case 'recon':
      return allKilled('recon');
  }
}
