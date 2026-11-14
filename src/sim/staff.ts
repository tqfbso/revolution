// The staff of the player's sub-commanders. Each commander has troops and a mission (both
// are game state, see commanders.ts); the staff works out what the troops do about it and
// hands in ordinary commands before each tick, exactly like a computer player. It is built
// from the computer player's own parts (src/sim/ai.ts): the same eyes and memory of the
// enemy, the same march that keeps a body together, the same assault with smoke, breaching
// and shelled strong points, the same rules for breaking off, the same billeting of
// infantry in houses. What differs is who decides the objective: here, the player.
//
// Deterministic like the rest of the sim: integer maths, no clocks, no Math.random. Two
// machines that run the same world run the same staff, which is what co-op will need.
import {
  DISMOUNT,
  FOOT,
  F_ASSAULT,
  F_IDLE,
  F_MARCH,
  F_RETREAT,
  LINE,
  MINUTE,
  OBJ_POINT,
  OBJ_TOWN,
  POWER,
  billet,
  billetStart,
  centre,
  createAi,
  dist,
  expect,
  follow,
  ceaseFire,
  ground,
  marchOrders,
  mount,
  newForce,
  order,
  perceive,
  press,
  setUp,
  strength,
  strongPoints,
  structX,
  structY,
  type Ai,
  type Force,
  type Objective,
} from './ai';
import {
  CMD_ATTACK_MOVE,
  CMD_BOMBARD,
  CMD_ENTRENCH,
  CMD_MOVE,
  CMD_UNLOAD,
  type Command,
} from './commands';
import { B_HQ } from './economy';
import { clampInt, fx } from './fixed';
import { CLASS_AIR, S_BUILDING, cellOfPos, wallMax } from './map';
import { structDist2 } from './sim';
import { fortified } from './urban';
import { KINDS, KIND_ARTILLERY } from './units';
import {
  FLAG_BOMBARD,
  FLAG_MOVING,
  JOB_NONE,
  MAP_SIZE_FX,
  MAX_COMMANDERS,
  MAX_UNITS,
  M_ATTACK,
  M_DEFEND,
  M_HOLD,
  M_MOVE,
  M_NONE,
  M_PATROL,
  M_SCREEN,
  NO_TARGET,
  STATE_ALIVE,
  TICK_RATE,
  type World,
} from './world';

/** What a commander reports it is doing. */
export const ST_IDLE = 0;
export const ST_MARCH = 1;
export const ST_ATTACK = 2;
export const ST_SECURED = 3;
export const ST_HOLD = 4;
export const ST_DEFEND = 5;
export const ST_PATROL = 6;
export const ST_SCREEN = 7;
export const ST_FALLBACK = 8;
export const ST_REGROUP = 9;
export const ST_GATHER = 10;
export const ST_MOVE = 11;
export const ST_ARRIVED = 12;

/** Ticks between two thinks: once a second, like the hard computer player. */
const PERIOD = 20;
/** Break off below this share of the strength it had (per cent), or against these odds (tenths). */
const BREAK_OFF = 45;
const ODDS = 11;
/** A commander that fell back attacks again when it is back to this share of its strength. */
const RALLIED = 75;
/** It asks for reinforcements below this share. */
const WEAK = 60;
/**
 * An attack waits short of its objective until this share of its line has closed up (per
 * cent), but no longer than GATHER_WAIT once half of it is there, and not at all under fire.
 */
const GATHERED = 70;
const GATHER_WAIT = 20 * TICK_RATE;
/** The same wait when troops that were given to it elsewhere are still on their way to that place. */
const JOIN_WAIT = 45 * TICK_RATE;
/**
 * How far out of the objective an attack closes up: past the edge of the town (or the
 * point) by more than anything in it sees (a tank's 44) or shoots (40). It used to be 60
 * from the middle, which in a town is among the houses: the body stood waiting for its
 * stragglers in the enemy's sights.
 */
const STAND_OFF = fx(75);
/** No known enemy this close to the place where it closes up, or it closes up further back. */
const STAND_CLEAR = fx(60);
/** A march that is close to its way point but cannot get half its line onto it moves on after this. */
const MARCH_WAIT = 30 * TICK_RATE;

/** One commander, as its staff sees it. */
export interface Post {
  f: Force;
  /** The mission counter (World.cSeq) its plan was made for; -1 = make a new one. */
  seq: number;
  status: number;
  /** The body, the newly assigned, and those still on their way to the body. */
  units: number[];
  fresh: number[];
  joining: number[];
  /** Strength and heads riding in its carriers. */
  aboard: number;
  riders: number;
  power: number;
  count: number;
  cx: number;
  cy: number;
  /** Where it falls back to. */
  backX: number;
  backY: number;
  need: boolean;
  fighting: boolean;
  /** It has fallen back and is waiting to be fit to go again. */
  regroup: boolean;
  /** The tick at which half of an attack had closed up short of the objective, or -1. */
  gather: number;
  /** Houses its infantry holds at the objective, the nearest first. */
  houses: number[];
  /** New orders this think: those on their way to the body turn round at once. */
  turn: boolean;
}

