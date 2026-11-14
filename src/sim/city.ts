// The city map (URBAN.md phase U3; Fabio, 2026-11-13: "more buildings, roads, knowing
// that where the flag is is where troops concentrate"). Every flag is the main square of a
// town laid out on a street grid: blocks of flats round a courtyard, slabs, halls, rows of
// small houses, a park. Main roads run from town to town with houses and shops along them,
// and what lies between is farmland cut by hedges, with a wood here and there.
//
// The armies set up in the south-west and the north-east corner, further apart than on
// the ridge map. Like that map this one is an exact mirror image of itself across the
// north-west to south-east diagonal: everything is made for the west half (x < y) and
// copied over, and what stands on the diagonal itself is made symmetric.
//
// There is no single way across. Three towns stand on the diagonal (Northgate, the City
// Centre, Station), each a grid of streets with a dozen ways through it; between and
// outside them the diagonal is open country. A street is three cells wide, so vehicles keep
// to the streets inside a town while infantry also goes through yards and gardens.
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
  T_FOREST,
  T_OPEN,
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

/** A block is nine cells square and a street three wide: a street line every twelve. */
const PITCH = 12;
const LEVEL = fx(3.2);

interface Flag {
  name: string;
  /** The name of its mirror image on the east side, or null for a town on the diagonal. */
  twin: string | null;
  x: number;
  y: number;
  /** Blocks from the flag to the edge of the street grid. */
  n: number;
  /** Radius of the capture circle, in metres. */
  r: number;
  /** How built up: 0 a small town, 1 a town, 2 the city centre. */
  grade: number;
}

/** The west army's towns, then those both armies are equally far from. Cells. */
const FLAGS: readonly Flag[] = [
  { name: 'West End', twin: 'East End', x: 75, y: 181, n: 2, r: 56, grade: 1 },
  { name: 'Millbrook', twin: 'Foundry Row', x: 45, y: 118, n: 1, r: 44, grade: 0 },
  { name: 'Southfield', twin: 'Eastfield', x: 142, y: 218, n: 1, r: 44, grade: 0 },
  { name: 'City Centre', twin: null, x: 128, y: 128, n: 2, r: 62, grade: 2 },
  { name: 'Northgate', twin: null, x: 58, y: 58, n: 2, r: 56, grade: 1 },
  { name: 'Station', twin: null, x: 198, y: 198, n: 2, r: 56, grade: 1 },
];

/** Where the west army's headquarters goes, and how much ground round it is kept clear. */
const BASE_X = 28;
const BASE_Y = 226;
const BASE_CLEAR = 24;

/** The main roads of the west half, as cell lines (x0, y0, x1, y1), each along one axis. */
const ROADS: readonly (readonly [number, number, number, number])[] = [
  [45, 118, 45, 218],
  [58, 58, 58, 128],
  [75, 128, 75, 218],
  [128, 128, 128, 198],
  [142, 198, 142, 218],
  [45, 118, 58, 118],
  [58, 128, 128, 128],
  [45, 181, 128, 181],
  [128, 198, 198, 198],
  [30, 218, 142, 218],
];

// (This module and map.ts import each other, so nothing here may read a constant of
// map.ts while the module is being loaded: hence the tables below are functions.)

