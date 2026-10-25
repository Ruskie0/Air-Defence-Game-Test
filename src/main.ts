import { Tempo } from './sim/tempo';
import './ui/style.css';
import { CAMPAIGN_DAYS, Campaign } from './campaign/campaign';
import { View3D } from './render/view3d';
import { IDLE_FPS, gfx } from './render/gfx';
import { DT } from './sim/constants';
import { MAP_TYPE_LIST, MapType, Terrain, typeForSeed } from './sim/terrain';
import { MAP_SEED, World } from './sim/world';
import { CampaignUi, loadSaved } from './ui/campaign-ui';
import { GameControl, Hud } from './ui/hud';
import { Ppi } from './ui/ppi';
import { Lesson, Tutorial, setupFrontLesson } from './ui/tutorial';
import { WEATHER, WeatherId } from './campaign/weather';
import { LastStand } from './campaign/laststand';
import { StandUi } from './ui/laststand-ui';
import { armoury } from './ui/armoury';
import type { War } from './campaign/war';
import { TEMPO } from './sim/tempo';
import { hhmm } from './campaign/clock';
import { SECTOR_NAMES } from './campaign/raidgen';

const params = new URLSearchParams(location.search);
const seed = Number(params.get('seed')) || MAP_SEED;
const mapParam = params.get('map');

/**
 * A new map for the sandbox: random every time, unless ?seed= (and optionally ?map=) fixes it.
 * ?map=classic gives the original 160 km map layout.
 */
function sandboxTerrain(type?: MapType): Terrain {
  if (mapParam === 'classic') return new Terrain(MAP_SEED);
  const s = params.has('seed') ? seed : Math.floor(Math.random() * 1e6) + 1;
  const t = type ?? (MAP_TYPE_LIST.includes(mapParam as MapType) ? (mapParam as MapType) : typeForSeed(s));
  return new Terrain(s, t);
}

/** The map behind the menu, and the last sandbox map. */
let terrain = sandboxTerrain();
/** What the menu shows behind it: the sandbox defence with no raids. */
const backdrop = (): World => new World({ seed, terrain, raids: [], civil: false });

let world = backdrop();
/** Only a battle (sandbox or campaign day) runs the simulation; the menu and planning just render. */
let running = false;
/** The training mission's coach, while one is running. */
let tutorial: Tutorial | null = null;
/** The Last Stand run and its panel, while one is on. */
let stand: LastStand | null = null;
/** The campaign's living war, while one is on. */
let war: War | null = null;
let standUi: StandUi | null = null;
const view = new View3D(document.getElementById('view')!, world);
const tempo = new Tempo();
gfx.mount();
view.planClock = () => (document.body.dataset.mode === 'plan' ? cui.campaign?.clock : undefined);
const ppi = new Ppi(document.getElementById('ppi') as HTMLCanvasElement, world);
const ctl: GameControl = { speed: Number(params.get('speed')) || 1, paused: false, skipQuiet: params.get('skipquiet') !== '0', autoPause: params.get('autopause') !== '0' };
const hud = new Hud(world, view, ppi, ctl);

function show(w: World): void {
  world = w;
  view.setWorld(w);
  ppi.setWorld(w);
}