export interface Staff {
  team: number;
  ai: Ai;
  posts: Post[];
  /** Per unit: the commander whose body it has joined, or -1. */
  body: Int8Array;
  /** Per commander: the mission counter (World.cSeq) the staff last acted on. */
  heard: Int32Array;
}

export function createStaff(team: number, seed = 1): Staff {
  const posts: Post[] = [];
  for (let c = 0; c < MAX_COMMANDERS; c++) {
    posts.push({
      f: newForce(0),
      seq: -1,
      status: ST_IDLE,
      units: [],
      fresh: [],
      joining: [],
      aboard: 0,
      riders: 0,
      power: 0,
      count: 0,
      cx: 0,
      cy: 0,
      backX: 0,
      backY: 0,
      need: false,
      fighting: false,
      regroup: false,
      gather: -1,
      houses: [],
      turn: false,
    });
  }
  return {
    team,
    ai: createAi(team, 'hard', seed),
    posts,
    body: new Int8Array(MAX_UNITS).fill(-1),
    heard: new Int32Array(MAX_COMMANDERS),
  };
}

/** The staff's commands for this tick, appended to `out`. Call once per tick, before step(). */
export function staffThink(st: Staff, w: World, out: Command[]): void {
  // A commander with new orders does not wait for the staff's next think (up to a second
  // away): its staff sits down the tick the order arrives, for that commander alone.
  const due = (w.tick + 3 * st.team) % PERIOD === 0;
  let told = 0;
  for (let c = 0; c < MAX_COMMANDERS; c++) {
    if (st.heard[c] !== w.cSeq[st.team * MAX_COMMANDERS + c]) told |= 1 << c;
  }
  if (!due && told === 0) return;
  const ai = st.ai;
  if (!ai.ready && !setUp(ai, w)) return;
  let any = false;
  for (const p of st.posts) {
    p.units.length = 0;
    p.fresh.length = 0;
    p.joining.length = 0;
    p.aboard = 0;
    p.riders = 0;
  }
  for (let i = 0; i < w.count; i++) {
    const c = w.state[i] === STATE_ALIVE && w.team[i] === st.team ? w.cmdr[i] : -1;
    if (c < 0) {
      st.body[i] = -1;
      continue;
    }
    any = true;
    const p = st.posts[c];
    if (w.carrier[i] >= 0) {
      p.aboard += Math.trunc((POWER[w.kind[i]] * w.hp[i]) / KINDS[w.kind[i]].hp);
      p.riders++;
    } else if (st.body[i] === c) p.units.push(i);
    else p.fresh.push(i);
  }
  if (!any) {
    for (const p of st.posts) stoodDown(p);
    return;
  }
  perceive(ai, w);
  for (let c = 0; c < MAX_COMMANDERS; c++) {
    st.heard[c] = w.cSeq[st.team * MAX_COMMANDERS + c];
    if (due || (told & (1 << c)) !== 0) run(st, w, out, c);
  }
}

function stoodDown(p: Post): void {
  p.status = ST_IDLE;
  p.power = 0;
  p.count = 0;
  p.need = false;
  p.fighting = false;
  p.seq = -1;
}

function run(st: Staff, w: World, out: Command[], c: number): void {
  const ai = st.ai;
  const p = st.posts[c];
  const f = p.f;
  const units = p.units;
  const k = st.team * MAX_COMMANDERS + c;
  // The newly assigned: a commander without troops takes them as they stand; one in the
  // field counts them in when they have caught up with it.
  if (units.length === 0) {
    for (const i of p.fresh) st.body[i] = c;
    units.push(...p.fresh);
  } else if (p.fresh.length > 0) {
    const [bx, by] = centre(w, units);
    for (const i of p.fresh) {
      if (dist(w.posX[i], w.posY[i], bx, by) < fx(50)) {
        st.body[i] = c;
        units.push(i);
      } else p.joining.push(i);
    }
    units.sort((a, b) => a - b);
  }
  const mission = w.cMission[k];
  // A new mission for troops that stand all over the map: the largest lot of them is the
  // body, the others make their own way to where it is going (see `rally`).
  if (p.seq !== w.cSeq[k] && mission !== M_NONE && mission !== M_MOVE && mission !== M_SCREEN)
    core(st, w, p);
  p.count = units.length + p.joining.length + p.riders;
  if (units.length === 0) {
    stoodDown(p);
    p.count = p.riders;
    return;
  }
  const power = strength(w, units) + p.aboard;
  const [cx, cy] = centre(w, units);
  p.power = power;
  p.cx = cx;
  p.cy = cy;
  if (p.seq !== w.cSeq[k]) begin(st, w, out, c, power, cx, cy);
  if (power > f.launch) f.launch = power;
  p.need = power * 100 < f.launch * WEAK;
  p.fighting = false;
  for (const i of units) if (w.attack[i] !== NO_TARGET) p.fighting = true;
  rally(st, w, out, c, cx, cy);
  // The computer player's parts take "behind" to be toward its staging area: for this
  // commander, that is the place it falls back to.
  ai.stageX = p.backX;
  ai.stageY = p.backY;
  const tx = w.cX[k];
  const ty = w.cY[k];
  if (mission === M_NONE) {
    p.status = ST_IDLE;
  } else if (mission === M_MOVE) {
    move(w, out, p, tx, ty);
  } else if (f.state === F_RETREAT) {
    fallingBack(w, out, p);
  } else if (p.regroup) {
    regrouping(st, w, out, c, power, cx, cy);
  } else if (f.state === F_MARCH) {
    p.status = mission === M_PATROL ? ST_PATROL : ST_MARCH;
    // Whoever is told to hold a place goes there, whatever is in the way.
    if (mission !== M_HOLD && beaten(ai, w, f, power, cx, cy)) breakOff(ai, w, out, p, cx, cy);
    else if (march(ai, w, out, p, cx, cy, mission === M_PATROL, mission === M_ATTACK)) {
      f.state = F_ASSAULT;
      f.quiet = 0;
    }
  } else if (mission === M_ATTACK) {
    attack(ai, w, out, p, power, cx, cy);
  } else if (mission === M_HOLD) {
    p.status = ST_HOLD;
    station(ai, w, out, p, tx, ty, cx, cy);
  } else if (mission === M_DEFEND) {
    defend(ai, w, out, p, power, cx, cy);
  } else if (mission === M_SCREEN) {
    p.status = ST_SCREEN;
    if (expect(ai, w, cx, cy, 3, 0) > power) breakOff(ai, w, out, p, cx, cy);
    else pickets(ai, w, out, units, tx, ty);
  }
  unload(ai, w, out, p);
}

