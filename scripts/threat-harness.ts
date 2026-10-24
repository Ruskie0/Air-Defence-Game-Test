// Kill and leaker counts per threat type against the sandbox defence, from many short fresh battles.
// Each case spawns one package from each of eight bearings (repeated `reps` times with new seeds) into a
// world with no scripted raids, runs it until no red munition is left, and reads every threat's fate.
// Usage: npm run harness -- [--only=arm,cruise] [--reps=N] [--seed=S] [--map=classic|mountain|...] [--extra=GUN,LASER] [--drop=MR,SH]
// --extra adds units of those types (in a ring 1.5 km round the airbase) to the sandbox defence.
import { World } from '../src/sim/world';
import type { Entity, Kind } from '../src/sim/entities';
import { spawnThreat, ThreatType } from '../src/sim/threats';
import { Terrain, MapType } from '../src/sim/terrain';
import { UnitType, newUnit } from '../src/sim/catalog';
import { nearestFree, sandboxDeployment } from '../src/sim/deploy';

const arg = (k: string): string | undefined => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
const only = arg('only')?.split(',');
const reps = Number(arg('reps') ?? 1);
const seed0 = Number(arg('seed') ?? 1000);
const mapArg = arg('map') as MapType | 'classic' | undefined;

interface Case {
  name: string;
  threat: ThreatType;
  /** Kinds counted for this case (the SEAD case counts the ARMs it fires). */
  kinds: Kind[];
  wcs?: 'TIGHT' | 'FREE';
}

const CASES: Case[] = [
  { name: 'arm', threat: 'sead', kinds: ['arm'] },
  { name: 'drone', threat: 'drones', kinds: ['drone'] },
  { name: 'cruise', threat: 'cruise', kinds: ['cruise'] },
  { name: 'alcm', threat: 'bomber', kinds: ['cruise'] },
  { name: 'tbm', threat: 'tbm', kinds: ['tbm'] },
];

const terrain = mapArg && mapArg !== 'classic' ? new Terrain(seed0, mapArg) : new Terrain(20261023);
const BEARINGS = [0, 45, 90, 135, 180, 225, 270, 315];
const extra = (arg('extra')?.split(',') ?? []) as UnitType[];
const deployment = sandboxDeployment(terrain);
const drop = arg('drop')?.split(',') ?? [];
deployment.units = deployment.units.filter((u) => !drop.includes(u.type));
extra.forEach((type, i) => {
  const a = (i / extra.length) * Math.PI * 2;
  const p = nearestFree(terrain, type, Math.sin(a) * 1500, Math.cos(a) * 1500, deployment.units, -1, 500);
  deployment.units.push(newUnit(100 + i, type, p.x, p.y, terrain.layout.rot));
});

interface Tally {
  n: number;
  killed: number;
  hit: number;
  missed: number;
  other: number;
  by: Record<string, number>;
}

const t0 = Date.now();
const out: [string, Tally][] = [];
for (const c of CASES) {
  if (only && !only.includes(c.name)) continue;
  const tally: Tally = { n: 0, killed: 0, hit: 0, missed: 0, other: 0, by: {} };
  for (let r = 0; r < reps; r++) {
    for (const b of BEARINGS) {
      const w = new World({ seed: seed0 + r * 101 + b, terrain, deployment: structuredClone(deployment), raids: [], civil: false });
      if (c.wcs) w.wcs = c.wcs;
      for (const j of w.gnss) j.on = true;
      spawnThreat(w, c.threat, (b + terrain.layout.rot) % 360);
      const seen = new Map<number, Entity>();
      const t1 = w.t;
      while (w.t - t1 < 900) {
        w.step();
        for (const e of w.entities) if (c.kinds.includes(e.kind) && e.side === 'red') seen.set(e.id, e);
        if (w.t - t1 > 30 && w.pendingCount === 0 && !w.entities.some((e) => e.alive && e.side === 'red' && (e.munition || e.kind === 'sead' || e.kind === 'bomber'))) break;
      }
      for (const e of seen.values()) {
        tally.n++;
        const f = e.fate;
        if (f?.air) {
          tally.killed++;
          tally.by[f.by] = (tally.by[f.by] ?? 0) + 1;
        } else if (f?.how === 'impact') {
          if (f.hit) tally.hit++;
          else tally.missed++;
        } else tally.other++;
      }
    }
  }
  out.push([c.name, tally]);
}

console.log(`map ${mapArg ?? 'classic'}, ${reps} x 8 bearings per case, ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
console.log('case      n  killed  leaked  missed  other   killed by');
for (const [name, t] of out) {
  const by = Object.entries(t.by)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(', ');
  console.log(`${name.padEnd(7)} ${String(t.n).padStart(3)}  ${String(t.killed).padStart(6)}  ${String(t.hit).padStart(6)}  ${String(t.missed).padStart(6)}  ${String(t.other).padStart(5)}   ${by}`);
}
