// Kowloon (Fabio, 2026-11-20: "something inspired by Hong Kong, Kowloon Park as the
// centre, real buildings and streets"). A harbour city of towers and tenements on a tight
// street grid, after Tsim Sha Tsui and Jordan: a park in the middle of it, the harbour on
// two sides, a hill of barracks inland. Names and shapes are borrowed from the real place;
// the map is a game map, not a survey.
//
// Tsim Sha Tsui happens to be nearly symmetric about the line from the Star Ferry through
// Kowloon Park to Gun Club Hill: the harbour runs along its west side (Canton Road) and its
// south side (Salisbury Road), and Nathan Road down the east side of the park meets Austin
// Road along its north side at the park's far corner. So, like the other maps, this one is
// an exact mirror image of itself across the north-west to south-east diagonal, and the
// real place is laid on it turned a quarter: the Star Ferry corner is the north-west of
// the map, the harbour runs along its north and west edges, and the armies set up at the
// two inland ends of the waterfront (the west army where Hung Hom would be, the east army
// on the West Kowloon reclamation).
//
// Everything is made for the west half (x < y) and copied over; what stands on the
// diagonal (the Star Ferry, Kowloon Park, Gun Club Hill) is made symmetric. Each real road
// of the west half has a twin in the east: Salisbury Road is Canton Road, Nathan Road south
// of the park is Austin Road, Chatham Road is Jordan Road.
//
// There are no bridges and no single way across. The grid is a street every twelve cells
// both ways (48 m blocks, about what the real ones are), so every street that reaches the
// diagonal meets its mirror image there: more than a dozen ways over, plus the park, which
// men cross on foot under the trees and vehicles only on its paths. Tanks own Nathan Road
// and the waterfront; in the side streets between towers a rocket team on the third floor
// owns them.
import { clampInt, fx, isqrt } from './fixed';
import {
  CELL_COUNT,
  CELL_FX,
  CELL_SHIFT,
  MAP_CELLS,
  MAP_VERTS,
  ROAD_PAVED,
  ROAD_STREET,
  SITE_FUEL,
  SITE_SUPPLIES,
  START_PLOT,
  S_BUILDING,
  T_CLIFF,
  T_FOREST,
  T_OPEN,
  T_WATER,
  WATER_LEVEL,
  addSite,
  addStructure,
  addTown,
  canPlace,
  findCell,
  finishMap,
  lattice,
  levelPlot,
  newMap,
  smooth,
  symNoise,
  type GameMap,
  type Lane,
} from './map';

const PITCH = 12;
const FIRST = 8;
/** Street line number `n`, in cells (8, 20, 32 ... 248). */
const line = (n: number) => FIRST + PITCH * n;
const LINES = 21;
const LEVEL = fx(3.2);
const BED = fx(-1.8);
/** Vertices of the west half nearer the edge than this are harbour (the north edge in the east). */
const COAST = 22;
/** The waterfront road: Salisbury Road (west half), Canton Road (east half). */
const SHORE_ROAD = 2;
/** Nathan Road (west half) and Austin Road (east half): the park's far side. */
const NATHAN = 13;
/** The near side of the park: Kowloon Park Drive and Haiphong Road. */
const PARK_FROM = 7;
const PARK_TO = 12;
/** Chatham Road (west), Jordan Road (east). */
const CHATHAM = 17;
const MAIN_LINES: readonly number[] = [SHORE_ROAD, PARK_FROM, NATHAN, CHATHAM];
/** Rows that go on past the waterfront road down to the promenade. */
const toWater = (b: number) => b % 3 === 1;
/** Buildings of the west half at most (the same again in the east). */
const MAX_PLOTS = 360;

interface Flag {
  name: string;
  twin: string | null;
  x: number;
  y: number;
  /** Radius of the capture circle, in metres. */
  r: number;
}

/**
 * The west army's quarters, each with its twin in the east (the first faces the park and
 * is where the AI forms up), then the three on the diagonal that both armies are as far from.
 */
