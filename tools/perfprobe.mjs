// What a big army costs to draw: 3,000 units of a set mix on open ground, looked at from
// three heights. Prints triangles, draw calls, the unit view's CPU time per frame and the
// frame time (software rendering, so only good for comparing two builds on one machine).
//
//   npm run build && npx vite preview --port 4173 --host 127.0.0.1
//   node tools/perfprobe.mjs [label]        env: PORT, WANDER=1, ARMY, DISTS=25,80,250
/* global process, window, console, performance, requestAnimationFrame */
import { chromium } from 'playwright';

const label = process.argv[2] ?? 'build';
const army = process.env.ARMY ?? 'nato';
const wander = process.env.WANDER === '1';
const URL =
  `http://127.0.0.1:${process.env.PORT ?? 4173}/` +
  '?renderer=webgl&scale=fixed&fog=0&debug=1&control=all&ai=off' +
  `&quality=normal&shadows=${process.env.SHADOWS ?? '1'}&units=0&army=${army}&foe=russia&map=ridge`;
// kind, count: a late-game army by the army mix pillar (mostly men, few tanks).
const MIX = [
  [1, 1800],
  [2, 300],
  [16, 120],
  [11, 60],
  [0, 150],
  [3, 220],
  [4, 50],
  [8, 50],
  [9, 20],
  [10, 60],
  [5, 50],
  [6, 40],
  [7, 40],
  [12, 30],
  [13, 10],
];
const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-proxy-server',
  ],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.setDefaultTimeout(1_800_000);
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.addInitScript(
  ([lod, top]) => {
    window.__lod = lod;
    window.__top = top;
  },
  [process.env.LOD ? JSON.parse(process.env.LOD) : null, Number(process.env.TOP ?? 0)],
);
await page.goto(URL);
await page.waitForFunction(() => window.__revolution?.send && window.__revolution.units.count > 5);
await page.evaluate(
  ([mix, wander]) => {
    const fx = (n) => Math.round(n * 1024);
    mix.forEach(([kind, count], k) => {
      window.__revolution.send({
        type: 3,
        count,
        team: 0,
        kind,
        wander,
        x: fx(500 + ((k % 4) - 1.5) * 30),
        y: fx(500 + (Math.floor(k / 4) - 1.5) * 30),
        radius: fx(70),
      });
    });
    window.__revolution.look(500, 500, 80, 0.5);
  },
  [MIX, wander],
);
await page.waitForFunction(() => window.__revolution.units.count > 2900);
await page.waitForTimeout(Number(process.env.WAIT ?? 20000));
const out = [];
for (const dist of (process.env.DISTS ?? '25,80,250').split(',').map(Number)) {
  const r = await page.evaluate(async (dist) => {
    const R = window.__revolution;
    R.look(500, 500, dist, 0.5);
    const frames = (n) =>
      new Promise((done) => {
        const step = () => (--n <= 0 ? done() : requestAnimationFrame(step));
        requestAnimationFrame(step);
      });
    await frames(3);
    if (window.__lod) Object.assign(R.units, window.__lod);
    const tri = (g) => (g.index ? g.index.count : g.attributes.position.count) / 3;
    const N = 12;
    R.stats.cpuUnits = 0;
    R.stats.cpuDraw = 0;
    // The shadow map is not redrawn every frame, so a frame's count comes in two sizes.
    let tris = [1e12, 0],
      draws = [1e12, 0];
    const t0 = performance.now();
    for (let f = 0; f < N; f++) {
      await frames(1);
      tris = [Math.min(tris[0], R.stats.triangles), Math.max(tris[1], R.stats.triangles)];
      draws = [Math.min(draws[0], R.stats.drawCalls), Math.max(draws[1], R.stats.drawCalls)];
    }
    const ms = (performance.now() - t0) / N;
    const k = 1 - Math.pow(0.95, N);
    return {
      dist,
      units: R.units.count,
      tris,
      draws,
      cpuUnits: +(R.stats.cpuUnits / k).toFixed(2),
      cpuDraw: +(R.stats.cpuDraw / k).toFixed(1),
      frameMs: +ms.toFixed(0),
      lod: [...R.stats.lod],
      still: R.stats.still,
      culled: R.stats.culled,
      // What the unit view itself put on screen, and its heaviest batches (triangles, instances).
      unitTris: R.units.batches.reduce((a, b) => a + tri(b.mesh.geometry) * b.mesh.count, 0),
      top: R.units.batches
        .map((b) => [
          tri(b.mesh.geometry) * b.mesh.count,
          tri(b.mesh.geometry),
          b.mesh.count,
          +b.mesh.castShadow,
        ])
        .filter((b) => b[0] > 0)
        .sort((a, b) => b[0] - a[0])
        .slice(0, Number(window.__top ?? 0)),
    };
  }, dist);
  out.push(r);
  console.log(label, JSON.stringify(r));
  if (process.env.SHOT) await page.screenshot({ path: `${process.env.SHOT}-${dist}.png` });
}
await browser.close();
