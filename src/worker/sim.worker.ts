// Runs the deterministic simulation at a fixed tick rate, off the main thread, so rendering
// never waits on game logic and game logic never waits on rendering.
import { aiThink, createAi, type Ai } from '../sim/ai';
import type { Command } from '../sim/commands';
import { fromFx } from '../sim/fixed';
import { S_BUILDING, generateMap } from '../sim/map';
import { BUILDINGS, TIER_ITEM, TIER_PRICE, UNIT_PRICE } from '../sim/economy';
import {
  assaultCommands,
  battleCommands,
  skirmishCommands,
  stressTestCommands,
} from '../sim/scenarios';
import { KINDS } from '../sim/units';
import { WORKS } from '../sim/works';
import { stageOf, step } from '../sim/sim';
import {
  FLAG_MOVING,
  MAX_TEAMS,
  NO_TARGET,
  NO_TEAM,
  QUEUE_MAX,
  STATE_ALIVE,
  TICK_MS,
  TICK_RATE,
  createWorld,
  hashWorld,
  type World,
  MAX_CAMERAS,
} from '../sim/world';
import { CAPTURE_POINTS } from '../sim/units';
import {
  INFO_CARRIED,
  INFO_INSIDE,
  INFO_SPOTTED,
  CAMERA_BLIND,
  CAMERA_KNOWN,
  INFO_REVEALED,
  INFO_TEAM_SHIFT,
  BASE_STRIDE,
  NO_AIM,
  TASK_MOVING,
  type Snapshot,
  type ToWorker,
} from './protocol';

const MAX_CATCH_UP_TICKS = 4;

let world: World | null = null;
let pending: Command[] = [];
/** The computer players. They hand in their commands before each tick, like anyone else. */
let ais: Ai[] = [];
let lastTime = 0;
let accumulator = 0;
/** Game speed: simulated ticks per real tick interval (`?speed=`). */
let speed = 1;
/** Paused: no ticks run and orders wait in `pending`; they all start on the first tick after. */
let paused = false;
let timer: ReturnType<typeof setInterval> | undefined;
/** The state of the field works (World.worksRev) the client was last told about. */
let worksSent = -1;

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    world = createWorld(msg.seed, generateMap(msg.seed, msg.layout));
    worksSent = -1;
    pending =
      msg.scenario === 'roam'
        ? stressTestCommands(msg.units)
        : msg.scenario === 'clash'
          ? battleCommands(msg.units)
          : msg.scenario === 'assault'
            ? assaultCommands(world.map, msg.units)
            : skirmishCommands(world.map);
    ais = [];
    if (msg.scenario === 'skirmish' && msg.ai !== 'off') {
      ais.push(createAi(1, msg.ai, msg.seed));
      // `?demo=1`: the AI plays red as well, to watch it at work.
      if (msg.demo) ais.push(createAi(0, msg.ai, msg.seed));
    }
    speed = Math.min(Math.max(msg.speed, 0.5), 16);
    paused = false;
    accumulator = TICK_MS; // run the first tick immediately
    lastTime = performance.now();
    if (timer === undefined) timer = setInterval(pump, 5);
  } else if (msg.type === 'command') {
    // Single player: apply on the next tick. Lockstep will schedule a few ticks ahead instead.
    pending.push(msg.command);
  } else if (msg.type === 'speed') {
    speed = Math.min(Math.max(msg.speed, 0.5), 16);
  } else if (msg.type === 'pause') {
    paused = msg.paused;
    lastTime = performance.now();
  }
};

function pump(): void {
  if (!world) return;
  const now = performance.now();
  if (paused) {
    lastTime = now;
    return;
  }
  accumulator += (now - lastTime) * speed;
  lastTime = now;
  if (accumulator < TICK_MS) return;

  let simMs = 0;
  let ticks = 0;
  while (accumulator >= TICK_MS && ticks < MAX_CATCH_UP_TICKS * speed) {
    const t0 = performance.now();
    for (const ai of ais) aiThink(ai, world, pending);
    step(world, pending);
    simMs = performance.now() - t0;
    pending = [];
    accumulator -= TICK_MS;
    ticks++;
  }
  // If we fell far behind (tab was in the background), drop the backlog instead of spiralling.
  if (accumulator >= TICK_MS) accumulator = 0;
  postSnapshot(world, simMs);
}