const cui = new CampaignUi({
  view,
  ppi,
  showPreview(w) {
    running = false;
    show(w);
  },
  startBattle(w: World, c: Campaign) {
    const down = c.airbaseDownNote();
    if (down) w.log(down, 'alert');
    w.scenario.doneMsg = 'All reported packages are in and the airspace is clear. End the raid when you are ready.';
    hud.campaign = { day: c.s.day, days: CAMPAIGN_DAYS, objectives: c.s.objectives ?? [], clock0: c.clock, onEndDay: () => {
        running = false;
        world.abandonRaid();
        cui.endDay(world);
      } };
    show(w);
    hud.setWorld(w);
    ctl.paused = false;
    ctl.speed = Math.max(ctl.speed, 2);
    running = true;
    document.body.dataset.mode = 'battle';
    view.setView('defended');
  },
  startWar(wr: War, c: Campaign) {
    endTraining();
    endStand();
    war = wr;
    hud.campaign = {
      get day() {
        return c.s.day;
      },
      days: CAMPAIGN_DAYS,
      objectives: [],
      onEndDay: () => cui.toggleOrders(),
      clock0: wr.w.clockStart,
      war: true,
      warn: () => {
        const wn = c.s.warn;
        return wn && wn.at > wr.clock - 30 ? `next enemy operation expected ~${hhmm(wn.at)} from the ${SECTOR_NAMES[wn.sector]}` : 'no enemy operation reported';
      },
    };
    show(wr.w);
    hud.setWorld(wr.w);
    wr.onEvent = (msg) => {
      if (!ctl.autoPause || !running || ctl.paused) return;
      ctl.paused = true;
      wr.w.log(`Paused: ${msg}`, 'alert');
    };
    wr.onWorld = (w) => {
      show(w);
      hud.setWorld(w);
    };
    tempo.max = TEMPO.warMax;
    running = true;
    document.body.dataset.mode = 'battle';
    view.setView('defended');
  },
  setPlanning(on: boolean) {
    ctl.paused = on;
    document.body.classList.toggle('planning', on);
  },
  toMenu() {
    endTraining();
    endStand();
    endWar();
    running = false;
    hud.campaign = null;
    show(backdrop());
    cui.showMenu();
  },
  startSandbox,
  startTraining,
  startLastStand,
});

function startSandbox(type?: MapType): void {
  endTraining();
  endStand();
  endWar();
  hud.campaign = null;
  terrain = sandboxTerrain(type);
  const wx = params.get('weather');
  const w = new World({ seed, terrain, weather: wx && wx in WEATHER ? (wx as WeatherId) : undefined });
  w.log(`Map: ${terrain.describe()}`, 'raid');
  show(w);
  hud.setWorld(w);
  running = true;
  document.body.dataset.mode = 'sandbox';
  view.setView('defended');
}

/** The guided training battle: the campaign's starting units plus an early warning radar, on a fixed map. */
function startTraining(lesson: Lesson = 'basics'): void {
  endTraining();
  endStand();
  endWar();
  hud.campaign = null;
  const c = Campaign.create(424242, 'normal', 'coastal');
  c.buy('EWR');
  if (lesson === 'front') setupFrontLesson(c);
  const w = c.makeWorld(false);
  show(w);
  hud.setWorld(w);
  ctl.paused = false;
  ctl.speed = 1;
  // The coach paces the lesson itself.
  ctl.skipQuiet = false;
  running = true;
  document.body.dataset.mode = 'training';
  view.setView('defended');
  tutorial = new Tutorial(w, hud, ctl, (to) => {
    tutorial = null;
    running = false;
    if (to === 'campaign') cui.newCampaign();
    else {
      show(backdrop());
      cui.showMenu();
    }
  }, lesson);
}

/** Last Stand: endless waves on a new map, a reinforcement pick after each. */
function startLastStand(type?: MapType): void {
  endTraining();
  endStand();
  endWar();
  hud.campaign = null;
  const st = new LastStand(params.has('seed') ? seed : Math.floor(Math.random() * 1e6) + 1, type);
  stand = st;
  hud.stand = st;
  show(st.w);
  hud.setWorld(st.w);
  ctl.paused = false;
  ctl.speed = Math.max(ctl.speed, 2);
  running = true;
  document.body.dataset.mode = 'battle';
  view.setView('defended');
  standUi = new StandUi(st, ctl, {
    again: () => startLastStand(type),
    menu: () => {
      endStand();
      running = false;
      show(backdrop());
      cui.showMenu();
    },
  });
}

function endWar(): void {
  war = null;
  tempo.max = TEMPO.max;
  document.body.classList.remove('planning');
}

function endStand(): void {
  standUi?.close();
  standUi = null;
  stand = null;
  hud.stand = null;
}