/**
 * Troops given to a commander from several parts of the map used to form up first at the
 * middle of where they all stood: those already at the objective walked back from it, and
 * the guns and drones made for an empty field. Instead the largest lot that stands
 * together is the body and the plan is made for it; everyone else is "joining" and goes
 * straight to where the body is going.
 */
function core(st: Staff, w: World, p: Post): void {
  const units = p.units;
  if (units.length < 2) return;
  const [cx, cy] = centre(w, units);
  if (!scattered(w, units, cx, cy)) return;
  // The unit with the most of the line around it (its own kind of troops, if it has none).
  const line = units.filter((i) => LINE[w.kind[i]]);
  const pool = line.length > 0 ? line : units;
  const stride = Math.ceil(pool.length / 150);
  let seed = pool[0];
  let most = -1;
  for (let a = 0; a < pool.length; a += stride) {
    const i = pool[a];
    let n = 0;
    for (const j of pool) if (dist(w.posX[i], w.posY[i], w.posX[j], w.posY[j]) < fx(45)) n++;
    if (n > most) {
      most = n;
      seed = i;
    }
  }
  const sx = w.posX[seed];
  const sy = w.posY[seed];
  const keep: number[] = [];
  for (const i of units) {
    if (dist(w.posX[i], w.posY[i], sx, sy) < fx(50)) keep.push(i);
    else {
      st.body[i] = -1;
      p.joining.push(i);
    }
  }
  units.length = 0;
  units.push(...keep);
}

/**
 * Those on their way to the body go where the body is going, not to where it is: the next
 * point of its march, the place it holds or attacks, the place it has fallen back to.
 * Whoever is already there stays there. They are counted into the body when it comes up
 * (see `run`), or when they stand at the place and it is close by.
 */
function rally(st: Staff, w: World, out: Command[], c: number, cx: number, cy: number): void {
  const p = st.posts[c];
  const f = p.f;
  const turn = p.turn;
  p.turn = false;
  if (p.joining.length === 0) return;
  const k = st.team * MAX_COMMANDERS + c;
  const mission = w.cMission[k];
  let x = cx;
  let y = cy;
  // Whoever is nearer the objective than that place stays where he is until the body
  // goes in: troops already there are not marched out again to come back with it.
  let ox = 0;
  let oy = 0;
  let inner = 0;
  if (mission === M_MOVE) {
    x = w.cX[k];
    y = w.cY[k];
  } else if (mission === M_NONE || mission === M_SCREEN) {
    // No place to go to (a screen is a line, each man to his own spot): to the body.
  } else if (f.state === F_RETREAT || p.regroup) {
    x = p.backX;
    y = p.backY;
  } else if (f.state === F_MARCH && f.wps.length > 0) {
    // The end of the march (a patrol has none: its next point). For an attack that is
    // where it closes up, outside the objective.
    const at = mission === M_PATROL ? 2 * f.wp : f.wps.length - 2;
    x = f.wps[at];
    y = f.wps[at + 1];
    if (f.obj) {
      ox = f.obj.x;
      oy = f.obj.y;
      inner = dist(x, y, ox, oy) + fx(20);
    }
  } else if (f.obj) {
    x = f.obj.x;
    y = f.obj.y;
  }
  const near = dist(cx, cy, x, y) < fx(120);
  const go: number[] = [];
  for (const i of p.joining) {
    const d = dist(w.posX[i], w.posY[i], x, y);
    if (d < fx(45) && near) st.body[i] = c;
    else if (inner > 0 && dist(w.posX[i], w.posY[i], ox, oy) < inner) continue;
    else if (
      d > fx(30) &&
      // Under new orders even those on the move turn round: they were going somewhere else.
      (turn || ((w.flags[i] & FLAG_MOVING) === 0 && w.attack[i] === NO_TARGET))
    )
      go.push(i);
  }
  order(out, mission === M_MOVE ? CMD_MOVE : CMD_ATTACK_MOVE, go, x, y);
}