const FLAGS: readonly Flag[] = [
  { name: 'Granville Road', twin: 'Jordan', x: line(10), y: line(14), r: 50 },
  { name: 'Chungking Mansions', twin: 'Xiqu Centre', x: line(4), y: line(NATHAN), r: 48 },
  { name: 'Cultural Centre', twin: 'Harbour City', x: 25, y: 76, r: 44 },
  { name: 'Signal Hill', twin: 'West Kowloon', x: 42, y: 197, r: 44 },
  { name: 'Tsim Sha Tsui East', twin: 'Yau Ma Tei', x: line(8), y: line(18), r: 50 },
  { name: 'Haiphong Road', twin: 'Canton Road', x: line(5), y: line(9), r: 48 },
  { name: 'Star Ferry', twin: null, x: 26, y: 26, r: 44 },
  { name: 'Kowloon Park', twin: null, x: 128, y: 128, r: 70 },
  { name: 'Gun Club Hill', twin: null, x: 212, y: 212, r: 56 },
];

const BASE_X = 40;
const BASE_Y = 232;
const BASE_CLEAR = 22;

/** Hills: centre (west-half cells), radius in cells, height. */
const HILLS: readonly (readonly [number, number, number, number])[] = [
  // Signal Hill, a knoll of trees with the old signal tower on top, over the harbour.
  [46, 194, 11, fx(4.2)],
  // The knoll of the old marine police station by the Star Ferry.
  [50, 50, 9, fx(2.4)],
  // Gun Club Hill and its barracks.
  [212, 212, 24, fx(5.6)],
];

/**
 * Piers out into the harbour from the west shore: from y0 to y1 (vertices), out to x
 * (they are mirrored onto the north shore, where the long one is the Ocean Terminal).
 */
const PIERS: readonly (readonly [number, number, number])[] = [
  [40, 47, 3],
  [104, 109, 8],
  [150, 153, 13],
];
/** The Star Ferry's pier at the corner: a square on the diagonal, from this vertex to the shore. */
const FERRY_PIER = 13;

/** Ponds in Kowloon Park (west-half cells x0, y0, x1, y1). */
const PONDS: readonly (readonly [number, number, number, number])[] = [
  [100, 134, 110, 145],
  [112, 150, 118, 156],
];

const sites = (): readonly (readonly [number, number, number, number])[] => [
  [SITE_SUPPLIES, 8000, 31, 244],
  [SITE_SUPPLIES, 8000, 54, 246],
  [SITE_FUEL, 200, 29, 220],
  // Behind the first quarters: the working sites of the mid game.
  [SITE_SUPPLIES, 12000, 74, 206],
  [SITE_FUEL, 200, 62, 182],
  [SITE_SUPPLIES, 12000, 124, 232],
  [SITE_FUEL, 200, 140, 210],
  // On the waterfront and by Haiphong Road: a long way out, under the towers.
  [SITE_SUPPLIES, 12000, 27, 124],
  [SITE_FUEL, 200, 27, 148],
  [SITE_SUPPLIES, 10000, 50, 96],
  // In the park, a short walk from the middle: the richest, and under fire.
  [SITE_SUPPLIES, 16000, 108, 124],
];
/** On the diagonal, as far from one army as from the other: kind, stock, cell (x = y). */
const shared = (): readonly (readonly [number, number, number])[] => [
  [SITE_SUPPLIES, 10000, 41],
  [SITE_FUEL, 200, 74],
  [SITE_FUEL, 200, 182],
  [SITE_SUPPLIES, 12000, 242],
];

// What kind of ground a block is (block (i, j) lies south-east of crossing (i, j)).
const B_WATER = 0;
const B_SHORE = 1;
const B_CITY = 2;
const B_PARK = 3;
const B_SIGNAL = 4;
const B_BARRACKS = 5;
const B_FIELDS = 6;
const B_BASE = 7;

