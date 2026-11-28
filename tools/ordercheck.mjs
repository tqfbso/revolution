// Can the player still give orders? For each army: start a battle, box-select every unit of
// the opening force on screen with the mouse (trucks too, which brings up the build card),
// right click the ground and check that they all set off, with no error on the page.
// On 2026-11-28 a crash in the Rebels' command card stopped every order (decision 163).
//
//   npm run build && npx vite preview --port 4173 --host 127.0.0.1
//   node tools/ordercheck.mjs [nato russia china rebels none]
/* global process, window, document, console */
import { chromium } from 'playwright';

const armies =
  process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : ['nato', 'russia', 'china', 'rebels', 'none'];
const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-proxy-server',
  ],
});
let failed = false;
for (const army of armies) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(300_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(
    `http://127.0.0.1:${process.env.PORT ?? 4173}/?renderer=webgl&shadows=0&play=1&army=${army}`,
  );
  await page.waitForFunction(() => window.__revolution?.units?.count > 5);
  await page.waitForTimeout(3000);
  // Every unit of the player's on screen: id, kind, screen point and ground point.
  const mine = () =>
    page.evaluate(() => {
      const r = window.__revolution;
      const u = r.units;
      const cam = r.camera;
      const out = [];
      for (let i = 0; i < u.count; i++) {
        if (!u.isMine(i)) continue;
        const p = new cam.position.constructor(
          u.renderPos[3 * i],
          u.renderPos[3 * i + 1],
          u.renderPos[3 * i + 2],
        ).project(cam);
        out.push({
          id: i,
          sx: ((p.x + 1) / 2) * window.innerWidth,
          sy: ((1 - p.y) / 2) * window.innerHeight,
          x: u.renderPos[3 * i],
          z: u.renderPos[3 * i + 2],
        });
      }
      return out;
    });
  // Clear of the panels at the top, the card at the bottom and the minimap on the right.
  const shown = (await mine()).filter((o) => o.sx > 20 && o.sx < 1000 && o.sy > 160 && o.sy < 560);
  const xs = shown.map((o) => o.sx);
  const ys = shown.map((o) => o.sy);
  await page.mouse.move(Math.min(...xs) - 15, Math.min(...ys) - 15);
  await page.mouse.down();
  await page.mouse.move(Math.max(...xs) + 15, Math.max(...ys) + 15, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(1500);
  const selected = await page.evaluate(() => window.__revolution.units.selectedIds());
  const from = new Map(shown.map((o) => [o.id, o]));
  await page.mouse.click(640, 240, { button: 'right' });
  await page.waitForTimeout(9000);
  const now = await mine();
  let moved = 0;
  for (const id of selected) {
    const a = from.get(id);
    const b = now.find((o) => o.id === id);
    if (a && b && Math.hypot(b.x - a.x, b.z - a.z) > 4) moved++;
  }
  const card = await page.evaluate(() => document.getElementById('card')?.textContent?.length ?? 0);
  const ok =
    errors.length === 0 && selected.length > 0 && moved >= selected.length * 0.8 && card > 0;
  if (!ok) failed = true;
  console.log(
    `${army.padEnd(7)} selected ${selected.length}, moved ${moved}, card ${card > 0 ? 'shown' : 'EMPTY'}, page errors ${errors.length}${errors[0] ? ` (${errors[0]})` : ''}: ${ok ? 'ok' : 'FAILED'}`,
  );
  await page.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
