import {
  CMD_ATTACK_MOVE,
  CMD_BOMBARD,
  CMD_ATTACK_STRUCTURE,
  CMD_GARRISON,
  CMD_LOAD,
  CMD_MOVE,
  CMD_SPAWN,
  CMD_STOP,
  CMD_UNLOAD,
  type Command,
  type SpawnCommand,
} from './commands';
import { FP_SHIFT, clampInt, fx, isqrt } from './fixed';
import {
  CELL_FX,
  CELL_SHIFT,
  CLASS_AIR,
  CLASS_COUNT,
  CLASS_FOOT,
  FLOOR_HEIGHT,
  MAP_CELLS,
  MAX_STRUCTS,
  MAX_TOWNS,
  S_BRIDGE,
  S_BUILDING,
  T_BRIDGE,
  T_BUILDING,
  T_FOREST,
  T_RUBBLE,
  cellOfPos,
  deckHeight,
  heightAt,
  lineOfSight,
  razeStructure,
  refreshPassability,
  stampStructure,
} from './map';
import { DIR_X, DIR_Y, UNREACHABLE, buildField, clearLine, flowDirection, newField } from './path';
import { nextInt } from './rng';
import {
  ACQUIRE_RANGE,
  AIR_HEIGHT,
  BOARD_DIST,
  CAPTURE_POINTS,
  CONCEAL_RANGE,
  COUNTER_BATTERY_TICKS,
  DANGER_CLOSE,
  DETECT_RANGE,
  EYE_HEIGHT,
  FACING_COS,
  GARRISON_MAX,
  GARRISON_RANGE_BONUS,
  HEIGHT_RANGE_MAX,
  HEIGHT_RANGE_MIN,
  HEIGHT_RANGE_SHIFT,
  JAM_DRAIN_TICKS,
  JAM_REVEAL_TICKS,
  KINDS,
  KIND_COUNT,
  KIND_TANK,
  REVEAL_TICKS,
  SCATTER_MIN,
  SCATTER_SHIFT,
  SHELL_BASE_TICKS,
  SHELL_TICKS_SHIFT,
  SPOT_TICKS,
  TOWN_INCOME,
} from './units';
import {
  CHASE_FIELDS,
  EV_CAPTURE,
  EV_COLLAPSE,
  EV_DEATH,
  EV_IMPACT,
  EV_LAUNCH,
  EV_REPAIR,
  EV_SHOT,
  EV_SIEGE,
  EV_UNLOAD,
  FLAG_AMOVE,
  FLAG_BOARD,
  FLAG_BOMBARD,
  FLAG_DIRECT,
  FLAG_GARRISON,
  FLAG_MOVING,
  FLAG_SIEGE,
  FLAG_WANDER,
  MAP_SIZE,
  MAP_SIZE_FX,
  MAX_FIELDS,
  MAX_SHELLS,
  MAX_TEAMS,
  MAX_UNITS,
  NO_TARGET,
  NO_TEAM,
  STATE_ALIVE,
  STATE_FREE,
  STATE_WRECK,
  packPoint,
  type World,
} from './world';

const SEP_RADIUS = fx(1.8);
const SEP_RADIUS_SQ = SEP_RADIUS * SEP_RADIUS;
// Cap on neighbour tests per unit per tick. Bounds the cost of pathological pile-ups
// (thousands of units on one spot) so a tick can never go quadratic.
const MAX_NEIGHBOUR_TESTS = 64;
const MAX_PUSH = fx(0.2);
// Below this speed a hull does not swing to follow its own drift.
const FACE_MIN_SPEED_SQ = fx(0.05) * fx(0.05);
const FORMATION_SPACING = fx(2.6);
const SQUAD_SIZE = 48;
const SQUAD_SPREAD = fx(10);
const WANDER_PERIOD = 600; // ticks between new roaming orders for a squad
const WANDER_MARGIN = fx(48);
const POS_MAX = MAP_SIZE_FX - 1;

// Fine grid for collisions: the terrain grid. Cells are 4 world units, larger than
// SEP_RADIUS, so all neighbours of a unit are in the 3x3 block around its cell.
const GRID_DIM = MAP_CELLS;
const GRID_CELLS = GRID_DIM * GRID_DIM;

// Coarse grid for target acquisition. Cells are 16 world units; ACQUIRE_CELLS cells in
// every direction cover ACQUIRE_RANGE.
const COARSE_SHIFT = FP_SHIFT + 4;
const COARSE_DIM = MAP_SIZE >> 4;
const COARSE_CELLS = COARSE_DIM * COARSE_DIM;
const ACQUIRE_CELLS = 3;
const ACQUIRE_RANGE_SQ = ACQUIRE_RANGE * ACQUIRE_RANGE;
const CONCEAL_RANGE_SQ = CONCEAL_RANGE * CONCEAL_RANGE;
// Units without a target look for one every 4 ticks; everyone re-evaluates every 16 so a
// closer threat replaces a distant one. Staggered by id so the work is spread evenly.
const SEARCH_IDLE_MASK = 3;
const SEARCH_ALL_MASK = 15;
const MAX_TARGET_TESTS = 2048;

// Scratch buffers, rebuilt from world state every tick. Not part of the state.
const cellStart = new Int32Array(GRID_CELLS + 1);
const cellFill = new Int32Array(GRID_CELLS);
const sorted = new Int32Array(MAX_UNITS);
const coarseStart = new Int32Array(COARSE_CELLS + 1);
const coarseSorted = new Int32Array(MAX_UNITS);
const cellOf = new Int32Array(MAX_UNITS);
const pushX = new Int32Array(MAX_UNITS);
const pushY = new Int32Array(MAX_UNITS);
const damage = new Int32Array(MAX_UNITS);
const killer = new Int32Array(MAX_UNITS);
const squadScratch: number[] = [];
const spawned: number[] = [];
const projForward = new Int32Array(MAX_UNITS);
const projSide = new Int32Array(MAX_UNITS);
const fieldRefs = new Int32Array(MAX_FIELDS);
const goalScratch = new Int32Array(MAX_UNITS);
const KIND_CLASS = KINDS.map((k) => k.cls);
const IS_AIR = KINDS.map((k) => k.cls === CLASS_AIR);
const ARMED = KINDS.map((k) => k.damage.some((d) => d > 0));
const SIGHT_SQ = KINDS.map((k) => k.sight * k.sight);
/**
 * Target priority, added to the squared distance of a candidate: a unit shoots at drones
 * only when it has nothing on the ground to shoot at (unless drones are all it can hit),
 * and a strike drone picks vehicles and guns before men.
 */
const LOW_PRIORITY = ACQUIRE_RANGE * ACQUIRE_RANGE;
const PRIORITY = KINDS.flatMap((a) =>
  KINDS.map((b) => {
    const air = b.cls === CLASS_AIR && a.damage.some((d, k) => d > 0 && KINDS[k].cls !== CLASS_AIR);
    const soft = a.kamikaze && b.cls === CLASS_FOOT;
    return air || soft ? LOW_PRIORITY : 0;
  }),
);
const DETECT_RANGE_SQ = DETECT_RANGE * DETECT_RANGE;
/** Jammers alive this tick. */
const jammers = new Int32Array(MAX_UNITS);
const structDamage = new Int32Array(MAX_STRUCTS);
const townCount = new Int32Array(MAX_TOWNS * MAX_TEAMS);
const repairCrew = new Int32Array(MAX_STRUCTS * MAX_TEAMS);
/** Set when a structure fell or was rebuilt this tick: routes must be recomputed. */
let topologyChanged = false;

// Line-of-sight checks per target search. Candidates beyond the budget count as unseen.
const MAX_SIGHT_TESTS = 8;
/** Value of `los` for a unit with no target because nothing near it is in sight. */
const SIGHT_NONE = 2;
// A unit with a target re-checks its line of sight this often, staggered by id.
const SIGHT_RECHECK_MASK = 3;
// How close infantry must get to a building to slip inside.
const ENTER_DIST = fx(3.5);
// Idle infantry this close to a cut bridge works on rebuilding it.
const REPAIR_DIST = fx(14);
const REPAIR_PER_SQUAD = 40;
const TOWN_PERIOD = 20;

// Direct-line checks for units on a move order are repeated every 16 ticks, staggered by id.
const DIRECT_RECHECK_MASK = 15;
// A "way to the nearest enemy" field is rebuilt at most this often, and only while some
// unit of that team and class has a target it cannot walk straight at.
const CHASE_REFRESH = 40;
// How far (in path cost, 10 per cell) a unit will route around an obstacle to reach an enemy.
const CHASE_LIMIT = 300;

/** Advance the world by exactly one tick, applying `commands` first, in order. */
export function step(w: World, commands: readonly Command[]): void {
  for (let c = 0; c < commands.length; c++) applyCommand(w, commands[c]);
  updateWander(w);
  bucket(w, CELL_SHIFT, GRID_DIM, cellStart, sorted);
  bucket(w, COARSE_SHIFT, COARSE_DIM, coarseStart, coarseSorted);
  updateChaseFields(w);
  updateStructureOrders(w);
  updateTransport(w);
  updateEyes(w);
  updateJamming(w);
  updateSpotters(w);
  acquireTargets(w);
  steer(w);
  separate(w);
  fire(w);
  resolveShells(w);
  integrate(w);
  resolveDamage(w);
  resolveStructures(w);
  if (w.tick % TOWN_PERIOD === 0) updateTowns(w);
  if (topologyChanged) {
    // The ground changed: every route computed so far may run through a wall or off a bridge.
    topologyChanged = false;
    refreshPassability(w.map);
    w.fieldGoal.fill(-1);
    w.path.fill(-1, 0, w.count);
    w.chaseBuilt.fill(-1);
  }
  w.tick++;
}

