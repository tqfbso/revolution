import * as THREE from 'three/webgpu';
import { CMD_SPAWN, type Command } from './sim/commands';
import { fx } from './sim/fixed';
import { MAP_SIZE, MAX_UNITS } from './sim/world';
import { RtsCamera } from './client/camera';
import { Hud } from './client/hud';
import { Input } from './client/input';
import { Terrain } from './client/terrain';
import { Effects } from './client/effects';
import { UnitView } from './client/units';
import type { Scenario, Snapshot, ToWorker } from './worker/protocol';
import { KIND_INFANTRY, KIND_TANK } from './sim/units';

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
  const scenario: Scenario = params.get('scenario') === 'roam' ? 'roam' : 'battle';

  const { renderer, canvas, backend } = await createRenderer(params.get('renderer') === 'webgl');
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

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

  const terrain = new Terrain();
  terrain.mesh.receiveShadow = shadows;
  const effects = new Effects();
  const units = new UnitView(terrain, effects, shadows);
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
    units.applySnapshot(e.data, performance.now());
    hud.simTick(e.data.simMs);
    hud.stats.alive = e.data.alive;
    if (e.data.hash !== undefined) hud.stats.hash = e.data.hash.toString(16).padStart(8, '0');
  };
  post({ type: 'init', seed, units: unitCount, scenario });

  const input = new Input(canvas, rts.camera, terrain, units, send);
  scene.add(terrain.mesh, units.group, effects.group, input.marker);

  // Reinforcements: 250 tanks and 250 infantry squads per side, attacking toward the centre.
  document.getElementById('add-units')?.addEventListener('click', () => {
    for (let team = 0; team < 2; team++) {
      const dir = team === 0 ? -1 : 1;
      for (const kind of [KIND_TANK, KIND_INFANTRY]) {
        send({
          type: CMD_SPAWN,
          count: 250,
          team,
          kind,
          x: fx(MAP_SIZE / 2 + dir * (kind === KIND_TANK ? 150 : 175)),
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
    effects.update(dt, rts.camera);
    input.update(dt);
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
  });

  // Read by automated performance checks.
  (window as unknown as { __revolution: unknown }).__revolution = {
    stats: hud.stats,
    units,
    look: (x: number, z: number, dist: number, yaw?: number) => rts.look(x, z, dist, yaw),
  };
  document.getElementById('loading')?.remove();
}

start().catch((err) => {
  console.error(err);
  const el = document.getElementById('loading');
  if (el) el.textContent = `Could not start: ${err instanceof Error ? err.message : String(err)}`;
});
