import type { UnitType } from './catalog';
import { placeError } from './deploy';
import { v3 } from './math';
import type { Fielded, World } from './world';

/**
 * Game stats for moving a unit during a battle: seconds to pack up, road speed (m/s) and seconds to set up
 * again. While packed, moving or setting up the unit is out of action: its radar is dark and it cannot fire.
 */
export const MOBILITY: Record<UnitType, { packS: number; speed: number; setupS: number }> = {
  LR: { packS: 150, speed: 10, setupS: 180 },
  MR: { packS: 60, speed: 12, setupS: 90 },
  SH: { packS: 10, speed: 18, setupS: 15 },
  CIWS: { packS: 30, speed: 12, setupS: 30 },
  GUN: { packS: 25, speed: 14, setupS: 30 },
  LASER: { packS: 20, speed: 16, setupS: 20 },
  EWR: { packS: 120, speed: 10, setupS: 150 },
  GAP: { packS: 40, speed: 14, setupS: 40 },
  GNSS: { packS: 15, speed: 16, setupS: 15 },
  JAM: { packS: 30, speed: 14, setupS: 30 },
  DECOY: { packS: 10, speed: 16, setupS: 10 },
  CAP: { packS: 0, speed: 0, setupS: 0 },
};

export type MovePhase = 'pack' | 'move' | 'setup';

export interface MoveOrder {
  phase: MovePhase;
  /** End of the pack or set-up phase. */
  until: number;
  to: { x: number; y: number };
  /** Where the main site was when the move started; every site of the unit keeps its offset from it. */
  from: { x: number; y: number };
  /** Each site's start position and its height above the ground (mast). */
  start: { x: number; y: number; mast: number }[];
  /** Metres covered so far. */
  done: number;
}

/** Human-readable state of a unit on the move, or '' if it is in action. */
export function moveStatus(w: World, f: Fielded): string {
  const m = f.move;
  if (!m) return '';
  const left = (s: number): string => `${Math.max(0, Math.ceil(s))} s`;
  if (m.phase === 'pack') return `packing up, ${left(m.until - w.t)}`;
  if (m.phase === 'setup') return `setting up, ${left(m.until - w.t)}`;
  const total = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y);
  return `on the move, ${((total - m.done) / 1000).toFixed(1)} km to go`;
}

/** Out of action (or back in): radar dark, no fire, jammer and decoy off. */
function stow(w: World, f: Fielded, on: boolean): void {
  f.fu?.stow(on);
  if (f.radar) {
    f.radar.stowed = on;
    if (on) f.radar.armSilent = false;
  }
  const main = f.sites[0];
  for (const g of w.gnss) if (g.site === main) g.stowed = on;
  for (const d of w.decoys) if (d.site === main) d.stowed = on;
  for (const j of w.ewj) if (j.site === main) j.stowed = on;
}

/** Why the unit cannot be sent to (x, y), or null if it can. */
export function moveError(w: World, f: Fielded, x: number, y: number): string | null {
  const u = f.unit;
  if (u.type === 'CAP') return placeError(w.terrain, 'CAP', x, y, []);
  if (!f.sites[0]?.alive) return 'destroyed';
  const others = w.fielded.filter((o) => o !== f).map((o) => (o.move ? { ...o.unit, x: o.move.to.x, y: o.move.to.y } : o.unit));
  return placeError(w.terrain, u.type, x, y, others, u.uid);
}