function applyCommand(w: World, cmd: Command): void {
  switch (cmd.type) {
    case CMD_MOVE:
    case CMD_ATTACK_MOVE: {
      const units = validUnits(w, cmd.units);
      for (let k = 0; k < units.length; k++) leaveBuilding(w, units[k]);
      orderFormationMove(w, units, cmd.x | 0, cmd.y | 0);
      const attack = cmd.type === CMD_ATTACK_MOVE;
      for (let k = 0; k < units.length; k++) {
        const id = units[k];
        w.flags[id] = (w.flags[id] & ~ORDER_FLAGS) | (attack ? FLAG_AMOVE : 0);
      }
      break;
    }
    case CMD_GARRISON:
    case CMD_ATTACK_STRUCTURE: {
      const st = cmd.structure;
      const map = w.map;
      if (!Number.isInteger(st) || st < 0 || st >= map.structCount || w.sHp[st] <= 0) break;
      const garrison = cmd.type === CMD_GARRISON;
      if (garrison && map.sKind[st] !== S_BUILDING) break;
      const units = validUnits(w, cmd.units).filter((id) => {
        const kind = KINDS[w.kind[id]];
        return garrison ? kind.garrison && w.inside[id] !== st : kind.siege > 0;
      });
      // Everyone heads for the middle of the structure; they stop (or go in) on the way.
      const gx = ((2 * map.sX[st] + map.sW[st]) << CELL_SHIFT) >> 1;
      const gy = ((2 * map.sY[st] + map.sH[st]) << CELL_SHIFT) >> 1;
      for (let k = 0; k < units.length; k++) {
        const id = units[k];
        leaveBuilding(w, id);
        w.targetX[id] = gx;
        w.targetY[id] = gy;
        w.orderSpeed[id] = w.speed[id];
        w.orderStruct[id] = st;
      }
      routeUnits(w, units, gx, gy);
      for (let k = 0; k < units.length; k++) {
        const id = units[k];
        // Guns do not drive up to the wall: they shell it from wherever they can reach it.
        const how = garrison
          ? FLAG_GARRISON
          : KINDS[w.kind[id]].indirect
            ? FLAG_BOMBARD
            : FLAG_SIEGE;
        w.aimX[id] = gx;
        w.aimY[id] = gy;
        w.flags[id] = (w.flags[id] & ~ORDER_FLAGS) | how;
      }
      break;
    }
    case CMD_BOMBARD: {
      const units = validUnits(w, cmd.units).filter((id) => KINDS[w.kind[id]].indirect);
      const x = clampInt(cmd.x | 0, 0, POS_MAX);
      const y = clampInt(cmd.y | 0, 0, POS_MAX);
      for (let k = 0; k < units.length; k++) {
        const id = units[k];
        w.targetX[id] = x;
        w.targetY[id] = y;
        w.orderSpeed[id] = w.speed[id];
        w.orderStruct[id] = -1;
        w.aimX[id] = x;
        w.aimY[id] = y;
      }
      routeUnits(w, units, x, y);
      for (let k = 0; k < units.length; k++) {
        const id = units[k];
        w.flags[id] = (w.flags[id] & ~ORDER_FLAGS) | FLAG_BOMBARD;
      }
      break;
    }
    case CMD_STOP: {
      const units = validUnits(w, cmd.units);
      for (let k = 0; k < units.length; k++) w.flags[units[k]] = 0;
      break;
    }
    case CMD_LOAD:
      orderBoarding(w, validUnits(w, cmd.units), validUnits(w, cmd.carriers));
      break;
    case CMD_UNLOAD: {
      const units = validUnits(w, cmd.units);
      for (let k = 0; k < units.length; k++) unload(w, units[k], false);
      break;
    }
    case CMD_SPAWN:
      spawn(w, cmd);
      break;
  }
}

const ORDER_FLAGS =
  FLAG_WANDER | FLAG_AMOVE | FLAG_GARRISON | FLAG_SIEGE | FLAG_BOARD | FLAG_BOMBARD;

/**
 * Send each squad to the nearest carrier of its own army that still has a seat free,
 * counting the seats promised earlier in the same order. The carriers stop and wait.
 */
function orderBoarding(w: World, squads: readonly number[], carriers: readonly number[]): void {
  const taken = new Map<number, number>();
  const one = [0];
  for (let k = 0; k < squads.length; k++) {
    const id = squads[k];
    // Whatever can hold a house can ride: infantry and weapon teams.
    if (!KINDS[w.kind[id]].garrison) continue;
    let best = -1;
    let bestD = 0;
    for (let c = 0; c < carriers.length; c++) {
      const v = carriers[c];
      const seats = KINDS[w.kind[v]].carry - w.load[v] - (taken.get(v) ?? 0);
      if (seats <= 0 || w.team[v] !== w.team[id]) continue;
      const dx = w.posX[v] - w.posX[id];
      const dy = w.posY[v] - w.posY[id];
      const d2 = dx * dx + dy * dy;
      if (best < 0 || d2 < bestD) {
        best = v;
        bestD = d2;
      }
    }
    if (best < 0) continue;
    taken.set(best, (taken.get(best) ?? 0) + 1);
    w.flags[best] = 0;
    leaveBuilding(w, id);
    w.orderUnit[id] = best;
    w.targetX[id] = w.posX[best];
    w.targetY[id] = w.posY[best];
    w.orderSpeed[id] = w.speed[id];
    one[0] = id;
    routeUnits(w, one, w.posX[best], w.posY[best]);
    w.flags[id] = (w.flags[id] & ~ORDER_FLAGS) | FLAG_BOARD;
  }
}

/**
 * Put down everyone aboard carrier `c`, in a line behind it. With `follow` the squads take
 * over the carrier's attack-move, so a column that meets the enemy goes on as infantry.
 */
function unload(w: World, c: number, follow: boolean): void {
  if (w.load[c] === 0) return;
  const map = w.map;
  const cost = map.cost[CLASS_FOOT];
  const one = [0];
  const fxc = w.faceX[c];
  const fyc = w.faceY[c];
  let k = 0;
  for (let j = 0; j < w.count; j++) {
    if (w.carrier[j] !== c) continue;
    w.carrier[j] = -1;
    // Two units behind the hull, squads side by side.
    const side = (2 * k - (w.load[c] - 1)) * fx(1.2);
    let x = clampInt(w.posX[c] - 2 * fxc + Math.trunc((-fyc * side) / 1024), 0, POS_MAX);
    let y = clampInt(w.posY[c] - 2 * fyc + Math.trunc((fxc * side) / 1024), 0, POS_MAX);
    const cell = cellOfPos(x, y);
    if (cost[cell] === 0) {
      const to = map.snap[CLASS_FOOT][cell];
      x = ((to & (MAP_CELLS - 1)) << CELL_SHIFT) + (CELL_FX >> 1);
      y = ((to >> 8) << CELL_SHIFT) + (CELL_FX >> 1);
    }
    w.posX[j] = x;
    w.posY[j] = y;
    w.velX[j] = 0;
    w.velY[j] = 0;
    w.flags[j] = 0;
    w.attack[j] = NO_TARGET;
    if (follow && (w.flags[c] & FLAG_MOVING) !== 0) {
      w.targetX[j] = w.targetX[c];
      w.targetY[j] = w.targetY[c];
      w.orderSpeed[j] = w.speed[j];
      one[0] = j;
      routeUnits(w, one, w.targetX[c], w.targetY[c]);
      w.flags[j] |= FLAG_AMOVE;
    }
    k++;
  }
  w.load[c] = 0;
  w.events.push(EV_UNLOAD, c, k);
}

/**
 * Boarding orders that have arrived, and carriers that have met the enemy: a carrier that
 * is free to fight (not under a plain move order) dismounts its squads once it has a target
 * in range.
 */
function updateTransport(w: World): void {
  const n = w.count;
  const one = [0];
  for (let i = 0; i < n; i++) {
    if (w.state[i] !== STATE_ALIVE) continue;
    const flags = w.flags[i];
    if (w.load[i] > 0) {
      const t = w.attack[i];
      if (
        t !== NO_TARGET &&
        w.los[i] === 1 &&
        ((flags & FLAG_MOVING) === 0 || (flags & (FLAG_AMOVE | FLAG_WANDER)) !== 0)
      ) {
        const dx = w.posX[t] - w.posX[i];
        const dy = w.posY[t] - w.posY[i];
        const range = KINDS[w.kind[i]].range;
        if (dx * dx + dy * dy <= range * range) unload(w, i, true);
      }
    }
    if ((flags & FLAG_BOARD) === 0) continue;
    const c = w.orderUnit[i];
    if (
      c < 0 ||
      w.state[c] !== STATE_ALIVE ||
      w.team[c] !== w.team[i] ||
      w.load[c] >= KINDS[w.kind[c]].carry
    ) {
      w.flags[i] = 0;
      continue;
    }
    const dx = w.posX[c] - w.posX[i];
    const dy = w.posY[c] - w.posY[i];
    if (dx * dx + dy * dy <= BOARD_DIST * BOARD_DIST) {
      w.carrier[i] = c;
      w.load[c]++;
      w.flags[i] = 0;
      w.path[i] = -1;
      w.velX[i] = 0;
      w.velY[i] = 0;
      w.attack[i] = NO_TARGET;
      w.posX[i] = w.posX[c];
      w.posY[i] = w.posY[c];
    } else if ((flags & FLAG_MOVING) === 0 || ((w.tick + i) & 31) === 0) {
      // The carrier is not where it was when the order came: walk to where it is now.
      w.targetX[i] = w.posX[c];
      w.targetY[i] = w.posY[c];
      one[0] = i;
      routeUnits(w, one, w.posX[c], w.posY[c]);
    }
  }
}

