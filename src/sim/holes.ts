// Mouseholes (decision 166; Fabio, 2026-11-28: "yes", his urban fantasy). Engineers knock
// holes through the walls between neighbouring buildings, and squads then move from house
// to house inside the block without stepping into the street: how every army that has
// fought through a city since Stalingrad has done it (the IDF called it "walking through
// walls" in Nablus, 2002).
//
// Neighbours: two buildings that share a wall (a party wall, at least a cell of it). Houses
// that stand apart, even across a narrow yard, are not: crossing a yard is crossing open
// ground. A block is the buildings joined by neighbours; it is fixed by the map. Holes are not anyone's: a
// hole the defender knocked lets the attacker through too, once he has a house of it.
//
// A squad already inside a building, ordered into another it can reach through open
// holes (only through houses that are standing, not burning and not held by the enemy),
// goes from house to house: HOP_TICKS a house, firing from each as it passes. Garrison
// block spreads squads over a block, a few to a house, nearest houses first; each walks
// to the nearest house it can then reach its own through holes from.
import { ablaze } from './collapse';
import { CMD_BLOCK, CMD_GARRISON, CMD_MOUSEHOLE, type Command } from './commands';
import { MAP_CELLS, S_BUILDING, type GameMap } from './map';
import { enterBuilding, hasRoom, structDist2, validUnits } from './sim';
import { kindOf } from './factions';
import { GARRISON_MAX } from './units';
import {
  EV_HOLE,
  FLAG_GARRISON,
  FLAG_MOVING,
  JOB_HOLE,
  JOB_NONE,
  MAX_HOLES,
  STATE_ALIVE,
  TICK_RATE,
  type World,
} from './world';

/** Ticks for one engineer squad to knock one hole through: a charge and the clearing up. */
export const HOLE_TICKS = 8 * TICK_RATE;
/** Ticks for a squad to get from one house into the next through a hole. */
export const HOP_TICKS = 3 * TICK_RATE;
/** Garrison block puts this many squads in each house before it fills any. */
const BLOCK_FIRST = 3;

/** The neighbours of every building of a map, fixed when the map is made. */
export interface HoleNet {
  /** Buildings looked at (structures added later, base buildings, have no neighbours). */
  count: number;
  /** Per building: its entries in `nb` and `pair`, from start[s] to start[s + 1]. */
  start: Int32Array;
  nb: Int16Array;
  pair: Int16Array;
  /** Per pair: its two buildings, and the middle of the wall it goes through (cells). */
  pa: Int16Array;
  pb: Int16Array;
  /** Twice the cell coordinates of the hole, so a half cell is exact. */
  px2: Int16Array;
  py2: Int16Array;
  /** Per pair: 1 if the two stand one above the other (the wall runs along x), and the gap. */
  axis: Uint8Array;
  gap: Uint8Array;
  pairCount: number;
  /** Per building: its block (the lowest building in it), or -1 for a building alone. */
  block: Int16Array;
}

const nets = new WeakMap<GameMap, HoleNet>();

/**
 * Do buildings a and b share a wall? Returns the hole's place (twice its cell coordinates),
 * which way the wall runs, and the gap (always 0), or null.
 */
function facing(map: GameMap, a: number, b: number): [number, number, number, number] | null {
  const ax0 = map.sX[a];
  const ay0 = map.sY[a];
  const ax1 = ax0 + map.sW[a];
  const ay1 = ay0 + map.sH[a];
  const bx0 = map.sX[b];
  const by0 = map.sY[b];
  const bx1 = bx0 + map.sW[b];
  const by1 = by0 + map.sH[b];
  const gx = Math.max(bx0 - ax1, ax0 - bx1);
  const gy = Math.max(by0 - ay1, ay0 - by1);
  if (gx < 0 && gy === 0) {
    // One above the other: the overlap along x, the gap along y.
    const lo = Math.max(ax0, bx0);
    const hi = Math.min(ax1, bx1);
    const y = ay1 <= by0 ? ay1 : by1;
    return [lo + hi, 2 * y + gy, 1, gy];
  }
  if (gy < 0 && gx === 0) {
    const lo = Math.max(ay0, by0);
    const hi = Math.min(ay1, by1);
    const x = ax1 <= bx0 ? ax1 : bx1;
    return [2 * x + gx, lo + hi, 0, gx];
  }
  return null;
}

