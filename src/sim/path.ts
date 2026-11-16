// Flowfield pathfinding. One Dijkstra pass from the goal over the terrain grid gives every
// cell its travel cost to the goal; any number of units then find their way by stepping to
// the cheapest neighbouring cell. Cost of a field is independent of how many units use it,
// which is what makes thousand-unit orders affordable.
import { CELL_COUNT, CELL_SHIFT, MAP_CELLS, type GameMap } from './map';

/** Cell offset of each of the eight directions. */
export const DIR_CELL = [
  1,
  MAP_CELLS + 1,
  MAP_CELLS,
  MAP_CELLS - 1,
  -1,
  -MAP_CELLS - 1,
  -MAP_CELLS,
  -MAP_CELLS + 1,
];

/** Cost of a cell the goal cannot be reached from (or that lies beyond the search limit). */
export const UNREACHABLE = 0xffff;
const W = MAP_CELLS;
const STRAIGHT = 10;
const DIAGONAL = 14;

// Neighbour order is part of the sim's behaviour (it breaks ties): E, SE, S, SW, W, NW, N, NE.
const NX = [1, 1, 0, -1, -1, -1, 0, 1];
const NY = [0, 1, 1, 1, 0, -1, -1, -1];
/** Unit vectors of the eight directions, Q10. */
export const DIR_X = [1024, 724, 0, -724, -1024, -724, 0, 724];
export const DIR_Y = [0, 724, 1024, 724, 0, -724, -1024, -724];

// Dijkstra with a bucket queue (Dial's algorithm): step costs are small integers, so the
// frontier lives in 32 buckets indexed by cost modulo 32. Entries are (cell) records in
// linked lists; a cell improved twice leaves a stale entry behind that is skipped on pop.
// The resulting costs are the true shortest costs, so they do not depend on pop order.
// A field work in the way costs WORK_COST a step (see the map), hence the many buckets.
const BUCKETS = 4096;
const bucketHead = new Int32Array(BUCKETS);
const entryCell = new Int32Array(CELL_COUNT * 8 + 8);
const entryNext = new Int32Array(CELL_COUNT * 8 + 8);

/** How many fields have been started in this process: a measuring aid, never part of the game. */
export const fieldStats = { builds: 0 };

/** `growField`'s answer once a field's search has nothing left to do. */
export const FIELD_DONE = 0x7fffffff;

/**
 * Fill `dist` with the travel cost from every cell to the nearest of `goals` for the
 * movement layer `layer` (see layerOf), not searching past `limit`. Diagonal steps never
 * cut a blocked corner. A field work in the way is a very expensive step, not a wall: the
 * route goes through one only if there is no way round.
 */
export function buildField(
  map: GameMap,
  layer: number,
  dist: Uint16Array,
  goals: ArrayLike<number>,
  goalCount: number,
  limit: number,
): void {
  seedField(map, layer, dist, goals, goalCount);
  growField(map, layer, dist, -1, -1, limit);
}

/**
 * Start a field that `growField` then searches as far as it is needed: every cell
 * unreached but the goals. The search so far is "settled up to -1".
 */
export function seedField(
  map: GameMap,
  layer: number,
  dist: Uint16Array,
  goals: ArrayLike<number>,
  goalCount: number,
): void {
  fieldStats.builds++;
  const cost = map.pathCost[layer];
  dist.fill(UNREACHABLE);
  for (let g = 0; g < goalCount; g++) if (cost[goals[g]] !== 0) dist[goals[g]] = 0;
}

/**
 * Carry on the search of a field whose costs are final up to `settled`, until the cost of
 * `cell` is final too and the search has gone a good way past it (-1: to the end).
 * Returns how far costs are now final, or FIELD_DONE.
 *
 * Dijkstra settles cells in order of cost, so a field searched in steps holds exactly the
 * same costs as one searched in one go, wherever it stopped: a cell the search has not
 * settled yet costs more than every settled one, and `flowDirection` at a settled cell
 * never steps to such a cell either way. Most move orders cross a fraction of the map, and
 * a search that stops past the units that asked for it costs that fraction.
 */