/** What there is to haul, for the west army (mirrored for the east): kind, stock, cell. */
const sites = (): readonly (readonly [number, number, number, number])[] => [
  [SITE_SUPPLIES, 8000, 19, 238],
  [SITE_SUPPLIES, 8000, 42, 240],
  [SITE_FUEL, 200, 17, 214],
  // Behind the first town up the road: the richest, and the nearest to the fighting.
  [SITE_SUPPLIES, 16000, 62, 211],
  [SITE_FUEL, 200, 45, 197],
  // At the small towns on the two flanks: a long drive.
  [SITE_SUPPLIES, 12000, 27, 135],
  [SITE_FUEL, 200, 28, 100],
  [SITE_SUPPLIES, 12000, 161, 238],
  [SITE_FUEL, 200, 123, 234],
  // Two more, between the base and each flank town (decision 098).
  [SITE_SUPPLIES, 10000, 30, 172],
  [SITE_SUPPLIES, 10000, 92, 236],
];
/** On the diagonal, as far from one army as from the other: kind, stock, cell (x = y). */
const shared = (): readonly (readonly [number, number, number])[] => [
  [SITE_SUPPLIES, 10000, 25],
  [SITE_FUEL, 200, 16],
  [SITE_SUPPLIES, 10000, 93],
  [SITE_SUPPLIES, 10000, 163],
  [SITE_SUPPLIES, 10000, 231],
  [SITE_FUEL, 200, 240],
];

/** Ground height at a grid vertex: gentle, level under the towns and the bases, one hill. */
function cityHeight(vx: number, vy: number, s: number): number {
  // The west half's coordinates of the point or of its mirror image.
  const a = vx < vy ? vx : vy;
  const b = vx < vy ? vy : vx;
  const base = Math.trunc(
    (symNoise(vx, vy, 6, s) * 8 + symNoise(vx, vy, 5, s + 3) * 4 + symNoise(vx, vy, 4, s + 4) * 2) /
      14,
  );
  let h = LEVEL + (base - 512) * 6;
  // A low hill in the fields between the first town and the centre, with a view of both.
  const d = isqrt((a - 101) * (a - 101) + (b - 155) * (b - 155));
  h += (fx(6) * smooth(clampInt(1024 - Math.trunc((d * 1024) / 20), 0, 1024))) >> 10;
  let flat = 0;
  for (const f of FLAGS) {
    const e = f.n * PITCH + 3;
    const far = Math.max(Math.abs(a - f.x), Math.abs(b - f.y));
    flat = Math.max(flat, clampInt(Math.trunc(((e + 8 - far) * 1024) / 8), 0, 1024));
  }
  const far = Math.max(Math.abs(a - BASE_X), Math.abs(b - BASE_Y));
  flat = Math.max(flat, clampInt(Math.trunc(((BASE_CLEAR + 6 - far) * 1024) / 8), 0, 1024));
  return h + (((LEVEL - h) * smooth(flat)) >> 10);
}

/** A building to be: its plot in cells, its floors, and the town it belongs to (-1: none). */
interface Plot {
  x: number;
  y: number;
  w: number;
  h: number;
  floors: number;
  flag: number;
}

/** Share of each kind of block, in per cent, by how built up the place is (see blockAt). */
const MIX: readonly (readonly number[])[] = [
  // court, slabs, quad, hall, houses, park, lot
  [0, 10, 25, 5, 50, 0, 10],
  [0, 10, 25, 5, 50, 0, 10],
  [0, 15, 25, 10, 35, 5, 10],
  [25, 20, 25, 10, 15, 5, 0],
  [40, 20, 22, 10, 0, 8, 0],
  [50, 20, 18, 8, 0, 4, 0],
];
const FLOORS = [2, 2, 2, 3, 4, 5];

/** What a block is built with: a house (if there is room), a paved yard, a tree. */
export interface BlockTools {
  build: (x: number, y: number, w: number, h: number, floors: number) => void;
  /** Paved ground, in cells from the corner of the block. */
  yard: (a: number, b: number, c: number, d: number) => void;
  tree: (x: number, y: number) => void;
  /** Floors of the house numbered `extra` in the block. */
  floors: (extra: number) => number;
}

/**
 * Lay out one block, nine cells square with its corner at (x0, y0): flats round a courtyard,
 * slabs, four houses, a hall, small houses, a park or a car park (kind 0 to 6). `h` is the
 * dice of the block, `dense` how built up the place is (0 to 5).
 */
