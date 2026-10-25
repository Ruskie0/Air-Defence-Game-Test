// RTS controls check: box select on the 3D view and the scope, control groups, a formation move and group orders.
// Usage: npm run build && node scripts/playtest-rts.mjs
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const port = 4332;
const server = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], { stdio: 'pipe' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.stack ?? e).slice(0, 600)));
await page.goto(`http://localhost:${port}/?mode=campaign&seed=3`);
await page.waitForFunction(() => window.game?.cui?.campaign);
await page.locator('[data-cui="start"]').first().dispatchEvent('click');
await page.waitForFunction(() => document.body.dataset.mode !== 'plan');
await page.evaluate(() => (window.game.ctl.paused = true));
const ok = (name, cond, info = '') => console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? `: ${info}` : ''}`);
const multi = () => page.evaluate(() => window.game.hud.multi.slice());

// Overview camera, then a shift-drag box over the whole view.
await page.evaluate(() => document.querySelector('[data-act="view"][data-v="overview"]')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
await page.evaluate(() => window.game.view.flyToGround(0, 0));
await page.waitForTimeout(2500);
const c = await page.evaluate(() => { const r = window.game.view.renderer.domElement.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; });
await page.keyboard.down('Shift');
await page.mouse.move(c.x + c.width * 0.3, c.y + c.height * 0.2);
await page.mouse.down();
await page.mouse.move(c.x + c.width * 0.7, c.y + c.height * 0.9, { steps: 5 });
await page.mouse.up();
await page.keyboard.up('Shift');
let m = await multi();
ok('3D box select', m.length > 1, m.join(' '));
await page.waitForTimeout(500);
await page.evaluate(() => window.game.hud.update());
const det = await page.locator('#detail').innerText();
ok('group panel', /units selected/i.test(det), det.slice(0, 80));

// Save as group 1 (Shift+1, since Chrome keeps Ctrl+1), clear, recall.
await page.keyboard.press('Shift+Digit1');
await page.keyboard.press('Escape');
ok('cleared', (await multi()).length === 0);
await page.keyboard.press('Digit1');
ok('group 1 recalled', (await multi()).length === m.length);
await page.evaluate(() => window.game.view.flyToGround(40000, 40000));
await page.waitForFunction(() => !window.game.view.rig.fly, null, { timeout: 120000 });
const cam0 = await page.evaluate(() => window.game.view.controls?.target?.clone?.() ?? null);
await page.keyboard.press('Digit1');
await page.keyboard.press('Digit1');
await page.waitForFunction(() => !window.game.view.rig.fly, null, { timeout: 120000 });
const cam1 = await page.evaluate(() => window.game.view.controls?.target?.clone?.() ?? null);
ok('double tap flies the camera', cam0 && cam1 && Math.hypot(cam0.x - cam1.x, cam0.z - cam1.z) > 10, JSON.stringify([cam0, cam1, await page.evaluate(() => window.game.hud['lastOrder'])]));

// Hold fire for all, then release.
await page.keyboard.press('KeyH');
const held = await page.evaluate(() => window.game.world.units.every((u) => u.hold));
ok('hold fire for the group', held);
await page.keyboard.press('KeyH');

// EMCON for all radars.
await page.evaluate(() => window.game.hud.update());
await page.evaluate(() => document.querySelector('[data-act="grp-emcon"]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
const em = await page.evaluate(() => window.game.hud.multi.map((c) => window.game.world.fieldedByCode(c)).map((f) => (f.fu?.radar ?? f.radar)?.emcon).filter(Boolean));
ok('EMCON for the group', em.length && em.every((e) => e === 'near'), em.join(' '));

// Scope: drag a box over the inner part, selecting the units near the defended area.
const ppi = await page.locator('canvas#ppi').first().boundingBox();
await page.mouse.move(ppi.x + ppi.width * 0.3, ppi.y + ppi.height * 0.3);
await page.mouse.down();
await page.mouse.move(ppi.x + ppi.width * 0.7, ppi.y + ppi.height * 0.7, { steps: 4 });
await page.mouse.up();
m = await multi();
ok('scope box select', m.length >= 1, m.join(' '));

// Formation move: right click on the scope a little north.
await page.mouse.click(ppi.x + ppi.width * 0.5, ppi.y + ppi.height * 0.45, { button: 'right' });
const order = await page.evaluate(() => window.game.hud['lastOrder']);
const moving = await page.evaluate(() => window.game.hud.multi.filter((c) => window.game.world.fieldedByCode(c)?.move).length);
ok('formation move', moving > 0, order);
console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'No page errors');
await browser.close();
server.kill('SIGKILL');
process.exit(0);