/** Order a ground unit to a new position (or a CAP pair to a new station). Returns why it cannot go, or null. */
export function orderMove(w: World, f: Fielded, x: number, y: number): string | null {
  const err = moveError(w, f, x, y);
  if (err) return err;
  const u = f.unit;
  if (u.type === 'CAP') {
    u.x = x;
    u.y = y;
    for (const fi of f.fighters ?? []) {
      if (!fi.alive) continue;
      if (fi.state === 'station') fi.toStation(w, v3(x, y, 8000));
      else fi.station = v3(x, y, 8000);
    }
    w.log(`CAP station moved ${(Math.hypot(x, y) / 1000).toFixed(0)} km out`, 'info');
    return null;
  }
  const main = f.sites[0].pos;
  const mob = MOBILITY[u.type];
  const m = f.move;
  if (m && m.phase !== 'setup') {
    // Change of destination: keep packing, or turn round from where the unit is now.
    if (m.phase === 'move') {
      m.start = f.sites.map((s) => ({ x: s.pos.x, y: s.pos.y, mast: s.pos.z - w.terrain.groundAt(s.pos.x, s.pos.y) }));
      m.from = { x: main.x, y: main.y };
      m.done = 0;
    }
    m.to = { x, y };
  } else {
    f.move = {
      phase: 'pack',
      until: w.t + mob.packS * w.mods.moveMult,
      to: { x, y },
      from: { x: main.x, y: main.y },
      start: f.sites.map((s) => ({ x: s.pos.x, y: s.pos.y, mast: s.pos.z - w.terrain.groundAt(s.pos.x, s.pos.y) })),
      done: 0,
    };
    stow(w, f, true);
  }
  const km = Math.hypot(x - main.x, y - main.y) / 1000;
  w.log(`${f.fu?.name ?? f.ciws?.name ?? f.radar?.name ?? f.sites[0].name} ordered to move ${km.toFixed(1)} km: out of action until set up`, 'info');
  return null;
}

/** Put every site of a moving unit `d` metres along its route (clamped to the destination). */
function place(w: World, f: Fielded, d: number): void {
  const m = f.move!;
  const dx = m.to.x - m.from.x;
  const dy = m.to.y - m.from.y;
  const total = Math.hypot(dx, dy);
  const k = total > 0 ? Math.min(1, d / total) : 1;
  f.sites.forEach((s, i) => {
    const st = m.start[i];
    const x = st.x + dx * k;
    const y = st.y + dy * k;
    s.pos.x = x;
    s.pos.y = y;
    s.pos.z = w.terrain.groundAt(x, y) + st.mast;
  });
  if (f.radar && f.sites[0]) {
    f.radar.pos.x = f.sites[0].pos.x;
    f.radar.pos.y = f.sites[0].pos.y;
    f.radar.pos.z = f.sites[0].pos.z;
  }
  f.unit.x = Math.round(f.sites[0].pos.x);
  f.unit.y = Math.round(f.sites[0].pos.y);
}

/** Launchers that ended up in water or on a cliff pull in next to the radar. */
function tidyLaunchers(w: World, f: Fielded): void {
  const main = f.sites[0];
  f.sites.forEach((s, i) => {
    if (i === 0 || w.terrain.buildable(s.pos.x, s.pos.y)) return;
    const a = i * 2.1;
    s.pos.x = main.pos.x + Math.sin(a) * 400;
    s.pos.y = main.pos.y + Math.cos(a) * 400;
    s.pos.z = w.terrain.groundAt(s.pos.x, s.pos.y) + f.move!.start[i].mast;
  });
}

function arrive(w: World, f: Fielded): void {
  place(w, f, Infinity);
  tidyLaunchers(w, f);
}

/** Advance every unit on the move by one step. Returns true if a unit arrived (its coverage changed). */
export function stepMoves(w: World, dt: number): boolean {
  let moved = false;
  for (const f of w.fielded) {
    const m = f.move;
    if (!m) continue;
    if (!f.sites[0].alive) {
      f.move = null;
      continue;
    }
    if (m.phase === 'pack' && w.t >= m.until) m.phase = 'move';
    if (m.phase === 'move') {
      const total = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y);
      m.done += MOBILITY[f.unit.type].speed * dt;
      place(w, f, m.done);
      if (m.done >= total) {
        arrive(w, f);
        moved = true;
        m.phase = 'setup';
        m.until = w.t + MOBILITY[f.unit.type].setupS * w.mods.moveMult;
      }
    } else if (m.phase === 'setup' && w.t >= m.until) {
      f.move = null;
      stow(w, f, false);
      w.log(`${f.fu?.name ?? f.ciws?.name ?? f.radar?.name ?? f.sites[0].name} set up and ready`, 'info');
    }
  }
  return moved;
}

/** End of the day: units still on the move reach their new positions overnight. */
export function finishMoves(w: World): void {
  for (const f of w.fielded) {
    if (!f.move) continue;
    if (f.sites[0].alive) arrive(w, f);
    f.move = null;
    stow(w, f, false);
  }
}
