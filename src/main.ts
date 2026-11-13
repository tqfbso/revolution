import * as THREE from 'three/webgpu';
import { pass } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { CMD_ASSIGN, CMD_SPAWN, type Command } from './sim/commands';
import { fx } from './sim/fixed';
import { generateMap, type Layout } from './sim/map';
import { MAP_SIZE, MAX_UNITS, M_NONE } from './sim/world';
import { ALERT_NOTE, Alerts } from './client/alerts';
import { Cameras } from './client/cameras';
import { RtsCamera } from './client/camera';
import { CommandCard } from './client/card';
import { Hud } from './client/hud';
import { Input } from './client/input';
import { Terrain } from './client/terrain';
import { makeLook, readQuality, skyScene } from './client/look';
import { Clutter } from './client/clutter';
import { Effects } from './client/effects';
import { Fog } from './client/fog';
import { Minimap } from './client/minimap';
import { ProductionCentre } from './client/production';
import { COMMANDER_NAMES, MissionBoard } from './client/missions';
import { Scars } from './client/scars';
import { Sound } from './client/sound';
import { StructureView } from './client/structures';
import { SupplyView } from './client/supply';
import { WorksView } from './client/works';
import { UnitView } from './client/units';
import { TASK_HUNGRY, type Scenario, type Snapshot, type ToWorker } from './worker/protocol';
import {
  KINDS,
  TOWN_INCOME,
  KIND_AD,
  KIND_ARTILLERY,
  KIND_ATGM,
  KIND_DRONE,
  KIND_EW,
  KIND_IFV,
  KIND_INFANTRY,
  KIND_RECON,
  KIND_STRIKE,
  KIND_TANK,
} from './sim/units';

