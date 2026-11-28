// Runs the deterministic simulation at a fixed tick rate, off the main thread, so rendering
// never waits on game logic and game logic never waits on rendering.
import { FELL_PANCAKE, FIRE_OUT, floorsAlight } from '../sim/collapse';
import type { Command } from '../sim/commands';
import { createGame, type Game } from '../sim/match';
import { CIV_FLEEING, CIV_HOME } from '../sim/civilians';
import { strikeOf, strikeStatus } from '../sim/air';
import { fromFx } from '../sim/fixed';
import { CELL_SHIFT, S_BUILDING, groundMax } from '../sim/map';
import { BUILDINGS, TIER_ITEM, TIER_PRICE, unitPrice } from '../sim/economy';
import { kindOf } from '../sim/factions';
import { KINDS } from '../sim/units';
import { NEEDS_SUPPLY, upkeepPerMinute } from '../sim/logistics';
import { WORKS } from '../sim/works';
import { stageOf } from '../sim/sim';
import { SCAR_CELLS } from '../sim/scars';
import { onRoof } from '../sim/ambush';
import { fortified } from '../sim/urban';
import {
  FLAG_MOVING,
  MAX_TEAMS,
  NO_TARGET,
  NO_TEAM,
  QUEUE_MAX,
  BUILD_QUEUE,
  JOB_BUILD,
  STATE_ALIVE,
  TICK_MS,
  TICK_RATE,
  hashWorld,
  type World,
  MAX_CAMERAS,
  MAX_COMMANDERS,
  CF_AUTO,
  CF_SHAPE_MASK,
  CF_SHAPE_SHIFT,
  CF_STYLE_MASK,
  CF_STYLE_SHIFT,
  STANCE_AMBUSH,
  STANCE_FREE,
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
  TASK_HUNGRY,
  TASK_HOLD_FIRE,
  TASK_AMBUSH,
  TASK_ROOF,
  COMMANDER_AUTO,
  COMMANDER_FIGHTING,
  COMMANDER_NEED,
  COMMANDER_STYLE_SHIFT,
  COMMANDER_SHAPE_SHIFT,
  COMMANDER_STRIDE,
  type Frame,
  type NetMode,
  type Snapshot,
  type ToWorker,
  STRUCT_ALIGHT,
  STRUCT_BURNT,
  STRUCT_FORTIFIED,
  STRUCT_PANCAKE,
} from './protocol';

const MAX_CATCH_UP_TICKS = 4;

/**
 * The game being played: the world, and the computer or the staff of every army, all built
 * from the one description of it the page sends (src/sim/match.ts).
 */
let game: Game | null = null;
/**
 * Co-op (client/net.ts). The host runs on its own clock like a game alone, and reports the
 * players' orders that went into each tick; the guest runs exactly the ticks it is sent.
 */
let mode: NetMode = 'solo';
/** Host: ticks run since the last report. Guest: ticks received and waiting to be run. */
let frames: Frame[] = [];
/** Guest: how many of `frames` have been run already (they are dropped in batches). */
let head = 0;
/** A guest this far behind is playing a game through to rejoin it: no pictures, no hashes. */
const REPLAY_BEHIND = 200;
let hashes: number[] = [];
/** Both sides hash the world on the same ticks, two seconds apart. */
const HASH_EVERY = TICK_RATE * 2;
/**
 * Players' orders received since the last tick, each signed with the seat and the army it
 * came from, kept apart so a frame holds only those.
 */
