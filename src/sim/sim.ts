import {
  CMD_ATTACK_MOVE,
  CMD_MOVE,
  CMD_SPAWN,
  CMD_STOP,
  type Command,
  type SpawnCommand,
} from './commands';
import { FP_SHIFT, clampInt, fx, isqrt } from './fixed';
import { nextInt } from './rng';
import { ACQUIRE_RANGE, KINDS, KIND_COUNT, KIND_TANK } from './units';
import {
  EV_DEATH,
  EV_SHOT,
  FLAG_AMOVE,
  FLAG_MOVING,
  FLAG_WANDER,
  MAP_SIZE,
  MAP_SIZE_FX,
  MAX_TEAMS,
  MAX_UNITS,
  NO_TARGET,
  STATE_ALIVE,
  STATE_FREE,
  STATE_WRECK,
  type World,
} from './world';

const SEP_RADIUS = fx(1.8);
const SEP_RADIUS_SQ = SEP_RADIUS * SEP_RADIUS;
// Cap on neighbour tests per unit per tick. Bounds the cost of pathological pile-ups
// (thousands of units on one spot) so a tick can never go quadratic.
const MAX_NEIGHBOUR_TESTS = 64;
const MAX_PUSH = fx(0.2);
const FORMATION_SPACING = fx(2.6);
const SQUAD_SIZE = 48;
const SQUAD_SPREAD = fx(10);
const WANDER_PERIOD = 600; // ticks between new roaming orders for a squad
const WANDER_MARGIN = fx(48);
const POS_MAX = MAP_SIZE_FX - 1;

// Fine grid for collisions. Cells are 4 world units, larger than SEP_RADIUS, so all
// neighbours of a unit are in the 3x3 block around its cell.
const CELL_SHIFT = FP_SHIFT + 2;
const GRID_DIM = MAP_SIZE >> 2;
const GRID_CELLS = GRID_DIM * GRID_DIM;

// Coarse grid for target acquisition. Cells are 16 world units; ACQUIRE_CELLS cells in
// every direction cover ACQUIRE_RANGE.
const COARSE_SHIFT = FP_SHIFT + 4;
const COARSE_DIM = MAP_SIZE >> 4;
const COARSE_CELLS = COARSE_DIM * COARSE_DIM;
const ACQUIRE_CELLS = 3;
const ACQUIRE_RANGE_SQ = ACQUIRE_RANGE * ACQUIRE_RANGE;
// Units without a target look for one every 4 ticks; everyone re-evaluates every 16 so a
// closer threat replaces a distant one. Staggered by id so the work is spread evenly.
const SEARCH_IDLE_MASK = 3;
const SEARCH_ALL_MASK = 15;
const MAX_TARGET_TESTS = 2048;

// Scratch buffers, rebuilt from world state every tick. Not part of the state.
const cellStart = new Int32Array(GRID_CELLS + 1);
const cellFill = new Int32Array(GRID_CELLS);
const sorted = new Int32Array(MAX_UNITS);
const coarseStart = new Int32Array(COARSE_CELLS + 1);
const coarseSorted = new Int32Array(MAX_UNITS);
const cellOf = new Int32Array(MAX_UNITS);
const pushX = new Int32Array(MAX_UNITS);
const pushY = new Int32Array(MAX_UNITS);
const damage = new Int32Array(MAX_UNITS);
const killer = new Int32Array(MAX_UNITS);
const squadScratch: number[] = [];

/** Advance the world by exactly one tick, applying `commands` first, in order. */
export function step(w: World, commands: readonly Command[]): void {
  for (let c = 0; c < commands.length; c++) applyCommand(w, commands[c]);
  updateWander(w);
  bucket(w, CELL_SHIFT, GRID_DIM, cellStart, sorted);
  bucket(w, COARSE_SHIFT, COARSE_DIM, coarseStart, coarseSorted);
  acquireTargets(w);
  steer(w);
  separate(w);
  fire(w);
  integrate(w);
  resolveDamage(w);
  w.tick++;
}