/** Squared distance from a point to the footprint of a structure (0 inside it). */
function structDist2(w: World, s: number, x: number, y: number): number {
  const map = w.map;
  const x0 = map.sX[s] << CELL_SHIFT;
  const y0 = map.sY[s] << CELL_SHIFT;
  const x1 = (map.sX[s] + map.sW[s]) << CELL_SHIFT;
  const y1 = (map.sY[s] + map.sH[s]) << CELL_SHIFT;
  const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
  const dy = y < y0 ? y0 - y : y > y1 ? y - y1 : 0;
  return dx * dx + dy * dy;
}

/** Can unit `i` see (and so shell) structure `s`? Sight to the nearest point of it. */
function seesStructure(w: World, i: number, s: number): boolean {
  const map = w.map;
  const x = w.posX[i];
  const y = w.posY[i];
  const px = clampInt(x, map.sX[s] << CELL_SHIFT, ((map.sX[s] + map.sW[s]) << CELL_SHIFT) - 1);
  const py = clampInt(y, map.sY[s] << CELL_SHIFT, ((map.sY[s] + map.sH[s]) << CELL_SHIFT) - 1);
  return lineOfSight(map, x, y, eyeZ[i], px, py, eyeZ[i], s, w.inside[i]);
}

/** Eye height of every living unit at the start of the tick (see eyeHeight). */
const eyeZ = new Int32Array(MAX_UNITS);

function updateEyes(w: World): void {
  for (let i = 0; i < w.count; i++) if (w.state[i] === STATE_ALIVE) eyeZ[i] = eyeHeight(w, i);
}

/** Height of a unit's eyes: the ground (or deck, or upper floor) it is on plus its own. */
function eyeHeight(w: World, i: number): number {
  const map = w.map;
  const s = w.inside[i];
  if (s >= 0) return map.sBase[s] + map.sFloors[s] * FLOOR_HEIGHT;
  const x = w.posX[i];
  const y = w.posY[i];
  if (IS_AIR[w.kind[i]]) return heightAt(map, x, y) + AIR_HEIGHT;
  const c = cellOfPos(x, y);
  if (map.type[c] === T_BRIDGE) return deckHeight(map, map.structAt[c], x) + EYE_HEIGHT;
  return heightAt(map, x, y) + EYE_HEIGHT;
}

/** Weapon range of `i` against `t`: longer from upper floors and from higher ground. */
function rangeTo(w: World, i: number, t: number): number {
  // Height above the ground is not height of ground: no bonus to or from drones.
  if (IS_AIR[w.kind[i]] || IS_AIR[w.kind[t]]) return KINDS[w.kind[i]].range;
  let bonus = (eyeZ[i] - eyeZ[t]) >> HEIGHT_RANGE_SHIFT;
  bonus = clampInt(bonus, HEIGHT_RANGE_MIN, HEIGHT_RANGE_MAX);
  if (w.inside[i] >= 0 && bonus < GARRISON_RANGE_BONUS) bonus = GARRISON_RANGE_BONUS;
  return KINDS[w.kind[i]].range + bonus;
}

function garrisonCapacity(w: World, s: number): number {
  const cells = w.map.sW[s] * w.map.sH[s];
  return cells < GARRISON_MAX ? cells : GARRISON_MAX;
}

function hasRoom(w: World, s: number, team: number): boolean {
  return (
    w.sHp[s] > 0 &&
    (w.sOcc[s] === 0 || w.sOccTeam[s] === team) &&
    w.sOcc[s] < garrisonCapacity(w, s)
  );
}

function enterBuilding(w: World, i: number, s: number): void {
  const map = w.map;
  // One squad per room, so to speak: occupants sit on the centres of the building's cells.
  const k = w.sOcc[s] % (map.sW[s] * map.sH[s]);
  const cx = map.sX[s] + (k % map.sW[s]);
  const cy = map.sY[s] + Math.trunc(k / map.sW[s]);
  w.posX[i] = (cx << CELL_SHIFT) + (CELL_FX >> 1);
  w.posY[i] = (cy << CELL_SHIFT) + (CELL_FX >> 1);
  w.velX[i] = 0;
  w.velY[i] = 0;
  w.flags[i] = 0;
  w.path[i] = -1;
  w.inside[i] = s;
  w.reveal[i] = 0;
  w.sOcc[s]++;
  w.sOccTeam[s] = w.team[i];
}

/** Step out of a building onto the nearest ground. Does nothing for a unit outside. */
function leaveBuilding(w: World, i: number): void {
  const s = w.inside[i];
  if (s < 0) return;
  w.inside[i] = -1;
  w.sOcc[s]--;
  const to = w.map.snap[KIND_CLASS[w.kind[i]]][cellOfPos(w.posX[i], w.posY[i])];
  w.posX[i] = ((to & (MAP_CELLS - 1)) << CELL_SHIFT) + (CELL_FX >> 1);
  w.posY[i] = ((to >> 8) << CELL_SHIFT) + (CELL_FX >> 1);
}

/** Carry out garrison orders that have arrived and drop orders whose structure is gone. */
function updateStructureOrders(w: World): void {
  const n = w.count;
  for (let i = 0; i < n; i++) {
    const flags = w.flags[i];
    if ((flags & (FLAG_GARRISON | FLAG_SIEGE | FLAG_BOMBARD)) === 0) continue;
    if (w.state[i] !== STATE_ALIVE) continue;
    const s = w.orderStruct[i];
    if (s < 0) continue; // shelling a point on the ground, not a structure
    if (w.sHp[s] <= 0) {
      w.flags[i] = 0;
    } else if ((flags & FLAG_GARRISON) !== 0) {
      if (structDist2(w, s, w.posX[i], w.posY[i]) <= ENTER_DIST * ENTER_DIST) {
        // Full, or the enemy got there first: wait outside.
        if (hasRoom(w, s, w.team[i])) enterBuilding(w, i, s);
        else w.flags[i] = 0;
      } else if ((flags & FLAG_MOVING) === 0) w.flags[i] = 0;
    }
  }
}

/** Commands come from outside the sim, so never trust the ids in them. */
function validUnits(w: World, ids: readonly number[]): number[] {
  const out: number[] = [];
  for (let k = 0; k < ids.length; k++) {
    const id = ids[k];
    if (
      Number.isInteger(id) &&
      id >= 0 &&
      id < w.count &&
      w.state[id] === STATE_ALIVE &&
      w.carrier[id] < 0
    ) {
      out.push(id);
    }
  }
  return out;
}

/**
 * Send units to a formation centred on (cx, cy): a block about twice as wide as deep that
 * faces the direction of travel, vehicles in the front rows. Units take the slot that
 * matches where they already stand relative to the group, so paths do not cross, and all
 * move at the pace of the slowest so the shape holds on the way.
 */
function orderFormationMove(w: World, units: readonly number[], cx: number, cy: number): void {
  const n = units.length;
  if (n === 0) return;
  let sumX = 0;
  let sumY = 0;
  let slowest = w.speed[units[0]];
  for (let k = 0; k < n; k++) {
    const id = units[k];
    sumX += w.posX[id];
    sumY += w.posY[id];
    if (w.speed[id] < slowest) slowest = w.speed[id];
  }
  const mx = Math.trunc(sumX / n);
  const my = Math.trunc(sumY / n);
  // Unit vector of travel (Q10); "side" is it turned a quarter: (-uy, ux).
  let ux = 0;
  let uy = 1024;
  const len = isqrt((cx - mx) * (cx - mx) + (cy - my) * (cy - my));
  if (len > fx(1)) {
    ux = Math.trunc(((cx - mx) * 1024) / len);
    uy = Math.trunc(((cy - my) * 1024) / len);
  }
  const order = units.slice();
  for (let k = 0; k < n; k++) {
    const id = order[k];
    const dx = w.posX[id] - mx;
    const dy = w.posY[id] - my;
    projForward[id] = Math.trunc((dx * ux + dy * uy) / 1024);
    projSide[id] = Math.trunc((dy * ux - dx * uy) / 1024);
  }
  order.sort((a, b) => w.kind[a] - w.kind[b] || projForward[b] - projForward[a] || a - b);
  let cols = isqrt(2 * n);
  if (cols * cols < 2 * n) cols++;
  if (cols > n) cols = n;
  const rows = Math.ceil(n / cols);
  for (let row = 0; row < rows; row++) {
    const line = order.slice(row * cols, (row + 1) * cols);
    line.sort((a, b) => projSide[a] - projSide[b] || a - b);
    // Halves keep the block centred using integers only.
    const ahead = ((rows - 1 - 2 * row) * FORMATION_SPACING) >> 1;
    for (let col = 0; col < line.length; col++) {
      const id = line[col];
      const side = ((2 * col - (line.length - 1)) * FORMATION_SPACING) >> 1;
      w.targetX[id] = cx + Math.trunc((ux * ahead - uy * side) / 1024);
      w.targetY[id] = cy + Math.trunc((uy * ahead + ux * side) / 1024);
      w.orderSpeed[id] = slowest;
    }
  }
  routeUnits(w, units, cx, cy);
}

/**
 * Start `units` toward their (already chosen) targets. A target on ground the unit cannot
 * enter moves to the nearest ground it can. Units with a clear straight line just walk it;
 * the others share one flowfield per movement class to (gx, gy).
 */
