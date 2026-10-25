/**
 * First-campaign prompts: a short note the first time the player meets each of the dynamic campaign's rules.
 * Dismissed tips are remembered in this browser; the game works the same without storage.
 */
export type TipId = 'lull' | 'located' | 'armour' | 'oob';

export const TIPS: Record<TipId, string> = {
  lull: '<b>The lull between raids.</b> The clock runs continuously. Between raids you can buy, move and repair, but new orders take hours to arrive and repairs restore points by the hour. <b>Wait 1 hour</b> lets time pass, though intel\'s timings can be out and the enemy may come early.',
  located: '<b>A battery has been located.</b> Its launches and radar emissions gave its position away, and a strike is now flying at that spot. Select it and press <b>Scoot</b> to move it before impact, or defend the spot. A quieter radar (the <b>Auto</b> emission presets) gets located less often.',
  armour: '<b>Enemy armour is massing</b> for an attack on one of your towns during one of today\'s strikes. If the raids knock the town below 60%, it falls. Strike the armour while it masses, or keep the town covered.',
  oob: '<b>The enemy order of battle.</b> Every raid flies from one of these installations and draws on its finite stock. Launches give an installation away, and once located you can pay for a <b>deep strike</b> on it. Aircraft you shoot down never come back.',
};

const KEY = 'adg-tips-seen';

function seen(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

/** Dismissed in this page session, even when storage is unavailable. */
const dismissed = new Set<string>();

export function dismissTip(id: string): void {
  dismissed.add(id);
  try {
    const s = seen();
    s.add(id);
    localStorage.setItem(KEY, JSON.stringify([...s]));
  } catch {
    /* storage blocked: the tip stays dismissed for this session only */
  }
}

/** The tip's banner, or '' once dismissed. `attr` is the click attribute the panel's handler listens for. */
export function tip(id: TipId, attr: 'data-cui' | 'data-act'): string {
  if (dismissed.has(id) || seen().has(id)) return '';
  return `<div class="tip">${TIPS[id]} <button ${attr}="tip-ok" data-name="${id}">Got it</button></div>`;
}