/** A new mission (or new troops for a commander that had none): make the plan. */
function begin(
  st: Staff,
  w: World,
  out: Command[],
  c: number,
  power: number,
  cx: number,
  cy: number,
): void {
  const ai = st.ai;
  const map = w.map;
  const p = st.posts[c];
  const f = p.f;
  const units = p.units;
  const k = st.team * MAX_COMMANDERS + c;
  const mission = w.cMission[k];
  const tx = w.cX[k];
  const ty = w.cY[k];
  p.seq = w.cSeq[k];
  p.turn = true;
  // Guns still shelling a house for the last mission are not left at it.
  ceaseFire(w, out, units, -1, true);
  p.regroup = false;
  p.gather = -1;
  f.launch = power;
  f.since = w.tick;
  f.quiet = 0;
  f.smoked = false;
  f.turned = false;
  f.wp = 0;
  f.wps = [];
  f.boardUntil = 0;
  f.state = F_IDLE;
  f.obj = objectiveAt(w, tx, ty);
  [p.backX, p.backY] = anchor(ai, w, cx, cy, tx, ty);
  p.houses = housesAt(ai, w, f.obj);
  if (mission === M_NONE) return;
  if (mission === M_SCREEN) {
    f.state = F_ASSAULT;
    return;
  }
  if (mission === M_MOVE) {
    // The place itself, not the town it may be in; everyone at once, by plain move orders,
    // which do not stop to fight. Squads in houses come out, squads in carriers ride.
    f.obj = { kind: OBJ_POINT, id: -1, x: tx, y: ty };
    f.state = F_MARCH;
    order(out, CMD_MOVE, units.slice(), ...ground(map, tx, ty));
    return;
  }
  const d = dist(cx, cy, tx, ty);
  if (mission === M_PATROL) {
    f.wps.push(...ground(map, tx, ty), ...ground(map, w.cAX[k], w.cAY[k]));
  } else {
    // Scattered troops form up first; an attack then closes up once more short of the
    // objective, so that it arrives as one body.
    if (d > fx(60) && scattered(w, units, cx, cy)) f.wps.push(...ground(map, cx, cy));
    if (mission === M_ATTACK) {
      // Close up out of the enemy's sight and reach, on the side it comes from; further
      // back still if the enemy is known to stand there. From too near to do that, it
      // goes straight in.
      const od = dist(cx, cy, f.obj.x, f.obj.y);
      let stand = (f.obj.kind === OBJ_TOWN ? map.townR[f.obj.id] : 0) + STAND_OFF;
      if (od > stand + fx(40)) {
        let sx: number;
        let sy: number;
        for (let tries = 0; ; tries++) {
          sx = f.obj.x + Math.trunc(((cx - f.obj.x) * stand) / od);
          sy = f.obj.y + Math.trunc(((cy - f.obj.y) * stand) / od);
          let clear = true;
          for (const e of ai.seen) {
            if (KINDS[w.kind[e]].cls === CLASS_AIR) continue;
            if (dist(w.posX[e], w.posY[e], sx, sy) < STAND_CLEAR) {
              clear = false;
              break;
            }
          }
          if (clear || tries === 3 || od <= stand + fx(70)) break;
          stand += fx(30);
        }
        f.wps.push(...ground(map, sx, sy));
      }
    } else if (d > fx(50)) f.wps.push(...ground(map, f.obj.x, f.obj.y));
  }
  if (f.wps.length === 0) {
    f.state = F_ASSAULT;
    return;
  }
  f.state = F_MARCH;
  // Nobody walks to a carrier and waits for it to fill under fire: it goes as it stands.
  const contact = units.some((i) => w.attack[i] !== NO_TARGET);
  const busy = d > fx(200) && !contact ? mount(w, out, f, units) : undefined;
  marchOrders(ai, w, out, f, units, true, busy);
  disengage(w, out, units, f.wps[0], f.wps[1], busy);
}

/** How far troops in a fight walk without stopping to shoot when they are ordered elsewhere. */
const BREAK_CONTACT = fx(70);

/**
 * New orders reach troops that are in a fight. On an attack-move they would stand and
 * shoot it out first, which from the player's chair is a commander that does not answer.
 * If any of them is shooting at an enemy that is not on the way to the new place, the line
 * breaks contact: a plain move for the first stretch, after which the march picks it up
 * as usual. Whoever has an enemy between himself and the place fights through, as before.
 */
function disengage(
  w: World,
  out: Command[],
  units: readonly number[],
  tx: number,
  ty: number,
  busy?: Set<number>,
): void {
  const go: number[] = [];
  let sx = 0;
  let sy = 0;
  let behind = 0;
  for (const i of units) {
    if (!LINE[w.kind[i]] || busy?.has(i)) continue;
    const e = w.attack[i];
    const d = dist(w.posX[i], w.posY[i], tx, ty);
    if (d < fx(50)) continue;
    if (e !== NO_TARGET) {
      if (dist(w.posX[e], w.posY[e], tx, ty) < d) continue;
      behind++;
    }
    // Those not shooting this instant go the same way: left on an attack-move they
    // would turn back for the first enemy that shows itself behind them.
    go.push(i);
    sx += w.posX[i];
    sy += w.posY[i];
  }
  if (behind === 0) return;
  if (go.length === 0) return;
  sx = Math.trunc(sx / go.length);
  sy = Math.trunc(sy / go.length);
  const d = dist(sx, sy, tx, ty);
  if (d <= BREAK_CONTACT) {
    order(out, CMD_MOVE, go, tx, ty);
    return;
  }
  const x = sx + Math.trunc(((tx - sx) * BREAK_CONTACT) / d);
  const y = sy + Math.trunc(((ty - sy) * BREAK_CONTACT) / d);
  order(out, CMD_MOVE, go, ...ground(w.map, x, y));
}