export function layBlock(
  kind: number,
  x0: number,
  y0: number,
  h: number,
  dense: number,
  s: number,
  { build, yard, tree, floors }: BlockTools,
): void {
  if (kind === 0) {
    // Flats round a courtyard: eight houses wall to wall. Half the courtyards have a
    // way in where one house is missing.
    const gap = (h >> 12) % 8;
    const sides = [
      [3, 0],
      [0, 3],
      [6, 3],
      [3, 6],
    ];
    for (let q = 0; q < 4; q++) build(x0 + (q & 1) * 6, y0 + (q >> 1) * 6, 3, 3, floors(q));
    for (let q = 0; q < 4; q++) {
      if (q === gap) yard(sides[q][0], sides[q][1], sides[q][0] + 2, sides[q][1] + 2);
      else build(x0 + sides[q][0], y0 + sides[q][1], 3, 3, floors((q + 1) & 3));
    }
    if (gap < 4) yard(3, 3, 5, 5);
    else for (let q = 0; q < 9; q++) tree(x0 + 3 + (q % 3), y0 + 3 + Math.trunc(q / 3));
  } else if (kind === 1) {
    // Two slabs with a yard between them, a row of trees down its middle.
    const turn = ((h >> 12) & 1) === 1;
    const at = (a: number, b: number, w: number, d: number, e: number) =>
      turn
        ? build(x0 + b, y0 + a, d, w, Math.max(3, floors(e)))
        : build(x0 + a, y0 + b, w, d, Math.max(3, floors(e)));
    at(0, 0, 5, 3, 0);
    at(5, 0, 4, 3, 1);
    at(0, 6, 4, 3, 2);
    at(4, 6, 5, 3, 3);
    if (turn) yard(3, 0, 5, 8);
    else yard(0, 3, 8, 5);
    for (let q = 2; q <= 6; q++) tree(x0 + (turn ? 4 : q), y0 + (turn ? q : 4));
  } else if (kind === 2) {
    // Four houses and the alleys between them, a tree where the alleys cross.
    for (let q = 0; q < 4; q++)
      build(x0 + (q & 1) * 5, y0 + (q >> 1) * 5, 4, 4, Math.max(3, floors(q)));
    yard(4, 0, 4, 8);
    yard(0, 4, 8, 4);
    tree(x0 + 4, y0 + 4);
  } else if (kind === 3) {
    // A hall (a market, a works, a depot) and its yard.
    const turn = ((h >> 12) & 1) === 1;
    if (turn) build(x0 + 1, y0 + 1, 5, 7, 2);
    else build(x0 + 1, y0 + 1, 7, 5, 2);
    yard(0, 0, 8, 8);
  } else if (kind === 4) {
    // Small houses three by three, a garden where one is missing, hedges where the
    // paths between them cross (men get through, vehicles do not).
    for (let q = 0; q < 9; q++) {
      const a = x0 + (q % 3) * 3;
      const b = y0 + Math.trunc(q / 3) * 3;
      const hh = lattice(a, b, s + 73);
      if (hh % 100 < 28) {
        if (hh % 3 !== 0) for (let t = 0; t < 4; t++) tree(a + (t & 1), b + (t >> 1));
      } else build(a, b, 2, 2, 2 + ((hh >> 8) % 2) + (dense >= 3 ? 1 : 0));
    }
    for (let q = 0; q < 4; q++) tree(x0 + 2 + (q & 1) * 3, y0 + 2 + (q >> 1) * 3);
  } else if (kind === 5) {
    for (let b = 1; b < 8; b++) {
      for (let a = 1; a < 8; a++) if (a !== 4 && b !== 4) tree(x0 + a, y0 + b);
    }
    yard(0, 4, 8, 4);
    yard(4, 0, 4, 8);
  } else {
    // A car park with a garage in it.
    build(x0 + 3, y0 + 3, 3, 2, 2);
    yard(0, 0, 8, 8);
  }
}

