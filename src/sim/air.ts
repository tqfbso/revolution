// Paratroops (decision 106). They are trained into a reserve that waits off the map, and a
// second order drops them: a transport plane comes in over the army's own edge of the map
// with up to PARA_PLANE_LOAD squads aboard, flies straight at the point asked for, puts them
// out over it and turns for home. Nobody steers the plane and nothing but air defence can
// touch it; shot down on the way in, it takes everyone aboard with it.
//
// Air strikes (I7) use the same airframe slot: a jet comes in over the army's edge of the
// map, lets go of what it carries over the point and turns for home (see the second half
// of this file). Only the three big armies have one, each its own.
//
// Helicopters need none of this: they are ordinary units that happen to fly (see units.ts)
// and are limited by their helipads (see economy.ts).
import { ON_OTHER, book } from './spend';
import { CMD_AIRSTRIKE, CMD_GRANT, CMD_PARADROP, type Command } from './commands';
import { B_HQ, BUILDINGS } from './economy';
import { FACTION_CHINA, FACTION_NATO, FACTION_RUSSIA, kindOf } from './factions';
import { clampInt, fx, isqrt } from './fixed';
import {
  CELL_FX,
  CELL_SHIFT,
  CLASS_AIR,
  CLASS_FOOT,
  MAP_CELLS,
  MAX_TEAMS,
  cellOfPos,
  layerOf,
} from './map';
import { nextInt } from './rng';
import { concealed, spawnUnit } from './sim';
import {
  KIND_PARA,
  KIND_PLANE,
  KINDS,
  PARA_LAND_TICKS,
  PARA_PLANE_LOAD,
  PARA_SCATTER,
} from './units';
import {
  EV_AIRSTRIKE,
  EV_BOMB,
  EV_PARADROP,
  EV_PLANE,
  MAP_SIZE_FX,
  MAX_SHELLS,
  NO_TARGET,
  NO_TEAM,
  STATE_WRECK,
  TICK_RATE,
  STATE_ALIVE,
  STATE_FREE,
  STAT_SEATS,
  packPoint,
  type World,
  NO_SEAT,
} from './world';