/** A point in or at the edge of a town means the town; anything else is just the point. */
function objectiveAt(w: World, x: number, y: number): Objective {
  const map = w.map;
  for (let t = 0; t < map.townCount; t++) {
    if (dist(x, y, map.townX[t], map.townY[t]) < map.townR[t] + fx(15)) {
      return { kind: OBJ_TOWN, id: t, x: map.townX[t], y: map.townY[t] };
    }
  }
  return { kind: OBJ_POINT, id: -1, x, y };
}

function housesAt(ai: Ai, w: World, obj: Objective): number[] {
  if (obj.kind === OBJ_TOWN) return ai.houses[obj.id];
  const map = w.map;
  const list: number[] = [];
  for (let s = 0; s < map.structCount; s++) {
    if (map.sKind[s] !== S_BUILDING) continue;
    if (dist(structX(map, s), structY(map, s), obj.x, obj.y) < fx(55)) list.push(s);
  }
  return list.sort(
    (a, b) =>
      dist(structX(map, a), structY(map, a), obj.x, obj.y) -
        dist(structX(map, b), structY(map, b), obj.x, obj.y) || a - b,
  );
}

/**
 * Where to fall back to: the nearest of the army's towns and its base that is not the
 * objective itself and is not known to have the enemy in it.
 */
function anchor(
  ai: Ai,
  w: World,
  cx: number,
  cy: number,
  tx: number,
  ty: number,
): [number, number] {
  const map = w.map;
  let bx = ai.homeX + ai.fwd * fx(40);
  let by = ai.homeY;
  let best = dist(cx, cy, bx, by);
  for (let t = 0; t < map.townCount; t++) {
    if (w.townOwner[t] !== ai.team) continue;
    const x = map.townX[t];
    const y = map.townY[t];
    if (dist(x, y, tx, ty) < fx(90) || expect(ai, w, x, y, 1, 0) > 20) continue;
    const d = dist(cx, cy, x, y);
    if (d < best) {
      best = d;
      bx = x;
      by = y;
    }
  }
  return ground(map, bx, by);
}

/** Fewer than half of them stand together. */
function scattered(w: World, units: readonly number[], cx: number, cy: number): boolean {
  let near = 0;
  for (const i of units) if (dist(w.posX[i], w.posY[i], cx, cy) < fx(45)) near++;
  return near * 2 < units.length;
}

/** The computer player's rule for breaking off: too little left, or too much in front. */
function beaten(ai: Ai, w: World, f: Force, power: number, cx: number, cy: number): boolean {
  const local = expect(ai, w, cx, cy, 2, 0);
  return (
    power * 100 < f.launch * BREAK_OFF ||
    local > 2 * power + 40 ||
    (local * 10 > power * ODDS && power * 10 < f.launch * 9)
  );
}

/** Break off and fall back, the guns laying smoke between the body and the enemy. */
function breakOff(ai: Ai, w: World, out: Command[], p: Post, cx: number, cy: number): void {
  const f = p.f;
  const units = p.units;
  f.state = F_RETREAT;
  f.since = w.tick;
  p.status = ST_FALLBACK;
  order(out, CMD_MOVE, units.slice(), p.backX, p.backY);
  let foe = -1;
  let foeD = fx(120);
  for (const e of ai.seen) {
    if (KINDS[w.kind[e]].cls === CLASS_AIR) continue;
    const d = dist(w.posX[e], w.posY[e], cx, cy);
    if (d < foeD) {
      foe = e;
      foeD = d;
    }
  }
  const guns = units.filter((i) => w.kind[i] === KIND_ARTILLERY);
  if (foe < 0 || guns.length === 0) return;
  out.push({
    type: CMD_BOMBARD,
    units: guns.slice(0, Math.max(1, guns.length >> 1)),
    x: (cx + w.posX[foe]) >> 1,
    y: (cy + w.posY[foe]) >> 1,
    smoke: true,
  });
}

function fallingBack(w: World, out: Command[], p: Post): void {
  const f = p.f;
  const units = p.units;
  p.status = ST_FALLBACK;
  let home = 0;
  for (const i of units) if (dist(w.posX[i], w.posY[i], p.backX, p.backY) < fx(45)) home++;
  if (home * 10 >= units.length * 6 || w.tick - f.since > 2 * MINUTE) {
    f.state = F_IDLE;
    f.since = w.tick;
    p.regroup = true;
    return;
  }
  // The guns that are laying smoke get their shell off first.
  const smoking = w.tick - f.since < 10 * TICK_RATE;
  const lost = units.filter(
    (i) =>
      (w.flags[i] & FLAG_MOVING) === 0 &&
      !(smoking && (w.flags[i] & FLAG_BOMBARD) !== 0) &&
      dist(w.posX[i], w.posY[i], p.backX, p.backY) > fx(40),
  );
  order(out, CMD_MOVE, lost, p.backX, p.backY);
}

