// Takes a picture of the model bench (tools/modelview.html). Needs `npx vite --port 5173`.
//   node tools/modelview.mjs out.png "factions=1,2,3&kinds=0&dist=12" [width height]
/* global process, window, console */
import { chromium } from 'playwright';

const [out = 'models.png', query = '', w = '1600', h = '900'] = process.argv.slice(2);
const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-proxy-server',
  ],
});
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
page.setDefaultTimeout(300_000);
page.on('console', (m) => m.type() === 'error' && console.log('page:', m.text()));
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto(`http://127.0.0.1:5173/tools/modelview.html?renderer=webgl&${query}`);
await page.waitForFunction(() => window.ready);
console.log(JSON.stringify(await page.evaluate(() => window.ready)));
await page.screenshot({ path: out, timeout: 300_000 });
await browser.close();
