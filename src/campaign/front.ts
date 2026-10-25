import type { DeployZone } from '../sim/deploy';
import { Rng } from '../sim/rng';
import { COLUMN } from '../sim/column';
import type { Terrain } from '../sim/terrain';

/**
 * The front line: a chain of towns from our airbase towards the enemy. Towns we hold pay income and widen the
 * ground our units may stand on; each one also leaves the enemy less room, so its raids shrink. A ground
 * offensive takes the next town if our air defence keeps the assault force alive for the day. Game-level
 * numbers throughout.
 */
export interface Town {
  name: string;
  x: number;
  y: number;
  incomeM: number;
  ours: boolean;
  hp: number;
  /** The last town is the enemy's forward airfield: taking it wins the campaign. */
  airfield?: boolean;
  /** Clock minute we took it (towns held 24 h are dug in). The starting town is dug in from the start. */
  heldSince?: number;
}

/** A town held this long (min) is dug in: armour needs to knock it below DUG_IN_HP to take it, not ARMOUR.takeHp. */
export const DUG_IN_MIN = 24 * 60;
export const DUG_IN_HP = 40;
/** Whether a town of ours is dug in at clock minute `now`. */
export const dugIn = (t: Town, now: number): boolean => t.ours && t.heldSince !== undefined && now - t.heldSince >= DUG_IN_MIN;

export interface FrontState {
  towns: Town[];
  /** Index of the town today's offensive goes for, or null for no offensive. */
  offensive: number | null;
}

/** How far up the road each town stands from the airbase (m), and what it pays a day ($M). */
const TOWN_V = [22000, 45000, 70000, 100000];
const TOWN_INCOME = [15, 20, 25, 30];
/** Ground units may stand within this of the airbase, and within TOWN_ZONE_M of a town we hold. */
export const AIRBASE_ZONE_M = 35000;
export const TOWN_ZONE_M = 25000;
/** A devastated town (raids knocked it to 0%) stays ours but only has this much room to deploy in (m). */
export const DEVASTATED_ZONE_M = 10000;
export const OFFENSIVE_COST_M = 30;
/** The assault force takes the town if it ends the day with at least this much health left. */
export const ASSAULT_HOLD = 40;
/** Each town held beyond the first cuts the enemy's daily raid strength by this fraction. */
export const TOWN_THREAT_CUT = 0.1;
/** A town just taken starts at this health. */
export const TAKEN_HP = 70;

const NAMES = ['Harrowfield', 'Kestrel Ford', 'Brennick', 'Vossmere', 'Ashby Cross', 'Tollen', 'Redwater', 'Marrin Hill', 'Saltbridge', 'Elderwick', 'Corran', 'Lowgate'];

/** Lay out this map's towns up the main approach: through the first pass where there are mountains. */
export function makeTowns(t: Terrain, seed: number): Town[] {
  const rng = new Rng(seed * 613 + 29);
  const names = [...NAMES];
  const towns: Town[] = [];
  const L = t.layout;
  TOWN_V.forEach((v0, i) => {
    // The road runs from the airbase up to the mouth of the first pass, then along it.
    const passFrom = Math.max(8000, L.mtnFrom - 6000);
    const roadU = (v: number): number => (v >= passFrom ? t.passU(0, v) : (t.passU(0, passFrom) * v) / passFrom);
    let spot: { x: number; y: number } | null = null;
    search: for (const dv of [0, 4000, -4000, 8000, -8000, 14000, 20000, 28000]) {
      const v = v0 + dv;
      for (const du of [0, 2000, -2000, 4000, -4000, 7000, -7000, 11000, -11000, 16000, -16000]) {
        const p = t.toWorld(roadU(v) + du, v);
        if (Math.hypot(p.x, p.y) > t.half - 15000) continue;
        if (!t.buildable(p.x, p.y, 70) || t.waterDist(p.x, p.y, 1000) < Infinity) continue;
        if (towns.some((o) => Math.hypot(o.x - p.x, o.y - p.y) < 15000)) continue;
        spot = { x: Math.round(p.x), y: Math.round(p.y) };
        break search;
      }
    }
    // A sea crossing too wide to cover from our side ends the road (peninsula maps).
    const prev = towns[towns.length - 1] ?? { x: 0, y: 0 };
    if (!spot || towns.length < i || Math.hypot(spot.x - prev.x, spot.y - prev.y) > 42000) return;
    const name = names.splice(rng.int(0, names.length - 1), 1)[0];
    towns.push({ name, x: spot.x, y: spot.y, incomeM: TOWN_INCOME[i], ours: false, hp: 100 });
  });
  if (towns.length) {
    towns[0].ours = true;
    towns[0].heldSince = -DUG_IN_MIN;
    const last = towns[towns.length - 1];
    if (towns.length >= 3) {
      last.airfield = true;
      last.name = `${last.name} airfield`;
    }
  }
  return towns;
}

