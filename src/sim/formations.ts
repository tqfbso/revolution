// How a body of troops moves (I4, decision 147): the shape it marches in and keeps on the way.
//
// A move order used to end in a block and promise nothing about the road there. Now every
// order has a shape. On a street or into a town it is a convoy: the vehicles in file at a
// fixed gap, squads on both pavements beside them, the first pair ahead of the lead vehicle
// to look round the corner. In the open it is the shape of the army's doctrine: a wedge, a
// line, a vee. The player can force any of them on a selection or on a commander.
//
// The shape is kept by station keeping, not by paths: one unit, the guide, follows the
// route; every other keeps a place relative to a lead (the guide, or the vehicle ahead of it
// in the file). A unit that cannot see its place across open ground, or whose lead has
// stopped to fight, simply goes on to its own spot by the route, as every unit did before.
//
// All of it is integers on sim state, like the rest of the sim.
import { fx, isqrt } from './fixed';
import { CELL_SHIFT, CLASS_AIR, CLASS_FOOT, MAP_CELLS, type GameMap } from './map';
import { clearLine } from './path';
import { KINDS, PROFILE_IFV, PROFILE_TANK } from './units';
import {
  CF_SHAPE_MASK,
  CF_SHAPE_SHIFT,
  FLAG_AMOVE,
  FLAG_MOVING,
  MAP_SIZE_FX,
  MAX_COMMANDERS,
  MAX_UNITS,
  NO_TARGET,
  STATE_ALIVE,
  type World,
} from './world';

/** Let the ground and the doctrine decide. */
export const SHAPE_AUTO = 0;
/** Vehicles in file, squads on both sides: the road and the street. */
export const SHAPE_CONVOY = 1;
/** Armour at the point, the wings swept back. */
export const SHAPE_WEDGE = 2;
/** Everyone abreast, armour in the first line. */
export const SHAPE_LINE = 3;
/** The wings forward, the middle held back. */
export const SHAPE_VEE = 4;
/** Stepped back to the right: for an open flank. */
export const SHAPE_ECHELON = 5;
/** The old block, twice as wide as deep, with no shape kept on the way. */
export const SHAPE_BLOCK = 6;
export const SHAPE_COUNT = 7;

export const SHAPES: readonly { name: string; tip: string }[] = [
  {
    name: 'Auto',
    tip: 'A convoy on roads and into towns; in open ground the formation of your army.',
  },
  {
    name: 'Convoy',
    tip: 'Vehicles in file with a gap between them, squads on both sides. Narrow and quick through streets; strung out if it is caught in the open.',
  },
  {
    name: 'Wedge',
    tip: 'Armour at the point, wings swept back, squads behind. Good in open ground when you do not know where the enemy is.',
  },
  {
    name: 'Line',
    tip: 'Armour abreast in front, squads in a second line. Every gun bears forward; weak on the flanks.',
  },
  {
    name: 'Vee',
    tip: 'Two wings forward, the middle held back. Whatever walks into it is shot at from both sides.',
  },
  {
    name: 'Echelon',
    tip: 'Stepped back to the right, to cover an open flank.',
  },
  { name: 'Block', tip: 'A plain block, vehicles in front. Keeps no shape on the way.' },
];

/**
 * The shape an army takes in open ground when it is left to itself, by faction (0 none,
 * 1 Western alliance, 2 Russia, 3 China). No faction keeps the old block everywhere, so a
 * game without factions plays to the bit as it did before there were shapes.
 */
export const DOCTRINE: readonly number[] = [SHAPE_BLOCK, SHAPE_WEDGE, SHAPE_LINE, SHAPE_VEE];

/** How a unit keeps station on its lead. */
export const BERTH_NONE = 0;
/** Behind it, wherever it goes, at a gap. */
export const BERTH_TRAIL = 1;
/** At a fixed offset on the map (offA east, offB south): the open shapes. */
export const BERTH_SLOT = 2;
/** At an offset in the lead's own frame (offA ahead, offB to its right): beside a vehicle. */
export const BERTH_FLANK = 3;

