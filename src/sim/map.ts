// The battlefield: an integer heightfield plus a terrain type per 4-unit cell. Generated
// from the seed with integer arithmetic only, so the simulation (passability) and every
// client (what is drawn) derive the identical map without sending it over the wire.
import { FP_SHIFT, clampInt, fx } from './fixed';

// Map is a square of MAP_SIZE world units. Sim (x, y) maps to render (x, z).
export const MAP_SIZE = 1024;
export const MAP_SIZE_FX = fx(MAP_SIZE);
/** Terrain cells are 4 world units: the same grid the sim uses for collisions. */
export const CELL_SHIFT = FP_SHIFT + 2;
export const CELL_FX = 1 << CELL_SHIFT;
export const MAP_CELLS = MAP_SIZE >> 2;
export const MAP_VERTS = MAP_CELLS + 1;
export const CELL_COUNT = MAP_CELLS * MAP_CELLS;

export const T_OPEN = 0;
/** Blocks vehicles; infantry passes at half speed and is hard to spot (see sim). */
export const T_FOREST = 1;
export const T_WATER = 2;
export const T_CLIFF = 3;
/** Shallow water: everyone can cross. */
export const T_FORD = 4;

/** Movement classes: each has its own passability and therefore its own flowfields. */
export const CLASS_VEHICLE = 0;
export const CLASS_FOOT = 1;
export const CLASS_COUNT = 2;

/** Height of the water surface, for drawing. */
export const WATER_LEVEL = fx(-0.4);

export interface GameMap {
  /** Height per grid vertex (MAP_VERTS squared), fixed-point world units. */
  heights: Int32Array;
  /** Terrain type per cell (T_*). */
  type: Uint8Array;
  /**
   * Per movement class and cell: 0 = cannot enter, otherwise the cost multiplier of
   * crossing it. Cells cut off from the main connected area count as impassable, so any
   * two passable cells of a class are always connected.
   */
  cost: Uint8Array[];
  /** Per class and cell: the nearest passable cell (itself when passable). */
  snap: Int32Array[];
  hash: number;
}

function lattice(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) & 1023;
}

/** Smoothstep on Q10: 0..1024 in, 0..1024 out. */
function smooth(t: number): number {
  return (t * t * (3072 - 2 * t)) >> 20;
}

/** Value noise in 0..1023 with a lattice every 2^shift grid steps. Integers only. */
function noise(x: number, y: number, shift: number, seed: number): number {
  const xi = x >> shift;
  const yi = y >> shift;
  const mask = (1 << shift) - 1;
  const sx = smooth(((x & mask) << 10) >> shift);
  const sy = smooth(((y & mask) << 10) >> shift);
  const a = lattice(xi, yi, seed);
  const b = lattice(xi + 1, yi, seed);
  const c = lattice(xi, yi + 1, seed);
  const d = lattice(xi + 1, yi + 1, seed);
  const top = a + (((b - a) * sx) >> 10);
  const bottom = c + (((d - c) * sx) >> 10);
  return top + (((bottom - top) * sy) >> 10);
}

const FORD_COUNT = 5;
const RIVER_HALF_WIDTH = fx(7);
const MESA_HEIGHT = fx(9);
const HALF = fx(MAP_SIZE / 2);

