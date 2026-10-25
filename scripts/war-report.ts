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

import { Site } from '../src/sim/sites';
/** Damage our battalions took from the air during a push, by weapon kind. */
const airHurt = new Map<string, number>();
const dmg0 = Site.prototype.damage;
Site.prototype.damage = function (this: Site, ww, amount, by) {
  const before = this.hp;
  dmg0.call(this, ww, amount, by);
  if (push && this.role === 'assault') { const k = by.replace(/[-\s]?\d+.*$/, ''); airHurt.set(k, (airHurt.get(k) ?? 0) + before - this.hp); }
};
let push: { town: number; at: number; start: number; gather: boolean } | null = null;
const results: string[] = [];
/** What the commander buys, in order, while it can afford it (as the raid campaign's commander did). */
function shop(): string[] {
  war.sync();
  const out: string[] = [];
  const count = (t: UnitType): number => c.units.filter((u) => u.type === t).length;
  for (const a of ['Airbase', 'CRC', 'Power plant']) if (c.repair(a)) out.push(`repair ${a}`);
  for (const u of c.units) if (c.reload(u)) out.push(`reload ${u.type}`);
  const noAd = flag('--no-ad');
  const adTypes: UnitType[] = ['MR', 'SH', 'LR', 'CIWS', 'GUN'];
  if (flag('--aggressive') && count('CAP') < 1 && c.buy('CAP')) out.push('buy CAP');
  const wants: [UnitType, () => boolean][] = [
    ['LR', () => count('LR') < 1], ['EWR', () => count('EWR') < 1], ['GNSS', () => count('GNSS') < 1],
    ['CAP', () => count('CAP') < 1 && c.s.day >= 3], ['MR', () => count('MR') < 2], ['SH', () => count('SH') < 3],
    ['CIWS', () => count('CIWS') < 3], ['GUN', () => count('GUN') < 2], ['DECOY', () => count('DECOY') < 1 && c.s.day >= 4],
    ['JAM', () => count('JAM') < 1 && c.s.day >= 5], ['MR', () => count('MR') < 3], ['SH', () => count('SH') < 4],
    ['CIWS', () => count('CIWS') < 4], ['LR', () => count('LR') < 2 && c.s.day >= 6], ['CAP', () => count('CAP') < 2 && c.s.day >= 5],
  ];
  for (const [t, want] of wants) {
    if (t !== 'LR' && !(t === 'CAP' && c.s.day >= 4) && c.unlocked('LR') && count('LR') < 1 && c.s.money - c.price(t) < CATALOG.LR.costM) continue;
    if (noAd && adTypes.includes(t)) continue;
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
  const g = w().ground;
  if (f && g && flag('--aggressive')) {
    // Pushing bot: once four manoeuvre battalions are fit, all of them go for the next town, with CAS on whatever is in the way.
    const man = g.bats.filter((b) => b.side === 'blue' && b.alive && b.kind !== 'arty');
    const next = nextObjective(f);
    if (next >= 0 && !push && man.filter((b) => !b.broken && b.strength > 70).length >= 4) {
      push = { town: next, at: war.clock, start: man.reduce((t, b) => t + b.strength, 0), gather: true };
      out.push(`GATHER for ${f.towns[next].name} with ${man.length} battalions`);
      if (!noAd) {
        // Escort: all but one SHORAD, a gun and an MR battery go with the two lead battalions.
        const lead = man.filter((b) => !b.broken).sort((a, b) => b.s - a.s);
        const pick = [...w().fielded.filter((x) => x.unit.type === 'SH').slice(1), ...w().fielded.filter((x) => x.unit.type === 'GUN').slice(0, 1), ...w().fielded.filter((x) => x.unit.type === 'CIWS').slice(0, 1), ...w().fielded.filter((x) => x.unit.type === 'MR').slice(0, 1)];
        pick.forEach((x, i) => war.escort(x.unit.uid, lead[i % lead.length].id));
        out.push(`escort: ${pick.map((x) => x.unit.type).join(' ')}`);
      }
    }
    if (push?.gather) {
      // Form up on our forward town with the escorts before going in.
      const front = f.towns.map((t, i) => (t.ours ? i : -1)).filter((i) => i >= 0).pop();
      const fs = front !== undefined ? g.townS[front] : g.blueDepot;
      if (front !== undefined) war.setObjective('hold', front);
      for (const b of man) if (!b.broken && b.order !== 'advance') war.orderBattalion(b.id, 'advance');
      const ready = man.every((b) => b.broken || Math.abs(b.s - fs) < 4000) && w().fielded.every((x) => war.escortOf(x.unit.uid) === undefined || x.unit.type === 'MR' || Math.hypot(x.sites[0].pos.x - g.at(fs).x, x.sites[0].pos.y - g.at(fs).y) < 5000);
      if (ready || war.clock - push.at > 240) {
        out.push(`PUSH for ${f.towns[push.town].name} after ${((war.clock - push.at) / 60).toFixed(1)} h forming up`);
        push = { town: push.town, at: war.clock, start: man.reduce((t, b) => t + b.strength, 0), gather: false };
        airHurt.clear();
      }
    } else if (push) {
      war.setObjective('push', push.town);
      for (const b of man) if (!b.broken && b.order !== 'advance') war.orderBattalion(b.id, 'advance');
      const red = g.bats.filter((b) => b.side === 'red' && b.alive).sort((a, b) => a.s - b.s)[0];
      if (red && !war.casError(red.id)) out.push(war.cas(red.id));
      if (flag('--esclog')) out.push(man.map((b) => `${b.name.split(' ')[0]}@${(b.s / 1000).toFixed(0)}${g.covered(w(), b) ? 'C' : ''}`).join(' ') + ' | ' + w().fielded.filter((x) => war.escortOf(x.unit.uid) !== undefined).map((x) => `${x.unit.type}${x.move ? x.move.phase : ''}(${(Math.hypot(x.sites[0].pos.x - g.bats.find((b) => b.id === war.escortOf(x.unit.uid))!.pos.x, x.sites[0].pos.y - g.bats.find((b) => b.id === war.escortOf(x.unit.uid))!.pos.y) / 1000).toFixed(1)}km)`).join(' '));
      if (f.towns[push.town].ours) {
        const lost = push.start - man.reduce((t, b) => t + b.strength, 0);
        out.push(`TOOK ${f.towns[push.town].name} after ${((war.clock - push.at) / 60).toFixed(1)} game hours, lost ${Math.round(lost)} of ${Math.round(push.start)} (${Math.round((100 * lost) / push.start)}%); from the air: ${[...airHurt].map(([k, v]) => `${k} ${Math.round(v)}`).join(', ')}`);
        results.push(out[out.length - 1]);
        push = null;
      } else if (man.every((b) => b.broken || !b.alive)) {
        out.push(`PUSH FAILED after ${((war.clock - push.at) / 60).toFixed(1)} game hours; from the air: ${[...airHurt].map(([k, v]) => `${k} ${Math.round(v)}`).join(', ')}`);
        results.push(out[out.length - 1]);
        push = null;
      }
    }
  } else if (f && g && !flag('--no-offensive')) {
    const blue = g.bats.filter((b) => b.side === 'blue' && b.alive);
    const avg = blue.length ? blue.reduce((t, b) => t + b.strength, 0) / blue.length : 0;
    const next = nextObjective(f);
    const front = f.towns.map((t, i) => (t.ours ? i : -1)).filter((i) => i >= 0).pop();
    if ((g.enemyGoal !== undefined || g.objective?.kind !== 'push' || f.towns[g.objective.town]?.ours) && front !== undefined) {
      if (g.objective?.kind !== 'hold') out.push(`hold ${f.towns[front].name}`);
      war.setObjective('hold', front);
    } else if (covered && next >= 0 && avg > 70 && blue.length >= 2 && blue.reduce((t, b) => t + b.strength, 0) > 1.4 * g.bats.filter((b) => b.side === 'red' && b.alive && b.s < g.townS[next] + 5000).reduce((t, b) => t + b.strength, 0)) {
      if (g.objective?.kind !== 'push') out.push(`push for ${f.towns[next].name}`);
      war.setObjective('push', next);
    }
    if (g.objective) for (const b of blue) if (b.order === 'hold' && !b.broken && b.strength > 55) war.orderBattalion(b.id, 'advance');
    const red = g.bats.find((b) => b.side === 'red' && b.alive && b.formUntil !== undefined);
    if (red && !war.casError(red.id)) out.push(war.cas(red.id));
  }
  // Units the enemy has a fix on move a couple of kilometres (the LR battery stays and fights).
  for (const fl of w().fielded) {
    const u = fl.unit;
    if (u.type === 'CAP' || u.type === 'LR' || fl.move || war.escortOf(u.uid) !== undefined || !w().exposure.fixOn(u.uid)) continue;
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
      `\n  ground: ${w().ground?.bats.filter((b) => b.alive).map((b) => `${b.side === 'blue' ? 'B' : 'R'}${Math.round(b.strength)}@${Math.round(b.s / 1000)}${b.order[0]}`).join(' ')}` +
      (r.front?.length ? `\n  front: ${r.front.join(' / ')}` : '') +
      (r.enemy?.length ? `\n  enemy: ${r.enemy.slice(0, verbose ? 99 : 4).join(' / ')}` : '') +
      (verbose && r.lessons.length ? `\n  lessons: ${r.lessons.join(' / ')}` : '') +
      `\n  real time by cause (min): ${[...slow].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${Math.round(v / 60)}`).join(', ')}` +
      `\n  real time so far at auto tempo: ${Math.round(realS / 60)} min; artillery barrages ${w().logEntries.filter((e) => e.msg.startsWith('Rocket artillery launch')).length}` +
      (verbose ? `\n  theatre: ${c.theatre.map((b) => `${b.id}${b.known ? '*' : ''}${b.lost ? ' LOST' : ''} [${stockText(b)}]`).join('; ')}` : ''),
  );
};
let nextShop = 0;
const ops: string[] = [];
let raidsSeen = 0;
let logSeen = 0;
while (!c.s.over) {
  const W = w();
  if (W.t >= nextShop) {
    const bought = shop();
    if (verbose && bought.length) console.log(`  ${stamp(war.clock)} commander: ${bought.join(', ')}`);
    nextShop = W.t + (push ? 600 : 2 * 3600);
    if (results.length && flag('--stop-first')) break;
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
  if (flag('--bnlog')) for (let k = Math.max(0, W.logEntries.length - (W.logSeq - logSeen)); k < W.logEntries.length; k++) { const m = W.logEntries[k].msg; if (/Bn|bn |taking|took|taken|forming|beaten|broken|fallen|Objective/.test(m) && !/ hit by /.test(m)) console.log('   ', stamp(war.clock), m.slice(0, 150)); } if (flag('--bnlog')) logSeen = W.logSeq;
  if (W.scenario.raids.length > raidsSeen) {
    const fresh = W.scenario.raids.slice(raidsSeen);
    raidsSeen = W.scenario.raids.length;
    ops.push(`${stamp(war.clock)} ${fresh.map((r) => r.name).join(', ')}`);
    if (verbose) console.log(`  ${ops[ops.length - 1]}`);
  }
}
console.log('Pushes:', results.join(' | ') || 'none');
if (!c.s.over) process.exit(0);
console.log(`\n${c.s.over!.won ? 'WON' : c.s.over!.draw ? 'DRAW' : 'LOST'} on day ${c.s.day}: ${c.s.over!.reason}  score ${c.score()}`);
console.log(`Operations flown: ${new Set(ops.map((o) => o.slice(0, 14))).size}; ${raidsSeen} packages. Real time at auto tempo about ${Math.round(realS / 60)} min. CPU ${((Date.now() - t0) / 1000).toFixed(0)} s, ${(simStepped / 3600).toFixed(1)} h stepped.`);
console.log('Towns held:', c.s.front?.towns.filter((t) => t.ours).map((t) => t.name).join(', '));
console.log('Force at the end:', c.units.map((u) => u.type).join(' '));
war.sync();
console.log(`Save size: ${(c.save().length / 1024).toFixed(1)} KB; next objective ${c.s.front ? nextObjective(c.s.front) : '-'}; days ${CAMPAIGN_DAYS}`);
