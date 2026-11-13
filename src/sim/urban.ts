// The city as it is destroyed and held (U4, decision 091): rubble that a falling block
// throws into the streets beside it, and engineers who mend a building or fortify it.
import { CMD_ENTRENCH, type Command } from './commands';
import { fx } from './fixed';
import { CELL_FX, MAP_CELLS, S_BUILDING, STAGE_INTACT, wallMax } from './map';
import { nextInt } from './rng';
import { leaveHouse, sendTo, stageOf, structDist2, validUnits } from './sim';
import { KINDS, KIND_TRUCK } from './units';
import { WORK_RUBBLE, canFortify, placeWork } from './works';
import {
  EV_FORTIFIED,
  FLAG_AMOVE,
  FLAG_MOVING,
  JOB_ENTRENCH,
  JOB_NONE,
  STATE_ALIVE,
  TICK_RATE,
  type World,
} from './world';

/** A building of this many floors or more throws rubble into the street when it falls. */
export const SPILL_FLOORS = 4;
/** Out of 100: how much of the ring of cells round a fallen block is buried. */
const SPILL_PCT = 55;
/** Work-ticks by engineers to fortify a building: 15 seconds for one squad. */
export const FORT_TICKS = 15 * TICK_RATE;
/** A builder mends this fraction of a structure a tick: a ruined shell takes 80 seconds. */
const MEND_DIV = 1600;
/** Mending costs one of supplies every so many work-ticks. */
const MEND_COST_EVERY = 8;
const REACH = fx(7);
const MAX_CREW = 3;

const crew = new Uint8Array(1024);

const isEngineer = (kind: number): boolean => KINDS[kind].engineer;
const isBuilder = (kind: number): boolean => kind === KIND_TRUCK || isEngineer(kind);

/** Is the building fortified (sandbagged, loopholed)? */
export function fortified(w: World, s: number): boolean {
  return w.sFort[s] >= FORT_TICKS;
}

/**
 * Building `s` has just fallen. If it was tall, part of it lands in the streets beside it:
 * rubble no vehicle can cross until engineers clear it. Shelling a block shuts the streets
 * round it, for the side that fired as much as for the other.
 */
export function spillRubble(w: World, s: number): void {
  const map = w.map;
  if (map.sKind[s] !== S_BUILDING || map.sFloors[s] < SPILL_FLOORS) return;
  const x0 = map.sX[s] - 1;
  const y0 = map.sY[s] - 1;
  const x1 = map.sX[s] + map.sW[s];
  const y1 = map.sY[s] + map.sH[s];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (x > x0 && x < x1 && y > y0 && y < y1) continue;
      if (x < 0 || y < 0 || x >= MAP_CELLS || y >= MAP_CELLS) continue;
      const c = y * MAP_CELLS + x;
      // Drawn for every cell of the ring, so what falls where does not depend on what
      // happened to be standing there.
      if (nextInt(w.rng, 100) >= SPILL_PCT) continue;
      if (w.wKind[c] !== 0 || !canFortify(map, WORK_RUBBLE, c)) continue;
      placeWork(w, WORK_RUBBLE, c);
    }
  }
}

/** May `team` work on building `s`? Not while the enemy is inside it. */
function mayWork(w: World, s: number, team: number): boolean {
  const map = w.map;
  if (!Number.isInteger(s) || s < 0 || s >= map.structCount) return false;
  if (map.sKind[s] !== S_BUILDING) return false;
  return w.sOcc[s] === 0 || w.sOccTeam[s] === team;
}

/** Is there anything left for this kind of builder to do on `s`? */
function workLeft(w: World, s: number, kind: number): boolean {
  if (w.sHp[s] > 0 && w.sHp[s] < w.map.sMaxHp[s]) return true;
  if (w.sHp[s] > 0) {
    for (let f = 0; f < 4; f++) if (w.sWall[4 * s + f] < wallMax(w.map, s, f)) return true;
  }
  return isEngineer(kind) && w.sFort[s] < FORT_TICKS;
}

