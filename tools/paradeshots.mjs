// Pictures of the armies' vehicles in the game itself: a column of each kind for two armies
// on open ground, close and from the middle distance.
//
//   npm run build && npx vite preview --port 4173 --host 127.0.0.1
//   node tools/paradeshots.mjs out-prefix [army] [foe] [x z] [map]
/* global process, window, console */
import { chromium } from 'playwright';

const [out = 'parade', army = 'nato', foe = 'russia', cx = '300', cz = '300', map = 'ridge'] =
  process.argv.slice(2);
const URL =
  `http://127.0.0.1:${process.env.PORT ?? 4173}/` +
  '?renderer=webgl&scale=fixed&fog=0&debug=1&control=all&ai=off' +
  `&quality=normal&shadows=${process.env.SHADOWS ?? '1'}&units=0&army=${army}&foe=${foe}&map=${map}`;
const X = Number(cx);
const Z = Number(cz);
const kinds = (process.env.KINDS ?? '0,3,4,8,9,10').split(',').map(Number);

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-proxy-server',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(900_000);
page.on('console', (m) => m.type() === 'error' && console.log('page:', m.text()));
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto(URL);
await page.waitForFunction(() => window.__revolution?.send && window.__revolution.units.count > 5);
// Open ground to stand on: the block of clear cells nearest the place asked for.
const [PX, PZ] = await page.evaluate(
  ([x, z, n]) => {
    const map = window.__revolution.map;
    const wide = 12;
    void n;
    let best = [x, z];
    let bd = 1e9;
    for (let j = 8; j < 248; j++)
      for (let i = 4; i < 250 - wide; i++) {
        let ok = true;
        for (let dj = -6; dj <= 6 && ok; dj++)
          for (let di = 0; di < wide && ok; di++) {
            const c = (j + dj) * 256 + i + di;
            if (map.type[c] !== 0 || map.structAt[c] >= 0 || map.road[c] !== 0) ok = false;
          }
        if (!ok) continue;
        const px = (i + wide / 2) * 4;
        const pz = j * 4;
        const d = Math.hypot(px - x, pz - z);
        if (d < bd) {
          bd = d;
          best = [px, pz];
        }
      }
    return best;
  },
  [X, Z, kinds.length],
);
console.log('parade at', PX, PZ);
await page.evaluate(
  ([x, z, kinds]) => {
    const fx = (n) => Math.round(n * 1024);
    const send = window.__revolution.send;
    kinds.forEach((kind, k) => {
      send({
        type: 3,
        count: 1,
        team: 0,
        kind,
        wander: false,
        x: fx(x + ((k % 3) - 1) * 4.6),
        y: fx(z + (k < 3 ? 2.6 : -2.6)),
        radius: fx(0.2),
      });
    });
    window.__revolution.look(x, z, 40, 0.5);
  },
  [PX, PZ, kinds],
);
// Time to walk to their places and settle (longer for men, who then set their weapons down).
await page.waitForTimeout(Number(process.env.WAIT ?? 6000));
await page.keyboard.press('Space');
await page.addStyleTag({ content: '#paused{display:none!important}' });
// Where they ended up standing: the last units made are ours.
const [CX, CZ] = await page.evaluate((n) => {
  const u = window.__revolution.units;
  let x = 0;
  let z = 0;
  for (let i = u.count - n; i < u.count; i++) {
    x += u.curr[2 * i] / n;
    z += u.curr[2 * i + 1] / n;
  }
  return [x, z];
}, kinds.length);
console.log('standing at', CX.toFixed(0), CZ.toFixed(0));
// POSE=halted,fight,since holds every squad in one stance (halted and in a fight, so many seconds after a shot).
if (process.env.POSE)
  await page.evaluate(
    (p) => (window.__revolution.units.pose = p),
    process.env.POSE.split(',').map(Number),
  );
const shot = async (name, dist, yaw = 0.5) => {
  await page.evaluate(
    ([x, z, d, yaw]) => window.__revolution.look(x, z, d, yaw),
    [CX, CZ, dist, yaw],
  );
  await page.waitForTimeout(6000);
  await page.screenshot({ path: `${out}-${name}.png`, timeout: 900_000 });
  console.log('saved', name);
};
await shot('close', Number(process.env.CLOSE ?? 17), Number(process.env.YAW ?? 2.6));
await shot('mid', Number(process.env.MID ?? 60), Number(process.env.YAW ?? 2.6));
await browser.close();