function routeUnits(w: World, units: readonly number[], gx: number, gy: number): void {
  const map = w.map;
  const goal = cellOfPos(clampInt(gx, 0, POS_MAX), clampInt(gy, 0, POS_MAX));
  for (let k = 0; k < units.length; k++) {
    const id = units[k];
    const cls = KIND_CLASS[w.kind[id]];
    let tx = clampInt(w.targetX[id], 0, POS_MAX);
    let ty = clampInt(w.targetY[id], 0, POS_MAX);
    const cell = cellOfPos(tx, ty);
    if (map.cost[cls][cell] === 0) {
      const to = map.snap[cls][cell];
      tx = ((to & (MAP_CELLS - 1)) << CELL_SHIFT) + (CELL_FX >> 1);
      ty = ((to >> 8) << CELL_SHIFT) + (CELL_FX >> 1);
    }
    w.targetX[id] = tx;
    w.targetY[id] = ty;
    // The field itself is only built when a unit first needs it (see steer).
    w.goal[id] = map.snap[cls][goal];
    w.path[id] = -1;
    const direct = clearLine(map, cls, w.posX[id], w.posY[id], tx, ty);
    w.flags[id] = (w.flags[id] & ~FLAG_DIRECT) | FLAG_MOVING | (direct ? FLAG_DIRECT : 0);
  }
}

/**
 * A flowfield to `goal` for movement class `cls`: an existing one if there is one, else
 * built in a slot no moving unit still uses. Returns -1 if every slot is in use (the unit
 * then walks straight, as before pathfinding existed).
 */
function acquireField(w: World, goal: number, cls: number): number {
  for (let f = 0; f < MAX_FIELDS; f++) {
    if (w.fieldGoal[f] === goal && w.fieldClass[f] === cls) return f;
  }
  if (w.fieldsFullTick === w.tick) return -1;
  fieldRefs.fill(0);
  for (let i = 0; i < w.count; i++) {
    if (w.state[i] === STATE_ALIVE && (w.flags[i] & FLAG_MOVING) !== 0 && w.path[i] >= 0) {
      fieldRefs[w.path[i]]++;
    }
  }
  let slot = -1;
  for (let f = 0; f < MAX_FIELDS && slot < 0; f++) if (w.fieldGoal[f] < 0) slot = f;
  for (let f = 0; f < MAX_FIELDS && slot < 0; f++) if (fieldRefs[f] === 0) slot = f;
  if (slot < 0) {
    w.fieldsFullTick = w.tick;
    return -1;
  }
  const dist = (w.fieldDist[slot] ??= newField());
  goalScratch[0] = goal;
  buildField(w.map, cls, dist, goalScratch, 1, UNREACHABLE - 1);
  w.fieldGoal[slot] = goal;
  w.fieldClass[slot] = cls;
  return slot;
}

/**
 * Units whose target is behind an obstacle follow a field that leads to the nearest enemy
 * by walkable route. Such a field exists per team and movement class, and is refreshed only
 * while someone needs it (at most one per tick, to spread the cost).
 */
function updateChaseFields(w: World): void {
  for (let f = 0; f < CHASE_FIELDS; f++) {
    if (w.chaseWanted[f] < w.tick - 1) continue;
    if (w.chaseBuilt[f] >= 0 && w.tick - w.chaseBuilt[f] < CHASE_REFRESH) continue;
    const team = Math.trunc(f / CLASS_COUNT);
    let n = 0;
    for (let i = 0; i < w.count; i++) {
      if (w.state[i] === STATE_ALIVE && w.team[i] !== team) {
        goalScratch[n++] = cellOfPos(w.posX[i], w.posY[i]);
      }
    }
    const dist = (w.chaseDist[f] ??= newField());
    buildField(w.map, f % CLASS_COUNT, dist, goalScratch, n, CHASE_LIMIT);
    w.chaseBuilt[f] = w.tick;
    return;
  }
}

function spawn(w: World, cmd: SpawnCommand): void {
  const r = clampInt(cmd.radius | 0, 1, MAP_SIZE_FX);
  const cx = cmd.x | 0;
  const cy = cmd.y | 0;
  const teamId = clampInt(cmd.team | 0, 0, MAX_TEAMS - 1);
  const kindId = clampInt((cmd.kind ?? KIND_TANK) | 0, 0, KIND_COUNT - 1);
  const kind = KINDS[kindId];
  const advance = cmd.advanceX !== undefined && cmd.advanceY !== undefined;
  const ax = (cmd.advanceX ?? 0) | 0;
  const ay = (cmd.advanceY ?? 0) | 0;
  const n = clampInt(cmd.count | 0, 0, MAX_UNITS);
  let squadX = 0;
  let squadY = 0;
  let group = 0;
  let scan = 0;
  const firstGroup = w.groupCount;
  const cls = kind.cls;
  const map = w.map;
  spawned.length = 0;
  for (let k = 0; k < n; k++) {
    // Reuse the lowest free slot, else grow.
    while (scan < w.count && w.state[scan] !== STATE_FREE) scan++;
    if (scan >= MAX_UNITS) break;
    const id = scan;
    if (id === w.count) w.count++;
    if (k % SQUAD_SIZE === 0) {
      group = w.groupCount++;
      squadX = cx - r + nextInt(w.rng, 2 * r);
      squadY = cy - r + nextInt(w.rng, 2 * r);
    }
    const x = squadX - SQUAD_SPREAD + nextInt(w.rng, 2 * SQUAD_SPREAD);
    const y = squadY - SQUAD_SPREAD + nextInt(w.rng, 2 * SQUAD_SPREAD);
    w.posX[id] = clampInt(x, 0, POS_MAX);
    w.posY[id] = clampInt(y, 0, POS_MAX);
    const cell = cellOfPos(w.posX[id], w.posY[id]);
    if (map.cost[cls][cell] === 0) {
      // Not ground this unit can stand on: use the nearest cell that is.
      const to = map.snap[cls][cell];
      w.posX[id] = ((to & (MAP_CELLS - 1)) << CELL_SHIFT) + (w.posX[id] & (CELL_FX - 1));
      w.posY[id] = ((to >> 8) << CELL_SHIFT) + (w.posY[id] & (CELL_FX - 1));
    }
    w.velX[id] = 0;
    w.velY[id] = 0;
    w.targetX[id] = w.posX[id];
    w.targetY[id] = w.posY[id];
    w.speed[id] = kind.speed + nextInt(w.rng, 1 + (kind.speed >> 3));
    w.group[id] = group;
    w.team[id] = teamId;
    w.kind[id] = kindId;
    w.state[id] = STATE_ALIVE;
    w.hp[id] = kind.hp;
    // Random first reload so a fresh army does not fire in one synchronised volley.
    w.cooldown[id] = nextInt(w.rng, kind.reload);
    w.attack[id] = NO_TARGET;
    w.orderSpeed[id] = w.speed[id];
    w.path[id] = -1;
    w.goal[id] = 0;
    w.inside[id] = -1;
    w.orderStruct[id] = -1;
    w.reveal[id] = 0;
    w.los[id] = 0;
    // Hulls start pointing at the other side of the map.
    w.faceX[id] = teamId === 0 ? 1024 : -1024;
    w.faceY[id] = 0;
    w.carrier[id] = -1;
    w.load[id] = 0;
    w.orderUnit[id] = -1;
    w.aimX[id] = 0;
    w.aimY[id] = 0;
    w.spotted[id] = 0;
    w.flags[id] = wanderFlag(cmd.wander && !advance);
    if (cmd.garrisonTown !== undefined && kind.garrison) {
      // Spread over the town's buildings: always the emptiest one that still has room.
      let best = -1;
      for (let st = 0; st < map.structCount; st++) {
        if (map.sTown[st] !== cmd.garrisonTown || map.sKind[st] !== S_BUILDING) continue;
        if (hasRoom(w, st, teamId) && (best < 0 || w.sOcc[st] < w.sOcc[best])) best = st;
      }
      if (best >= 0) enterBuilding(w, id, best);
    }
    if (advance) {
      w.targetX[id] = w.posX[id] + ax;
      w.targetY[id] = w.posY[id] + ay;
      w.flags[id] = FLAG_AMOVE;
      spawned.push(id);
    }
  }
  if (advance) routeUnits(w, spawned, cx + ax, cy + ay);
  if (cmd.wander && !advance) {
    for (let g = firstGroup; g < w.groupCount; g++) orderSquadWander(w, g);
  }
}

function wanderFlag(wander: boolean): number {
  return wander ? FLAG_WANDER : 0;
}

function orderSquadWander(w: World, group: number): void {
  squadScratch.length = 0;
  for (let i = 0; i < w.count; i++) {
    if (w.group[i] === group && (w.flags[i] & FLAG_WANDER) !== 0 && w.state[i] === STATE_ALIVE)
      squadScratch.push(i);
  }
  if (squadScratch.length === 0) return;
  const span = MAP_SIZE_FX - 2 * WANDER_MARGIN;
  const x = WANDER_MARGIN + nextInt(w.rng, span);
  const y = WANDER_MARGIN + nextInt(w.rng, span);
  orderFormationMove(w, squadScratch, x, y);
}

function updateWander(w: World): void {
  if (w.tick === 0) return;
  for (let g = 0; g < w.groupCount; g++) {
    // Stagger squads so new orders are spread over the period instead of all at once.
    if ((w.tick + g * 53) % WANDER_PERIOD === 0) orderSquadWander(w, g);
  }
}

/** Counting sort of the living units into a square grid of `dim` cells per side. */
function bucket(w: World, shift: number, dim: number, start: Int32Array, out: Int32Array): void {
  const n = w.count;
  start.fill(0);
  for (let i = 0; i < n; i++) {
    if (w.state[i] !== STATE_ALIVE || w.carrier[i] >= 0) continue;
    const c = (w.posY[i] >> shift) * dim + (w.posX[i] >> shift);
    cellOf[i] = c;
    start[c + 1]++;
  }
  const cells = dim * dim;
  for (let c = 0; c < cells; c++) start[c + 1] += start[c];
  // Ascending id order inside each cell.
  cellFill.fill(0, 0, cells);
  for (let i = 0; i < n; i++) {
    if (w.state[i] !== STATE_ALIVE || w.carrier[i] >= 0) continue;
    const c = cellOf[i];
    out[start[c] + cellFill[c]++] = i;
  }
}

