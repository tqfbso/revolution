// Civilians (decision 102): the people who live in the houses the battle is fought over.
//
// They are not units. Nobody orders them, targets them or bumps into them; they are a few
// hundred points with a state, kept apart from the unit arrays so that the search for
// targets and the steering never see them. Each stays in its house until shooting comes
// near, then runs for the nearest edge of the map and is gone. On the way a round that
// passes close, a shell that lands near, or a shell on the house it has not yet left can
// kill it. No gore: the client lets it fall and fades it out. The army that fired pays.
import { clampInt, fx, isqrt } from './fixed';
import {
  CELL_FX,
  CELL_SHIFT,
  CLASS_AIR,
  CLASS_FOOT,
  MAP_CELLS,
  S_BUILDING,
  T_BUILDING,
  layerOf,
} from './map';
import { DIR_CELL, UNREACHABLE, buildField } from './path';
import { nextInt, nextU32, seedRng } from './rng';
import { BLAST_STRAY, KINDS } from './units';
import { EV_CIVILIAN, packPoint, type World } from './world';

// (This module and world.ts import each other, so nothing here may read a constant of
// world.ts while the module is being loaded: hence the tick rate below is written out.)
const TICK_RATE = 20;

/** Civilians on a map at most, and what each is doing. */
export const MAX_CIVILIANS = 512;
export const CIV_NONE = 0;
export const CIV_HOME = 1;
export const CIV_FLEEING = 2;
/** Reached the edge of the map and left it. */
export const CIV_GONE = 3;
export const CIV_DEAD = 4;
/** The squares in which shooting is remembered: 16 world units a side. */
export const DANGER_SHIFT = 14;
export const DANGER_DIM = 64;

/** Civilians on a map: this many, or fewer where there are few houses to put them in. */
export const CIVILIANS = 400;
const PER_BUILDING = 3;
/** What a dead civilian costs the army that killed it. */
export const CIVILIAN_SUPPLIES = 100;
export const CIVILIAN_CREDITS = 40;
/** An army cannot be fined deeper into debt than this. */
export const SUPPLY_FLOOR = -1500;
/** How long a place stays dangerous after a shot or a burst there. */
const DANGER_TICKS = 15 * TICK_RATE;
/** A running civilian covers about 3.4 m a second, a little more or less each. */
const SPEED = fx(0.17);
/** A round passing this close can hit (one time in STRAY_ODDS); a warhead's burst reaches further. */
const STRAY_REACH = fx(2);
const STRAY_ODDS = 8;
const BURST_REACH = fx(5);
/** The way out is worked out again this often, while anyone is running. */
const FIELD_EVERY = 30 * TICK_RATE;
const FOOT_LAYER = layerOf(0, CLASS_FOOT);

/** Scratch: the civilians in the open this tick. Rebuilt by updateCivilians. */
const running = new Int32Array(MAX_CIVILIANS);
let runningCount = 0;
const goals = new Int32Array(4 * MAP_CELLS);

/** Put the civilians of a new world into its houses. The same for the same seed and map. */
export function placeCivilians(w: World, seed: number): void {
  const map = w.map;
  const houses: number[] = [];
  for (let s = 0; s < map.structCount; s++) if (map.sKind[s] === S_BUILDING) houses.push(s);
  w.civCount = 0;
  if (houses.length === 0) return;
  // Its own dice, so that the world's are not touched by who lives where.
  const rng = new Uint32Array(1);
  seedRng(rng, seed ^ 0x51c1a5);
  const n = Math.min(CIVILIANS, MAX_CIVILIANS, PER_BUILDING * houses.length);
  for (let k = 0; k < n; k++) {
    const s = houses[nextU32(rng) % houses.length];
    w.civHome[k] = s;
    w.civState[k] = CIV_HOME;
    w.civX[k] = ((2 * map.sX[s] + map.sW[s]) << CELL_SHIFT) >> 1;
    w.civY[k] = ((2 * map.sY[s] + map.sH[s]) << CELL_SHIFT) >> 1;
  }
  w.civCount = n;
}

const square = (x: number, y: number) =>
  clampInt(y >> DANGER_SHIFT, 0, DANGER_DIM - 1) * DANGER_DIM +
  clampInt(x >> DANGER_SHIFT, 0, DANGER_DIM - 1);

function markDanger(w: World, x: number, y: number): void {
  w.danger[square(x, y)] = w.tick + DANGER_TICKS;
}