/**
 * Back where it fell back to. An attack goes in again when the commander is back near the
 * strength it had (which takes reinforcements, or a new order); the other missions are
 * taken up again once the place looks like something it can deal with.
 */
function regrouping(
  st: Staff,
  w: World,
  out: Command[],
  c: number,
  power: number,
  cx: number,
  cy: number,
): void {
  const ai = st.ai;
  const p = st.posts[c];
  const f = p.f;
  const k = st.team * MAX_COMMANDERS + c;
  p.status = ST_REGROUP;
  // Strong enough again (an attack only), and the place looks like something it can take
  // on. What it remembers of the enemy there grows stale: after a minute and a half with
  // no enemy in sight around the place, it goes to look.
  const obj = f.obj!;
  const waited = w.tick - f.since;
  let there = expect(ai, w, obj.x, obj.y, 2, 0);
  if (waited > 90 * TICK_RATE) {
    there = 0;
    for (const e of ai.seen) {
      if (dist(w.posX[e], w.posY[e], obj.x, obj.y) < fx(110)) there += POWER[w.kind[e]] + 1;
    }
  }
  const fit =
    waited > 45 * TICK_RATE &&
    (w.cMission[k] === M_ATTACK
      ? power * 100 >= f.launch * RALLIED && there * 10 <= power * ODDS
      : there * 10 < power * 8);
  p.need = true;
  if (fit) {
    begin(st, w, out, c, power, cx, cy);
    return;
  }
  const far = p.units.filter(
    (i) =>
      (w.flags[i] & FLAG_MOVING) === 0 &&
      w.attack[i] === NO_TARGET &&
      dist(w.posX[i], w.posY[i], p.backX, p.backY) > fx(45),
  );
  order(out, CMD_MOVE, far, p.backX, p.backY);
}

/**
 * One think of a march. The body moves on when half of its line has closed up on the way
 * point. True when it has arrived at the last one (a patrol, `loop`, never does). An
 * attack (`gather`) waits at the last one, short of the objective, for its stragglers and
 * for new arrivals that are nearly there, so that it goes in as one body. That place is
 * out of the enemy's sight (see STAND_OFF); it does not wait once it is shot at.
 */
function march(
  ai: Ai,
  w: World,
  out: Command[],
  p: Post,
  cx: number,
  cy: number,
  loop: boolean,
  gather = false,
): boolean {
  const f = p.f;
  const units = p.units;
  const tx = f.wps[2 * f.wp];
  const ty = f.wps[2 * f.wp + 1];
  const last = 2 * (f.wp + 1) >= f.wps.length;
  let line = 0;
  let there = 0;
  for (let pass = 0; pass < 2 && line === 0; pass++) {
    for (const i of units) {
      if (pass === 0 && !LINE[w.kind[i]]) continue;
      line++;
      if (dist(w.posX[i], w.posY[i], tx, ty) < fx(38)) there++;
    }
  }
  const waited = w.tick - f.since;
  const close = dist(cx, cy, tx, ty) < fx(55);
  const half = there * 2 >= line;
  if (gather && last && !loop && waited <= 5 * MINUTE) {
    // A large body does not fit in the small circle that counts as "there".
    const room = fx(45) + Math.trunc(Math.sqrt(units.length)) * fx(1);
    let all = 0;
    let up = 0;
    for (const i of units) {
      if (!LINE[w.kind[i]]) continue;
      all++;
      if (dist(w.posX[i], w.posY[i], tx, ty) < room) up++;
    }
    // Those making their own way here count too, and are given a little longer.
    let coming = 0;
    for (const i of p.joining) {
      if (LINE[w.kind[i]] && dist(w.posX[i], w.posY[i], tx, ty) < fx(300)) coming++;
    }
    all += coming;
    if (half && p.gather < 0) p.gather = w.tick;
    const held = p.gather >= 0 ? w.tick - p.gather : 0;
    const limit = coming > 0 ? JOIN_WAIT : GATHER_WAIT;
    if (all > 0 && up * 100 < all * GATHERED && !p.fighting && held <= limit) {
      if (half) p.status = ST_GATHER;
      advance(ai, w, out, p, false);
      return false;
    }
    return true;
  }
  if (half || (close && waited > MARCH_WAIT) || waited > 5 * MINUTE) {
    f.since = w.tick;
    if (last && !loop) return true;
    f.wp = last ? 0 : f.wp + 1;
    advance(ai, w, out, p, true);
    return false;
  }
  advance(ai, w, out, p, false);
  return false;
}

function advance(ai: Ai, w: World, out: Command[], p: Post, all: boolean): void {
  const f = p.f;
  const units = p.units;
  marchOrders(ai, w, out, f, units, all);
  if (units.some((i) => LINE[w.kind[i]])) return;
  // A body with nothing that fights in the line (guns, trucks, drones) just goes.
  const tx = f.wps[2 * f.wp];
  const ty = f.wps[2 * f.wp + 1];
  const go = units.filter(
    (i) => (all || (w.flags[i] & FLAG_MOVING) === 0) && dist(w.posX[i], w.posY[i], tx, ty) > fx(30),
  );
  order(out, CMD_MOVE, go, tx, ty);
}

