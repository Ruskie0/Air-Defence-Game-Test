import { Rng } from '../sim/rng';
import type { Asset } from '../sim/theatre';
import type { UnitType } from '../sim/catalog';
import type { PkgKind, PlanOpts } from './raidgen';

/**
 * The continuous campaign clock. The war runs on one clock (minutes since midnight before day 1). Each day the
 * enemy flies two to four operations ("pulses"), each one a battle; between them the clock jumps ahead and the
 * player plans. Logistics take time on the same clock. Game-level pacing, not a real air tasking cycle.
 */

/** The campaign starts at 06:00 on day 1, and every day turns over at 06:00, when the day's income is paid. */
export const DAY_START_MIN = 6 * 60;

export const dayOf = (clock: number): number => Math.floor((clock - DAY_START_MIN) / 1440) + 1;

/** "14:20". */
export function hhmm(clock: number): string {
  const m = ((Math.round(clock) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** "Day 3, 14:20" (a night pulse after midnight still belongs to the day it started in). */
export const stamp = (clock: number): string => `Day ${dayOf(clock)}, ${hhmm(clock)}`;

/** Night is from 20:00 to 05:30. */
export function isNight(clock: number): boolean {
  const m = ((clock % 1440) + 1440) % 1440;
  return m >= 20 * 60 || m < 5.5 * 60;
}

export type PulseType = 'probe' | 'strike' | 'night';

/** One enemy operation planned for the day. */
export interface PulseSlot {
  /** When the first package launches (clock minutes). */
  at: number;
  type: PulseType;
  /** Share of the day's threat budget. */
  share: number;
}

const ALL: PkgKind[] = ['drones', 'decoys', 'recon', 'cruise', 'strike', 'helo', 'sead', 'soj', 'bomber', 'tbm'];

/** What each kind of operation looks like. */
export const PULSES: Record<PulseType, { name: string; desc: string; opts: Omit<PlanOpts, 'budget'> }> = {
  probe: {
    name: 'Dawn probe',
    desc: 'drones and recon feeling out our defences',
    opts: { allow: ['drones', 'decoys', 'recon', 'cruise'], bias: { drones: 1.6, recon: 2, decoys: 1.3, cruise: 0.5 }, darkChance: 0 },
  },
  strike: {
    name: 'Combined strike',
    desc: 'the turned-round strike force, jets and missiles together',
    opts: { allow: ALL, bias: { strike: 1.4, sead: 1.3, helo: 1.3, soj: 1.2, bomber: 1.2 }, darkChance: 0.3 },
  },
  night: {
    name: 'Night strike',
    desc: 'ballistic and cruise missiles and drones under cover of dark',
    opts: { allow: ['drones', 'decoys', 'cruise', 'tbm', 'sead', 'soj', 'bomber'], bias: { tbm: 1.8, cruise: 1.4, drones: 1.2, sead: 0.6 }, darkChance: 0.15 },
  },
};

/** Candidate windows for each kind of operation (hours after the day's 06:00 start, earliest and latest). */
const WINDOWS: { type: PulseType; from: number; to: number; share: number }[] = [
  { type: 'probe', from: 0.5, to: 2, share: 0.16 },
  { type: 'strike', from: 4.5, to: 7.5, share: 0.38 },
  { type: 'strike', from: 10, to: 13, share: 0.3 },
  { type: 'night', from: 16, to: 20, share: 0.24 },
];

/** Plan the day's operations: two on day 1, three or four later, with the budget shares normalised. */
export function scheduleDay(day: number, seed: number): PulseSlot[] {
  const rng = new Rng(seed * 9173 + day * 613);
  const start = DAY_START_MIN + (day - 1) * 1440;
  let pick: number[];
  if (day === 1) pick = [1, 2];
  else if (day <= 3) pick = rng.chance(0.5) ? [0, 1, 3] : [1, 2, 3];
  else pick = rng.chance(0.7) ? [0, 1, 2, 3] : [0, 1, 3];
  const total = pick.reduce((t, i) => t + WINDOWS[i].share, 0);
  return pick.map((i) => {
    const wnd = WINDOWS[i];
    return { at: Math.round(start + rng.range(wnd.from, wnd.to) * 60), type: wnd.type, share: wnd.share / total };
  });
}

/** Hours from ordering a unit until it reaches the airbase depot. */
export const DELIVERY_H: Record<UnitType, number> = {
  SH: 2, CIWS: 2, GUN: 2, LASER: 3, GNSS: 1, DECOY: 1, GAP: 3, EWR: 4, JAM: 3, MR: 6, LR: 10, CAP: 4,
};

/** Hours an aircraft needs after a sortie before it can fly again. */
export const TURNAROUND_H: Partial<Record<Asset, number>> = { strike: 6, sead: 6, helo: 5, recon: 4, bomber: 10, soj: 10 };

/** Repair crews restore this many health points an hour. */
export const REPAIR_PER_H = 15;
