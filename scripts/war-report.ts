// Headless run of the living war with a simple automatic commander, for balancing.
// Usage: npm run war -- [seed] [--verbose] [--diff=easy|normal|hard] [--threat=1.7] [--emcon]
import { CAMPAIGN_DAYS, Campaign, Difficulty, setDayThreat } from '../src/campaign/campaign';
import { War } from '../src/campaign/war';
import { CATALOG, UnitType } from '../src/sim/catalog';
import { deepStrike, deepStrikeError, strikeTargets } from '../src/campaign/deepstrike';
import { stockText } from '../src/sim/theatre';
import { nextObjective } from '../src/campaign/front';
import { nearestFree } from '../src/sim/deploy';
import { stamp } from '../src/campaign/clock';
import { Tempo } from '../src/sim/tempo';

const args = process.argv.slice(2);
const seed = Number(args.find((a) => !a.startsWith('--')) ?? 1);
const verbose = args.includes('--verbose');
const flag = (f: string): boolean => args.includes(f);
const thr = args.find((a) => a.startsWith('--threat='));
if (thr) setDayThreat(Number(thr.split('=')[1]));
const diff = (args.find((a) => a.startsWith('--diff='))?.split('=')[1] ?? 'normal') as Difficulty;
const c = Campaign.create(seed, diff);
const war = new War(c);
const w = (): typeof war.w => war.w;

/** What the commander buys, in order, while it can afford it (as the raid campaign's commander did). */
function shop(): string[] {
  war.sync();
  const out: string[] = [];
  const count = (t: UnitType): number => c.units.filter((u) => u.type === t).length;
  for (const a of ['Airbase', 'CRC', 'Power plant']) if (c.repair(a)) out.push(`repair ${a}`);
  for (const u of c.units) if (c.reload(u)) out.push(`reload ${u.type}`);
  const wants: [UnitType, () => boolean][] = [
    ['LR', () => count('LR') < 1], ['EWR', () => count('EWR') < 1], ['GNSS', () => count('GNSS') < 1],
    ['CAP', () => count('CAP') < 1 && c.s.day >= 3], ['MR', () => count('MR') < 2], ['SH', () => count('SH') < 3],
    ['CIWS', () => count('CIWS') < 3], ['GUN', () => count('GUN') < 2], ['DECOY', () => count('DECOY') < 1 && c.s.day >= 4],
    ['JAM', () => count('JAM') < 1 && c.s.day >= 5], ['MR', () => count('MR') < 3], ['SH', () => count('SH') < 4],
    ['CIWS', () => count('CIWS') < 4], ['LR', () => count('LR') < 2 && c.s.day >= 6], ['CAP', () => count('CAP') < 2 && c.s.day >= 5],
  ];
  for (const [t, want] of wants) {
    if (t !== 'LR' && !(t === 'CAP' && c.s.day >= 4) && c.unlocked('LR') && count('LR') < 1 && c.s.money - c.price(t) < CATALOG.LR.costM) continue;
    if (want() && c.buy(t)) out.push(`buy ${t}`);
  }
  for (const u of c.units) if ((u.type === 'MR' || u.type === 'LR') && u.spares < 4 && c.buySpares(u)) out.push(`spares ${u.type}`);
  for (const u of c.units) if (c.replaceAircraft(u)) out.push('fighter');
  war.applyAll();
  if (c.s.money > 70 && !flag('--no-strikes')) {
    const weight: Record<string, number> = { tbm: 3, cruise: 1, strike: 2, sead: 2, recon: 1, helo: 1.5, drone: 0.3, shell: 2 };
    const value = (id: string): number => Object.entries(c.theatre.find((x) => x.id === id)!.stock).reduce((t, [a, n]) => t + Math.floor(n ?? 0) * (weight[a] ?? 1), 0);
    const best = strikeTargets(c).map((b) => b.id).filter((id) => !deepStrikeError(c, id) && value(id) > 6).sort((a, b) => value(b) - value(a))[0];
    if (best && deepStrike(c, best)) out.push(`deep strike ${best} (${c.s.deepStrike?.ok ? 'hit' : 'failed'})`);
  }
  if (c.s.money > 80 && !c.armourStrikeError()) out.push(`armour strike: ${c.strikeArmour()}`);
  const f = c.s.front;
  const covered = count('MR') + count('LR') >= 2 && count('SH') >= 1;
  if (f && covered && c.s.money > 130 && !flag('--no-offensive') && war.launchOffensive()) out.push(`offensive on ${f.towns[f.offensive!].name}`);
  // Units the enemy has a fix on move a couple of kilometres (the LR battery stays and fights).
  for (const fl of w().fielded) {
    const u = fl.unit;
    if (u.type === 'CAP' || u.type === 'LR' || fl.move || !w().exposure.fixOn(u.uid)) continue;
    const a = ((u.uid * 137 + c.s.day * 61) % 360) * (Math.PI / 180);
    const q = nearestFree(c.terrain, u.type, u.x + Math.cos(a) * 2500, u.y + Math.sin(a) * 2500, c.units, u.uid, 600, c.zones);
    if (!war.move(u, q.x, q.y)) out.push(`${u.type} relocated`);
  }
  if (flag('--emcon')) for (const fl of w().fielded) if (fl.fu?.radar && fl.fu.type !== 'SH' && fl.fu.radar.emcon === 'on') w().cycleEmcon(fl.fu.radar.code);
  return out;
}

