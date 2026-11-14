// The European city (roadmap item 7; Fabio, 2026-11-14: "much denser, big parks, an
// elevated highway, a river with a few bridges balanced by tunnels, a central station,
// fighting inch by inch"). One city, not a scatter of towns: a band of streets and blocks
// on both banks of a river that runs down the middle of the map, from the north-west corner
// to the south-east. The armies set up in the other two corners, with open country and a
// village between each of them and its bank.
//
// Like the other maps it is an exact mirror image of itself across the river: everything
// is made for the west half (x < y) and copied over.
//
// The river is walled in and cannot be forded. Seven ways lead over it. Four are bridges,
// which can be brought down (and mended by infantry, as on the river map). Three cannot:
// there the river runs under the ground in a culvert, under the cathedral square in the
// middle and out in the fields at both ends. So cutting every bridge never seals a bank;
// it only sends the fighting to the square and the flanks.
//
// The streets are one grid, a line every twelve cells both ways, so every street that
// reaches the river meets its own mirror image there. A motorway on an embankment cuts
// through each half of the city; it can be passed only where a street goes under it.
import { layBlock } from './city';
import { clampInt, fx } from './fixed';
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
  S_BRIDGE,
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
/** The first street line; the others follow every PITCH cells, the same both ways. */
const FIRST = 8;
const LEVEL = fx(3.2);
const BED = fx(-1.8);
/** Vertices this close to the diagonal are river bed. */
const RIVER = 3;
/** Buildings of the west half at most (the same again in the east). */
const MAX_PLOTS = 372;

/** Street line number `n`, in cells. */
const line = (n: number) => FIRST + PITCH * n;

interface Flag {
  name: string;
  twin: string | null;
  /** The street crossing it stands on, as line numbers. */
  a: number;
  b: number;
  r: number;
}

/** The west army's quarters (the first faces the middle crossing), then the shared square. */
const FLAGS: readonly Flag[] = [
  { name: 'Old Quarter', twin: 'New Quarter', a: 7, b: 10, r: 50 },
  { name: 'Tannery Row', twin: 'Weavers Row', a: 4, b: 7, r: 50 },
  { name: 'Market Quarter', twin: 'University', a: 10, b: 13, r: 50 },
  { name: 'Docklands', twin: 'Shipyard', a: 13, b: 16, r: 50 },
  { name: 'Central Station', twin: 'Harbour Station', a: 5, b: 12, r: 50 },
  { name: 'Westerfeld', twin: 'Osterfeld', a: 4, b: 15, r: 44 },
  { name: 'Cathedral Square', twin: null, a: 10, b: 10, r: 62 },
];

/** Where the river runs under the ground: street line and half the width of the cover. */
const CULVERTS: readonly (readonly [number, number])[] = [
  [2, 5],
  [10, 10],
  [18, 5],
];
/** Street lines that cross the river on a bridge. */
const BRIDGES: readonly number[] = [4, 7, 13, 16];
/** Half the side of a bridge: it has to reach from bank to bank across the diagonal. */
const BRIDGE_HALF = 5;

/** The motorway of the west half: the street line it runs along and its ends, in cells. */
const MOTORWAY = 8;
const MOTORWAY_FROM = line(9) + 2;
const MOTORWAY_TO = line(16) - 2;
const MOTORWAY_HEIGHT = fx(5);
const RAMP = 6;
/** The streets (as line numbers) that pass under it. */
const UNDERPASSES: readonly number[] = [11, 12, 14, 15];

const BASE_X = 28;
const BASE_Y = 226;
const BASE_CLEAR = 24;

/** Main roads of the west half through the country, as cell lines along one axis. */
const ROADS: readonly (readonly [number, number, number, number])[] = [
  [line(2), line(2), line(2), 226],
  [28, line(18), line(18), line(18)],
  [line(4), line(7), line(4), line(18)],
  [line(2), line(7), line(4), line(7)],
  [line(2), line(12), line(7), line(12)],
  [line(2), line(15), line(10), line(15)],
];

// (This module and map.ts import each other: nothing here may read a constant of map.ts
// while the module is being loaded, hence the function.)
const sites = (): readonly (readonly [number, number, number, number])[] => [
  [SITE_SUPPLIES, 8000, 19, 238],
  [SITE_SUPPLIES, 8000, 42, 240],
  [SITE_FUEL, 200, 17, 214],
  // By the village and behind the station: the working sites of the mid game.
  [SITE_SUPPLIES, 12000, 38, 180],
  [SITE_FUEL, 200, 48, 206],
  [SITE_SUPPLIES, 12000, 50, 146],
  [SITE_FUEL, 200, 50, 162],
  // In the two parks, a short walk from the river: the richest, and under fire.
  [SITE_SUPPLIES, 16000, 62, 116],
  [SITE_SUPPLIES, 16000, 140, 194],
  [SITE_FUEL, 200, 134, 206],
  // Out on the flanks, by the two outer crossings.
  [SITE_SUPPLIES, 10000, 10, 56],
  [SITE_FUEL, 200, 14, 40],
  [SITE_SUPPLIES, 10000, 196, 238],
  [SITE_FUEL, 200, 212, 242],
];