/** The haze at the horizon: what distance fades into. */
const SKY = 0xa9b6bd;

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
  const scenario: Scenario =
    wanted === 'roam' || wanted === 'clash' || wanted === 'assault' ? wanted : 'skirmish';

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

  const quality = readQuality(params);
  const shadows = params.get('shadows') !== '0';
  const lodScale = Math.min(Math.max(Number(params.get('lod') ?? 1) || 1, 0.25), 4);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = shadows;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(SKY, 500, 2200);
  // Overcast-bright sky light plus a low, warm sun: long readable shadows, muted colours.
  // With reflections on, most of the sky's light comes from the environment map instead.
  scene.add(new THREE.HemisphereLight(0xcfdbe6, 0x4d4636, quality === 'low' ? 1.25 : 0.78));
  const sun = new THREE.DirectionalLight(0xffe6c0, quality === 'low' ? 3.4 : 4.3);
  const sunDir = new THREE.Vector3(-0.55, 0.62, 0.42).normalize();
  sun.castShadow = shadows;
  const shadowSize = quality === 'high' ? 4096 : quality === 'low' ? 1024 : 2048;
  sun.shadow.mapSize.set(shadowSize, shadowSize);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  scene.add(sun, sun.target);

  // The same generator the sim worker runs: both derive the map from the seed.
  // You command the red army (team 0) and see what it sees. `?fog=0` lifts the fog,
  // `?control=all` lets you select and order every army.
  const look = makeLook(quality, shadows);
  const fog = new Fog(params.get('fog') !== '0');
  if (look.rich) {
    fog.clouds = look.tex.noise;
    // What shiny things reflect, and the light that comes from the whole sky.
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(skyScene(sunDir), 0.02).texture;
    scene.environmentIntensity = 0.45;
    pmrem.dispose();
  }
  // The skirmish is fought in the city unless `?map=ridge` or `?map=river` asks for an
  // older map; the other scenarios are laid out for the river.
  const asked = params.get('map');
  const layout: Layout =
    scenario !== 'skirmish' || asked === 'river' ? 'river' : asked === 'ridge' ? 'ridge' : 'city';
  const map = generateMap(seed, layout);
  fog.setMap(map);
  const terrain = new Terrain(map, fog, look);
  const effects = new Effects(look, fog.cloud());
  const structures = new StructureView(map, terrain, fog, effects, look);
  const works = new WorksView(map, terrain, fog, effects, look);
  const scars = new Scars(fog, terrain, look);
  const clutter = new Clutter(terrain, fog, look);
  structures.clutter = clutter;
  works.clutter = clutter;
  const units = new UnitView(terrain, effects, fog, look, structures, scars);
  const cameras = new Cameras(
    terrain,
    fog,
    () => alerts,
    () => units.playerTeam,
  );
  const supply = new SupplyView(map, units);
  const sound = new Sound();
  units.sound = sound;
  units.lodNear *= lodScale;
  units.lodFar *= lodScale;
  const rts = new RtsCamera(canvas, terrain);
  const hud = new Hud();
  hud.stats.backend = `${backend}, ${quality} detail${shadows ? '' : ', no shadows'}`;

  const worker = new Worker(new URL('./worker/sim.worker.ts', import.meta.url), {
    type: 'module',
  });
  const post = (msg: ToWorker) => worker.postMessage(msg);
  // Pause (Space): the sim stands still; orders wait and all start when play resumes.
  let paused = false;
  let queued = 0;
  const pausedEl = document.getElementById('paused');
  const pauseBtn = document.getElementById('pause');
  const showPause = () => {
    if (pausedEl) {
      pausedEl.style.display = paused ? 'block' : 'none';
      pausedEl.innerHTML = `PAUSED<small>${queued === 0 ? 'give orders, they start when you resume' : `${queued} order${queued === 1 ? '' : 's'} waiting`} · Space to resume</small>`;
    }
    if (pauseBtn) pauseBtn.textContent = paused ? 'Resume (Space)' : 'Pause (Space)';
  };
  const setPaused = (p: boolean) => {
    paused = p;
    if (!p) queued = 0;
    post({ type: 'pause', paused });
    showPause();
  };
  const send = (command: Command) => {
    // An order the player gives a unit himself takes it out of its commander's hands
    // (or the staff would countermand it a second later).
    if ('units' in command && command.type !== CMD_ASSIGN) {
      const taken = command.units.filter((id) => units.cmdr[id] >= 0 && units.isMine(id));
      if (taken.length > 0)
        post({ type: 'command', command: { type: CMD_ASSIGN, units: taken, slot: -1 } });
    }
    post({ type: 'command', command });
    if (paused) {
      queued++;
      showPause();
    }
  };
  worker.onmessage = (e: MessageEvent<Snapshot>) => {
    structures.applySnapshot(e.data, performance.now() / 1000);
    works.applySnapshot(e.data);
    cameras.applySnapshot(e.data, performance.now() / 1000);
    units.applySnapshot(e.data, performance.now());
    card.applySnapshot(e.data);
    production.applySnapshot(e.data);
    board.applySnapshot(e.data);
    supply.applySnapshot(e.data);
    alerts?.applySnapshot(e.data, performance.now() / 1000);
    hud.simTick(e.data.simMs);
    hud.stats.alive = e.data.alive;
    if (e.data.hash !== undefined) hud.stats.hash = e.data.hash.toString(16).padStart(8, '0');
  };
  const lookAt = (x: number, z: number) => rts.moveTo(x, z);
  let alerts: Alerts | null = null;
  const card = new CommandCard(
    document.getElementById('card') as HTMLElement,
    document.getElementById('resources') as HTMLElement,
    document.getElementById('banner') as HTMLElement,
    map,
    terrain,
    units,
    structures,
    send,
    lookAt,
    works,
  );
  const production = new ProductionCentre(
    document.getElementById('production') as HTMLElement,
    map,
    units,
    send,
  );
  const productionBtn = document.getElementById('production-toggle');
  productionBtn?.addEventListener('click', () => {
    production.toggle();
    productionBtn.blur();
  });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyP' && !e.ctrlKey && !e.metaKey) production.toggle();
    else if (e.code === 'Escape' && production.open) production.toggle(false);
  });
  card.hungry = () => supply.hungry;
  const input = new Input(
    canvas,
    rts.camera,
    terrain,
    units,
    send,
    lookAt,
    structures,
    card,
    works,
  );
  input.say = (text, x, z) => alerts?.report(ALERT_NOTE, x, z, text, performance.now() / 1000);
  // The mission board: sub-commanders, their missions and how they are getting on.
  const promptEl = document.getElementById('prompt');
  input.prompt = (text) => {
    if (!promptEl) return;
    promptEl.style.display = text === null ? 'none' : 'block';
    promptEl.textContent = text ?? '';
  };
  const board = new MissionBoard(
    document.getElementById('missions') as HTMLElement,
    map,
    units,
    send,
    {
      lookAt,
      ask: (text, done) => input.ask(text, done),
      alert: (text, x, z) => alerts?.report(ALERT_NOTE, x, z, text, performance.now() / 1000),
    },
  );
  production.postings = () => board.postings();
  const boardBtn = document.getElementById('missions-toggle');
  boardBtn?.addEventListener('click', () => {
    board.toggle();
    boardBtn.blur();
  });
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'KeyM') board.toggle();
    else if (e.code === 'KeyN') board.newFromSelection();
  });
  // `?ai=recruit|easy|normal|hard|off` picks the opponent of the skirmish. Easy is the
  // default: the first playtest found normal hard to beat.
  const level = params.get('ai');
  const ai =
    level === 'recruit' || level === 'normal' || level === 'hard' || level === 'off'
      ? level
      : 'easy';
  const demo = params.get('demo') === '1';
  // Game speed: `?speed=N` for testing, or the 0.75x / 1x choice on screen (remembered).
  let saved: string | null = null;
  try {
    saved = localStorage.getItem('revolution.speed');
  } catch {
    // storage may be blocked; the default is fine
  }
  const speed = Number(params.get('speed') ?? saved ?? 1) || 1;
  post({ type: 'init', seed, layout, units: unitCount, scenario, ai, demo, speed });
  const speedEl = document.getElementById('game-speed') as HTMLSelectElement | null;
  if (speedEl) {
    if (speed === 0.75 || speed === 1) speedEl.value = String(speed);
    speedEl.addEventListener('change', () => {
      post({ type: 'speed', speed: Number(speedEl.value) });
      try {
        localStorage.setItem('revolution.speed', speedEl.value);
      } catch {
        // not remembered; still applied
      }
      speedEl.blur();
    });
  }
  pauseBtn?.addEventListener('click', () => {
    setPaused(!paused);
    pauseBtn.blur();
  });
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat) return;
    e.preventDefault();
    setPaused(!paused);
  });
  // The skirmish opens on your headquarters.
  if (scenario === 'skirmish' && map.startX[0] >= 0) {
    rts.look(map.startX[0] * 4 + 14, map.startY[0] * 4 + 10, 95);
  }
  input.controlAll = params.get('control') === 'all';
  structures.revealAll = input.controlAll || demo;
  works.revealAll = input.controlAll || demo || params.get('fog') === '0';
  // The opponent is chosen on screen; a new choice starts a new game.
  const pickAi = document.getElementById('ai-level') as HTMLSelectElement | null;
  if (pickAi) {
    pickAi.value = ai;
    pickAi.addEventListener('change', () => {
      params.set('ai', pickAi.value);
      location.search = params.toString();
    });
  }
  const pickMap = document.getElementById('map-pick') as HTMLSelectElement | null;
  if (pickMap) {
    pickMap.value = layout;
    pickMap.addEventListener('change', () => {
      params.set('map', pickMap.value);
      location.search = params.toString();
    });
  }
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
    works,
    supply,
  );
  minimap.pick = (x, z) => input.pickAt(x, z);
  minimap.commanders = () =>
    board.info
      .filter((c) => c.count > 0)
      .map((c) => ({ name: c.name, cx: c.cx, cz: c.cz, x: c.x, z: c.z, on: c.mission !== M_NONE }));
  // Where a ground point is on screen, for the alerts' edge arrows.
  const probe = new THREE.Vector3();
  alerts = new Alerts(
    map,
    units,
    structures,
    fog,
    minimap,
    sound,
    (x, z) => {
      probe.set(x, terrain.heightAt(x, z), z).project(rts.camera);
      // Behind the camera the projection is mirrored: turn it back so the arrow points right.
      const back = probe.z > 1;
      const nx = back ? -probe.x : probe.x;
      const ny = back ? -probe.y : probe.y;
      return {
        sx: (nx * 0.5 + 0.5) * window.innerWidth,
        sy: (-ny * 0.5 + 0.5) * window.innerHeight,
        on: !back && Math.abs(probe.x) < 0.92 && Math.abs(probe.y) < 0.92,
      };
    },
    lookAt,
  );
  scene.add(
    terrain.mesh,
    terrain.water,
    terrain.trees,
    clutter.group,
    structures.group,
    works.group,
    scars.mesh,
    units.group,
    cameras.group,
    effects.group,
    input.marker,
    card.group,
  );
  // Towns: who holds what, and what the held ones have paid so far.
  const townsEl = document.getElementById('towns');
  const TEAM_NAME = ['red', 'blue', 'gold'];
  const TEAM_CSS = ['#eb4637', '#468cff', '#f0be3c'];
  setInterval(() => {
    if (!townsEl) return;
    let html = `<b>Towns pay ${TOWN_INCOME} credits a second each</b>`;
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
  // Control groups that exist, as chips: number and size. Click = the number key.
  const groupsEl = document.getElementById('groups');
  let groupsHtml = '';
  groupsEl?.addEventListener('pointerdown', (e) => {
    const chip = (e.target as HTMLElement).closest('button');
    if (!chip) return;
    e.preventDefault();
    if (chip.dataset.n === 'new') input.saveNewGroup();
    else input.recallGroup(Number(chip.dataset.n), e.shiftKey);
  });
  setInterval(() => {
    if (!groupsEl) return;
    let html = '';
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 0]) {
      const ids = input.groupIds(n);
      if (ids.length === 0) continue;
      const on = ids.length === units.selectedCount && ids.every((id) => units.selected[id]);
      html += `<button data-n="${n}" class="${on ? 'on' : ''}" title="Group ${n}: press ${n} to select, twice to jump to it. Ctrl or Option/Alt + ${n} saves the selection as this group; with Shift it is added to it"><b>${n}</b>${ids.length}</button>`;
    }
    if (units.selectedCount > 0 && !html.includes('class="on"')) {
      html += `<button data-n="new" title="Save the selected units as the next free group. Keys: Ctrl + number, or Option/Alt + number (on a Mac, Ctrl + number belongs to the system)">+ Group</button>`;
    }
    if (html !== groupsHtml) groupsEl.innerHTML = groupsHtml = html;
  }, 300);
  const selectionEl = document.getElementById('selection');
  let wasFed = true;
  setInterval(() => {
    if (!selectionEl) return;
    const n = new Array<number>(KINDS.length).fill(0);
    let aboard = 0;
    for (const id of units.selectedIds()) {
      n[units.kindOf(id)]++;
      if (KINDS[units.kindOf(id)].carry > 0) aboard += units.load[id];
    }
    const parts = KINDS.map((k, i) => (n[i] > 0 ? `${n[i]} ${k.name.toLowerCase()}` : '')).filter(
      (p) => p !== '',
    );
    if (aboard > 0) parts.push(`${aboard} squads aboard`);
    const starving = units
      .selectedIds()
      .filter((id) => (units.task[id] & TASK_HUNGRY) !== 0).length;
    if (starving > 0) parts.push(`${starving} out of supply: half fire rate`);
    const under = new Map<number, number>();
    for (const id of units.selectedIds()) {
      if (units.cmdr[id] >= 0) under.set(units.cmdr[id], (under.get(units.cmdr[id]) ?? 0) + 1);
    }
    for (const [slot, count] of under) parts.push(`${count} under ${COMMANDER_NAMES[slot]}`);
    // The first units to run out of rations get an alert; the count stays in the top bar.
    const out = supply.hungry;
    if (out.length > 0 && wasFed) {
      const c = units.centreOf(out);
      if (c) alerts?.report(ALERT_NOTE, c.x, c.z, 'Units out of supply', performance.now() / 1000);
    }
    wasFed = out.length === 0;
    selectionEl.style.display = parts.length > 0 ? 'block' : 'none';
    selectionEl.textContent = parts.join(' · ');
  }, 250);

  // Reinforcements: a combined-arms battlegroup of 500 per side, attacking toward the centre.
  document.getElementById('add-units')?.addEventListener('click', () => {
    for (let team = 0; team < 2; team++) {
      const dir = team === 0 ? -1 : 1;
      const mix: [number, number, number][] = [
        [KIND_TANK, 180, 150],
        [KIND_IFV, 80, 165],
        [KIND_INFANTRY, 124, 180],
        [KIND_ATGM, 55, 190],
        [KIND_ARTILLERY, 20, 230],
        [KIND_RECON, 8, 150],
        [KIND_DRONE, 8, 200],
        [KIND_STRIKE, 24, 215],
        [KIND_AD, 8, 170],
        [KIND_EW, 3, 185],
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
  // Graphics detail is chosen on screen and remembered; it takes a reload to rebuild
  // every material.
  const pickQuality = document.getElementById('quality') as HTMLSelectElement | null;
  if (pickQuality) {
    pickQuality.value = quality;
    pickQuality.addEventListener('change', () => {
      try {
        localStorage.setItem('revolution.quality', pickQuality.value);
      } catch {
        // not remembered; the address still carries it
      }
      params.set('quality', pickQuality.value);
      location.search = params.toString();
    });
  }
  const pickVolume = document.getElementById('volume') as HTMLSelectElement | null;
  if (pickVolume) {
    pickVolume.value = String(
      [0, 0.35, 0.7, 1].reduce((a, b) =>
        Math.abs(b - sound.volume) < Math.abs(a - sound.volume) ? b : a,
      ),
    );
    pickVolume.addEventListener('change', () => {
      sound.setVolume(Number(pickVolume.value));
      pickVolume.blur();
    });
  }
  const helpEl = document.getElementById('help');
  const toggleHelp = () => {
    if (helpEl) helpEl.style.display = helpEl.style.display === 'block' ? 'none' : 'block';
  };
  document.getElementById('help-toggle')?.addEventListener('click', toggleHelp);
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'F1') return;
    e.preventDefault();
    toggleHelp();
  });
  // Base buildings change this copy of the map too, so a reset starts from a fresh page.
  document.getElementById('reset')?.addEventListener('click', () => location.reload());

  const resize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    rts.resize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', resize);
  resize();

  // High detail: fire, flashes and sun glints bleed light into what is around them.
  let pipeline: THREE.RenderPipeline | null = null;
  if (quality === 'high') {
    const scenePass = pass(scene, rts.camera);
    const lit = scenePass.getTextureNode('output');
    pipeline = new THREE.RenderPipeline(renderer);
    pipeline.outputNode = lit.add(bloom(lit, 0.14, 0.3, 1.5));
  }

  let last = performance.now();
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dtMs = now - last;
    last = now;
    const dt = Math.min(dtMs / 1000, 0.1);
    rts.update(dt);
    units.zoom = rts.distance;
    clutter.update(rts.distance);
    const cm = rts.camera.matrixWorld.elements;
    sound.listen(rts.focus.x, rts.focus.z, rts.distance, cm[0], cm[2]);
    const c0 = performance.now();
    units.update(now, dt, rts.camera);
    const c1 = performance.now();
    cameras.zoom = rts.distance;
    cameras.update();
    structures.update(now / 1000, dt);
    works.update(now / 1000);
    const c2 = performance.now();
    effects.update(dt, rts.camera);
    const c3 = performance.now();
    terrain.update(dt);
    input.update(dt);
    card.update();
    minimap.update(now);
    alerts?.update(now / 1000);
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
    const c4 = performance.now();
    if (pipeline) pipeline.render();
    else renderer.render(scene, rts.camera);
    const c5 = performance.now();
    // Smoothed, so the readout is readable: where the CPU time of a frame goes.
    const st = hud.stats;
    st.cpuUnits += (c1 - c0 - st.cpuUnits) * 0.05;
    st.cpuFx += (c3 - c2 - st.cpuFx) * 0.05;
    st.cpuDraw += (c5 - c4 - st.cpuDraw) * 0.05;
    st.zoom = rts.distance;
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
    sound,
    units,
    structures,
    works,
    card,
    production,
    board,
    alerts,
    map,
    send,
    look: (x: number, z: number, dist: number, yaw?: number) => rts.look(x, z, dist, yaw),
    camera: rts.camera,
    cameras,
  };
  document.getElementById('loading')?.remove();
}

start().catch((err) => {
  console.error(err);
  const el = document.getElementById('loading');
  if (el) el.textContent = `Could not start: ${err instanceof Error ? err.message : String(err)}`;
});
