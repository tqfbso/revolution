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
/** Shallow water: everyone can cross, slowly. */
export const T_FORD = 4;
/** A standing building: nobody walks through it, nobody sees or shoots through it. */
export const T_BUILDING = 5;
/** Bridge deck: the fast way across the river while it stands. */
export const T_BRIDGE = 6;
/** A collapsed building. Infantry can pick its way through and finds cover; vehicles cannot. */
export const T_RUBBLE = 7;

export const S_BUILDING = 0;
export const S_BRIDGE = 1;
/** A base building put up by an army during the game (see src/sim/economy.ts). */
export const S_BASE = 2;
export const MAX_STRUCTS = 512;
/** Resource sites: stockpiles of supplies (finite) and oil wells (slow but endless). */
export const SITE_SUPPLIES = 0;
export const SITE_FUEL = 1;
export const MAX_SITES = 32;
export const MAX_TOWNS = 8;
/** Height of one storey, for sight from upper floors and for drawing. */
export const FLOOR_HEIGHT = fx(0.85);

/** Movement classes: each has its own passability and therefore its own flowfields. */
export const CLASS_VEHICLE = 0;
export const CLASS_FOOT = 1;
/** Flies: goes anywhere, in a straight line. */
export const CLASS_AIR = 2;
export const CLASS_COUNT = 3;

/** Height of the water surface, for drawing. */
export const WATER_LEVEL = fx(-0.4);

export interface GameMap {
  /** Height per grid vertex (MAP_VERTS squared), fixed-point world units. */
  heights: Int32Array;
  /**
   * Terrain type per cell (T_*). Changes during a game when a building collapses or a bridge
   * is cut or repaired; call refreshPassability() afterwards. A world owns its map.
   */
  type: Uint8Array;
  /** The natural terrain under each cell, before anything was built on it. */
  baseType: Uint8Array;
  /**
   * Structures: buildings and bridges, each a rectangle of cells. The layout is fixed; what
   * changes during a game (health, who is inside) lives in the world.
   */
  structCount: number;
  sKind: Uint8Array;
  sX: Int32Array;
  sY: Int32Array;
  sW: Int32Array;
  sH: Int32Array;
  /** Town the structure belongs to, or -1. */
  sTown: Int8Array;
  sFloors: Uint8Array;
  sMaxHp: Int32Array;
  /** Height of the ground floor (building) or of the west end of the deck (bridge). */
  sBase: Int32Array;
  /** Bridges: height of the east end of the deck. The deck slopes evenly between the two. */
  sEast: Int32Array;
  /** Structure occupying each cell, or -1. Stays set after the structure is destroyed. */
  structAt: Int16Array;
  /** Towns: capture zones, each a circle (centre and radius, fixed-point). */
  townCount: number;
  townX: Int32Array;
  townY: Int32Array;
  townR: Int32Array;
  townName: string[];
  /**
   * Per movement class and cell: 0 = cannot enter, otherwise the cost multiplier of
   * crossing it. Cells cut off from the main connected area count as impassable, so any
   * two passable cells of a class are always connected.
   */
  cost: Uint8Array[];
  /** Per class and cell: the nearest passable cell (itself when passable). */
  snap: Int32Array[];
  /**
   * Smoke: per cell, the tick until which it stands there, and the current tick (kept here
   * by the sim so that lineOfSight can tell). Smoke more than a cell deep stops the eye.
   */
  smoke: Int32Array;
  now: number;
  hash: number;
  /**
   * Resource sites: a point each (the centre of a cell), what it holds and how much it
   * starts with. What is left of it lives in the world.
   */
  siteCount: number;
  siteX: Int32Array;
  siteY: Int32Array;
  siteKind: Uint8Array;
  siteStock: Int32Array;
  /** Where each of the two armies sets up: the north-west cell of its headquarters plot. */
  startX: Int32Array;
  startY: Int32Array;
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
    const riverX = riverXAt(vy, s);
    let ford = 0;
    for (let k = 0; k < FORD_COUNT; k++) {
      const d = vy > fords[k] ? vy - fords[k] : fords[k] - vy;
      const f = clampInt(1024 - (d - 2) * 256, 0, 1024);
      if (f > ford) ford = f;
    }
    const bank = fx(8) + ((fx(26) * ford) >> 10);
    // At a ford the bed rises just above the water surface, so it shows as a muddy strip you
    // can see across, not as river with units swimming in it.
    const bed = fx(-2.6) + ((fx(2.25) * ford) >> 10);
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
      if (avg < fx(-0.6)) t = T_WATER;
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
  const map = newMap(heights, type);
  // The three middle fords each get a bridge just upstream and a settlement on both banks:
  // a town at the central crossing, villages at the other two. The outer fords stay bare.
  placeCrossing(map, s, fords[2] - 9, 4, 2, 'Central');
  placeCrossing(map, s, fords[1] - 9, 3, 1, 'North');
  placeCrossing(map, s, fords[3] - 9, 3, 1, 'South');
  finishMap(map);
  placeSites(map);
  return map;
}

