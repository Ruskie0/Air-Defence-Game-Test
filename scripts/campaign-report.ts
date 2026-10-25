// Headless campaign run with a simple automatic commander, for balancing the economy and the raids.
// Usage: npm run campaign -- [seed] [--verbose]
import { Tempo } from '../src/sim/tempo';
import { Campaign, Difficulty } from '../src/campaign/campaign';
import { PKG, SECTOR_NAMES, sectorOf } from '../src/campaign/raidgen';
import { CATALOG, UnitType } from '../src/sim/catalog';
import { DeepStrikeId, deepStrike, deepStrikeError, strikeTargets } from '../src/campaign/deepstrike';
import { stockText } from '../src/sim/theatre';
import { assaultSpot } from '../src/campaign/front';
import { nearestFree } from '../src/sim/deploy';
import { hhmm } from '../src/campaign/clock';
import { scrambleQra } from '../src/sim/support';
import { commanderShop } from './commander';

const seed = Number(process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 1);
const verbose = process.argv.includes('--verbose');
const logDay = Number(process.argv.find((a) => a.startsWith('--log-day='))?.split('=')[1] ?? 0);
const diff = (process.argv.find((a) => a.startsWith('--diff='))?.split('=')[1] ?? 'normal') as Difficulty;
const c = Campaign.create(seed, diff);
const shop = (): string[] => commanderShop(c);

