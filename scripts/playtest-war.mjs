// Browser playtest of the living war: opens a new campaign, buys and places a unit on the orders overlay,
// starts the war, runs it at full auto tempo for a while, opens the orders again mid-war and checks a save.
// Usage: npm run build && node scripts/playtest-war.mjs [seed] [real seconds to run]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const seed = Number(process.argv[2] ?? 7);
const runS = Number(process.argv[3] ?? 40);
const port = 4321;
const server = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], { stdio: 'pipe' });
await new Promise((r) => setTimeout(r, 2500));

mkdirSync('playtest', { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
// Software rendering is slow: low quality keeps the frame rate usable.
await page.addInitScript(() => localStorage.setItem('ad-graphics', JSON.stringify({ quality: 'low', fps: 30 })));
page.setDefaultTimeout(120000);
const errors = [];
page.on('pageerror', (e) => { errors.push(String(e)); console.log('PAGE ERROR', String(e)); });
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(`http://localhost:${port}/?mode=campaign&seed=${seed}`);
await page.waitForFunction(() => window.game?.war);
await page.waitForTimeout(1000);
await page.screenshot({ path: 'playtest/w0-orders.png' });

await page.click('[data-cui="buy"][data-type="SH"]');
const box = await page.locator('#view canvas').first().boundingBox();
await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.55);
console.log('note:', await page.locator('#plan-right .order').textContent().catch(() => ''));
console.log('fielded:', await page.evaluate(() => window.game.war.w.fielded.map((f) => f.unit.type).join(' ')));

await page.click('[data-cui="resume"]');
const t0 = Date.now();
let last = '';
while (Date.now() - t0 < runS * 1000) {
  await page.waitForTimeout(5000);
  const st = await page.evaluate(() => {
    const g = window.game;
    const w = g.war.w;
    return `${document.querySelector('#clock')?.textContent} | ${document.querySelector('#raid')?.textContent?.slice(0, 120)} | red ${w.entities.filter((e) => e.alive && e.side === 'red').length} | tempo ${g.ctl.tempo} t ${Math.round(w.t)} paused ${g.ctl.paused}`;
  });
  if (st !== last) console.log(st);
  last = st;
}
await page.screenshot({ path: 'playtest/w1-war.png' });
await page.keyboard.press('KeyP');
await page.waitForTimeout(800);
await page.screenshot({ path: 'playtest/w2-orders-mid.png' });
const saved = await page.evaluate(() => localStorage.getItem('air-defence-campaign-v1')?.length ?? 0);
console.log('save bytes:', saved, 'paused:', await page.evaluate(() => window.game.ctl.paused));
console.log('errors:', errors.length ? errors.slice(0, 5) : 'none');
await browser.close();
server.kill();