/** The kind of block (i, j), for either half (it is its own mirror image). */
function blockKind(i0: number, j0: number): number {
  const i = Math.min(i0, j0);
  const j = Math.max(i0, j0);
  if (i <= 0) return B_WATER;
  if (i === 1) return j >= 18 ? B_BASE : B_SHORE;
  if (i >= PARK_FROM && j <= PARK_TO) return B_PARK;
  if (i >= 16 && j <= 17) return B_BARRACKS;
  if (i >= 19) return B_FIELDS;
  if (j === 15 && i <= 3) return B_SIGNAL;
  if (j >= 18 && i <= 4) return B_BASE;
  return B_CITY;
}

/** A compound has no streets inside it. */
const compound = (k: number) =>
  k === B_PARK || k === B_BARRACKS || k === B_SIGNAL || k === B_FIELDS;

function inPier(a: number, b: number): boolean {
  if (a >= FERRY_PIER && b <= COAST) return true;
  for (const [y0, y1, x] of PIERS) if (b >= y0 && b <= y1 && a >= x) return true;
  return false;
}

/** Ground height at a grid vertex (its mirror image has the same). */
function kowloonHeight(vx: number, vy: number, s: number): number {
  const a = vx < vy ? vx : vy;
  const b = vx < vy ? vy : vx;
  if (a < COAST) return inPier(a, b) ? LEVEL : BED;
  for (const [x0, y0, x1, y1] of PONDS) if (a >= x0 && a <= x1 && b >= y0 && b <= y1) return BED;
  // Reclaimed, made ground: dead level but for a sag here and there under the streets.
  const base = symNoise(vx, vy, 5, s) + symNoise(vx, vy, 4, s + 3);
  let h = LEVEL + Math.trunc((base - 1024) * 2);
  for (const [cx, cy, r, top] of HILLS) {
    const d = isqrt((a - cx) * (a - cx) + (b - cy) * (b - cy));
    h += (top * smooth(clampInt(Math.trunc(((r - d) * 1024) / (r - 3)), 0, 1024))) >> 10;
  }
  return h;
}

interface Plot {
  x: number;
  y: number;
  w: number;
  h: number;
  floors: number;
  flag: number;
}