function applyCommand(w: World, cmd: Command): void {
  switch (cmd.type) {
    case CMD_MOVE:
    case CMD_ATTACK_MOVE: {
      const units = validUnits(w, cmd.units);
      orderFormationMove(w, units, cmd.x | 0, cmd.y | 0);
      const attack = cmd.type === CMD_ATTACK_MOVE;
      for (let k = 0; k < units.length; k++) {
        const id = units[k];
        w.flags[id] = (w.flags[id] & ~(FLAG_WANDER | FLAG_AMOVE)) | (attack ? FLAG_AMOVE : 0);
      }
      break;
    }
    case CMD_STOP: {
      const units = validUnits(w, cmd.units);
      for (let k = 0; k < units.length; k++) w.flags[units[k]] = 0;
      break;
    }
    case CMD_SPAWN:
      spawn(w, cmd);
      break;
  }
}

/** Commands come from outside the sim, so never trust the ids in them. */
function validUnits(w: World, ids: readonly number[]): number[] {
  const out: number[] = [];
  for (let k = 0; k < ids.length; k++) {
    const id = ids[k];
    if (Number.isInteger(id) && id >= 0 && id < w.count && w.state[id] === STATE_ALIVE) {
      out.push(id);
    }
  }
  return out;
}

/** Send units to a square grid formation centred on (cx, cy). */
function orderFormationMove(w: World, units: readonly number[], cx: number, cy: number): void {
  const n = units.length;
  if (n === 0) return;
  let cols = isqrt(n);
  if (cols * cols < n) cols++;
  const rows = Math.ceil(n / cols);
  for (let k = 0; k < n; k++) {
    const id = units[k];
    const col = k % cols;
    const row = (k - col) / cols;
    // (2*col - (cols-1)) / 2 keeps the block centred using integers only.
    const ox = ((2 * col - (cols - 1)) * FORMATION_SPACING) >> 1;
    const oy = ((2 * row - (rows - 1)) * FORMATION_SPACING) >> 1;
    w.targetX[id] = clampInt(cx + ox, 0, POS_MAX);
    w.targetY[id] = clampInt(cy + oy, 0, POS_MAX);
    w.flags[id] |= FLAG_MOVING;
  }
}

function spawn(w: World, cmd: SpawnCommand): void {
  const r = clampInt(cmd.radius | 0, 1, MAP_SIZE_FX);
  const cx = cmd.x | 0;
  const cy = cmd.y | 0;
  const teamId = clampInt(cmd.team | 0, 0, MAX_TEAMS - 1);
  const kindId = clampInt((cmd.kind ?? KIND_TANK) | 0, 0, KIND_COUNT - 1);
  const kind = KINDS[kindId];
  const advance = cmd.advanceX !== undefined && cmd.advanceY !== undefined;
  const ax = (cmd.advanceX ?? 0) | 0;
  const ay = (cmd.advanceY ?? 0) | 0;
  const n = clampInt(cmd.count | 0, 0, MAX_UNITS);
  let squadX = 0;
  let squadY = 0;
  let group = 0;
  let scan = 0;
  const firstGroup = w.groupCount;
  for (let k = 0; k < n; k++) {
    // Reuse the lowest free slot, else grow.
    while (scan < w.count && w.state[scan] !== STATE_FREE) scan++;
    if (scan >= MAX_UNITS) break;
    const id = scan;
    if (id === w.count) w.count++;
    if (k % SQUAD_SIZE === 0) {
      group = w.groupCount++;
      squadX = cx - r + nextInt(w.rng, 2 * r);
      squadY = cy - r + nextInt(w.rng, 2 * r);
    }
    const x = squadX - SQUAD_SPREAD + nextInt(w.rng, 2 * SQUAD_SPREAD);
    const y = squadY - SQUAD_SPREAD + nextInt(w.rng, 2 * SQUAD_SPREAD);
    w.posX[id] = clampInt(x, 0, POS_MAX);
    w.posY[id] = clampInt(y, 0, POS_MAX);
    w.velX[id] = 0;
    w.velY[id] = 0;
    w.targetX[id] = w.posX[id];
    w.targetY[id] = w.posY[id];
    w.speed[id] = kind.speed + nextInt(w.rng, 1 + (kind.speed >> 3));
    w.group[id] = group;
    w.team[id] = teamId;
    w.kind[id] = kindId;
    w.state[id] = STATE_ALIVE;
    w.hp[id] = kind.hp;
    // Random first reload so a fresh army does not fire in one synchronised volley.
    w.cooldown[id] = nextInt(w.rng, kind.reload);
    w.attack[id] = NO_TARGET;
    w.flags[id] = wanderFlag(cmd.wander && !advance);
    if (advance) {
      w.targetX[id] = clampInt(w.posX[id] + ax, 0, POS_MAX);
      w.targetY[id] = clampInt(w.posY[id] + ay, 0, POS_MAX);
      w.flags[id] = FLAG_MOVING | FLAG_AMOVE;
    }
  }
  if (cmd.wander && !advance) {
    for (let g = firstGroup; g < w.groupCount; g++) orderSquadWander(w, g);
  }
}