/** The parks of the west half, as ranges of blocks: i0, i1, j0, j1. */
const PARKS: readonly (readonly [number, number, number, number])[] = [
  [3, 5, 8, 9],
  [10, 11, 14, 16],
];

/** Which park block (i, j) lies in (from 1), or 0. */
function parkOf(i: number, j: number): number {
  for (let p = 0; p < PARKS.length; p++) {
    const [i0, i1, j0, j1] = PARKS[p];
    if (i >= i0 && i <= i1 && j >= j0 && j <= j1) return p + 1;
  }
  return 0;
}

/** Is block (i, j) of the west half part of the city? Block (i, j) lies south-east of crossing (i, j). */
function urban(i: number, j: number): boolean {
  const d = j - i;
  if (d < 1 || i < 0) return false;
  if (parkOf(i, j) !== 0) return true;
  // The band along the river, five blocks deep.
  if (d <= 5 && i + j >= 5 && i + j <= 33) return true;
  // The station quarter behind it, and the village in the fields.
  if (i >= 4 && i <= 6 && j >= 11 && j <= 12) return true;
  return i >= 3 && i <= 4 && j >= 14 && j <= 15;
}

function covered(a: number, b: number): boolean {
  for (const [n, half] of CULVERTS) {
    const c = line(n);
    if (Math.abs(a - c) <= half && Math.abs(b - c) <= half) return true;
  }
  return false;
}

/** How far the motorway is raised at a vertex of the west half (a < b), 0 to MOTORWAY_HEIGHT. */
function raised(a: number, b: number): number {
  const x = line(MOTORWAY);
  if (a < x || a > x + 1 || b < MOTORWAY_FROM || b > MOTORWAY_TO) return 0;
  for (const u of UNDERPASSES) if (b >= line(u) - 1 && b <= line(u) + 2) return 0;
  const end = Math.min(b - MOTORWAY_FROM, MOTORWAY_TO - b);
  return Math.trunc((MOTORWAY_HEIGHT * clampInt(end, 0, RAMP)) / RAMP);
}

/** Ground height at a grid vertex: level under the city, rolling a little in the fields. */
function euroHeight(vx: number, vy: number, s: number): number {
  const a = vx < vy ? vx : vy;
  const b = vx < vy ? vy : vx;
  const k = b - a;
  if (k <= RIVER && !covered(a, b)) return BED;
  const base = Math.trunc(
    (symNoise(vx, vy, 6, s) * 8 + symNoise(vx, vy, 5, s + 3) * 4 + symNoise(vx, vy, 4, s + 4) * 2) /
      14,
  );
  const h = LEVEL + (base - 512) * 6;
  let flat = clampInt(Math.trunc(((92 - k) * 1024) / 12), 0, 1024);
  const box = (cx: number, cy: number, r: number) => {
    const far = Math.max(Math.abs(a - cx), Math.abs(b - cy));
    flat = Math.max(flat, clampInt(Math.trunc(((r + 8 - far) * 1024) / 8), 0, 1024));
  };
  box(line(5), line(12), 34);
  box(line(4), line(15), 20);
  box(BASE_X, BASE_Y, BASE_CLEAR - 2);
  return h + (((LEVEL - h) * smooth(flat)) >> 10) + raised(a, b);
}

interface Plot {
  x: number;
  y: number;
  w: number;
  h: number;
  floors: number;
  flag: number;
}

/** Share of each kind of block, in per cent, by how built up the place is (see layBlock). */
const MIX: readonly (readonly number[])[] = [
  // court, slabs, quad, hall, houses, park, lot
  [0, 10, 30, 5, 45, 0, 10],
  [0, 15, 35, 10, 30, 0, 10],
  [10, 25, 35, 12, 10, 3, 5],
  [22, 28, 30, 12, 0, 3, 5],
  [34, 26, 26, 10, 0, 4, 0],
  [44, 24, 22, 8, 0, 2, 0],
];
const FLOORS = [2, 2, 3, 3, 4, 5];

