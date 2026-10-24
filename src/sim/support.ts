import { ROUND_COST } from './catalog';
import type { Site } from './sites';
import type { FireUnit } from './sites';
import type { World } from './world';

/**
 * Support calls during a battle: things the commander can buy with the campaign budget while the raid is on.
 * Game stats only: a flat delay and price for each.
 */
export const RESUPPLY = { delayS: 150, rounds: 4, feeM: 3 };
export const FIELD_REPAIR = { delayS: 120, hp: 30, costM: 10 };

export interface SupportCall {
  kind: 'resupply' | 'repair';
  /** Sim time it arrives. */
  t: number;
  fu?: FireUnit;
  site?: Site;
}

export const resupplyCost = (fu: FireUnit): number => RESUPPLY.feeM + RESUPPLY.rounds * (ROUND_COST[fu.type] ?? 0);

/** Money left for support calls (Infinity in the sandbox). */
export const budgetLeft = (w: World): number => w.budgetM - w.supportSpentM;

/** Why a resupply convoy cannot be sent to this battery now, or null. */
export function resupplyError(w: World, fu: FireUnit): string | null {
  if (w.support.some((c) => c.fu === fu)) return 'convoy on its way';
  if (!fu.launchers.some((l) => l.site.alive)) return 'no launchers left';
  if (resupplyCost(fu) > budgetLeft(w)) return 'not enough budget';
  return null;
}

/** Why a field repair team cannot go to this site now, or null. */
export function repairError(w: World, site: Site): string | null {
  if (!site.alive) return 'destroyed';
  if (site.hp >= 100) return 'undamaged';
  if (w.support.some((c) => c.site === site)) return 'team on its way';
  if (FIELD_REPAIR.costM > budgetLeft(w)) return 'not enough budget';
  return null;
}

export function callResupply(w: World, fu: FireUnit): string | null {
  const err = resupplyError(w, fu);
  if (err) return err;
  w.supportSpentM += resupplyCost(fu);
  w.support.push({ kind: 'resupply', t: w.t + RESUPPLY.delayS, fu });
  w.log(`Resupply convoy with ${RESUPPLY.rounds} missiles sent to ${fu.name}, arriving in ${RESUPPLY.delayS / 60 | 0}:${String(RESUPPLY.delayS % 60).padStart(2, '0')}`, 'info');
  return null;
}

export function callRepair(w: World, site: Site): string | null {
  const err = repairError(w, site);
  if (err) return err;
  w.supportSpentM += FIELD_REPAIR.costM;
  w.support.push({ kind: 'repair', t: w.t + FIELD_REPAIR.delayS, site });
  w.log(`Field repair team sent to ${site.name}`, 'info');
  return null;
}

/** Deliver support calls that have arrived. */
export function stepSupport(w: World): void {
  if (!w.support.length || w.support[0].t > w.t) return;
  w.support.sort((a, b) => a.t - b.t);
  while (w.support.length && w.support[0].t <= w.t) {
    const c = w.support.shift()!;
    if (c.kind === 'resupply' && c.fu) {
      const fu = c.fu;
      fu.spares = (Number.isFinite(fu.spares) ? fu.spares : 0) + RESUPPLY.rounds;
      // Crews start reloading the empty rails straight away.
      for (const l of fu.launchers) if (l.site.alive && l.rounds < l.max && l.reloadAt === 0) l.reloadAt = w.t + fu.reloadS;
      w.log(`Resupply convoy reached ${fu.name}: +${RESUPPLY.rounds} spare missiles`, 'info');
    } else if (c.kind === 'repair' && c.site) {
      if (!c.site.alive) continue;
      c.site.hp = Math.min(100, c.site.hp + FIELD_REPAIR.hp);
      w.log(`Field repair on ${c.site.name} done (${Math.round(c.site.hp)}%)`, 'info');
    }
  }
}

/** Quick reaction alert: a fighter pair kept on the airbase that can be scrambled once a battle. */
export const QRA = { costM: 25, missiles: 2, fuelS: 1500 };

/** Why the alert pair cannot be scrambled now, or null. */
export function qraError(w: World): string | null {
  if (w.qraUsed) return 'already scrambled today';
  if (!w.site('Airbase')?.alive) return 'the airbase is out of action';
  if (QRA.costM > budgetLeft(w)) return 'not enough budget';
  return null;
}

/** Scramble the alert pair from the airbase. Returns why it cannot, or null. */
export function scrambleQra(w: World): string | null {
  const err = qraError(w);
  if (err) return err;
  w.qraUsed = true;
  w.supportSpentM += QRA.costM;
  w.addQra(QRA.missiles, QRA.fuelS);
  return null;
}
