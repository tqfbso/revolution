// Runs the deterministic simulation at a fixed tick rate, off the main thread, so rendering
// never waits on game logic and game logic never waits on rendering.
import type { Command } from '../sim/commands';
import { fromFx } from '../sim/fixed';
import { stressTestCommands } from '../sim/scenarios';
import { step } from '../sim/sim';
import { TICK_MS, TICK_RATE, createWorld, hashWorld, type World } from '../sim/world';
import type { Snapshot, ToWorker } from './protocol';

const MAX_CATCH_UP_TICKS = 4;

let world: World | null = null;
let pending: Command[] = [];
let lastTime = 0;
let accumulator = 0;
let sentCount = -1;
let timer: ReturnType<typeof setInterval> | undefined;

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    world = createWorld(msg.seed);
    pending = stressTestCommands(msg.units);
    sentCount = -1;
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
  for (let i = 0; i < n; i++) {
    positions[2 * i] = fromFx(w.posX[i]);
    positions[2 * i + 1] = fromFx(w.posY[i]);
  }
  const snapshot: Snapshot = { type: 'snapshot', tick: w.tick, count: n, positions, simMs };
  const transfer: Transferable[] = [positions.buffer];
  if (n !== sentCount) {
    snapshot.teams = w.team.slice(0, n);
    transfer.push(snapshot.teams.buffer);
    sentCount = n;
  }
  if (w.tick % TICK_RATE === 0) snapshot.hash = hashWorld(w);
  self.postMessage(snapshot, { transfer });
}