/** Gap between vehicles in file, centre to centre, and between men in file. */
const GAP_VEHICLE = fx(9);
const GAP_FOOT = fx(3);
/** A unit further than this behind its place closes up at its own speed. */
const CLOSE_UP = fx(5);
/** How far out from the middle of the street the squads walk. */
const PAVEMENT = fx(3.5);
/** Squads beside each vehicle: this many pairs. */
const ESCORT_ROWS = 3;
const ESCORT_STEP = fx(2.6);
/** The first pair walks this far ahead of the lead vehicle: it sees round the corner first. */
const POINT_AHEAD = fx(6);
/** Spacing in the open shapes. */
const SPACE_VEHICLE = fx(6);
const SPACE_FOOT = fx(3.2);
const SPACE_BAND = fx(8);
/** No rank of an open shape is longer than this. */
const RANK_MAX = 11;
/** How near a street or a square the place ordered must be to count as on it, in cells. */
const ROAD_NEAR = 2;

const ROLE_ARMOUR = 0;
const ROLE_FOOT = 1;
const ROLE_REAR = 2;
/** What each kind is on a march: a fighting vehicle, men on foot, or the rest. */
const ROLE = KINDS.map((k) =>
  k.cls === CLASS_FOOT
    ? ROLE_FOOT
    : k.profile === PROFILE_TANK || k.profile === PROFILE_IFV
      ? ROLE_ARMOUR
      : ROLE_REAR,
);
const CLS = KINDS.map((k) => k.cls);
const TURNS = KINDS.map((k) => k.turn > 0);

// What `arrange` decided, kept until the units have been routed (routing clears a unit's
// station) and `commit` writes it into the world.
const pLead = new Int32Array(MAX_UNITS);
const pBerth = new Uint8Array(MAX_UNITS);
const pA = new Int32Array(MAX_UNITS);
const pB = new Int32Array(MAX_UNITS);
const slotA = new Int32Array(MAX_UNITS);
const slotB = new Int32Array(MAX_UNITS);

/** Whether the place (x, y) is on or by a street or a square, or inside a town. */
export function builtUp(map: GameMap, x: number, y: number): boolean {
  for (let t = 0; t < map.townCount; t++) {
    const dx = (x - map.townX[t]) >> 4;
    const dy = (y - map.townY[t]) >> 4;
    const r = map.townR[t] >> 4;
    if (dx * dx + dy * dy <= r * r) return true;
  }
  if (map.streets.length === 0) return false;
  const cx = x >> CELL_SHIFT;
  const cy = y >> CELL_SHIFT;
  for (let j = cy - ROAD_NEAR; j <= cy + ROAD_NEAR; j++) {
    if (j < 0 || j >= MAP_CELLS) continue;
    for (let i = cx - ROAD_NEAR; i <= cx + ROAD_NEAR; i++) {
      if (i < 0 || i >= MAP_CELLS) continue;
      if (map.road[j * MAP_CELLS + i] !== 0) return true;
    }
  }
  return false;
}

/**
 * The shape `units` take on a move to (cx, cy): what their commander was told, else what
 * they were told themselves (the first of them speaks for all), else the ground's.
 */
export function shapeFor(w: World, units: readonly number[], cx: number, cy: number): number {
  const first = units[0];
  let shape: number;
  if (w.cmdr[first] >= 0) {
    const c = w.team[first] * MAX_COMMANDERS + w.cmdr[first];
    shape = (w.cFlags[c] >> CF_SHAPE_SHIFT) & CF_SHAPE_MASK;
  } else shape = w.shape[first];
  if (shape > SHAPE_AUTO && shape < SHAPE_COUNT) return shape;
  const doctrine = DOCTRINE[w.faction[w.team[first]]] ?? SHAPE_BLOCK;
  if (doctrine === SHAPE_BLOCK) return SHAPE_BLOCK;
  return builtUp(w.map, cx, cy) ? SHAPE_CONVOY : doctrine;
}

/**
 * Give every unit of a convoy its lead. `units` is the order's own list; `forward` and
 * `side` are where each stands relative to the body (along the way, and across it).
 * Returns the guide. Where they stop is the caller's business: a convoy halts in a block.
 */
