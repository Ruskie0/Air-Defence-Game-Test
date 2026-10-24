import { AAM_MSL, LR_MSL, MR_MSL, MissileSpec, SH_MSL } from './missile';

export type UnitType = 'LR' | 'MR' | 'SH' | 'CIWS' | 'GUN' | 'LASER' | 'EWR' | 'GAP' | 'GNSS' | 'DECOY' | 'JAM' | 'CAP';

/** One launcher of a SAM battery, at an absolute map position. */
export interface DeployedLauncher {
  x: number;
  y: number;
  rounds: number;
  max: number;
  /** Health carried over from an earlier raid (100 when absent). */
  hp?: number;
}

/** A unit as the campaign owns it between days: where it stands and what it has left. */
export interface DeployedUnit {
  /** Stable id across days. */
  uid: number;
  type: UnitType;
  /** Main site (radar, gun, emitter) or, for CAP, the centre of the patrol station. */
  x: number;
  y: number;
  /** Sector boresight for phased arrays (deg true). */
  facing: number;
  launchers: DeployedLauncher[];
  /** Spare missiles held at the battery for reloads (SAMs); Infinity in the sandbox. */
  spares: number;
  /** CAP: aircraft remaining in the pair. */
  aircraft: number;
  /** Radar starts the day on automatic ARM response. */
  armWatch?: boolean;
  /** Starts the day on hold fire (no automatic engagements). */
  holdFire?: boolean;
  /** Jammers and decoys: switched on (kept between days). */
  on?: boolean;
  /** Kills over the whole campaign: the crew's experience. */
  xp?: number;
  /** On loan for one day (an event): leaves when the day turns over. */
  loan?: boolean;
  /** Campaign clock (minutes) when a unit on order reaches the airbase depot; it sits out battles until then. */
  arrives?: number;
  /** Health of the main site (radar, gun, emitter) carried over from an earlier raid (100 when absent). */
  hp?: number;
  /** Exposure carried over from the last battle (the enemy still half remembers where it was firing from). */
  heat?: number;
}

/** Crew ranks by campaign kills. Each rank above Green makes the unit a little deadlier and quicker to reload. */
export const RANKS = [
  { name: 'Green', xp: 0, badge: '' },
  { name: 'Trained', xp: 4, badge: '★' },
  { name: 'Veteran', xp: 10, badge: '★★' },
  { name: 'Elite', xp: 20, badge: '★★★' },
];

/** Rank index (0 = Green) for a number of kills. */
export function rankOf(xp = 0): number {
  let r = 0;
  RANKS.forEach((k, i) => {
    if (xp >= k.xp) r = i;
  });
  return r;
}

export interface AssetState {
  name: string;
  hp: number;
}

export interface Deployment {
  units: DeployedUnit[];
  assets: AssetState[];
}

export interface UnitInfo {
  type: UnitType;
  name: string;
  /** Purchase price, $M, including the first load of missiles. */
  costM: number;
  /** First campaign day it can be bought. */
  unlockDay: number;
  /** Shown in the shop. */
  role: string;
  missile?: MissileSpec;
  /** SAMs: launchers that come with the battery, rounds per launcher, launcher limit. */
  launchers?: number;
  perLauncher?: number;
  maxLaunchers?: number;
  /** Price of one extra launcher, $M, loaded. */
  launcherCostM?: number;
  channels?: number;
  reloadS?: number;
  /** Radius drawn on the map when placing (km). */
  rangeKm: number;
  /** Has a sector that can be turned. */
  sector?: boolean;
}

