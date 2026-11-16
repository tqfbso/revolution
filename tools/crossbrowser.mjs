// The sim must give the same game in every JavaScript engine: lockstep co-op between a
// Mac on Safari and a PC on Firefox depends on it. This plays the golden games
// (tools/golden.ts) in Node, Chromium, Firefox and WebKit and fails if any hash differs.
//   npx playwright install chromium firefox webkit   (once)
//   node tools/crossbrowser.mjs [chromium firefox webkit]
/* global process, performance, console */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { chromium, firefox, webkit } from 'playwright';

const engines = { chromium, firefox, webkit };
const wanted = process.argv.slice(2).length > 0 ? process.argv.slice(2) : Object.keys(engines);
const out = join(mkdtempSync(join(tmpdir(), 'golden-')), 'golden.js');
execFileSync(
  'npx',
  ['rolldown', 'tools/golden-entry.ts', '--format', 'iife', '--platform', 'browser', '-o', out],
  { stdio: 'inherit' },
);
const code = readFileSync(out, 'utf8');

const context = { performance, console };
vm.createContext(context);
vm.runInContext(code, context);
let t = Date.now();
const expected = context.crossCheck();
console.log(`node      ${expected.join(' ')} (${((Date.now() - t) / 1000).toFixed(0)} s)`);

let failed = false;
for (const name of wanted) {
  const browser = await engines[name].launch();
  const page = await browser.newPage();
  await page.setContent('<!doctype html><title>golden</title>');
  await page.addScriptTag({ content: code });
  t = Date.now();
  const got = await page.evaluate(() => globalThis.crossCheck());
  await browser.close();
  const same = got.join() === expected.join();
  if (!same) failed = true;
  console.log(
    `${name.padEnd(9)} ${got.join(' ')} (${((Date.now() - t) / 1000).toFixed(0)} s) ${same ? 'same' : 'DIFFERENT'}`,
  );
}
process.exit(failed ? 1 : 0);