/** The neighbours and blocks of `map`'s buildings (worked out once per map). */
export function holeNet(map: GameMap): HoleNet {
  const known = nets.get(map);
  if (known) return known;
  const n = map.structCount;
  const houses: number[] = [];
  for (let s = 0; s < n; s++) if (map.sKind[s] === S_BUILDING) houses.push(s);
  // Buckets of 16 cells, so that only buildings near each other are compared.
  const B = 16;
  const side = MAP_CELLS / B;
  const bucket = new Map<number, number[]>();
  for (const s of houses) {
    const k = Math.trunc(map.sY[s] / B) * side + Math.trunc(map.sX[s] / B);
    const list = bucket.get(k);
    if (list) list.push(s);
    else bucket.set(k, [s]);
  }
  const pairs: [number, number, number, number, number, number][] = [];
  for (const a of houses) {
    const bx = Math.trunc(map.sX[a] / B);
    const by = Math.trunc(map.sY[a] / B);
    const near: number[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = bx + dx;
        const y = by + dy;
        if (x < 0 || y < 0 || x >= side || y >= side) continue;
        for (const b of bucket.get(y * side + x) ?? []) if (b > a) near.push(b);
      }
    }
    near.sort((p, q) => p - q);
    for (const b of near) {
      if (pairs.length >= MAX_HOLES) break;
      const at = facing(map, a, b);
      if (at) pairs.push([a, b, ...at]);
    }
  }
  const deg = new Int32Array(n + 1);
  for (const [a, b] of pairs) {
    deg[a]++;
    deg[b]++;
  }
  const start = new Int32Array(n + 1);
  for (let s = 0; s < n; s++) start[s + 1] = start[s] + deg[s];
  const fill = start.slice(0, n);
  const nb = new Int16Array(2 * pairs.length);
  const pair = new Int16Array(2 * pairs.length);
  const pc = pairs.length;
  const pa = new Int16Array(pc);
  const pb = new Int16Array(pc);
  const px2 = new Int16Array(pc);
  const py2 = new Int16Array(pc);
  const axis = new Uint8Array(pc);
  const gap = new Uint8Array(pc);
  pairs.forEach(([a, b, x2, y2, ax, g], p) => {
    axis[p] = ax;
    gap[p] = g;
    pa[p] = a;
    pb[p] = b;
    px2[p] = x2;
    py2[p] = y2;
    nb[fill[a]] = b;
    pair[fill[a]++] = p;
    nb[fill[b]] = a;
    pair[fill[b]++] = p;
  });
  // Blocks: each named by its lowest building.
  const block = new Int16Array(n).fill(-1);
  for (const s of houses) {
    if (block[s] >= 0 || start[s + 1] === start[s]) continue;
    const queue = [s];
    block[s] = s;
    for (let q = 0; q < queue.length; q++) {
      const c = queue[q];
      for (let k = start[c]; k < start[c + 1]; k++) {
        if (block[nb[k]] < 0) {
          block[nb[k]] = s;
          queue.push(nb[k]);
        }
      }
    }
  }
  const net: HoleNet = {
    count: n,
    start,
    nb,
    pair,
    pa,
    pb,
    px2,
    py2,
    axis,
    gap,
    pairCount: pc,
    block,
  };
  nets.set(map, net);
  return net;
}

/** Can a squad of `team` pass through building `s` on its way through the holes? */
function passable(w: World, s: number, team: number): boolean {
  return w.sHp[s] > 0 && !ablaze(w, s) && (w.sOcc[s] === 0 || w.sOccTeam[s] === team);
}

const seen = new Int32Array(1 << 16);
const via = new Int16Array(1 << 16);
let stamp = 0;