/** Side of the headquarters plot, in cells. */
export const START_PLOT = 3;

/**
 * True if a base building may stand on the cell rectangle: the plot and a ring of one cell
 * around it are open ground (so buildings never touch anything and can never wall the map
 * in two), the ground is nearly level, and no resource site is under or right next to it.
 */
export function canPlace(map: GameMap, x: number, y: number, w: number, h: number): boolean {
  if (x < 2 || y < 2 || x + w > MAP_CELLS - 2 || y + h > MAP_CELLS - 2) return false;
  for (let j = y - 1; j <= y + h; j++) {
    for (let i = x - 1; i <= x + w; i++) if (map.type[j * MAP_CELLS + i] !== T_OPEN) return false;
  }
  let lo = map.heights[y * MAP_VERTS + x];
  let hi = lo;
  for (let j = y; j <= y + h; j++) {
    for (let i = x; i <= x + w; i++) {
      const v = map.heights[j * MAP_VERTS + i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (hi - lo > fx(2.2)) return false;
  for (let k = 0; k < map.siteCount; k++) {
    const sx = map.siteX[k] >> CELL_SHIFT;
    const sy = map.siteY[k] >> CELL_SHIFT;
    if (sx >= x - 2 && sx <= x + w + 1 && sy >= y - 2 && sy <= y + h + 1) return false;
  }
  return true;
}

/**
 * The nearest cell to (cx, cy), searching outward ring by ring in a fixed order, for which
 * `ok` holds. Returns -1 if there is none within `reach` cells.
 */
export function findCell(
  cx: number,
  cy: number,
  reach: number,
  ok: (x: number, y: number) => boolean,
): number {
  for (let r = 0; r <= reach; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx !== -r && dx !== r && dy !== -r && dy !== r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= MAP_CELLS || y >= MAP_CELLS) continue;
        if (ok(x, y)) return y * MAP_CELLS + x;
      }
    }
  }
  return -1;
}

/**
 * Where the two armies set up and what there is to haul, the same on both sides of the
 * river: two stockpiles and a well by each headquarters, a stockpile and a well a long
 * drive north and south of it, and the richest stockpiles and a well behind each of the
 * settlements on that bank, where the fighting is.
 */