/**
 * Move: go to the place and stand there. Plain move orders, so nobody stops to fight on
 * the way; once there the troops shoot at what comes at them, like any troops standing
 * about. It never breaks off and never goes into the houses: it is for manoeuvre.
 */
function move(w: World, out: Command[], p: Post, x: number, y: number): void {
  const f = p.f;
  const units = p.units;
  if (f.state !== F_MARCH) {
    p.status = ST_ARRIVED;
    return;
  }
  p.status = ST_MOVE;
  const room = fx(40) + Math.trunc(Math.sqrt(units.length)) * fx(1);
  let up = 0;
  let moving = 0;
  const stuck: number[] = [];
  for (const i of units) {
    const d = dist(w.posX[i], w.posY[i], x, y);
    if (d < room) up++;
    if ((w.flags[i] & FLAG_MOVING) !== 0) moving++;
    else if (d > 2 * room) stuck.push(i);
  }
  const waited = w.tick - f.since;
  if (
    up * 100 >= units.length * 80 ||
    (moving === 0 && stuck.length === 0 && waited > 2 * TICK_RATE) ||
    waited > 5 * MINUTE
  ) {
    f.state = F_ASSAULT;
    p.status = ST_ARRIVED;
    return;
  }
  // Whoever stopped far short of the place (a blocked street, a squad put down) goes on.
  order(out, CMD_MOVE, stuck, ...ground(w.map, x, y));
}

/** At the objective: take it, with everything the computer player's assault has. */
function attack(
  ai: Ai,
  w: World,
  out: Command[],
  p: Post,
  power: number,
  cx: number,
  cy: number,
): void {
  const map = w.map;
  const f = p.f;
  const obj = f.obj!;
  const units = p.units;
  const reach = obj.kind === OBJ_TOWN ? map.townR[obj.id] + fx(30) : fx(70);
  let foes = 0;
  for (const e of ai.seen) {
    if (KINDS[w.kind[e]].cls !== CLASS_AIR && dist(w.posX[e], w.posY[e], obj.x, obj.y) < reach)
      foes++;
  }
  f.quiet = foes === 0 && dist(cx, cy, obj.x, obj.y) < reach ? f.quiet + 1 : 0;
  const points = strongPoints(ai, w, obj);
  let point = -1;
  let pointD = 0;
  for (const s of points) {
    const d =
      structDist2(w, s, cx, cy) - (w.sTeam[s] === ai.enemy && w.sType[s] === B_HQ ? 1e12 : 0);
    if (point < 0 || d < pointD) {
      point = s;
      pointD = d;
    }
  }
  ceaseFire(w, out, units, point);
  const ours = obj.kind !== OBJ_TOWN || w.townOwner[obj.id] === ai.team;
  if (f.quiet >= 6 && points.length === 0 && ours) {
    // Taken. It stays and holds the place until told otherwise.
    p.status = ST_SECURED;
    station(ai, w, out, p, obj.x, obj.y, cx, cy);
    return;
  }
  if (beaten(ai, w, f, power, cx, cy)) {
    breakOff(ai, w, out, p, cx, cy);
    return;
  }
  p.status = ST_ATTACK;
  press(ai, w, out, f, units, cx, cy, points, point);
  muster(w, out, units, obj.x, obj.y);
}

/** Hold a place: infantry into its houses, the rest of the line around it, guns behind. */
function station(
  ai: Ai,
  w: World,
  out: Command[],
  p: Post,
  x: number,
  y: number,
  cx: number,
  cy: number,
): void {
  const units = p.units;
  const foot = units.filter((i) => FOOT(w.kind[i]));
  billetStart(w, [foot]);
  billet(ai, w, out, foot, p.houses, x, y, fx(28), -1);
  dig(w, out, p, foot);
  const rest = units.filter(
    (i) =>
      LINE[w.kind[i]] &&
      !FOOT(w.kind[i]) &&
      w.job[i] === JOB_NONE &&
      (w.flags[i] & FLAG_MOVING) === 0 &&
      w.attack[i] === NO_TARGET &&
      dist(w.posX[i], w.posY[i], x, y) > fx(30),
  );
  order(out, CMD_ATTACK_MOVE, rest, x, y);
  follow(ai, w, out, units, cx, cy);
  muster(w, out, units, x, y);
}

/**
 * A commander that holds a place has its engineers sandbag the houses its squads are in,
 * and the ruins they are lying in, one after another (decision 110). Fortifying costs
 * nothing but their time; they do not mend, which would spend the player's supplies.
 */