function goTo(w: World, i: number, s: number): void {
  const map = w.map;
  // The middle of the nearest side, a cell out from the wall.
  const cx = ((2 * map.sX[s] + map.sW[s]) * CELL_FX) >> 1;
  const cy = ((2 * map.sY[s] + map.sH[s]) * CELL_FX) >> 1;
  const dx = w.posX[i] - cx;
  const dy = w.posY[i] - cy;
  const hw = ((map.sW[s] * CELL_FX) >> 1) + CELL_FX;
  const hh = ((map.sH[s] * CELL_FX) >> 1) + CELL_FX;
  let tx = cx;
  let ty = cy;
  if (Math.abs(dx) * hh >= Math.abs(dy) * hw) tx += dx > 0 ? hw : -hw;
  else ty += dy > 0 ? hh : -hh;
  sendTo(w, i, tx, ty);
}

/** The command that sends builders to mend and fortify a building. */
export function applyUrbanCommand(w: World, cmd: Command): boolean {
  if (cmd.type !== CMD_ENTRENCH) return false;
  const s = cmd.structure;
  const units = validUnits(w, cmd.units).filter((id) => isBuilder(w.kind[id]));
  if (units.length === 0 || !mayWork(w, s, w.team[units[0]])) return true;
  for (const id of units) {
    if (w.team[id] !== w.team[units[0]] || !workLeft(w, s, w.kind[id])) continue;
    leaveHouse(w, id);
    w.job[id] = JOB_ENTRENCH;
    w.jobStruct[id] = s;
    goTo(w, id, s);
  }
  return true;
}

/** One tick of work on buildings: mend first, then fortify. */
export function updateEntrench(w: World): void {
  const map = w.map;
  let any = false;
  for (let i = 0; i < w.count; i++) {
    if (w.job[i] !== JOB_ENTRENCH) continue;
    if (w.state[i] !== STATE_ALIVE) {
      w.job[i] = JOB_NONE;
      continue;
    }
    const s = w.jobStruct[i];
    const team = w.team[i];
    if (!mayWork(w, s, team) || !workLeft(w, s, w.kind[i])) {
      w.job[i] = JOB_NONE;
      continue;
    }
    if (structDist2(w, s, w.posX[i], w.posY[i]) > REACH * REACH) {
      if ((w.tick + i) % TICK_RATE === 0 && (w.flags[i] & FLAG_MOVING) === 0) goTo(w, i, s);
      continue;
    }
    w.flags[i] &= ~(FLAG_MOVING | FLAG_AMOVE);
    if (crew[s] >= MAX_CREW) continue;
    crew[s]++;
    any = true;
    const max = map.sMaxHp[s];
    let walls = false;
    if (w.sHp[s] > 0) {
      for (let f = 0; f < 4; f++) if (w.sWall[4 * s + f] < wallMax(map, s, f)) walls = true;
    }
    if (w.sHp[s] > 0 && (w.sHp[s] < max || walls)) {
      // Mending is paid for as it goes; with nothing in the stores the crew waits.
      if ((w.tick + i) % MEND_COST_EVERY === 0) {
        if (w.supplies[team] < 1) continue;
        w.supplies[team]--;
      } else if (w.supplies[team] < 1) continue;
      const before = stageOf(w, s);
      w.sHp[s] = Math.min(max, w.sHp[s] + Math.ceil(max / MEND_DIV));
      for (let f = 0; f < 4; f++) {
        const full = wallMax(map, s, f);
        if (w.sWall[4 * s + f] < full) {
          w.sWall[4 * s + f] = Math.min(
            full,
            w.sWall[4 * s + f] + Math.ceil(full / (MEND_DIV >> 1)),
          );
        }
      }
      if (stageOf(w, s) !== before && stageOf(w, s) === STAGE_INTACT) {
        w.events.push(EV_FORTIFIED, s, 0);
      }
    } else if (isEngineer(w.kind[i]) && w.sFort[s] < FORT_TICKS) {
      if (++w.sFort[s] >= FORT_TICKS) w.events.push(EV_FORTIFIED, s, 1);
    }
  }
  if (any) crew.fill(0, 0, map.structCount);
}