export const CATALOG: Record<UnitType, UnitInfo> = {
  LR: {
    type: 'LR', name: 'LR SAM battery', costM: 280, unlockDay: 3, missile: LR_MSL,
    role: 'C-band phased array, 120° sector, 120 km missiles. The only missile that can intercept ballistic missiles (inside 40 km).',
    launchers: 2, perLauncher: 4, maxLaunchers: 4, launcherCostM: 30, channels: 9, reloadS: 600, rangeKm: 120, sector: true,
  },
  MR: {
    type: 'MR', name: 'MR SAM battery', costM: 130, unlockDay: 1, missile: MR_MSL,
    role: 'X-band 3D radar, 32 km active-radar missiles that can fire on any track in the picture.',
    launchers: 2, perLauncher: 6, maxLaunchers: 4, launcherCostM: 15, channels: 8, reloadS: 300, rangeKm: 32,
  },
  SH: {
    type: 'SH', name: 'SHORAD unit', costM: 40, unlockDay: 1, missile: SH_MSL,
    role: 'S-band search radar and 8 command-guided missiles, 10 km. Cheap, one target at a time.',
    launchers: 1, perLauncher: 8, maxLaunchers: 1, channels: 1, reloadS: 120, rangeKm: 10,
  },
  CIWS: {
    type: 'CIWS', name: 'CIWS gun', costM: 25, unlockDay: 1,
    role: 'Radar-directed 4500 rpm gun, 2.5 km. Last-ditch point defence: best against anti-radiation and cruise missiles, and it even gets a shot at a ballistic missile diving on it. Free to rearm.',
    rangeKm: 2.5,
  },
  GUN: {
    type: 'GUN', name: 'Skyburst 35 mm gun', costM: 35, unlockDay: 2,
    role: 'Airburst gun, 4.5 km. Shreds drones and cruise missiles further out than the CIWS; weak against ARMs. Cheap to rearm.',
    rangeKm: 4.5,
  },
  LASER: {
    type: 'LASER', name: 'Counter-drone laser', costM: 45, unlockDay: 4,
    role: 'High-energy laser, 3.5 km. Burns down drones one at a time and never runs out of shots, but overheats on long bursts and barely scratches missiles.',
    rangeKm: 3.5,
  },
  EWR: {
    type: 'EWR', name: 'Early warning radar', costM: 55, unlockDay: 1,
    role: 'L-band surveillance radar, 250 km, all round. Sees far and through most jamming, but is imprecise and draws SEAD.',
    rangeKm: 250,
  },
  GAP: {
    type: 'GAP', name: 'Gap-filler radar', costM: 30, unlockDay: 2,
    role: 'Low-level search radar on a 30 m mast, 25 km. Put it where hills hide the valleys: it spots low cruise missiles and drones early so the MR SAM can fire on them.',
    rangeKm: 25,
  },
  GNSS: {
    type: 'GNSS', name: 'GNSS jammer', costM: 15, unlockDay: 1,
    role: 'Denies satellite navigation within 30 km: GNSS-guided drones wander off their aim points.',
    rangeKm: 30,
  },
  DECOY: {
    type: 'DECOY', name: 'Radar decoy', costM: 10, unlockDay: 2,
    role: 'Radiates like an LR radar. Anti-radiation missiles that lose their target re-acquire it.',
    rangeKm: 1,
  },
  JAM: {
    type: 'JAM', name: 'EW jammer', costM: 40, unlockDay: 3,
    role: 'Noise-jams enemy aircraft within 90 km: SEAD fighters can only find radars close by, strike jets release their bombs off target, recon drones take no pictures. It radiates, so SEAD will come for it: keep a gun near it.',
    rangeKm: 90,
  },
  CAP: {
    type: 'CAP', name: 'Fighter pair (CAP)', costM: 170, unlockDay: 2, missile: AAM_MSL,
    role: 'Two fighters with airborne radar and 4 AAMs each. Place the patrol station; they intercept aircraft and jammers forward of the SAMs.',
    rangeKm: 15,
  },
};

/** Missile prices for rearming, $M per round. */
export const ROUND_COST: Partial<Record<UnitType, number>> = { LR: LR_MSL.costM, MR: MR_MSL.costM, SH: SH_MSL.costM };

/**
 * The sites the defence exists for (their positions come from the map). `vuln` scales warhead damage:
 * a large airbase shrugs off more hits than a substation.
 */
export const DEFENDED_ASSETS: { name: string; radius: number; valueM: number; vuln: number }[] = [
  { name: 'Airbase', radius: 320, valueM: 400, vuln: 0.4 },
  { name: 'CRC', radius: 40, valueM: 150, vuln: 1 },
  { name: 'Power plant', radius: 160, valueM: 250, vuln: 0.7 },
];

/** Default launcher layout around a battery's radar (metres, relative). */
export function launcherOffsets(type: UnitType, n: number, facing: number): [number, number][] {
  const out: [number, number][] = [];
  const ring = type === 'LR' ? 900 : type === 'MR' ? 2500 : 0;
  for (let i = 0; i < n; i++) {
    if (!ring) {
      out.push([0, 0]);
      continue;
    }
    const a = ((facing + 180 + (i - (n - 1) / 2) * (type === 'LR' ? 55 : 70)) * Math.PI) / 180;
    out.push([Math.sin(a) * ring, Math.cos(a) * ring]);
  }
  return out;
}

/** A new, fully loaded unit at (x, y). */
export function newUnit(uid: number, type: UnitType, x: number, y: number, facing = 0): DeployedUnit {
  const info = CATALOG[type];
  const n = info.launchers ?? 0;
  const launchers = launcherOffsets(type, n, facing).map(([dx, dy]) => ({ x: x + dx, y: y + dy, rounds: info.perLauncher!, max: info.perLauncher! }));
  const armWatch = type === 'LR' || type === 'MR' || type === 'EWR';
  const on = type === 'GNSS' || type === 'DECOY' || type === 'JAM' ? true : undefined;
  return { uid, type, x, y, facing, launchers, spares: 0, aircraft: type === 'CAP' ? 2 : 0, armWatch, on };
}
