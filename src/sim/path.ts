// Flowfield pathfinding. One Dijkstra pass from the goal over the terrain grid gives every
// cell its travel cost to the goal; any number of units then find their way by stepping to
// the cheapest neighbouring cell. Cost of a field is independent of how many units use it,
// which is what makes thousand-unit orders affordable.
import { CELL_COUNT, CELL_SHIFT, MAP_CELLS, type GameMap } from './map';

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
const BUCKETS = 32;
const bucketHead = new Int32Array(BUCKETS);
const entryCell = new Int32Array(CELL_COUNT * 8 + 8);
const entryNext = new Int32Array(CELL_COUNT * 8 + 8);

/**
 * Fill `dist` with the travel cost from every cell to the nearest of `goals` for movement
 * class `cls`, not searching past `limit`. Diagonal steps never cut a blocked corner.
 */
export function buildField(
  map: GameMap,
  cls: number,
  dist: Uint16Array,
  goals: ArrayLike<number>,
  goalCount: number,
  limit: number,
): void {
  const cost = map.cost[cls];
  dist.fill(UNREACHABLE);
  bucketHead.fill(-1);
  let entries = 0;
  let pending = 0;
  for (let g = 0; g < goalCount; g++) {
    const c = goals[g];
    if (cost[c] === 0 || dist[c] === 0) continue;
    dist[c] = 0;
    entryCell[entries] = c;
    entryNext[entries] = bucketHead[0];
    bucketHead[0] = entries++;
    pending++;
  }
  for (let d = 0; pending > 0; d++) {
    const b = d & (BUCKETS - 1);
    for (let e = bucketHead[b]; e >= 0; e = entryNext[e]) {
      pending--;
      const c = entryCell[e];
      if (dist[c] !== d) continue;
      const x = c & (W - 1);
      const y = c >> 8;
      for (let k = 0; k < 8; k++) {
        const nx = x + NX[k];
        const ny = y + NY[k];
        if (nx < 0 || ny < 0 || nx >= W || ny >= W) continue;
        const n = ny * W + nx;
        const step = cost[n];
        if (step === 0) continue;
        const diagonal = (k & 1) !== 0;
        if (diagonal && (cost[c + NX[k]] === 0 || cost[c + NY[k] * W] === 0)) continue;
        const nd = d + (diagonal ? DIAGONAL : STRAIGHT) * step;
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
  }
}

/**
 * Direction (0..7, see DIR_X/DIR_Y) to step from `cell` toward the field's goal, or -1 at
 * the goal or where the goal cannot be reached.
 */
export function flowDirection(map: GameMap, cls: number, dist: Uint16Array, cell: number): number {
  const cost = map.cost[cls];
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

/** True if class `cls` can walk the straight line between two points (sampled every half cell). */
export function clearLine(
  map: GameMap,
  cls: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  const cost = map.cost[cls];
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
