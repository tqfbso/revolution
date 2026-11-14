// Paratroops (decision 106). They are trained into a reserve that waits off the map, and a
// second order drops them: a transport plane comes in over the army's own edge of the map
// with up to PARA_PLANE_LOAD squads aboard, flies straight at the point asked for, puts them
// out over it and turns for home. Nobody steers the plane and nothing but air defence can
// touch it; shot down on the way in, it takes everyone aboard with it.
//
// Helicopters need none of this: they are ordinary units that happen to fly (see units.ts)
// and are limited by their helipads (see economy.ts).
import { CMD_PARADROP, type Command } from './commands';
import { clampInt, fx, isqrt } from './fixed';
import { CELL_FX, CELL_SHIFT, CLASS_FOOT, MAP_CELLS, MAX_TEAMS, cellOfPos, layerOf } from './map';
import { nextInt } from './rng';
import { spawnUnit } from './sim';
import {
  KIND_PARA,
  KIND_PLANE,
  KINDS,
  PARA_LAND_TICKS,
  PARA_PLANE_LOAD,
  PARA_SCATTER,
} from './units';
import {
  EV_PARADROP,
  EV_PLANE,
  MAP_SIZE_FX,
  NO_TARGET,
  STATE_ALIVE,
  STATE_FREE,
  STAT_SEATS,
  packPoint,
  type World,
} from './world';

const POS_MAX = MAP_SIZE_FX - 1;
/** `cargo` of a plane: on its way in with the squads, or on its way out without them. */
const INBOUND = 0;
const OUTBOUND = 1;
/** A plane this close to where it came in is gone. */
const EXIT_DIST = fx(10);
const EDGE = fx(5);
/** Drops closer to the edge than this are moved in: the plane needs room to turn. */
const DROP_MARGIN = fx(24);

/** Where `team`'s planes come from: the point on the edge of the map nearest its base. */
export function planeEntry(w: World, team: number): [number, number] {
  const hx = (w.map.startX[team] << CELL_SHIFT) + (CELL_FX >> 1);
  const hy = (w.map.startY[team] << CELL_SHIFT) + (CELL_FX >> 1);
  const west = hx;
  const east = POS_MAX - hx;
  const north = hy;
  const south = POS_MAX - hy;
  const least = Math.min(west, east, north, south);
  if (least === west) return [0, hy];
  if (least === east) return [POS_MAX, hy];
  if (least === north) return [hx, 0];
  return [hx, POS_MAX];
}

function face(w: World, i: number, dx: number, dy: number): void {
  const len = isqrt(dx * dx + dy * dy);
  if (len === 0) return;
  w.faceX[i] = Math.trunc((dx * 1024) / len);
  w.faceY[i] = Math.trunc((dy * 1024) / len);
}

export function applyAirCommand(w: World, cmd: Command): boolean {
  if (cmd.type !== CMD_PARADROP) return false;
  const team = cmd.team;
  if (!Number.isInteger(team) || team < 0 || team >= MAX_TEAMS) return true;
  if (w.paraReserve[team] <= 0) return true;
  const x = clampInt(cmd.x | 0, DROP_MARGIN, POS_MAX - DROP_MARGIN);
  const y = clampInt(cmd.y | 0, DROP_MARGIN, POS_MAX - DROP_MARGIN);
  const [ex, ey] = planeEntry(w, team);
  const plane = spawnUnit(w, KIND_PLANE, team, ex, ey);
  if (plane < 0) return true;
  w.posX[plane] = ex;
  w.posY[plane] = ey;
  w.targetX[plane] = x;
  w.targetY[plane] = y;
  w.aimX[plane] = ex;
  w.aimY[plane] = ey;
  w.cargo[plane] = INBOUND;
  face(w, plane, x - ex, y - ey);
  const want = Math.min(w.paraReserve[team], PARA_PLANE_LOAD);
  let aboard = 0;
  for (let k = 0; k < want; k++) {
    const id = spawnUnit(w, KIND_PARA, team, ex, ey);
    if (id < 0) break;
    w.posX[id] = ex;
    w.posY[id] = ey;
    w.carrier[id] = plane;
    if (cmd.by !== undefined && cmd.by >= 0 && cmd.by < STAT_SEATS) w.seat[id] = cmd.by;
    aboard++;
  }
  if (aboard === 0) {
    w.state[plane] = STATE_FREE;
    return true;
  }
  w.load[plane] = aboard;
  w.paraReserve[team] -= aboard;
  w.events.push(EV_PLANE, plane, aboard);
  return true;
}

