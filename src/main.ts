import * as THREE from 'three/webgpu';
import { CMD_SPAWN, type Command } from './sim/commands';
import { fx } from './sim/fixed';
import { generateMap } from './sim/map';
import { MAP_SIZE, MAX_UNITS } from './sim/world';
import { RtsCamera } from './client/camera';
import { Hud } from './client/hud';
import { Input } from './client/input';
import { Terrain } from './client/terrain';
import { Effects } from './client/effects';
import { Fog } from './client/fog';
import { Minimap } from './client/minimap';
import { Scars } from './client/scars';
import { StructureView } from './client/structures';
import { UnitView } from './client/units';
import type { Scenario, Snapshot, ToWorker } from './worker/protocol';
import { KINDS, KIND_ARTILLERY, KIND_ATGM, KIND_IFV, KIND_INFANTRY, KIND_TANK } from './sim/units';

const SKY = 0x9db4c4;

/**
 * WebGPU where available, WebGL2 otherwise (Three.js picks). If WebGPU is advertised but
 * fails to start (flaky drivers), retry on a fresh canvas with WebGL2 forced.
 */
async function createRenderer(forceWebGL: boolean) {
  let canvas = document.getElementById('game') as HTMLCanvasElement;
  let renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL });
  try {
    await renderer.init();
  } catch (err) {
    if (forceWebGL) throw err;
    console.warn('WebGPU failed to start, falling back to WebGL2', err);
    const fresh = canvas.cloneNode(false) as HTMLCanvasElement;
    canvas.replaceWith(fresh);
    canvas = fresh;
    renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL: true });
    await renderer.init();
  }
  const isWebGPU = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
  return { renderer, canvas, backend: isWebGPU ? 'WebGPU' : 'WebGL2' };
}