/**
 * Pick who to shoot: the nearest living enemy within ACQUIRE_RANGE (ties go to the lowest
 * id) that is not concealed by forest. Reads only positions, which do not change during this pass, so the result does not
 * depend on iteration order.
 */
function acquireTargets(w: World): void {
  const n = w.count;
  const tick = w.tick;
  const map = w.map;
  for (let i = 0; i < n; i++) {
    if (w.state[i] !== STATE_ALIVE || w.carrier[i] >= 0) continue;
    const ki = w.kind[i];
    if (KINDS[ki].indirect) {
      acquireIndirect(w, i);
      continue;
    }
    // Nothing to shoot with, or a drone that has lost its link.
    if (!ARMED[ki]) continue;
    if (w.jammed[i] !== 0) {
      w.attack[i] = NO_TARGET;
      w.los[i] = 0;
      continue;
    }
    const x = w.posX[i];
    const y = w.posY[i];
    const t = w.attack[i];
    const phase = tick + i;
    const dmgTable = KINDS[ki].damage;
    const sight2 = SIGHT_SQ[ki];
    const air = IS_AIR[ki];
    const z = eyeZ[i];
    const own = w.inside[i];
    let valid = false;
    let targetKey = 0;
    if (
      t !== NO_TARGET &&
      w.state[t] === STATE_ALIVE &&
      w.team[t] !== w.team[i] &&
      w.carrier[t] < 0
    ) {
      const dx = w.posX[t] - x;
      const dy = w.posY[t] - y;
      const d2 = dx * dx + dy * dy;
      targetKey = d2 + PRIORITY[ki * KIND_COUNT + w.kind[t]];
      // Seen with its own eyes, or known because someone else has it in sight.
      const mine = d2 <= sight2 && (d2 <= CONCEAL_RANGE_SQ || !concealed(w, t));
      valid = d2 <= ACQUIRE_RANGE_SQ && (mine || w.spotted[t] > tick);
      if (valid && (phase & SIGHT_RECHECK_MASK) === 0) {
        const tz = eyeZ[t];
        w.los[i] =
          air ||
          IS_AIR[w.kind[t]] ||
          lineOfSight(map, x, y, z, w.posX[t], w.posY[t], tz, own, w.inside[t])
            ? 1
            : 0;
        if (mine && w.los[i] === 1) w.spotted[t] = tick + SPOT_TICKS;
      }
    }
    // A unit whose last look found enemies near but none in sight looks again at the slow
    // rate: scanning a crowd it cannot see four times as often would buy nothing.
    const slow = valid || w.los[i] === SIGHT_NONE;
    if (slow ? (phase & SEARCH_ALL_MASK) !== 0 : (phase & SEARCH_IDLE_MASK) !== 0) {
      if (!valid) w.attack[i] = NO_TARGET;
      continue;
    }
    const team = w.team[i];
    const cx = x >> COARSE_SHIFT;
    const cy = y >> COARSE_SHIFT;
    const y0 = cy > ACQUIRE_CELLS ? cy - ACQUIRE_CELLS : 0;
    const y1 = cy < COARSE_DIM - 1 - ACQUIRE_CELLS ? cy + ACQUIRE_CELLS : COARSE_DIM - 1;
    const x0 = cx > ACQUIRE_CELLS ? cx - ACQUIRE_CELLS : 0;
    const x1 = cx < COARSE_DIM - 1 - ACQUIRE_CELLS ? cx + ACQUIRE_CELLS : COARSE_DIM - 1;
    // A target still in sight stays unless something closer (or more worth shooting) shows
    // up, which saves most of the sight tests in a standing fight.
    const keep = valid && w.los[i] !== 0;
    let best = keep ? t : NO_TARGET;
    let bestKey = keep ? targetKey : ACQUIRE_RANGE_SQ + LOW_PRIORITY + 1;
    let bestMine = false;
    let budget = MAX_TARGET_TESTS;
    let sightTests = MAX_SIGHT_TESTS;
    let blocked = false;
    for (let gy = y0; gy <= y1 && budget > 0; gy++) {
      const from = coarseStart[gy * COARSE_DIM + x0];
      let to = coarseStart[gy * COARSE_DIM + x1 + 1];
      if (to - from > budget) to = from + budget;
      budget -= to - from;
      for (let s = from; s < to; s++) {
        const j = coarseSorted[s];
        if (w.team[j] === team) continue;
        const dx = w.posX[j] - x;
        const dy = w.posY[j] - y;
        const d2 = dx * dx + dy * dy;
        // Most candidates are simply further away than the best so far: reject them first.
        if (d2 > bestKey || d2 > ACQUIRE_RANGE_SQ) continue;
        const kj = w.kind[j];
        // Nothing this unit carries can hurt it.
        if (dmgTable[kj] === 0) continue;
        const key = d2 + PRIORITY[ki * KIND_COUNT + kj];
        if (key >= bestKey && (key > bestKey || j >= best)) continue;
        // Beyond its own sight, or concealed (forest, rubble, a building, a recon team) and
        // not close: only if the army already knows about it.
        const mine = d2 <= sight2 && (d2 <= CONCEAL_RANGE_SQ || !concealed(w, j));
        if (!mine && w.spotted[j] <= tick) {
          // Enemies about, none of them visible: look again at the slow rate.
          blocked = true;
          continue;
        }
        // Seeing is the expensive test, so it comes last and only for a better candidate.
        // Nothing stands between the ground and a drone.
        if (!air && !IS_AIR[kj]) {
          if (sightTests-- <= 0) continue;
          if (!lineOfSight(map, x, y, z, w.posX[j], w.posY[j], eyeZ[j], own, w.inside[j])) {
            blocked = true;
            continue;
          }
        }
        bestKey = key;
        best = j;
        bestMine = mine;
      }
    }
    // Nothing visible: keep the current target only while it is itself still in sight.
    if (best !== NO_TARGET) {
      w.attack[i] = best;
      w.los[i] = 1;
      // What one unit sees, the whole army can shoot at.
      if (bestMine) w.spotted[best] = tick + SPOT_TICKS;
    } else if (!keep) {
      w.attack[i] = NO_TARGET;
      w.los[i] = blocked ? SIGHT_NONE : 0;
    }
  }
}

/**
 * Which drones are inside an enemy jammer's bubble. A jammed strike drone loses its target
 * and then its life; a jammed recon drone sees nothing. Jamming gives the jammer away.
 */
function updateJamming(w: World): void {
  const n = w.count;
  const tick = w.tick;
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (w.state[i] === STATE_ALIVE && KINDS[w.kind[i]].jam > 0) jammers[count++] = i;
  }
  for (let i = 0; i < n; i++) {
    if (!IS_AIR[w.kind[i]] || w.state[i] !== STATE_ALIVE) continue;
    let hit = 0;
    for (let k = 0; k < count; k++) {
      const e = jammers[k];
      if (w.team[e] === w.team[i]) continue;
      const dx = w.posX[e] - w.posX[i];
      const dy = w.posY[e] - w.posY[i];
      const r = KINDS[w.kind[e]].jam;
      if (dx * dx + dy * dy > r * r) continue;
      hit = 1;
      w.spotted[e] = tick + JAM_REVEAL_TICKS;
    }
    w.jammed[i] = hit;
    if (hit !== 0 && KINDS[w.kind[i]].kamikaze && (tick + i) % JAM_DRAIN_TICKS === 0) {
      damage[i]++;
      killer[i] = i;
    }
  }
}

// Sensors sweep twice a second, staggered by id.
const SPOTTER_MASK = 7;
const MAX_SPOTTER_SIGHT_TESTS = 24;

/**
 * Recon teams and recon drones report every enemy within their sight, not only a target:
 * that is what lets guns reach deep and tanks engage what is hidden. They find concealed
 * troops from DETECT_RANGE. A drone needs no line of sight; a team on the ground does.
 */
function updateSpotters(w: World): void {
  const n = w.count;
  const tick = w.tick;
  const map = w.map;
  for (let i = (SPOTTER_MASK + 1 - (tick & SPOTTER_MASK)) & SPOTTER_MASK; i < n; i += 8) {
    if (w.state[i] !== STATE_ALIVE || w.carrier[i] >= 0) continue;
    const kind = KINDS[w.kind[i]];
    if (!kind.spotter || w.jammed[i] !== 0) continue;
    const x = w.posX[i];
    const y = w.posY[i];
    const team = w.team[i];
    const air = IS_AIR[w.kind[i]];
    const sight2 = kind.sight * kind.sight;
    const reach = (kind.sight >> COARSE_SHIFT) + 1;
    const cx = x >> COARSE_SHIFT;
    const cy = y >> COARSE_SHIFT;
    const y0 = cy > reach ? cy - reach : 0;
    const y1 = cy + reach < COARSE_DIM ? cy + reach : COARSE_DIM - 1;
    const x0 = cx > reach ? cx - reach : 0;
    const x1 = cx + reach < COARSE_DIM ? cx + reach : COARSE_DIM - 1;
    let tests = MAX_SPOTTER_SIGHT_TESTS;
    const until = tick + SPOT_TICKS;
    for (let gy = y0; gy <= y1; gy++) {
      const to = coarseStart[gy * COARSE_DIM + x1 + 1];
      for (let s = coarseStart[gy * COARSE_DIM + x0]; s < to; s++) {
        const j = coarseSorted[s];
        // Already known for longer than this sweep would make it: nothing to add.
        if (w.team[j] === team || w.spotted[j] >= until - SPOTTER_MASK) continue;
        const dx = w.posX[j] - x;
        const dy = w.posY[j] - y;
        const d2 = dx * dx + dy * dy;
        if (d2 > sight2 || (d2 > DETECT_RANGE_SQ && concealed(w, j))) continue;
        if (!air && !IS_AIR[w.kind[j]]) {
          if (tests-- <= 0) continue;
          const jz = eyeZ[j];
          if (!lineOfSight(map, x, y, eyeZ[i], w.posX[j], w.posY[j], jz, w.inside[i], w.inside[j]))
            continue;
        }
        w.spotted[j] = until;
      }
    }
  }
}