/**
 * The house a squad of `team` in building `from` should go into next to get to `to`
 * through open holes, or -1 if there is no way. Breadth first, in the map's fixed order
 * of neighbours, so the same on every machine.
 */
export function nextHop(w: World, from: number, to: number, team: number): number {
  const net = holeNet(w.map);
  if (from === to || from >= net.count || to >= net.count) return -1;
  if (net.block[from] < 0 || net.block[from] !== net.block[to]) return -1;
  if (!passable(w, to, team)) return -1;
  stamp++;
  seen[from] = stamp;
  via[from] = -1;
  const queue = [from];
  for (let q = 0; q < queue.length; q++) {
    const c = queue[q];
    for (let k = net.start[c]; k < net.start[c + 1]; k++) {
      const d = net.nb[k];
      if (seen[d] === stamp || w.holes[net.pair[k]] === 0) continue;
      if (!passable(w, d, team)) continue;
      seen[d] = stamp;
      via[d] = c === from ? d : via[c];
      if (d === to) return via[d];
      queue.push(d);
    }
  }
  return -1;
}

/** The buildings `from` reaches through open holes for `team`, itself first, nearest first. */
export function holedTo(w: World, from: number, team: number): number[] {
  const net = holeNet(w.map);
  const out = [from];
  if (from >= net.count) return out;
  stamp++;
  seen[from] = stamp;
  for (let q = 0; q < out.length; q++) {
    const c = out[q];
    for (let k = net.start[c]; k < net.start[c + 1]; k++) {
      const d = net.nb[k];
      if (seen[d] === stamp || w.holes[net.pair[k]] === 0 || !passable(w, d, team)) continue;
      seen[d] = stamp;
      out.push(d);
    }
  }
  return out;
}

/** The buildings of the block `s` stands in, `s` first and then outwards from it. */
export function blockOf(map: GameMap, s: number): number[] {
  const net = holeNet(map);
  const out = [s];
  if (s >= net.count || net.block[s] < 0) return out;
  stamp++;
  seen[s] = stamp;
  for (let q = 0; q < out.length; q++) {
    const c = out[q];
    for (let k = net.start[c]; k < net.start[c + 1]; k++) {
      if (seen[net.nb[k]] === stamp) continue;
      seen[net.nb[k]] = stamp;
      out.push(net.nb[k]);
    }
  }
  return out;
}

/** Is there an open hole between buildings a and b? */
export function holeBetween(w: World, a: number, b: number): boolean {
  const net = holeNet(w.map);
  if (a >= net.count) return false;
  for (let k = net.start[a]; k < net.start[a + 1]; k++) {
    if (net.nb[k] === b) return w.holes[net.pair[k]] !== 0;
  }
  return false;
}

/**
 * Squad `i`, inside a building, is ordered into `to`: if it can get there through the
 * holes, it sets off from house to house and this returns true.
 */
export function startHop(w: World, i: number, to: number): boolean {
  const from = w.inside[i];
  if (from < 0 || from === to) return false;
  if (nextHop(w, from, to, w.team[i]) < 0) return false;
  w.hopTo[i] = to;
  w.hopAt[i] = w.tick + HOP_TICKS;
  w.flags[i] &= ~FLAG_MOVING;
  return true;
}

/** Engineers of `team` may knock through into `s`: it stands, and the enemy is not in it. */
function mayKnock(w: World, s: number, team: number): boolean {
  return w.sHp[s] > 0 && (w.sOcc[s] === 0 || w.sOccTeam[s] === team);
}

/** The first wall of building `s` that engineers of `team` could knock through, or -1. */
export function closedPair(w: World, s: number, team: number): number {
  const net = holeNet(w.map);
  if (s >= net.count) return -1;
  for (let k = net.start[s]; k < net.start[s + 1]; k++) {
    if (w.holes[net.pair[k]] === 0 && mayKnock(w, net.nb[k], team)) return net.pair[k];
  }
  return -1;
}

