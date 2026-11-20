// Kowloon (Fabio, 2026-11-20: "something inspired by Hong Kong, Kowloon Park as the
// centre, real buildings and streets"; then: "the geography, the grid, the park, the
// buildings" as they really are). Tsim Sha Tsui as it is, from OpenStreetMap: the real
// coastline with the Star Ferry, Ocean Terminal and the West Kowloon reclamation, every
// road at its real width (Nathan Road's two carriageways, Salisbury Road, the side
// streets), Kowloon Park with its woods, Bird Lake and the pools, and about eleven hundred
// buildings at their footprints and heights, each drawn as what it is: an office tower,
// a mall, a hotel, a tenement, a church, the mosque.
//
// The ground (1,400 m square, north up, as on any map of the place) is drawn 0.73 times
// its size on the 1,024 m map; tools/kowloon/osm2map.py makes kowloon-data.ts from the
// OpenStreetMap data, and this file lays the map on it. Map data (c) OpenStreetMap
// contributors, under the Open Database Licence.
//
// Unlike the other maps this one is not a mirror image of itself: the real place is not
// symmetric (Kowloon Park lies 150 m from the harbour to its west and 650 m from the one
// to its south). The armies set up on the two reclamations, West Kowloon (west) and the
// museum grounds of Tsim Sha Tsui East (east); the west is nearer the park, the east has
// more quarters nearby, and the flags come in pairs, each a quarter of one side with its
// counterpart on the other, for the computer's sense of front and back.
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
  T_WATER,
  addSite,
  addStructure,
  addTown,
  canPlace,
  findCell,
  finishMap,
  levelPlot,
  newMap,
  smooth,
  symNoise,
  type GameMap,
  type Lane,
} from './map';
import { HK_BUILDINGS, HK_CELLS } from './kowloon-data';

// What a cell of the real ground is (see tools/kowloon/osm2map.py).
export const HK_SEA = 0;
export const HK_POND = 1;
export const HK_POOL = 2;
export const HK_ROAD = 3;
export const HK_PAVE = 4;
export const HK_PATH = 5;
export const HK_GRASS = 6;
export const HK_WOOD = 7;
export const HK_EARTH = 8;
export const HK_PITCH = 9;
export const HK_BUILT = 10;

// How a building looks (map.sStyle).
export const STYLE_TENEMENT = 1;
export const STYLE_OFFICE = 2;
export const STYLE_MALL = 3;
export const STYLE_HOTEL = 4;
export const STYLE_CIVIC = 5;
export const STYLE_HERITAGE = 6;
export const STYLE_DOME = 7;
export const STYLE_CLOCK = 8;
export const STYLE_MOSQUE = 9;
export const STYLE_SPORTS = 10;
export const STYLE_KIOSK = 11;
export const STYLE_CHURCH = 12;

let cellsCache: Uint8Array | null = null;

/** The kind of every cell of the real ground, row by row. */
export function hkCells(): Uint8Array {
  if (cellsCache) return cellsCache;
  const out = new Uint8Array(CELL_COUNT);
  let k = 0;
  let i = 0;
  while (i < HK_CELLS.length) {
    const kind = HK_CELLS.charCodeAt(i++) - 97;
    let run = 0;
    while (i < HK_CELLS.length) {
      const c = HK_CELLS.charCodeAt(i);
      if (c < 48 || c > 57) break;
      run = run * 10 + (c - 48);
      i++;
    }
    if (run === 0) run = 1;
    out.fill(kind, k, k + run);
    k += run;
  }
  cellsCache = out;
  return out;
}

const LEVEL = fx(3.2);
const BED = fx(-1.8);

/** A town: where its flag stands (cells) and the radius of its circle (metres). */
interface Flag {
  name: string;
  x: number;
  y: number;
  r: number;
}

/**
 * The quarters in pairs, a west one and its east counterpart (the first pair is where each
 * side's computer forms up), then Kowloon Park in the middle, which both armies want.
 */