/** Is there shooting in the square of (x, y) or in one next to it? */
function unsafe(w: World, x: number, y: number): boolean {
  const cx = clampInt(x >> DANGER_SHIFT, 0, DANGER_DIM - 1);
  const cy = clampInt(y >> DANGER_SHIFT, 0, DANGER_DIM - 1);
  for (let j = cy - 1; j <= cy + 1; j++) {
    for (let i = cx - 1; i <= cx + 1; i++) {
      if (i < 0 || j < 0 || i >= DANGER_DIM || j >= DANGER_DIM) continue;
      if (w.danger[j * DANGER_DIM + i] > w.tick) return true;
    }
  }
  return false;
}

/** Out of the house, onto the nearest ground a person can stand on. */
function leave(w: World, k: number): void {
  const map = w.map;
  let c = (w.civY[k] >> CELL_SHIFT) * MAP_CELLS + (w.civX[k] >> CELL_SHIFT);
  if (map.cost[FOOT_LAYER][c] === 0) c = map.snap[FOOT_LAYER][c];
  w.civX[k] = ((c & (MAP_CELLS - 1)) << CELL_SHIFT) + (CELL_FX >> 1);
  w.civY[k] = ((c >> 8) << CELL_SHIFT) + (CELL_FX >> 1);
  w.civState[k] = CIV_FLEEING;
}

function die(w: World, k: number, team: number): void {
  w.civState[k] = CIV_DEAD;
  w.civKilled[team]++;
  const s = w.supplies[team] - CIVILIAN_SUPPLIES;
  w.supplies[team] = s < SUPPLY_FLOOR ? Math.min(w.supplies[team], SUPPLY_FLOOR) : s;
  const c = w.credits[team] - CIVILIAN_CREDITS;
  w.credits[team] = c < 0 ? 0 : c;
  w.events.push(EV_CIVILIAN, packPoint(w.civX[k], w.civY[k]), team);
}

/** The way to the nearest edge of the map from everywhere, on foot. */
function wayOut(w: World): Uint16Array {
  const map = w.map;
  const field = w.civField ?? (w.civField = new Uint16Array(MAP_CELLS * MAP_CELLS));
  let n = 0;
  const last = MAP_CELLS - 2;
  for (let i = 1; i <= last; i++) {
    for (const c of [
      MAP_CELLS + i,
      last * MAP_CELLS + i,
      i * MAP_CELLS + 1,
      i * MAP_CELLS + last,
    ]) {
      if (map.cost[FOOT_LAYER][c] !== 0) goals[n++] = c;
    }
  }
  buildField(map, FOOT_LAYER, field, goals, n, UNREACHABLE - 1);
  w.civFieldAt = w.tick;
  return field;
}

/** One tick of the civilians: those at home look out of the window, those outside run. */
export function updateCivilians(w: World): void {
  const n = w.civCount;
  runningCount = 0;
  if (n === 0) return;
  const map = w.map;
  const tick = w.tick;
  let field: Uint16Array | null = null;
  for (let k = 0; k < n; k++) {
    const state = w.civState[k];
    if (state === CIV_HOME) {
      // Once a second each, not all on the same tick.
      if ((tick + k) % TICK_RATE !== 0) continue;
      const home = w.civHome[k];
      if (w.sHp[home] > 0 && !unsafe(w, w.civX[k], w.civY[k])) continue;
      leave(w, k);
      continue;
    }
    if (state !== CIV_FLEEING) continue;
    if (field === null) {
      field = w.civField === null || tick - w.civFieldAt >= FIELD_EVERY ? wayOut(w) : w.civField;
    }
    const x = w.civX[k];
    const y = w.civY[k];
    const cx = x >> CELL_SHIFT;
    const cy = y >> CELL_SHIFT;
    let c = cy * MAP_CELLS + cx;
    if (map.cost[FOOT_LAYER][c] === 0) {
      // Something was put up where it stood: step off it.
      leave(w, k);
      running[runningCount++] = k;
      continue;
    }
    if (field[c] === 0) {
      w.civState[k] = CIV_GONE;
      w.civEscaped++;
      continue;
    }
    running[runningCount++] = k;
    let best = c;
    let bestD = field[c];
    const hard = map.cost[FOOT_LAYER];
    for (let d = 0; d < 8; d++) {
      const to = c + DIR_CELL[d];
      const tx = to & (MAP_CELLS - 1);
      const ty = to >> 8;
      if (to < 0 || ty >= MAP_CELLS || tx - cx > 1 || cx - tx > 1) continue;
      // Never across the corner of a wall.
      if ((d & 1) !== 0 && (hard[cy * MAP_CELLS + tx] === 0 || hard[ty * MAP_CELLS + cx] === 0))
        continue;
      if (field[to] < bestD) {
        bestD = field[to];
        best = to;
      }
    }
    // Shut in: it stays where it is and hopes.
    if (best === c) continue;
    c = best;
    // Each keeps a little to one side of the middle of the street, so a crowd is a crowd.
    const gx =
      ((c & (MAP_CELLS - 1)) << CELL_SHIFT) + (CELL_FX >> 1) + (((k * 37) % 9) - 4) * fx(0.3);
    const gy = ((c >> 8) << CELL_SHIFT) + (CELL_FX >> 1) + (((k * 53) % 9) - 4) * fx(0.3);
    const dx = gx - x;
    const dy = gy - y;
    const d = isqrt(dx * dx + dy * dy);
    if (d === 0) continue;
    const speed = SPEED + (((k * 29) % 7) - 3) * fx(0.008);
    if (d <= speed) {
      w.civX[k] = gx;
      w.civY[k] = gy;
    } else {
      w.civX[k] = x + Math.trunc((dx * speed) / d);
      w.civY[k] = y + Math.trunc((dy * speed) / d);
    }
  }
}

