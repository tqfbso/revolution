// Field works: what an army builds on the ground to hold it. One cell each. Walls and gates
// stop everyone (a gate lets its owner through), wire stops men, obstacles stop vehicles,
// trenches and sandbags are cover for infantry. See decisions 052 to 056.
import {
  CMD_BREACH,
  CMD_DEMOLISH,
  CMD_FIELDWORK,
  CMD_FORTIFY,
  CMD_OCCUPY,
  type Command,
} from './commands';
import { clampInt, fx } from './fixed';
import {
  CELL_COUNT,
  CELL_FX,
  CELL_SHIFT,
  CLASS_FOOT,
  MAP_CELLS,
  MAX_TEAMS,
  NO_OWNER,
  T_FORD,
  T_GATE,
  T_OPEN,
  T_SANDBAG,
  T_TRAP,
  T_TRENCH,
  T_WALL,
  T_WIRE,
  cellOfPos,
  type GameMap,
} from './map';
import { leaveHouse, markWorks, orderTo, sendTo, validUnits } from './sim';
import { KINDS, KIND_TRUCK, type UnitKind } from './units';
import {
  EV_WORK,
  EV_WORK_LOST,
  FLAG_AMOVE,
  FLAG_BOMBARD,
  FLAG_BREACH,
  FLAG_HOLD,
  FLAG_MOVING,
  JOB_NONE,
  JOB_WORK,
  MAP_SIZE_FX,
  MAX_WORKS,
  STATE_ALIVE,
  TICK_RATE,
  type World,
} from './world';

export const WORK_WALL = 1;
export const WORK_GATE = 2;
export const WORK_WIRE = 3;
export const WORK_TRAP = 4;
export const WORK_TRENCH = 5;
export const WORK_SANDBAG = 6;
export const WORK_COUNT = 7;

export interface Work {
  name: string;
  /** Terrain type of a finished one (see the map). */
  terrain: number;
  supplies: number;
  /** Ticks of work by one builder. */
  ticks: number;
  /** Health; 0 = cannot be destroyed, only taken (a hole in the ground). */
  hp: number;
  /** May stand in a ford as well as on open ground. */
  ford: boolean;
  /**
   * Percent of a weapon's siege damage that it takes: from direct fire, from a shell
   * bursting on it, from an engineer's charge.
   */
  direct: number;
  blast: number;
  charge: number;
}

/** Index: WORK_*. Entry 0 is "nothing". */
export const WORKS: readonly Work[] = [
  {
    name: '',
    terrain: T_OPEN,
    supplies: 0,
    ticks: 1,
    hp: 0,
    ford: false,
    direct: 0,
    blast: 0,
    charge: 0,
  },
  {
    name: 'Wall',
    terrain: T_WALL,
    supplies: 30,
    ticks: 160,
    hp: 480,
    ford: false,
    direct: 100,
    blast: 100,
    charge: 130,
  },
  {
    name: 'Gate',
    terrain: T_GATE,
    supplies: 60,
    ticks: 240,
    hp: 480,
    ford: false,
    direct: 100,
    blast: 100,
    charge: 130,
  },
  {
    // Concertina wire. A tank gun is the wrong tool; tracks, shells and cutters are the right ones.
    name: 'Barbed wire',
    terrain: T_WIRE,
    supplies: 8,
    ticks: 50,
    hp: 60,
    ford: true,
    direct: 25,
    blast: 100,
    charge: 100,
  },
  {
    // Steel hedgehogs and concrete teeth: shrug off shellfire, come apart with a charge.
    name: 'Tank obstacle',
    terrain: T_TRAP,
    supplies: 20,
    ticks: 120,
    hp: 240,
    ford: true,
    direct: 40,
    blast: 30,
    charge: 150,
  },
  {
    name: 'Trench',
    terrain: T_TRENCH,
    supplies: 10,
    ticks: 140,
    hp: 0,
    ford: false,
    direct: 0,
    blast: 0,
    charge: 0,
  },
  {
    name: 'Sandbags',
    terrain: T_SANDBAG,
    supplies: 12,
    ticks: 70,
    hp: 160,
    ford: false,
    direct: 100,
    blast: 100,
    charge: 100,
  },
];

