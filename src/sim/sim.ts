import { CMD_MOVE, CMD_SPAWN, CMD_STOP, type Command } from './commands';
import { FP_SHIFT, clampInt, fx, isqrt } from './fixed';
import { nextInt } from './rng';
import {
  FLAG_MOVING,
  FLAG_WANDER,
  MAP_SIZE,
  MAP_SIZE_FX,
  MAX_TEAMS,
  MAX_UNITS,
  type World,
} from './world';

const BASE_SPEED = fx(0.3); // world units per tick (6 units/s at 20 Hz)
const SPEED_JITTER = 48;
const SEP_RADIUS = fx(1.8);
const SEP_RADIUS_SQ = SEP_RADIUS * SEP_RADIUS;
// Cap on neighbour tests per unit per tick. Bounds the cost of pathological pile-ups
// (thousands of units on one spot) so a tick can never go quadratic.
const MAX_NEIGHBOUR_TESTS = 64;
const MAX_PUSH = fx(0.2); // below BASE_SPEED, so a crowd can slow a unit but never stall it
const FORMATION_SPACING = fx(2.6);
const SQUAD_SIZE = 48;
const SQUAD_SPREAD = fx(10);
const WANDER_PERIOD = 600; // ticks between new roaming orders for a squad
const WANDER_MARGIN = fx(48);
const POS_MAX = MAP_SIZE_FX - 1;

// Uniform grid for neighbour queries. Cells are 4 world units, larger than SEP_RADIUS,
// so all neighbours of a unit are in the 3x3 block around its cell.
const CELL_SHIFT = FP_SHIFT + 2;
const GRID_DIM = MAP_SIZE >> 2;
const GRID_CELLS = GRID_DIM * GRID_DIM;

// Scratch buffers, rebuilt from world state every tick. Not part of the state.
const cellStart = new Int32Array(GRID_CELLS + 1);
const cellFill = new Int32Array(GRID_CELLS);
const cellOf = new Int32Array(MAX_UNITS);
const sorted = new Int32Array(MAX_UNITS);
const pushX = new Int32Array(MAX_UNITS);
const pushY = new Int32Array(MAX_UNITS);
const squadScratch: number[] = [];

/** Advance the world by exactly one tick, applying `commands` first, in order. */
export function step(w: World, commands: readonly Command[]): void {
  for (let c = 0; c < commands.length; c++) applyCommand(w, commands[c]);
  updateWander(w);
  steer(w);
  separate(w);
  integrate(w);
  w.tick++;
}

function applyCommand(w: World, cmd: Command): void {
  switch (cmd.type) {
    case CMD_MOVE: {
      const units = validUnits(w, cmd.units);
      for (let k = 0; k < units.length; k++) w.flags[units[k]] &= ~FLAG_WANDER;
      orderFormationMove(w, units, cmd.x | 0, cmd.y | 0);
      break;
    }
    case CMD_STOP: {
      const units = validUnits(w, cmd.units);
      for (let k = 0; k < units.length; k++) w.flags[units[k]] &= ~(FLAG_WANDER | FLAG_MOVING);
      break;
    }
    case CMD_SPAWN:
      spawn(w, cmd.count | 0, cmd.team | 0, cmd.x | 0, cmd.y | 0, cmd.radius | 0, cmd.wander);
      break;
  }
}

/** Commands come from outside the sim, so never trust the ids in them. */
function validUnits(w: World, ids: readonly number[]): number[] {
  const out: number[] = [];
  for (let k = 0; k < ids.length; k++) {
    const id = ids[k];
    if (Number.isInteger(id) && id >= 0 && id < w.count) out.push(id);
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

function spawn(
  w: World,
  count: number,
  team: number,
  cx: number,
  cy: number,
  radius: number,
  wander: boolean,
): void {
  const n = clampInt(count, 0, MAX_UNITS - w.count);
  const r = clampInt(radius, 1, MAP_SIZE_FX);
  const teamId = clampInt(team, 0, MAX_TEAMS - 1);
  let squadX = 0;
  let squadY = 0;
  let group = 0;
  const firstGroup = w.groupCount;
  for (let k = 0; k < n; k++) {
    if (k % SQUAD_SIZE === 0) {
      group = w.groupCount++;
      squadX = cx - r + nextInt(w.rng, 2 * r);
      squadY = cy - r + nextInt(w.rng, 2 * r);
    }
    const id = w.count++;
    const x = squadX - SQUAD_SPREAD + nextInt(w.rng, 2 * SQUAD_SPREAD);
    const y = squadY - SQUAD_SPREAD + nextInt(w.rng, 2 * SQUAD_SPREAD);
    w.posX[id] = clampInt(x, 0, POS_MAX);
    w.posY[id] = clampInt(y, 0, POS_MAX);
    w.velX[id] = 0;
    w.velY[id] = 0;
    w.targetX[id] = w.posX[id];
    w.targetY[id] = w.posY[id];
    w.speed[id] = BASE_SPEED + nextInt(w.rng, SPEED_JITTER);
    w.group[id] = group;
    w.team[id] = teamId;
    w.flags[id] = wander ? FLAG_WANDER : 0;
  }
  if (wander) for (let g = firstGroup; g < w.groupCount; g++) orderSquadWander(w, g);
}

function orderSquadWander(w: World, group: number): void {
  squadScratch.length = 0;
  for (let i = 0; i < w.count; i++) {
    if (w.group[i] === group && (w.flags[i] & FLAG_WANDER) !== 0) squadScratch.push(i);
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

/** Desired velocity: straight at the target at the unit's speed. */
function steer(w: World): void {
  const n = w.count;
  for (let i = 0; i < n; i++) {
    let vx = 0;
    let vy = 0;
    if ((w.flags[i] & FLAG_MOVING) !== 0) {
      const dx = w.targetX[i] - w.posX[i];
      const dy = w.targetY[i] - w.posY[i];
      const dist = isqrt(dx * dx + dy * dy);
      const s = w.speed[i];
      if (dist <= s) {
        vx = dx;
        vy = dy;
        w.flags[i] &= ~FLAG_MOVING;
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
  // Counting sort of units into grid cells.
  cellStart.fill(0);
  for (let i = 0; i < n; i++) {
    const c = (w.posY[i] >> CELL_SHIFT) * GRID_DIM + (w.posX[i] >> CELL_SHIFT);
    cellOf[i] = c;
    cellStart[c + 1]++;
  }
  for (let c = 0; c < GRID_CELLS; c++) cellStart[c + 1] += cellStart[c];
  cellFill.fill(0);
  for (let i = 0; i < n; i++) {
    const c = cellOf[i];
    sorted[cellStart[c] + cellFill[c]++] = i;
  }

  for (let i = 0; i < n; i++) {
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
    w.posX[i] = clampInt(w.posX[i] + w.velX[i] + pushX[i], 0, POS_MAX);
    w.posY[i] = clampInt(w.posY[i] + w.velY[i] + pushY[i], 0, POS_MAX);
  }
}
