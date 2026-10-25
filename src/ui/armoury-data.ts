import { CATALOG, UnitType } from '../sim/catalog';
import { GUNS, GunKind } from '../sim/ciws';
import { AAM_MSL, LR_MSL, MR_MSL, MissileSpec, SH_MSL } from '../sim/missile';
import { MOBILITY } from '../sim/mobility';
import { AI_RADAR, CIWS_RADAR, EW_RADAR, LR_RADAR, MR_RADAR, Radar, RadarSpec, SH_RADAR } from '../sim/radar';
import { Airliner, Arm, Atgm, Bomber, Cruise, Drone, Entity, GlideBomb, HELO_RANGE, Helo, Kind, ReconDrone, Sead, Soj, Striker, Tbm } from '../sim/entities';
import { Awacs, RED_FIGHTER, RED_SUPPORT, RedFighter, Tanker } from '../sim/redair';
import { ENEMY_AD } from '../sim/enemyad';
import { ARMOUR } from '../sim/enemyarmour';
import { SEAD_DECOY_LEVEL, tbmFlightS } from '../sim/threats';
import { DELIVERY_H } from '../campaign/clock';
import { v3 } from '../sim/math';

/**
 * Everything the armoury page shows, pulled from the sim's own numbers so it stays true when they are
 * rebalanced. The prose is written here; every figure comes from the catalogue, the specs or a probe
 * entity built with the sim's own constructor.
 */

export type ModelSpec =
  | { kind: 'unit'; type: UnitType }
  | { kind: 'air'; key: string }
  | { kind: 'missile'; code: MissileSpec['code'] }
  | { kind: 'enemy-sam' }
  | { kind: 'armour' };

export interface Bar {
  label: string;
  /** 0..1 */
  value: number;
  text: string;
}

export interface Section {
  title: string;
  rows?: [string, string][];
  bars?: Bar[];
  note?: string;
}

export interface ArmouryEntry {
  id: string;
  side: 'blue' | 'red' | 'neutral';
  group: string;
  name: string;
  /** One line under the name. */
  tag: string;
  text: string[];
  model: ModelSpec;
  sections: Section[];
}