/** Where a hit on a field work comes from (see Work.direct, .blast, .charge). */
export const HIT_DIRECT = 0;
export const HIT_BLAST = 1;
export const HIT_CHARGE = 2;

/** Builders that can work on one cell at once. */
const MAX_CREW = 2;
const WORK_REACH = fx(6.5);
/** A builder whose work is done looks this far for the next unfinished one. */
const NEXT_REACH = fx(60);
/** Works one fortify command can plan. */
export const MAX_ORDER = 256;

const crew = new Uint8Array(CELL_COUNT);
const crewCells: number[] = [];

const isBuilder = (kind: number): boolean => kind === KIND_TRUCK || KINDS[kind].engineer;

/** The centre of a cell, fixed-point. */
const centre = (c: number): number => (c << CELL_SHIFT) + (CELL_FX >> 1);

/** Is the work on `cell` finished (standing, or dug)? */
export function workStands(w: World, cell: number): boolean {
  const kind = w.wKind[cell];
  return kind !== 0 && w.wBuild[cell] >= WORKS[kind].ticks;
}

/**
 * True if the ground of `cell` takes a field work of this kind: open ground (or a ford,
 * for wire and obstacles) that someone can stand on, away from the edge of the map and
 * not on top of a resource site. Shared with the client's placement preview.
 */
export function canFortify(map: GameMap, kind: number, cell: number): boolean {
  if (!Number.isInteger(cell) || cell < 0 || cell >= CELL_COUNT) return false;
  if (!Number.isInteger(kind) || kind <= 0 || kind >= WORK_COUNT) return false;
  const x = cell & (MAP_CELLS - 1);
  const y = cell >> 8;
  if (x < 2 || y < 2 || x >= MAP_CELLS - 2 || y >= MAP_CELLS - 2) return false;
  const t = map.type[cell];
  if (t !== T_OPEN && !(t === T_FORD && WORKS[kind].ford)) return false;
  if (map.natural[CLASS_FOOT][cell] === 0) return false;
  for (let k = 0; k < map.siteCount; k++) {
    const dx = (map.siteX[k] >> CELL_SHIFT) - x;
    const dy = (map.siteY[k] >> CELL_SHIFT) - y;
    if (dx >= -1 && dx <= 1 && dy >= -1 && dy <= 1) return false;
  }
  return true;
}

/** Does this kind of work change who can walk where? */
const blocks = (kind: number): boolean => kind >= WORK_WALL && kind <= WORK_TRAP;

/** Plan a work on a free cell. Returns false if there is no room in the table. */
function plan(w: World, team: number, kind: number, cell: number): boolean {
  if (w.workCount >= MAX_WORKS || w.wKind[cell] !== 0) return false;
  w.wIndex[cell] = w.workCount;
  w.workCells[w.workCount++] = cell;
  w.wKind[cell] = kind;
  w.wTeam[cell] = team;
  w.wHp[cell] = 0;
  w.wBuild[cell] = 0;
  w.worksRev++;
  return true;
}

/** The work on `cell` is done: it becomes part of the terrain. */
function finish(w: World, cell: number): void {
  const map = w.map;
  const kind = w.wKind[cell];
  const work = WORKS[kind];
  w.wBuild[cell] = work.ticks;
  w.wHp[cell] = work.hp;
  // Something may have been built here while it was only a plan.
  const t = map.type[cell];
  if (t !== T_OPEN && t !== T_FORD) {
    remove(w, cell, false);
    return;
  }
  map.baseType[cell] = t;
  map.type[cell] = work.terrain;
  map.workTeam[cell] = w.wTeam[cell];
  if (kind === WORK_GATE) map.gates[w.wTeam[cell]]++;
  if (blocks(kind)) markWorks(true);
  w.worksRev++;
  w.events.push(EV_WORK, cell, kind | (w.wTeam[cell] << 8));
}

