// Headless campaign playtest: plans day 1 through the UI (buy, place, start), fights it at high
// time compression, ends the day and screenshots the debrief and the next planning screen.
// Usage: npm run build && node scripts/playtest-campaign.mjs [seed]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const seed = Number(process.argv[2] ?? 7);
const port = 4319;
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
await page.goto(`http://localhost:${port}/?mode=campaign&seed=${seed}`);
await page.waitForFunction(() => window.game?.cui?.campaign);
await page.screenshot({ path: 'playtest/c0-plan.png' });

// Buy a SHORAD unit and place it by clicking the map; try a bad spot (the sea) first.
await page.click('[data-cui="buy"][data-type="SH"]');
const box = await page.locator('#view canvas').first().boundingBox();
await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.55);
await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.55);
await page.screenshot({ path: 'playtest/c1-placed.png' });
console.log('note:', await page.locator('#plan-right .order').textContent().catch(() => ''));
console.log('units:', await page.evaluate(() => window.game.cui.campaign.units.map((u) => `${u.type}@${Math.round(u.x)},${Math.round(u.y)}`).join(' ')));

await page.click('[data-cui="start"]');
await page.waitForFunction(() => document.body.dataset.mode === 'battle');
for (let i = 0; i < 40; i++) {
  const done = await page.evaluate(() => {
    const { world } = window.game;
    for (let k = 0; k < 3600; k++) world.step();
    return world.scenario.done;
  });
  if (i === 6) await page.screenshot({ path: 'playtest/c2-battle.png' });
  if (done) break;
}
await page.waitForTimeout(400);
await page.screenshot({ path: 'playtest/c3-end.png' });
await page.click('[data-act="endday"]');
await page.waitForFunction(() => document.body.dataset.mode === 'debrief');
await page.screenshot({ path: 'playtest/c4-debrief.png' });
console.log((await page.locator('#debrief-body').innerText()).replace(/\n+/g, ' | '));
await page.click('[data-cui="plan"]');
await page.waitForFunction(() => document.body.dataset.mode === 'plan');
await page.screenshot({ path: 'playtest/c5-day2.png' });
console.log('day', await page.evaluate(() => window.game.cui.campaign.s.day));
// Reload: the campaign continues from storage.
await page.goto(`http://localhost:${port}/`);
await page.waitForFunction(() => window.game);
console.log('menu:', (await page.locator('#menu-body').innerText()).replace(/\n+/g, ' | ').slice(0, 300));
await page.screenshot({ path: 'playtest/c6-menu.png' });
console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'No page errors');
await browser.close();
server.kill();
process.exit(errors.length ? 1 : 0);