function wanderFlag(wander: boolean): number {
  return wander ? FLAG_WANDER : 0;
}

function orderSquadWander(w: World, group: number): void {
  squadScratch.length = 0;
  for (let i = 0; i < w.count; i++) {
    if (w.group[i] === group && (w.flags[i] & FLAG_WANDER) !== 0 && w.state[i] === STATE_ALIVE)
      squadScratch.push(i);
  }
  if (squadScratch.length === 0) return;
  const span = MAP_SIZE_FX - 2 * WANDER_MARGIN;
  const x = WANDER_MARGIN + nextInt(w.rng, span);
  const y = WANDER_MARGIN + nextInt(w.rng, span);
  orderFormationMove(w, squadScratch, x, y);
}

function updateWander(w: World): void {
  if (w.tick === 0) return;
  for (let g = 0; g < w.groupCount; g++) {
    // Stagger squads so new orders are spread over the period instead of all at once.
    if ((w.tick + g * 53) % WANDER_PERIOD === 0) orderSquadWander(w, g);
  }
}

/** Counting sort of the living units into a square grid of `dim` cells per side. */
function bucket(w: World, shift: number, dim: number, start: Int32Array, out: Int32Array): void {
  const n = w.count;
  start.fill(0);
  for (let i = 0; i < n; i++) {
    if (w.state[i] !== STATE_ALIVE) continue;
    const c = (w.posY[i] >> shift) * dim + (w.posX[i] >> shift);
    cellOf[i] = c;
    start[c + 1]++;
  }
  const cells = dim * dim;
  for (let c = 0; c < cells; c++) start[c + 1] += start[c];
  // Ascending id order inside each cell.
  cellFill.fill(0, 0, cells);
  for (let i = 0; i < n; i++) {
    if (w.state[i] !== STATE_ALIVE) continue;
    const c = cellOf[i];
    out[start[c] + cellFill[c]++] = i;
  }
}

/**
 * Pick who to shoot: the nearest living enemy within ACQUIRE_RANGE (ties go to the lowest
 * id). Reads only positions, which do not change during this pass, so the result does not
 * depend on iteration order.
 */