function placeSites(map: GameMap): void {
  if (map.townCount < 6) return;
  const site = (kind: number, stock: number, wx: number, wy: number) => {
    if (map.siteCount >= MAX_SITES) return;
    const open = (x: number, y: number) => {
      if (x < 2 || y < 2 || x >= MAP_CELLS - 2 || y >= MAP_CELLS - 2) return false;
      for (let j = y - 1; j <= y + 1; j++) {
        for (let i = x - 1; i <= x + 1; i++) {
          const c = j * MAP_CELLS + i;
          if (map.type[c] !== T_OPEN || map.cost[CLASS_VEHICLE][c] === 0) return false;
        }
      }
      for (let k = 0; k < map.siteCount; k++) {
        const dx = (map.siteX[k] >> CELL_SHIFT) - x;
        const dy = (map.siteY[k] >> CELL_SHIFT) - y;
        if (dx * dx + dy * dy < 25) return false;
      }
      for (let t = 0; t < 2; t++) {
        const dx = x - map.startX[t];
        const dy = y - map.startY[t];
        if (dx >= -3 && dx <= START_PLOT + 2 && dy >= -3 && dy <= START_PLOT + 2) return false;
      }
      return true;
    };
    const cx = clampInt(wx >> CELL_SHIFT, 2, MAP_CELLS - 3);
    const cy = clampInt(wy >> CELL_SHIFT, 2, MAP_CELLS - 3);
    const c = findCell(cx, cy, 30, open);
    if (c < 0) return;
    const k = map.siteCount++;
    map.siteX[k] = ((c % MAP_CELLS) << CELL_SHIFT) + (CELL_FX >> 1);
    map.siteY[k] = (Math.trunc(c / MAP_CELLS) << CELL_SHIFT) + (CELL_FX >> 1);
    map.siteKind[k] = kind;
    map.siteStock[k] = stock;
  };
  for (let side = 0; side < 2; side++) {
    const dir = side === 0 ? -1 : 1;
    const hx = map.townX[side] + dir * fx(190);
    const hy = map.townY[side];
    const c = findCell(
      hx >> CELL_SHIFT,
      hy >> CELL_SHIFT,
      40,
      (x, y) =>
        canPlace(map, x, y, START_PLOT, START_PLOT) &&
        map.cost[CLASS_VEHICLE][y * MAP_CELLS + x - 1] !== 0,
    );
    if (c < 0) continue;
    map.startX[side] = c % MAP_CELLS;
    map.startY[side] = Math.trunc(c / MAP_CELLS);
  }
  for (let side = 0; side < 2; side++) {
    if (map.startX[side] < 0) continue;
    const dir = side === 0 ? -1 : 1;
    const bx = (map.startX[side] << CELL_SHIFT) + fx(6);
    const by = (map.startY[side] << CELL_SHIFT) + fx(6);
    site(SITE_SUPPLIES, 8000, bx + dir * fx(8), by - fx(36));
    site(SITE_SUPPLIES, 8000, bx - dir * fx(32), by + fx(20));
    site(SITE_FUEL, 200, bx + dir * fx(30), by + fx(26));
    for (const ns of [-1, 1]) {
      site(SITE_SUPPLIES, 12000, bx - dir * fx(10), by + ns * fx(150));
      site(SITE_FUEL, 200, bx + dir * fx(14), by + ns * fx(165));
    }
    for (let k = 0; k < 3; k++) {
      const t = 2 * k + side;
      const tx = map.townX[t] + dir * (map.townR[t] + fx(18));
      site(SITE_SUPPLIES, 16000, tx, map.townY[t] - fx(26));
      site(SITE_FUEL, 200, tx, map.townY[t] + fx(26));
    }
  }
}

/** Featureless open ground, for tests that are about something other than terrain. */
export function flatMap(): GameMap {
  return finishMap(
    newMap(new Int32Array(MAP_VERTS * MAP_VERTS).fill(fx(1)), new Uint8Array(CELL_COUNT)),
  );
}

function newMap(heights: Int32Array, type: Uint8Array): GameMap {
  return {
    heights,
    type,
    baseType: type.slice(),
    structCount: 0,
    sKind: new Uint8Array(MAX_STRUCTS),
    sX: new Int32Array(MAX_STRUCTS),
    sY: new Int32Array(MAX_STRUCTS),
    sW: new Int32Array(MAX_STRUCTS),
    sH: new Int32Array(MAX_STRUCTS),
    sTown: new Int8Array(MAX_STRUCTS).fill(-1),
    sFloors: new Uint8Array(MAX_STRUCTS),
    sMaxHp: new Int32Array(MAX_STRUCTS),
    sBase: new Int32Array(MAX_STRUCTS),
    sEast: new Int32Array(MAX_STRUCTS),
    structAt: new Int16Array(CELL_COUNT).fill(-1),
    townCount: 0,
    townX: new Int32Array(MAX_TOWNS),
    townY: new Int32Array(MAX_TOWNS),
    townR: new Int32Array(MAX_TOWNS),
    townName: [],
    cost: [],
    snap: [],
    smoke: new Int32Array(CELL_COUNT),
    now: 0,
    hash: 0,
    siteCount: 0,
    siteX: new Int32Array(MAX_SITES),
    siteY: new Int32Array(MAX_SITES),
    siteKind: new Uint8Array(MAX_SITES),
    siteStock: new Int32Array(MAX_SITES),
    startX: new Int32Array(2).fill(-1),
    startY: new Int32Array(2).fill(-1),
  };
}