/** Build the map for a seed: rolling ground, a river with fords, mesas, lakes, forests. */
export function generateMap(seed: number): GameMap {
  const s = seed | 0;
  const heights = new Int32Array(MAP_VERTS * MAP_VERTS);
  const fords: number[] = [];
  for (let k = 0; k < FORD_COUNT; k++) {
    // Evenly spread with some jitter; the middle one stays near the centre of the map.
    const jitter = k === 2 ? 3 : 10;
    fords.push(26 + k * 51 + (lattice(k, 77, s) % (2 * jitter + 1)) - jitter);
  }

  for (let vy = 0; vy < MAP_VERTS; vy++) {
    // The river runs north-south and meanders around the middle of the map.
    const meander = (noise(5, vy, 6, s + 1) * 2 + noise(9, vy, 5, s + 2)) / 3;
    const riverX = HALF + Math.trunc(meander - 512) * 170;
    let ford = 0;
    for (let k = 0; k < FORD_COUNT; k++) {
      const d = vy > fords[k] ? vy - fords[k] : fords[k] - vy;
      const f = clampInt(1024 - (d - 2) * 256, 0, 1024);
      if (f > ford) ford = f;
    }
    const bank = fx(8) + ((fx(26) * ford) >> 10);
    const bed = fx(-2.6) + ((fx(2.1) * ford) >> 10);
    for (let vx = 0; vx < MAP_VERTS; vx++) {
      const base =
        (noise(vx, vy, 6, s) * 8 +
          noise(vx, vy, 5, s + 3) * 4 +
          noise(vx, vy, 4, s + 4) * 2 +
          noise(vx, vy, 3, s + 5)) /
        15;
      let h = Math.trunc(base - 512) * 20 + fx(3.2);
      // Raise the middle of the map a little so the central crossing is a ford, not a lake.
      const mxc = vx - (MAP_VERTS >> 1);
      const myc = vy - (MAP_VERTS >> 1);
      const centre = clampInt(1024 - ((mxc * mxc + myc * myc) >> 1), 0, 1024);
      h += (fx(3) * centre) >> 10;
      const dx = vx * CELL_FX - riverX;
      const dist = dx < 0 ? -dx : dx;

      // Mesas: plateaus whose edge is a cliff in most places and a climbable ramp in others.
      const m = Math.trunc((noise(vx, vy, 6, s + 11) * 2 + noise(vx, vy, 5, s + 12)) / 3);
      const steep = clampInt(128 - (noise(vx, vy, 5, s + 13) - 380) * 3, 8, 128);
      const plateau = smooth(clampInt((m - 610) * steep, 0, 1024));
      const away = clampInt(Math.trunc(((dist - fx(40)) * 1024) / fx(50)), 0, 1024);
      h += (((MESA_HEIGHT * plateau) >> 10) * away) >> 10;

      // Carve the river: flat bed, banks that are steep except at the fords.
      if (dist < RIVER_HALF_WIDTH + bank) {
        const t =
          dist <= RIVER_HALF_WIDTH
            ? 0
            : smooth(Math.trunc(((dist - RIVER_HALF_WIDTH) * 1024) / bank));
        const carved = bed + (((h - bed) * t) >> 10);
        if (carved < h) h = carved;
      }
      heights[vy * MAP_VERTS + vx] = h;
    }
  }

  const type = new Uint8Array(CELL_COUNT);
  const clearing = fx(75) * fx(75);
  for (let cy = 0; cy < MAP_CELLS; cy++) {
    for (let cx = 0; cx < MAP_CELLS; cx++) {
      const v = cy * MAP_VERTS + cx;
      const a = heights[v];
      const b = heights[v + 1];
      const c = heights[v + MAP_VERTS];
      const d = heights[v + MAP_VERTS + 1];
      const avg = (a + b + c + d) >> 2;
      const lo = Math.min(a, b, c, d);
      const hi = Math.max(a, b, c, d);
      let t = T_OPEN;
      if (avg < fx(-1)) t = T_WATER;
      else if (hi - lo > fx(2.6)) t = T_CLIFF;
      else if (avg < fx(-0.25)) t = T_FORD;
      else if (avg > fx(0.4)) {
        const f =
          (noise(cx, cy, 5, s + 21) * 2 + noise(cx, cy, 4, s + 22) + noise(cx, cy, 3, s + 23)) / 4;
        // Keep the two deployment areas either side of the centre clear of trees.
        const px = cx * CELL_FX - HALF;
        const py = cy * CELL_FX - HALF;
        const east = (px - fx(110)) * (px - fx(110)) + py * py;
        const west = (px + fx(110)) * (px + fx(110)) + py * py;
        if (f > 610 && east > clearing && west > clearing) t = T_FOREST;
      }
      type[cy * MAP_CELLS + cx] = t;
    }
  }
  return finishMap(heights, type);
}