/** Does the block of `s` have a wall left that `team`'s engineers could knock through? */
export function blockHasWork(w: World, s: number, team: number): boolean {
  for (const b of blockOf(w.map, s)) if (w.sHp[b] > 0 && closedPair(w, b, team) >= 0) return true;
  return false;
}

function openHole(w: World, p: number): void {
  const net = holeNet(w.map);
  if (w.holes[p] !== 0) return;
  w.holes[p] = 1;
  w.holeCount++;
  w.events.push(EV_HOLE, net.pa[p], net.pb[p]);
}

/** Room left in `s` for `team`'s squads, counting those already sent there. */
function roomLeft(w: World, s: number, cap: number, sent: Int32Array): number {
  const map = w.map;
  const full = Math.min(GARRISON_MAX, (map.sW[s] * map.sH[s] * 2) >> 1);
  return Math.min(cap, full) - w.sOcc[s] - sent[s];
}

/** The commands of this module. True if it was one of them. */
export function applyHoleCommand(
  w: World,
  cmd: Command,
  apply: (w: World, cmd: Command) => void,
): boolean {
  if (cmd.type !== CMD_MOUSEHOLE && cmd.type !== CMD_BLOCK) return false;
  const map = w.map;
  const st = cmd.structure;
  if (!Number.isInteger(st) || st < 0 || st >= map.structCount) return true;
  if (map.sKind[st] !== S_BUILDING || w.sHp[st] <= 0) return true;
  const units = validUnits(w, cmd.units).filter((id) => kindOf(w, id).garrison);
  if (units.length === 0) return true;
  if (cmd.type === CMD_MOUSEHOLE) {
    const crew = units.filter((id) => kindOf(w, id).engineer);
    if (crew.length === 0) return true;
    const walk = crew.filter((id) => w.inside[id] !== st && !startHop(w, id, st));
    if (walk.length > 0) apply(w, { type: CMD_GARRISON, units: walk, structure: st });
    for (const id of crew) {
      w.job[id] = JOB_HOLE;
      w.jobStruct[id] = st;
      w.jobTimer[id] = 0;
    }
    return true;
  }
  // Garrison block: the houses outwards from the one clicked, a few squads to each first.
  const team = w.team[units[0]];
  const houses = blockOf(map, st).filter(
    (s) => w.sHp[s] > 0 && !ablaze(w, s) && (w.sOcc[s] === 0 || w.sOccTeam[s] === team),
  );
  const sent = new Int32Array(map.structCount);
  const mine = units.filter((id) => w.team[id] === team);
  // Squads already in a house of the block stay where they are.
  const inBlock = new Set(houses);
  const left = mine.filter((id) => !inBlock.has(w.inside[id]));
  const goes = new Map<number, number>();
  for (const cap of [BLOCK_FIRST, GARRISON_MAX]) {
    for (const s of houses) {
      while (goes.size < left.length && roomLeft(w, s, cap, sent) > 0) {
        goes.set(left[goes.size], s);
        sent[s]++;
      }
    }
  }
  const byEntry = new Map<number, number[]>();
  const then: [number, number][] = [];
  for (const [id, s] of goes) {
    if (startHop(w, id, s)) continue;
    // In by the house nearest it from which the holes lead on to its own.
    let entry = s;
    let best = structDist2(w, s, w.posX[id], w.posY[id]);
    for (const e of holedTo(w, s, team)) {
      const d = structDist2(w, e, w.posX[id], w.posY[id]);
      if (d < best) {
        best = d;
        entry = e;
      }
    }
    const list = byEntry.get(entry);
    if (list) list.push(id);
    else byEntry.set(entry, [id]);
    if (entry !== s) then.push([id, s]);
  }
  for (const [structure, list] of byEntry) apply(w, { type: CMD_GARRISON, units: list, structure });
  for (const [id, s] of then) {
    if ((w.flags[id] & FLAG_GARRISON) === 0) continue;
    w.hopTo[id] = s;
    w.hopAt[id] = 0;
  }
  return true;
}