function acquireTargets(w: World): void {
  const n = w.count;
  const tick = w.tick;
  for (let i = 0; i < n; i++) {
    if (w.state[i] !== STATE_ALIVE) continue;
    const x = w.posX[i];
    const y = w.posY[i];
    const t = w.attack[i];
    let valid = false;
    if (t !== NO_TARGET && w.state[t] === STATE_ALIVE && w.team[t] !== w.team[i]) {
      const dx = w.posX[t] - x;
      const dy = w.posY[t] - y;
      valid = dx * dx + dy * dy <= ACQUIRE_RANGE_SQ;
    }
    const phase = tick + i;
    if (valid ? (phase & SEARCH_ALL_MASK) !== 0 : (phase & SEARCH_IDLE_MASK) !== 0) {
      if (!valid) w.attack[i] = NO_TARGET;
      continue;
    }
    const team = w.team[i];
    const cx = x >> COARSE_SHIFT;
    const cy = y >> COARSE_SHIFT;
    const y0 = cy > ACQUIRE_CELLS ? cy - ACQUIRE_CELLS : 0;
    const y1 = cy < COARSE_DIM - 1 - ACQUIRE_CELLS ? cy + ACQUIRE_CELLS : COARSE_DIM - 1;
    const x0 = cx > ACQUIRE_CELLS ? cx - ACQUIRE_CELLS : 0;
    const x1 = cx < COARSE_DIM - 1 - ACQUIRE_CELLS ? cx + ACQUIRE_CELLS : COARSE_DIM - 1;
    let best = NO_TARGET;
    let bestD = ACQUIRE_RANGE_SQ + 1;
    let budget = MAX_TARGET_TESTS;
    for (let gy = y0; gy <= y1 && budget > 0; gy++) {
      const from = coarseStart[gy * COARSE_DIM + x0];
      let to = coarseStart[gy * COARSE_DIM + x1 + 1];
      if (to - from > budget) to = from + budget;
      budget -= to - from;
      for (let s = from; s < to; s++) {
        const j = coarseSorted[s];
        if (w.team[j] === team) continue;
        const dx = w.posX[j] - x;
        const dy = w.posY[j] - y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD || (d2 === bestD && j < best)) {
          bestD = d2;
          best = j;
        }
      }
    }
    w.attack[i] = best;
  }
}

/**
 * Weapons are hitscan: a ready weapon with its target in range hits now. Damage is summed
 * per target from start-of-tick state and applied in resolveDamage(), so two units can
 * kill each other on the same tick and iteration order never matters.
 */
function fire(w: World): void {
  const n = w.count;
  for (let i = 0; i < n; i++) {
    if (w.state[i] !== STATE_ALIVE) continue;
    if (w.cooldown[i] > 0) {
      w.cooldown[i]--;
      continue;
    }
    const t = w.attack[i];
    if (t === NO_TARGET) continue;
    const kind = KINDS[w.kind[i]];
    const dx = w.posX[t] - w.posX[i];
    const dy = w.posY[t] - w.posY[i];
    if (dx * dx + dy * dy > kind.range * kind.range) continue;
    damage[t] += kind.damage[w.kind[t]];
    killer[t] = i;
    w.cooldown[i] = kind.reload;
    w.events.push(EV_SHOT, i, t);
  }
}

function resolveDamage(w: World): void {
  const n = w.count;
  for (let i = 0; i < n; i++) {
    const state = w.state[i];
    if (state === STATE_ALIVE) {
      const d = damage[i];
      if (d === 0) continue;
      damage[i] = 0;
      const hp = w.hp[i] - d;
      if (hp > 0) {
        w.hp[i] = hp;
        continue;
      }
      w.hp[i] = 0;
      w.state[i] = STATE_WRECK;
      w.cooldown[i] = KINDS[w.kind[i]].wreckTicks;
      w.flags[i] = 0;
      w.velX[i] = 0;
      w.velY[i] = 0;
      w.attack[i] = NO_TARGET;
      w.events.push(EV_DEATH, i, killer[i]);
    } else if (state === STATE_WRECK && --w.cooldown[i] <= 0) {
      w.state[i] = STATE_FREE;
    }
  }
}

/**
 * Desired velocity. A unit that is free to fight (idle, attack-moving or roaming) closes
 * on its target until in weapon range and then holds. A unit under a plain move order keeps
 * going and only shoots what happens to be in range.
 */
