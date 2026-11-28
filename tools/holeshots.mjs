// Pictures of mouseholes (decision 166), taken in the game itself: engineers knock a block
// of houses through, then Garrison block fills it. City map, seed 1, block of house 58.
//
//   npm run build && npx vite preview --port 4173 --host 127.0.0.1
//   node tools/holeshots.mjs out-prefix
/* global process, window, console */
import { chromium } from 'playwright';

const [out = 'holes'] = process.argv.slice(2);
const HOUSE = Number(process.env.HOUSE ?? 58);
const URL =
  `http://127.0.0.1:${process.env.PORT ?? 4173}/?renderer=webgl&scale=fixed&fog=0&debug=1&control=all&ai=off` +
  `&quality=low&shadows=0&units=0&seed=1&map=city`;

const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-proxy-server'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(900_000);
page.on('console', (m) => m.type() === 'error' && console.log('page:', m.text()));
page.on('pageerror', (e) => console.log('page error:', e.message));
await page.goto(URL);
await page.waitForFunction(() => window.__revolution?.send && window.__revolution.units.count > 0);
await page.addStyleTag({ content: '#paused{display:none!important}' });
const box = await page.evaluate((s) => {
  const m = window.__revolution.map;
  return { x: (m.sX[s] + m.sW[s] / 2) * 4, z: (m.sY[s] + m.sH[s] / 2) * 4 };
}, HOUSE);
console.log('house', HOUSE, box);
// Engineers and riflemen in the street just south of the block.
const sx = box.x;
const sz = box.z + 22;
await page.evaluate(
  ([x, z]) => {
    const send = window.__revolution.send;
    const f = (n) => Math.round(n * 1024);
    send({ type: 3, count: 2, team: 0, kind: 11, wander: false, x: f(x), y: f(z), radius: f(3) });
    send({
      type: 3,
      count: 12,
      team: 0,
      kind: 1,
      wander: false,
      x: f(x + 10),
      y: f(z),
      radius: f(5),
    });
  },
  [sx, sz],
);
await page.waitForTimeout(3000);
const ids = await page.evaluate(
  ([x, z]) => {
    const u = window.__revolution.units;
    const eng = [];
    const foot = [];
    for (let i = 0; i < u.count; i++) {
      const d = Math.hypot(u.curr[2 * i] - x, u.curr[2 * i + 1] - z);
      if (d > 30) continue;
      if (u.kind[i] === 11) eng.push(i);
      if (u.kind[i] === 1) foot.push(i);
    }
    return { eng, foot };
  },
  [sx, sz],
);
console.log('units', ids);
// The middle of the block (CX, CZ in metres), else the house.
const cx = Number(process.env.CX ?? box.x);
const cz = Number(process.env.CZ ?? box.z);
const look = (d, yaw, dx = 0, dz = 0) =>
  page.evaluate(([x, z, d, y]) => window.__revolution.look(x, z, d, y), [cx + dx, cz + dz, d, yaw]);
const shot = async (name, d, yaw, dx, dz) => {
  await look(d, yaw, dx, dz);
  await page.waitForTimeout(6000);
  await page.screenshot({ path: `${out}-${name}.png`, timeout: 900_000 });
  console.log('saved', name);
};
await shot('1-before', 70, 0.6);
await page.evaluate(
  ([e, s]) => window.__revolution.send({ type: 51, units: e, structure: s }),
  [ids.eng, HOUSE],
);
const holes = () => page.evaluate(() => window.__revolution.structures.holes.shown.length);
for (let n = 0; n < 900 && (await holes()) < Number(process.env.WANT ?? 6); n++) {
  await page.waitForTimeout(1000);
}
console.log('holes shown', await holes());
await page.evaluate(
  ([f, s]) => window.__revolution.send({ type: 52, units: f, structure: s }),
  [ids.foot, HOUSE],
);
await page.waitForTimeout(30000);
await shot('2-holed-and-garrisoned', 70, 0.6);
await shot('3-closer', 45, 2.2);
await browser.close();
