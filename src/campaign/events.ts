import { CATALOG, newUnit } from '../sim/catalog';
import { Rng } from '../sim/rng';
import type { Campaign } from './campaign';
import { planDay } from './raidgen';
import { WEATHER } from './weather';

/** Between-day events: a situation with two choices, shown on the planning screen. */
export type EventId = 'arms' | 'intel' | 'strike' | 'allies' | 'preempt' | 'press';

export interface EventChoice {
  label: string;
  /** Shown under the button. */
  detail: string;
  costM?: number;
}

interface EventDef {
  title: string;
  text: string;
  choices: [EventChoice, EventChoice];
  /** Can it happen now? */
  ok: (c: Campaign) => boolean;
  /** Apply choice 0 or 1; returns the line for the planning screen. */
  apply: (c: Campaign, choice: number) => string;
}

const firstMr = (c: Campaign) => c.units.find((u) => u.type === 'MR');

export const EVENTS: Record<EventId, EventDef> = {
  arms: {
    title: 'An arms dealer at the gate',
    text: 'A dealer with a truck of surplus MR SAM missiles offers 8 of them at a third of the depot price, no questions asked.',
    choices: [
      { label: 'Buy them', detail: '8 spare missiles for the MR battery', costM: 4 },
      { label: 'Send him away', detail: 'Nothing happens' },
    ],
    ok: (c) => !!firstMr(c),
    apply: (c, i) => {
      if (i === 1) return 'The dealer drove off.';
      firstMr(c)!.spares += 8;
      return '8 spare MR missiles delivered.';
    },
  },
  intel: {
    title: 'An informant',
    text: 'Someone on the other side offers the complete strike plan for tomorrow, every package and its timing.',
    choices: [
      { label: 'Pay the informant', detail: 'Every package of the day is reported', costM: 20 },
      { label: 'Refuse', detail: 'Rely on our own intelligence' },
    ],
    ok: (c) => c.s.plan.some((p) => !p.reported),
    apply: (c, i) => {
      if (i === 1) return 'We declined the offer.';
      for (const p of c.s.plan) p.reported = true;
      return 'The full enemy plan is in the briefing.';
    },
  },
  strike: {
    title: 'Trouble at the power plant',
    text: 'The power plant workers refuse to keep working under the raids without danger money.',
    choices: [
      { label: 'Pay danger money', detail: 'The plant keeps running', costM: 15 },
      { label: 'Refuse', detail: 'Tomorrow\'s income is $30M lower' },
    ],
    ok: () => true,
    apply: (c, i) => {
      if (i === 0) return 'The workers are back at their posts.';
      c.s.incomePenalty = 30;
      return 'The plant runs on a skeleton crew: income tomorrow is $30M lower.';
    },
  },
  allies: {
    title: 'Allied fighters',
    text: 'An allied squadron passing through can fly a combat air patrol over us for one day if we cover their fuel.',
    choices: [
      { label: 'Accept', detail: 'A loaned fighter pair for today only', costM: 45 },
      { label: 'Decline', detail: 'Nothing happens' },
    ],
    ok: (c) => c.s.day >= 2,
    apply: (c, i) => {
      if (i === 1) return 'The allies flew on.';
      const t = c.terrain;
      const p = t.toWorld(0, 45000);
      const u = newUnit(c.s.nextUid++, 'CAP', Math.round(p.x), Math.round(p.y));
      u.loan = true;
      c.units.push(u);
      return `An allied ${CATALOG.CAP.name} is on loan for today. Move its station if you like.`;
    },
  },
  preempt: {
    title: 'A pre-emptive strike',
    text: 'Our own air force can hit the enemy\'s launch sites tonight, if we give up part of our budget for it.',
    choices: [
      { label: 'Fund the strike', detail: 'Today\'s raids are about a quarter smaller (a new plan)', costM: 40 },
      { label: 'Keep the money', detail: 'Nothing happens' },
    ],
    ok: (c) => c.s.day >= 3,
    apply: (c, i) => {
      if (i === 1) return 'No strike tonight.';
      c.s.plan = planDay(c.s.day, c.s.seed + 1, c.s.enemy, c.s.nextPkg, c.layout.rot, c.diff.threat * 0.75, WEATHER[c.s.weather ?? 'clear'].noDrones);
      c.s.nextPkg += c.s.plan.length;
      return 'The strike went in: the enemy has less to throw at us today. Read the new briefing.';
    },
  },
  press: {
    title: 'The press',
    text: 'A television crew wants to film one of our SAM batteries for the evening news. The ministry would reward us for the publicity.',
    choices: [
      { label: 'Allow it', detail: '+$25M, but the enemy watches the news too', costM: -25 },
      { label: 'Refuse', detail: 'Nothing happens' },
    ],
    ok: (c) => c.units.some((u) => u.type === 'MR' || u.type === 'LR'),
    apply: (c, i) => {
      if (i === 1) return 'No filming.';
      const u = c.units.find((x) => x.type === 'LR') ?? c.units.find((x) => x.type === 'MR')!;
      (c.s.enemy.known ??= []).push({ uid: u.uid, x: u.x, y: u.y, name: CATALOG[u.type].name });
      c.replanStrikes();
      return `The ${CATALOG[u.type].name} was on the news. Expect the enemy to aim at it unless you move it.`;
    },
  },
};

/** Maybe an event for the coming day. */
export function rollEvent(c: Campaign): EventId | null {
  if (c.s.day < 2) return null;
  const rng = new Rng(c.s.seed * 4099 + c.s.day * 271);
  if (!rng.chance(0.6)) return null;
  const ids = (Object.keys(EVENTS) as EventId[]).filter((id) => EVENTS[id].ok(c));
  return ids.length ? ids[rng.int(0, ids.length - 1)] : null;
}