function finishMap(map: GameMap): GameMap {
  refreshPassability(map);
  let hash = 0x811c9dc5;
  for (let i = 0; i < CELL_COUNT; i++) hash = Math.imul(hash ^ map.type[i], 0x01000193);
  for (let i = 0; i < map.heights.length; i++) {
    hash = Math.imul(hash ^ map.heights[i], 0x01000193);
  }
  map.hash = hash >>> 0;
  return map;
}

/** Recompute who can walk where from the terrain types. Call after changing `type`. */
export function refreshPassability(map: GameMap): void {
  const type = map.type;
  for (let cls = 0; cls < CLASS_COUNT; cls++) {
    const c = (map.cost[cls] ??= new Uint8Array(CELL_COUNT));
    for (let i = 0; i < CELL_COUNT; i++) {
      const t = type[i];
      let v = 0;
      if (t === T_OPEN || t === T_BRIDGE) v = 1;
      else if (t === T_FORD) v = 2;
      else if ((t === T_FOREST || t === T_RUBBLE) && cls === CLASS_FOOT) v = 2;
      c[i] = cls === CLASS_AIR ? 1 : v;
    }
    keepMainArea(c);
    map.snap[cls] = nearestPassable(c);
  }
}

/** Add a town: a circle that an army captures by being the only one inside it. */
export function addTown(map: GameMap, x: number, y: number, r: number, name: string): number {
  const t = map.townCount++;
  map.townX[t] = x;
  map.townY[t] = y;
  map.townR[t] = r;
  map.townName[t] = name;
  return t;
}

/**
 * Add a structure on the cell rectangle (x, y, w, h). Returns its id, or -1 if the table is
 * full. Callers that add structures after the map was finished must call
 * refreshPassability().
 */