export function arrangeConvoy(
  w: World,
  units: readonly number[],
  forward: Int32Array,
  side: Int32Array,
): number {
  const front = (a: number, b: number) => forward[b] - forward[a] || a - b;
  const armour: number[] = [];
  const soft: number[] = [];
  const foot: number[] = [];
  for (let k = 0; k < units.length; k++) {
    const id = units[k];
    pLead[id] = -1;
    pBerth[id] = BERTH_NONE;
    pA[id] = 0;
    pB[id] = 0;
    const cls = CLS[w.kind[id]];
    if (cls === CLASS_AIR) continue;
    if (cls === CLASS_FOOT) foot.push(id);
    else if (ROLE[w.kind[id]] === ROLE_ARMOUR) armour.push(id);
    else soft.push(id);
  }
  armour.sort(front);
  soft.sort(front);
  foot.sort(front);
  // With three fighting vehicles or more, the rearmost closes the file: a rear guard.
  const guard = armour.length >= 3 && soft.length > 0 ? armour.pop() : undefined;
  const file = armour.concat(soft);
  if (guard !== undefined) file.push(guard);
  for (let v = 1; v < file.length; v++) {
    pLead[file[v]] = file[v - 1];
    pBerth[file[v]] = BERTH_TRAIL;
  }
  const beside = file.length * ESCORT_ROWS;
  let prevL = -1;
  let prevR = -1;
  for (let f = 0; f < foot.length; f += 2) {
    // Each pair in turn: the one further left takes the left pavement.
    let l = foot[f];
    let r = f + 1 < foot.length ? foot[f + 1] : -1;
    if (r >= 0 && (side[l] > side[r] || (side[l] === side[r] && l > r))) {
      const t = l;
      l = r;
      r = t;
    }
    const pair = f >> 1;
    for (let h = 0; h < 2; h++) {
      const id = h === 0 ? l : r;
      if (id < 0) continue;
      const sign = h === 0 ? -1 : 1;
      if (pair < beside) {
        const v = Math.trunc(pair / ESCORT_ROWS);
        pLead[id] = file[v];
        pBerth[id] = BERTH_FLANK;
        pA[id] = (v === 0 ? POINT_AHEAD : ESCORT_STEP) - (pair % ESCORT_ROWS) * ESCORT_STEP;
        pB[id] = sign * PAVEMENT;
      } else if (pair === beside && file.length > 0) {
        // The squads there is no vehicle for: two files behind the last one.
        pLead[id] = file[file.length - 1];
        pBerth[id] = BERTH_FLANK;
        pA[id] = -GAP_VEHICLE;
        pB[id] = sign * PAVEMENT;
      } else if (prevL < 0) {
        // No vehicles at all: two files of men, the left one's first man the guide.
        if (h === 0) continue;
        pLead[id] = l;
        pBerth[id] = BERTH_FLANK;
        pB[id] = 2 * PAVEMENT;
      } else {
        pLead[id] = h === 0 ? prevL : prevR;
        pBerth[id] = BERTH_TRAIL;
      }
    }
    prevL = l;
    prevR = r >= 0 ? r : l;
  }
  return file.length > 0 ? file[0] : foot.length > 0 ? firstLeft(foot, side) : -1;
}

/** The man of the first pair who walks on the left: the guide of a convoy on foot. */
function firstLeft(foot: readonly number[], side: Int32Array): number {
  if (foot.length < 2) return foot[0];
  const a = foot[0];
  const b = foot[1];
  return side[a] > side[b] || (side[a] === side[b] && a > b) ? b : a;
}

/** Slot `k` of a rank of `n` in `shape`, `d` apart: how far ahead (0 or less) and to the right. */
function rankSlot(shape: number, k: number, n: number, d: number): [number, number] {
  const h = (k + 1) >> 1;
  const sign = (k & 1) === 1 ? 1 : -1;
  const step = Math.trunc((d * 2) / 3);
  switch (shape) {
    case SHAPE_WEDGE:
      return [-h * step, sign * h * d];
    case SHAPE_VEE:
      return [-((n >> 1) - h) * step, sign * h * d];
    case SHAPE_ECHELON:
      return [-k * step, Math.trunc(((2 * k - (n - 1)) * d) / 2)];
    default:
      return [0, sign * h * d];
  }
}

