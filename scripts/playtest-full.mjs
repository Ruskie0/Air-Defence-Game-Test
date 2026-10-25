// Full-campaign browser playthrough: plays every raid through the UI (start, fight at high compression, end,
// debrief, plan), collecting page errors, and on the late days measures sim step and 3D render times with the
// raid in full swing, plus the save size. Usage: npm run build && node scripts/playtest-full.mjs [seed]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const seed = Number(process.argv[2] ?? 7);
const port = 4331;
const server = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], { stdio: 'pipe' });
await new Promise((r) => setTimeout(r, 2500));
mkdirSync('playtest', { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(120000);
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.stack ?? e).slice(0, 600)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 400)));
await page.goto(`http://localhost:${port}/?mode=campaign&seed=${seed}`);
await page.waitForFunction(() => window.game?.cui?.campaign);

for (let raid = 0; raid < 60; raid++) {
  const st = await page.evaluate(() => ({ day: window.game.cui.campaign.s.day, over: window.game.cui.campaign.s.over, mode: document.body.dataset.mode }));
  if (st.over) {
    console.log('campaign over', JSON.stringify(st.over).slice(0, 200));
    break;
  }
  await page.waitForSelector('[data-cui="start"]');
  await page.click('[data-cui="start"]');
  await page.waitForFunction(() => document.body.dataset.mode === 'battle');
  let perf = null;
  for (let i = 0; i < 120; i++) {
    const r = await page.evaluate((measure) => {
      const { world, view } = window.game;
      const t0 = performance.now();
      for (let k = 0; k < 900; k++) world.step();
      const stepMs = (performance.now() - t0) / 900;
      let renderMs = null;
      if (measure) {
        const r0 = performance.now();
        for (let k = 0; k < 10; k++) view.render();
        renderMs = (performance.now() - r0) / 10;
      }
      window.game.hud.update();
      return { done: world.scenario.done, stepMs, renderMs, ents: world.entities.filter((e) => e.alive).length };
    }, st.day >= 8 && i % 10 === 5);
    if (r.renderMs !== null && (!perf || r.ents > perf.ents)) perf = r;
    if (r.done) break;
  }
  if (perf) console.log(`day ${st.day} perf: ${perf.ents} live entities, sim step ${perf.stepMs.toFixed(3)} ms, render ${perf.renderMs.toFixed(1)} ms (SwiftShader)`);
  if (st.day >= 9 && raid % 3 === 0) await page.screenshot({ path: `playtest/full-d${st.day}.png` });
  await page.click('[data-act="endday"]');
  await page.waitForFunction(() => document.body.dataset.mode === 'debrief');
  const text = (await page.locator('#debrief-body').innerText()).replace(/\n+/g, ' | ');
  console.log(`raid ${raid} day ${st.day}: ${text.slice(0, 160)}`);
  if (await page.locator('[data-cui="plan"]').count()) await page.click('[data-cui="plan"]');
  else break;
  await page.waitForFunction(() => document.body.dataset.mode === 'plan' || window.game.cui.campaign.s.over);
}
console.log('save size', await page.evaluate(() => (window.game.cui.campaign.save().length / 1024).toFixed(1) + ' KB'));
console.log(errors.length ? `ERRORS (${errors.length}):\n${[...new Set(errors)].join('\n')}` : 'No page errors');
await browser.close();
server.kill('SIGKILL');
process.exit(0);