/**
 * Unit `i` has just fired at unit `t`. The place is dangerous from now on, and whoever is
 * running through the line of fire, or stands where a warhead goes off, may be hit.
 */
export function civiliansShot(w: World, i: number, t: number): void {
  if (w.civCount === 0) return;
  const ax = w.posX[i];
  const ay = w.posY[i];
  const bx = w.posX[t];
  const by = w.posY[t];
  markDanger(w, ax, ay);
  markDanger(w, bx, by);
  if (runningCount === 0) return;
  const kind = KINDS[w.kind[i]];
  if (KINDS[w.kind[t]].cls === CLASS_AIR) return;
  const team = w.team[i];
  if (kind.kamikaze || kind.stray >= BLAST_STRAY) {
    burst(w, bx, by, BURST_REACH, team);
    if (kind.kamikaze) return;
  }
  const dx = bx - ax;
  const dy = by - ay;
  const len = isqrt(dx * dx + dy * dy);
  if (len === 0) return;
  const x0 = (ax < bx ? ax : bx) - STRAY_REACH;
  const x1 = (ax < bx ? bx : ax) + STRAY_REACH;
  const y0 = (ay < by ? ay : by) - STRAY_REACH;
  const y1 = (ay < by ? by : ay) + STRAY_REACH;
  for (let r = 0; r < runningCount; r++) {
    const k = running[r];
    const px = w.civX[k];
    const py = w.civY[k];
    if (px < x0 || px > x1 || py < y0 || py > y1 || w.civState[k] !== CIV_FLEEING) continue;
    // Beside the line between the two, and between them.
    const along = (px - ax) * dx + (py - ay) * dy;
    if (along < 0 || along > len * len) continue;
    const off = (px - ax) * dy - (py - ay) * dx;
    if ((off < 0 ? -off : off) >= STRAY_REACH * len) continue;
    if (nextInt(w.rng, STRAY_ODDS) === 0) die(w, k, team);
  }
}

/** Everyone in the open within `R` of a burst: sure to die close in, half of them further out. */
function burst(w: World, x: number, y: number, R: number, team: number): void {
  for (let r = 0; r < runningCount; r++) {
    const k = running[r];
    if (w.civState[k] !== CIV_FLEEING) continue;
    const dx = w.civX[k] - x;
    const dy = w.civY[k] - y;
    if (dx > R || dx < -R || dy > R || dy < -R) continue;
    const d2 = dx * dx + dy * dy;
    if (d2 >= R * R) continue;
    if (4 * d2 < R * R || nextInt(w.rng, 2) === 0) die(w, k, team);
  }
}

/**
 * A shell of `team` has landed at (x, y) with a burst of radius `R`. In the open it kills
 * like any burst. On a house with people still in it, half of them die and the rest run.
 */
export function civiliansShelled(w: World, x: number, y: number, R: number, team: number): void {
  if (w.civCount === 0) return;
  markDanger(w, x, y);
  if (runningCount > 0) burst(w, x, y, R, team);
  const map = w.map;
  const c =
    clampInt(y >> CELL_SHIFT, 0, MAP_CELLS - 1) * MAP_CELLS +
    clampInt(x >> CELL_SHIFT, 0, MAP_CELLS - 1);
  if (map.type[c] !== T_BUILDING) return;
  const s = map.structAt[c];
  if (s < 0 || map.sKind[s] !== S_BUILDING) return;
  for (let k = 0; k < w.civCount; k++) {
    if (w.civState[k] !== CIV_HOME || w.civHome[k] !== s) continue;
    if (nextInt(w.rng, 2) === 0) die(w, k, team);
    else leave(w, k);
  }
}
