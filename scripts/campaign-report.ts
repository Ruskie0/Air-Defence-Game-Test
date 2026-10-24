// Headless campaign run with a simple automatic commander, for balancing the economy and the raids.
// Usage: npm run campaign -- [seed] [--verbose]
import { Campaign, Difficulty } from '../src/campaign/campaign';
import { PKG, SECTOR_NAMES, sectorOf } from '../src/campaign/raidgen';
import { CATALOG, UnitType } from '../src/sim/catalog';
import { DeepStrikeId, deepStrike, deepStrikeError } from '../src/campaign/deepstrike';
import { assaultSpot } from '../src/campaign/front';
import { nearestFree } from '../src/sim/deploy';
import { scrambleQra } from '../src/sim/support';

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
  // Push up the road when there is money to spare, and send a covering group forward with the assault force.
  const f = c.s.front;
  if (f && c.s.day >= 2 && count('MR') >= 2 && c.s.money > 140 && !process.argv.includes('--no-offensive') && c.launchOffensive()) {
    bought.push(`offensive on ${f.towns[f.offensive!].name}`);
    const at = assaultSpot(c.terrain, f, f.offensive!);
    const prev = f.offensive! > 0 ? f.towns[f.offensive! - 1] : { x: 0, y: 0 };
    const d = Math.hypot(at.x - prev.x, at.y - prev.y);
    const back = (m: number): { x: number; y: number } => ({ x: at.x + ((prev.x - at.x) * m) / d, y: at.y + ((prev.y - at.y) * m) / d });
    const escort: [UnitType, number, number][] = [['MR', 1, 6000], ['SH', 0, 1500], ['GUN', 0, 1000], ['CIWS', 1, 800]];
    for (const [t, which, m] of escort) {
      const us = c.units.filter((u) => u.type === t);
      const u = us[Math.min(which, us.length - 1)];
      if (!u) continue;
      const p = back(m);
      const q = nearestFree(c.terrain, t, p.x, p.y, c.units, u.uid, 600, c.zones);
      if (!c.place(c.terrain, u, q.x, q.y)) bought.push(`${t} forward`);
    }
  }
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
  // Keep a SHORAD unit and a gun with the front town, unless they go forward with an offensive below.
  const ft = c.s.front?.towns.filter((t) => t.ours).pop();
  if (ft) {
    const toward = Math.hypot(ft.x, ft.y);
    for (const [t, which, m] of [['SH', 1, 1500], ['GUN', 0, 900]] as [UnitType, number, number][]) {
      const u = c.units.filter((x) => x.type === t)[which];
      if (!u || Math.hypot(u.x - ft.x, u.y - ft.y) < 4000) continue;
      const q = nearestFree(c.terrain, t, ft.x - (ft.x * m) / toward, ft.y - (ft.y * m) / toward, c.units, u.uid, 600, c.zones);
      if (!c.place(c.terrain, u, q.x, q.y)) bought.push(`${t} to ${ft.name}`);
    }
  }
  for (const id of ['pdfuze', 'hardened'] as const) if (!saving && c.s.money > 150 && c.upgrade(id)) bought.push(id);
  for (const u of c.units) if (!saving && (u.type === 'LR' || u.type === 'MR') && c.s.money > 250 && c.addLauncher(u)) bought.push(`launcher ${u.type}`);
  return bought;
}

