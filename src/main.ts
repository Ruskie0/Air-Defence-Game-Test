import './ui/style.css';
import { CAMPAIGN_DAYS, Campaign } from './campaign/campaign';
import { View3D } from './render/view3d';
import { DT } from './sim/constants';
import { MAP_TYPE_LIST, MapType, Terrain, typeForSeed } from './sim/terrain';
import { MAP_SEED, World } from './sim/world';
import { CampaignUi, loadSaved } from './ui/campaign-ui';
import { GameControl, Hud } from './ui/hud';
import { Ppi } from './ui/ppi';
import { Tutorial } from './ui/tutorial';
import { WEATHER, WeatherId } from './campaign/weather';
import { LastStand } from './campaign/laststand';
import { StandUi } from './ui/laststand-ui';

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
let standUi: StandUi | null = null;
const view = new View3D(document.getElementById('view')!, world);
const ppi = new Ppi(document.getElementById('ppi') as HTMLCanvasElement, world);
const ctl: GameControl = { speed: Number(params.get('speed')) || 1, paused: false };
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
    w.scenario.doneMsg = 'All reported packages are in and the airspace is clear. End the day when you are ready.';
    hud.campaign = { day: c.s.day, days: CAMPAIGN_DAYS, objectives: c.s.objectives ?? [], onEndDay: () => {
        running = false;
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
  toMenu() {
    endTraining();
    endStand();
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
function startTraining(): void {
  endTraining();
  endStand();
  hud.campaign = null;
  const c = Campaign.create(424242, 'normal', 'coastal');
  c.buy('EWR');
  const w = c.makeWorld(false);
  show(w);
  hud.setWorld(w);
  ctl.paused = false;
  ctl.speed = 1;
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
  });
}

/** Last Stand: endless waves on a new map, a reinforcement pick after each. */
function startLastStand(type?: MapType): void {
  endTraining();
  endStand();
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
else if (mode === 'training') startTraining();
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
};

const MAX_STEPS_PER_FRAME = 64;
let acc = 0;
let last = performance.now();

function frame(now: number): void {
  const real = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (running && !ctl.paused) {
    acc += real * ctl.speed;
    let n = 0;
    while (acc >= DT && n < MAX_STEPS_PER_FRAME) {
      world.step(DT);
      acc -= DT;
      n++;
    }
    // If the sim cannot keep up with the requested compression, drop the backlog rather than spiral.
    if (n === MAX_STEPS_PER_FRAME) acc = 0;
  } else acc = 0;
  view.render();
  ppi.draw();
  if (running) hud.update();
  tutorial?.update();
  if (running && stand?.update()) standUi?.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
