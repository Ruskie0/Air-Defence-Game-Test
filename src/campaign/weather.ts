import { Rng } from '../sim/rng';

/** Each campaign day's weather. It is forecast in the briefing and changes what works in the battle. */
export type WeatherId = 'clear' | 'overcast' | 'rain' | 'fog' | 'wind' | 'storm';

export interface Weather {
  name: string;
  /** Briefing line: what it does. */
  desc: string;
  /** Laser kill rate multiplier. */
  laser: number;
  /** Extra loss (dB) for radars at 8 GHz and above (X band and up): rain soaks up their energy. */
  radarLossDb: number;
  /** Speed multiplier for attack and decoy drones (a headwind slows them down). */
  droneSpeed: number;
  /** Too rough for drones of any kind: the enemy sends none. */
  noDrones: boolean;
}

export const WEATHER: Record<WeatherId, Weather> = {
  clear: { name: 'Clear', desc: 'Clear skies: nothing gets in the way.', laser: 1, radarLossDb: 0, droneSpeed: 1, noDrones: false },
  overcast: { name: 'Overcast', desc: 'Low cloud: lasers lose some of their punch.', laser: 0.75, radarLossDb: 0, droneSpeed: 1, noDrones: false },
  rain: { name: 'Rain', desc: 'Rain: lasers are badly hampered and X-band radars (MR, CIWS, fighters) see about 15% less far.', laser: 0.4, radarLossDb: 3, droneSpeed: 1, noDrones: false },
  fog: { name: 'Fog', desc: 'Thick fog: lasers are at half power. Radars do not care.', laser: 0.5, radarLossDb: 0.5, droneSpeed: 1, noDrones: false },
  wind: { name: 'Strong wind', desc: 'A strong headwind: enemy drones crawl in about a third slower, giving our guns more time.', laser: 0.9, radarLossDb: 0, droneSpeed: 0.7, noDrones: false },
  storm: { name: 'Storm', desc: 'A storm: no enemy drone can fly, lasers are nearly useless and X-band radars see about 20% less far. Expect missiles and jets instead.', laser: 0.2, radarLossDb: 4, droneSpeed: 1, noDrones: true },
};

/** The weather for a day. Day 1 is always clear so the first battle is a fair introduction. */
export function rollWeather(seed: number, day: number): WeatherId {
  if (day <= 1) return 'clear';
  const rng = new Rng(seed * 2741 + day * 613);
  const table: [WeatherId, number][] = [['clear', 40], ['overcast', 20], ['rain', 14], ['fog', 10], ['wind', 10], ['storm', 6]];
  let r = rng.next() * 100;
  for (const [id, w] of table) {
    r -= w;
    if (r <= 0) return id;
  }
  return 'clear';
}