/** The European city (see the notes above). */
export function generateEuro(seed: number): GameMap {
  const s = seed | 0;
  const N = MAP_CELLS;
  const SITES = sites();
  const heights = new Int32Array(MAP_VERTS * MAP_VERTS);
  for (let vy = 0; vy < MAP_VERTS; vy++) {
    for (let vx = vy; vx < MAP_VERTS; vx++) {
      const h = euroHeight(vx, vy, s);
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
      else if (hi - lo > fx(1.4) || lo > LEVEL + fx(2)) type[cy * N + cx] = T_CLIFF;
    }
  }
  const map = newMap(heights, type);
  map.layout = 'euro';
  const road = map.road;
  const used = new Uint8Array(CELL_COUNT);
  /** Cells of the city's blocks and streets (for the country to keep clear of). */
  const town = new Uint8Array(CELL_COUNT);
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
  const crossing = (n: number) => BRIDGES.includes(n) || CULVERTS.some(([c]) => c === n);
  /** Streets a block edge needs: both sides city, and not the inside of one park. */
  const wanted = (i0: number, j0: number, i1: number, j1: number) => {
    const p = urban(i0, j0);
    const q = urban(i1, j1);
    if (!p && !q) return false;
    const park = parkOf(i0, j0);
    return park === 0 || park !== parkOf(i1, j1);
  };
  /** Where the motorway shuts a street: the crossings on it that are not underpasses. */
  const shut = (a: number, b: number) =>
    a === MOTORWAY && b > 9 && b < 16 && !UNDERPASSES.includes(b);

  for (const [x0, y0, x1, y1] of ROADS) street(x0, y0, x1, y1, 1);
  const LINES = Math.trunc((N - FIRST) / PITCH);
  // West to east streets: line b, from crossing a to a + 1, as far as the river.
  for (let b = 1; b < LINES; b++) {
    let from = -1;
    for (let a = 0; a <= b; a++) {
      const on = a < b && wanted(a, b - 1, a, b);
      const stop = shut(a, b);
      if (from >= 0 && (!on || stop)) {
        let x1 = line(a);
        if (stop) x1 -= 2;
        else if (a === b && !crossing(b)) x1 -= 6;
        street(from, line(b), x1, line(b), 0);
        from = -1;
      }
      if (on && from < 0) from = line(a) + (stop ? 2 : 0);
    }
  }
  // North to south streets: line a, from the river at crossing a down to the edge of town.
  for (let a = 1; a < LINES; a++) {
    let from = -1;
    for (let b = a; b <= LINES; b++) {
      const motorway = a === MOTORWAY && b >= 9 && b < 16;
      const on = b < LINES && !motorway && wanted(a - 1, b, a, b);
      if (from >= 0 && !on) {
        street(line(a), from, line(a), line(b), 0);
        from = -1;
      }
      if (on && from < 0) from = line(b) + (b === a && !crossing(a) ? 6 : 0);
    }
  }
  for (let j = 0; j < LINES; j++) {
    for (let i = 0; i < j; i++) {
      if (!urban(i, j)) continue;
      for (let y = line(j) - 2; y <= line(j + 1) + 2; y++) {
        for (let x = line(i) - 2; x <= line(i + 1) + 2; x++) if (inside(x, y)) town[y * N + x] = 1;
      }
    }
  }
  // The squares: round each flag, and over the river where it runs under the ground.
  for (const [n, half] of CULVERTS) {
    pave(line(n) - half, line(n) - half, line(n) + half - 1, line(n) + half - 1, ROAD_PAVED);
  }
  // A paved quay along both banks, inside the city.
  for (let y = 2; y < N - 2; y++) {
    for (let x = Math.max(2, y - 7); x <= y - 5; x++) {
      if (town[y * N + x] !== 0) pave(x, y, x, y, ROAD_PAVED);
    }
  }
  const keep = (cx: number, cy: number, r: number) => {
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) if (inside(x, y)) used[y * N + x] = 1;
    }
  };
  for (const f of FLAGS) {
    pave(line(f.a) - 3, line(f.b) - 3, line(f.a) + 3, line(f.b) + 3, ROAD_PAVED);
    keep(line(f.a), line(f.b), 3);
  }
  keep(BASE_X, BASE_Y, BASE_CLEAR);
  for (const [, , x, y] of SITES) keep(x, y, 3);

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
  const claim = (x: number, y: number, w: number, h: number, margin: number) => {
    for (let j = y - margin; j < y + h + margin; j++) {
      for (let i = x - margin; i < x + w + margin; i++) if (inside(i, j)) used[j * N + i] = 1;
    }
  };
  const tree = (x: number, y: number) => {
    const c = y * N + x;
    if (!inside(x, y) || type[c] !== T_OPEN || road[c] === ROAD_STREET || used[c] !== 0) return;
    type[c] = T_FOREST;
    road[c] = 0;
    used[c] = 1;
  };
  /** The flag a house at (x, y) belongs to: the nearest within two blocks, or -1. */
  const flagAt = (x: number, y: number) => {
    let best = -1;
    let bestD = 2 * PITCH + 3;
    for (let k = 0; k < FLAGS.length; k++) {
      const d = Math.max(Math.abs(x - line(FLAGS[k].a)), Math.abs(y - line(FLAGS[k].b)));
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    return best;
  };
  const build = (x: number, y: number, w: number, h: number, floors: number) => {
    if (plots.length >= MAX_PLOTS || !free(x, y, w, h)) return;
    plots.push({ x, y, w, h, floors, flag: flagAt(x + (w >> 1), y + (h >> 1)) });
    claim(x, y, w, h, 0);
  };

  // ---- the parks: an avenue of trees round a lawn, groves, paths, a pavilion
  for (let p = 0; p < PARKS.length; p++) {
    const [i0, i1, j0, j1] = PARKS[p];
    const x0 = line(i0) + 2;
    const y0 = line(j0) + 2;
    const x1 = line(i1 + 1) - 2;
    const y1 = line(j1 + 1) - 2;
    const mx = (x0 + x1) >> 1;
    const my = (y0 + y1) >> 1;
    pave(x0, my, x1, my, ROAD_PAVED);
    pave(mx, y0, mx, y1, ROAD_PAVED);
    pave(mx - 2, my - 2, mx + 2, my + 2, ROAD_PAVED);
    build(mx + 4, my - 6, 3, 3, 2);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (road[y * N + x] !== 0) continue;
        const edge = x === x0 || y === y0 || x === x1 || y === y1;
        const lawn = Math.abs(x - mx) <= 6 && Math.abs(y - my) <= 6;
        const grove =
          symNoise(x, y, 3, s + 31) + symNoise(x, y, 2, s + 32) > 1070 &&
          lattice(x, y, s + 33) % 4 !== 0;
        if ((edge && (x + y) % 3 !== 0) || (!lawn && grove)) tree(x, y);
      }
    }
  }

  // ---- the city, block by block
  for (let j = 1; j < LINES; j++) {
    for (let i = 0; i < j; i++) {
      if (!urban(i, j) || parkOf(i, j) !== 0) continue;
      const x0 = line(i) + 2;
      const y0 = line(j) + 2;
      const h = lattice(x0, y0, s + 71);
      const yard = (a: number, b: number, c: number, d: number) =>
        pave(x0 + a, y0 + b, x0 + c, y0 + d, ROAD_PAVED);
      // How built up: most round a flag and by the river, least in the village.
      let dense = j - i <= 3 ? 4 : j - i <= 5 ? 3 : 2;
      for (const f of FLAGS) {
        if (f.twin === null) continue;
        const next = (i === f.a || i === f.a - 1) && (j === f.b || j === f.b - 1);
        if (next) dense = f.b - f.a > 8 ? 1 : 5;
        else if (f.b - f.a > 8 && Math.abs(i - f.a) <= 2 && Math.abs(j - f.b) <= 2) dense = 0;
      }
      const floors = (extra: number) => FLOORS[dense] + ((h >> (8 + 2 * extra)) % 3);
      if (i === 5 && j === 11) {
        // The station: the hall across the whole block, the forecourt before it.
        build(x0, y0 + 1, 9, 5, 3);
        yard(0, 0, 8, 8);
        continue;
      }
      if (i === 4 && j === 11) {
        // Its platforms: three long roofs with the tracks between them.
        for (let q = 0; q < 3; q++) build(x0, y0 + 3 * q, q < 2 ? 9 : 6, 2, 2);
        yard(0, 0, 8, 8);
        continue;
      }
      let roll = h % 100;
      let kind = 0;
      while (kind < 6 && roll >= MIX[dense][kind]) roll -= MIX[dense][kind++];
      layBlock(kind, x0, y0, h, dense, s, { build, yard, tree, floors });
    }
  }
  // The cathedral and its tower, on the square over the river: their own mirror images.
  const mid = line(10);
  for (const [x, w, floors] of [
    [mid - 9, 5, 3],
    [mid + 5, 3, 8],
  ]) {
    own.push({ x, y: x, w, h: w, floors, flag: FLAGS.length - 1 });
    claim(x, x, w, w, 0);
  }

  // ---- houses along the roads through the country
  for (const [rx0, ry0, rx1, ry1] of ROADS) {
    const upright = rx0 === rx1;
    const len = upright ? ry1 - ry0 : rx1 - rx0;
    for (let t = 4; t < len - 4; t += 5) {
      for (let side = -1; side <= 1; side += 2) {
        const h = lattice(upright ? rx0 + side : rx0 + t, upright ? ry0 + t : ry0 + side, s + 75);
        if (h % 100 >= 34) continue;
        const along = 2 + ((h >> 8) & 1);
        const deep = 2 + ((h >> 9) & 1);
        const back = side > 0 ? 3 : -2 - deep;
        const w = upright ? deep : along;
        const d = upright ? along : deep;
        const x = upright ? rx0 + back : rx0 + t;
        const y = upright ? ry0 + t : ry0 + back;
        if (town[y * N + x] !== 0 || plots.length >= MAX_PLOTS) continue;
        if (!free(x - 1, y - 1, w + 2, d + 2)) continue;
        plots.push({ x, y, w, h: d, floors: 2 + ((h >> 11) % 2), flag: flagAt(x, y) });
        claim(x, y, w, d, 1);
        for (let q = 0; q < along && ((h >> 12) & 3) !== 0; q++) {
          if (upright) tree(side > 0 ? x + w + 1 : x - 2, y + q);
          else tree(x + q, side > 0 ? y + d + 1 : y - 2);
        }
      }
    }
  }

  // ---- the country: hedges round the fields, a wood here and there
  const near = new Uint8Array(CELL_COUNT);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (road[y * N + x] !== ROAD_STREET && town[y * N + x] === 0) continue;
      for (let j = Math.max(0, y - 4); j <= Math.min(N - 1, y + 4); j++) {
        for (let i = Math.max(0, x - 4); i <= Math.min(N - 1, x + 4); i++) near[j * N + i] = 1;
      }
    }
  }
  for (let y = 3; y < N - 3; y++) {
    for (let x = 3; x <= y; x++) {
      const c = y * N + x;
      if (near[c] !== 0 || used[c] !== 0 || type[c] !== T_OPEN || road[c] !== 0) continue;
      // The banks of the river stay open: a field of fire from one side to the other.
      if (y - x < 12) continue;
      const hedge =
        (x % 16 === 3 && (y * 7 + (x >> 4) * 5) % 11 >= 3) ||
        (y % 12 === 7 && (x * 5 + Math.trunc(y / 12) * 3) % 13 >= 4);
      const wood =
        (symNoise(x, y, 5, s + 21) * 2 + symNoise(x, y, 4, s + 22) + symNoise(x, y, 3, s + 23)) / 4;
      if (hedge || wood > 665) type[c] = T_FOREST;
    }
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
    townOf.push(addTown(map, at(line(f.a)), at(line(f.b)), fx(f.r), f.name));
    if (f.twin !== null) addTown(map, at(line(f.b)), at(line(f.a)), fx(f.r), f.twin);
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
    addStructure(map, S_BUILDING, p.x, p.y, p.w, p.h, townOf[p.flag], p.floors);
  }
  for (const n of BRIDGES) {
    const c = line(n) - BRIDGE_HALF;
    const side = 2 * BRIDGE_HALF + 1;
    addStructure(map, S_BRIDGE, c, c, side, side, -1, 0);
    for (let y = c; y < c + side; y++) for (let x = c; x < c + side; x++) road[y * N + x] = 0;
  }
  // The carriageway on top of each embankment, for the client to draw.
  const top = LEVEL + MOTORWAY_HEIGHT;
  map.decks.push(line(MOTORWAY), MOTORWAY_FROM + RAMP, line(MOTORWAY), MOTORWAY_TO - RAMP, top);
  map.decks.push(MOTORWAY_FROM + RAMP, line(MOTORWAY), MOTORWAY_TO - RAMP, line(MOTORWAY), top);
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

  // The ways across, for the AI: each crossing, with the quarter that faces it or else the
  // street corner short of it as the place to form up.
  const lane = (n: number, w: number): Lane => {
    const c = line(n);
    return {
      x: at(c),
      y: at(c),
      bankX: w >= 0 ? [map.townX[w], map.townX[w + 1]] : [at(c - PITCH), at(c)],
      bankY: w >= 0 ? [map.townY[w], map.townY[w + 1]] : [at(c), at(c - PITCH)],
      town: w >= 0 ? [w, w + 1] : [-1, -1],
    };
  };
  map.lanes = [
    lane(10, townOf[0]),
    lane(7, townOf[1]),
    lane(13, townOf[2]),
    lane(16, townOf[3]),
    lane(4, -1),
    lane(2, -1),
    lane(18, -1),
  ];
  return map;
}