/** Take the work on `cell` off the map and out of the table, planned or standing. */
export function remove(w: World, cell: number, lost: boolean): void {
  const map = w.map;
  const kind = w.wKind[cell];
  if (kind === 0) return;
  if (workStands(w, cell) && map.type[cell] === WORKS[kind].terrain) {
    map.type[cell] = map.baseType[cell];
    map.workTeam[cell] = NO_OWNER;
    if (kind === WORK_GATE) map.gates[w.wTeam[cell]]--;
    if (blocks(kind)) markWorks(false);
  }
  if (lost) w.events.push(EV_WORK_LOST, cell, kind);
  const k = w.wIndex[cell];
  const last = w.workCells[--w.workCount];
  w.workCells[k] = last;
  w.wIndex[last] = k;
  w.wKind[cell] = 0;
  w.wTeam[cell] = 0;
  w.wHp[cell] = 0;
  w.wBuild[cell] = 0;
  w.wIndex[cell] = 0;
  w.worksRev++;
}

/** Can a unit of this type do anything to a work of this kind? */
export function canBreach(unit: UnitKind, kind: number): boolean {
  if (unit.siege === 0 || kind === 0) return false;
  const work = WORKS[kind];
  return work.hp > 0 && (unit.engineer ? work.charge : work.direct) > 0;
}

/** A hit on the standing work on `cell`. Returns true if there was one to hit. */
export function hitWork(w: World, cell: number, siege: number, how: number): boolean {
  if (!workStands(w, cell)) return false;
  const work = WORKS[w.wKind[cell]];
  if (work.hp === 0) return false;
  const pct = how === HIT_DIRECT ? work.direct : how === HIT_BLAST ? work.blast : work.charge;
  const dmg = Math.trunc((siege * pct) / 100);
  if (dmg <= 0) return true;
  if (w.wHp[cell] > dmg) {
    w.wHp[cell] -= dmg;
    w.worksRev++;
  } else remove(w, cell, true);
  return true;
}

/** A shell bursts at (x, y): works under it and around it are damaged, less toward the rim. */
export function blastWorks(w: World, x: number, y: number, siege: number, radius: number): void {
  if (w.workCount === 0 || siege === 0) return;
  const r = (radius >> CELL_SHIFT) + 1;
  const cx = x >> CELL_SHIFT;
  const cy = y >> CELL_SHIFT;
  // The burst reaches a work if it reaches into its cell.
  const reach = radius + (CELL_FX >> 1);
  for (let gy = cy - r; gy <= cy + r; gy++) {
    for (let gx = cx - r; gx <= cx + r; gx++) {
      if (gx < 0 || gy < 0 || gx >= MAP_CELLS || gy >= MAP_CELLS) continue;
      const c = gy * MAP_CELLS + gx;
      if (w.wKind[c] === 0) continue;
      const dx = centre(gx) - x;
      const dy = centre(gy) - y;
      const far = dx < 0 ? -dx : dx;
      const d = far > (dy < 0 ? -dy : dy) ? far : dy < 0 ? -dy : dy;
      if (d >= reach) continue;
      hitWork(w, c, Math.trunc((siege * (2 * reach - d)) / (2 * reach)), HIT_BLAST);
    }
  }
}

function startWork(w: World, i: number, cell: number): void {
  w.job[i] = JOB_WORK;
  w.jobCell[i] = cell;
  sendTo(w, i, centre(cell & (MAP_CELLS - 1)), centre(cell >> 8));
}

