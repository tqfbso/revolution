// Where a building has been hit (decision 157).
//
// A building's health is still one number, and how fast it goes is the same as before. What
// this adds is a record of where on the building the damage landed: the footprint is cut
// into a grid of up to SCAR_SIDE by SCAR_SIDE sections (one to a cell on a small house), and
// every hit adds to the section it struck. A tank across the street strikes the sections
// along the face it sees, near the line it fires along; a shell strikes the section it
// lands on; a charge the one it was laid against. The client takes that record and brings
// the building down where it was hit: a corner, a bite out of one face, a tower that loses
// one section at a time, instead of a level cut from the roof down.
//
// The record decides nothing in the battle, so it is left out of the world hash: the fight
// is the same with it as without it, hit for hit.
import {
  CELL_FX,
  CELL_SHIFT,
  FACE_EAST,
  FACE_NORTH,
  FACE_WEST,
  S_BUILDING,
  type GameMap,
} from './map';
import type { World } from './world';

/** Sections along a side of the grid, at most. */
export const SCAR_SIDE = 4;
/** Sections per building in the world's record (a full grid, used or not). */
export const SCAR_CELLS = SCAR_SIDE * SCAR_SIDE;
const SCAR_TOP = 60000;

/** Sections of building `s` across (x) and down (y). */
export function scarGrid(map: GameMap, s: number): [number, number] {
  return [Math.min(SCAR_SIDE, map.sW[s]), Math.min(SCAR_SIDE, map.sH[s])];
}

/** Damage `amount` landed at (x, y), which is brought inside the footprint of building `s`. */
export function scarAt(w: World, s: number, x: number, y: number, amount: number): void {
  const map = w.map;
  if (amount <= 0 || map.sKind[s] !== S_BUILDING) return;
  const [gx, gy] = scarGrid(map, s);
  const x0 = map.sX[s] << CELL_SHIFT;
  const y0 = map.sY[s] << CELL_SHIFT;
  const wide = map.sW[s] << CELL_SHIFT;
  const deep = map.sH[s] << CELL_SHIFT;
  const ix = Math.min(gx - 1, Math.max(0, Math.trunc(((x - x0) * gx) / wide)));
  const iy = Math.min(gy - 1, Math.max(0, Math.trunc(((y - y0) * gy) / deep)));
  const at = s * SCAR_CELLS;
  const k = at + iy * SCAR_SIDE + ix;
  if (w.sScar[k] + amount > SCAR_TOP) {
    // Keep the shape and make room: halve the lot.
    for (let c = 0; c < SCAR_CELLS; c++) w.sScar[at + c] >>= 1;
  }
  w.sScar[k] = Math.min(SCAR_TOP, w.sScar[k] + amount);
}

/**
 * Damage `amount` from a shot fired from (fx, fy) at building `s`, which meets `face` where
 * the line to the middle of the building crosses it, moved `along` the face by that much.
 */
export function scarFace(
  w: World,
  s: number,
  face: number,
  fromX: number,
  fromY: number,
  along: number,
  amount: number,
): void {
  const map = w.map;
  const x0 = map.sX[s] << CELL_SHIFT;
  const y0 = map.sY[s] << CELL_SHIFT;
  const x1 = x0 + (map.sW[s] << CELL_SHIFT);
  const y1 = y0 + (map.sH[s] << CELL_SHIFT);
  const cx = (x0 + x1) >> 1;
  const cy = (y0 + y1) >> 1;
  const dx = fromX - cx;
  const dy = fromY - cy;
  const half = CELL_FX >> 1;
  let x: number;
  let y: number;
  if (face === FACE_EAST || face === FACE_WEST) {
    const ex = face === FACE_EAST ? x1 : x0;
    y = dx === 0 ? cy : cy + Math.trunc(((ex - cx) * dy) / dx);
    y += along;
    x = face === FACE_EAST ? ex - half : ex + half;
  } else {
    const ey = face === FACE_NORTH ? y0 : y1;
    x = dy === 0 ? cx : cx + Math.trunc(((ey - cy) * dx) / dy);
    x += along;
    y = face === FACE_NORTH ? ey + half : ey - half;
  }
  scarAt(w, s, x, y, amount);
}

/** The building is whole again: nothing to show. */
export function clearScars(w: World, s: number): void {
  w.sScar.fill(0, s * SCAR_CELLS, (s + 1) * SCAR_CELLS);
}