function dig(w: World, out: Command[], p: Post, foot: readonly number[]): void {
  const map = w.map;
  const free = p.units.filter(
    (i) =>
      KINDS[w.kind[i]].engineer &&
      w.job[i] === JOB_NONE &&
      w.attack[i] === NO_TARGET &&
      (w.flags[i] & FLAG_MOVING) === 0,
  );
  if (free.length === 0) return;
  const held = new Set<number>();
  for (const i of foot) {
    if (w.inside[i] >= 0) held.add(w.inside[i]);
    else {
      const s = map.structAt[cellOfPos(w.posX[i], w.posY[i])];
      if (s >= 0 && map.sKind[s] === S_BUILDING && w.sHp[s] <= 0) held.add(s);
    }
  }
  for (const s of p.houses) {
    if (!held.has(s) || fortified(w, s)) continue;
    // Whole, or flat: a damaged house would be mended first, and that is not free.
    if (w.sHp[s] > 0 && w.sHp[s] < map.sMaxHp[s]) continue;
    let holed = false;
    for (let f = 0; f < 4 && w.sHp[s] > 0; f++) {
      if (w.sWall[4 * s + f] < wallMax(map, s, f)) holed = true;
    }
    if (holed) continue;
    out.push({ type: CMD_ENTRENCH, units: free.slice(0, 3), structure: s });
    return;
  }
}

/**
 * A body with nothing that fights in the line (drones, guns, trucks) has no line to keep
 * behind, so `follow` leaves it where it is: it is sent to the place itself, once, and
 * stays there. Strike drones that are after a vehicle are left to it.
 */
function muster(w: World, out: Command[], units: readonly number[], x: number, y: number): void {
  if (units.some((i) => LINE[w.kind[i]])) return;
  const go = units.filter(
    (i) =>
      (w.flags[i] & (FLAG_MOVING | FLAG_BOMBARD)) === 0 &&
      w.attack[i] === NO_TARGET &&
      dist(w.posX[i], w.posY[i], x, y) > fx(30),
  );
  order(out, CMD_MOVE, go, x, y);
}

/**
 * Defend a place: hold it like `station`, but go out to meet an enemy seen anywhere
 * around it, and give ground to one that is far too strong.
 */
function defend(
  ai: Ai,
  w: World,
  out: Command[],
  p: Post,
  power: number,
  cx: number,
  cy: number,
): void {
  const obj = p.f.obj!;
  const units = p.units;
  let sx = 0;
  let sy = 0;
  let n = 0;
  let threat = 0;
  for (const e of ai.seen) {
    const kind = w.kind[e];
    if (KINDS[kind].cls === CLASS_AIR) continue;
    if (dist(w.posX[e], w.posY[e], obj.x, obj.y) > fx(110)) continue;
    sx += w.posX[e] >> 4;
    sy += w.posY[e] >> 4;
    n++;
    threat += Math.trunc((POWER[kind] * w.hp[e]) / KINDS[kind].hp) + 1;
  }
  p.status = ST_DEFEND;
  if (n === 0) {
    station(ai, w, out, p, obj.x, obj.y, cx, cy);
    return;
  }
  if (threat > 2 * power + 40) {
    breakOff(ai, w, out, p, cx, cy);
    return;
  }
  const mobile = units.filter(
    (i) =>
      LINE[w.kind[i]] &&
      w.inside[i] < 0 &&
      (w.flags[i] & FLAG_MOVING) === 0 &&
      w.attack[i] === NO_TARGET,
  );
  order(out, CMD_ATTACK_MOVE, mobile, Math.trunc(sx / n) << 4, Math.trunc(sy / n) << 4);
  follow(ai, w, out, units, cx, cy);
  muster(w, out, units, obj.x, obj.y);
}

/** A screen: the troops strung out in a line through the point, across the way from home. */
function pickets(
  ai: Ai,
  w: World,
  out: Command[],
  units: readonly number[],
  tx: number,
  ty: number,
): void {
  const n = units.length;
  const d = dist(tx, ty, ai.homeX, ai.homeY) || 1;
  const px = -(ty - ai.homeY);
  const py = tx - ai.homeX;
  const gap = Math.min(fx(18), Math.trunc(fx(360) / n));
  for (let k = 0; k < n; k++) {
    const i = units[k];
    if ((w.flags[i] & FLAG_MOVING) !== 0 || w.attack[i] !== NO_TARGET) continue;
    const off = Math.trunc(((2 * k - (n - 1)) * gap) / 2);
    const x = clampInt(tx + Math.trunc((px * off) / d), 0, MAP_SIZE_FX - 1);
    const y = clampInt(ty + Math.trunc((py * off) / d), 0, MAP_SIZE_FX - 1);
    if (dist(w.posX[i], w.posY[i], x, y) > fx(10)) out.push({ type: CMD_MOVE, units: [i], x, y });
  }
}

/** Carriers put their squads down when the enemy is near, or when they have arrived. */
function unload(ai: Ai, w: World, out: Command[], p: Post): void {
  const down: number[] = [];
  for (const i of p.units) {
    if (w.load[i] === 0 || KINDS[w.kind[i]].carry === 0) continue;
    let danger = false;
    for (const e of ai.seen) {
      if (KINDS[w.kind[e]].cls === CLASS_AIR || POWER[w.kind[e]] <= 2) continue;
      if (dist(w.posX[e], w.posY[e], w.posX[i], w.posY[i]) < DISMOUNT) {
        danger = true;
        break;
      }
    }
    if (danger || ((w.flags[i] & FLAG_MOVING) === 0 && p.f.state !== F_MARCH)) down.push(i);
  }
  if (down.length > 0) out.push({ type: CMD_UNLOAD, units: down });
}
