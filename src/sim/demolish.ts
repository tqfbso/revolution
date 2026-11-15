// Demolition by engineers that is not a charge against a wall (decision 118): felling trees.
//
// A wood stops vehicles, hides whoever stands in it and blocks the view through it. An
// engineer squad sent to fell it turns a patch of it into open ground, cell by cell: a lane
// for the tanks, a field of fire in front of a position, an ambush taken away from the
// enemy. Trees do not grow back.
//
// Buildings, bridges and field works are brought down with charges (FLAG_SIEGE and
// FLAG_BREACH in sim.ts); who dies in a house that is brought down is in civilians.ts.
import { CMD_FELL, type Command } from './commands';
import { clampInt, fx } from './fixed';
import { CELL_FX, CELL_SHIFT, MAP_CELLS, T_FOREST, T_OPEN, cellOfPos } from './map';
import { leaveHouse, markGround, sendTo, validUnits } from './sim';
import { KINDS } from './units';
import {
  EV_FELL,
  FLAG_AMOVE,
  FLAG_MOVING,
  JOB_FELL,
  JOB_NONE,
  MAP_SIZE_FX,
  STATE_ALIVE,
  TICK_RATE,
  type World,
} from './world';

/** A felling order clears the forest cells within this many cells of the one clicked. */
export const FELL_CELLS = 2;
/** Work-ticks by one squad to clear a cell: two seconds. */
export const FELL_TICKS = 2 * TICK_RATE;
/** How close the squad must be to the middle of the cell it works on. */
const REACH = fx(6.5);

const centre = (c: number) => (c << CELL_SHIFT) + (CELL_FX >> 1);

/** The forest cell of the patch round `at` that is nearest to (x, y), or -1 when none is left. */
export function nextTree(w: World, at: number, x: number, y: number): number {
  const map = w.map;
  const ax = at & (MAP_CELLS - 1);
  const ay = at >> 8;
  let best = -1;
  let bestD = 0;
  for (let j = ay - FELL_CELLS; j <= ay + FELL_CELLS; j++) {
    for (let i = ax - FELL_CELLS; i <= ax + FELL_CELLS; i++) {
      if (i < 0 || j < 0 || i >= MAP_CELLS || j >= MAP_CELLS) continue;
      // A round patch, not a square one.
      if ((i - ax) * (i - ax) + (j - ay) * (j - ay) > FELL_CELLS * FELL_CELLS + 1) continue;
      const c = j * MAP_CELLS + i;
      if (map.type[c] !== T_FOREST) continue;
      const dx = centre(i) - x;
      const dy = centre(j) - y;
      const d = dx * dx + dy * dy;
      if (best < 0 || d < bestD) {
        best = c;
        bestD = d;
      }
    }
  }
  return best;
}

/** The command that sends engineers to fell trees. False if `cmd` is not it. */
export function applyDemolishCommand(w: World, cmd: Command): boolean {
  if (cmd.type !== CMD_FELL) return false;
  const x = clampInt(cmd.x | 0, 0, MAP_SIZE_FX - 1);
  const y = clampInt(cmd.y | 0, 0, MAP_SIZE_FX - 1);
  const at = cellOfPos(x, y);
  if (nextTree(w, at, x, y) < 0) return true;
  for (const id of validUnits(w, cmd.units)) {
    if (!KINDS[w.kind[id]].engineer) continue;
    leaveHouse(w, id);
    w.job[id] = JOB_FELL;
    w.jobCell[id] = at;
    w.jobTimer[id] = 0;
    const c = nextTree(w, at, w.posX[id], w.posY[id]);
    sendTo(w, id, centre(c & (MAP_CELLS - 1)), centre(c >> 8));
  }
  return true;
}

/** One tick of felling: walk up to the nearest tree of the patch, cut, on to the next. */
export function updateFelling(w: World): void {
  const map = w.map;
  for (let i = 0; i < w.count; i++) {
    if (w.job[i] !== JOB_FELL) continue;
    if (w.state[i] !== STATE_ALIVE) {
      w.job[i] = JOB_NONE;
      continue;
    }
    const x = w.posX[i];
    const y = w.posY[i];
    const c = nextTree(w, w.jobCell[i], x, y);
    if (c < 0) {
      w.job[i] = JOB_NONE;
      w.jobTimer[i] = 0;
      continue;
    }
    const cx = centre(c & (MAP_CELLS - 1));
    const cy = centre(c >> 8);
    const dx = cx - x;
    const dy = cy - y;
    if (dx * dx + dy * dy > REACH * REACH) {
      if ((w.tick + i) % 10 === 0 && (w.flags[i] & FLAG_MOVING) === 0) sendTo(w, i, cx, cy);
      continue;
    }
    w.flags[i] &= ~(FLAG_MOVING | FLAG_AMOVE);
    if (++w.jobTimer[i] < FELL_TICKS) continue;
    w.jobTimer[i] = 0;
    map.type[c] = T_OPEN;
    map.baseType[c] = T_OPEN;
    w.felled[w.felledCount++] = c;
    markGround();
    w.events.push(EV_FELL, c, w.team[i]);
  }
}