console.log(`Campaign seed ${seed}, ${diff}, enemy ${c.s.enemy.doctrine}`);
const t0 = Date.now();
while (!c.s.over) {
  const bought = shop();
  const day = c.s.day;
  const plan = c.s.plan.map((p) => `${PKG[p.kind].name}(${p.size}) ${SECTOR_NAMES[sectorOf(p.bearing)]}@${p.t}s`).join(', ');
  const w = c.makeWorld();
  const spent = c.s.money;
  if (process.argv.includes('--no-cb')) w.exposure.strikesLeft = 0;
  if (process.argv.includes('--no-enemy-ad')) (w as { enemyAd: unknown }).enemyAd = null;
  for (const j of w.gnss) j.on = true;
  const last = Math.max(0, ...w.scenario.raids.map((r) => r.t));
  const scoot = !process.argv.includes('--no-scoot');
  let cb = 0;
  // Sweep the enemy-held towns' air defences first thing: one fighter per town, nearest first.
  const sweep = !process.argv.includes('--no-sweep');
  // With no fighters of our own, scramble the alert pair to clear the way for an offensive.
  const sent = new Set<object>();
  while (!w.scenario.done && w.t < last + 1200) {
    w.step();
    if (sweep && w.enemyAd && w.t > 20 && w.t % 5 < 1 / 60) {
      const assault = w.sites.some((x) => x.role === 'assault');
      if (assault && !w.fighters.length && !w.qraUsed) scrambleQra(w);
      const towns = w.enemyAd.towns();
      for (const fg of w.fighters) {
        if (sent.has(fg) || !towns.length || fg.sweepError(w, towns[0])) continue;
        sent.add(fg);
        fg.sweep(w, towns.shift()!);
      }
    }
    // Shoot and scoot: move a located battery out from under the strike once its missiles in the air are
    // done (they need its radar), with time left to get clear. The LR battery takes too long to pack: it stays
    // and fights for itself.
    if (scoot && w.t % 1 < 1 / 60) {
      for (const l of w.exposure.located.slice(cb)) {
        if (l.moved || w.t > l.eta - 20) continue;
        const f = w.fielded.find((x) => x.unit.uid === l.uid);
        const code = f?.fu?.code ?? f?.radar?.code;
        if (!f || !code || f.unit.type === 'LR' || f.move) continue;
        if (f.fu && w.missiles.some((m) => m.alive && m.fu === f.fu)) continue;
        w.scootUnit(code);
      }
      while (cb < w.exposure.located.length && w.t > w.exposure.located[cb].eta) cb++;
    }
  }
  if (day === logDay) for (const e of w.logEntries) console.log(`  ${(e.t / 60).toFixed(1).padStart(5)} ${e.msg}`);
  const r = c.settle(w);
  const dmg = r.damage.filter((d) => d.lost > 0).map((d) => `${d.name} -${d.lost} (${d.hp})`).join(', ') || 'none';
  console.log(
    `\nDay ${day}  budget left after shopping $${Math.round(spent)}M  bought: ${bought.join(', ') || 'nothing'}` +
      `\n  raid: ${plan}` +
      (w.enemyAd ? `\n  enemy AD: ${w.enemyAd.sites.map((a) => `${a.site.name}${a.site.alive ? '' : ' (destroyed)'}`).join(', ')}; ${w.logEntries.filter((e) => e.msg.includes('enemy SAM')).length} SAM events` : '') +
      `\n  counter-battery: ${w.exposure.located.map((l) => `${l.unit}@${Math.round(l.t)}s${l.moved ? ' (moved)' : ''}`).join(', ') || 'none'}` +
      `\n  kills ${r.kills}, leakers ${r.leakers}, missiles ${r.missilesFired} ($${r.missileCostM}M), civil ${r.civilian}, fratricide ${r.fratricide}, ${Math.round(w.t / 60)} min` +
      `\n  damage: ${dmg}${r.losses.length ? `\n  lost: ${r.losses.join(', ')}` : ''}` +
      (r.front?.length ? `\n  front: ${r.front.join(' / ')}` : '') +
      (verbose && r.lessons.length ? `\n  lessons: ${r.lessons.join(' / ')}` : '') +
      `\n  income $${r.income}M`,
  );
}
console.log(`\n${c.s.over.won ? 'WON' : 'LOST'} on day ${c.s.day}: ${c.s.over.reason}  score ${c.score()}  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
console.log('Towns held:', c.s.front?.towns.filter((t) => t.ours).map((t) => t.name).join(', '));
console.log('Force at the end:', c.units.map((u) => u.type).join(' '));
