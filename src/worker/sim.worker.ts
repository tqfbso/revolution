// Runs the deterministic simulation at a fixed tick rate, off the main thread, so rendering
// never waits on game logic and game logic never waits on rendering.
import type { Command } from '../sim/commands';
import { fromFx } from '../sim/fixed';
import { battleCommands, stressTestCommands } from '../sim/scenarios';
import { KINDS } from '../sim/units';
import { step } from '../sim/sim';
import {
  MAX_TEAMS,
  NO_TARGET,
  STATE_ALIVE,
  TICK_MS,
  TICK_RATE,
  createWorld,
  hashWorld,
  type World,
} from '../sim/world';
import { INFO_KIND_SHIFT, INFO_TEAM_SHIFT, NO_AIM, type Snapshot, type ToWorker } from './protocol';

const MAX_CATCH_UP_TICKS = 4;

let world: World | null = null;
let pending: Command[] = [];
let lastTime = 0;
let accumulator = 0;
let timer: ReturnType<typeof setInterval> | undefined;

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    world = createWorld(msg.seed);
    pending = msg.scenario === 'roam' ? stressTestCommands(msg.units) : battleCommands(msg.units);
    accumulator = TICK_MS; // run the first tick immediately
    lastTime = performance.now();
    if (timer === undefined) timer = setInterval(pump, 5);
  } else if (msg.type === 'command') {
    // Single player: apply on the next tick. Lockstep will schedule a few ticks ahead instead.
    pending.push(msg.command);
  }
};

function pump(): void {
  if (!world) return;
  const now = performance.now();
  accumulator += now - lastTime;
  lastTime = now;
  if (accumulator < TICK_MS) return;

  let simMs = 0;
  let ticks = 0;
  while (accumulator >= TICK_MS && ticks < MAX_CATCH_UP_TICKS) {
    const t0 = performance.now();
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
  const alive = new Array<number>(MAX_TEAMS).fill(0);
  for (let i = 0; i < n; i++) {
    positions[2 * i] = fromFx(w.posX[i]);
    positions[2 * i + 1] = fromFx(w.posY[i]);
    const kind = w.kind[i];
    info[i] = w.state[i] | (kind << INFO_KIND_SHIFT) | (w.team[i] << INFO_TEAM_SHIFT);
    hp[i] = Math.ceil((w.hp[i] * 255) / KINDS[kind].hp);
    aim[i] = w.attack[i] === NO_TARGET ? NO_AIM : w.attack[i];
    if (w.state[i] === STATE_ALIVE) alive[w.team[i]]++;
  }
  const events = Int32Array.from(w.events);
  w.events.length = 0;
  const snapshot: Snapshot = {
    type: 'snapshot',
    tick: w.tick,
    count: n,
    positions,
    info,
    hp,
    aim,
    events,
    alive,
    simMs,
  };
  if (w.tick % TICK_RATE === 0) snapshot.hash = hashWorld(w);
  self.postMessage(snapshot, {
    transfer: [positions.buffer, info.buffer, hp.buffer, aim.buffer, events.buffer],
  });
}