export function newFront(t: Terrain, seed: number): FrontState {
  return { towns: makeTowns(t, seed), offensive: null };
}

/** Index of the next town up the road the enemy still holds, or -1. */
export function nextObjective(f: FrontState): number {
  return f.towns.findIndex((x) => !x.ours);
}

/** Our most forward town, or null. */
export function frontTown(f: FrontState): Town | null {
  const held = f.towns.filter((x) => x.ours);
  return held.length ? held[held.length - 1] : null;
}

export const townsHeld = (f: FrontState | undefined): number => f?.towns.filter((x) => x.ours).length ?? 0;

/** Where ground units may stand: round the airbase and round every town we hold. */
export function deployZones(f: FrontState | undefined): DeployZone[] {
  const zones: DeployZone[] = [{ x: 0, y: 0, r: AIRBASE_ZONE_M }];
  for (const tn of f?.towns ?? []) if (tn.ours) zones.push({ x: tn.x, y: tn.y, r: tn.hp > 0 ? TOWN_ZONE_M : DEVASTATED_ZONE_M });
  return zones;
}

/** Where the assault force digs in for an offensive on town `i`: short of it, on the road from our side. */
export function assaultSpot(t: Terrain, f: FrontState, i: number): { x: number; y: number } {
  const tn = f.towns[i];
  const prev = i > 0 ? f.towns[i - 1] : { x: 0, y: 0 };
  const d = Math.hypot(tn.x - prev.x, tn.y - prev.y);
  for (const back of [4000, 3000, 5000, 2000, 6500, 1000]) {
    const k = Math.max(0, 1 - back / d);
    const x = Math.round(prev.x + (tn.x - prev.x) * k);
    const y = Math.round(prev.y + (tn.y - prev.y) * k);
    if (t.buildable(x, y, 90)) return { x, y };
  }
  return { x: tn.x, y: tn.y };
}

/** Daily income from the towns we hold: a battered town pays less. */
export function townIncome(f: FrontState | undefined): number {
  return Math.round((f?.towns ?? []).filter((x) => x.ours && x.hp > 0).reduce((s, x) => s + x.incomeM * (0.5 + x.hp / 200), 0));
}

/** Where the assault column sets off: back down the road from its start line, towards the town before it. */
export function columnStart(t: Terrain, f: FrontState, i: number): { x: number; y: number } {
  const at = assaultSpot(t, f, i);
  const prev = i > 0 ? f.towns[i - 1] : { x: 0, y: 0 };
  const d = Math.hypot(prev.x - at.x, prev.y - at.y);
  // It drives the road, so it does not need buildable ground to set off from.
  const m = Math.min(d, COLUMN.maxRunM);
  return { x: Math.round(at.x + ((prev.x - at.x) * m) / Math.max(1, d)), y: Math.round(at.y + ((prev.y - at.y) * m) / Math.max(1, d)) };
}
