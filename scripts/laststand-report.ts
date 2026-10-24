// Headless Last Stand run: the automatic TEWA fights, and the first reinforcement on offer is always taken.
// Usage: npx esbuild scripts/laststand-report.ts --bundle --platform=node --format=esm --outfile=playtest/laststand.mjs && node playtest/laststand.mjs [seed]
import { LastStand } from '../src/campaign/laststand';

(globalThis as { localStorage?: unknown }).localStorage ??= { getItem: () => null, setItem: () => undefined };
const seed = Number(process.argv[2] ?? 1);
const st = new LastStand(seed);
console.log(`Last Stand seed ${seed}, enemy ${st.c.s.enemy.doctrine}`);
const t0 = Date.now();
const scoot = !process.argv.includes('--no-scoot');
let cb = 0;
let moves = 0;
while (!st.over && st.w.t < 6 * 3600) {
  const w = st.w;
  for (const j of w.gnss) j.on = true;
  w.step();
  // Shoot and scoot as in the campaign report: move a located battery once its missiles are done.
  if (scoot && w.t % 1 < 1 / 60) {
    for (const l of w.exposure.located.slice(cb)) {
      if (l.moved || w.t > l.eta - 20) continue;
      const f = w.fielded.find((x) => x.unit.uid === l.uid);
      const code = f?.fu?.code ?? f?.radar?.code;
      if (!f || !code || f.unit.type === 'LR' || f.move) continue;
      if (f.fu && w.missiles.some((m) => m.alive && m.fu === f.fu)) continue;
      w.scootUnit(code);
      moves++;
    }
    while (cb < w.exposure.located.length && w.t > w.exposure.located[cb].eta) cb++;
    // Between waves, move whatever the enemy has had time to study.
    for (const f of w.fielded) {
      const code = f.fu?.code ?? f.radar?.code;
      if (code && !f.move && f.unit.type !== 'LR' && (f.heat ?? 0) >= 60 && !w.entities.some((e) => e.alive && e.side === 'red' && e.munition)) {
        w.scootUnit(code);
        moves++;
      }
    }
  }
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
console.log(`moves ${moves}, counter-battery strikes ${st.w.exposure.located.length}`);
console.log(`${st.over ?? 'time limit'}  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
