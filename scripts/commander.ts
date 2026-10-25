// The automatic commander's planning: what it buys, repairs, strikes and moves between raids. Shared by the
// headless campaign report and the browser playthrough (bundled as an IIFE that sets window.commanderShop).
import { CAMPAIGN_DAYS, Campaign } from '../src/campaign/campaign';
import { CATALOG, UnitType } from '../src/sim/catalog';
import { DeepStrikeId, deepStrike, deepStrikeError, strikeTargets } from '../src/campaign/deepstrike';
import { OFFENSIVE_COST_M, assaultSpot, nextObjective } from '../src/campaign/front';
import { nearestFree } from '../src/sim/deploy';

/** What the automatic commander buys, in order, while it can afford it. */
/** A command-line flag (always off in the browser). */
const flag = (f: string): boolean => !!(globalThis as { process?: { argv: string[] } }).process?.argv.includes(f);

export function commanderShop(c: Campaign): string[] {
  const bought: string[] = [];
  const count = (t: UnitType): number => c.units.filter((u) => u.type === t).length;
  for (const a of ['Airbase', 'CRC', 'Power plant']) if (c.repair(a)) bought.push(`repair ${a}`);
  for (const u of c.units) if (c.reload(u)) bought.push(`reload ${CATALOG[u.type].name}`);
  // Push up the road when there is money to spare, and send a covering group forward with the assault force.
  const f = c.s.front;
  // Attack whenever two batteries can cover the push and $100M is left after paying for it; after a town falls
  // to us, keep pressing as long as the push itself is affordable.
  const last = c.s.history[c.s.history.length - 1];
  const pressing = !!last?.front?.some((l) => / and took /.test(l));
  const covered = count('MR') + count('LR') >= 2 && count('SH') >= 1;
  const spare = c.s.money - OFFENSIVE_COST_M >= (pressing ? 0 : 100);
  // Before the airfield: wear down what would counter-attack it (deep strikes on the airfield and FARP) and only
  // go in once the jets and helicopters it could throw are few, or on the last days.
  const nextI = f ? nextObjective(f) : -1;
  const atField = !!f && nextI >= 0 && !!f.towns[nextI].airfield;
  const threat = atField ? c.fieldCounterForce().filter((x) => x.kind !== 'drones').reduce((t, x) => t + x.n, 0) : 0;
  const ready = !atField || threat <= 6 || c.s.day >= CAMPAIGN_DAYS - 1;
  if (atField && !flag('--no-strikes')) {
    const prep = strikeTargets(c).filter((b) => (b.kind === 'airfield' || b.kind === 'farp') && !deepStrikeError(c, b.id)).sort((a, b) => (a.kind === 'airfield' ? -1 : 1) - (b.kind === 'airfield' ? -1 : 1))[0];
    if (prep && deepStrike(c, prep.id)) bought.push(`prep strike ${prep.id} (${c.s.deepStrike?.ok ? 'hit' : 'failed'})`);
  }
  if (f && covered && spare && ready && !flag('--no-offensive') && c.launchOffensive()) {
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
    // A second fighter pair mid-campaign, cheaper than the first.
    ['CAP', () => count('CAP') < 2 && c.s.day >= 5],
  ];
  for (const [t, want] of wants) {
    // Save up for the LR battery once it is unlocked rather than spending on extras.
    // The fighter pair is worth having once the enemy flies an AWACS (and its fighters): buy it even while saving.
    if (t !== 'LR' && !(t === 'CAP' && c.s.day >= 4) && c.unlocked('LR') && count('LR') < 1 && c.s.money - c.price(t) < CATALOG.LR.costM) continue;
    if (want() && c.buy(t)) bought.push(CATALOG[t].name);
  }
  for (const u of c.units) {
    if ((u.type === 'MR' || u.type === 'LR') && u.spares < 4 && c.buySpares(u)) bought.push(`spares ${u.type}`);
    if (c.replaceAircraft(u)) bought.push('replacement fighter');
  }
  const saving = c.unlocked('LR') && count('LR') < 1;
  // One deep strike a day at the biggest threat in today's plan, when there is money to spare.
  if (!saving && c.s.money > 70 && !flag('--no-strikes')) {
    // Value of a located installation: what it holds, weighted by how much each kind hurts.
    const weight: Record<string, number> = { tbm: 3, cruise: 1, strike: 2, sead: 2, recon: 1, helo: 1.5, drone: 0.3 };
    const value = (id: DeepStrikeId): number => {
      const b = c.theatre.find((x) => x.id === id)!;
      return Object.entries(b.stock).reduce((t, [a, n]) => t + Math.floor(n ?? 0) * (weight[a] ?? 1), 0);
    };
    const best = strikeTargets(c).map((b) => b.id).filter((id) => !deepStrikeError(c, id) && value(id) > 6).sort((a, b) => value(b) - value(a))[0];
    if (best) {
      const r = deepStrike(c, best);
      if (r) bought.push(`deep strike ${best} (${c.s.deepStrike?.ok ? 'hit' : 'failed'})`);
    }
  }
  // Break up an enemy attack on our front town while its armour masses, when there is money for it.
  if (c.s.money > 80 && !c.armourStrikeError()) bought.push(`armour strike (${c.strikeArmour()?.includes('broken up') ? 'hit' : 'missed'})`);
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
  // Batteries the enemy has a fix on move a couple of kilometres before the next raid.
  for (const u of c.units) {
    if (!c.spotted(u) || u.type === 'CAP' || u.type === 'LR') continue;
    const a = ((u.uid * 137 + c.s.history.length * 61) % 360) * (Math.PI / 180);
    const q = nearestFree(c.terrain, u.type, u.x + Math.cos(a) * 2000, u.y + Math.sin(a) * 2000, c.units, u.uid, 600, c.zones);
    if (!c.place(c.terrain, u, q.x, q.y)) bought.push(`${u.type} relocated`);
  }
  for (const id of ['pdfuze', 'hardened'] as const) if (!saving && c.s.money > 150 && c.upgrade(id)) bought.push(id);
  for (const u of c.units) if (!saving && (u.type === 'LR' || u.type === 'MR') && c.s.money > 250 && c.addLauncher(u)) bought.push(`launcher ${u.type}`);
  return bought;
}


(globalThis as { commanderShop?: typeof commanderShop }).commanderShop = commanderShop;
