// Pictures of one big building being shot to pieces, taken in the game itself, for judging
// how destruction looks (decision 157). Tanks open up on it from one side and guns shell
// one corner; the game is paused and photographed as its health passes each mark.
// The sim does the same thing on every build, so two builds give matching pictures.
//
//   npm run build && npx vite preview --port 4173 --host 127.0.0.1
//   node tools/ruinshots.mjs out-prefix [city|kowloon]
/* global process, window, console */
import { chromium } from 'playwright';

const [out = 'ruin', where = 'city'] = process.argv.slice(2);
// Building, the side the tanks come from (+1 east, -1 west), camera distance and yaw.
const SCENES = {
  // City, seed 1: a five-storey block of 3 by 5 cells.
  city: { s: 211, side: 1, dist: 52, yaw: 1.25, tanks: 3, guns: 2 },
  // Kowloon, seed 1: an eighteen-storey tower of 6 by 6 cells.
  kowloon: { s: 24, side: 1, dist: 115, yaw: 1.25, tanks: 4, guns: 4 },
};
const scene = SCENES[where];
const URL =
  `http://127.0.0.1:${process.env.PORT ?? 4173}/?renderer=webgl&scale=fixed&fog=0&debug=1&control=all&ai=off` +
  `&quality=low&shadows=0&units=0&seed=1&map=${where}`;
const MARKS = (process.env.MARKS ?? '230,190,150,120,100,0').split(',').map(Number);

const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-proxy-server'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(900_000);
page.on('console', (m) => m.type() === 'error' && console.log('page:', m.text()));
await page.goto(URL);
await page.waitForFunction(() => window.__revolution?.send && window.__revolution.units.count > 20);
await page.addStyleTag({ content: '#paused{display:none!important}' });
const box = await page.evaluate((s) => {
  const m = window.__revolution.map;
  return { x0: m.sX[s] * 4, z0: m.sY[s] * 4, w: m.sW[s] * 4, d: m.sH[s] * 4, floors: m.sFloors[s] };
}, scene.s);
const cx = box.x0 + box.w / 2;
const cz = box.z0 + box.d / 2;
console.log('building', scene.s, box);
const tankX = scene.side > 0 ? box.x0 + box.w + 26 : box.x0 - 26;
const gunX = cx + scene.side * 150;
await page.evaluate(
  ([tx, cz, gx, tanks, guns]) => {
    const fx = (n) => Math.round(n * 1024);
    const send = window.__revolution.send;
    send({
      type: 3,
      count: tanks,
      team: 0,
      kind: 0,
      wander: false,
      x: fx(tx),
      y: fx(cz),
      radius: fx(4),
    });
    if (guns > 0)
      send({
        type: 3,
        count: guns,
        team: 0,
        kind: 4,
        wander: false,
        x: fx(gx),
        y: fx(cz - 30),
        radius: fx(5),
      });
  },
  [tankX, cz, gunX, scene.tanks, scene.guns],
);
await page.waitForTimeout(3000);
const ids = await page.evaluate(
  ([tx, cz, gx]) => {
    const u = window.__revolution.units;
    const tanks = [];
    const guns = [];
    for (let i = 0; i < u.count; i++) {
      const x = u.curr[2 * i];
      const z = u.curr[2 * i + 1];
      if (u.kind[i] === 0 && Math.hypot(x - tx, z - cz) < 14) tanks.push(i);
      if (u.kind[i] === 4 && Math.hypot(x - gx, z - (cz - 30)) < 16) guns.push(i);
    }
    return { tanks, guns };
  },
  [tankX, cz, gunX],
);
console.log('units', ids);
// The guns shell the corner on the tanks' side, toward the camera.
const cornerX = scene.side > 0 ? box.x0 + box.w - 3 : box.x0 + 3;
const cornerZ = box.z0 + box.d - 3;
await page.evaluate(
  ([s, ids, x, z]) => {
    const send = window.__revolution.send;
    send({ type: 6, units: ids.tanks, structure: s });
    if (ids.guns.length > 0)
      send({ type: 9, units: ids.guns, x: Math.round(x * 1024), y: Math.round(z * 1024) });
  },
  [scene.s, ids, cornerX, cornerZ],
);
const look = () =>
  page.evaluate(
    ([x, z, d, y]) => window.__revolution.look(x, z, d, y),
    [cx, cz, scene.dist, scene.yaw],
  );
await look();
const hpOf = () => page.evaluate((s) => window.__revolution.structures.hp[s], scene.s);
const shot = async (name) => {
  await look();
  await page.waitForTimeout(6000);
  await page.screenshot({ path: `${out}-${name}.png`, timeout: 900_000 });
  console.log('saved', name);
};
await page.keyboard.press('Space');
await shot('0-intact');
await page.keyboard.press('Space');
let k = 0;
for (let n = 0; n < 4000 && k < MARKS.length; n++) {
  const hp = await hpOf();
  if (hp <= MARKS[k]) {
    await page.keyboard.press('Space');
    // Let the pending looks build before the picture.
    await page.waitForTimeout(2500);
    await shot(`${k + 1}-hp${hp}`);
    await page.keyboard.press('Space');
    while (k < MARKS.length && hp <= MARKS[k]) k++;
  }
  await page.waitForTimeout(200);
}
await browser.close();