/** Featureless open ground, for tests that are about something other than terrain. */
export function flatMap(): GameMap {
  return finishMap(new Int32Array(MAP_VERTS * MAP_VERTS).fill(fx(1)), new Uint8Array(CELL_COUNT));
}

function finishMap(heights: Int32Array, type: Uint8Array): GameMap {
  const cost: Uint8Array[] = [];
  const snap: Int32Array[] = [];
  for (let cls = 0; cls < CLASS_COUNT; cls++) {
    const c = new Uint8Array(CELL_COUNT);
    for (let i = 0; i < CELL_COUNT; i++) {
      const t = type[i];
      if (t === T_OPEN || t === T_FORD) c[i] = 1;
      else if (t === T_FOREST && cls === CLASS_FOOT) c[i] = 2;
    }
    keepMainArea(c);
    cost.push(c);
    snap.push(nearestPassable(c));
  }
  let hash = 0x811c9dc5;
  for (let i = 0; i < CELL_COUNT; i++) hash = Math.imul(hash ^ type[i], 0x01000193);
  for (let i = 0; i < heights.length; i++) hash = Math.imul(hash ^ heights[i], 0x01000193);
  return { heights, type, cost, snap, hash: hash >>> 0 };
}

const queue = new Int32Array(CELL_COUNT);

/** Visit the 4-connected neighbours of the queued cells, breadth first. */
function flood(count: number, visit: (from: number, to: number) => boolean): number {
  let head = 0;
  let tail = count;
  while (head < tail) {
    const c = queue[head++];
    const x = c & (MAP_CELLS - 1);
    if (x > 0 && visit(c, c - 1)) queue[tail++] = c - 1;
    if (x < MAP_CELLS - 1 && visit(c, c + 1)) queue[tail++] = c + 1;
    if (c >= MAP_CELLS && visit(c, c - MAP_CELLS)) queue[tail++] = c - MAP_CELLS;
    if (c < CELL_COUNT - MAP_CELLS && visit(c, c + MAP_CELLS)) queue[tail++] = c + MAP_CELLS;
  }
  return tail;
}

/** Zero the cost of every passable cell outside the largest connected area. */
function keepMainArea(cost: Uint8Array): void {
  const label = new Int32Array(CELL_COUNT);
  let labels = 0;
  let best = 0;
  let bestSize = 0;
  for (let i = 0; i < CELL_COUNT; i++) {
    if (cost[i] === 0 || label[i] !== 0) continue;
    const id = ++labels;
    label[i] = id;
    queue[0] = i;
    const size = flood(1, (_from, to) => {
      if (cost[to] === 0 || label[to] !== 0) return false;
      label[to] = id;
      return true;
    });
    if (size > bestSize) {
      bestSize = size;
      best = id;
    }
  }
  for (let i = 0; i < CELL_COUNT; i++) if (label[i] !== best) cost[i] = 0;
}

function nearestPassable(cost: Uint8Array): Int32Array {
  const snap = new Int32Array(CELL_COUNT).fill(-1);
  let n = 0;
  for (let i = 0; i < CELL_COUNT; i++) {
    if (cost[i] === 0) continue;
    snap[i] = i;
    queue[n++] = i;
  }
  if (n === 0) return snap.fill(0);
  flood(n, (from, to) => {
    if (snap[to] !== -1) return false;
    snap[to] = snap[from];
    return true;
  });
  return snap;
}

export function cellOfPos(x: number, y: number): number {
  return (y >> CELL_SHIFT) * MAP_CELLS + (x >> CELL_SHIFT);
}