let inbox: Command[] = [];
/** This player's seat, and the army he commands (the snapshot's commanders are that army's). */
let seat = 0;
let me = 0;
/** `?control=all`, alone: this player's orders go in unsigned, so any army obeys them. */
let free = false;
let lastTime = 0;
let accumulator = 0;
/** Game speed: simulated ticks per real tick interval (`?speed=`). */
let speed = 1;
/** Paused: no ticks run and orders wait in `pending`; they all start on the first tick after. */
let paused = false;
let timer: ReturnType<typeof setInterval> | undefined;
/** The state of the field works (World.worksRev) the client was last told about. */
let worksSent = -1;
/** How many felled cells (World.felledCount) the client was last told about. */
let felledSent = 0;

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    game = createGame(msg.match);
    worksSent = -1;
    felledSent = 0;
    seat = msg.seat;
    me = msg.match.players[seat]?.army ?? 0;
    mode = msg.net ?? 'solo';
    free = msg.free === true && mode === 'solo';
    speed = Math.min(Math.max(msg.speed, 0.5), 16);
    paused = false;
    frames = [];
    head = 0;
    hashes = [];
    inbox = [];
    accumulator = TICK_MS; // run the first tick immediately
    lastTime = performance.now();
    if (timer === undefined) timer = setInterval(pump, 5);
  } else if (msg.type === 'command') {
    // Applied on the next tick this sim runs on its own clock (alone, or as the host).
    // Whoever it is from, this player or another's browser, it is signed here with the seat
    // and the army it came from and goes in only as far as it is theirs to give.
    const from = msg.from ?? seat;
    const own = msg.from === undefined && mode === 'solo' && (free || msg.setup === true);
    const command = own ? msg.command : (game?.sign(msg.command, from) ?? null);
    if (command) inbox.push(command);
  } else if (msg.type === 'frames') {
    for (const f of msg.frames) frames.push(f);
  } else if (msg.type === 'alone') {
    if (game && mode === 'guest') {
      const world = game.world;
      for (let k = head; k < frames.length; k++) {
        if (frames[k][0] === world.tick) tick(game, frames[k][1]);
      }
      frames = [];
      head = 0;
      mode = 'solo';
      accumulator = 0;
      lastTime = performance.now();
      postSnapshot(world, 0);
    }
  } else if (msg.type === 'speed') {
    speed = Math.min(Math.max(msg.speed, 0.5), 16);
  } else if (msg.type === 'pause') {
    paused = msg.paused;
    lastTime = performance.now();
  }
};

/** One tick: the players' orders, then the computer's, then the world moves. */
function tick(g: Game, orders: Command[], quiet = false): number {
  const t0 = performance.now();
  g.tick(orders);
  const w = g.world;
  if (!quiet && mode !== 'solo' && w.tick % HASH_EVERY === 0) hashes.push(w.tick, hashWorld(w));
  return performance.now() - t0;
}

let lastReport = 0;

/** The guest's clock is the host's: run what has arrived, faster if we have fallen behind. */
function follow(g: Game, now: number): void {
  const w = g.world;
  lastTime = now;
  const waiting = frames.length - head;
  // Far behind means a player who came back (decision 104): the whole game so far is
  // waiting. It is played through flat out; what happened on the way is not shown or
  // sounded, and the hashes are compared again once he is level.
  const replay = waiting > REPLAY_BEHIND;
  const cap = replay ? 1 << 30 : waiting > 60 ? 24 : waiting > 6 ? 4 : waiting > 2 ? 2 : 1;
  let simMs = 0;
  let ticks = 0;
  const t0 = performance.now();
  while (head < frames.length && ticks < cap && performance.now() - t0 < (replay ? 30 : 40)) {
    const f = frames[head++];
    // A frame for another tick than ours cannot be played; the hash check will report it.
    if (f[0] !== w.tick) continue;
    const quiet = frames.length - head > REPLAY_BEHIND;
    simMs = tick(g, f[1], quiet);
    if (quiet) w.events.length = 0;
    ticks++;
  }
  if (head > 1024 || head === frames.length) {
    frames = frames.slice(head);
    head = 0;
  }
  if (replay ? now - lastReport > 400 : ticks > 0 || now - lastReport > 500) {
    lastReport = now;
    postSnapshot(w, simMs);
  }
}

function pump(): void {
  if (!game) return;
  const world = game.world;
  const now = performance.now();
  if (mode === 'guest') {
    follow(game, now);
    return;
  }
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
    const orders = inbox;
    inbox = [];
    if (mode === 'host') frames.push([world.tick, orders]);
    simMs = tick(game, orders);
    accumulator -= TICK_MS;
    ticks++;
  }
  // If we fell far behind (tab was in the background), drop the backlog instead of spiralling.
  if (accumulator >= TICK_MS) accumulator = 0;
  postSnapshot(world, simMs);
}

