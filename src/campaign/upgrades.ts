/** Campaign upgrades: one-off purchases that change game stats for the rest of the campaign. */
export type UpgradeId = 'drills' | 'supply' | 'pdfuze' | 'crews' | 'hardened';

export interface UpgradeInfo {
  id: UpgradeId;
  name: string;
  costM: number;
  unlockDay: number;
  desc: string;
}

export const UPGRADES: Record<UpgradeId, UpgradeInfo> = {
  drills: { id: 'drills', name: 'Displacement drills', costM: 25, unlockDay: 1, desc: 'Crews pack up and set up in half the time when you move units during a battle.' },
  supply: { id: 'supply', name: 'Supply contract', costM: 60, unlockDay: 1, desc: '+15 $M income every day.' },
  pdfuze: { id: 'pdfuze', name: 'Programmable gun ammunition', costM: 40, unlockDay: 2, desc: 'CIWS, Skyburst and laser kill rates +25%.' },
  crews: { id: 'crews', name: 'Fast reload crews', costM: 35, unlockDay: 2, desc: 'SAM launchers reload from spares 40% faster.' },
  hardened: { id: 'hardened', name: 'Hardened shelters', costM: 70, unlockDay: 3, desc: 'Every site, defended assets and air defence equipment alike, takes 25% less damage.' },
};

export const UPGRADE_ORDER: UpgradeId[] = ['drills', 'supply', 'pdfuze', 'crews', 'hardened'];

/** Game-stat multipliers a set of upgrades gives a battle. */
export interface Modifiers {
  pdBonus: number;
  reloadMult: number;
  damageMult: number;
  moveMult: number;
}

export function modifiers(ids: readonly string[] = []): Modifiers {
  const has = (id: UpgradeId): boolean => ids.includes(id);
  return {
    pdBonus: has('pdfuze') ? 1.25 : 1,
    reloadMult: has('crews') ? 0.6 : 1,
    damageMult: has('hardened') ? 0.75 : 1,
    moveMult: has('drills') ? 0.5 : 1,
  };
}