/** The Kowloon map (see the notes above). */
export function generateKowloon(seed: number): GameMap {
  const s = seed | 0;
  const N = MAP_CELLS;
  const SITES = sites();
  const SHARED = shared();
  const heights = new Int32Array(MAP_VERTS * MAP_VERTS);
  for (let vy = 0; vy < MAP_VERTS; vy++) {
    for (let vx = vy; vx < MAP_VERTS; vx++) {
      const h = kowloonHeight(vx, vy, s);
      heights[vy * MAP_VERTS + vx] = h;
      heights[vx * MAP_VERTS + vy] = h;
    }
  }
  const type = new Uint8Array(CELL_COUNT);
  for (let cy = 0; cy < N; cy++) {
    for (let cx = 0; cx < N; cx++) {
      const v = cy * MAP_VERTS + cx;
      const p = heights[v];
      const q = heights[v + 1];
      const r = heights[v + MAP_VERTS];
      const t = heights[v + MAP_VERTS + 1];
      const lo = Math.min(p, q, r, t);
      const hi = Math.max(p, q, r, t);
      if (lo < WATER_LEVEL) type[cy * N + cx] = T_WATER;
      else if (hi - lo > fx(1.4)) type[cy * N + cx] = T_CLIFF;
    }
  }
  const map = newMap(heights, type);
  map.layout = 'kowloon';
  const road = map.road;
  const used = new Uint8Array(CELL_COUNT);
  const plots: Plot[] = [];
  const own: Plot[] = [];

  const inside = (x: number, y: number) => x >= 2 && y >= 2 && x < N - 2 && y < N - 2;
  const pave = (x0: number, y0: number, x1: number, y1: number, what: number) => {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
        const c = y * N + x;
        if (inside(x, y) && type[c] === T_OPEN && road[c] !== ROAD_STREET) road[c] = what;
      }
    }
  };
  const street = (x0: number, y0: number, x1: number, y1: number, main: number) => {
    pave(x0 - 1, y0 - 1, x1 + 1, y1 + 1, ROAD_STREET);
    map.streets.push(x0, y0, x1, y1, main);
    map.streets.push(y0, x0, y1, x1, main);
  };
  /** A street between blocks p and q: not inside a compound, and not out over the water. */
  const wanted = (pi: number, pj: number, qi: number, qj: number) => {
    const p = blockKind(pi, pj);
    const q = blockKind(qi, qj);
    if (p === B_WATER && q === B_WATER) return false;
    if (p === q && compound(p)) return false;
    return true;
  };

  // ---- the streets: rows (west to east, as far as the diagonal) and columns (from the
  // diagonal south to the edge). Each comes with its mirror image.
  for (let b = 1; b < LINES; b++) {
    let from = -1;
    const main = MAIN_LINES.includes(b) ? 1 : 0;
    for (let a = 1; a <= b; a++) {
      // The segment from crossing a to a + 1, between blocks (a, b - 1) and (a, b).
      const shore = a === 1;
      const on = a < b && wanted(a, b - 1, a, b) && (!shore || toWater(b));
      if (from >= 0 && !on) {
        street(from, line(b), line(a), line(b), main);
        from = -1;
      }
      if (on && from < 0) from = shore ? COAST + 1 : line(a);
    }
  }
  for (let a = SHORE_ROAD; a < LINES; a++) {
    let from = -1;
    const main = MAIN_LINES.includes(a) ? 1 : 0;
    for (let b = a; b <= LINES; b++) {
      // The segment from crossing b to b + 1, between blocks (a - 1, b) and (a, b).
      const on = b < LINES && wanted(a - 1, b, a, b);
      if (from >= 0 && !on) {
        street(line(a), from, line(a), Math.min(line(b), N - 3), main);
        from = -1;
      }
      if (on && from < 0) from = line(b);
    }
  }
  // The waterfront strip and the freight yards by the bases are paved over.
  for (let j = 1; j < LINES; j++) {
    for (let i = 1; i <= j; i++) {
      const k = blockKind(i, j);
      if (k === B_SHORE || k === B_BASE)
        pave(line(i) + 2, line(j) + 2, line(i) + 10, line(j) + 10, ROAD_PAVED);
    }
  }
  // The promenade along the harbour, and the piers.
  for (let y = COAST; y < N - 2; y++) pave(COAST, y, COAST + 1, y, ROAD_PAVED);
  for (const [y0, y1, x] of PIERS) pave(x, y0, COAST, y1 - 1, ROAD_PAVED);
  pave(FERRY_PIER, FERRY_PIER, COAST + 1, COAST + 1, ROAD_PAVED);

  const keep = (cx: number, cy: number, r: number) => {
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) if (inside(x, y)) used[y * N + x] = 1;
    }
  };
  for (const f of FLAGS) {
    pave(f.x - 3, f.y - 3, f.x + 3, f.y + 3, ROAD_PAVED);
    keep(f.x, f.y, 3);
  }
  keep(BASE_X, BASE_Y, BASE_CLEAR);
  for (const [, , x, y] of SITES) keep(x, y, 3);
  for (const [, , c] of SHARED) keep(c, c, 3);

  const free = (x: number, y: number, w: number, h: number) => {
    if (!inside(x, y) || !inside(x + w - 1, y + h - 1) || x + w > y) return false;
    for (let j = y; j < y + h; j++) {
      for (let i = x; i < x + w; i++) {
        const c = j * N + i;
        if (type[c] !== T_OPEN || road[c] === ROAD_STREET || used[c] !== 0) return false;
      }
    }
    return true;
  };
  const claim = (x: number, y: number, w: number, h: number) => {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) used[j * N + i] = 1;
  };
  const tree = (x: number, y: number) => {
    const c = y * N + x;
    if (!inside(x, y) || x > y || type[c] !== T_OPEN || road[c] === ROAD_STREET || used[c] !== 0)
      return;
    type[c] = T_FOREST;
    road[c] = 0;
    used[c] = 1;
  };
  /** The flag a house at (x, y) belongs to: the nearest within two blocks, or -1. */
  const flagAt = (x: number, y: number) => {
    let best = -1;
    let bestD = 2 * PITCH + 4;
    for (let k = 0; k < FLAGS.length; k++) {
      const d = Math.max(Math.abs(x - FLAGS[k].x), Math.abs(y - FLAGS[k].y));
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    return best;
  };
  const build = (x: number, y: number, w: number, h: number, floors: number): boolean => {
    if (plots.length >= MAX_PLOTS || !free(x, y, w, h)) return false;
    plots.push({ x, y, w, h, floors, flag: flagAt(x + (w >> 1), y + (h >> 1)) });
    claim(x, y, w, h);
    return true;
  };
  /** A building on the diagonal, its own mirror image (square, corner on the diagonal). */
  const self = (c: number, w: number, floors: number) => {
    for (let j = c; j < c + w; j++) {
      for (let i = c; i < c + w; i++) {
        const k = j * N + i;
        if (type[k] !== T_OPEN || road[k] === ROAD_STREET || used[k] !== 0) return;
      }
    }
    own.push({ x: c, y: c, w, h: w, floors, flag: flagAt(c, c) });
    for (let j = c; j < c + w; j++) for (let i = c; i < c + w; i++) used[j * N + i] = 1;
  };
  const yardAt = (x0: number, y0: number, x1: number, y1: number) =>
    pave(x0, y0, x1, y1, ROAD_PAVED);

  // ---- landmarks first, so that nothing else takes their ground
  // The Star Ferry: its terminal on the pier, the clock tower on the concourse behind it.
  self(15, 4, 2);
  self(34, 2, 11);
  // The old marine police station on its knoll, and its stables.
  self(47, 6, 2);
  build(46, 56, 4, 3, 2);
  // The waterfront: the Cultural Centre's long blind hall, the planetarium dome, the
  // towers of the dockside, hotels further on.
  build(24, 58, 7, 14, 2);
  build(24, 81, 6, 6, 2);
  build(24, 96, 7, 7, 16);
  build(24, 112, 6, 6, 12);
  build(24, 168, 7, 6, 14);
  build(24, 178, 6, 6, 11);
  // The Peninsula on Salisbury Road at the foot of Nathan Road: its wings and its tower.
  build(34, 166, 9, 3, 7);
  build(36, 170, 5, 4, 15);
  // Chungking Mansions: one block of tenements seventeen storeys high, and iSQUARE over the road.
  build(58, 168, 8, 6, 14);
  build(58, 154, 7, 7, 15);
  // K11 and its tower; The ONE and Mira Place on Nathan Road along the park.
  build(82, 178, 9, 5, 2);
  build(84, 184, 5, 3, 18);
  build(106, 166, 6, 6, 18);
  build(130, 166, 8, 5, 12);
  // The old signal tower on Signal Hill.
  build(49, 190, 2, 2, 6);

  // ---- Kowloon Park: groves, lawns, ponds, paths, the old barracks, the sports centre
  {
    const x0 = line(PARK_FROM) + 2;
    const x1 = line(PARK_TO + 1) - 2;
    // A path down the diagonal and a ring of paths round the middle.
    for (let c = x0; c <= x1; c++) pave(c - 1, c, c, c + 1, ROAD_PAVED);
    pave(x0, 128, 128, 128, ROAD_PAVED);
    pave(x0, 150, 150, 150, ROAD_PAVED);
    pave(116, 116, 116, x1, ROAD_PAVED);
    pave(122, 122, 134, 134, ROAD_PAVED);
    // The sports centre and its pools, by the gate on the corner of Nathan and Austin Road.
    self(147, 8, 2);
    // The old barracks, now a museum, and the hall by the Nathan Road gate.
    build(98, 112, 7, 3, 3);
    build(98, 118, 7, 3, 3);
    build(96, 155, 5, 5, 2);
    build(136, 157, 6, 3, 2);
    for (let y = x0; y <= x1; y++) {
      for (let x = x0; x <= y; x++) {
        if (road[y * N + x] !== 0) continue;
        const edge = x === x0 || y === x1;
        const lawn = Math.abs(x - 124) + Math.abs(y - 132) < 9;
        const grove = symNoise(x, y, 3, s + 31) + symNoise(x, y, 2, s + 32) > 980;
        if ((edge && (x + y) % 3 !== 0) || (!lawn && grove && lattice(x, y, s + 33) % 5 !== 0))
          tree(x, y);
      }
    }
  }

  // ---- Gun Club Hill: barracks round a parade ground, trees down the slopes
  {
    const x0 = line(16) + 2;
    const x1 = line(18) - 2;
    yardAt(x0 + 6, x0 + 6, x1 - 6, x1 - 6);
    self(line(16) + 4, 3, 4);
    build(x0 + 1, x0 + 10, 3, 8, 3);
    build(x0 + 6, x0 + 16, 8, 3, 3);
    build(x0 + 1, x0 + 2, 3, 4, 2);
    for (let y = x0; y <= x1; y++) {
      for (let x = x0; x <= y; x++) {
        const d = Math.max(Math.abs(x - 212), Math.abs(y - 212));
        if (d >= 9 && lattice(x, y, s + 41) % 3 !== 0) tree(x, y);
      }
    }
  }

  // ---- Signal Hill: a garden of trees and paths on the knoll
  for (let y = line(15) + 2; y <= line(16) - 2; y++) {
    for (let x = line(SHORE_ROAD) + 2; x <= line(4) - 2; x++) {
      if ((x + 2 * y) % 7 === 0) pave(x, y, x, y, ROAD_PAVED);
      else if (lattice(x, y, s + 43) % 4 !== 0) tree(x, y);
    }
  }

  // ---- King's Park, out at the far corner: playing fields and rows of trees
  for (let y = line(19); y < N - 2; y++) {
    for (let x = line(19); x <= y; x++) {
      if (x % 14 === 2 || y % 14 === 2) tree(x, y);
      else pave(x, y, x, y, ROAD_PAVED);
    }
  }

  // ---- the city, block by block, the busiest first (so the cap on buildings falls on the edges)
  const order: [number, number, number][] = [];
  for (let j = 1; j < LINES; j++) {
    for (let i = 1; i <= j; i++) {
      const k = blockKind(i, j);
      if (k !== B_CITY && k !== B_SHORE) continue;
      const cx = line(i) + 6;
      const cy = line(j) + 6;
      let d = 999;
      for (const f of FLAGS) d = Math.min(d, Math.max(Math.abs(cx - f.x), Math.abs(cy - f.y)));
      // Along Nathan Road counts as next to a flag.
      if (j === NATHAN || j === NATHAN - 1) d = Math.min(d, 8);
      order.push([d, i, j]);
    }
  }
  order.sort((p, q) => p[0] - q[0] || p[2] - q[2] || p[1] - q[1]);
  for (const [d, i, j] of order) {
    const x0 = line(i) + 2;
    const y0 = line(j) + 2;
    const h = lattice(x0, y0, s + 71);
    const dense = d <= 12 ? 3 : d <= 24 ? 2 : d <= 36 ? 1 : 0;
    const tall = (base: number, k: number) => base + ((h >> (8 + 2 * k)) % 4);
    if (blockKind(i, j) === B_SHORE) {
      // A strip between the waterfront road and the promenade: hotels, offices, a hall.
      const pick = h % 3;
      if (pick === 0) build(24, y0, 7, 7, tall(9, 0));
      else if (pick === 1) build(24, y0 + 1, 6, 8, 2);
      else {
        build(24, y0, 6, 4, tall(6, 0));
        build(24, y0 + 5, 6, 4, tall(6, 1));
      }
      continue;
    }
    if (i === j) {
      // A block on the diagonal: a tower on its own corner, a building either side.
      self(x0 + 5, 4, tall(10, 0));
      build(x0, y0 + 4, 4, 5, tall(6, 1));
      yardAt(x0, y0, x0 + 3, y0 + 3);
      continue;
    }
    // Hong Kong is paved from wall to wall: what the block leaves between its buildings is
    // lanes and yards, and a block the cap leaves empty is a car park or a building site.
    yardAt(x0, y0, x0 + 8, y0 + 8);
    layHK(pickKind(h, dense), x0, y0, h, dense, s, build, yardAt, tree);
  }

  // ---- the east half: the mirror image of the west
  for (let y = 0; y < N; y++) {
    for (let x = y + 1; x < N; x++) {
      type[y * N + x] = type[x * N + y];
      road[y * N + x] = road[x * N + y];
    }
  }
  map.baseType.set(type);
  const at = (c: number) => (c << CELL_SHIFT) + (CELL_FX >> 1);
  const townOf: number[] = [];
  for (const f of FLAGS) {
    townOf.push(addTown(map, at(f.x), at(f.y), fx(f.r), f.name));
    if (f.twin !== null) addTown(map, at(f.y), at(f.x), fx(f.r), f.twin);
  }
  for (const p of plots) {
    if (!levelPlot(map, p.x, p.y, p.w, p.h) || !levelPlot(map, p.y, p.x, p.h, p.w)) continue;
    const t = p.flag < 0 ? -1 : townOf[p.flag];
    const twin = p.flag < 0 || FLAGS[p.flag].twin === null ? t : t + 1;
    addStructure(map, S_BUILDING, p.x, p.y, p.w, p.h, t, p.floors);
    addStructure(map, S_BUILDING, p.y, p.x, p.h, p.w, twin, p.floors);
  }
  for (const p of own) {
    if (!levelPlot(map, p.x, p.y, p.w, p.h)) continue;
    addStructure(map, S_BUILDING, p.x, p.y, p.w, p.h, p.flag < 0 ? -1 : townOf[p.flag], p.floors);
  }
  finishMap(map);

  const west = findCell(BASE_X, BASE_Y, 20, (x, y) => canPlace(map, x, y, START_PLOT, START_PLOT));
  if (west >= 0) {
    map.startX[0] = west % N;
    map.startY[0] = Math.trunc(west / N);
    map.startX[1] = map.startY[0];
    map.startY[1] = map.startX[0];
  }
  for (const [kind, stock, x, y] of SITES) {
    addSite(map, kind, stock, at(x), at(y));
    addSite(map, kind, stock, at(y), at(x));
  }
  for (const [kind, stock, c] of SHARED) addSite(map, kind, stock, at(c), at(c));

  // The ways across, for the AI: past the park's corners and its middle, by the Star Ferry
  // knoll, and round Gun Club Hill, each from the quarter on its side that faces it.
  const lane = (mid: number, w: number, wx: number, wy: number): Lane => ({
    x: at(mid),
    y: at(mid),
    bankX: w >= 0 ? [map.townX[w], map.townX[w + 1]] : [at(wx), at(wy)],
    bankY: w >= 0 ? [map.townY[w], map.townY[w + 1]] : [at(wy), at(wx)],
    town: w >= 0 ? [w, w + 1] : [-1, -1],
  });
  map.lanes = [
    lane(line(NATHAN), townOf[0], 0, 0),
    lane(line(PARK_FROM), townOf[5], 0, 0),
    lane(44, townOf[2], 0, 0),
    lane(line(16), townOf[4], 0, 0),
    lane(128, -1, 104, 152),
    lane(240, -1, 226, 250),
  ];
  return map;
}