const km = (m: number, dp = m < 10000 ? 1 : 0): string => `${(m / 1000).toFixed(dp)} km`;
const speed = (mps: number): string => `${Math.round(mps * 3.6)} km/h · Mach ${(mps / 340).toFixed(mps < 100 ? 2 : 1)}`;
const money = (m: number): string => `$${m}M`;
const mins = (s: number): string => (s >= 120 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`);
const pct = (p: number): string => `${Math.round(p * 100)}%`;
const band = (ghz: number): string => (ghz < 2 ? 'L' : ghz < 4 ? 'S' : ghz < 8 ? 'C' : ghz < 12 ? 'X' : ghz < 18 ? 'Ku' : 'K');
const SEEKER: Record<MissileSpec['seeker'], string> = { tvm: 'Track via missile', arh: 'Active radar homing', cmd: 'Command to line of sight' };

/** Reference targets for "what this radar sees", RCS from the sim's probe entities. */
const origin = v3();
const far = v3(100000, 0, 0);
const dummyEmitter = { name: 'radar', pos: origin, signature: 'MR' as const, alive: true, isEmitting: () => true };

/** The sim's own entity for each enemy entry, built once, for RCS, speed, warhead and countermeasures. */
function probes(): Record<string, Entity> {
  const decoyDrone = new Drone('DD', far, [origin], origin, '', 100);
  decoyDrone.warhead = null;
  decoyDrone.decoy = true;
  const decoy = new Cruise('DCY', far, [], origin, 'decoy');
  decoy.warhead = null;
  decoy.decoy = true;
  return {
    drone: new Drone('D', far, [origin], origin, '', 100),
    decoyDrone,
    recon: new ReconDrone('R', far, origin),
    cruise: new Cruise('C', far, [origin], origin, ''),
    decoy,
    tbm: new Tbm('T', far, v3(), origin, ''),
    arm: new Arm('A', far, v3(-1, 0, 0), dummyEmitter, 0),
    bomb: new GlideBomb('GB', far, v3(-200, 0, 0), origin, '', 0),
    atgm: new Atgm('AT', far, { pos: origin, name: '' } as never, 0),
    strike: new Striker('S', far, { pos: origin, name: '' }),
    sead: new Sead('SD', far),
    bomber: new Bomber('B', far, [{ pos: origin, name: '' }]),
    soj: new Soj('SOJ', origin, 0),
    helo: new Helo('H', far),
    redfighter: new RedFighter('F', far, 0, null),
    awacs: new Awacs('AW', far, origin),
    tanker: new Tanker('TK', far, origin),
    airliner: new Airliner('AL', far, origin, true),
  };
}

/** Our radars, for "seen by": free-space range for a given RCS at the sim's detection threshold. */
const SENSORS: { name: string; spec: RadarSpec }[] = [
  { name: 'Early warning', spec: EW_RADAR },
  { name: 'LR SAM', spec: LR_RADAR },
  { name: 'Fighter radar', spec: AI_RADAR },
  { name: 'MR SAM', spec: MR_RADAR },
  { name: 'SHORAD / gap-filler', spec: SH_RADAR },
  { name: 'CIWS / gun radar', spec: CIWS_RADAR },
];
const radarCache = new Map<RadarSpec, Radar>();
function detectM(spec: RadarSpec, rcs: number): number {
  let r = radarCache.get(spec);
  if (!r) {
    r = new Radar('X', 'probe', spec, origin, 'MR');
    radarCache.set(spec, r);
  }
  return Math.min(r.rangeFor(rcs), spec.maxRangeKm * 1000);
}

function seenBy(rcs: number): Section {
  const max = detectM(EW_RADAR, 40);
  return {
    title: 'Seen by our radars',
    bars: SENSORS.map((s) => {
      const d = detectM(s.spec, rcs);
      return { label: s.name, value: Math.min(1, d / max), text: km(d) };
    }),
    note: 'Detection range in clear air with a clear line of sight. Terrain, clutter, rain and jamming all cut it, and low fliers are hidden by the horizon.',
  };
}

function radarSection(spec: RadarSpec, title = 'Radar'): Section {
  const scan = spec.scan.kind === 'rotating' ? `Rotating, ${spec.scan.rpm} rpm` : `Electronic sector ±${spec.scan.halfWidthDeg}°, frame ${spec.scan.frameS} s`;
  return {
    title,
    rows: [
      ['Band', `${band(spec.freqGHz)}-band (${spec.freqGHz} GHz)`],
      ['Peak power', `${spec.peakKW} kW`],
      ['Scan', scan],
      ['Instrumented range', `${spec.maxRangeKm} km`],
      ['Beam', `${spec.bwAzDeg}° × ${spec.bwElDeg}°`],
      ['IFF', spec.iff ? 'Yes' : 'No'],
    ],
  };
}

function sees(spec: RadarSpec, p: Record<string, Entity>): Section {
  const refs: [string, number][] = [
    ['Airliner', p.airliner.rcs],
    ['Strike jet', p.strike.rcs],
    ['Attack drone', p.drone.rcs],
    ['Cruise missile', p.cruise.rcs],
    ['Anti-radiation missile', p.arm.rcs],
  ];
  const max = detectM(spec, refs[0][1]);
  return {
    title: 'Detects',
    bars: refs.map(([n, rcs]) => {
      const d = detectM(spec, rcs);
      return { label: `${n} (${rcs} m²)`, value: d / max, text: km(d) };
    }),
    note: 'Clear air, clear line of sight. Terrain, clutter, weather and jamming cut these ranges.',
  };
}

function missileRows(m: MissileSpec): [string, string][] {
  return [
    ['Range', `${km(m.minRangeM)} to ${km(m.maxRangeM)}`],
    ['Ceiling', km(m.maxAltM)],
    ['Anti-ballistic', m.tbmRangeM ? `Inside ${km(m.tbmRangeM)}` : 'No'],
    ['Guidance', SEEKER[m.seeker] + (m.seekerRangeM ? `, seeker ${km(m.seekerRangeM)}` : '')],
    ['Average speed', speed(m.avgSpd)],
    ['Manoeuvre', `${m.maxG} g`],
    ['Kill chance', `${pct(m.pk)} on a hit (lethal radius ${m.lethalR} m)`],
    ['Price', `${money(m.costM)} a round`],
  ];
}

const GUN_FOR: Partial<Record<UnitType, GunKind>> = { CIWS: 'ciws', GUN: 'gun35', LASER: 'laser' };
const RADAR_FOR: Partial<Record<UnitType, RadarSpec>> = { LR: LR_RADAR, MR: MR_RADAR, SH: SH_RADAR, CIWS: CIWS_RADAR, GUN: CIWS_RADAR, LASER: CIWS_RADAR, EWR: EW_RADAR, GAP: SH_RADAR, CAP: AI_RADAR };
const KIND_NAME: Partial<Record<Kind, string>> = {
  drone: 'Drones', cruise: 'Cruise missiles', arm: 'ARMs', tbm: 'Ballistic missiles', bomb: 'Glide bombs', atgm: 'ATGMs',
  helo: 'Helicopters', sead: 'SEAD jets', strike: 'Strike jets', fighter: 'Fighters', bomber: 'Bombers',
};

function gunSection(g: (typeof GUNS)[GunKind]): Section[] {
  const rows: [string, string][] = [['Reach', km(g.rangeM)], ['Traverse', `${g.slew}°/s`]];
  if (g.ammo !== Infinity) rows.push(['Magazine', `${g.ammo} rounds, reload ${mins(g.reloadS)}`], ['Muzzle velocity', `${g.muzzle} m/s`]);
  else rows.push(['Magazine', 'Unlimited']);
  if (g.heatS) rows.push(['Duty cycle', `${g.heatS} s of fire, then ${g.coolS} s to cool`]);
  const kinds = Object.entries(g.killRate) as [Kind, number][];
  const top = Math.max(...Object.values(GUNS).flatMap((x) => Object.values(x.killRate)));
  return [
    { title: 'Weapon', rows },
    {
      title: 'Effectiveness at close range',
      bars: kinds
        .sort((a, b) => b[1] - a[1])
        .map(([k, r]) => ({ label: KIND_NAME[k] ?? k, value: r / top, text: `${pct(1 - Math.exp(-r))}/s` })),
      note: 'Chance of a kill for each second on target inside half range; it falls to about a third at the edge of the envelope.',
    },
  ];
}

const TIPS: Partial<Record<UnitType, string>> = {
  LR: 'Face its sector down the threat axis and keep it back: the radar is the most valuable thing you own and every SEAD pilot knows it. Its missiles can reach out to almost anything, but a battery with empty launchers is just a target.',
  MR: 'The workhorse. Because its missiles find their own way in the last 12 km, it can fire on a track from any radar in the network and keep its own radar silent. Spread the launchers so one strike cannot take the whole battery.',
  SH: 'Cheap, quick to move and quick to hide. One target at a time, so put two where the drones come in, and let the guns finish what gets through.',
  CIWS: 'The last line. Park one next to anything that radiates. It needs to see the threat before it can shoot, so open ground around it helps.',
  GUN: 'Programmable airburst rounds make it the best answer to a swarm. Put it forward of what it defends so drones meet it first.',
  LASER: 'Never runs dry, which makes it ideal against cheap drones that would waste missiles. Useless in fog or heavy rain, and too slow to save you from a missile.',
  EWR: 'Sees everything high and far, but not precisely enough to guide a missile. The MR SAM can fire on its tracks anyway. It radiates all day, so expect SEAD.',
  GAP: 'Its 30 m mast looks down into valleys the other radars cannot. Put it on a ridge over the approach the cruise missiles use.',
  GNSS: 'Silent until it matters and very cheap. It does nothing against command-guided or inertial weapons.',
  DECOY: 'Place it a kilometre or two from a real radar. ARMs that lose their emitter will turn for the brighter one.',
  JAM: 'Strong, but loud: it tells every SEAD pilot where it is. Never leave it without a gun next to it.',
  CAP: 'Fighters reach where the SAMs cannot. Use them on jammers, AWACS and bombers far out, and to escort the assault column.',
};

function friendly(p: Record<string, Entity>): ArmouryEntry[] {
  const groups: Record<UnitType, string> = {
    LR: 'Missile systems', MR: 'Missile systems', SH: 'Missile systems',
    CIWS: 'Guns and lasers', GUN: 'Guns and lasers', LASER: 'Guns and lasers',
    EWR: 'Sensors and EW', GAP: 'Sensors and EW', GNSS: 'Sensors and EW', DECOY: 'Sensors and EW', JAM: 'Sensors and EW',
    CAP: 'Aircraft',
  };
  return (Object.keys(CATALOG) as UnitType[]).map((t) => {
    const u = CATALOG[t];
    const mob = MOBILITY[t];
    const sections: Section[] = [];
    const service: [string, string][] = [
      ['Price', money(u.costM)],
      ['Available from', `Campaign day ${u.unlockDay}`],
      ['Delivery', `${DELIVERY_H[t]} h after ordering`],
    ];
    if (mob.speed) service.push(['Relocation', `${mins(mob.packS)} to pack, ${Math.round(mob.speed * 3.6)} km/h on the road, ${mins(mob.setupS)} to set up`]);
    sections.push({ title: 'Service', rows: service });
    if (u.missile && t !== 'CAP') {
      const fire: [string, string][] = [
        ['Launchers', `${u.launchers} × ${u.perLauncher} rounds${u.maxLaunchers! > u.launchers! ? `, up to ${u.maxLaunchers} (${money(u.launcherCostM!)} each)` : ''}`],
        ['Fire channels', `${u.channels} targets at once`],
        ['Reload', mins(u.reloadS!)],
      ];
      sections.push({ title: 'Battery', rows: fire }, { title: `${u.missile.name} missile`, rows: missileRows(u.missile) });
    }
    if (t === 'CAP') sections.push({ title: 'Armament', rows: [['Missiles', `4 × AAM per aircraft, 2 aircraft`], ...missileRows(AAM_MSL).slice(0, 3)] });
    const g = GUN_FOR[t];
    if (g) sections.push(...gunSection(GUNS[g]));
    if (t === 'GNSS' || t === 'JAM' || t === 'DECOY') sections.push({ title: 'Effect', rows: [['Radius', km(u.rangeKm * 1000)]] });
    const rs = RADAR_FOR[t];
    if (rs) sections.push(radarSection(rs, t === 'GAP' ? 'Radar (on a 30 m mast)' : t === 'CAP' ? 'Airborne radar' : 'Radar'), sees(rs, p));
    return {
      id: `u-${t}`,
      side: 'blue' as const,
      group: groups[t],
      name: u.name,
      tag: `${money(u.costM)} · ${u.rangeKm >= 10 ? `${u.rangeKm} km` : `${u.rangeKm} km`} reach`,
      text: [u.role, TIPS[t] ?? ''].filter(Boolean),
      model: { kind: 'unit', type: t },
      sections,
    };
  });
}

function missiles(): ArmouryEntry[] {
  const list: [MissileSpec, string, string][] = [
    [LR_MSL, 'LR SAM', 'Big two-stage missile with a long, high flyout. The battery radar watches both the target and the missile, and the missile relays what its own seeker sees back to the ground, so it can be steered all the way in. The only round in the armoury that can catch a ballistic missile.'],
    [MR_MSL, 'MR SAM', 'Flies out on data-link updates and switches on its own radar seeker 12 km from the target. That is why it can fire on any track in the picture and why the battery radar can go quiet after launch.'],
    [SH_MSL, 'SHORAD', 'Small, very fast and steered by the launcher all the way, so the fire unit can only handle one target at a time. Cheap enough to spend on drones.'],
    [AAM_MSL, 'CAP fighters', 'Active radar air-to-air missile. Fired from altitude and speed, it outranges every ground missile but the LR SAM.'],
  ];
  return list.map(([m, who, text]) => ({
    id: `m-${m.code}`,
    side: 'blue' as const,
    group: 'Missiles',
    name: `${m.name} missile`,
    tag: `${km(m.maxRangeM)} · ${SEEKER[m.seeker].toLowerCase()} · ${who}`,
    text: [text],
    model: { kind: 'missile', code: m.code },
    sections: [{ title: 'Performance', rows: missileRows(m) }],
  }));
}

interface RedDef {
  id: string;
  name: string;
  group: string;
  probe: string;
  model: string;
  kind: Kind;
  text: string;
  speedMps?: number;
  flight?: string;
  extra?: [string, string][];
  side?: 'red' | 'neutral';
}

function enemy(p: Record<string, Entity>): ArmouryEntry[] {
  // The ballistic missile's speed as the sim launches it over a typical 175 km.
  const tbmRange = 175000;
  const tbmSpd = (() => {
    const s = Tbm.solve(origin, 0, tbmRange, tbmRange * 0.48, tbmFlightS(tbmRange));
    return Math.hypot(s.vel.x, s.vel.y, s.vel.z);
  })();
  const defs: RedDef[] = [
    { id: 'drone', name: 'Attack drone', group: 'Drones', probe: 'drone', model: 'drone', kind: 'drone', flight: 'Low, about 100 m above the ground', text: 'A one-way attack drone with a small warhead, flown on satellite navigation. Slow and small on radar, and it comes in numbers: missiles spent on it are missiles you will not have for the jets. Guns, lasers and the GNSS jammer are the cheap answer.' },
    { id: 'decoydrone', name: 'Decoy drone', group: 'Drones', probe: 'decoyDrone', model: 'drone', kind: 'drone', flight: 'Low, about 100 m above the ground', text: 'Looks exactly like an attack drone on radar but carries no warhead. Its job is to soak up your missiles. Put batteries on hold fire and let the guns deal with a big low swarm.' },
    { id: 'recon', name: 'Recon drone', group: 'Drones', probe: 'recon', model: 'recon', kind: 'drone', text: 'High, slow and patient. It photographs your units, and if it gets home the next raids aim at what it saw. Shooting one down with photos aboard denies the enemy that intel and earns a bounty.' },
    { id: 'cruise', name: 'Cruise missile', group: 'Missiles', probe: 'cruise', model: 'cruise', kind: 'cruise', flight: 'Terrain following, about 40 m', text: 'Subsonic, tiny on radar and flying through the valleys, it pops over the last ridge a few kilometres out. Gap-filler radars on high ground see it earlier. Its navigation leans a little on satellites.' },
    { id: 'decoy', name: 'Air-launched decoy', group: 'Missiles', probe: 'decoy', model: 'decoy', kind: 'cruise', text: `SEAD pairs release these ahead of them from exposure level ${SEAD_DECOY_LEVEL}. They glide in looking like a cruise missile to draw your radars into radiating and your missiles into firing.` },
    { id: 'tbm', name: 'Ballistic missile', group: 'Missiles', probe: 'tbm', model: 'tbm', kind: 'tbm', speedMps: tbmSpd, flight: `Falls from about ${km(tbmRange * 0.48)}; ${Math.round(tbmFlightS(tbmRange))} s over ${km(tbmRange)}`, text: `Comes down steep and very fast with the biggest warhead in the enemy's stock. Only the LR SAM can intercept it, inside ${km(LR_MSL.tbmRangeM)}, and a CIWS gets a last shot at one diving on it.` },
    { id: 'arm', name: 'Anti-radiation missile', group: 'Missiles', probe: 'arm', model: 'arm', kind: 'arm', speedMps: 950, text: 'Homes on a radar that is radiating. If the radar goes silent it flies on to where it last heard it, so moving, a decoy nearby or ARM auto shut-down all help. Fast and tiny on radar: guns get only a few seconds on it.' },
    { id: 'bomb', name: 'Glide bomb', group: 'Missiles', probe: 'bomb', model: 'bomb', kind: 'bomb', speedMps: 220, text: 'Released by strike jets when they pop up near the target, it glides the last kilometres on satellite navigation. The GNSS jammer pulls it off its aim; guns can kill it on the way down.' },
    { id: 'atgm', name: 'Anti-tank missile', group: 'Missiles', probe: 'atgm', model: 'atgm', kind: 'atgm', speedMps: 300, text: `Fired by attack helicopters from inside ${km(HELO_RANGE)}. Laser or wire guided, so jamming does nothing; it is over in seconds.` },
    { id: 'strike', name: 'Strike jet', group: 'Aircraft', probe: 'strike', model: 'strike', kind: 'strike', flight: 'High in transit, treetop height for the last 95 km', text: 'Runs in at treetop height, pops up near its target and releases glide bombs. Chaff and flares make it harder to hit. A fast jet with no IFF running in low inside 45 km is declared hostile automatically.' },
    { id: 'sead', name: 'SEAD fighter', group: 'Aircraft', probe: 'sead', model: 'sead', kind: 'sead', text: 'Hunts radars. It listens for emitters and fires anti-radiation missiles at the ones that radiate, from well beyond the usual range at any radar that keeps radiating for 40 s. Emission control is your best defence.' },
    { id: 'bomber', name: 'Strike bomber', group: 'Aircraft', probe: 'bomber', model: 'bomber', kind: 'bomber', text: 'A big, high, slow target that launches air-launched cruise missiles from outside your SAM envelopes. Kill it before it gets there, which usually means fighters or the LR SAM.' },
    { id: 'soj', name: 'Stand-off jammer', group: 'Aircraft', probe: 'soj', model: 'soj', kind: 'bomber', text: 'Orbits far out and floods your radars with noise along its bearing. Two radars that hear it can cross-fix its position. Fighters are the cure.', extra: [['Jammer', `${Math.round((p.soj.jammer?.erpW ?? 0) / 1000)} kW ERP, ${p.soj.jammer?.loGHz}-${p.soj.jammer?.hiGHz} GHz`]] },
    { id: 'helo', name: 'Attack helicopter', group: 'Aircraft', probe: 'helo', model: 'helo', kind: 'helo', flight: 'Treetop height, hidden in the ground clutter', text: `Creeps in among the trees where radars barely see it, pops up within ${km(HELO_RANGE)} of a unit, fires two anti-tank missiles and drops back down. SHORAD, guns and CIWS deal with it.` },
    { id: 'redfighter', name: 'Enemy fighter', group: 'Aircraft', probe: 'redfighter', model: 'redfighter', kind: 'fighter', text: `Escorts strike packages and sweeps your CAP from day ${RED_FIGHTER.level}. It does not fly at night or in fog and storms.`, extra: [['Missiles', `${RED_FIGHTER.aams} AAMs, ${km(RED_FIGHTER.rangeM)}, ${pct(RED_FIGHTER.pk)} kill chance`]] },
    { id: 'awacs', name: 'AWACS', group: 'Aircraft', probe: 'awacs', model: 'awacs', kind: 'bomber', text: `Flies a racetrack far back over its own SAMs from day ${RED_SUPPORT.awacsLevel}. While it is up, enemy aircraft are warned of your shots and your missiles kill them less often. It runs for home when your fighters close inside ${km(RED_SUPPORT.runM)}.` },
    { id: 'tanker', name: 'Tanker', group: 'Aircraft', probe: 'tanker', model: 'tanker', kind: 'bomber', text: `From day ${RED_SUPPORT.tankerLevel}. While it is up, jammers and SEAD fighters stay on station ${RED_SUPPORT.stationMult}× longer.` },
    { id: 'airliner', name: 'Civil airliner', group: 'Civil', probe: 'airliner', model: 'airliner', kind: 'bomber', side: 'neutral', text: 'Flies the airways at cruise altitude with its transponder on, usually. One with a failed transponder looks like a big unknown jet. Shoot two down and the campaign is lost.' },
  ];
  const out: ArmouryEntry[] = defs.map((d) => {
    const e = p[d.probe];
    const spd = d.speedMps ?? (e as { spd?: number }).spd ?? 0;
    const alt = (e as { cmdAlt?: number; tfAgl?: number | null }).cmdAlt;
    const rows: [string, string][] = [['Speed', speed(spd)]];
    rows.push(['Flight', d.flight ?? (alt ? `About ${km(alt)} up` : '—')]);
    rows.push(['Radar cross-section', `${e.rcs} m²`]);
    rows.push(['Warhead', e.warhead ? `${e.warhead.dmg} damage, ${e.warhead.lethalR} m radius` : e.decoy ? 'None (decoy)' : 'Carries weapons'] as [string, string]);
    if (e.cmPk < 1) rows.push(['Countermeasures', `Missiles that reach it kill ${pct(e.cmPk)} as often`]);
    if (e.gnssDep > 0) rows.push(['Satellite navigation', e.gnssDep >= 1 ? 'Relies on it: the GNSS jammer works' : 'Partly: the GNSS jammer helps a little']);
    rows.push(...(d.extra ?? []));
    const guns = (Object.values(GUNS) as (typeof GUNS)[GunKind][]).filter((g) => g.killRate[d.kind]);
    const top = Math.max(...Object.values(GUNS).flatMap((x) => Object.values(x.killRate)));
    const sections: Section[] = [{ title: 'Profile', rows }, seenBy(e.rcs)];
    const answers: Bar[] = [];
    if (d.kind === 'tbm') answers.push({ label: 'LR SAM', value: LR_MSL.pk, text: `inside ${km(LR_MSL.tbmRangeM)}` });
    else if (d.side !== 'neutral') for (const m of [LR_MSL, MR_MSL, SH_MSL, AAM_MSL]) answers.push({ label: `${m.name} missile`, value: m.pk * e.cmPk, text: `${pct(m.pk * e.cmPk)} a hit` });
    for (const g of guns) answers.push({ label: g.label, value: g.killRate[d.kind]! / top, text: `${pct(1 - Math.exp(-g.killRate[d.kind]!))}/s` });
    if (answers.length) sections.push({ title: 'Answered by', bars: answers, note: 'Missiles: kill chance once one reaches it. Guns: kill chance per second on target at close range.' });
    return { id: `e-${d.id}`, side: d.side ?? 'red', group: d.group, name: d.name, tag: `${speed(spd).split(' · ')[0]} · ${e.rcs} m²`, text: [d.text], model: { kind: 'air', key: d.model }, sections };
  });
  out.push(
    {
      id: 'e-sam', side: 'red', group: 'Ground', name: 'Enemy SAM site', tag: `${km(ENEMY_AD.samRangeM)} missiles · ${km(ENEMY_AD.radarRangeM)} radar`, model: { kind: 'enemy-sam' },
      text: ['Every town the enemy holds has one. It fires on your fighters, makes your batteries in its radar\'s view easier to locate, and calls artillery onto an assault force. Sweep it with a fighter, pay for a deep strike, or take its town.'],
      sections: [{ title: 'Profile', rows: [
        ['Missile reach', `${km(ENEMY_AD.samRangeM)} (${km(ENEMY_AD.lowSeenM)} against a fighter running in low)`],
        ['Kill chance', pct(ENEMY_AD.samPk)],
        ['Radar reach', km(ENEMY_AD.radarRangeM)],
        ['Spotting for artillery', `${km(ENEMY_AD.spotM)}, a barrage every ${mins(ENEMY_AD.artilleryS)}`],
        ['Our stand-off release', `${km(ENEMY_AD.sweepReleaseM)} out, ${pct(ENEMY_AD.sweepPk)} kill chance`],
      ] }],
    },
    {
      id: 'e-armour', side: 'red', group: 'Ground', name: 'Enemy armour', tag: `${Math.round(ARMOUR.speed * 3.6)} km/h on the road`, model: { kind: 'armour' },
      text: ['Tanks and fighting vehicles that mass down the road and drive on your front town. Once they are there the assault lasts a few minutes; knock the town flat enough and it falls.'],
      sections: [{ title: 'Profile', rows: [
        ['Masses', `${km(ARMOUR.startM)} back down the road`],
        ['Road speed', `${Math.round(ARMOUR.speed * 3.6)} km/h`],
        ['Assault', `${mins(ARMOUR.assaultS)} at the town`],
        ['Town falls below', `${ARMOUR.takeHp}% health`],
      ] }],
    },
  );
  return out;
}

let cache: ArmouryEntry[] | null = null;

export function armouryEntries(): ArmouryEntry[] {
  if (!cache) {
    const p = probes();
    cache = [...friendly(p), ...missiles(), ...enemy(p)];
  }
  return cache;
}