/** One tick of squads going from house to house, and of engineers knocking through. */
export function updateHoles(w: World): void {
  const n = w.count;
  const tick = w.tick;
  const net = w.holeCount > 0 || anyHoleWork(w) ? holeNet(w.map) : null;
  if (net === null) return;
  for (let i = 0; i < n; i++) {
    const to = w.hopTo[i];
    if (to >= 0) {
      if (w.state[i] !== STATE_ALIVE) {
        w.hopTo[i] = -1;
        continue;
      }
      const at = w.inside[i];
      if (at < 0) {
        // On its way to the house it goes in by; given up when that order is.
        if ((w.flags[i] & FLAG_GARRISON) === 0) w.hopTo[i] = -1;
        continue;
      }
      if (at === to) {
        w.hopTo[i] = -1;
        continue;
      }
      if (w.hopAt[i] === 0) w.hopAt[i] = tick + HOP_TICKS;
      if (tick < w.hopAt[i]) continue;
      const team = w.team[i];
      const next = nextHop(w, at, to, team);
      if (next < 0 || (next === to && !hasRoom(w, to, team))) {
        // The way is cut, or the house is full: it stays where it is.
        w.hopTo[i] = -1;
        continue;
      }
      const roof = w.roof[i];
      w.sOcc[at]--;
      enterBuilding(w, i, next);
      // Up on the roof it stays up as it goes: only for the last house.
      w.roof[i] = next === to ? roof : 0;
      w.hopAt[i] = tick + HOP_TICKS;
      if (next === to) w.hopTo[i] = -1;
      continue;
    }
    if (w.job[i] !== JOB_HOLE) continue;
    if (w.state[i] !== STATE_ALIVE) {
      w.job[i] = JOB_NONE;
      continue;
    }
    const s = w.inside[i];
    const team = w.team[i];
    if (s < 0) {
      // Still walking there; stopped short (shot at, full house), the job is off.
      if ((w.flags[i] & (FLAG_GARRISON | FLAG_MOVING)) === 0) w.job[i] = JOB_NONE;
      continue;
    }
    const p = closedPair(w, s, team);
    if (p >= 0) {
      if (++w.jobTimer[i] >= HOLE_TICKS) {
        w.jobTimer[i] = 0;
        openHole(w, p);
      }
      continue;
    }
    w.jobTimer[i] = 0;
    // Nothing left to knock through from here: on to a house of the block that has.
    let next = -1;
    for (const b of holedTo(w, s, team)) {
      if (b !== s && closedPair(w, b, team) >= 0) {
        next = b;
        break;
      }
    }
    if (next < 0 || !startHop(w, i, next)) w.job[i] = JOB_NONE;
  }
}

/** Is any engineer at the job? Checked only while there is no hole on the map yet. */
function anyHoleWork(w: World): boolean {
  for (let i = 0; i < w.count; i++) if (w.job[i] === JOB_HOLE || w.hopTo[i] >= 0) return true;
  return false;
}

/** The holes knocked through so far, by pair (for the screen). */
export function openHoles(w: World): number[] {
  const out: number[] = [];
  if (w.holeCount === 0) return out;
  const pc = holeNet(w.map).pairCount;
  for (let p = 0; p < pc; p++) if (w.holes[p] !== 0) out.push(p);
  return out;
}

/**
 * Does `team` hold a house with an open hole into building `s`? Then an assault on `s`
 * comes in through the wall as well as the door, and the defender loses his edge as he
 * does to a breach (URBAN.md 4.5).
 */
export function holedInto(w: World, s: number, team: number): boolean {
  if (w.holeCount === 0) return false;
  const net = holeNet(w.map);
  if (s >= net.count) return false;
  for (let k = net.start[s]; k < net.start[s + 1]; k++) {
    const d = net.nb[k];
    if (w.holes[net.pair[k]] !== 0 && w.sOcc[d] > 0 && w.sOccTeam[d] === team) return true;
  }
  return false;
}
