// The pictures behind the main menu (decision 151) are taken in the game itself. This stages
// a night battle on a town square and photographs it from a camera lower than the game's own.
//
//   npm run build && npx vite preview --port 4173 --host 127.0.0.1
//   node tools/menushots.mjs city out.png            (or: euro)
//   node tools/menushots.mjs city out.png 510 455 75 (square x, z; seconds of fighting first)
//
// Without a graphics card a frame takes minutes: one picture a run, about five minutes.
// Then: resize to 1920x1080, save as public/menu.jpg, menu-2.jpg or menu-3.jpg (quality 82).
/* global process, window, console */
import { chromium } from 'playwright';

const [
  map = 'city',
  out = 'menu.png',
  cx = '510',
  cz = map === 'euro' ? '505' : '455',
  wait = '75',
] = process.argv.slice(2);
const URL =
  'http://127.0.0.1:4173/?renderer=webgl&scale=fixed&fog=0&debug=1&control=all&ai=off' +
  `&time=night&quality=high&units=0&map=${map}`;
/** The camera: degrees round the square, metres back, metres up, lens, and how far the fight sits right of the middle. */
const VIEW = { yaw: 30, dist: 75, height: 26, fov: 34, lift: 3, right: 10 };

const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-proxy-server'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.setDefaultTimeout(600_000);
await page.goto(URL);
await page.waitForFunction(() => window.__revolution?.send && window.__revolution.units.count > 20);

// Two armies of every arm, a street apart, each ordered to attack toward the other.
await page.evaluate(
  ([x, z]) => {
    const fx = (n) => Math.round(n * 1024);
    const spawn = (team, kind, count, off, side, radius, advance) => {
      const s = team ? 1 : -1;
      window.__revolution.send({
        type: 3,
        count,
        team,
        kind,
        wander: false,
        x: fx(x + s * off),
        y: fx(z + side),
        radius: fx(radius),
        advanceX: fx(-s * advance),
        advanceY: 0,
      });
    };
    for (const team of [0, 1]) {
      spawn(team, 0, 7, 82, 0, 22, 60); // tanks
      spawn(team, 3, 6, 94, 20, 22, 66); // infantry fighting vehicles
      spawn(team, 1, 28, 66, -25, 35, 50); // rifle squads
      spawn(team, 1, 20, 72, 40, 30, 55);
      spawn(team, 2, 6, 77, 10, 25, 44); // missile teams
      spawn(team, 12, 3, 126, -30, 30, 110); // helicopters
      spawn(team, 4, 3, 143, 0, 20, 16); // guns
    }
  },
  [Number(cx), Number(cz)],
);
await page.waitForTimeout(Number(wait) * 1000);

await page.addStyleTag({
  content:
    '#left,#right,#bottom,#alerts,#minimap,#alert-arrows,.panel,.pill,#paused,#missions,#perf{display:none!important}',
});
// Aim at the thick of the firing, and take the camera off the game's own rig.
await page.evaluate((v) => {
  const game = window.__revolution;
  const u = game.units;
  let last = -1e9;
  for (let i = 0; i < u.count; i++) last = Math.max(last, u.shotAt[i]);
  const firing = [];
  for (let i = 0; i < u.count; i++) if (last - u.shotAt[i] < 10) firing.push(i);
  const cells = new Map();
  for (const i of firing) {
    const key = `${Math.floor(u.curr[2 * i] / 60)},${Math.floor(u.curr[2 * i + 1] / 60)}`;
    cells.set(key, (cells.get(key) ?? 0) + 1);
  }
  const [bx, bz] = [...cells.entries()]
    .sort((a, b) => b[1] - a[1])[0][0]
    .split(',')
    .map((n) => Number(n) * 60 + 30);
  let sx = 0;
  let sz = 0;
  let n = 0;
  for (const i of firing) {
    if (Math.hypot(u.curr[2 * i] - bx, u.curr[2 * i + 1] - bz) < 50) {
      sx += u.curr[2 * i];
      sz += u.curr[2 * i + 1];
      n++;
    }
  }
  const yaw = (v.yaw * Math.PI) / 180;
  const x = sx / n - Math.cos(yaw) * v.right;
  const z = sz / n + Math.sin(yaw) * v.right;
  const camera = game.camera;
  const lookAt = Object.getPrototypeOf(camera).lookAt;
  game.look(x, z, 30, yaw);
  camera.fov = v.fov;
  camera.updateProjectionMatrix();
  camera.lookAt = function (tx, ty, tz) {
    this.position.set(x + Math.sin(yaw) * v.dist, ty + v.height, z + Math.cos(yaw) * v.dist);
    lookAt.call(this, tx, ty + v.lift, tz);
  };
}, VIEW);
await page.waitForTimeout(20_000);
await page.screenshot({ path: out, timeout: 600_000 });
console.log('saved', out);
await browser.close();