export function growField(
  map: GameMap,
  layer: number,
  dist: Uint16Array,
  settled: number,
  cell: number,
  limit: number,
): number {
  const cost = map.pathCost[layer];
  const hard = map.cost[layer];
  bucketHead.fill(-1);
  let entries = 0;
  let pending = 0;
  // The frontier is every cell reached but not settled: its cost so far is in `dist`.
  for (let c = 0; c < CELL_COUNT; c++) {
    const v = dist[c];
    if (v <= settled || v === UNREACHABLE) continue;
    const nb = v & (BUCKETS - 1);
    entryCell[entries] = c;
    entryNext[entries] = bucketHead[nb];
    bucketHead[nb] = entries++;
    pending++;
  }
  let stopAt = -1;
  // Offsets of the eight neighbours.
  const off = DIR_CELL;
  for (let d = settled + 1; pending > 0; d++) {
    const b = d & (BUCKETS - 1);
    for (let e = bucketHead[b]; e >= 0; e = entryNext[e]) {
      pending--;
      const c = entryCell[e];
      if (dist[c] !== d) continue;
      const x = c & (W - 1);
      const y = c >> 8;
      // Away from the edge of the map no neighbour needs a bounds check.
      const inside = x > 0 && y > 0 && x < W - 1 && y < W - 1;
      for (let k = 0; k < 8; k++) {
        if (!inside) {
          const nx = x + NX[k];
          const ny = y + NY[k];
          if (nx < 0 || ny < 0 || nx >= W || ny >= W) continue;
        }
        const n = c + off[k];
        const step = cost[n];
        if (step === 0) continue;
        let nd: number;
        if ((k & 1) !== 0) {
          // A diagonal step never cuts a blocked corner.
          if (hard[c + NX[k]] === 0 || hard[c + NY[k] * W] === 0) continue;
          nd = d + DIAGONAL * step;
        } else nd = d + STRAIGHT * step;
        if (nd < dist[n] && nd <= limit) {
          dist[n] = nd;
          const nb = nd & (BUCKETS - 1);
          entryCell[entries] = n;
          entryNext[entries] = bucketHead[nb];
          bucketHead[nb] = entries++;
          pending++;
        }
      }
    }
    bucketHead[b] = -1;
    if (cell < 0) continue;
    if (stopAt < 0 && dist[cell] <= d) {
      // Settled: go on half as far again and some, so that the rest of the units of the
      // order, and the next order near here, seldom need the search carried on.
      stopAt = d + 600 + (d >> 1);
    }
    if (stopAt >= 0 && d >= stopAt && pending > 0) return d;
  }
  return FIELD_DONE;
}

/**
 * Direction (0..7, see DIR_X/DIR_Y) to step from `cell` toward the field's goal, or -1 at
 * the goal or where the goal cannot be reached.
 */
export function flowDirection(
  map: GameMap,
  layer: number,
  dist: Uint16Array,
  cell: number,
): number {
  const cost = map.cost[layer];
  const x = cell & (W - 1);
  const y = cell >> 8;
  let best = dist[cell];
  let dir = -1;
  for (let k = 0; k < 8; k++) {
    const nx = x + NX[k];
    const ny = y + NY[k];
    if (nx < 0 || ny < 0 || nx >= W || ny >= W) continue;
    const n = ny * W + nx;
    if (dist[n] >= best) continue;
    if ((k & 1) !== 0 && (cost[cell + NX[k]] === 0 || cost[cell + NY[k] * W] === 0)) {
      continue;
    }
    best = dist[n];
    dir = k;
  }
  return dir;
}

const HALF_CELL_SHIFT = CELL_SHIFT - 1;

/** True if units of `layer` can walk the straight line between two points (sampled every half cell). */
export function clearLine(
  map: GameMap,
  layer: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  const cost = map.cost[layer];
  const dx = x1 - x0;
  const dy = y1 - y0;
  const ax = dx < 0 ? -dx : dx;
  const ay = dy < 0 ? -dy : dy;
  const steps = ((ax > ay ? ax : ay) >> HALF_CELL_SHIFT) + 1;
  for (let k = 1; k <= steps; k++) {
    const x = x0 + Math.trunc((dx * k) / steps);
    const y = y0 + Math.trunc((dy * k) / steps);
    if (cost[(y >> CELL_SHIFT) * W + (x >> CELL_SHIFT)] === 0) return false;
  }
  return true;
}

export function newField(): Uint16Array {
  return new Uint16Array(CELL_COUNT);
}