function postSnapshot(w: World, simMs: number): void {
  const n = w.count;
  const positions = new Float32Array(n * 2);
  const info = new Uint8Array(n);
  const hp = new Uint8Array(n);
  const aim = new Uint16Array(n);
  const kinds = w.kind.slice(0, n);
  const load = w.load.slice(0, n);
  const heading = new Uint8Array(n);
  const task = new Uint8Array(n);
  const alive = new Array<number>(MAX_TEAMS).fill(0);
  for (let i = 0; i < n; i++) {
    positions[2 * i] = fromFx(w.posX[i]);
    positions[2 * i + 1] = fromFx(w.posY[i]);
    const kind = w.kind[i];
    info[i] =
      w.state[i] |
      (w.team[i] << INFO_TEAM_SHIFT) |
      (w.inside[i] >= 0 ? INFO_INSIDE : 0) |
      (w.carrier[i] >= 0 ? INFO_CARRIED : 0) |
      (w.spotted[i] > w.tick ? INFO_SPOTTED : 0) |
      (w.reveal[i] > w.tick ? INFO_REVEALED : 0);
    hp[i] = Math.ceil((w.hp[i] * 255) / KINDS[kind].hp);
    aim[i] = w.attack[i] === NO_TARGET ? NO_AIM : w.attack[i];
    if (w.jammed[i] !== 0) load[i] = 1;
    // A truck shows what it carries: 1 supplies, 2 fuel.
    if (w.cargo[i] > 0) load[i] = 1 + w.cargoKind[i];
    task[i] = w.job[i] | (w.stance[i] << 3) | ((w.flags[i] & FLAG_MOVING) !== 0 ? TASK_MOVING : 0);
    if (KINDS[kind].turn > 0) {
      heading[i] = Math.round((Math.atan2(w.faceX[i], w.faceY[i]) * 128) / Math.PI) & 255;
    }
    if (w.state[i] === STATE_ALIVE) alive[w.team[i]]++;
  }
  const map = w.map;
  const structHp = new Uint8Array(map.structCount);
  const structStage = new Uint8Array(map.structCount);
  for (let s = 0; s < map.structCount; s++) {
    structHp[s] = w.sHp[s] <= 0 ? 0 : Math.ceil((w.sHp[s] * 255) / map.sMaxHp[s]);
    let bits = stageOf(w, s);
    if (map.sKind[s] === S_BUILDING) {
      for (let f = 0; f < 4; f++) if (w.sWall[4 * s + f] <= 0) bits |= 4 << f;
    }
    structStage[s] = bits;
  }
  const cams: number[] = [];
  for (let c = 0; c < MAX_CAMERAS; c++) {
    if (w.camTeam[c] < 0) continue;
    cams.push(
      c,
      fromFx(w.camX[c]),
      fromFx(w.camY[c]),
      w.camTeam[c] |
        (w.camSeen[c] > w.tick ? CAMERA_KNOWN : 0) |
        (w.camBlind[c] !== 0 ? CAMERA_BLIND : 0),
    );
  }
  const townProgress = new Uint8Array(map.townCount);
  for (let t = 0; t < map.townCount; t++) {
    townProgress[t] = Math.min(100, Math.round((w.townProgress[t] * 100) / CAPTURE_POINTS));
  }
  const bases: number[] = [];
  for (let s = 0; s < map.structCount; s++) {
    if (w.sTeam[s] === NO_TEAM) continue;
    const b = BUILDINGS[w.sType[s]];
    const item = w.sQueue[s * QUEUE_MAX];
    const need =
      w.sQueueLen[s] === 0
        ? 1
        : item === TIER_ITEM
          ? (TIER_PRICE[w.tier[w.sTeam[s]]]?.ticks ?? 1)
          : UNIT_PRICE[item].ticks;
    bases.push(
      s,
      w.sType[s],
      w.sTeam[s],
      map.sX[s],
      map.sY[s],
      Math.floor((w.sBuild[s] * 100) / b.ticks),
      w.sQueueLen[s],
      Math.floor((w.sProgress[s] * 100) / need),
    );
    for (let q = 0; q < QUEUE_MAX; q++) bases.push(w.sQueue[s * QUEUE_MAX + q]);
    bases.push(Math.round(fromFx(w.sRallyX[s])), Math.round(fromFx(w.sRallyY[s])), w.sRepeat[s]);
  }
  if (bases.length % BASE_STRIDE !== 0) throw new Error('base record size');
  const events = Int32Array.from(w.events);
  w.events.length = 0;
  const snapshot: Snapshot = {
    type: 'snapshot',
    tick: w.tick,
    count: n,
    positions,
    info,
    kind: kinds,
    heading,
    load,
    hp,
    aim,
    events,
    alive,
    structHp,
    structStage,
    cameras: Float32Array.from(cams),
    townOwner: w.townOwner.slice(0, map.townCount),
    townCapturer: w.townCapturer.slice(0, map.townCount),
    townProgress,
    credits: Array.from(w.credits),
    supplies: Array.from(w.supplies),
    fuel: Array.from(w.fuel),
    tier: Array.from(w.tier),
    pop: Array.from(w.pop),
    popCap: Array.from(w.popCap),
    task,
    siteStock: w.siteStock.slice(0, map.siteCount),
    bases: Int32Array.from(bases),
    simMs,
  };
  if (w.worksRev !== worksSent && w.tick % 2 === 0) {
    worksSent = w.worksRev;
    const works = new Int32Array(w.workCount * 2);
    for (let k = 0; k < w.workCount; k++) {
      const c = w.workCells[k];
      const work = WORKS[w.wKind[c]];
      const done = w.wBuild[c] >= work.ticks;
      const value = done
        ? work.hp > 0
          ? Math.ceil((w.wHp[c] * 255) / work.hp)
          : 255
        : Math.floor((w.wBuild[c] * 100) / work.ticks);
      works[2 * k] = c;
      works[2 * k + 1] = w.wKind[c] | (w.wTeam[c] << 4) | (done ? 128 : 0) | (value << 8);
    }
    snapshot.works = works;
  }
  if (w.tick % TICK_RATE === 0) snapshot.hash = hashWorld(w);
  self.postMessage(snapshot, {
    transfer: [
      positions.buffer,
      info.buffer,
      kinds.buffer,
      heading.buffer,
      load.buffer,
      hp.buffer,
      aim.buffer,
      events.buffer,
      task.buffer,
    ],
  });
}