/**
 * Target for a gun: an enemy the army has spotted, between minimum and maximum range, with
 * no friendly troops next to it. Other guns come first (counter-battery), then whatever
 * stands still, then the nearest. Looked for every 16 ticks.
 */
function acquireIndirect(w: World, i: number): void {
  const tick = w.tick;
  const kind = KINDS[w.kind[i]];
  const x = w.posX[i];
  const y = w.posY[i];
  const team = w.team[i];
  const max2 = kind.range * kind.range;
  const min2 = kind.minRange * kind.minRange;
  const t = w.attack[i];
  let valid = false;
  if (
    t !== NO_TARGET &&
    w.state[t] === STATE_ALIVE &&
    w.team[t] !== team &&
    w.carrier[t] < 0 &&
    w.spotted[t] > tick
  ) {
    const dx = w.posX[t] - x;
    const dy = w.posY[t] - y;
    const d2 = dx * dx + dy * dy;
    valid = d2 <= max2 && d2 >= min2;
  }
  if (((tick + i) & SEARCH_ALL_MASK) !== 0) {
    if (!valid) w.attack[i] = NO_TARGET;
    return;
  }
  const reach = (kind.range >> COARSE_SHIFT) + 1;
  const cx = x >> COARSE_SHIFT;
  const cy = y >> COARSE_SHIFT;
  const y0 = cy > reach ? cy - reach : 0;
  const y1 = cy + reach < COARSE_DIM ? cy + reach : COARSE_DIM - 1;
  const x0 = cx > reach ? cx - reach : 0;
  const x1 = cx + reach < COARSE_DIM ? cx + reach : COARSE_DIM - 1;
  let best = NO_TARGET;
  let bestKey = 4 * max2;
  let checks = MAX_SIGHT_TESTS;
  for (let gy = y0; gy <= y1; gy++) {
    const from = coarseStart[gy * COARSE_DIM + x0];
    const to = coarseStart[gy * COARSE_DIM + x1 + 1];
    for (let s = from; s < to; s++) {
      const j = coarseSorted[s];
      if (w.team[j] === team || w.spotted[j] <= tick || kind.damage[w.kind[j]] === 0) continue;
      const dx = w.posX[j] - x;
      const dy = w.posY[j] - y;
      const d2 = dx * dx + dy * dy;
      if (d2 > max2 || d2 < min2) continue;
      const key =
        d2 +
        (KINDS[w.kind[j]].indirect ? 0 : 2 * max2) +
        ((w.flags[j] & FLAG_MOVING) !== 0 ? max2 : 0);
      if (key >= bestKey && (key > bestKey || j >= best)) continue;
      if (checks-- <= 0 || dangerClose(w, w.posX[j], w.posY[j], team)) continue;
      bestKey = key;
      best = j;
    }
  }
  w.attack[i] = best;
  w.los[i] = best === NO_TARGET ? 0 : 1;
}

/** Are troops of `team` within DANGER_CLOSE of a point? */
function dangerClose(w: World, x: number, y: number, team: number): boolean {
  const r = (DANGER_CLOSE >> CELL_SHIFT) + 1;
  const cx = x >> CELL_SHIFT;
  const cy = y >> CELL_SHIFT;
  const y0 = cy > r ? cy - r : 0;
  const y1 = cy + r < GRID_DIM ? cy + r : GRID_DIM - 1;
  const x0 = cx > r ? cx - r : 0;
  const x1 = cx + r < GRID_DIM ? cx + r : GRID_DIM - 1;
  for (let gy = y0; gy <= y1; gy++) {
    const to = cellStart[gy * GRID_DIM + x1 + 1];
    for (let s = cellStart[gy * GRID_DIM + x0]; s < to; s++) {
      const j = sorted[s];
      if (w.team[j] !== team || IS_AIR[w.kind[j]]) continue;
      const dx = w.posX[j] - x;
      const dy = w.posY[j] - y;
      if (dx * dx + dy * dy < DANGER_CLOSE * DANGER_CLOSE) return true;
    }
  }
  return false;
}

const ARMOUR_BLAST = (r: number) => Math.trunc(r / 3);

/** Fire a shell from gun `i` at a point `dist` away. It lands later, and not exactly there. */
function launch(w: World, i: number, tx: number, ty: number, dist: number): void {
  const scatter = SCATTER_MIN + (dist >> SCATTER_SHIFT);
  const x = clampInt(tx - scatter + nextInt(w.rng, 2 * scatter + 1), 0, POS_MAX);
  const y = clampInt(ty - scatter + nextInt(w.rng, 2 * scatter + 1), 0, POS_MAX);
  w.cooldown[i] = KINDS[w.kind[i]].reload;
  w.spotted[i] = w.tick + COUNTER_BATTERY_TICKS;
  if (w.shellCount >= MAX_SHELLS) return;
  const k = w.shellCount++;
  w.shX[k] = x;
  w.shY[k] = y;
  w.shTick[k] = w.tick + SHELL_BASE_TICKS + (dist >> SHELL_TICKS_SHIFT);
  w.shOwner[k] = i;
  w.shKind[k] = w.kind[i];
  w.events.push(EV_LAUNCH, i, packPoint(x, y));
}

/**
 * Shells that land this tick. Everything within the blast is hurt, friend or foe, less
 * toward the edge (half at the rim); walls keep three quarters of it off a garrison. A
 * shell that lands on a building or a bridge damages it.
 */
function resolveShells(w: World): void {
  const map = w.map;
  for (let k = 0; k < w.shellCount;) {
    if (w.shTick[k] > w.tick) {
      k++;
      continue;
    }
    const x = w.shX[k];
    const y = w.shY[k];
    const kind = KINDS[w.shKind[k]];
    const owner = w.shOwner[k];
    const last = --w.shellCount;
    w.shX[k] = w.shX[last];
    w.shY[k] = w.shY[last];
    w.shTick[k] = w.shTick[last];
    w.shOwner[k] = w.shOwner[last];
    w.shKind[k] = w.shKind[last];
    w.events.push(EV_IMPACT, packPoint(x, y), 0);
    const cell = cellOfPos(x, y);
    const type = map.type[cell];
    if ((type === T_BUILDING || type === T_BRIDGE) && w.sHp[map.structAt[cell]] > 0) {
      structDamage[map.structAt[cell]] += kind.siege;
    }
    const R = kind.blast;
    const r = (R >> CELL_SHIFT) + 1;
    const cx = x >> CELL_SHIFT;
    const cy = y >> CELL_SHIFT;
    const y0 = cy > r ? cy - r : 0;
    const y1 = cy + r < GRID_DIM ? cy + r : GRID_DIM - 1;
    const x0 = cx > r ? cx - r : 0;
    const x1 = cx + r < GRID_DIM ? cx + r : GRID_DIM - 1;
    for (let gy = y0; gy <= y1; gy++) {
      const to = cellStart[gy * GRID_DIM + x1 + 1];
      for (let s = cellStart[gy * GRID_DIM + x0]; s < to; s++) {
        const j = sorted[s];
        if (IS_AIR[w.kind[j]]) continue;
        const dx = w.posX[j] - x;
        const dy = w.posY[j] - y;
        const d2 = dx * dx + dy * dy;
        // Splinters do nothing to armour: a tank is only hurt by a shell that all but hits it.
        const reach = KINDS[w.kind[j]].armour === null ? R : ARMOUR_BLAST(R);
        if (d2 >= reach * reach) continue;
        let dmg = Math.trunc((kind.damage[w.kind[j]] * (2 * reach - isqrt(d2))) / (2 * reach));
        if (w.inside[j] >= 0) dmg >>= 2;
        else if (
          KIND_CLASS[w.kind[j]] === CLASS_FOOT &&
          map.type[cellOfPos(w.posX[j], w.posY[j])] === T_RUBBLE
        ) {
          dmg >>= 1;
        }
        damage[j] += dmg || 1;
        killer[j] = owner;
      }
    }
  }
}

/**
 * Is unit `j` hard to spot? In forest and in rubble always; in a building until it fires.
 */
function concealed(w: World, j: number): boolean {
  if (w.inside[j] >= 0) return w.reveal[j] <= w.tick;
  if (IS_AIR[w.kind[j]]) return false;
  if (KINDS[w.kind[j]].stealth) return true;
  const t = w.map.type[cellOfPos(w.posX[j], w.posY[j])];
  return t === T_FOREST || (t === T_RUBBLE && KIND_CLASS[w.kind[j]] === CLASS_FOOT);
}

/**
 * Weapons are hitscan: a ready weapon with its target in range hits now. Damage is summed
 * per target from start-of-tick state and applied in resolveDamage(), so two units can
 * kill each other on the same tick and iteration order never matters.
 */