/** Everyone out, scattered round the point, each squad on ground it can stand on. */
function drop(w: World, plane: number): void {
  const map = w.map;
  const team = w.team[plane];
  const layer = layerOf(team, CLASS_FOOT);
  const x = w.targetX[plane];
  const y = w.targetY[plane];
  let out = 0;
  for (let j = 0; j < w.count; j++) {
    if (w.carrier[j] !== plane || w.state[j] !== STATE_ALIVE) continue;
    w.carrier[j] = -1;
    const px = clampInt(x + nextInt(w.rng, 2 * PARA_SCATTER + 1) - PARA_SCATTER, 0, POS_MAX);
    const py = clampInt(y + nextInt(w.rng, 2 * PARA_SCATTER + 1) - PARA_SCATTER, 0, POS_MAX);
    const to = map.snap[layer][cellOfPos(px, py)];
    w.posX[j] = ((to & (MAP_CELLS - 1)) << CELL_SHIFT) + (CELL_FX >> 1);
    w.posY[j] = ((to >> 8) << CELL_SHIFT) + (CELL_FX >> 1);
    w.targetX[j] = w.posX[j];
    w.targetY[j] = w.posY[j];
    w.velX[j] = 0;
    w.velY[j] = 0;
    w.flags[j] = 0;
    w.attack[j] = NO_TARGET;
    // Coming down and getting out of the harness: they cannot shoot back yet.
    w.cooldown[j] = PARA_LAND_TICKS + 4 * out;
    out++;
  }
  w.load[plane] = 0;
  w.events.push(EV_PARADROP, packPoint(x, y), team | (out << 8));
}

/** Fly the planes: straight in, everyone out over the point, round and home. */
export function updateAir(w: World): void {
  const n = w.count;
  for (let i = 0; i < n; i++) {
    if (w.kind[i] !== KIND_PLANE || w.state[i] !== STATE_ALIVE) continue;
    const x = w.posX[i];
    const y = w.posY[i];
    let dx = w.targetX[i] - x;
    let dy = w.targetY[i] - y;
    const fxi = w.faceX[i];
    const fyi = w.faceY[i];
    if (w.cargo[i] === INBOUND) {
      // Over the point, or as near as this pass gets to it.
      if (dx * dx + dy * dy <= fx(3) * fx(3) || dx * fxi + dy * fyi <= 0) {
        drop(w, i);
        w.cargo[i] = OUTBOUND;
        w.targetX[i] = w.aimX[i];
        w.targetY[i] = w.aimY[i];
        dx = w.targetX[i] - x;
        dy = w.targetY[i] - y;
      }
    } else if (
      dx * dx + dy * dy <= EXIT_DIST * EXIT_DIST ||
      x < EDGE ||
      y < EDGE ||
      x > POS_MAX - EDGE ||
      y > POS_MAX - EDGE
    ) {
      // Back where it came in, or over any edge of the map: gone.
      w.state[i] = STATE_FREE;
      w.velX[i] = 0;
      w.velY[i] = 0;
      continue;
    }
    // A wide turn toward where it is going, then full speed along the nose.
    const len = isqrt(dx * dx + dy * dy);
    if (len > 0) {
      let ux = Math.trunc((dx * 1024) / len);
      let uy = Math.trunc((dy * 1024) / len);
      if (fxi * ux + fyi * uy < -900 * 1024) {
        // Dead astern: break to one side.
        ux = -fyi;
        uy = fxi;
      }
      const turn = KINDS[KIND_PLANE].turn;
      const bx = fxi * turn + ux;
      const by = fyi * turn + uy;
      const bl = isqrt(bx * bx + by * by);
      if (bl > 0) {
        w.faceX[i] = Math.trunc((bx * 1024) / bl);
        w.faceY[i] = Math.trunc((by * 1024) / bl);
      }
    }
    const s = w.speed[i];
    w.velX[i] = Math.trunc((w.faceX[i] * s) / 1024);
    w.velY[i] = Math.trunc((w.faceY[i] * s) / 1024);
  }
}
