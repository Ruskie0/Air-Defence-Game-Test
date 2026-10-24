import type { World } from '../sim/world';

/**
 * Career medals: goals that carry across every campaign and Last Stand run, kept in this browser.
 * Earning one is logged in the battle and listed on the debrief; the main menu shows the whole cabinet.
 */
export type MedalId =
  | 'clean'
  | 'ace'
  | 'rotors'
  | 'swarm'
  | 'victory'
  | 'veteran'
  | 'hands'
  | 'wave5'
  | 'wave10'
  | 'bravado';

export const MEDALS: Record<MedalId, { name: string; desc: string }> = {
  clean: { name: 'Clean Sheet', desc: 'Hold a campaign day from day 3 on with nothing getting through.' },
  ace: { name: 'Ace Crew', desc: 'One unit shoots down 10 or more in a single battle.' },
  rotors: { name: 'Rotor Breaker', desc: 'Shoot down 4 attack helicopters in a single battle.' },
  swarm: { name: 'Swatter', desc: 'Shoot down 30 drones in a single battle.' },
  victory: { name: 'Ten Days', desc: 'Win a campaign.' },
  veteran: { name: 'Old Hand', desc: 'Win a campaign on Veteran.' },
  hands: { name: 'Clean Hands', desc: 'Win a campaign without shooting down an airliner or a friendly.' },
  wave5: { name: 'Holdout', desc: 'Hold 5 waves in Last Stand.' },
  wave10: { name: 'The Wall', desc: 'Hold 10 waves in Last Stand.' },
  bravado: { name: 'Bring It On', desc: 'Call 3 Last Stand waves in early in one run.' },
};

const KEY = 'airdefence.medals';

/** Medals earned so far, with the date each was first earned. */
export function earnedMedals(): Partial<Record<MedalId, string>> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Record<MedalId, string>>;
  } catch {
    return {};
  }
}

/** Award a medal; returns its name if it is new, else null. Logs it in the battle when a world is given. */
export function award(id: MedalId, w?: World): string | null {
  const got = earnedMedals();
  if (got[id]) return null;
  got[id] = new Date().toISOString().slice(0, 10);
  try {
    localStorage.setItem(KEY, JSON.stringify(got));
  } catch {
    // No storage (private window): medals just are not kept.
  }
  w?.log(`Medal earned: ${MEDALS[id].name}. ${MEDALS[id].desc}`, 'kill');
  return MEDALS[id].name;
}

/** Medals any battle can earn, from its stats. */
export function battleMedals(w: World): string[] {
  const out: (string | null)[] = [];
  const s = w.stats;
  if (Math.max(0, ...Object.values(s.killsBy)) >= 10) out.push(award('ace', w));
  if ((s.killedKind.helo ?? 0) >= 4) out.push(award('rotors', w));
  if ((s.killedKind.drone ?? 0) >= 30) out.push(award('swarm', w));
  return out.filter((x): x is string => !!x);
}