export function addStructure(
  map: GameMap,
  kind: number,
  x: number,
  y: number,
  w: number,
  h: number,
  town: number,
  floors: number,
): number {
  if (map.structCount >= MAX_STRUCTS) return -1;
  const s = map.structCount++;
  map.sKind[s] = kind;
  map.sX[s] = x;
  map.sY[s] = y;
  map.sW[s] = w;
  map.sH[s] = h;
  map.sTown[s] = town;
  map.sFloors[s] = floors;
  map.sMaxHp[s] = kind === S_BRIDGE ? 2400 : 220 * w * h;
  // Buildings stand on the lowest corner of their plot; a deck spans at the higher bank.
  let lo = map.heights[y * MAP_VERTS + x];
  let hi = lo;
  for (let j = y; j <= y + h; j++) {
    for (let i = x; i <= x + w; i++) {
      const v = map.heights[j * MAP_VERTS + i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (kind === S_BRIDGE) {
    // Each end sits on its bank (the higher corner, so the deck never dips into the ground).
    const end = (vx: number) => {
      const a = map.heights[y * MAP_VERTS + vx];
      const b = map.heights[(y + h) * MAP_VERTS + vx];
      return (a > b ? a : b) + fx(0.2);
    };
    map.sBase[s] = end(x);
    map.sEast[s] = end(x + w);
  } else {
    map.sBase[s] = lo;
  }
  for (let j = y; j < y + h; j++) {
    for (let i = x; i < x + w; i++) map.baseType[j * MAP_CELLS + i] = map.type[j * MAP_CELLS + i];
  }
  stampStructure(map, s);
  return s;
}

/** Write a standing structure into the terrain types. */
export function stampStructure(map: GameMap, s: number): void {
  const t = map.sKind[s] === S_BRIDGE ? T_BRIDGE : T_BUILDING;
  for (let j = map.sY[s]; j < map.sY[s] + map.sH[s]; j++) {
    for (let i = map.sX[s]; i < map.sX[s] + map.sW[s]; i++) {
      map.type[j * MAP_CELLS + i] = t;
      map.structAt[j * MAP_CELLS + i] = s;
    }
  }
}

/** Write a destroyed structure into the terrain types: rubble, or the river as it was. */
export function razeStructure(map: GameMap, s: number): void {
  const bridge = map.sKind[s] === S_BRIDGE;
  for (let j = map.sY[s]; j < map.sY[s] + map.sH[s]; j++) {
    for (let i = map.sX[s]; i < map.sX[s] + map.sW[s]; i++) {
      const c = j * MAP_CELLS + i;
      map.type[c] = bridge ? map.baseType[c] : T_RUBBLE;
    }
  }
}

function riverXAt(vy: number, s: number): number {
  const meander = (noise(5, vy, 6, s + 1) * 2 + noise(9, vy, 5, s + 2)) / 3;
  return HALF + Math.trunc(meander - 512) * 170;
}

const LOT = 5;

/**
 * A crossing: a bridge over the river at cell row `row`, and on each bank a settlement of
 * `cols` by 2 x `rows` lots along a main street that leads onto the bridge.
 */
function placeCrossing(
  map: GameMap,
  seed: number,
  row: number,
  cols: number,
  rows: number,
  name: string,
): void {
  const type = map.type;
  const br = clampInt(row, 16, MAP_CELLS - 18);
  const rc = clampInt(riverXAt(br, seed) >> CELL_SHIFT, 30, MAP_CELLS - 31);
  const solid = (x: number, y: number) => {
    const t = type[y * MAP_CELLS + x];
    return t === T_OPEN || t === T_FOREST;
  };
  // Widest stretch of water and bank across the two rows of the deck.
  let x0 = rc;
  let x1 = rc;
  for (let y = br; y <= br + 1; y++) {
    let a = rc;
    while (a > 4 && !(solid(a, y) && solid(a - 1, y))) a--;
    let b = rc;
    while (b < MAP_CELLS - 5 && !(solid(b, y) && solid(b + 1, y))) b++;
    if (a < x0) x0 = a;
    if (b > x1) x1 = b;
  }
  for (let side = 0; side < 2; side++) {
    const base = side === 0 ? x0 - 2 - cols * LOT : x1 + 3;
    const cx = base + ((cols * LOT) >> 1);
    const town = addTown(
      map,
      (cx << CELL_SHIFT) + (CELL_FX >> 1),
      (br + 1) << CELL_SHIFT,
      fx(cols * LOT * 2 + 10),
      `${name} ${side === 0 ? 'West' : 'East'}`,
    );
    // Clear the trees off the whole settlement and the road onto the bridge.
    for (let y = br - rows * LOT - 2; y <= br + 3 + rows * LOT; y++) {
      for (let x = base - 2; x <= base + cols * LOT + 3; x++) {
        if (x < 0 || y < 0 || x >= MAP_CELLS || y >= MAP_CELLS) continue;
        if (type[y * MAP_CELLS + x] === T_FOREST) type[y * MAP_CELLS + x] = T_OPEN;
      }
    }
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < 2 * rows; j++) {
        // Lots north of the street (rows br-1 .. br+2 stay free) and south of it.
        const ly = j < rows ? br - 1 - LOT * (j + 1) : br + 3 + LOT * (j - rows);
        const lx = base + i * LOT;
        const h = lattice(lx, ly, seed + 31);
        if (h % 100 < 14) continue; // a yard, a square, a gap in the row
        const w = 2 + ((h >> 8) & 1);
        const d = 2 + ((h >> 9) & 1);
        const bx = lx + 1 + (w === 2 ? (h >> 7) & 1 : 0);
        const by = ly + 1 + (d === 2 ? (h >> 6) & 1 : 0);
        if (bx < 2 || by < 2 || bx + w > MAP_CELLS - 2 || by + d > MAP_CELLS - 2) continue;
        if (!levelPlot(map, bx, by, w, d)) continue;
        const floors = 2 + ((h >> 3) % 3) + (cols > 3 && j % rows === 0 ? 1 : 0);
        addStructure(map, S_BUILDING, bx, by, w, d, town, floors);
      }
    }
  }
  if (x1 - x0 <= 26) addStructure(map, S_BRIDGE, x0, br, x1 - x0 + 1, 2, -1, 0);
}

/** True if a building can stand on the plot; if so, levels the ground under it. */
function levelPlot(map: GameMap, x: number, y: number, w: number, h: number): boolean {
  for (let j = y; j < y + h; j++) {
    for (let i = x; i < x + w; i++) if (map.type[j * MAP_CELLS + i] !== T_OPEN) return false;
  }
  let lo = map.heights[y * MAP_VERTS + x];
  let hi = lo;
  let sum = 0;
  for (let j = y; j <= y + h; j++) {
    for (let i = x; i <= x + w; i++) {
      const v = map.heights[j * MAP_VERTS + i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      sum += v;
    }
  }
  if (hi - lo > fx(2.2)) return false;
  const level = Math.trunc(sum / ((w + 1) * (h + 1)));
  for (let j = y; j <= y + h; j++) {
    for (let i = x; i <= x + w; i++) map.heights[j * MAP_VERTS + i] = level;
  }
  return true;
}

/** Height of the deck of bridge `s` under world x. */
export function deckHeight(map: GameMap, s: number, x: number): number {
  const span = map.sW[s] << CELL_SHIFT;
  const along = clampInt(x - (map.sX[s] << CELL_SHIFT), 0, span);
  return map.sBase[s] + Math.trunc(((map.sEast[s] - map.sBase[s]) * along) / span);
}

/** Ground height at a point (bilinear over the grid vertices), fixed-point. */
export function heightAt(map: GameMap, x: number, y: number): number {
  const cx = x >> CELL_SHIFT;
  const cy = y >> CELL_SHIFT;
  const fxq = x & (CELL_FX - 1);
  const fyq = y & (CELL_FX - 1);
  const v = cy * MAP_VERTS + cx;
  const h = map.heights;
  const top = h[v] + (((h[v + 1] - h[v]) * fxq) >> CELL_SHIFT);
  const bottom =
    h[v + MAP_VERTS] + (((h[v + MAP_VERTS + 1] - h[v + MAP_VERTS]) * fxq) >> CELL_SHIFT);
  return top + (((bottom - top) * fyq) >> CELL_SHIFT);
}

/** How many half-cell steps of smoke a line of sight can pass through. */
const SMOKE_SIGHT_STEPS = 2;
/** How many half-cell steps of forest a line of sight can pass through. */
const FOREST_SIGHT_STEPS = 6;

/**
 * True line of sight between two eye points (z0 and z1 are eye heights). Blocked by
 * standing buildings, by more than a thin belt of forest, and by ground that rises above
 * the line. `skipA` and `skipB` are structures to ignore: the ones the two ends are in.
 */
export function lineOfSight(
  map: GameMap,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  skipA: number,
  skipB: number,
): boolean {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const ax = dx < 0 ? -dx : dx;
  const ay = dy < 0 ? -dy : dy;
  const steps = ((ax > ay ? ax : ay) >> (CELL_SHIFT - 1)) + 1;
  const type = map.type;
  const h = map.heights;
  const dz = z1 - z0;
  let forest = 0;
  let haze = 0;
  const smoke = map.smoke;
  const now = map.now;
  for (let k = 1; k < steps; k++) {
    const x = x0 + Math.trunc((dx * k) / steps);
    const y = y0 + Math.trunc((dy * k) / steps);
    const cx = x >> CELL_SHIFT;
    const cy = y >> CELL_SHIFT;
    const c = cy * MAP_CELLS + cx;
    const t = type[c];
    if (t === T_BUILDING) {
      const s = map.structAt[c];
      if (s !== skipA && s !== skipB) return false;
      continue;
    }
    if (t === T_FOREST && ++forest > FOREST_SIGHT_STEPS) return false;
    if (smoke[c] > now && ++haze > SMOKE_SIGHT_STEPS) return false;
    // Ground is checked once per cell (every other step); walls and trees every step.
    if ((k & 1) !== 0 || t === T_BRIDGE) continue;
    const v = cy * MAP_VERTS + cx;
    const fxq = x & (CELL_FX - 1);
    const top = h[v] + (((h[v + 1] - h[v]) * fxq) >> CELL_SHIFT);
    const v2 = v + MAP_VERTS;
    const bottom = h[v2] + (((h[v2 + 1] - h[v2]) * fxq) >> CELL_SHIFT);
    const ground = top + (((bottom - top) * (y & (CELL_FX - 1))) >> CELL_SHIFT);
    if (ground > z0 + Math.trunc((dz * k) / steps)) return false;
  }
  return true;
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
