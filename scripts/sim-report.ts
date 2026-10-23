// Headless balance report: runs the sandbox scenario with no browser and summarises every raid.
// Usage: npm run sim -- [simSeconds] [seed] [--log]
import { World } from '../src/sim/world';
import type { Entity } from '../src/sim/entities';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const showLog = process.argv.includes('--log');
const simSeconds = Number(args[0] ?? 3300);
const seed = Number(args[1] ?? 20261023);

const w = new World(seed);
const seen = new Map<number, { e: Entity; raid: string; born: number }>();
const fate = new Map<number, string>();
let raid = 'Background';
let logged = 0;

const t0 = Date.now();
while (w.t < simSeconds) {
  w.step();
  for (const r of w.scenario.raids) if (r.launched && w.t - r.t < 0.02) raid = r.name.split(':')[0];
  for (const e of w.entities) if (!seen.has(e.id)) seen.set(e.id, { e, raid, born: w.t });
  for (; logged < w.logSeq; logged++) {
    const entry = w.logEntries[w.logEntries.length - (w.logSeq - logged)];
    if (!entry) continue;
    if (showLog) console.log(`${fmt(entry.t)} ${entry.msg}`);
    const splash = /^Splash (\S+) \(\w+\) by (.+?)(?: \(.*)?$/.exec(entry.msg);
    if (splash) setFate(splash[1], `killed by ${splash[2]}`);
    const hit = /hit by (\S+)/.exec(entry.msg);
    if (hit) setFate(hit[1], `HIT ${entry.msg.split(' hit by')[0]}`);
    const imp = /^(\S+) impacted (\d+) m from (.*)$/.exec(entry.msg);
    if (imp) setFate(imp[1], `missed ${imp[3]} by ${imp[2]} m`);
  }
}

function setFate(name: string, f: string): void {
  for (const [id, s] of seen) if (s.e.name === name && !fate.has(id)) fate.set(id, f);
}

function fmt(t: number): string {
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
}

const byRaid = new Map<string, string[]>();
for (const [id, s] of seen) {
  if (s.e.side !== 'red') continue;
  let f = fate.get(id);
  if (!f) f = s.e.alive ? 'still alive' : 'gone (egressed or expired)';
  const list = byRaid.get(s.raid) ?? [];
  list.push(`  ${s.e.name.padEnd(8)} ${s.e.kind.padEnd(7)} ${f}`);
  byRaid.set(s.raid, list);
}
console.log(`\nseed ${seed}, ${fmt(w.t)} simulated in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
for (const [r, list] of byRaid) console.log(`\n${r}\n${list.join('\n')}`);
console.log('\nSites:', w.sites.filter((s) => s.hp < 100).map((s) => `${s.name} ${Math.round(s.hp)}%`).join(', ') || 'all intact');
console.log('Stats:', JSON.stringify(w.stats));
console.log('Rounds left:', w.units.map((u) => `${u.code} ${u.rounds}/${u.maxRounds}`).join(', '), '| CIWS', w.ciws.map((c) => c.ammo).join('/'));