function fire(w: World): void {
  const n = w.count;
  for (let i = 0; i < n; i++) {
    if (w.state[i] !== STATE_ALIVE || w.carrier[i] >= 0) continue;
    if (w.cooldown[i] > 0) {
      w.cooldown[i]--;
      continue;
    }
    const kind = KINDS[w.kind[i]];
    if (kind.indirect) {
      // A gun fires standing still: at the point it was given, or at its spotted target.
      const flags = w.flags[i];
      if ((flags & FLAG_MOVING) !== 0) continue;
      let tx = w.aimX[i];
      let ty = w.aimY[i];
      if ((flags & FLAG_BOMBARD) === 0) {
        const t = w.attack[i];
        if (t === NO_TARGET) continue;
        tx = w.posX[t];
        ty = w.posY[t];
      }
      const dx = tx - w.posX[i];
      const dy = ty - w.posY[i];
      const d2 = dx * dx + dy * dy;
      if (d2 > kind.range * kind.range || d2 < kind.minRange * kind.minRange) continue;
      launch(w, i, tx, ty, isqrt(d2));
      continue;
    }
    if ((w.flags[i] & FLAG_SIEGE) !== 0) {
      // Ordered to bring a structure down: that comes before targets of opportunity.
      const s = w.orderStruct[i];
      if (
        w.sHp[s] > 0 &&
        structDist2(w, s, w.posX[i], w.posY[i]) <= kind.range * kind.range &&
        seesStructure(w, i, s)
      ) {
        structDamage[s] += kind.siege;
        w.cooldown[i] = kind.reload;
        w.events.push(EV_SIEGE, i, s);
        continue;
      }
    }
    const t = w.attack[i];
    if (t === NO_TARGET || w.los[i] === 0) continue;
    const dx = w.posX[t] - w.posX[i];
    const dy = w.posY[t] - w.posY[i];
    const range = rangeTo(w, i, t);
    const d2 = dx * dx + dy * dy;
    if (d2 > range * range) continue;
    let dmg = kind.damage[w.kind[t]];
    const cover = w.inside[t];
    const armour = KINDS[w.kind[t]].armour;
    if (armour !== null && d2 > 0 && !kind.kamikaze) {
      // Which plate the shot meets: the angle between the target's nose and the shooter.
      const cos = Math.trunc((-dx * w.faceX[t] - dy * w.faceY[t]) / isqrt(d2));
      dmg =
        Math.trunc((dmg * armour[cos >= FACING_COS ? 0 : cos <= -FACING_COS ? 2 : 1]) / 100) || 1;
    }
    if (cover >= 0) {
      // Walls stop most of it. What a tank gun does not do to the men it does to the house.
      dmg = dmg >> 2 || 1;
      structDamage[cover] += kind.siege;
    } else if (
      KIND_CLASS[w.kind[t]] === CLASS_FOOT &&
      w.map.type[cellOfPos(w.posX[t], w.posY[t])] === T_RUBBLE
    ) {
      dmg = (dmg + 1) >> 1;
    }
    damage[t] += dmg;
    killer[t] = i;
    w.cooldown[i] = kind.reload;
    if (w.inside[i] >= 0) w.reveal[i] = w.tick + REVEAL_TICKS;
    w.events.push(EV_SHOT, i, t);
    if (kind.kamikaze) {
      // The drone is the warhead.
      damage[i] += 30000;
      killer[i] = i;
    }
  }
}

function resolveDamage(w: World): void {
  const n = w.count;
  for (let i = 0; i < n; i++) {
    const state = w.state[i];
    if (state === STATE_ALIVE) {
      const d = damage[i];
      if (d === 0) continue;
      damage[i] = 0;
      const hp = w.hp[i] - d;
      if (hp > 0) {
        w.hp[i] = hp;
        continue;
      }
      kill(w, i, killer[i]);
    } else if (state === STATE_WRECK && --w.cooldown[i] <= 0) {
      w.state[i] = STATE_FREE;
    }
  }
}

function kill(w: World, i: number, by: number): void {
  if (w.inside[i] >= 0) {
    w.sOcc[w.inside[i]]--;
    w.inside[i] = -1;
  }
  if (w.carrier[i] >= 0) {
    w.load[w.carrier[i]]--;
    w.carrier[i] = -1;
  }
  if (w.load[i] > 0) {
    // The vehicle is hit with its squads aboard: half of each gets out.
    for (let j = 0; j < w.count; j++) {
      if (w.carrier[j] !== i) continue;
      w.carrier[j] = -1;
      w.hp[j] -= w.hp[j] >> 1;
      w.flags[j] = 0;
    }
    w.load[i] = 0;
  }
  w.hp[i] = 0;
  w.state[i] = STATE_WRECK;
  w.cooldown[i] = KINDS[w.kind[i]].wreckTicks;
  w.flags[i] = 0;
  w.velX[i] = 0;
  w.velY[i] = 0;
  w.attack[i] = NO_TARGET;
  w.events.push(EV_DEATH, i, by);
}

/** Apply the tick's damage to structures. A structure at zero comes down for good. */
function resolveStructures(w: World): void {
  const map = w.map;
  for (let s = 0; s < map.structCount; s++) {
    const d = structDamage[s];
    if (d === 0) continue;
    structDamage[s] = 0;
    if (w.sHp[s] <= 0) continue;
    w.sHp[s] -= d;
    if (w.sHp[s] > 0) continue;
    w.sHp[s] = 0;
    w.sRepair[s] = 0;
    const bridge = map.sKind[s] === S_BRIDGE;
    // Twice for a bridge: squads thrown out of a sinking carrier are in the river too.
    for (let pass = 0; pass < (bridge ? 2 : 1); pass++) {
      for (let i = 0; i < w.count; i++) {
        if (w.state[i] !== STATE_ALIVE) continue;
        if (bridge) {
          // Whoever is on the span goes down with it.
          const c = cellOfPos(w.posX[i], w.posY[i]);
          if (map.structAt[c] === s && map.type[c] === T_BRIDGE && !IS_AIR[w.kind[i]]) {
            kill(w, i, i);
          }
        } else if (w.inside[i] === s) {
          // The house falls on its garrison: half of what is left of each squad walks out.
          w.inside[i] = -1;
          w.hp[i] -= w.hp[i] >> 1;
        }
      }
    }
    w.sOcc[s] = 0;
    razeStructure(map, s);
    topologyChanged = true;
    w.events.push(EV_COLLAPSE, s, 0);
  }
}

/**
 * Once a second: who holds each town, what it pays, and work on cut bridges. A town goes
 * to the only army inside its circle, faster with more units; while two armies are inside,
 * nothing moves. A garrison counts, so a town is not taken until its houses are cleared.
 */
function updateTowns(w: World): void {
  const map = w.map;
  const towns = map.townCount;
  townCount.fill(0);
  repairCrew.fill(0);
  let cut = 0;
  for (let s = 0; s < map.structCount; s++) {
    if (map.sKind[s] === S_BRIDGE && w.sHp[s] <= 0) cut++;
  }
  for (let i = 0; i < w.count; i++) {
    if (w.state[i] !== STATE_ALIVE || w.carrier[i] >= 0 || IS_AIR[w.kind[i]]) continue;
    const x = w.posX[i];
    const y = w.posY[i];
    const team = w.team[i];
    for (let t = 0; t < towns; t++) {
      const dx = x - map.townX[t];
      const dy = y - map.townY[t];
      if (dx * dx + dy * dy <= map.townR[t] * map.townR[t]) townCount[t * MAX_TEAMS + team]++;
    }
    if (cut === 0 || !KINDS[w.kind[i]].garrison) continue;
    if ((w.flags[i] & FLAG_MOVING) !== 0 || w.attack[i] !== NO_TARGET) continue;
    for (let s = 0; s < map.structCount; s++) {
      if (map.sKind[s] !== S_BRIDGE || w.sHp[s] > 0) continue;
      if (structDist2(w, s, x, y) <= REPAIR_DIST * REPAIR_DIST) repairCrew[s * MAX_TEAMS + team]++;
    }
  }
  for (let t = 0; t < towns; t++) {
    let present = 0;
    let team = NO_TEAM;
    let count = 0;
    for (let k = 0; k < MAX_TEAMS; k++) {
      const c = townCount[t * MAX_TEAMS + k];
      if (c === 0) continue;
      present++;
      team = k;
      count = c;
    }
    if (present === 0) {
      if (w.townProgress[t] > 0) w.townProgress[t] -= w.townProgress[t] < 5 ? w.townProgress[t] : 5;
    } else if (present === 1) {
      if (team === w.townOwner[t]) {
        w.townProgress[t] = 0;
        w.townCapturer[t] = NO_TEAM;
      } else {
        if (w.townCapturer[t] !== team) {
          w.townCapturer[t] = team;
          w.townProgress[t] = 0;
        }
        w.townProgress[t] += count < 10 ? count : 10;
        if (w.townProgress[t] >= CAPTURE_POINTS) {
          w.townOwner[t] = team;
          w.townCapturer[t] = NO_TEAM;
          w.townProgress[t] = 0;
          w.events.push(EV_CAPTURE, t, team);
        }
      }
    }
    if (w.townOwner[t] !== NO_TEAM) w.credits[w.townOwner[t]] += TOWN_INCOME;
  }
  for (let s = 0; cut > 0 && s < map.structCount; s++) {
    if (map.sKind[s] !== S_BRIDGE || w.sHp[s] > 0) continue;
    let crew = 0;
    let teams = 0;
    for (let k = 0; k < MAX_TEAMS; k++) {
      const c = repairCrew[s * MAX_TEAMS + k];
      if (c === 0) continue;
      teams++;
      crew = c;
    }
    if (teams !== 1) continue;
    w.sRepair[s] += (crew < 5 ? crew : 5) * REPAIR_PER_SQUAD;
    if (w.sRepair[s] < map.sMaxHp[s]) continue;
    w.sRepair[s] = 0;
    w.sHp[s] = map.sMaxHp[s];
    stampStructure(map, s);
    topologyChanged = true;
    w.events.push(EV_REPAIR, s, 0);
  }
}

/**
 * Desired velocity. A unit that is free to fight (idle, attack-moving or roaming) closes
 * on its target until in weapon range and then holds. A unit under a plain move order keeps
 * going and only shoots what happens to be in range. Either way the unit walks a straight
 * line when the ground allows it and follows a flowfield around obstacles when not.
 */
