import type { Ident } from '../sim/tracker';

export const IDENT_COLOR: Record<Ident, string> = {
  HOS: '#ff4d4d',
  SUS: '#ff9f43',
  PEND: '#ffd84d',
  UNK: '#ffd84d',
  NEU: '#5ee07a',
  FRD: '#4da6ff',
};

export const IDENT_NAME: Record<Ident, string> = {
  HOS: 'Hostile',
  SUS: 'Suspect',
  PEND: 'Pending',
  UNK: 'Unknown',
  NEU: 'Neutral',
  FRD: 'Friend',
};

export const CLASS_NAME: Record<string, string> = {
  UNK: 'Unclassified',
  FW: 'Fixed wing',
  RW: 'Helicopter',
  CIV: 'Civil airliner',
  UAV: 'Drone / UAV',
  CM: 'Cruise missile',
  MSL: 'Fast missile (ARM)',
  TBM: 'Ballistic missile',
  JAM: 'Jammer',
};

export const fmtTime = (t: number): string => {
  const s = Math.max(0, Math.floor(t));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${h > 0 ? `${h}:` : ''}${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
};
