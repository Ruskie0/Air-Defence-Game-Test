import './ui/style.css';
import { View3D } from './render/view3d';
import { DT } from './sim/constants';
import { World } from './sim/world';
import { GameControl, Hud } from './ui/hud';
import { Ppi } from './ui/ppi';

const params = new URLSearchParams(location.search);
const seed = Number(params.get('seed')) || 20261023;

const world = new World(seed);
const view = new View3D(document.getElementById('view')!, world);
const ppi = new Ppi(document.getElementById('ppi') as HTMLCanvasElement, world);
const ctl: GameControl = { speed: Number(params.get('speed')) || 1, paused: false };
const hud = new Hud(world, view, ppi, ctl);

// Exposed for automated playtests and the browser console.
(window as unknown as { game: unknown }).game = { world, view, hud, ctl };

const MAX_STEPS_PER_FRAME = 64;
let acc = 0;
let last = performance.now();

function frame(now: number): void {
  const real = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!ctl.paused) {
    acc += real * ctl.speed;
    let n = 0;
    while (acc >= DT && n < MAX_STEPS_PER_FRAME) {
      world.step(DT);
      acc -= DT;
      n++;
    }
    // If the sim cannot keep up with the requested compression, drop the backlog rather than spiral.
    if (n === MAX_STEPS_PER_FRAME) acc = 0;
  }
  view.render();
  ppi.draw();
  hud.update();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
