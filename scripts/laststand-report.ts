// Headless Last Stand run: the automatic TEWA fights, and the first reinforcement on offer is always taken.
// Usage: npx esbuild scripts/laststand-report.ts --bundle --platform=node --format=esm --outfile=playtest/laststand.mjs && node playtest/laststand.mjs [seed]
import { LastStand } from '../src/campaign/laststand';

(globalThis as { localStorage?: unknown }).localStorage ??= { getItem: () => null, setItem: () => undefined };
const seed = Number(process.argv[2] ?? 1);
const st = new LastStand(seed);
console.log(`Last Stand seed ${seed}, enemy ${st.c.s.enemy.doctrine}`);
const t0 = Date.now();
while (!st.over && st.w.t < 6 * 3600) {
  for (const j of st.w.gnss) j.on = true;
  st.w.step();
  if (st.update() && st.offer) {
    // LR when offered, else resupply every third wave, else the first card.
    const find = (id: string): number => st.offer!.findIndex((c) => c.id === id);
    const pick = find('LR') >= 0 ? find('LR') : find('resupply') >= 0 && st.wave % 3 === 0 ? find('resupply') : 0;
    const a = st.w.site('Airbase')!;
    console.log(`wave ${st.wave} held at ${(st.w.t / 60).toFixed(1)} min, airbase ${Math.round(a.hp)}%, kills ${st.w.stats.kills}, leakers ${st.w.stats.leakers}; took ${st.offer[pick].name}`);
    st.choose(pick);
  }
}
for (const e of st.w.logEntries.slice(-40)) if (/Airbase|Wave|impact|hit/i.test(e.msg)) console.log(`  ${(e.t / 60).toFixed(1)} ${e.msg}`);
console.log(`${st.over ?? 'time limit'}  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