const POS_MAX = MAP_SIZE_FX - 1;
/** `cargo` of a plane: on its way in with the squads, or on its way out without them. */
const INBOUND = 0;
const OUTBOUND = 1;
/** `cargo` of a jet on its strike run; once it has let go it is OUTBOUND like any plane. */
const STRIKE_RUN = 2;
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
  if (cmd.type === CMD_GRANT) {
    const t = cmd.team;
    if (!Number.isInteger(t) || t < 0 || t >= MAX_TEAMS) return true;
    w.tier[t] = clampInt(cmd.tier | 0, 1, 3);
    w.supplies[t] = Math.max(0, cmd.supplies | 0);
    w.fuel[t] = Math.max(0, cmd.fuel | 0);
    w.credits[t] = Math.max(0, cmd.credits | 0);
    return true;
  }
  if (cmd.type === CMD_AIRSTRIKE) {
    callStrike(w, cmd.team, cmd.x, cmd.y);
    return true;
  }
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
    if (cmd.by !== undefined && cmd.by >= 0 && cmd.by < STAT_SEATS) {
      w.seat[id] = cmd.by;
      // Nobody's role covers them: they are his who sent the plane.
      if (w.owner[id] === NO_SEAT && w.seatArmy[cmd.by] === team) w.owner[id] = cmd.by;
    }
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
    if (w.cargo[i] === STRIKE_RUN) {
      followMark(w, i);
      dx = w.targetX[i] - x;
      dy = w.targetY[i] - y;
      if (dx * dx + dy * dy <= fx(3) * fx(3) || dx * fxi + dy * fyi <= 0) {
        release(w, i);
        w.cargo[i] = OUTBOUND;
        w.targetX[i] = w.aimX[i];
        w.targetY[i] = w.aimY[i];
        dx = w.targetX[i] - x;
        dy = w.targetY[i] - y;
      }
    } else if (w.cargo[i] === INBOUND) {
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

// ---------------------------------------------------------------------------------------
// Air strikes (I7, decision 154).
//
// The slowest and dearest thing an army has: the top tier, a standing headquarters, a big
// bill in credits and four minutes between one and the next. A jet comes in fast and low
// over the army's own edge of the map, so air defence on the way gets a few seconds at it;
// shot down before the point, it takes its load with it. Over the point it lets go:
//
//   Western alliance, a guided bomb: one bomb, where it was asked for and nowhere else. It
//     kills whatever is under it, tank included, and takes most of a building.
//   Russia, a stick of bombs: six bombs in a line along the run, each landing a little off.
//     A street of men in the open, a row of houses cracked; armour only if a bomb is close.
//   China, a drone swarm: eight munitions look for vehicles round the point (two to a tank),
//     then for men in the open. A jammer near what they dive on sends them astray.
//
// The bombs are shells as far as the rest of the rules go (World.shX and so on, landing in
// resolveShells): what they carry is in shSmoke, the team in shKind. Friend or foe, anyone
// under a bomb is hurt; the swarm only dives on the enemy. The fine for civilians killed is
// the same as for shells (Fabio: the cost today is fine).
// ---------------------------------------------------------------------------------------

export const AIR_NONE = 0;
export const AIR_GUIDED = 1;
export const AIR_STICK = 2;
export const AIR_SWARM = 3;

/** Each faction's strike (index: faction). The plain table has none, nor will the guerrilla. */
export const STRIKE_OF_FACTION: readonly number[] = (() => {
  const t = [AIR_NONE, AIR_NONE, AIR_NONE, AIR_NONE];
  t[FACTION_NATO] = AIR_GUIDED;
  t[FACTION_RUSSIA] = AIR_STICK;
  t[FACTION_CHINA] = AIR_SWARM;
  return t;
})();

export const STRIKE_NAMES: readonly string[] = ['', 'Guided bomb', 'Stick of bombs', 'Drone swarm'];

/** What a strike costs. More credits than a tank, about the whole of one in all. */
export const AIR_STRIKE_PRICE = { supplies: 200, fuel: 150, credits: 250 };
export const AIR_STRIKE_TIER = 3;
/** From one strike to the next. */
export const AIR_STRIKE_COOLDOWN = 4 * 60 * TICK_RATE;
/** A jet is that much faster than a transport plane, so air defence has less time at it. */
const JET_SPEED_PCT = 170;

/** What one bomb or munition does where it lands (shSmoke values from SHELL_BOMB up). */
export interface Bomb {
  /** Radius of the burst. */
  radius: number;
  /** Damage at the centre as a share of the target's full health, in percent; half at the rim. */
  soft: number;
  /** The same against armour, which takes it only within `armourReach` of the burst. */
  armour: number;
  armourReach: number;
  /** Damage to buildings, as the `siege` of a gun. */
  siege: number;
}

/** The first shSmoke value that is a bomb, not smoke or a flare; then one per strike. */
export const SHELL_BOMB = 3;

export const BOMBS: readonly Bomb[] = [
  { radius: 0, soft: 0, armour: 0, armourReach: 0, siege: 0 },
  // About 230 kg of high explosive with a seeker: it lands on the point.
  { radius: fx(7), soft: 260, armour: 260, armourReach: fx(3.5), siege: 1500 },
  // Six free-fall bombs of about 100 kg.
  { radius: fx(6), soft: 170, armour: 170, armourReach: fx(2), siege: 420 },
  // A small warhead from above: two finish a tank, one a carrier or a squad in the open.
  { radius: fx(3), soft: 120, armour: 58, armourReach: fx(3), siege: 90 },
];

const STICK_BOMBS = 6;
const STICK_GAP = fx(6);
const STICK_SCATTER = fx(2);
const SWARM_SIZE = 8;
/** How far round the point the swarm looks for something to dive on. */
export const SWARM_REACH = fx(32);
/** A spoofed munition comes down up to this far from what it was diving on. */
const SWARM_ASTRAY = fx(14);
/** Ticks from letting go to the first landing, and between one landing and the next. */
const FALL_TICKS = [0, 30, 22, 26];
const STAGGER_TICKS = [0, 0, 3, 6];

/** The strike `team` has, by its faction, or AIR_NONE. */
export function strikeOf(w: World, team: number): number {
  return STRIKE_OF_FACTION[w.faction[team]] ?? AIR_NONE;
}

/** Does `team` have a finished headquarters standing? */
function hasHq(w: World, team: number): boolean {
  const map = w.map;
  for (let s = map.structCount - 1; s >= 0; s--) {
    if (w.sTeam[s] === NO_TEAM || w.sTeam[s] !== team) continue;
    if (w.sType[s] !== B_HQ || w.sHp[s] <= 0) continue;
    if (w.sBuild[s] >= BUILDINGS[B_HQ].ticks) return true;
  }
  return false;
}

/** Why `team` cannot call its strike now (STRIKE_*), or STRIKE_READY. */
export const STRIKE_READY = 0;
export const STRIKE_NO_PLANES = 1;
export const STRIKE_TIER_LOW = 2;
export const STRIKE_NO_HQ = 3;
export const STRIKE_COOLING = 4;
export const STRIKE_POOR = 5;

export function strikeStatus(w: World, team: number): number {
  if (team < 0 || team >= MAX_TEAMS || strikeOf(w, team) === AIR_NONE) return STRIKE_NO_PLANES;
  if (w.tier[team] < AIR_STRIKE_TIER) return STRIKE_TIER_LOW;
  if (w.tick < w.airStrikeAt[team]) return STRIKE_COOLING;
  const p = AIR_STRIKE_PRICE;
  if (w.supplies[team] < p.supplies || w.fuel[team] < p.fuel || w.credits[team] < p.credits) {
    return STRIKE_POOR;
  }
  if (!hasHq(w, team)) return STRIKE_NO_HQ;
  return STRIKE_READY;
}

/** Send `team`'s jet at (x, y), if it can go. Returns the jet, or -1. */
function callStrike(w: World, team: number, cx: number, cy: number): number {
  if (!Number.isInteger(team) || strikeStatus(w, team) !== STRIKE_READY) return -1;
  const x = clampInt(cx | 0, DROP_MARGIN, POS_MAX - DROP_MARGIN);
  const y = clampInt(cy | 0, DROP_MARGIN, POS_MAX - DROP_MARGIN);
  const [ex, ey] = planeEntry(w, team);
  const jet = spawnUnit(w, KIND_PLANE, team, ex, ey);
  if (jet < 0) return -1;
  const p = AIR_STRIKE_PRICE;
  w.supplies[team] -= p.supplies;
  w.fuel[team] -= p.fuel;
  w.credits[team] -= p.credits;
  book(w, team, w.payer, p, ON_OTHER);
  w.airStrikeAt[team] = w.tick + AIR_STRIKE_COOLDOWN;
  w.posX[jet] = ex;
  w.posY[jet] = ey;
  w.targetX[jet] = x;
  w.targetY[jet] = y;
  w.aimX[jet] = ex;
  w.aimY[jet] = ey;
  w.cargo[jet] = STRIKE_RUN;
  w.load[jet] = 0;
  w.speed[jet] = Math.trunc((KINDS[KIND_PLANE].speed * JET_SPEED_PCT) / 100);
  // The guided bomb is laser-guided: called on a vehicle or a squad, it follows it.
  w.orderUnit[jet] = strikeOf(w, team) === AIR_GUIDED ? lockOn(w, team, x, y) : -1;
  face(w, jet, x - ex, y - ey);
  w.events.push(EV_AIRSTRIKE, jet, strikeOf(w, team) | (team << 4));
  return jet;
}

function addBomb(w: World, jet: number, type: number, x: number, y: number, after: number): void {
  if (w.shellCount >= MAX_SHELLS) return;
  const k = w.shellCount++;
  const px = clampInt(x, 0, POS_MAX);
  const py = clampInt(y, 0, POS_MAX);
  w.shX[k] = px;
  w.shY[k] = py;
  w.shTick[k] = w.tick + after;
  w.shOwner[k] = jet;
  // A bomb has no gun to look up: it keeps the team that sent it instead.
  w.shKind[k] = w.team[jet];
  w.shSmoke[k] = SHELL_BOMB + type - 1;
  w.events.push(EV_BOMB, packPoint(px, py), type | (after << 4) | (jet << 12));
}

/** How close to the point an enemy must be for the guided bomb to lock on to it. */
const LOCK_REACH = fx(8);

/** The enemy on the ground nearest (x, y) within LOCK_REACH, vehicles first, or -1. */
function lockOn(w: World, team: number, x: number, y: number): number {
  let best = -1;
  let bestScore = -1;
  for (let j = 0; j < w.count; j++) {
    const worth = swarmWorth(w, j, team);
    if (worth === 0) continue;
    const dx = w.posX[j] - x;
    const dy = w.posY[j] - y;
    const d2 = dx * dx + dy * dy;
    if (d2 > LOCK_REACH * LOCK_REACH) continue;
    const sc = worth * 2 ** 40 - d2;
    if (sc > bestScore) {
      best = j;
      bestScore = sc;
    }
  }
  return best;
}

/** A guided bomb's mark, while it lives and the laser can see it; else -1. */
function marked(w: World, jet: number): number {
  const t = w.orderUnit[jet];
  if (t < 0 || t >= w.count || w.state[t] !== STATE_ALIVE || w.inside[t] >= 0) return -1;
  if (w.team[t] === w.team[jet] || w.carrier[t] >= 0) return -1;
  return t;
}

/** On the way in: the guided bomb's jet keeps its nose on the mark. */
export function followMark(w: World, jet: number): void {
  const t = marked(w, jet);
  if (t < 0) return;
  w.targetX[jet] = clampInt(w.posX[t], DROP_MARGIN, POS_MAX - DROP_MARGIN);
  w.targetY[jet] = clampInt(w.posY[t], DROP_MARGIN, POS_MAX - DROP_MARGIN);
}

/** Over the point: let go. */
function release(w: World, jet: number): void {
  const team = w.team[jet];
  const type = strikeOf(w, team);
  const x = w.targetX[jet];
  const y = w.targetY[jet];
  const fall = FALL_TICKS[type];
  const gap = STAGGER_TICKS[type];
  if (type === AIR_GUIDED) {
    // On the mark, where it will be when the bomb gets there.
    const t = marked(w, jet);
    if (t >= 0)
      addBomb(w, jet, type, w.posX[t] + w.velX[t] * fall, w.posY[t] + w.velY[t] * fall, fall);
    else addBomb(w, jet, type, x, y, fall);
  } else if (type === AIR_STICK) {
    // Along the line of flight, centred on the point.
    const ux = w.faceX[jet];
    const uy = w.faceY[jet];
    for (let b = 0; b < STICK_BOMBS; b++) {
      const along = (2 * b - (STICK_BOMBS - 1)) * (STICK_GAP >> 1);
      const sx = nextInt(w.rng, 2 * STICK_SCATTER + 1) - STICK_SCATTER;
      const sy = nextInt(w.rng, 2 * STICK_SCATTER + 1) - STICK_SCATTER;
      addBomb(
        w,
        jet,
        type,
        x + ((ux * along) >> 10) + sx,
        y + ((uy * along) >> 10) + sy,
        fall + gap * b,
      );
    }
  } else if (type === AIR_SWARM) {
    swarm(w, jet, x, y, fall, gap);
  }
}

/** How much a swarm munition wants to dive on unit `j`: vehicles before men, nothing hidden. */
function swarmWorth(w: World, j: number, team: number): number {
  if (w.state[j] !== STATE_ALIVE || w.team[j] === team || w.carrier[j] >= 0) return 0;
  if (w.inside[j] >= 0) return 0;
  const kind = kindOf(w, j);
  if (kind.cls === CLASS_AIR) return 0;
  // What the swarm's own seekers cannot make out it does not find.
  if (concealed(w, j) && w.spotted[j] <= w.tick) return 0;
  if (kind.cls === CLASS_FOOT) return 1;
  return kind.armour !== null ? 3 : 2;
}

const pickIds = new Int32Array(SWARM_SIZE);
const pickWant = new Int32Array(SWARM_SIZE);

/**
 * Eight munitions, each on the best thing it can find round the point: the most valuable
 * first (armour, then other vehicles, then men), nearest first among equals, two to a tank.
 * What none finds a target for comes down on the point. Each dives on where its target
 * will be when it gets there, so whatever keeps moving may yet get away.
 */
function swarm(w: World, jet: number, x: number, y: number, fall: number, gap: number): void {
  const team = w.team[jet];
  const R2 = SWARM_REACH * SWARM_REACH;
  // The best SWARM_SIZE candidates, kept sorted: worth high first, then nearer.
  let n = 0;
  const score = (j: number, d2: number) => swarmWorth(w, j, team) * 2 ** 40 - d2;
  const scores: number[] = [];
  for (let j = 0; j < w.count; j++) {
    const worth = swarmWorth(w, j, team);
    if (worth === 0) continue;
    const dx = w.posX[j] - x;
    const dy = w.posY[j] - y;
    const d2 = dx * dx + dy * dy;
    if (d2 > R2) continue;
    const sc = score(j, d2);
    if (n === SWARM_SIZE && sc <= scores[n - 1]) continue;
    let k = n < SWARM_SIZE ? n++ : n - 1;
    while (k > 0 && scores[k - 1] < sc) {
      scores[k] = scores[k - 1];
      pickIds[k] = pickIds[k - 1];
      k--;
    }
    scores[k] = sc;
    pickIds[k] = j;
  }
  // Two munitions to each tank, one to anything else, round again while any are left.
  let m = 0;
  for (let k = 0; k < n; k++) pickWant[k] = kindOf(w, pickIds[k]).armour !== null ? 2 : 1;
  for (let round = 0; m < SWARM_SIZE && n > 0 && round < SWARM_SIZE; round++) {
    for (let k = 0; k < n && m < SWARM_SIZE; k++) {
      const j = pickIds[k];
      const want = round === 0 ? pickWant[k] : 1;
      for (let q = 0; q < want && m < SWARM_SIZE; q++) {
        const after = fall + gap * m;
        // Lead the target by what it will cover before the munition arrives.
        let tx = w.posX[j] + w.velX[j] * after;
        let ty = w.posY[j] + w.velY[j] * after;
        if (jammedAt(w, team, tx, ty)) {
          tx += nextInt(w.rng, 2 * SWARM_ASTRAY + 1) - SWARM_ASTRAY;
          ty += nextInt(w.rng, 2 * SWARM_ASTRAY + 1) - SWARM_ASTRAY;
        }
        addBomb(w, jet, AIR_SWARM, tx, ty, after);
        m++;
      }
    }
  }
  for (; m < SWARM_SIZE; m++) {
    const s = fx(6);
    addBomb(
      w,
      jet,
      AIR_SWARM,
      x + nextInt(w.rng, 2 * s + 1) - s,
      y + nextInt(w.rng, 2 * s + 1) - s,
      fall + gap * m,
    );
  }
}

/** Is (x, y) under the jamming of an army other than `team`? */
function jammedAt(w: World, team: number, x: number, y: number): boolean {
  for (let e = 0; e < w.count; e++) {
    if (w.state[e] !== STATE_ALIVE || w.team[e] === team) continue;
    const r = kindOf(w, e).jam;
    if (r <= 0) continue;
    const dx = w.posX[e] - x;
    const dy = w.posY[e] - y;
    if (dx * dx + dy * dy <= r * r) return true;
  }
  return false;
}

/** Is `jet` (still) the strike jet of `team`, so that what its bombs kill is to its credit? */
export function bomberOf(w: World, jet: number, team: number): number {
  return jet >= 0 &&
    jet < w.count &&
    w.kind[jet] === KIND_PLANE &&
    w.team[jet] === team &&
    (w.state[jet] === STATE_ALIVE || w.state[jet] === STATE_WRECK)
    ? jet
    : -1;
}