async function start(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const unitCount = Math.min(Math.max(Number(params.get('units') ?? 3000) | 0, 0), MAX_UNITS);
  const seed = Number(params.get('seed') ?? 1) | 0;
  const wanted = params.get('scenario');
  const scenario: Scenario = wanted === 'roam' || wanted === 'clash' ? wanted : 'assault';

  const { renderer, canvas, backend } = await createRenderer(params.get('renderer') === 'webgl');
  // Render scale adapts to load: if frames run slow for a couple of seconds the resolution
  // steps down, and it steps back up after a long smooth stretch. `?scale=fixed` pins it.
  const maxRatio = Math.min(window.devicePixelRatio, 2);
  const minRatio = Math.max(0.75, maxRatio / 2);
  const adaptScale = params.get('scale') !== 'fixed' && maxRatio > minRatio;
  let ratio = maxRatio;
  let slowSeconds = 0;
  let smoothSeconds = 0;
  let windowMs = 0;
  let windowFrames = 0;
  renderer.setPixelRatio(ratio);

  const shadows = params.get('shadows') !== '0';
  const lodScale = Math.min(Math.max(Number(params.get('lod') ?? 1) || 1, 0.25), 4);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = shadows;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(SKY, 500, 2200);
  // Overcast-bright sky light plus a low, warm sun: long readable shadows, muted colours.
  scene.add(new THREE.HemisphereLight(0xcfdbe6, 0x4d4636, 1.25));
  const sun = new THREE.DirectionalLight(0xffe8c4, 3.4);
  const sunDir = new THREE.Vector3(-0.55, 0.62, 0.42).normalize();
  sun.castShadow = shadows;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  scene.add(sun, sun.target);

  // The same generator the sim worker runs: both derive the map from the seed.
  // You command the red army (team 0) and see what it sees. `?fog=0` lifts the fog,
  // `?control=all` lets you select and order every army.
  const fog = new Fog(params.get('fog') !== '0');
  const map = generateMap(seed);
  fog.setMap(map);
  const terrain = new Terrain(map, fog, shadows);
  const effects = new Effects();
  const structures = new StructureView(map, terrain, fog, effects, shadows);
  const scars = new Scars(fog, terrain);
  const units = new UnitView(terrain, effects, fog, shadows, structures, scars);
  units.lodNear *= lodScale;
  units.lodFar *= lodScale;
  const rts = new RtsCamera(canvas, terrain);
  const hud = new Hud();
  hud.stats.backend = backend + (shadows ? '' : ' (no shadows)');

  const worker = new Worker(new URL('./worker/sim.worker.ts', import.meta.url), {
    type: 'module',
  });
  const post = (msg: ToWorker) => worker.postMessage(msg);
  const send = (command: Command) => post({ type: 'command', command });
  worker.onmessage = (e: MessageEvent<Snapshot>) => {
    structures.applySnapshot(e.data, performance.now() / 1000);
    units.applySnapshot(e.data, performance.now());
    hud.simTick(e.data.simMs);
    hud.stats.alive = e.data.alive;
    if (e.data.hash !== undefined) hud.stats.hash = e.data.hash.toString(16).padStart(8, '0');
  };
  post({ type: 'init', seed, units: unitCount, scenario });

  const lookAt = (x: number, z: number) => rts.moveTo(x, z);
  const input = new Input(canvas, rts.camera, terrain, units, send, lookAt, structures);
  input.controlAll = params.get('control') === 'all';
  const minimap = new Minimap(
    document.getElementById('minimap') as HTMLCanvasElement,
    terrain.map,
    fog,
    units,
    rts.camera,
    lookAt,
    (x, z, attack) => input.orderTo(x, z, attack),
    structures,
    map,
  );
  scene.add(
    terrain.mesh,
    terrain.water,
    terrain.trees,
    structures.group,
    scars.mesh,
    units.group,
    effects.group,
    input.marker,
  );
  // Towns: who holds what, and what the held ones have paid so far.
  const townsEl = document.getElementById('towns');
  const TEAM_NAME = ['red', 'blue', 'gold'];
  const TEAM_CSS = ['#eb4637', '#468cff', '#f0be3c'];
  setInterval(() => {
    if (!townsEl) return;
    let html = `<b>Credits ${structures.credits[0] ?? 0}</b> (blue ${structures.credits[1] ?? 0})`;
    for (let t = 0; t < map.townCount; t++) {
      const owner = structures.townOwner[t];
      const taking = structures.townCapturer[t];
      const colour = TEAM_CSS[owner] ?? '#b9c4cf';
      html += `<br /><span style="color:${colour}">■</span> ${map.townName[t]}`;
      if (TEAM_NAME[taking] !== undefined) {
        html += ` <span style="color:${TEAM_CSS[taking]}">${TEAM_NAME[taking]} taking ${structures.townProgress[t]}%</span>`;
      }
    }
    townsEl.innerHTML = html;
  }, 500);
  // What is selected, by type: with ten kinds of unit a box of rings is not enough.
  const selectionEl = document.getElementById('selection');
  setInterval(() => {
    if (!selectionEl) return;
    const n = new Array<number>(KINDS.length).fill(0);
    let aboard = 0;
    for (const id of units.selectedIds()) {
      n[units.kindOf(id)]++;
      aboard += units.load[id];
    }
    const parts = KINDS.map((k, i) => (n[i] > 0 ? `${n[i]} ${k.name.toLowerCase()}` : '')).filter(
      (p) => p !== '',
    );
    if (aboard > 0) parts.push(`${aboard} squads aboard`);
    selectionEl.style.display = parts.length > 0 ? 'block' : 'none';
    selectionEl.textContent = parts.join(' · ');
  }, 250);

  // Reinforcements: a combined-arms battlegroup of 500 per side, attacking toward the centre.
  document.getElementById('add-units')?.addEventListener('click', () => {
    for (let team = 0; team < 2; team++) {
      const dir = team === 0 ? -1 : 1;
      const mix: [number, number, number][] = [
        [KIND_TANK, 190, 150],
        [KIND_IFV, 80, 165],
        [KIND_INFANTRY, 150, 180],
        [KIND_ATGM, 55, 190],
        [KIND_ARTILLERY, 25, 230],
      ];
      for (const [kind, count, back] of mix) {
        send({
          type: CMD_SPAWN,
          count,
          team,
          kind,
          x: fx(MAP_SIZE / 2 + dir * back),
          y: fx(MAP_SIZE / 2),
          radius: fx(70),
          wander: scenario === 'roam',
          advanceX: scenario === 'roam' ? undefined : fx(-dir * 150),
          advanceY: scenario === 'roam' ? undefined : 0,
        });
      }
    }
  });
  document.getElementById('reset')?.addEventListener('click', () => {
    post({ type: 'init', seed, units: unitCount, scenario });
  });

  const resize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    rts.resize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', resize);
  resize();

  let last = performance.now();
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dtMs = now - last;
    last = now;
    const dt = Math.min(dtMs / 1000, 0.1);
    rts.update(dt);
    units.update(now, dt, rts.camera);
    structures.update(now / 1000, dt);
    effects.update(dt, rts.camera);
    input.update(dt);
    minimap.update(now);
    // The shadow map follows the point the camera looks at and covers only what is close
    // enough to show shadow detail; far units are drawn without shadows.
    const focus = rts.focus;
    const extent = Math.min(Math.max(rts.distance * 0.75, 45), 260);
    const sc = sun.shadow.camera;
    if (sc.right !== extent) {
      sc.left = sc.bottom = -extent;
      sc.right = sc.top = extent;
      sc.near = 1;
      sc.far = 900;
      sc.updateProjectionMatrix();
    }
    sun.target.position.copy(focus);
    sun.position.copy(focus).addScaledVector(sunDir, 400);
    renderer.render(scene, rts.camera);
    hud.stats.units = units.count;
    hud.stats.selected = units.selectedCount;
    hud.stats.drawCalls = renderer.info.render.drawCalls;
    hud.stats.triangles = renderer.info.render.triangles;
    hud.stats.lod = units.stats.lod;
    hud.stats.culled = units.stats.culled;
    hud.stats.particles = effects.count;
    hud.frame(dtMs);
    windowMs += dtMs;
    windowFrames++;
    if (adaptScale && windowMs >= 1000) {
      const avg = windowMs / windowFrames;
      windowMs = windowFrames = 0;
      slowSeconds = avg > 19.5 ? slowSeconds + 1 : 0;
      smoothSeconds = avg < 17.5 ? smoothSeconds + 1 : 0;
      let next = ratio;
      if (slowSeconds >= 2) next = Math.max(minRatio, ratio - 0.25);
      else if (smoothSeconds >= 12) next = Math.min(maxRatio, ratio + 0.25);
      if (next !== ratio) {
        ratio = next;
        slowSeconds = smoothSeconds = 0;
        renderer.setPixelRatio(ratio);
        hud.stats.scale = ratio / maxRatio;
      }
    }
  });

  // Read by automated performance checks.
  (window as unknown as { __revolution: unknown }).__revolution = {
    stats: hud.stats,
    units,
    structures,
    map,
    send,
    look: (x: number, z: number, dist: number, yaw?: number) => rts.look(x, z, dist, yaw),
  };
  document.getElementById('loading')?.remove();
}

start().catch((err) => {
  console.error(err);
  const el = document.getElementById('loading');
  if (el) el.textContent = `Could not start: ${err instanceof Error ? err.message : String(err)}`;
});