function endTraining(): void {
  tutorial?.close();
  tutorial = null;
}

// ?mode=sandbox skips the menu (automated playtests use it); ?mode=campaign starts or continues one.
const mode = params.get('mode');
if (mode === 'sandbox') startSandbox();
else if (mode === 'training') startTraining(params.get('lesson') === 'front' ? 'front' : 'basics');
else if (mode === 'laststand') startLastStand();
else if (mode === 'campaign') {
  const saved = params.has('seed') ? null : loadSaved();
  if (saved) cui.continueCampaign(saved);
  else cui.newCampaign(Number(params.get('seed')) || undefined);
} else cui.showMenu();

// Exposed for automated playtests and the browser console.
(window as unknown as { game: unknown }).game = {
  get world() {
    return world;
  },
  view,
  hud,
  ctl,
  cui,
  get stand() {
    return stand;
  },
  get war() {
    return war;
  },
};

// The armoury pauses a running battle while it is open.
document.getElementById('armoury-btn')!.addEventListener('click', () => {
  const was = ctl.paused;
  if (running) ctl.paused = true;
  armoury.open(undefined, () => (ctl.paused = was));
});

const MAX_STEPS_PER_FRAME = 300;
/** Real milliseconds a frame may spend stepping the simulation before it gives up on the backlog. */
const STEP_BUDGET_MS = 14;
/** Sim seconds per real second while the war jumps through quiet time. */
const SKIP_PER_S = 3600;
let acc = 0;
let last = performance.now();
let nextDraw = 0;
/** Last pointer, wheel or key input: the camera may be moving, so idle screens draw at the full rate for a moment. */
let lastInput = 0;
for (const ev of ['pointerdown', 'pointermove', 'wheel', 'keydown']) window.addEventListener(ev, () => (lastInput = performance.now()), { passive: true, capture: true });

function frame(now: number): void {
  requestAnimationFrame(frame);
  // Frame-rate cap (Graphics menu), and a lower rate while nothing moves: paused, in menus or planning.
  const idle = (!running || ctl.paused) && now - lastInput > 1000;
  const fps = idle ? Math.min(IDLE_FPS, gfx.fps || IDLE_FPS) : gfx.fps;
  if (fps) {
    if (now < nextDraw - 1) return;
    nextDraw = Math.max(nextDraw + 1000 / fps, now);
  }
  const real = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (running && !ctl.paused) {
    // Auto tempo: fast while the nearest threat is minutes out, back to the chosen speed as it closes.
    const lv = ctl.skipQuiet && !tutorial ? tempo.update(world) : 1;
    if ((ctl.tempo ?? 1) >= 8 && lv <= 2) world.log('Contact closing: back to normal speed', 'alert');
    ctl.tempo = lv;
    ctl.fastForward = lv > ctl.speed;
    acc += real * Math.max(ctl.speed, lv);
    // Living war: quiet time with nothing on its way is jumped through at about an hour a second, up to the next event.
    const skip = war && lv >= TEMPO.warMax ? war.skippable() : 0;
    if (skip > 30) {
      war!.jump(Math.min(skip, real * SKIP_PER_S));
      ctl.tempo = SKIP_PER_S;
      acc = 0;
    }
    let n = 0;
    const t0 = performance.now();
    while (acc >= DT && n < MAX_STEPS_PER_FRAME) {
      world.step(DT);
      acc -= DT;
      n++;
      if (war && n % 30 === 0) war.update();
      if (performance.now() - t0 > STEP_BUDGET_MS) break;
    }
    // If the sim cannot keep up with the requested compression, drop the backlog rather than spiral.
    if (acc >= DT) acc = 0;
  } else acc = 0;
  if (war && running) {
    war.update();
    cui.autosave();
  }
  view.render();
  ppi.draw();
  if (running) hud.update();
  tutorial?.update();
  if (running && stand?.update()) standUi?.render();
}
requestAnimationFrame(frame);