// Kinds of city block, nine cells square (see layHK).
const K_TENEMENTS = 0;
const K_TOWERS = 1;
const K_PODIUM = 2;
const K_ESTATE = 3;
const K_MARKET = 4;
// (and 5, a sitting-out garden)
/** Share of each kind, in per cent, by how busy the place is (0 the edges, 3 the heart). */
const HK_MIX: readonly (readonly number[])[] = [
  [36, 4, 0, 30, 10, 20],
  [48, 12, 6, 16, 8, 10],
  [44, 20, 18, 6, 6, 6],
  [38, 26, 26, 0, 4, 6],
];

function pickKind(h: number, dense: number): number {
  let roll = h % 100;
  let kind = 0;
  while (kind < 5 && roll >= HK_MIX[dense][kind]) roll -= HK_MIX[dense][kind++];
  return kind;
}

/**
 * One block of the city with its corner at (x0, y0): tenements wall to wall along both
 * streets with a back lane between, two slab towers, a mall with a tower over it, a public
 * housing estate round its playground, a market hall, or a sitting-out garden.
 */
function layHK(
  kind: number,
  x0: number,
  y0: number,
  h: number,
  dense: number,
  s: number,
  build: (x: number, y: number, w: number, h: number, floors: number) => boolean,
  yard: (x0: number, y0: number, x1: number, y1: number) => void,
  tree: (x: number, y: number) => void,
): void {
  const turn = ((h >> 12) & 1) === 1;
  /** A plot given across and down the block, turned with it. */
  const at = (a: number, b: number, w: number, d: number, floors: number) =>
    turn ? build(x0 + b, y0 + a, d, w, floors) : build(x0 + a, y0 + b, w, d, floors);
  const lane = (a0: number, b0: number, a1: number, b1: number) =>
    turn ? yard(x0 + b0, y0 + a0, x0 + b1, y0 + a1) : yard(x0 + a0, y0 + b0, x0 + a1, y0 + b1);
  const fl = (base: number, k: number) => base + ((h >> (9 + k)) % 3) + dense;
  if (kind === K_TENEMENTS) {
    // Two rows of narrow walk-ups, a back lane between them.
    const split = 3 + ((h >> 14) % 3);
    at(0, 0, split, 4, fl(4, 0));
    at(split, 0, 9 - split, 4, fl(4, 1));
    at(0, 5, 9 - split, 4, fl(4, 2));
    at(9 - split, 5, split, 4, fl(4, 3));
    lane(0, 4, 8, 4);
  } else if (kind === K_TOWERS) {
    at(0, 0, 9, 4, fl(9, 0) + 2);
    at(0, 5, 9, 4, fl(9, 1));
    lane(0, 4, 8, 4);
  } else if (kind === K_PODIUM) {
    // A shopping podium two storeys high, an office tower out of one end of it.
    at(0, 0, 9, 5, 2);
    at(2, 6, 5, 3, fl(11, 0) + 2);
    lane(0, 5, 8, 5);
    lane(0, 6, 1, 8);
    lane(7, 6, 8, 8);
  } else if (kind === K_ESTATE) {
    // Public housing: a long slab and a tower block round a playground with a few trees.
    at(0, 0, 3, 9, fl(9, 0));
    at(5, 5, 4, 4, fl(8, 1));
    lane(3, 0, 8, 4);
    lane(3, 5, 4, 8);
    for (let q = 0; q < 3; q++) {
      const tx = turn ? x0 + 1 + 2 * q : x0 + 4 + 2 * q;
      const ty = turn ? y0 + 4 + 2 * q : y0 + 1 + 2 * q;
      if (lattice(tx, ty, s + 77) % 2 === 0) tree(tx, ty);
    }
  } else if (kind === K_MARKET) {
    // A municipal market and cooked-food centre, shops in the lane behind.
    at(1, 0, 7, 5, 2);
    at(0, 6, 4, 3, fl(3, 0));
    at(5, 6, 4, 3, fl(3, 1));
    lane(0, 5, 8, 5);
    lane(0, 0, 0, 4);
    lane(8, 0, 8, 4);
  } else {
    // A sitting-out area: paving, benches, a ring of trees, a kiosk.
    yard(x0, y0, x0 + 8, y0 + 8);
    at(3, 3, 2, 2, 1);
    for (let q = 0; q < 9; q++) {
      tree(x0 + q, y0);
      if (q % 2 === 0) tree(x0, y0 + q);
    }
  }
}
