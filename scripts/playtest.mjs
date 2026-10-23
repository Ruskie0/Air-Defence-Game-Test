// Headless playtest: serves dist/ with `vite preview`, runs the sandbox at high time compression and
// reports console errors, track counts, engagements and screenshots.
// Usage: npm run build && node scripts/playtest.mjs [simSeconds]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const simSeconds = Number(process.argv[2] ?? 1500);
const port = 4318;
const server = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], { stdio: 'pipe' });
await new Promise((r) => setTimeout(r, 2500));

mkdirSync('playtest', { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(`http://localhost:${port}/`);
await page.waitForFunction(() => window.game);
await page.click('[data-close]');
await page.screenshot({ path: 'playtest/00-start.png' });

// Step the sim directly (faster than real time) and sample the state.
let shot = 1;
for (let t = 0; t < simSeconds; t += 60) {
  const s = await page.evaluate(() => {
    const { world } = window.game;
    for (let i = 0; i < 3600; i++) world.step();
    return {
      t: Math.round(world.t),
      entities: world.entities.length,
      tracks: world.tracker.tracks.filter((x) => x.confirmed).length,
      hostile: world.tracker.tracks.filter((x) => x.ident === 'HOS').length,
      missiles: world.missiles.length,
      stats: world.stats,
      log: world.logEntries.slice(-4).map((e) => e.msg),
    };
  });
  console.log(JSON.stringify(s));
  if (t % 300 === 0) await page.screenshot({ path: `playtest/${String(shot++).padStart(2, '0')}-t${s.t}.png` });
}
await page.screenshot({ path: 'playtest/final.png' });
console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'No page errors');
await browser.close();
server.kill();
process.exit(errors.length ? 1 : 0);