function steer(w: World): void {
  const n = w.count;
  const map = w.map;
  const tick = w.tick;
  for (let i = 0; i < n; i++) {
    if (w.state[i] !== STATE_ALIVE) continue;
    if (w.inside[i] >= 0 || w.carrier[i] >= 0) continue; // garrisons and passengers stay put
    let flags = w.flags[i];
    const cls = KIND_CLASS[w.kind[i]];
    const x = w.posX[i];
    const y = w.posY[i];
    const cell = cellOfPos(x, y);
    const s = w.speed[i];
    let vx = 0;
    let vy = 0;
    let busy = false;
    if ((flags & FLAG_SIEGE) !== 0) {
      // Close enough to shell the structure and able to see it: stop here.
      const st = w.orderStruct[i];
      const reach = KINDS[w.kind[i]].range - fx(1);
      if (structDist2(w, st, x, y) <= reach * reach && seesStructure(w, i, st)) {
        w.velX[i] = 0;
        w.velY[i] = 0;
        continue;
      }
    }
    if ((flags & (FLAG_BOMBARD | FLAG_MOVING)) === (FLAG_BOMBARD | FLAG_MOVING)) {
      // Driving up to shell a point: close enough is where the gun can reach it from.
      const dx = w.aimX[i] - x;
      const dy = w.aimY[i] - y;
      const reach = KINDS[w.kind[i]].range - fx(4);
      if (dx * dx + dy * dy <= reach * reach) {
        flags &= ~(FLAG_MOVING | FLAG_DIRECT);
        w.flags[i] = flags;
      }
    }
    const t = w.attack[i];
    if (
      t !== NO_TARGET &&
      !KINDS[w.kind[i]].indirect &&
      ((flags & FLAG_MOVING) === 0 || (flags & (FLAG_AMOVE | FLAG_WANDER)) !== 0)
    ) {
      const dx = w.posX[t] - x;
      const dy = w.posY[t] - y;
      const d2 = dx * dx + dy * dy;
      const range = rangeTo(w, i, t);
      if (d2 <= range * range && w.los[i] !== 0) {
        busy = true;
      } else if (clearLine(map, cls, x, y, w.posX[t], w.posY[t])) {
        const dist = isqrt(d2);
        vx = Math.trunc((dx * s) / dist);
        vy = Math.trunc((dy * s) / dist);
        busy = true;
      } else {
        // Something is in the way: take the walkable route to the nearest enemy, if any.
        const f = w.team[i] * CLASS_COUNT + cls;
        w.chaseWanted[f] = tick;
        const field = w.chaseDist[f];
        const dir = field ? flowDirection(map, cls, field, cell) : -1;
        if (dir >= 0) {
          vx = Math.trunc((DIR_X[dir] * s) / 1024);
          vy = Math.trunc((DIR_Y[dir] * s) / 1024);
          busy = true;
        }
      }
    }
    if (!busy && (flags & FLAG_MOVING) !== 0) {
      const pace = w.orderSpeed[i] < s ? w.orderSpeed[i] : s;
      const tx = w.targetX[i];
      const ty = w.targetY[i];
      if (((tick + i) & DIRECT_RECHECK_MASK) === 0) {
        flags = clearLine(map, cls, x, y, tx, ty) ? flags | FLAG_DIRECT : flags & ~FLAG_DIRECT;
        w.flags[i] = flags;
      }
      let field = -1;
      if ((flags & FLAG_DIRECT) === 0) {
        field = w.path[i];
        if (field < 0) field = w.path[i] = acquireField(w, map.snap[cls][w.goal[i]], cls);
      }
      if (field < 0) {
        const dx = tx - x;
        const dy = ty - y;
        const dist = isqrt(dx * dx + dy * dy);
        if (dist <= pace) {
          vx = dx;
          vy = dy;
          w.flags[i] = flags & ~(FLAG_MOVING | FLAG_AMOVE | FLAG_DIRECT);
        } else {
          vx = Math.trunc((dx * pace) / dist);
          vy = Math.trunc((dy * pace) / dist);
        }
      } else {
        const dir = flowDirection(map, cls, w.fieldDist[field]!, cell);
        if (dir >= 0) {
          vx = Math.trunc((DIR_X[dir] * pace) / 1024);
          vy = Math.trunc((DIR_Y[dir] * pace) / 1024);
        } else {
          // At the field's goal with no clear line to the unit's own spot (or cut off from
          // the goal altogether): this is as close as it gets.
          w.flags[i] = flags & ~(FLAG_MOVING | FLAG_AMOVE | FLAG_DIRECT);
        }
      }
    }
    if (map.cost[cls][cell] > 1) {
      // Slow ground (infantry in forest).
      vx = Math.trunc(vx / 2);
      vy = Math.trunc(vy / 2);
    }
    w.velX[i] = vx;
    w.velY[i] = vy;
    const turn = KINDS[w.kind[i]].turn;
    if (turn === 0) continue;
    // The hull turns toward where it is driving, or, standing, toward what it is shooting.
    let hx = vx;
    let hy = vy;
    if (vx * vx + vy * vy < FACE_MIN_SPEED_SQ) {
      if (t === NO_TARGET || w.los[i] !== 1) continue;
      hx = w.posX[t] - x;
      hy = w.posY[t] - y;
    }
    const len = isqrt(hx * hx + hy * hy);
    if (len === 0) continue;
    let ux = Math.trunc((hx * 1024) / len);
    let uy = Math.trunc((hy * 1024) / len);
    const fxi = w.faceX[i];
    const fyi = w.faceY[i];
    if (fxi * ux + fyi * uy < -1000 * 1024) {
      // Dead astern: pick a side, or the blend below would never leave the spot.
      ux = -fyi;
      uy = fxi;
    }
    const bx = fxi * turn + ux;
    const by = fyi * turn + uy;
    const bl = isqrt(bx * bx + by * by);
    if (bl === 0) continue;
    w.faceX[i] = Math.trunc((bx * 1024) / bl);
    w.faceY[i] = Math.trunc((by * 1024) / bl);
  }
}

/**
 * Soft collision: overlapping units push each other apart. Pushes are computed from the
 * positions at the start of the tick and applied afterwards, so the result does not depend
 * on iteration order.
 */
function separate(w: World): void {
  const n = w.count;
  for (let i = 0; i < n; i++) {
    if (w.state[i] !== STATE_ALIVE) continue;
    if (w.inside[i] >= 0 || w.carrier[i] >= 0) {
      pushX[i] = pushY[i] = 0;
      continue;
    }
    const x = w.posX[i];
    const y = w.posY[i];
    const cx = x >> CELL_SHIFT;
    const cy = y >> CELL_SHIFT;
    const y0 = cy > 0 ? cy - 1 : 0;
    const y1 = cy < GRID_DIM - 1 ? cy + 1 : cy;
    const x0 = cx > 0 ? cx - 1 : 0;
    const x1 = cx < GRID_DIM - 1 ? cx + 1 : cx;
    let px = 0;
    let py = 0;
    const air = IS_AIR[w.kind[i]];
    let budget = MAX_NEIGHBOUR_TESTS;
    for (let gy = y0; gy <= y1 && budget > 0; gy++) {
      // Cells x0..x1 of a row are contiguous in the sorted array.
      const from = cellStart[gy * GRID_DIM + x0];
      let to = cellStart[gy * GRID_DIM + x1 + 1];
      if (to - from > budget) to = from + budget;
      budget -= to - from;
      for (let s = from; s < to; s++) {
        const j = sorted[s];
        if (j === i || IS_AIR[w.kind[j]] !== air) continue;
        const dx = x - w.posX[j];
        const dy = y - w.posY[j];
        if (dx >= SEP_RADIUS || dx <= -SEP_RADIUS || dy >= SEP_RADIUS || dy <= -SEP_RADIUS) {
          continue;
        }
        const d2 = dx * dx + dy * dy;
        if (d2 >= SEP_RADIUS_SQ) continue;
        if (d2 === 0) {
          // Exactly stacked: split along x by id so the pair separates symmetrically.
          px += i < j ? -(SEP_RADIUS >> 3) : SEP_RADIUS >> 3;
          continue;
        }
        const d = isqrt(d2);
        const overlap = SEP_RADIUS - d;
        px += Math.trunc((dx * overlap) / ((d + 1) * 4));
        py += Math.trunc((dy * overlap) / ((d + 1) * 4));
      }
    }
    pushX[i] = clampInt(px, -MAX_PUSH, MAX_PUSH);
    pushY[i] = clampInt(py, -MAX_PUSH, MAX_PUSH);
  }
}

function integrate(w: World): void {
  const n = w.count;
  const map = w.map;
  for (let i = 0; i < n; i++) {
    if (w.state[i] !== STATE_ALIVE || w.inside[i] >= 0 || w.carrier[i] >= 0) continue;
    const x = w.posX[i];
    const y = w.posY[i];
    let nx = clampInt(x + w.velX[i] + pushX[i], 0, POS_MAX);
    let ny = clampInt(y + w.velY[i] + pushY[i], 0, POS_MAX);
    // Impassable ground is a hard wall: slide along it. (A unit that somehow stands on
    // impassable ground may move freely, so it can get off.)
    const cost = map.cost[KIND_CLASS[w.kind[i]]];
    if (cost[cellOfPos(nx, ny)] === 0 && cost[cellOfPos(x, y)] !== 0) {
      if (cost[cellOfPos(nx, y)] !== 0) ny = y;
      else if (cost[cellOfPos(x, ny)] !== 0) nx = x;
      else {
        nx = x;
        ny = y;
      }
    }
    w.posX[i] = nx;
    w.posY[i] = ny;
  }
  // Passengers go where their vehicle goes.
  for (let i = 0; i < n; i++) {
    const c = w.carrier[i];
    if (c < 0) continue;
    w.posX[i] = w.posX[c];
    w.posY[i] = w.posY[c];
  }
}