console.log(`Living war, seed ${seed}, ${diff}, enemy ${c.s.enemy.doctrine}`);
const t0 = Date.now();
let realS = 0;
let simStepped = 0;
const tempo = new Tempo();
tempo.max = 64;
const slow = new Map<string, number>();
war.onDay = (r) => {
  const dmg = r.damage.filter((d) => d.lost > 0).map((d) => `${d.name} -${d.lost} (${d.hp})`).join(', ') || 'none';
  console.log(
    `\nDay ${r.day}: kills ${r.kills}, leakers ${r.leakers}, missiles ${r.missilesFired} ($${r.missileCostM}M), civil ${r.civilian}, income $${r.income}M, money now $${Math.round(c.s.money)}M` +
      `\n  damage: ${dmg}${r.losses.length ? `\n  lost: ${r.losses.join(', ')}` : ''}` +
      (r.front?.length ? `\n  front: ${r.front.join(' / ')}` : '') +
      (r.enemy?.length ? `\n  enemy: ${r.enemy.slice(0, verbose ? 99 : 4).join(' / ')}` : '') +
      (verbose && r.lessons.length ? `\n  lessons: ${r.lessons.join(' / ')}` : '') +
      `\n  real time by cause (min): ${[...slow].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${Math.round(v / 60)}`).join(', ')}` +
      `\n  real time so far at auto tempo: ${Math.round(realS / 60)} min; artillery barrages ${w().logEntries.filter((e) => e.msg.startsWith('Artillery fire')).length}` +
      (verbose ? `\n  theatre: ${c.theatre.map((b) => `${b.id}${b.known ? '*' : ''}${b.lost ? ' LOST' : ''} [${stockText(b)}]`).join('; ')}` : ''),
  );
};
let nextShop = 0;
const ops: string[] = [];
let raidsSeen = 0;
while (!c.s.over) {
  const W = w();
  if (W.t >= nextShop) {
    const bought = shop();
    if (verbose && bought.length) console.log(`  ${stamp(war.clock)} commander: ${bought.join(', ')}`);
    nextShop = W.t + 2 * 3600;
  }
  const skip = war.skippable();
  if (skip > 30) {
    realS += skip / 3600;
    war.jump(skip);
  } else {
    W.step();
    simStepped++;
    const lv = Math.max(1, tempo.update(W));
    realS += 1 / 60 / lv;
    const why = W.missiles.length ? 'missiles' : lv >= 64 ? 'fast' : W.tracker.tracks.some((t) => t.confirmed && !t.dropped && t.ident !== 'FRD' && t.ident !== 'NEU') ? `track@${lv}` : `other@${lv}`;
    slow.set(why, (slow.get(why) ?? 0) + 1 / 60 / lv);
    war.update();
  }
  if (W.scenario.raids.length > raidsSeen) {
    const fresh = W.scenario.raids.slice(raidsSeen);
    raidsSeen = W.scenario.raids.length;
    ops.push(`${stamp(war.clock)} ${fresh.map((r) => r.name).join(', ')}`);
    if (verbose) console.log(`  ${ops[ops.length - 1]}`);
  }
}
console.log(`\n${c.s.over!.won ? 'WON' : c.s.over!.draw ? 'DRAW' : 'LOST'} on day ${c.s.day}: ${c.s.over!.reason}  score ${c.score()}`);
console.log(`Operations flown: ${new Set(ops.map((o) => o.slice(0, 14))).size}; ${raidsSeen} packages. Real time at auto tempo about ${Math.round(realS / 60)} min. CPU ${((Date.now() - t0) / 1000).toFixed(0)} s, ${(simStepped / 3600).toFixed(1)} h stepped.`);
console.log('Towns held:', c.s.front?.towns.filter((t) => t.ours).map((t) => t.name).join(', '));
console.log('Force at the end:', c.units.map((u) => u.type).join(' '));
war.sync();
console.log(`Save size: ${(c.save().length / 1024).toFixed(1)} KB; next objective ${c.s.front ? nextObjective(c.s.front) : '-'}; days ${CAMPAIGN_DAYS}`);
