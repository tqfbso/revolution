// Pictures of the air strikes (I7), taken in the game itself: enemy armour and men on a
// square, the army given the top tier, its strike called on them; the game is paused once
// as the load comes down and once as it lands.
//
//   npm run build && npx vite preview --port 4173 --host 127.0.0.1
//   node tools/strikeshots.mjs nato out-prefix      (or: russia, china)
/* global process, window, console */
import { chromium } from 'playwright';

const [army = 'nato', out = 'strike', cx = '510', cz = '455'] = process.argv.slice(2);
const URL =
  'http://127.0.0.1:4173/?renderer=webgl&scale=fixed&fog=0&debug=1&control=all&ai=off' +
  `&quality=low&shadows=0&units=0&speed=0.5&army=${army}`;
const X = Number(cx);
const Z = Number(cz);

const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-proxy-server'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(600_000);
page.on('console', (m) => m.type() === 'error' && console.log('page:', m.text()));
await page.goto(URL);
await page.waitForFunction(() => window.__revolution?.send && window.__revolution.units.count > 20);
await page.evaluate(
  ([x, z]) => {
    const fx = (n) => Math.round(n * 1024);
    const send = window.__revolution.send;
    send({ type: 48, team: 0, tier: 3, supplies: 5000, fuel: 5000, credits: 5000 });
    const spawn = (kind, count, dx, dz, radius) =>
      send({
        type: 3,
        count,
        team: 1,
        kind,
        wander: false,
        x: fx(x + dx),
        y: fx(z + dz),
        radius: fx(radius),
      });
    spawn(0, 4, 0, 0, 14); // tanks
    spawn(3, 2, 10, 8, 6); // carriers
    spawn(1, 10, -6, -4, 14); // rifle squads
    window.__revolution.look(x, z, 70, 0.6);
  },
  [X, Z],
);
await page.waitForTimeout(8000);
// On a tank, so the guided bomb has its mark.
const target = await page.evaluate(
  ([x, z]) => {
    const u = window.__revolution.units;
    let best = -1;
    let bd = 1e9;
    for (let i = 0; i < u.count; i++) {
      if (u.kind[i] !== 0) continue;
      const d = Math.hypot(u.curr[2 * i] - x, u.curr[2 * i + 1] - z);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best >= 0 ? [u.curr[2 * best], u.curr[2 * best + 1]] : [x, z];
  },
  [X, Z],
);
await page.evaluate(([x, z]) => {
  window.__revolution.send({ type: 47, team: 0, x: Math.round(x * 1024), y: Math.round(z * 1024) });
}, target);
console.log('called at', target);
const jetGap = async () =>
  page.evaluate(([x, z]) => {
    const u = window.__revolution.units;
    let best = 1e9;
    for (let i = 0; i < u.count; i++) {
      if (u.kind[i] !== 15) continue;
      best = Math.min(best, Math.hypot(u.curr[2 * i] - x, u.curr[2 * i + 1] - z));
    }
    return best;
  }, target);
const hide = () => page.addStyleTag({ content: '#paused{display:none!important}' });
await hide();
// 1: the jet coming in over the target.
let gap = 1e9;
for (let k = 0; k < 600; k++) {
  gap = await jetGap();
  if (gap < 40) break;
  await page.waitForTimeout(150);
}
await page.keyboard.press('Space');
console.log('paused, jet', gap.toFixed(0), 'm out');
const shot = async (name, look) => {
  await page.evaluate(([x, z, d]) => window.__revolution.look(x, z, d, 0.6), [...target, look]);
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${out}-${name}.png`, timeout: 600_000 });
  console.log('saved', name);
};
const run = async (ms) => {
  await page.keyboard.press('Space');
  await page.waitForTimeout(ms);
  await page.keyboard.press('Space');
};
await shot('1-inbound', 95);
// 2: the load on its way down.
await run(Number(process.env.FALL_MS ?? 3200));
await shot('2-falling', 85);
// 3: landing.
await run(Number(process.env.LAND_MS ?? 2000));
await shot('3-impact', 65);
// 4: what is left.
await run(9000);
await shot('4-after', 45);
await browser.close();