const FLAG_PLAN: readonly Flag[] = [
  { name: 'China Hong Kong City', x: 64, y: 76, r: 46 },
  { name: 'Granville Road', x: 182, y: 90, r: 48 },
  { name: 'Harbour City', x: 72, y: 138, r: 48 },
  { name: 'Mody Road', x: 186, y: 138, r: 46 },
  { name: 'Jordan', x: 124, y: 13, r: 46 },
  { name: 'Observatory Hill', x: 176, y: 44, r: 44 },
  { name: 'Haiphong Road', x: 113, y: 136, r: 46 },
  { name: 'Chungking Mansions', x: 150, y: 150, r: 46 },
  { name: 'Star Ferry', x: 88, y: 206, r: 46 },
  { name: 'Avenue of Stars', x: 206, y: 203, r: 46 },
  { name: 'Cultural Centre', x: 124, y: 212, r: 44 },
  { name: 'Signal Hill', x: 192, y: 164, r: 42 },
  { name: 'Canton Road', x: 92, y: 172, r: 44 },
  { name: 'The Peninsula', x: 142, y: 190, r: 44 },
  { name: 'Kowloon Park', x: 117, y: 76, r: 70 },
];

/**
 * The armies' bases (cells): the West Kowloon reclamation, and the slopes of Ho Man Tin
 * above the Observatory. Chosen so each army has as many quarters near it as the other:
 * by the walk of a man from each, 8 flags lie nearer the west and 7 nearer the east, and
 * the nearest eight are at much the same distances (decision 160).
 */
const BASES: readonly (readonly [number, number])[] = [
  [28, 50],
  [245, 50],
];
const BASE_CLEAR = 20;

/** Hills (cells): centre, radius, height. */
const HILLS: readonly (readonly [number, number, number, number])[] = [
  // The Observatory's wooded hill.
  [177, 42, 15, fx(5.5)],
  // Signal Hill, with its tower, above Salisbury Road.
  [193, 164, 9, fx(4)],
  // The knoll of the old Whitfield Barracks at the west of Kowloon Park.
  [104, 100, 16, fx(3.2)],
  // The rise of the park's north end.
  [118, 50, 14, fx(1.6)],
];

/** Supplies and fuel: kind, stock, cell. Each side's own, then those between them. */
const SITE_PLAN: readonly (readonly [number, number, number, number])[] = [
  // West Kowloon: the base's own, then out along the reclamation and Canton Road.
  [SITE_SUPPLIES, 8000, 8, 26],
  [SITE_SUPPLIES, 8000, 38, 16],
  [SITE_FUEL, 200, 54, 34],
  [SITE_SUPPLIES, 12000, 50, 104],
  [SITE_FUEL, 200, 72, 40],
  // Ho Man Tin: the same.
  [SITE_SUPPLIES, 8000, 240, 10],
  [SITE_SUPPLIES, 8000, 224, 62],
  [SITE_FUEL, 200, 220, 22],
  [SITE_SUPPLIES, 12000, 222, 96],
  [SITE_FUEL, 200, 206, 64],
  // Further out, nearer the other side than one's own: each side's reward for pushing.
  [SITE_SUPPLIES, 12000, 158, 30],
  [SITE_FUEL, 200, 160, 120],
  [SITE_SUPPLIES, 12000, 80, 200],
  [SITE_FUEL, 200, 98, 150],
  // In the middle: Kowloon Park and the waterfront by the Cultural Centre.
  [SITE_SUPPLIES, 16000, 108, 66],
  [SITE_FUEL, 200, 128, 104],
  [SITE_SUPPLIES, 12000, 140, 214],
];

/** Ground height at a grid vertex. */
function height(cells: Uint8Array, vx: number, vy: number, s: number): number {
  let sea = 0;
  let pond = 0;
  let pool = 0;
  for (let q = 0; q < 4; q++) {
    const cx = vx - (q & 1);
    const cy = vy - (q >> 1);
    if (cx < 0 || cy < 0 || cx >= MAP_CELLS || cy >= MAP_CELLS) {
      sea++;
      continue;
    }
    const k = cells[cy * MAP_CELLS + cx];
    if (k === HK_SEA) sea++;
    else if (k === HK_POND) pond++;
    else if (k === HK_POOL) pool++;
  }
  // The harbour: a quay wall, deep water at once.
  if (sea >= 3) return BED;
  if (pond > 0) return fx(-0.9);
  if (pool > 0) return fx(-0.45);
  // Reclaimed, made ground: dead level but for a sag here and there under the streets.
  const base = symNoise(vx, vy, 5, s) + symNoise(vx, vy, 4, s + 3);
  let h = LEVEL + Math.trunc((base - 1024) * 2);
  for (const [cx, cy, r, top] of HILLS) {
    const d = isqrt((vx - cx) * (vx - cx) + (vy - cy) * (vy - cy));
    h += (top * smooth(clampInt(Math.trunc(((r - d) * 1024) / (r - 3)), 0, 1024))) >> 10;
  }
  return h;
}