console.log(`Campaign seed ${seed}, ${diff}, enemy ${c.s.enemy.doctrine}`);
const t0 = Date.now();
while (!c.s.over) {
  const bought = shop();
  const day = c.s.day;
  const slot = c.pulse;
  const plan = c.s.plan.map((p) => `${PKG[p.kind].name}(${p.size}) ${SECTOR_NAMES[sectorOf(p.bearing)]}@${p.t}s`).join(', ');
  const w = c.startPulse();
  const at = c.clock;
  const spent = c.s.money;
  if (process.argv.includes('--no-cb')) w.exposure.strikesLeft = 0;
  for (const j of w.gnss) j.on = true;
  const last = Math.max(0, ...w.scenario.raids.map((r) => r.t));
  const scoot = !process.argv.includes('--no-scoot');
  let cb = 0;
  let realS = 0;
  const tempo = new Tempo();
  let escorted = process.argv.includes('--no-escort');
  const sweep = !process.argv.includes('--no-sweep');
  const hunt = !process.argv.includes('--no-hunt');
  // Counterplay: the SAM radars radiate only while a hostile is within reach (EMCON preset 'near').
  const emcon = process.argv.includes('--emcon');
  if (emcon) for (const f of w.fielded) if (f.fu?.radar && f.fu.type !== 'SH') w.cycleEmcon(f.fu.radar.code);
  const sent = new Set<unknown>();
  while (!w.scenario.done && w.t < last + 3600) {
    w.step();
    // Sweep the SAM sites we know about first thing: one fighter each, the one nearest the assault force first.
    if (sweep && w.t > 20 && w.t % 5 < 1 / 60) {
      const targets = w.enemyAd.targets().filter((a) => !sent.has(a.base.id));
      if (targets.length && w.column?.alive && !w.fighters.length && !w.qraUsed) scrambleQra(w);
      for (const fg of w.fighters) {
        const a = targets.find((x) => !sent.has(x.base.id));
        if (!a || sent.has(fg) || fg.sweepError(w, a.base.id)) continue;
        sent.add(fg);
        sent.add(a.base.id);
        fg.sweep(w, a.base.id);
      }
    }
    // One fighter goes after the enemy AWACS once it is up and the fighter is on CAP.
    if (hunt && w.t % 5 < 1 / 60 && w.redSupport.awacsUp && !w.fighters.some((f) => f.state === 'hunt')) {
      const fg = w.fighters.find((f) => f.state === 'station' && !f.huntError(w, 'awacs'));
      if (fg) fg.hunt(w, 'awacs');
    }
    // Fighters escort the assault column while it is on the road.
    if (!escorted && w.column?.alive && w.t > 10) {
      escorted = true;
      for (const f of w.fighters) if (f.state !== 'sweep') f.escortColumn(w);
    }
    // Real time a player at 1x would spend on this battle with auto tempo on.
    realS += 1 / 60 / tempo.update(w);
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
  const stuck = w.entities.filter((e) => e.alive && e.side === 'red');
  if (verbose && stuck.length) console.log(`  still up at the end: ${stuck.map((e) => `${e.name}@${Math.round(Math.hypot(e.pos.x, e.pos.y) / 1000)}km`).join(', ')}`);
  if (day === logDay) for (const e of w.logEntries) console.log(`  ${(e.t / 60).toFixed(1).padStart(5)} ${e.msg}`);
  const r = c.settle(w);
  const dmg = r.damage.filter((d) => d.lost > 0).map((d) => `${d.name} -${d.lost} (${d.hp})`).join(', ') || 'none';
  console.log(
    `\nDay ${day} ${hhmm(at)} ${slot?.type ?? ''}  budget left after shopping $${Math.round(spent)}M  bought: ${bought.join(', ') || 'nothing'}` +
      `\n  raid: ${plan}` +
      `\n  enemy SAM: ${w.enemyAd.sites.map((a) => `${a.base.name}${a.site.alive ? '' : ' (destroyed)'}${a.base.known ? '' : ' (unknown)'}`).join(', ') || 'none'}; ${w.logEntries.filter((e) => e.msg.includes('by an enemy SAM')).length} fighters downed; hunts ${w.logEntries.filter((e) => e.msg.includes('going deep after the enemy AWACS')).length}, escort ${w.redSupport.escort}; AWACS ${w.deaths.some((e) => e.kind === 'awacs') ? 'shot down' : w.entities.some((e) => e.kind === 'awacs') ? 'flew' : 'none'}, tanker ${w.deaths.some((e) => e.kind === 'tanker') ? 'shot down' : w.entities.some((e) => e.kind === 'tanker') ? 'flew' : 'none'}` +
      `\n  counter-battery: ${w.exposure.located.map((l) => `${l.unit}@${Math.round(l.t)}s${l.moved ? ' (moved)' : ''}`).join(', ') || 'none'}` +
      `\n  kills ${r.kills}, leakers ${r.leakers}, missiles ${r.missilesFired} ($${r.missileCostM}M), civil ${r.civilian}, fratricide ${r.fratricide}, ${Math.round(w.t / 60)} min (${Math.round(realS / 60)} real at auto tempo)` +
      `\n  damage: ${dmg}${r.losses.length ? `\n  lost: ${r.losses.join(', ')}` : ''}` +
      (r.front?.length ? `\n  front: ${r.front.join(' / ')}` : '') +
      (verbose && r.lessons.length ? `\n  lessons: ${r.lessons.join(' / ')}` : '') +
      (r.enemy?.length ? `\n  enemy: ${r.enemy.join(' / ')}` : '') +
      (verbose ? `\n  theatre: ${c.theatre.map((b) => `${b.id}${b.known ? '*' : ''}${b.lost ? ' LOST' : ''} [${stockText(b)}]`).join('; ')}` : '') +
      `\n  bonus $${r.bonusM ?? 0}M${r.income ? `  income $${r.income}M` : ''}`,
  );
}
console.log(`\n${c.s.over.won ? 'WON' : 'LOST'} on day ${c.s.day} (${c.s.history.length} raids): ${c.s.over.reason}  score ${c.score()}  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
console.log('Towns held:', c.s.front?.towns.filter((t) => t.ours).map((t) => t.name).join(', '));
console.log('Force at the end:', c.units.map((u) => u.type).join(' '));
console.log(`Save size: ${(c.save().length / 1024).toFixed(1)} KB`);
