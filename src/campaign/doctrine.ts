import { Rng } from '../sim/rng';
import type { PkgKind } from './raidgen';

/**
 * The enemy commander. Each campaign faces one, picked from the seed, with a style that tilts which kinds of
 * attack it favours and how quickly it copies what worked. Our intel works out who it is after the first day.
 */
export type DoctrineId = 'swarm' | 'rocket' | 'air' | 'opportunist';

export interface Doctrine {
  /** The commander's nickname, as our intel calls them. */
  name: string;
  desc: string;
  /** Multiplies the enemy's preference for each kind of attack (missing = 1). */
  bias: Partial<Record<PkgKind, number>>;
  /** How much a package that got through raises the enemy's taste for it (the default is 1.25). */
  learn: number;
  /** How hard it piles onto its favourite approach (1 = normal, more = narrower). */
  axisFocus: number;
}

export const DOCTRINES: Record<DoctrineId, Doctrine> = {
  swarm: {
    name: 'The Beekeeper',
    desc: 'A drone commander: expect big swarms, decoys and recon drones, and fewer jets. Cheap guns and lasers pay off.',
    bias: { drones: 1.8, decoys: 1.6, recon: 1.4, strike: 0.6, bomber: 0.6, sead: 0.8, helo: 0.7 },
    learn: 1.25,
    axisFocus: 1,
  },
  rocket: {
    name: 'The Artilleryman',
    desc: 'A rocket forces officer: cruise and ballistic missiles in volume, little else. Missile stocks and CIWS matter most.',
    bias: { cruise: 1.7, tbm: 1.9, drones: 0.7, strike: 0.7, soj: 0.6, decoys: 0.7, helo: 0.6 },
    learn: 1.25,
    axisFocus: 1.3,
  },
  air: {
    name: 'The Wing Commander',
    desc: 'An air force general: strike jets, helicopters, SEAD and jamming packages, often from one direction. Keep radars moving and fighters up.',
    bias: { strike: 1.7, sead: 1.6, soj: 1.6, bomber: 1.5, helo: 1.6, drones: 0.6, cruise: 0.8 },
    learn: 1.25,
    axisFocus: 1.6,
  },
  opportunist: {
    name: 'The Fox',
    desc: 'No favourite weapon, but copies whatever got through yesterday much faster than the others. Plug every gap.',
    bias: {},
    learn: 1.5,
    axisFocus: 1,
  },
};

export function pickDoctrine(seed: number): DoctrineId {
  const ids = Object.keys(DOCTRINES) as DoctrineId[];
  return ids[new Rng(seed * 4513 + 77).int(0, ids.length - 1)];
}

/** Old saves have no commander: they behave as before. */
export const doctrineOf = (id: DoctrineId | undefined): Doctrine | null => (id ? DOCTRINES[id] : null);
