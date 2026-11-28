// node shoot.mjs shots/name.mjs [--scout] [--w 1920 --h 1080] [--from s --to s] [--port 4173] [--tag x]
// Shoots one trailer shot in the real game, frame by frame (the game's ?capture=1 mode).
import { chromium } from 'playwright';
import fs from 'fs'; import path from 'path'; import { pathToFileURL } from 'url';
const argv = process.argv.slice(2); const file = argv[0]; const a = {};
for (let i = 1; i < argv.length; i++) if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[i+1] && !argv[i+1].startsWith('--') ? argv[++i] : true;
const shot = (await import(pathToFileURL(path.resolve(file)).href)).default;
const name = path.basename(file, '.mjs') + (a.cam ? '-' + a.cam : '') + (a.tag ? '-' + a.tag : '');
const scout = !!a.scout;
const W = +(a.w ?? (scout ? 768 : 1920)), H = +(a.h ?? (scout ? 432 : 1080));
const fps = shot.fps ?? 24;
const quality = a.quality ?? (scout ? 'normal' : 'high');
const URL = `http://127.0.0.1:${a.port ?? 4173}/?renderer=webgl&scale=fixed&fog=0&debug=1&control=all&ai=off&capture=1&seed=1&lod=4&quality=${quality}&${shot.params ?? ''}${(shot.params ?? '').includes('units=') ? '' : '&units=0'}`;
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-proxy-server','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.setDefaultTimeout(1800000);
page.on('console', m => { if (m.type()==='error') console.log('ERR', m.text().slice(0,300)); });
page.on('pageerror', e => console.log('PAGEERR', String(e).slice(0,300)));
await page.addInitScript(() => {
  const fx = n => Math.round(n*1024);
  const T = window.T = {
    fx,
    get g() { return window.__revolution; },
    send: c => window.__revolution.send(c),
    spawn: (team, kind, count, x, z, radius = 10, ax = 0, az = 0) => window.__revolution.send({ type: 3, count, team, kind, wander: false, x: fx(x), y: fx(z), radius: fx(radius), advanceX: fx(ax), advanceY: fx(az) }),
    alive: i => (window.__revolution.units.info[i] & 3) === 1,
    ids: (team, kinds, near) => { const u = window.__revolution.units, out = [];
      for (let i = 0; i < u.count; i++) { if (!T.alive(i)) continue; if (team != null && u.teamOf(i) !== team) continue; if (kinds && !kinds.includes(u.kind[i])) continue;
        if (near && Math.hypot(u.curr[2*i]-near[0], u.curr[2*i+1]-near[1]) > near[2]) continue; out.push(i); } return out; },
    pos: i => [window.__revolution.units.curr[2*i], window.__revolution.units.curr[2*i+1]],
    move: (ids, x, z, queue) => ids.length && T.send({ type: 1, units: ids, x: fx(x), y: fx(z), queue }),
    amove: (ids, x, z, queue) => ids.length && T.send({ type: 4, units: ids, x: fx(x), y: fx(z), queue }),
    hold: ids => ids.length && T.send({ type: 10, units: ids }),
    stop: ids => ids.length && T.send({ type: 2, units: ids }),
    hitStruct: (ids, s) => ids.length && T.send({ type: 6, units: ids, structure: s }),
    bombard: (ids, x, z, o = {}) => ids.length && T.send({ type: 9, units: ids, x: fx(x), y: fx(z), ...o }),
    garrison: (ids, s) => ids.length && T.send({ type: 5, units: ids, structure: s }),
    roof: (ids, s) => ids.length && T.send({ type: 49, units: ids, structure: s }),
    ambush: (ids, x, z, r) => ids.length && T.send({ type: 50, units: ids, x: fx(x), y: fx(z), radius: fx(r) }),
    grant: (team) => T.send({ type: 48, team, tier: 3, supplies: 9000, fuel: 9000, credits: 9000 }),
    strike: (team, x, z) => T.send({ type: 47, team, x: fx(x), y: fx(z) }),
    para: (team, x, z) => T.send({ type: 35, team, x: fx(x), y: fx(z) }),
    faction: (team, f) => T.send({ type: 39, team, faction: f }),
    struct: s => { const m = window.__revolution.map; return { s, x: m.sX[s]*4 + m.sW[s]*2, z: m.sY[s]*4 + m.sH[s]*2, w: m.sW[s]*4, d: m.sH[s]*4, floors: m.sFloors[s], cls: m.sClass[s], kind: m.sKind[s], town: m.sTown[s] }; },
    structs: (x, z, r) => { const m = window.__revolution.map, out = []; for (let s = 0; s < m.structCount; s++) { const b = T.struct(s); if (Math.hypot(b.x-x, b.z-z) < r) out.push(b); } return out; },
    towns: () => { const m = window.__revolution.map, out = []; for (let t = 0; t < m.townCount; t++) out.push({ t, name: m.townName[t], x: m.townX[t]/1024, z: m.townY[t]/1024, r: m.townR[t]/1024 }); return out; },
    h: (x, z) => window.__revolution.heightAt(x, z),
    info: () => { const u = window.__revolution.units; const by = {}; let fx_=0, fz=0, fn=0, now = performance.now()/1000;
      for (let i = 0; i < u.count; i++) { if (!T.alive(i)) continue; const k = u.teamOf(i)+':'+u.kind[i]; by[k] = (by[k]||0)+1; }
      return { count: u.count, by, flares: u.flares.length }; },
    centroid: (team, kinds, near) => { const ids = T.ids(team, kinds, near); let x=0,z=0; for (const i of ids) { x += T.pos(i)[0]; z += T.pos(i)[1]; } return ids.length ? [x/ids.length, z/ids.length, ids.length] : null; },
  };
});
const t0 = Date.now();
await page.goto(URL);
await page.waitForFunction(() => window.__revolution?.step);
await page.addStyleTag({ content: (shot.hud || a.cam === 'hud') ? '#perf,#paused,#loading,#alerts,#alert-arrows,#missions,#towns,#banner,#prompt{display:none!important}' : '#left,#right,#bottom,#alerts,#minimap,#alert-arrows,.panel,.pill,#paused,#missions,#perf,#banner,#prompt,#status,#selection,#groups{display:none!important}' });
const run = (fn, arg) => page.evaluate(fn, arg);
await run(() => { const u = window.__revolution.units; u.lodFull = 320; u.nearBudget = 6000; u.midBudget = 6000; });
if (shot.setup) await run(shot.setup, shot.args);
const events = [...(shot.events ?? [])].sort((x, y) => x.at - y.at);
let sim = 0, ev = 0;
const state = {};
const fire = async () => { while (ev < events.length && events[ev].at <= sim + 1e-6) { const r = await run(events[ev].run, shot.args); if (events[ev].as) state[events[ev].as] = r; if (r !== undefined) console.log('event', events[ev].at, JSON.stringify(r)?.slice(0, 400)); ev++; } };
const cams = shot.cams ?? { main: shot.cam }; const camName = a.cam ?? Object.keys(cams)[0]; const camFn = cams[camName];
const camAt = async (t) => { if (shot.track) state.track = await run(shot.track, shot.args); const c = camFn(t, state); return { fov: 34, lod: 40, roll: 0, ...c }; };
const advance = async (seconds, draw) => { await run(([ms, d]) => window.__revolution.step(ms, d), [seconds*1000, draw]); sim += seconds; };
const warm = +(a.warm ?? shot.warm ?? 0), dur = +(a.dur ?? shot.dur ?? 5), rate = +(a.rate ?? shot.rate ?? 1);

