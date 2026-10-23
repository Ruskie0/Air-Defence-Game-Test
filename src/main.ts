import './ui/style.css';
import type { Campaign } from './campaign/campaign';
import { CAMPAIGN_DAYS } from './campaign/campaign';
import { View3D } from './render/view3d';
import { DT } from './sim/constants';
import { Terrain } from './sim/terrain';
import { MAP_SEED, World } from './sim/world';
import { CampaignUi, loadSaved } from './ui/campaign-ui';
import { GameControl, Hud } from './ui/hud';
import { Ppi } from './ui/ppi';

const params = new URLSearchParams(location.search);
const seed = Number(params.get('seed')) || MAP_SEED;

/** One terrain for every world: the sandbox, each campaign day and the deployment preview. */
const terrain = new Terrain(MAP_SEED);
/** What the menu shows behind it: the sandbox defence with no raids. */
const backdrop = (): World => new World({ seed, terrain, raids: [], civil: false });

let world = backdrop();
/** Only a battle (sandbox or campaign day) runs the simulation; the menu and planning just render. */
let running = false;
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
  terrain,
  view,
  ppi,
  showPreview(w) {
    running = false;
    show(w);
  },
  startBattle(w: World, c: Campaign) {
    w.scenario.doneMsg = 'All reported packages are in and the airspace is clear. End the day when you are ready.';
    hud.campaign = { day: c.s.day, days: CAMPAIGN_DAYS, onEndDay: () => {
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
    running = false;
    hud.campaign = null;
    show(backdrop());
    cui.showMenu();
  },
  startSandbox,
});

function startSandbox(): void {
  hud.campaign = null;
  const w = new World({ seed, terrain });
  show(w);
  hud.setWorld(w);
  running = true;
  document.body.dataset.mode = 'sandbox';
  view.setView('defended');
}

// ?mode=sandbox skips the menu (automated playtests use it); ?mode=campaign starts or continues one.
const mode = params.get('mode');
if (mode === 'sandbox') startSandbox();
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
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