/** The nearest unfinished work of `team` within NEXT_REACH of (x, y), or -1. */
function nextSite(w: World, team: number, x: number, y: number): number {
  let best = -1;
  let bestD = NEXT_REACH * NEXT_REACH;
  for (let k = 0; k < w.workCount; k++) {
    const c = w.workCells[k];
    if (w.wTeam[c] !== team || workStands(w, c)) continue;
    const dx = centre(c & (MAP_CELLS - 1)) - x;
    const dy = centre(c >> 8) - y;
    // Prefer a work nobody is on yet: a crew spreads out along a line.
    const d = dx * dx + dy * dy + (crew[c] > 0 ? fx(12) * fx(12) : 0);
    if (d < bestD || (d === bestD && c < best)) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

/** The commands about field works. Returns false for a command that is not one of them. */
export function applyWorkCommand(w: World, cmd: Command): boolean {
  const map = w.map;
  switch (cmd.type) {
    case CMD_FORTIFY: {
      const builders = validUnits(w, cmd.units).filter((id) => isBuilder(w.kind[id]));
      const kind = cmd.work;
      if (builders.length === 0 || !Array.isArray(cmd.cells)) return true;
      const team = w.team[builders[0]];
      const sites: number[] = [];
      for (let k = 0; k < cmd.cells.length && k < MAX_ORDER; k++) {
        const c = cmd.cells[k];
        if (!Number.isInteger(c) || c < 0 || c >= CELL_COUNT) continue;
        if (w.wKind[c] !== 0) {
          if (w.wTeam[c] === team && !workStands(w, c)) sites.push(c);
          continue;
        }
        if (!canFortify(map, kind, c)) continue;
        const price = WORKS[kind].supplies;
        if (w.supplies[team] < price || !plan(w, team, kind, c)) break;
        w.supplies[team] -= price;
        sites.push(c);
      }
      if (sites.length === 0) return true;
      for (let k = 0; k < builders.length; k++) {
        const id = builders[k];
        if (w.team[id] !== team) continue;
        leaveHouse(w, id);
        startWork(w, id, sites[k % sites.length]);
      }
      return true;
    }
    case CMD_FIELDWORK: {
      const team = clampInt(cmd.team | 0, 0, MAX_TEAMS - 1);
      if (!Array.isArray(cmd.cells)) return true;
      for (const c of cmd.cells) {
        if (canFortify(map, cmd.work, c) && w.wKind[c] === 0 && plan(w, team, cmd.work, c)) {
          finish(w, c);
        }
      }
      return true;
    }
    case CMD_DEMOLISH: {
      if (!Array.isArray(cmd.cells) || !(cmd.team >= 0 && cmd.team < MAX_TEAMS)) return true;
      for (let k = 0; k < cmd.cells.length && k < MAX_ORDER; k++) {
        const c = cmd.cells[k];
        if (!Number.isInteger(c) || c < 0 || c >= CELL_COUNT) continue;
        if (w.wKind[c] === 0 || w.wTeam[c] !== cmd.team) continue;
        if (!workStands(w, c)) w.supplies[cmd.team] += WORKS[w.wKind[c]].supplies;
        remove(w, c, false);
      }
      return true;
    }
    case CMD_BREACH: {
      const x = clampInt(cmd.x | 0, 0, MAP_SIZE_FX - 1);
      const y = clampInt(cmd.y | 0, 0, MAP_SIZE_FX - 1);
      const cell = cellOfPos(x, y);
      if (!workStands(w, cell)) return true;
      const gx = centre(cell & (MAP_CELLS - 1));
      const gy = centre(cell >> 8);
      const units = validUnits(w, cmd.units).filter(
        (id) => w.team[id] !== w.wTeam[cell] && canBreach(KINDS[w.kind[id]], w.wKind[cell]),
      );
      for (const id of units) {
        w.job[id] = JOB_NONE;
        leaveHouse(w, id);
      }
      orderTo(w, units, gx, gy);
      for (const id of units) {
        w.aimX[id] = gx;
        w.aimY[id] = gy;
        // Guns shell the spot from where they can reach it; the others go for the work itself.
        w.flags[id] |= KINDS[w.kind[id]].indirect ? FLAG_BOMBARD : FLAG_BREACH;
      }
      return true;
    }
    case CMD_OCCUPY: {
      const x = clampInt(cmd.x | 0, 0, MAP_SIZE_FX - 1);
      const y = clampInt(cmd.y | 0, 0, MAP_SIZE_FX - 1);
      const start = cellOfPos(x, y);
      if (!isCover(map.type[start])) return true;
      const units = validUnits(w, cmd.units).filter((id) => KINDS[w.kind[id]].garrison);
      if (units.length === 0) return true;
      // The line outward from the point clicked, breadth first, two squads to a cell.
      const cells = [start];
      const seen = new Set<number>(cells);
      const want = (units.length + 1) >> 1;
      for (let head = 0; head < cells.length && cells.length < want; head++) {
        const c = cells[head];
        const cx = c & (MAP_CELLS - 1);
        const cy = c >> 8;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= MAP_CELLS || ny >= MAP_CELLS) continue;
            const n = ny * MAP_CELLS + nx;
            if (seen.has(n) || !isCover(map.type[n]) || cells.length >= want) continue;
            seen.add(n);
            cells.push(n);
          }
        }
      }
      for (const id of units) {
        w.job[id] = JOB_NONE;
        leaveHouse(w, id);
      }
      orderTo(w, units, x, y);
      for (let k = 0; k < units.length; k++) {
        const id = units[k];
        const c = cells[(k >> 1) % cells.length];
        w.targetX[id] = centre(c & (MAP_CELLS - 1)) + ((k & 1) === 0 ? -fx(0.95) : fx(0.95));
        w.targetY[id] = centre(c >> 8);
        w.flags[id] |= FLAG_HOLD;
      }
      return true;
    }
  }
  return false;
}