const outDir = path.resolve('out', name + (scout ? '-scout' : `-${W}x${H}`)); fs.mkdirSync(outDir, { recursive: true });
if (!a.resume) { fs.rmSync(outDir, { recursive: true, force: true }); } fs.mkdirSync(outDir, { recursive: true });
const have = a.resume ? fs.readdirSync(outDir).filter(f => f.endsWith('.jpg')).length : 0;
const from = a.resume ? Math.max(0, have - 1) / fps : +(a.from ?? 0), to = +(a.to ?? dur);
if (a.resume && have >= Math.round(to * fps)) { console.log(name, 'done already'); await browser.close(); process.exit(0); }
// run ahead to the start of the shot (plus --from), undrawn, a tick at a time
const setCam = async (c) => run(c => { const g = window.__revolution; if (c.game) { g.film.cine = null; g.camera.fov = 40; g.camera.up.set(0, 1, 0); g.camera.updateProjectionMatrix(); g.look(...c.game); } else g.film.cine = c; }, c);
await setCam(await camAt(0));
const ahead = warm + from * rate;
while (sim < ahead - 1e-6) { await fire(); await advance(Math.min(0.05, ahead - sim), false); }
console.log(name, 'warm done', ((Date.now()-t0)/1000).toFixed(0)+'s', JSON.stringify(await run(() => window.T.info())));
const n0 = Math.round(from*fps), n1 = Math.round(to*fps);
const stepF = scout ? Math.max(1, Math.round(fps * (+(a.every ?? 1)))) : 1;
for (let f = n0; f < n1; f += stepF) {
  const t = f / fps;
  await fire();
  await setCam(await camAt(t));
  if (scout && stepF > 1 && f > n0) { // run undrawn up to this frame
    const target = warm + t * rate; while (sim < target - 0.05) { await fire(); await advance(0.05, false); }
    await advance(Math.max(target - sim, 0.001), true);
  } else await advance(rate / fps, true);
  await page.screenshot({ path: path.join(outDir, `f${String(f).padStart(5,'0')}.jpg`), type: 'jpeg', quality: scout ? 85 : 97 });
  if (shot.log) console.log('t', t.toFixed(2), JSON.stringify(await run(shot.log, shot.args)));
  if ((f - n0) % (24 * stepF) === 0) console.log(name, 'frame', f, '/', n1, ((Date.now()-t0)/1000).toFixed(0)+'s');
}
console.log(name, 'done', ((Date.now()-t0)/1000).toFixed(0)+'s', outDir);
await browser.close();