function postSnapshot(w: World, simMs: number): void {
  const n = w.count;
  const routes: number[] = [];
  for (const r of w.routes) {
    routes.push(r.units.length, 1 + r.pts.length / 3, ...r.units, fromFx(r.curX), fromFx(r.curY));
    for (let k = 0; k < r.pts.length; k += 3)
      routes.push(fromFx(r.pts[k + 1]), fromFx(r.pts[k + 2]));
  }
  // Trucks with a list of buildings to put up: the one in hand, then the list.
  const { map } = w;
  const plot = (s: number) =>
    routes.push(
      fromFx(((2 * map.sX[s] + map.sW[s]) << CELL_SHIFT) >> 1),
      fromFx(((2 * map.sY[s] + map.sH[s]) << CELL_SHIFT) >> 1),
    );
  for (let i = 0; i < n; i++) {
    const len = w.buildLen[i];
    if (len === 0 || w.state[i] !== STATE_ALIVE || w.job[i] !== JOB_BUILD) continue;
    routes.push(1, 1 + len, i);
    plot(w.jobStruct[i]);
    for (let q = 0; q < len; q++) plot(w.buildNext[i * BUILD_QUEUE + q]);
  }
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
    hp[i] = Math.ceil((w.hp[i] * 255) / kindOf(w, i).hp);
    aim[i] = w.attack[i] === NO_TARGET ? NO_AIM : w.attack[i];
    if (w.jammed[i] !== 0) load[i] = 1;
    // A truck shows what it carries: 1 supplies, 2 fuel.
    if (w.cargo[i] > 0) load[i] = 1 + w.cargoKind[i];
    task[i] =
      w.job[i] |
      (w.stance[i] !== STANCE_FREE ? TASK_HOLD_FIRE : 0) |
      (w.stance[i] === STANCE_AMBUSH ? TASK_AMBUSH : 0) |
      (onRoof(w, i) ? TASK_ROOF : 0) |
      ((w.flags[i] & FLAG_MOVING) !== 0 ? TASK_MOVING : 0) |
      (w.ration[i] === 0 && NEEDS_SUPPLY[kind] ? TASK_HUNGRY : 0);
    if (KINDS[kind].turn > 0) {
      heading[i] = Math.round((Math.atan2(w.faceX[i], w.faceY[i]) * 128) / Math.PI) & 255;
    }
    if (w.state[i] === STATE_ALIVE) alive[w.team[i]]++;
  }
  const structHp = new Uint8Array(map.structCount);
  const structStage = new Uint8Array(map.structCount);
  const structFire = new Uint8Array(map.structCount);
  const structGround = new Uint8Array(map.structCount).fill(255);
  const structScar = new Uint8Array(map.structCount * SCAR_CELLS);
  for (let s = 0; s < map.structCount; s++) {
    structHp[s] = w.sHp[s] <= 0 ? 0 : Math.ceil((w.sHp[s] * 255) / map.sMaxHp[s]);
    let bits = stageOf(w, s);
    if (map.sKind[s] === S_BUILDING) {
      for (let f = 0; f < 4; f++) if (w.sWall[4 * s + f] <= 0) bits |= 4 << f;
    }
    if (fortified(w, s)) bits |= STRUCT_FORTIFIED;
    structStage[s] = bits;
    if (map.sKind[s] === S_BUILDING) {
      structGround[s] = Math.ceil((Math.max(0, w.sGround[s]) * 255) / groundMax(map, s));
      if (w.sHp[s] < map.sMaxHp[s]) {
        let top = 0;
        for (let c = 0; c < SCAR_CELLS; c++) top = Math.max(top, w.sScar[s * SCAR_CELLS + c]);
        if (top > 0) {
          for (let c = 0; c < SCAR_CELLS; c++) {
            structScar[s * SCAR_CELLS + c] = Math.ceil((w.sScar[s * SCAR_CELLS + c] * 255) / top);
          }
        }
      }
    }
    structFire[s] =
      Math.min(STRUCT_ALIGHT, floorsAlight(w, s)) |
      (w.sFire[s] === FIRE_OUT ? STRUCT_BURNT : 0) |
      (w.sFell[s] === FELL_PANCAKE ? STRUCT_PANCAKE : 0);
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
          : unitPrice(w, w.sTeam[s], item).ticks;
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
  const commanders = new Int32Array(MAX_COMMANDERS * COMMANDER_STRIDE);
  for (let c = 0; c < MAX_COMMANDERS; c++) {
    const o = c * COMMANDER_STRIDE;
    const p = game?.staffs[me]?.posts[c];
    const k = me * MAX_COMMANDERS + c;
    commanders[o] = w.cMission[k];
    commanders[o + 1] = Math.round(fromFx(w.cX[k]));
    commanders[o + 2] = Math.round(fromFx(w.cY[k]));
    commanders[o + 9] =
      ((w.cFlags[k] & CF_AUTO) !== 0 ? COMMANDER_AUTO : 0) |
      (((w.cFlags[k] >> CF_STYLE_SHIFT) & CF_STYLE_MASK) << COMMANDER_STYLE_SHIFT) |
      (((w.cFlags[k] >> CF_SHAPE_SHIFT) & CF_SHAPE_MASK) << COMMANDER_SHAPE_SHIFT);
    if (!p) continue;
    commanders[o + 3] = p.status;
    commanders[o + 4] = p.power;
    commanders[o + 5] = p.f.launch;
    commanders[o + 6] = p.count;
    commanders[o + 7] = Math.round(fromFx(p.cx));
    commanders[o + 8] = Math.round(fromFx(p.cy));
    commanders[o + 9] |= (p.need ? COMMANDER_NEED : 0) | (p.fighting ? COMMANDER_FIGHTING : 0);
  }
  const civs: number[] = [];
  let civHome = 0;
  for (let k = 0; k < w.civCount; k++) {
    if (w.civState[k] === CIV_HOME) civHome++;
    else if (w.civState[k] === CIV_FLEEING) civs.push(k, fromFx(w.civX[k]), fromFx(w.civY[k]));
  }
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
    structFire,
    structGround,
    structScar,
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
    reserve: Array.from(w.paraReserve),
    strikeType: Array.from(w.paraReserve, (_, t) => strikeOf(w, t)),
    strikeStatus: Array.from(w.paraReserve, (_, t) => strikeStatus(w, t)),
    strikeIn: Array.from(w.airStrikeAt, (at) => Math.max(0, Math.ceil((at - w.tick) / TICK_RATE))),
    helis: Array.from(w.helis),
    heliCap: Array.from(w.heliCap),
    upkeep: Array.from(w.pop, (p) => upkeepPerMinute(p)),
    orders: w.orders.slice(),
    keep: w.keep.slice(),
    dest: w.dest.slice(),
    cmdr: w.cmdr.slice(0, n),
    shape: w.shape.slice(0, n),
    owner: w.owner.slice(0, n),
    duties: Array.from(w.duty),
    commanders,
    task,
    routes: Float32Array.from(routes),
    stats: w.stats.slice(),
    spent: w.spent.slice(),
    civilians: Float32Array.from(civs),
    civStats: Int32Array.from([w.civCount, civHome, w.civEscaped, ...w.civKilled]),
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
  if (w.felledCount !== felledSent) {
    felledSent = w.felledCount;
    snapshot.felled = w.felled.slice(0, w.felledCount);
  }
  if (w.tick % TICK_RATE === 0) snapshot.hash = hashWorld(w);
  if (mode !== 'solo') {
    snapshot.net = { hashes, behind: mode === 'guest' ? frames.length - head : 0 };
    if (mode === 'host') {
      snapshot.net.frames = frames;
      frames = [];
    }
    hashes = [];
  }
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
