import { DEFENDED_ASSETS, DeployedLauncher, DeployedUnit, Deployment, UnitType } from './catalog';
import type { Terrain } from './terrain';

/** Furthest a ground unit may stand from the airbase (m). */
export const DEPLOY_RADIUS = 60000;
/** Furthest a CAP station may be (m). */
export const CAP_RADIUS = 120000;

/** A circle ground units may deploy in: around the airbase, or around a town we hold (campaign front line). */
export interface DeployZone {
  x: number;
  y: number;
  r: number;
}

/** The sandbox's deploy area: one circle round the airbase. */
export const DEFAULT_ZONES: readonly DeployZone[] = [{ x: 0, y: 0, r: DEPLOY_RADIUS }];

export const inZones = (zones: readonly DeployZone[], x: number, y: number): boolean => zones.some((z) => Math.hypot(x - z.x, y - z.y) <= z.r);

/** Why a unit of `type` cannot stand at (x, y) among `others`, or null if it can. */
export function placeError(t: Terrain, type: UnitType, x: number, y: number, others: readonly DeployedUnit[], uid = -1, zones: readonly DeployZone[] = DEFAULT_ZONES): string | null {
  const r = Math.hypot(x, y);
  if (type === 'CAP') return r > CAP_RADIUS ? `CAP stations must be within ${CAP_RADIUS / 1000} km` : null;
  if (!inZones(zones, x, y)) {
    return zones.length > 1
      ? `Too far out: units must stand within ${zones[0].r / 1000} km of the airbase or ${zones[1].r / 1000} km of a town we hold`
      : `Too far out: units must stand within ${zones[0].r / 1000} km of the airbase`;
  }
  if (t.groundAt(x, y) < 3 || t.heightAt(x, y) < 3) return 'That is water';
  if (!t.buildable(x, y)) return 'Too steep to emplace';
  for (const a of DEFENDED_ASSETS) {
    const p = t.asset(a.name);
    if (Math.hypot(p.x - x, p.y - y) < a.radius + 150) return `On top of the ${a.name}`;
  }
  for (const u of others) if (u.uid !== uid && u.type !== 'CAP' && Math.hypot(u.x - x, u.y - y) < 300) return 'Too close to another unit';
  return null;
}

/** The nearest point to (x, y), spiralling out, where the unit can stand (or (x, y) itself if none is found). */
export function nearestFree(t: Terrain, type: UnitType, x: number, y: number, others: readonly DeployedUnit[], uid = -1, spacing = 300, zones: readonly DeployZone[] = DEFAULT_ZONES): { x: number; y: number } {
  const ok = (px: number, py: number): boolean =>
    !placeError(t, type, px, py, others, uid, zones) && !others.some((u) => u.uid !== uid && u.type !== 'CAP' && type !== 'CAP' && Math.hypot(u.x - px, u.y - py) < spacing);
  if (ok(x, y)) return { x, y };
  for (let i = 1; i < 400; i++) {
    const a = i * 2.4;
    const r = 250 * Math.sqrt(i);
    const px = x + Math.sin(a) * r;
    const py = y + Math.cos(a) * r;
    if (ok(px, py)) return { x: Math.round(px), y: Math.round(py) };
  }
  return { x, y };
}

/**
 * The fixed order of battle of the sandbox, laid out for a threat from the enemy side of the map
 * (local frame: +v towards the enemy) and moved onto the nearest good ground.
 */
export function sandboxDeployment(t?: Terrain): Deployment {
  const units: DeployedUnit[] = [];
  const at = (u: number, v: number): { x: number; y: number } => (t ? t.toWorld(u, v) : { x: u, y: v });
  const add = (uid: number, type: UnitType, u: number, v: number, launchers: [number, number, number][] = [], extra: Partial<DeployedUnit> = {}): void => {
    let p = at(u, v);
    if (t && type !== 'CAP') p = nearestFree(t, type, Math.round(p.x), Math.round(p.y), units, uid, 1200);
    const dx = p.x - at(u, v).x;
    const dy = p.y - at(u, v).y;
    const ls: DeployedLauncher[] = launchers.map(([lu, lv, max]) => {
      const q = at(lu, lv);
      let lx = q.x + dx;
      let ly = q.y + dy;
      if (t && !t.buildable(lx, ly)) ({ x: lx, y: ly } = nearestFree(t, 'SH', lx, ly, []));
      return { x: Math.round(lx), y: Math.round(ly), rounds: max, max };
    });
    units.push({
      uid, type, x: Math.round(p.x), y: Math.round(p.y), facing: t?.layout.rot ?? 0, launchers: ls, spares: Infinity,
      aircraft: type === 'CAP' ? 2 : 0, armWatch: type === 'LR' || type === 'MR', ...extra,
    });
  };
  add(1, 'LR', 2500, 7000, [[1700, 6300, 4], [3400, 6200, 4], [2000, 7900, 4], [3200, 7800, 4]]);
  add(2, 'MR', -9000, 9000, [[-7500, 7000, 6], [-3000, 2600, 6], [-11000, 10500, 6]]);
  add(3, 'SH', 1500, -1600, [[1500, -1600, 8]]);
  add(4, 'CIWS', -700, 600);
  add(5, 'CIWS', 3000, 6500);
  add(6, 'GNSS', 0, 2500);
  add(7, 'DECOY', 4800, 8600);
  add(8, 'CAP', 0, 50000);
  add(9, 'JAM', -4500, 1500);
  return { units, assets: DEFENDED_ASSETS.map((a) => ({ name: a.name, hp: 100 })) };
}