/** Trenches and sandbags: infantry standing on such a cell is in cover. */
export function isCover(t: number): boolean {
  return t === T_TRENCH || t === T_SANDBAG;
}

/** One tick of building: every builder with a field work to put up. */
export function updateWorks(w: World): void {
  for (let k = 0; k < crewCells.length; k++) crew[crewCells[k]] = 0;
  crewCells.length = 0;
  const n = w.count;
  for (let i = 0; i < n; i++) {
    if (w.job[i] !== JOB_WORK) continue;
    if (w.state[i] !== STATE_ALIVE) {
      w.job[i] = JOB_NONE;
      continue;
    }
    const team = w.team[i];
    const x = w.posX[i];
    const y = w.posY[i];
    let c = w.jobCell[i];
    if (w.wKind[c] === 0 || w.wTeam[c] !== team || workStands(w, c)) {
      // Done, or gone. On to the next one near here, if there is one.
      c = nextSite(w, team, x, y);
      if (c < 0) {
        w.job[i] = JOB_NONE;
        w.flags[i] &= ~(FLAG_MOVING | FLAG_AMOVE);
        continue;
      }
      startWork(w, i, c);
    }
    const dx = centre(c & (MAP_CELLS - 1)) - x;
    const dy = centre(c >> 8) - y;
    if (dx * dx + dy * dy > WORK_REACH * WORK_REACH) {
      if ((w.tick + i) % TICK_RATE === 0 && (w.flags[i] & FLAG_MOVING) === 0) startWork(w, i, c);
      continue;
    }
    w.flags[i] &= ~(FLAG_MOVING | FLAG_AMOVE);
    if (crew[c] >= MAX_CREW) continue;
    if (crew[c]++ === 0) crewCells.push(c);
    if (++w.wBuild[c] >= WORKS[w.wKind[c]].ticks) finish(w, c);
    else if ((w.wBuild[c] & 15) === 0) w.worksRev++;
  }
}