/** The city map (see the notes above). */
export function generateCity(seed: number): GameMap {
  const s = seed | 0;
  const N = MAP_CELLS;
  const SITES = sites();
  const SHARED = shared();
  const heights = new Int32Array(MAP_VERTS * MAP_VERTS);
  for (let vy = 0; vy < MAP_VERTS; vy++) {
    for (let vx = vy; vx < MAP_VERTS; vx++) {
      const h = cityHeight(vx, vy, s);
      heights[vy * MAP_VERTS + vx] = h;
      heights[vx * MAP_VERTS + vy] = h;
    }
  }
  const type = new Uint8Array(CELL_COUNT);
  const map = newMap(heights, type);
  map.layout = 'city';
  const road = map.road;
  /** Cells inside a town's street grid (the town's number plus one). */
  const core = new Uint8Array(CELL_COUNT);
  /** Cells a building or its garden stands on, or that are kept free for something. */
  const used = new Uint8Array(CELL_COUNT);
  const plots: Plot[] = [];
  /** Squares on the diagonal: their own mirror image, so they are added once. */
  const own: Plot[] = [];

  const inside = (x: number, y: number) => x >= 2 && y >= 2 && x < N - 2 && y < N - 2;
  const pave = (x0: number, y0: number, x1: number, y1: number, what: number) => {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
        if (inside(x, y) && road[y * N + x] !== ROAD_STREET) road[y * N + x] = what;
      }
    }
  };
  const street = (x0: number, y0: number, x1: number, y1: number, main: number, both: boolean) => {
    pave(x0 - 1, y0 - 1, x1 + 1, y1 + 1, ROAD_STREET);
    map.streets.push(x0, y0, x1, y1, main);
    // Its mirror image in the east half, unless the town it is in makes that itself.
    if (both) map.streets.push(y0, x0, y1, x1, main);
  };

  for (const [x0, y0, x1, y1] of ROADS) street(x0, y0, x1, y1, 1, true);
  for (let k = 0; k < FLAGS.length; k++) {
    const f = FLAGS[k];
    const e = f.n * PITCH;
    for (let i = -f.n; i <= f.n; i++) {
      street(f.x + i * PITCH, f.y - e, f.x + i * PITCH, f.y + e, 0, f.twin !== null);
      street(f.x - e, f.y + i * PITCH, f.x + e, f.y + i * PITCH, 0, f.twin !== null);
    }
    for (let y = f.y - e - 2; y <= f.y + e + 2; y++) {
      for (let x = f.x - e - 2; x <= f.x + e + 2; x++) if (inside(x, y)) core[y * N + x] = k + 1;
    }
    // The square round the flag.
    pave(f.x - 3, f.y - 3, f.x + 3, f.y + 3, ROAD_PAVED);
  }
  // Ground kept free: round the base, and where the resource sites will go.
  const keep = (cx: number, cy: number, r: number) => {
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) if (inside(x, y)) used[y * N + x] = 1;
    }
  };
  keep(BASE_X, BASE_Y, BASE_CLEAR);
  for (const [, , x, y] of SITES) keep(x, y, 3);
  for (const [, , c] of SHARED) keep(c, c, 3);

  const free = (x: number, y: number, w: number, h: number, town: boolean) => {
    // Strictly in the west half, so that its mirror image never touches it.
    if (!inside(x, y) || !inside(x + w - 1, y + h - 1) || x + w > y) return false;
    for (let j = y; j < y + h; j++) {
      for (let i = x; i < x + w; i++) {
        const c = j * N + i;
        if (type[c] !== T_OPEN || road[c] === ROAD_STREET || used[c] !== 0) return false;
        if (!town && core[c] !== 0) return false;
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

  // ---- the towns, block by block
  for (let k = 0; k < FLAGS.length; k++) {
    const f = FLAGS[k];
    const diagonal = f.twin === null;
    const build = (x: number, y: number, w: number, h: number, floors: number, self = false) => {
      // Nothing stands on the square round the flag.
      if (x <= f.x + 3 && x + w > f.x - 3 && y <= f.y + 3 && y + h > f.y - 3) return;
      if (self) {
        own.push({ x, y, w, h, floors, flag: k });
        claim(x, y, w, h, 0);
      } else if (free(x, y, w, h, true)) {
        plots.push({ x, y, w, h, floors, flag: k });
        claim(x, y, w, h, 0);
      }
    };
    for (let j = -f.n; j < f.n; j++) {
      for (let i = -f.n; i < f.n; i++) {
        if (diagonal && i > j) continue;
        const x0 = f.x + i * PITCH + 2;
        const y0 = f.y + j * PITCH + 2;
        const h = lattice(x0, y0, s + 71);
        const inner = i >= -1 && i <= 0 && j >= -1 && j <= 0;
        const dense = f.grade * 2 + (inner ? 1 : 0);
        const floors = (extra: number) => FLOORS[dense] + ((h >> (8 + 2 * extra)) % 3);
        const yard = (a: number, b: number, c: number, d: number) =>
          pave(x0 + a, y0 + b, x0 + c, y0 + d, ROAD_PAVED);
        if (diagonal && i === j) {
          // A block on the diagonal is its own mirror image: a landmark, a tower, a park.
          const what = inner ? (i === -1 ? 0 : 1) : 2 + (h % 2);
          if (what === 0) {
            // The town hall (or the station, the market hall): five cells square, low.
            build(x0 + 2, y0 + 2, 5, 5, 2, true);
            yard(0, 0, 8, 8);
          } else if (what === 1) {
            build(x0 + 3, y0 + 3, 3, 3, 6 + f.grade, true);
            yard(0, 0, 8, 8);
          } else if (what === 2) {
            for (let b = 1; b < 8; b++) {
              for (let a = 1; a < 8; a++) if (a !== 4 && b !== 4) tree(x0 + a, y0 + b);
            }
            yard(0, 4, 8, 4);
            yard(4, 0, 4, 8);
          } else {
            build(x0, y0 + 5, 4, 4, floors(0));
            yard(0, 0, 8, 8);
            tree(x0 + 4, y0 + 4);
          }
          continue;
        }
        let roll = h % 100;
        let kind = 0;
        while (kind < 6 && roll >= MIX[dense][kind]) roll -= MIX[dense][kind++];
        layBlock(kind, x0, y0, h, dense, s, { build, yard, tree, floors });
      }
    }
  }

  // ---- houses and shops along the main roads
  for (const [rx0, ry0, rx1, ry1] of ROADS) {
    const upright = rx0 === rx1;
    const len = upright ? ry1 - ry0 : rx1 - rx0;
    for (let t = 4; t < len - 4; t += 5) {
      for (let side = -1; side <= 1; side += 2) {
        const h = lattice(upright ? rx0 + side : rx0 + t, upright ? ry0 + t : ry0 + side, s + 75);
        const roll = h % 100;
        if (roll >= 70) continue;
        const shop = roll >= 60;
        // Along the road and back from it.
        const along = shop ? 4 : 2 + ((h >> 8) & 1);
        const deep = shop ? 3 : 2 + ((h >> 9) & 1);
        const back = side > 0 ? 3 : -2 - deep;
        const w = upright ? deep : along;
        const d = upright ? along : deep;
        const x = upright ? rx0 + back : rx0 + t;
        const y = upright ? ry0 + t : ry0 + back;
        if (!free(x - 1, y - 1, w + 2, d + 2, false)) continue;
        plots.push({ x, y, w, h: d, floors: shop ? 2 : 2 + ((h >> 11) % 2), flag: -1 });
        claim(x, y, w, d, 1);
        if (shop) {
          // Its forecourt, down to the kerb.
          if (upright)
            pave(side > 0 ? rx0 + 2 : x + w, y, side > 0 ? x - 1 : rx0 - 2, y + d - 1, 2);
          else pave(x, side > 0 ? ry0 + 2 : y + d, x + w - 1, side > 0 ? y - 1 : ry0 - 2, 2);
        } else if (((h >> 12) & 3) !== 0) {
          // A hedge along the back of the garden.
          for (let q = 0; q < along; q++) {
            if (upright) tree(side > 0 ? x + w + 1 : x - 2, y + q);
            else tree(x + q, side > 0 ? y + d + 1 : y - 2);
          }
        }
      }
    }
  }

  // ---- the country: hedges round the fields, a wood here and there
  const near = new Uint8Array(CELL_COUNT);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (road[y * N + x] !== ROAD_STREET && core[y * N + x] === 0) continue;
      for (let j = Math.max(0, y - 4); j <= Math.min(N - 1, y + 4); j++) {
        for (let i = Math.max(0, x - 4); i <= Math.min(N - 1, x + 4); i++) near[j * N + i] = 1;
      }
    }
  }
  for (let y = 3; y < N - 3; y++) {
    for (let x = 3; x <= y; x++) {
      const c = y * N + x;
      if (near[c] !== 0 || used[c] !== 0 || type[c] !== T_OPEN) continue;
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
  // Towns in pairs, the west army's first (the AI counts on that), the shared ones last.
  const townOf: number[] = [];
  for (let k = 0; k < FLAGS.length; k++) {
    const f = FLAGS[k];
    const at = (c: number) => (c << CELL_SHIFT) + (CELL_FX >> 1);
    townOf.push(addTown(map, at(f.x), at(f.y), fx(f.r), f.name));
    if (f.twin !== null) addTown(map, at(f.y), at(f.x), fx(f.r), f.twin);
  }
  for (const p of plots) {
    if (!levelPlot(map, p.x, p.y, p.w, p.h) || !levelPlot(map, p.y, p.x, p.h, p.w)) continue;
    const town = p.flag < 0 ? -1 : townOf[p.flag];
    const twin = p.flag < 0 || FLAGS[p.flag].twin === null ? town : town + 1;
    addStructure(map, S_BUILDING, p.x, p.y, p.w, p.h, town, p.floors);
    addStructure(map, S_BUILDING, p.y, p.x, p.h, p.w, twin, p.floors);
  }
  for (const p of own) {
    if (!levelPlot(map, p.x, p.y, p.w, p.h)) continue;
    addStructure(map, S_BUILDING, p.x, p.y, p.w, p.h, townOf[p.flag], p.floors);
  }
  finishMap(map);

  const west = findCell(BASE_X, BASE_Y, 20, (x, y) => canPlace(map, x, y, START_PLOT, START_PLOT));
  if (west >= 0) {
    map.startX[0] = west % N;
    map.startY[0] = Math.trunc(west / N);
    map.startX[1] = map.startY[0];
    map.startY[1] = map.startX[0];
  }
  const at = (c: number) => (c << CELL_SHIFT) + (CELL_FX >> 1);
  for (const [kind, stock, x, y] of SITES) {
    addSite(map, kind, stock, at(x), at(y));
    addSite(map, kind, stock, at(y), at(x));
  }
  for (const [kind, stock, c] of SHARED) addSite(map, kind, stock, at(c), at(c));

  // The ways across, for the AI: through each of the three towns on the diagonal, from the
  // town on its side that faces it, and over the open country between them.
  const lane = (mid: number, w: number, wx: number, wy: number): Lane => ({
    x: at(mid),
    y: at(mid),
    bankX: w >= 0 ? [map.townX[w], map.townX[w + 1]] : [at(wx), at(wy)],
    bankY: w >= 0 ? [map.townY[w], map.townY[w + 1]] : [at(wy), at(wx)],
    town: w >= 0 ? [w, w + 1] : [-1, -1],
  });
  map.lanes = [
    lane(128, townOf[0], 0, 0),
    lane(58, townOf[1], 0, 0),
    lane(198, townOf[2], 0, 0),
    lane(93, -1, 84, 108),
    lane(163, -1, 150, 176),
  ];
  return map;
}