/** The Kowloon map (see the notes above). */
export function generateKowloon(seed: number): GameMap {
  const s = seed | 0;
  const N = MAP_CELLS;
  const cells = hkCells();
  const heights = new Int32Array(MAP_VERTS * MAP_VERTS);
  for (let vy = 0; vy < MAP_VERTS; vy++) {
    for (let vx = 0; vx < MAP_VERTS; vx++) heights[vy * MAP_VERTS + vx] = height(cells, vx, vy, s);
  }
  const type = new Uint8Array(CELL_COUNT);
  for (let c = 0; c < CELL_COUNT; c++) {
    const k = cells[c];
    type[c] =
      k === HK_SEA || k === HK_POND || k === HK_POOL ? T_WATER : k === HK_WOOD ? T_FOREST : T_OPEN;
  }
  const map = newMap(heights, type);
  map.layout = 'kowloon';
  const road = map.road;
  for (let c = 0; c < CELL_COUNT; c++) {
    const k = cells[c];
    road[c] =
      k === HK_ROAD
        ? ROAD_STREET
        : k === HK_PAVE || k === HK_PATH || k === HK_BUILT
          ? ROAD_PAVED
          : 0;
  }
  // The client draws the streets from the data itself; this says the map has them.
  map.streets.push(0, 0, 0, 0, 0);

  // The survey's buildings, so that no flag or site is put down on one: each is moved to
  // the nearest open ground (a forecourt, a street, a lawn) instead.
  const built = new Uint8Array(CELL_COUNT);
  for (let k = 0; k + 5 < HK_BUILDINGS.length; k += 6) {
    const [bx, by, bw, bh] = [
      HK_BUILDINGS[k],
      HK_BUILDINGS[k + 1],
      HK_BUILDINGS[k + 2],
      HK_BUILDINGS[k + 3],
    ];
    for (let y = by; y < by + bh; y++)
      for (let x = bx; x < bx + bw; x++)
        if (x >= 0 && y >= 0 && x < N && y < N) built[y * N + x] = 1;
  }
  const open = (cx: number, cy: number, r: number) => {
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 1 || y < 1 || x >= N - 1 || y >= N - 1) return false;
        const c = y * N + x;
        if (built[c] !== 0 || type[c] === T_WATER || type[c] === T_FOREST) return false;
      }
    }
    return true;
  };
  const settle = (cx: number, cy: number, r: number): [number, number] => {
    for (let ring = 0; ring <= 16; ring++) {
      let best: [number, number] | null = null;
      let bestD = Infinity;
      for (let y = cy - ring; y <= cy + ring; y++) {
        for (let x = cx - ring; x <= cx + ring; x++) {
          if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== ring) continue;
          const d = (x - cx) ** 2 + (y - cy) ** 2;
          if (d < bestD && open(x, y, r)) {
            bestD = d;
            best = [x, y];
          }
        }
      }
      if (best) return best;
    }
    return [cx, cy];
  };
  const FLAGS = FLAG_PLAN.map((f) => {
    const [x, y] = settle(f.x, f.y, 2);
    return { ...f, x, y };
  });
  const SITES = SITE_PLAN.map(([kind, stock, sx, sy]) => {
    const [x, y] = settle(sx, sy, 3);
    return [kind, stock, x, y] as const;
  });

  // Ground kept clear: the bases, a square round each flag, the resource sites.
  const clear = new Uint8Array(CELL_COUNT);
  const keep = (cx: number, cy: number, r: number, round: boolean) => {
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || y < 0 || x >= N || y >= N) continue;
        if (round && (x - cx) * (x - cx) + (y - cy) * (y - cy) > r * r) continue;
        clear[y * N + x] = 1;
      }
    }
  };
  for (const [bx, by] of BASES) keep(bx, by, BASE_CLEAR, true);
  for (const f of FLAGS) keep(f.x, f.y, 2, false);
  for (const [, , x, y] of SITES) keep(x, y, 3, false);
  // The bases stand on open, level, paved ground: the yards and lawns of the reclamations.
  for (const [bx, by] of BASES) {
    for (let y = by - BASE_CLEAR; y <= by + BASE_CLEAR; y++) {
      for (let x = bx - BASE_CLEAR; x <= bx + BASE_CLEAR; x++) {
        if (x < 1 || y < 1 || x >= N - 1 || y >= N - 1) continue;
        const c = y * N + x;
        if (clear[c] === 0 || type[c] === T_WATER) continue;
        type[c] = T_OPEN;
        if (road[c] === 0) road[c] = ROAD_PAVED;
      }
    }
  }
  map.baseType.set(type);

  const at = (c: number) => (c << CELL_SHIFT) + (CELL_FX >> 1);
  for (const f of FLAGS) addTown(map, at(f.x), at(f.y), fx(f.r), f.name);
  /** The flag a building belongs to: the nearest within 22 cells, or -1. */
  const flagAt = (x: number, y: number) => {
    let best = -1;
    let bestD = 22 * 22 + 1;
    for (let k = 0; k < FLAGS.length; k++) {
      const d = (x - FLAGS[k].x) ** 2 + (y - FLAGS[k].y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    return best;
  };
  const B = HK_BUILDINGS;
  for (let k = 0; k + 5 < B.length; k += 6) {
    const x = B[k];
    const y = B[k + 1];
    const w = B[k + 2];
    const h = B[k + 3];
    let blocked = x < 1 || y < 1 || x + w >= N || y + h >= N;
    for (let j = y; j < y + h && !blocked; j++) {
      for (let i = x; i < x + w; i++) {
        const c = j * N + i;
        if (clear[c] !== 0 || type[c] !== T_OPEN || road[c] === ROAD_STREET) {
          blocked = true;
          break;
        }
      }
    }
    if (blocked || !levelPlot(map, x, y, w, h)) continue;
    const town = flagAt(x + (w >> 1), y + (h >> 1));
    // The mosque is three storeys and a dome, whatever its height in the survey.
    const floors = B[k + 5] === STYLE_MOSQUE ? Math.min(3, B[k + 4]) : B[k + 4];
    const st = addStructure(map, S_BUILDING, x, y, w, h, town, floors);
    if (st >= 0) map.sStyle[st] = B[k + 5];
  }
  finishMap(map);

  for (let side = 0; side < 2; side++) {
    const [bx, by] = BASES[side];
    const c = findCell(bx, by, 16, (x, y) => canPlace(map, x, y, START_PLOT, START_PLOT));
    if (c >= 0) {
      map.startX[side] = c % N;
      map.startY[side] = Math.trunc(c / N);
    }
  }
  for (const [kind, stock, x, y] of SITES) addSite(map, kind, stock, at(x), at(y));

  // The ways across, for the computer: through Kowloon Park, along Austin Road in the north,
  // down Haiphong and Peking Roads, and along Salisbury Road by the water. Each runs from a
  // quarter of the west to its counterpart in the east, or between two points.
  const lane = (mx: number, my: number, w: number, wx = 0, wy = 0, ex = 0, ey = 0): Lane => ({
    x: at(mx),
    y: at(my),
    bankX: w >= 0 ? [map.townX[w], map.townX[w + 1]] : [at(wx), at(ex)],
    bankY: w >= 0 ? [map.townY[w], map.townY[w + 1]] : [at(wy), at(ey)],
    town: w >= 0 ? [w, w + 1] : [-1, -1],
  });
  map.lanes = [
    lane(117, 76, 0),
    lane(130, 140, 2),
    lane(150, 20, 4),
    lane(132, 146, 6),
    lane(150, 196, -1, 100, 190, 196, 196),
    lane(146, 60, -1, 96, 30, 196, 70),
  ];
  return map;
}
