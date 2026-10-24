// Headless campaign run with a simple automatic commander, for balancing the economy and the raids.
// Usage: npm run campaign -- [seed] [--verbose]
import { Campaign, Difficulty } from '../src/campaign/campaign';
import { PKG, SECTOR_NAMES, sectorOf } from '../src/campaign/raidgen';
import { CATALOG, UnitType } from '../src/sim/catalog';
import { DeepStrikeId, deepStrike, deepStrikeError } from '../src/campaign/deepstrike';

const seed = Number(process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 1);
const verbose = process.argv.includes('--verbose');
const logDay = Number(process.argv.find((a) => a.startsWith('--log-day='))?.split('=')[1] ?? 0);
const diff = (process.argv.find((a) => a.startsWith('--diff='))?.split('=')[1] ?? 'normal') as Difficulty;
const c = Campaign.create(seed, diff);

/** What the automatic commander buys, in order, while it can afford it. */
function shop(): string[] {
  const bought: string[] = [];
  const count = (t: UnitType): number => c.units.filter((u) => u.type === t).length;
  for (const a of ['Airbase', 'CRC', 'Power plant']) if (c.repair(a)) bought.push(`repair ${a}`);
  for (const u of c.units) if (c.reload(u)) bought.push(`reload ${CATALOG[u.type].name}`);
  const wants: [UnitType, () => boolean][] = [
    ['LR', () => count('LR') < 1],
    ['EWR', () => count('EWR') < 1],
    ['GNSS', () => count('GNSS') < 1],
    ['CAP', () => count('CAP') < 1 && c.s.day >= 3],
    ['MR', () => count('MR') < 2],
    ['SH', () => count('SH') < 3],
    ['CIWS', () => count('CIWS') < 3],
    ['GUN', () => count('GUN') < 2],
    ['DECOY', () => count('DECOY') < 1 && c.s.day >= 4],
    ['JAM', () => count('JAM') < 1 && c.s.day >= 5],
    ['MR', () => count('MR') < 3],
    ['SH', () => count('SH') < 4],
    ['CIWS', () => count('CIWS') < 4],
    ['LR', () => count('LR') < 2 && c.s.day >= 6],
  ];
  for (const [t, want] of wants) {
    // Save up for the LR battery once it is unlocked rather than spending on extras.
    if (t !== 'LR' && c.unlocked('LR') && count('LR') < 1 && c.s.money - CATALOG[t].costM < CATALOG.LR.costM) continue;
    if (want() && c.buy(t)) bought.push(CATALOG[t].name);
  }
  for (const u of c.units) {
    if ((u.type === 'MR' || u.type === 'LR') && u.spares < 4 && c.buySpares(u)) bought.push(`spares ${u.type}`);
    if (c.replaceAircraft(u)) bought.push('replacement fighter');
  }
  const saving = c.unlocked('LR') && count('LR') < 1;
  // One deep strike a day at the biggest threat in today's plan, when there is money to spare.
  if (!saving && c.s.money > 70 && !process.argv.includes('--no-strikes')) {
    const has = (k: string): number => c.s.plan.filter((p) => p.kind === k).reduce((n, p) => n + p.size, 0);
    const order: [DeepStrikeId, number][] = [['tbm', has('tbm') * 3], ['airfield', has('strike') + has('sead') + has('bomber') * 3], ['drones', has('drones') / 3]];
    const best = order.filter(([id, v]) => v > 2 && !deepStrikeError(c, id)).sort((a, b) => b[1] - a[1])[0];
    if (best) {
      const r = deepStrike(c, best[0]);
      if (r) bought.push(`deep strike ${best[0]} (${c.s.deepStrike?.ok ? 'hit' : 'failed'})`);
    }
  }
  for (const id of ['pdfuze', 'hardened'] as const) if (!saving && c.s.money > 150 && c.upgrade(id)) bought.push(id);
  for (const u of c.units) if (!saving && (u.type === 'LR' || u.type === 'MR') && c.s.money > 250 && c.addLauncher(u)) bought.push(`launcher ${u.type}`);
  return bought;
}

console.log(`Campaign seed ${seed}, ${diff}`);
const t0 = Date.now();
while (!c.s.over) {
  const bought = shop();
  const day = c.s.day;
  const plan = c.s.plan.map((p) => `${PKG[p.kind].name}(${p.size}) ${SECTOR_NAMES[sectorOf(p.bearing)]}@${p.t}s`).join(', ');
  const w = c.makeWorld();
  for (const j of w.gnss) j.on = true;
  const last = Math.max(0, ...w.scenario.raids.map((r) => r.t));
  while (!w.scenario.done && w.t < last + 1200) w.step();
  if (day === logDay) for (const e of w.logEntries) console.log(`  ${(e.t / 60).toFixed(1).padStart(5)} ${e.msg}`);
  const r = c.settle(w);
  const dmg = r.damage.filter((d) => d.lost > 0).map((d) => `${d.name} -${d.lost} (${d.hp})`).join(', ') || 'none';
  console.log(
    `\nDay ${day}  budget left after shopping $${c.s.money - (c.s.over ? 0 : r.income)}M  bought: ${bought.join(', ') || 'nothing'}` +
      `\n  raid: ${plan}` +
      `\n  kills ${r.kills}, leakers ${r.leakers}, missiles ${r.missilesFired} ($${r.missileCostM}M), civil ${r.civilian}, fratricide ${r.fratricide}, ${Math.round(w.t / 60)} min` +
      `\n  damage: ${dmg}${r.losses.length ? `\n  lost: ${r.losses.join(', ')}` : ''}` +
      (verbose && r.lessons.length ? `\n  lessons: ${r.lessons.join(' / ')}` : '') +
      `\n  income $${r.income}M`,
  );
}
console.log(`\n${c.s.over.won ? 'WON' : 'LOST'} on day ${c.s.day}: ${c.s.over.reason}  score ${c.score()}  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
console.log('Force at the end:', c.units.map((u) => u.type).join(' '));