/** How deep a rank of `n` in `shape` is. */
function rankDepth(shape: number, n: number, d: number): number {
  const step = Math.trunc((d * 2) / 3);
  if (shape === SHAPE_WEDGE || shape === SHAPE_VEE) return (n >> 1) * step;
  if (shape === SHAPE_ECHELON) return (n - 1) * step;
  return 0;
}

/**
 * Put `units` into an open shape that ends centred on (cx, cy) facing (ux, uy) (Q10):
 * armour in front, the squads behind it, everything else at the back, each in ranks of the
 * shape. Sets every unit's target and its station on the guide, and returns the guide.
 */
export function arrangeShape(
  w: World,
  units: readonly number[],
  shape: number,
  cx: number,
  cy: number,
  ux: number,
  uy: number,
  forward: Int32Array,
  side: Int32Array,
): number {
  const bands: number[][] = [[], [], []];
  for (let k = 0; k < units.length; k++) bands[ROLE[w.kind[units[k]]]].push(units[k]);
  let depth = 0;
  let guide = -1;
  let first = true;
  let bestA = 0;
  let bestB = 0;
  let minA = 0;
  let minB = 0;
  let maxB = 0;
  for (let role = 0; role < 3; role++) {
    const band = bands[role];
    if (band.length === 0) continue;
    // The rear is never the point of anything: it follows in lines.
    const form = role === ROLE_REAR ? SHAPE_LINE : shape;
    const d = role === ROLE_FOOT ? SPACE_FOOT : SPACE_VEHICLE;
    band.sort((a, b) => forward[b] - forward[a] || a - b);
    for (let from = 0; from < band.length; from += RANK_MAX) {
      const rank = band.slice(from, from + RANK_MAX);
      const n = rank.length;
      rank.sort((a, b) => side[a] - side[b] || a - b);
      // The slots of the rank from left to right, to be taken by the units from left to right.
      const order: number[] = [];
      for (let k = 0; k < n; k++) order.push(k);
      order.sort((p, q) => rankSlot(form, p, n, d)[1] - rankSlot(form, q, n, d)[1] || p - q);
      for (let k = 0; k < n; k++) {
        const id = rank[k];
        const [a, b] = rankSlot(form, order[k], n, d);
        slotA[id] = depth + a;
        slotB[id] = b;
        if (slotA[id] < minA) minA = slotA[id];
        if (b < minB) minB = b;
        if (b > maxB) maxB = b;
        // The guide is the foremost of the first rank, the one nearest the middle.
        if (first) {
          const off = b < 0 ? -b : b;
          if (guide < 0 || a > bestA || (a === bestA && off < bestB)) {
            guide = id;
            bestA = a;
            bestB = off;
          }
        }
      }
      first = false;
      depth -= rankDepth(form, n, d) + Math.trunc((d * 3) / 2);
    }
    depth -= SPACE_BAND - Math.trunc((d * 3) / 2);
  }
  const midA = minA >> 1;
  const midB = (minB + maxB) >> 1;
  for (let k = 0; k < units.length; k++) {
    const id = units[k];
    const a = slotA[id] - midA;
    const b = slotB[id] - midB;
    w.targetX[id] = cx + Math.trunc((ux * a - uy * b) / 1024);
    w.targetY[id] = cy + Math.trunc((uy * a + ux * b) / 1024);
    if (id === guide) {
      pLead[id] = -1;
      pBerth[id] = BERTH_NONE;
      continue;
    }
    const ga = slotA[id] - slotA[guide];
    const gb = slotB[id] - slotB[guide];
    pLead[id] = guide;
    pBerth[id] = BERTH_SLOT;
    pA[id] = Math.trunc((ux * ga - uy * gb) / 1024);
    pB[id] = Math.trunc((uy * ga + ux * gb) / 1024);
  }
  return guide;
}

