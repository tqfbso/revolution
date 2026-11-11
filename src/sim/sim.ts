import {
  CMD_ATTACK_MOVE,
  CMD_MOVE,
  CMD_SPAWN,
  CMD_STOP,
  type Command,
  type SpawnCommand,
} from './commands';
import { FP_SHIFT, clampInt, fx, isqrt } from './fixed';
import { CELL_FX, CELL_SHIFT, CLASS_COUNT, MAP_CELLS, T_FOREST, cellOfPos } from './map';
import { DIR_X, DIR_Y, UNREACHABLE, buildField, clearLine, flowDirection, newField } from './path';
import { nextInt } from './rng';
import { ACQUIRE_RANGE, CONCEAL_RANGE, KINDS, KIND_COUNT, KIND_TANK } from './units';
import {
  CHASE_FIELDS,
  EV_DEATH,
  EV_SHOT,
  FLAG_AMOVE,
  FLAG_DIRECT,
  FLAG_MOVING,
  FLAG_WANDER,
  MAP_SIZE,
  MAP_SIZE_FX,
  MAX_FIELDS,
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

// Fine grid for collisions: the terrain grid. Cells are 4 world units, larger than
// SEP_RADIUS, so all neighbours of a unit are in the 3x3 block around its cell.
const GRID_DIM = MAP_CELLS;
const GRID_CELLS = GRID_DIM * GRID_DIM;

// Coarse grid for target acquisition. Cells are 16 world units; ACQUIRE_CELLS cells in
// every direction cover ACQUIRE_RANGE.
const COARSE_SHIFT = FP_SHIFT + 4;
const COARSE_DIM = MAP_SIZE >> 4;
const COARSE_CELLS = COARSE_DIM * COARSE_DIM;
const ACQUIRE_CELLS = 3;
const ACQUIRE_RANGE_SQ = ACQUIRE_RANGE * ACQUIRE_RANGE;
const CONCEAL_RANGE_SQ = CONCEAL_RANGE * CONCEAL_RANGE;
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
const spawned: number[] = [];
const projForward = new Int32Array(MAX_UNITS);
const projSide = new Int32Array(MAX_UNITS);
const fieldRefs = new Int32Array(MAX_FIELDS);
const goalScratch = new Int32Array(MAX_UNITS);
const KIND_CLASS = KINDS.map((k) => k.cls);

// Direct-line checks for units on a move order are repeated every 16 ticks, staggered by id.
const DIRECT_RECHECK_MASK = 15;
// A "way to the nearest enemy" field is rebuilt at most this often, and only while some
// unit of that team and class has a target it cannot walk straight at.
const CHASE_REFRESH = 40;
// How far (in path cost, 10 per cell) a unit will route around an obstacle to reach an enemy.
const CHASE_LIMIT = 300;

/** Advance the world by exactly one tick, applying `commands` first, in order. */
export function step(w: World, commands: readonly Command[]): void {
  for (let c = 0; c < commands.length; c++) applyCommand(w, commands[c]);
  updateWander(w);
  bucket(w, CELL_SHIFT, GRID_DIM, cellStart, sorted);
  bucket(w, COARSE_SHIFT, COARSE_DIM, coarseStart, coarseSorted);
  updateChaseFields(w);
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

/**
 * Send units to a formation centred on (cx, cy): a block about twice as wide as deep that
 * faces the direction of travel, vehicles in the front rows. Units take the slot that
 * matches where they already stand relative to the group, so paths do not cross, and all
 * move at the pace of the slowest so the shape holds on the way.
 */
function orderFormationMove(w: World, units: readonly number[], cx: number, cy: number): void {
  const n = units.length;
  if (n === 0) return;
  let sumX = 0;
  let sumY = 0;
  let slowest = w.speed[units[0]];
  for (let k = 0; k < n; k++) {
    const id = units[k];
    sumX += w.posX[id];
    sumY += w.posY[id];
    if (w.speed[id] < slowest) slowest = w.speed[id];
  }
  const mx = Math.trunc(sumX / n);
  const my = Math.trunc(sumY / n);
  // Unit vector of travel (Q10); "side" is it turned a quarter: (-uy, ux).
  let ux = 0;
  let uy = 1024;
  const len = isqrt((cx - mx) * (cx - mx) + (cy - my) * (cy - my));
  if (len > fx(1)) {
    ux = Math.trunc(((cx - mx) * 1024) / len);
    uy = Math.trunc(((cy - my) * 1024) / len);
  }
  const order = units.slice();
  for (let k = 0; k < n; k++) {
    const id = order[k];
    const dx = w.posX[id] - mx;
    const dy = w.posY[id] - my;
    projForward[id] = Math.trunc((dx * ux + dy * uy) / 1024);
    projSide[id] = Math.trunc((dy * ux - dx * uy) / 1024);
  }
  order.sort((a, b) => w.kind[a] - w.kind[b] || projForward[b] - projForward[a] || a - b);
  let cols = isqrt(2 * n);
  if (cols * cols < 2 * n) cols++;
  if (cols > n) cols = n;
  const rows = Math.ceil(n / cols);
  for (let row = 0; row < rows; row++) {
    const line = order.slice(row * cols, (row + 1) * cols);
    line.sort((a, b) => projSide[a] - projSide[b] || a - b);
    // Halves keep the block centred using integers only.
    const ahead = ((rows - 1 - 2 * row) * FORMATION_SPACING) >> 1;
    for (let col = 0; col < line.length; col++) {
      const id = line[col];
      const side = ((2 * col - (line.length - 1)) * FORMATION_SPACING) >> 1;
      w.targetX[id] = cx + Math.trunc((ux * ahead - uy * side) / 1024);
      w.targetY[id] = cy + Math.trunc((uy * ahead + ux * side) / 1024);
      w.orderSpeed[id] = slowest;
    }
  }
  routeUnits(w, units, cx, cy);
}

/**
 * Start `units` toward their (already chosen) targets. A target on ground the unit cannot
 * enter moves to the nearest ground it can. Units with a clear straight line just walk it;
 * the others share one flowfield per movement class to (gx, gy).
 */
function routeUnits(w: World, units: readonly number[], gx: number, gy: number): void {
  const map = w.map;
  const goal = cellOfPos(clampInt(gx, 0, POS_MAX), clampInt(gy, 0, POS_MAX));
  for (let k = 0; k < units.length; k++) {
    const id = units[k];
    const cls = KIND_CLASS[w.kind[id]];
    let tx = clampInt(w.targetX[id], 0, POS_MAX);
    let ty = clampInt(w.targetY[id], 0, POS_MAX);
    const cell = cellOfPos(tx, ty);
    if (map.cost[cls][cell] === 0) {
      const to = map.snap[cls][cell];
      tx = ((to & (MAP_CELLS - 1)) << CELL_SHIFT) + (CELL_FX >> 1);
      ty = ((to >> 8) << CELL_SHIFT) + (CELL_FX >> 1);
    }
    w.targetX[id] = tx;
    w.targetY[id] = ty;
    // The field itself is only built when a unit first needs it (see steer).
    w.goal[id] = map.snap[cls][goal];
    w.path[id] = -1;
    const direct = clearLine(map, cls, w.posX[id], w.posY[id], tx, ty);
    w.flags[id] = (w.flags[id] & ~FLAG_DIRECT) | FLAG_MOVING | (direct ? FLAG_DIRECT : 0);
  }
}

/**
 * A flowfield to `goal` for movement class `cls`: an existing one if there is one, else
 * built in a slot no moving unit still uses. Returns -1 if every slot is in use (the unit
 * then walks straight, as before pathfinding existed).
 */
function acquireField(w: World, goal: number, cls: number): number {
  for (let f = 0; f < MAX_FIELDS; f++) {
    if (w.fieldGoal[f] === goal && w.fieldClass[f] === cls) return f;
  }
  if (w.fieldsFullTick === w.tick) return -1;
  fieldRefs.fill(0);
  for (let i = 0; i < w.count; i++) {
    if (w.state[i] === STATE_ALIVE && (w.flags[i] & FLAG_MOVING) !== 0 && w.path[i] >= 0) {
      fieldRefs[w.path[i]]++;
    }
  }
  let slot = -1;
  for (let f = 0; f < MAX_FIELDS && slot < 0; f++) if (w.fieldGoal[f] < 0) slot = f;
  for (let f = 0; f < MAX_FIELDS && slot < 0; f++) if (fieldRefs[f] === 0) slot = f;
  if (slot < 0) {
    w.fieldsFullTick = w.tick;
    return -1;
  }
  const dist = (w.fieldDist[slot] ??= newField());
  goalScratch[0] = goal;
  buildField(w.map, cls, dist, goalScratch, 1, UNREACHABLE - 1);
  w.fieldGoal[slot] = goal;
  w.fieldClass[slot] = cls;
  return slot;
}

/**
 * Units whose target is behind an obstacle follow a field that leads to the nearest enemy
 * by walkable route. Such a field exists per team and movement class, and is refreshed only
 * while someone needs it (at most one per tick, to spread the cost).
 */
function updateChaseFields(w: World): void {
  for (let f = 0; f < CHASE_FIELDS; f++) {
    if (w.chaseWanted[f] < w.tick - 1) continue;
    if (w.chaseBuilt[f] >= 0 && w.tick - w.chaseBuilt[f] < CHASE_REFRESH) continue;
    const team = Math.trunc(f / CLASS_COUNT);
    let n = 0;
    for (let i = 0; i < w.count; i++) {
      if (w.state[i] === STATE_ALIVE && w.team[i] !== team) {
        goalScratch[n++] = cellOfPos(w.posX[i], w.posY[i]);
      }
    }
    const dist = (w.chaseDist[f] ??= newField());
    buildField(w.map, f % CLASS_COUNT, dist, goalScratch, n, CHASE_LIMIT);
    w.chaseBuilt[f] = w.tick;
    return;
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
  const cls = kind.cls;
  const map = w.map;
  spawned.length = 0;
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
    const cell = cellOfPos(w.posX[id], w.posY[id]);
    if (map.cost[cls][cell] === 0) {
      // Not ground this unit can stand on: use the nearest cell that is.
      const to = map.snap[cls][cell];
      w.posX[id] = ((to & (MAP_CELLS - 1)) << CELL_SHIFT) + (w.posX[id] & (CELL_FX - 1));
      w.posY[id] = ((to >> 8) << CELL_SHIFT) + (w.posY[id] & (CELL_FX - 1));
    }
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
    w.orderSpeed[id] = w.speed[id];
    w.path[id] = -1;
    w.goal[id] = 0;
    w.flags[id] = wanderFlag(cmd.wander && !advance);
    if (advance) {
      w.targetX[id] = w.posX[id] + ax;
      w.targetY[id] = w.posY[id] + ay;
      w.flags[id] = FLAG_AMOVE;
      spawned.push(id);
    }
  }
  if (advance) routeUnits(w, spawned, cx + ax, cy + ay);
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
 * id) that is not concealed by forest. Reads only positions, which do not change during this pass, so the result does not
 * depend on iteration order.
 */
function acquireTargets(w: World): void {
  const n = w.count;
  const tick = w.tick;
  const terrain = w.map.type;
  for (let i = 0; i < n; i++) {
    if (w.state[i] !== STATE_ALIVE) continue;
    const x = w.posX[i];
    const y = w.posY[i];
    const t = w.attack[i];
    let valid = false;
    if (t !== NO_TARGET && w.state[t] === STATE_ALIVE && w.team[t] !== w.team[i]) {
      const dx = w.posX[t] - x;
      const dy = w.posY[t] - y;
      const d2 = dx * dx + dy * dy;
      valid =
        d2 <= ACQUIRE_RANGE_SQ &&
        (d2 <= CONCEAL_RANGE_SQ || terrain[cellOfPos(w.posX[t], w.posY[t])] !== T_FOREST);
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
        if (d2 >= bestD && (d2 > bestD || j >= best)) continue;
        // Units in forest are concealed: they can only be spotted from close by.
        if (d2 > CONCEAL_RANGE_SQ && terrain[cellOfPos(w.posX[j], w.posY[j])] === T_FOREST) {
          continue;
        }
        {
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
 * going and only shoots what happens to be in range. Either way the unit walks a straight
 * line when the ground allows it and follows a flowfield around obstacles when not.
 */
function steer(w: World): void {
  const n = w.count;
  const map = w.map;
  const tick = w.tick;
  for (let i = 0; i < n; i++) {
    if (w.state[i] !== STATE_ALIVE) continue;
    let flags = w.flags[i];
    const cls = KIND_CLASS[w.kind[i]];
    const x = w.posX[i];
    const y = w.posY[i];
    const cell = cellOfPos(x, y);
    const s = w.speed[i];
    let vx = 0;
    let vy = 0;
    let busy = false;
    const t = w.attack[i];
    if (
      t !== NO_TARGET &&
      ((flags & FLAG_MOVING) === 0 || (flags & (FLAG_AMOVE | FLAG_WANDER)) !== 0)
    ) {
      const dx = w.posX[t] - x;
      const dy = w.posY[t] - y;
      const d2 = dx * dx + dy * dy;
      const range = KINDS[w.kind[i]].range;
      if (d2 <= range * range) {
        busy = true;
      } else if (clearLine(map, cls, x, y, w.posX[t], w.posY[t])) {
        const dist = isqrt(d2);
        vx = Math.trunc((dx * s) / dist);
        vy = Math.trunc((dy * s) / dist);
        busy = true;
      } else {
        // Something is in the way: take the walkable route to the nearest enemy, if any.
        const f = w.team[i] * CLASS_COUNT + cls;
        w.chaseWanted[f] = tick;
        const field = w.chaseDist[f];
        const dir = field ? flowDirection(map, cls, field, cell) : -1;
        if (dir >= 0) {
          vx = Math.trunc((DIR_X[dir] * s) / 1024);
          vy = Math.trunc((DIR_Y[dir] * s) / 1024);
          busy = true;
        }
      }
    }
    if (!busy && (flags & FLAG_MOVING) !== 0) {
      const pace = w.orderSpeed[i] < s ? w.orderSpeed[i] : s;
      const tx = w.targetX[i];
      const ty = w.targetY[i];
      if (((tick + i) & DIRECT_RECHECK_MASK) === 0) {
        flags = clearLine(map, cls, x, y, tx, ty) ? flags | FLAG_DIRECT : flags & ~FLAG_DIRECT;
        w.flags[i] = flags;
      }
      let field = -1;
      if ((flags & FLAG_DIRECT) === 0) {
        field = w.path[i];
        if (field < 0) field = w.path[i] = acquireField(w, w.goal[i], cls);
      }
      if (field < 0) {
        const dx = tx - x;
        const dy = ty - y;
        const dist = isqrt(dx * dx + dy * dy);
        if (dist <= pace) {
          vx = dx;
          vy = dy;
          w.flags[i] = flags & ~(FLAG_MOVING | FLAG_AMOVE | FLAG_DIRECT);
        } else {
          vx = Math.trunc((dx * pace) / dist);
          vy = Math.trunc((dy * pace) / dist);
        }
      } else {
        const dir = flowDirection(map, cls, w.fieldDist[field]!, cell);
        if (dir >= 0) {
          vx = Math.trunc((DIR_X[dir] * pace) / 1024);
          vy = Math.trunc((DIR_Y[dir] * pace) / 1024);
        } else {
          // At the field's goal with no clear line to the unit's own spot (or cut off from
          // the goal altogether): this is as close as it gets.
          w.flags[i] = flags & ~(FLAG_MOVING | FLAG_AMOVE | FLAG_DIRECT);
        }
      }
    }
    if (map.cost[cls][cell] > 1) {
      // Slow ground (infantry in forest).
      vx = Math.trunc(vx / 2);
      vy = Math.trunc(vy / 2);
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
  const map = w.map;
  for (let i = 0; i < n; i++) {
    if (w.state[i] !== STATE_ALIVE) continue;
    const x = w.posX[i];
    const y = w.posY[i];
    let nx = clampInt(x + w.velX[i] + pushX[i], 0, POS_MAX);
    let ny = clampInt(y + w.velY[i] + pushY[i], 0, POS_MAX);
    // Impassable ground is a hard wall: slide along it. (A unit that somehow stands on
    // impassable ground may move freely, so it can get off.)
    const cost = map.cost[KIND_CLASS[w.kind[i]]];
    if (cost[cellOfPos(nx, ny)] === 0 && cost[cellOfPos(x, y)] !== 0) {
      if (cost[cellOfPos(nx, y)] !== 0) ny = y;
      else if (cost[cellOfPos(x, ny)] !== 0) nx = x;
      else {
        nx = x;
        ny = y;
      }
    }
    w.posX[i] = nx;
    w.posY[i] = ny;
  }
}