function steer(w: World): void {
  const n = w.count;
  for (let i = 0; i < n; i++) {
    if (w.state[i] !== STATE_ALIVE) continue;
    const flags = w.flags[i];
    const s = w.speed[i];
    let vx = 0;
    let vy = 0;
    const t = w.attack[i];
    if (
      t !== NO_TARGET &&
      ((flags & FLAG_MOVING) === 0 || (flags & (FLAG_AMOVE | FLAG_WANDER)) !== 0)
    ) {
      const dx = w.posX[t] - w.posX[i];
      const dy = w.posY[t] - w.posY[i];
      const d2 = dx * dx + dy * dy;
      const range = KINDS[w.kind[i]].range;
      if (d2 > range * range) {
        const dist = isqrt(d2);
        vx = Math.trunc((dx * s) / dist);
        vy = Math.trunc((dy * s) / dist);
      }
    } else if ((flags & FLAG_MOVING) !== 0) {
      const dx = w.targetX[i] - w.posX[i];
      const dy = w.targetY[i] - w.posY[i];
      const dist = isqrt(dx * dx + dy * dy);
      if (dist <= s) {
        vx = dx;
        vy = dy;
        w.flags[i] = flags & ~(FLAG_MOVING | FLAG_AMOVE);
      } else {
        vx = Math.trunc((dx * s) / dist);
        vy = Math.trunc((dy * s) / dist);
      }
    }
    w.velX[i] = vx;
    w.velY[i] = vy;
  }
}

/**
 * Soft collision: overlapping units push each other apart. Pushes are computed from the
 * positions at the start of the tick and applied afterwards, so the result does not depend
 * on iteration order.
 */
function separate(w: World): void {
  const n = w.count;
  for (let i = 0; i < n; i++) {
    if (w.state[i] !== STATE_ALIVE) continue;
    const x = w.posX[i];
    const y = w.posY[i];
    const cx = x >> CELL_SHIFT;
    const cy = y >> CELL_SHIFT;
    const y0 = cy > 0 ? cy - 1 : 0;
    const y1 = cy < GRID_DIM - 1 ? cy + 1 : cy;
    const x0 = cx > 0 ? cx - 1 : 0;
    const x1 = cx < GRID_DIM - 1 ? cx + 1 : cx;
    let px = 0;
    let py = 0;
    let budget = MAX_NEIGHBOUR_TESTS;
    for (let gy = y0; gy <= y1 && budget > 0; gy++) {
      // Cells x0..x1 of a row are contiguous in the sorted array.
      const from = cellStart[gy * GRID_DIM + x0];
      let to = cellStart[gy * GRID_DIM + x1 + 1];
      if (to - from > budget) to = from + budget;
      budget -= to - from;
      for (let s = from; s < to; s++) {
        const j = sorted[s];
        if (j === i) continue;
        const dx = x - w.posX[j];
        const dy = y - w.posY[j];
        if (dx >= SEP_RADIUS || dx <= -SEP_RADIUS || dy >= SEP_RADIUS || dy <= -SEP_RADIUS) {
          continue;
        }
        const d2 = dx * dx + dy * dy;
        if (d2 >= SEP_RADIUS_SQ) continue;
        if (d2 === 0) {
          // Exactly stacked: split along x by id so the pair separates symmetrically.
          px += i < j ? -(SEP_RADIUS >> 3) : SEP_RADIUS >> 3;
          continue;
        }
        const d = isqrt(d2);
        const overlap = SEP_RADIUS - d;
        px += Math.trunc((dx * overlap) / ((d + 1) * 4));
        py += Math.trunc((dy * overlap) / ((d + 1) * 4));
      }
    }
    pushX[i] = clampInt(px, -MAX_PUSH, MAX_PUSH);
    pushY[i] = clampInt(py, -MAX_PUSH, MAX_PUSH);
  }
}

function integrate(w: World): void {
  const n = w.count;
  for (let i = 0; i < n; i++) {
    if (w.state[i] !== STATE_ALIVE) continue;
    w.posX[i] = clampInt(w.posX[i] + w.velX[i] + pushX[i], 0, POS_MAX);
    w.posY[i] = clampInt(w.posY[i] + w.velY[i] + pushY[i], 0, POS_MAX);
  }
}