/**
 * Write the stations `arrangeConvoy` or `arrangeShape` chose into the world, as one march.
 * The guide walks a little under the pace of the slowest, so that the slowest can still
 * close up to its place.
 */
export function commitMarch(
  w: World,
  units: readonly number[],
  guide: number,
  slowest: number,
): void {
  if (guide < 0) return;
  w.marchSeq = (w.marchSeq + 1) | 0;
  if (w.marchSeq === 0) w.marchSeq = 1;
  for (let k = 0; k < units.length; k++) {
    const id = units[k];
    w.march[id] = w.marchSeq;
    w.lead[id] = pLead[id];
    w.berth[id] = pBerth[id];
    w.offA[id] = pA[id];
    w.offB[id] = pB[id];
  }
  w.orderSpeed[guide] = slowest - (slowest >> 3);
}

/** What `keepStation` decided: a velocity, or (when it returns 0) the pace to go on at. */
export const station = { vx: 0, vy: 0, pace: 0 };

/**
 * Unit `i`, on a move at `pace` with its own top speed `s`, keeps station on its lead.
 * Returns 1 with the velocity in `station` when it does; 0 when it is on its own (no lead,
 * or one that is dead, stopped, on another order or fighting, or a place it cannot walk
 * straight to), with the pace to go on at in `station.pace`.
 */
export function keepStation(w: World, i: number, layer: number, s: number, pace: number): number {
  station.pace = pace;
  const lead = w.lead[i];
  if (lead < 0) return 0;
  const lf = w.flags[lead];
  if (
    w.state[lead] !== STATE_ALIVE ||
    w.march[lead] !== w.march[i] ||
    (lf & FLAG_MOVING) === 0 ||
    ((lf & FLAG_AMOVE) !== 0 && w.attack[lead] !== NO_TARGET)
  ) {
    return 0;
  }
  const x = w.posX[i];
  const y = w.posY[i];
  let px = w.posX[lead];
  let py = w.posY[lead];
  const berth = w.berth[i];
  let gap = 0;
  if (berth === BERTH_TRAIL) {
    gap = CLS[w.kind[i]] === CLASS_FOOT ? GAP_FOOT : GAP_VEHICLE;
  } else if (berth === BERTH_SLOT) {
    px += w.offA[i];
    py += w.offB[i];
  } else {
    // The lead's own frame: where its hull points, or (men have no hull) where it walks.
    let hx = w.faceX[lead];
    let hy = w.faceY[lead];
    if (!TURNS[w.kind[lead]]) {
      const vx = w.velX[lead];
      const vy = w.velY[lead];
      const len = isqrt(vx * vx + vy * vy);
      if (len === 0) {
        station.vx = 0;
        station.vy = 0;
        return 1;
      }
      hx = Math.trunc((vx * 1024) / len);
      hy = Math.trunc((vy * 1024) / len);
    }
    px += Math.trunc((hx * w.offA[i] - hy * w.offB[i]) / 1024);
    py += Math.trunc((hy * w.offA[i] + hx * w.offB[i]) / 1024);
  }
  if (px < 0) px = 0;
  else if (px >= MAP_SIZE_FX) px = MAP_SIZE_FX - 1;
  if (py < 0) py = 0;
  else if (py >= MAP_SIZE_FX) py = MAP_SIZE_FX - 1;
  const dx = px - x;
  const dy = py - y;
  const dist = isqrt(dx * dx + dy * dy);
  if (dist <= gap) {
    // In file and close enough: wait for the one ahead to draw away.
    station.vx = 0;
    station.vy = 0;
    return 1;
  }
  // Across ground it cannot walk straight over, it goes by the route like everyone else.
  if (!clearLine(w.map, layer, x, y, px, py)) return 0;
  const v = gap > 0 && dist - gap <= CLOSE_UP ? pace : s;
  const go = dist - gap < v ? dist - gap : v;
  station.vx = Math.trunc((dx * go) / dist);
  station.vy = Math.trunc((dy * go) / dist);
  return 1;
}
