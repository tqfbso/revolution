// The skirmish opponent. It is a player, not a part of the simulation: it reads the world
// and answers with the same commands a human gives (see decision 044), so everything it
// does a human could do, and in multiplayer every client can run it and stay in step.
//
// It knows what a player knows: the map, its own army, and of the enemy only what its
// units have in sight (plus a fading memory of what they saw). Integers only, its own
// random numbers, no clock: the same world always gets the same answer.
//
// Three layers, each run about once a second:
//   economy    trucks on sites, depots at new sites, buildings, technology
//   production what to build next, from the army it wants and the enemy it has seen
//   military   town garrisons, scouts, a reserve that answers alarms, and a field army
//              that picks an objective, picks the crossing to reach it by, and assaults
import {
  CMD_ASSIST,
  CMD_ATTACK_MOVE,
  CMD_ATTACK_STRUCTURE,
  CMD_BOMBARD,
  CMD_BREACH,
  CMD_BUILD,
  CMD_FORTIFY,
  CMD_GARRISON,
  CMD_GATHER,
  CMD_LOAD,
  CMD_MOVE,
  CMD_OCCUPY,
  CMD_RALLY,
  CMD_RESEARCH,
  CMD_TRAIN,
  CMD_UNLOAD,
  type Command,
} from './commands';
import {
  BUILDINGS,
  B_BARRACKS,
  B_DEPOT,
  B_DRONES,
  B_HQ,
  B_WORKS,
  MAX_TIER,
  POP_MAX,
  TIER_ITEM,
  TIER_PRICE,
  UNIT_PRICE,
  type Price,
} from './economy';
import { FP_SHIFT, clampInt, fx, isqrt } from './fixed';
import {
  CELL_FX,
  CELL_SHIFT,
  CLASS_AIR,
  CLASS_VEHICLE,
  MAP_CELLS,
  MAX_SITES,
  MAX_STRUCTS,
  MAX_TOWNS,
  SITE_FUEL,
  S_BASE,
  S_BUILDING,
  T_BRIDGE,
  T_FORD,
  T_FOREST,
  T_OPEN,
  T_SANDBAG,
  T_WATER,
  canPlace,
  findCell,
  type GameMap,
} from './map';
import { seedRng, nextInt } from './rng';
import {
  WORKS,
  WORK_SANDBAG,
  WORK_TRAP,
  WORK_TRENCH,
  WORK_WIRE,
  canBreach,
  canFortify,
  workStands,
} from './works';
import { concealed, structDist2 } from './sim';
import {
  GARRISON_MAX,
  KINDS,
  KIND_AD,
  KIND_ARTILLERY,
  KIND_ATGM,
  KIND_COUNT,
  KIND_DRONE,
  KIND_ENGINEER,
  KIND_EW,
  KIND_IFV,
  KIND_INFANTRY,
  KIND_RECON,
  KIND_STRIKE,
  KIND_TANK,
  KIND_TRUCK,
  POINTS,
} from './units';
import {
  FLAG_BOARD,
  FLAG_BOMBARD,
  FLAG_BREACH,
  FLAG_GARRISON,
  FLAG_MOVING,
  FLAG_SIEGE,
  JOB_BUILD,
  JOB_NONE,
  MAP_SIZE,
  MAP_SIZE_FX,
  MAX_UNITS,
  NO_TARGET,
  NO_TEAM,
  QUEUE_MAX,
  STATE_ALIVE,
  TICK_RATE,
  type World,
} from './world';

export type AiLevel = 'recruit' | 'easy' | 'normal' | 'hard';

/** What separates the difficulty levels. No level gets free resources or sees through fog. */
interface Tuning {
  /** Ticks between two rounds of thinking. */
  period: number;
  /** Most trucks it runs, and most production buildings it puts up. */
  trucks: number;
  factories: number;
  /** The largest force it keeps, in units of the unit limit, however many depots it has. */
  size: number;
  /** Entries it keeps on a production queue. */
  queue: number;
  /** Trucks it puts on one building site. */
  builders: number;
  /** Squads it wants in each of its towns at the start (the central one gets half more). */
  garrison: number;
  /** It attacks when its strength is this many percent of what it expects to meet. */
  ratio: number;
  /** No attack across the river before this tick, and none with less strength than this. */
  firstAttack: number;
  minArmy: number;
  /**
   * It breaks off when this many percent of the strength it set out with is left, or when
   * it is losing against more than `odds` tenths of its own strength.
   */
  breakOff: number;
  odds: number;
  /** First tick of raids on trucks and outlying depots (0 = never), and IFVs in a raiding party. */
  raids: number;
  raidParty: number;
  /** Builds against what it has seen of the enemy. */
  counter: boolean;
  /** Lays smoke in front of a town it storms. */
  smoke: boolean;
  /** Engineer squads it keeps to put up field works (0 = it builds none). */
  sappers: number;
  /** Its belts get tank obstacles behind the wire. */
  traps: boolean;
  /** Ticks it lets pass after an attack has come home before it sets out again. */
  rest: number;
  /** Towns beyond the one at its gate it puts a garrison in before its first attack. */
  reach: number;
  /** Its infantry rides to the attack in the carriers it has. */
  carriers: boolean;
  /** It orders new units only on every so-many-th think: a slow hand on the production line. */
  slow: number;
}

const MINUTE = 60 * TICK_RATE;

export const AI_TUNING: Readonly<Record<AiLevel, Tuning>> = {
  // A sparring partner for learning the game: a small economy, a long quiet opening,
  // and an attack only with overwhelming numbers.
  recruit: {
    period: 80,
    trucks: 6,
    factories: 2,
    size: 70,
    queue: 1,
    builders: 1,
    garrison: 2,
    ratio: 300,
    firstAttack: 22 * MINUTE,
    minArmy: 300,
    breakOff: 55,
    odds: 24,
    raids: 0,
    raidParty: 4,
    counter: false,
    smoke: false,
    sappers: 0,
    traps: false,
    rest: 8 * MINUTE,
    reach: 0,
    carriers: false,
    slow: 5,
  },
  // Decision 070: Fabio found this level too hard. It now keeps a small army, holds only
  // its gate town and one more until it has attacked once, attacks late with what its
  // carriers can lift, and waits five minutes between attacks.
  easy: {
    period: 60,
    trucks: 7,
    factories: 2,
    size: 110,
    queue: 1,
    builders: 1,
    garrison: 2,
    ratio: 260,
    firstAttack: 24 * MINUTE,
    minArmy: 260,
    breakOff: 55,
    odds: 22,
    raids: 0,
    raidParty: 4,
    counter: false,
    smoke: false,
    sappers: 1,
    traps: false,
    rest: 5 * MINUTE,
    reach: 1,
    carriers: true,
    slow: 3,
  },
  normal: {
    period: 20,
    trucks: 26,
    factories: 10,
    size: 800,
    queue: 2,
    builders: 2,
    garrison: 4,
    ratio: 170,
    firstAttack: 12 * MINUTE,
    minArmy: 240,
    breakOff: 45,
    odds: 14,
    raids: 14 * MINUTE,
    raidParty: 4,
    counter: true,
    smoke: false,
    sappers: 2,
    traps: true,
    rest: 45 * TICK_RATE,
    reach: 99,
    carriers: true,
    slow: 1,
  },
  hard: {
    period: 20,
    trucks: 36,
    factories: 14,
    size: 800,
    queue: 2,
    builders: 3,
    garrison: 5,
    ratio: 150,
    firstAttack: 6 * MINUTE,
    minArmy: 220,
    breakOff: 45,
    odds: 11,
    raids: 7 * MINUTE,
    raidParty: 6,
    counter: true,
    smoke: true,
    sappers: 3,
    traps: true,
    rest: 45 * TICK_RATE,
    reach: 99,
    carriers: true,
    slow: 1,
  },
};

/** The AI's own map of the battlefield: squares of 16 units. */
const CS = FP_SHIFT + 4;
const CD = MAP_SIZE >> 4;
const CC = CD * CD;

/** What a unit of each type is worth in a fight, roughly. Strength is this times health. */
const POWER = [30, 8, 12, 16, 20, 2, 1, 10, 4, 2, 0, 6];
/** Units that form the line of an attack; the rest follow behind it. */
const LINE = KINDS.map(
  (k, i) => k.cls !== CLASS_AIR && !k.indirect && k.damage.some((d) => d > 0) && i !== KIND_TRUCK,
);
const FOOT = (k: number) => k === KIND_INFANTRY || k === KIND_ATGM;

const R_NONE = -1;
const R_RESERVE = 0;
const R_ARMY = 1;
const R_RAID = 2;
const R_SCOUT = 3;
/** On the way from the reserve to the field army. */
const R_JOIN = 4;
/** Engineers kept back to put up field works. */
const R_SAPPER = 5;
/** Garrison of town t: R_TOWN + t. */
const R_TOWN = 8;

const F_IDLE = 0;
const F_MARCH = 1;
const F_ASSAULT = 2;
const F_RETREAT = 3;

const OBJ_TOWN = 0;
const OBJ_BASE = 1;
const OBJ_POINT = 2;

interface Objective {
  kind: number;
  /** Town, for OBJ_TOWN. */
  id: number;
  x: number;
  y: number;
}

/** A body of troops with one job: the field army, or a raiding party. */
interface Force {
  role: number;
  state: number;
  /** Way points (x, y pairs) and the one it is heading for. */
  wps: number[];
  wp: number;
  /** Tick it entered its state, strength it set out with. */
  since: number;
  launch: number;
  obj: Objective | null;
  /** Thinks in a row without an enemy in sight at the objective. */
  quiet: number;
  smoked: boolean;
  /** It has already changed its route once on this march. */
  turned: boolean;
  /** Objectives taken on this outing. */
  done: number;
  /** Carriers wait for the squads that are to ride until this tick. */
  boardUntil: number;
}

/** A way over the river: a ford, with its bridge if it has one. */
export interface Crossing {
  x: number;
  y: number;
  /** Where to form up on the west and on the east bank. */
  bankX: [number, number];
  bankY: [number, number];
  /** The settlement on each bank, or -1 for a bare ford. */
  town: [number, number];
}

interface Alarm {
  x: number;
  y: number;
  threat: number;
  base: boolean;
  town: number;
}

export interface Ai {
  team: number;
  enemy: number;
  level: AiLevel;
  tune: Tuning;
  rng: Uint32Array;
  ready: boolean;
  /** 0 = it holds the west bank, 1 = the east. `fwd` is the x direction toward the enemy. */
  side: number;
  fwd: number;
  homeX: number;
  homeY: number;
  hq: number;
  /** Where it believes the enemy headquarters stands. */
  foeX: number;
  foeY: number;
  crossings: Crossing[];
  /** The crossings are the map's lanes (no river). */
  lanes: boolean;
  /** The crossing its army last marched by, or -1. */
  armyLane: number;
  /** Per cell row: the cell column of the river, or -1. */
  riverX: Int16Array;
  /** Per town: its houses, the ones facing the crossing first. */
  houses: number[][];
  role: Int8Array;
  roleKind: Uint8Array;
  /** Scouts: the post they watch, and how far along the way there they are. */
  post: Int8Array;
  leg: Uint8Array;
  /** Enemy strength per square as last seen, and when the square was last looked at. */
  threat: Int32Array;
  seenAt: Int32Array;
  /** Enemy base buildings it has found. */
  known: Uint8Array;
  /** Per structure: the tick until which it believes the enemy is inside. */
  occupied: Int32Array;
  /** Enemy units of each type it remembers seeing at once. */
  foeMix: Int32Array;
  /** Enemy units in sight right now. */
  seen: number[];
  have: Int32Array;
  trucks: number[];
  fresh: number[];
  reserve: number[];
  joining: number[];
  scouts: number[];
  sappers: number[];
  garr: number[][];
  forces: [Force, Force];
  members: [number[], number[]];
  stageX: number;
  stageY: number;
  alarm: Alarm | null;
  /** Towns it has held (so losing one calls for a counter-attack). */
  held: Uint8Array;
  /** Per site: the tick until which it keeps its trucks away. */
  siteBad: Int32Array;
  /** Per site: trucks it will put on it (0 = not workable now). */
  siteCap: Int32Array;
  /** What it is saving for. */
  resS: number;
  resF: number;
  resC: number;
  lastAttack: number;
  lastRaid: number;
  /** No new attack before this tick (set when one is broken off). */
  restUntil: number;
  /** Per town (and, last, the enemy base): the strength that was not enough last time. */
  grudge: Int32Array;
  /** Enemy field works it has seen that still stand. */
  foeWorks: number;
  /** Per town, then per crossing: no new look at its field works before this tick. */
  fortAt: Int32Array;
  /** Per town: a cell of the sandbags it put up there, or -1. */
  nest: Int32Array;
  /** Field works it has ordered so far. */
  laid: number;
  /** Its carriers with squads aboard, and the strength riding with the army and the raid. */
  loaded: number[];
  aboard: [number, number];
  /** Attacks it has launched over the middle of the map. */
  attacks: number;
  /** One line on what it is up to, for tests and the debug overlay. */
  plan: string;
}

const scratch = new Int32Array(CC);
const eyes = new Uint8Array(CC);
const watched = new Uint8Array(CC);
const perSite = new Int32Array(MAX_SITES);
const pendingIn = new Uint8Array(MAX_STRUCTS);
const mixNow = new Int32Array(KIND_COUNT);
const want = new Int32Array(KIND_COUNT);

export function createAi(team: number, level: AiLevel = 'normal', seed = 1): Ai {
  const force = (role: number): Force => ({
    role,
    state: F_IDLE,
    wps: [],
    wp: 0,
    since: 0,
    launch: 0,
    obj: null,
    quiet: 0,
    smoked: false,
    turned: false,
    done: 0,
    boardUntil: 0,
  });
  const ai: Ai = {
    team,
    enemy: team === 0 ? 1 : 0,
    level,
    tune: AI_TUNING[level],
    rng: new Uint32Array(1),
    ready: false,
    side: 0,
    fwd: 1,
    homeX: 0,
    homeY: 0,
    hq: -1,
    foeX: 0,
    foeY: 0,
    crossings: [],
    lanes: false,
    armyLane: -1,
    riverX: new Int16Array(MAP_CELLS).fill(-1),
    houses: [],
    role: new Int8Array(MAX_UNITS).fill(R_NONE),
    roleKind: new Uint8Array(MAX_UNITS),
    post: new Int8Array(MAX_UNITS).fill(-1),
    leg: new Uint8Array(MAX_UNITS),
    threat: new Int32Array(CC),
    seenAt: new Int32Array(CC).fill(-1000000),
    known: new Uint8Array(MAX_STRUCTS),
    occupied: new Int32Array(MAX_STRUCTS),
    foeMix: new Int32Array(KIND_COUNT),
    seen: [],
    have: new Int32Array(KIND_COUNT),
    trucks: [],
    fresh: [],
    reserve: [],
    joining: [],
    scouts: [],
    sappers: [],
    garr: [],
    forces: [force(R_ARMY), force(R_RAID)],
    members: [[], []],
    stageX: 0,
    stageY: 0,
    alarm: null,
    held: new Uint8Array(MAX_TOWNS),
    siteBad: new Int32Array(MAX_SITES),
    siteCap: new Int32Array(MAX_SITES),
    resS: 0,
    resF: 0,
    resC: 0,
    lastAttack: 0,
    lastRaid: 0,
    restUntil: 0,
    grudge: new Int32Array(MAX_TOWNS + 1),
    foeWorks: 0,
    fortAt: new Int32Array(MAX_TOWNS + 16),
    nest: new Int32Array(MAX_TOWNS).fill(-1),
    laid: 0,
    loaded: [],
    aboard: [0, 0],
    attacks: 0,
    plan: '',
  };
  seedRng(ai.rng, (seed ^ Math.imul(team + 1, 0x51ed27)) | 0);
  return ai;
}

/** The AI's commands for this tick, appended to `out`. Call once per tick, before step(). */
export function aiThink(ai: Ai, w: World, out: Command[]): void {
  if (!ai.ready && !setUp(ai, w)) return;
  // Without a headquarters the game is lost: nothing more to decide.
  if (w.sHp[ai.hq] <= 0 || w.sTeam[ai.hq] !== ai.team) return;
  const period = ai.tune.period;
  const phase = (w.tick + 3 * ai.team) % period;
  if (phase === 0) {
    perceive(ai, w);
    economy(ai, w, out);
    production(ai, w, out);
    fortify(ai, w, out);
  } else if (phase === period >> 1) {
    perceive(ai, w);
    military(ai, w, out);
  }
}

// ---------------------------------------------------------------- geography

const cellX = (c: number) => ((c % MAP_CELLS) << CELL_SHIFT) + (CELL_FX >> 1);
const cellY = (c: number) => (Math.trunc(c / MAP_CELLS) << CELL_SHIFT) + (CELL_FX >> 1);
const cellAt = (x: number, y: number) =>
  clampInt(y >> CELL_SHIFT, 0, MAP_CELLS - 1) * MAP_CELLS +
  clampInt(x >> CELL_SHIFT, 0, MAP_CELLS - 1);
const square = (x: number, y: number) =>
  clampInt(y >> CS, 0, CD - 1) * CD + clampInt(x >> CS, 0, CD - 1);
const structX = (map: GameMap, s: number) => ((2 * map.sX[s] + map.sW[s]) << CELL_SHIFT) >> 1;
const structY = (map: GameMap, s: number) => ((2 * map.sY[s] + map.sH[s]) << CELL_SHIFT) >> 1;

function dist(ax: number, ay: number, bx: number, by: number): number {
  return isqrt((ax - bx) * (ax - bx) + (ay - by) * (ay - by));
}

/** The nearest point to (x, y) a vehicle can stand on. */
function ground(map: GameMap, x: number, y: number): [number, number] {
  const c =
    map.snap[CLASS_VEHICLE][
      cellAt(clampInt(x, 0, MAP_SIZE_FX - 1), clampInt(y, 0, MAP_SIZE_FX - 1))
    ];
  return [cellX(c), cellY(c)];
}

/**
 * Find the river and the ways over it. The river is the water that runs from the north
 * edge of the map to the south edge; a row of it without deep water is a crossing, and
 * rows close together (a ford and the bridge next to it) are one crossing.
 */
export function findCrossings(map: GameMap, riverX: Int16Array): Crossing[] {
  const type = map.type;
  const wet = (c: number) => type[c] === T_WATER || type[c] === T_FORD || type[c] === T_BRIDGE;
  const river = new Uint8Array(MAP_CELLS * MAP_CELLS);
  const stack: number[] = [];
  for (let x = 0; x < MAP_CELLS; x++) {
    if (wet(x)) {
      river[x] = 1;
      stack.push(x);
    }
  }
  while (stack.length > 0) {
    const c = stack.pop()!;
    const x = c % MAP_CELLS;
    const y = Math.trunc(c / MAP_CELLS);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= MAP_CELLS || ny >= MAP_CELLS) continue;
        const n = ny * MAP_CELLS + nx;
        if (river[n] !== 0 || !wet(n)) continue;
        river[n] = 1;
        stack.push(n);
      }
    }
  }
  riverX.fill(-1);
  const open = new Uint8Array(MAP_CELLS);
  let rows = 0;
  for (let y = 0; y < MAP_CELLS; y++) {
    // The river proper is the widest run of wet cells in the row; a pond that touches it
    // is not part of it.
    let bestFrom = -1;
    let bestLen = 0;
    let from = -1;
    for (let x = 0; x <= MAP_CELLS; x++) {
      const in_ = x < MAP_CELLS && river[y * MAP_CELLS + x] !== 0;
      if (in_ && from < 0) from = x;
      if (!in_ && from >= 0) {
        if (x - from > bestLen) {
          bestLen = x - from;
          bestFrom = from;
        }
        from = -1;
      }
    }
    if (bestLen === 0) continue;
    rows++;
    riverX[y] = bestFrom + (bestLen >> 1);
    let deep = false;
    for (let x = bestFrom; x < bestFrom + bestLen; x++) {
      if (type[y * MAP_CELLS + x] === T_WATER) deep = true;
    }
    if (!deep && bestLen >= 3) open[y] = 1;
  }
  const crossings: Crossing[] = [];
  if (rows < MAP_CELLS - 8) {
    // No river from edge to edge: nothing to cross.
    riverX.fill(-1);
    return crossings;
  }
  for (let y = 0; y < MAP_CELLS; y++) if (riverX[y] < 0) riverX[y] = y > 0 ? riverX[y - 1] : 0;
  for (let y = MAP_CELLS - 2; y >= 0; y--) if (riverX[y] < 0) riverX[y] = riverX[y + 1];
  let y = 0;
  while (y < MAP_CELLS) {
    if (open[y] === 0) {
      y++;
      continue;
    }
    let last = y;
    for (let k = y + 1; k < MAP_CELLS && k - last <= 12; k++) if (open[k] !== 0) last = k;
    // The ford itself is the longest run of open rows in the group.
    let bestAt = y;
    let bestLen = 0;
    let run = 0;
    for (let k = y; k <= last; k++) {
      run = open[k] !== 0 ? run + 1 : 0;
      if (run > bestLen) {
        bestLen = run;
        bestAt = k - (run >> 1);
      }
    }
    const cx = cellX(riverX[bestAt]);
    const cy = cellY(bestAt * MAP_CELLS);
    const c: Crossing = { x: cx, y: cy, bankX: [0, 0], bankY: [0, 0], town: [-1, -1] };
    for (let side = 0; side < 2; side++) {
      const [bx, by] = ground(map, cx + (side === 0 ? -fx(44) : fx(44)), cy);
      c.bankX[side] = bx;
      c.bankY[side] = by;
    }
    crossings.push(c);
    y = last + 1;
  }
  // A settlement belongs to the crossing nearest to it along the river.
  for (let t = 0; t < map.townCount; t++) {
    let best: Crossing | null = null;
    for (const c of crossings) {
      const d = Math.abs(c.y - map.townY[t]);
      if (d < fx(110) && (best === null || d < Math.abs(best.y - map.townY[t]))) best = c;
    }
    if (best === null) continue;
    const side = map.townX[t] < best.x ? 0 : 1;
    if (best.town[side] >= 0) continue;
    best.town[side] = t;
    // Form up in the settlement, not in the water meadow in front of it.
    best.bankX[side] = map.townX[t];
    best.bankY[side] = map.townY[t];
  }
  return crossings;
}

/** Which bank a point is on: 0 west, 1 east. */
function bankOf(ai: Ai, x: number, y: number): number {
  const rx = ai.riverX[clampInt(y >> CELL_SHIFT, 0, MAP_CELLS - 1)];
  if (rx < 0) {
    // No river: the half of the map nearer its own headquarters is "its bank".
    const near = dist(x, y, ai.homeX, ai.homeY) <= dist(x, y, ai.foeX, ai.foeY);
    return near ? ai.side : 1 - ai.side;
  }
  return x >> CELL_SHIFT < rx ? 0 : 1;
}

/** Over the middle of the map: on the enemy's bank, or no nearer its own base than his. */
function across(ai: Ai, x: number, y: number): boolean {
  if (bankOf(ai, x, y) !== ai.side) return true;
  return dist(x, y, ai.homeX, ai.homeY) + fx(60) >= dist(x, y, ai.foeX, ai.foeY);
}

/** First think: find the two headquarters and read the map. False if there is no base. */
function setUp(ai: Ai, w: World): boolean {
  const map = w.map;
  let hq = -1;
  let foe = -1;
  for (let s = 0; s < map.structCount; s++) {
    if (map.sKind[s] !== S_BASE || w.sType[s] !== B_HQ || w.sHp[s] <= 0) continue;
    if (w.sTeam[s] === ai.team && hq < 0) hq = s;
    else if (w.sTeam[s] !== ai.team && w.sTeam[s] !== NO_TEAM && foe < 0) foe = s;
  }
  if (hq < 0 || foe < 0) return false;
  ai.hq = hq;
  ai.enemy = w.sTeam[foe];
  ai.homeX = structX(map, hq);
  ai.homeY = structY(map, hq);
  // Both sides know where the other sets up: the map is the same every game.
  ai.foeX = structX(map, foe);
  ai.foeY = structY(map, foe);
  ai.side = ai.homeX < ai.foeX ? 0 : 1;
  ai.fwd = ai.side === 0 ? 1 : -1;
  // A map without a river says itself which ways lead across; they are used like fords.
  ai.crossings = map.lanes.length > 0 ? map.lanes : findCrossings(map, ai.riverX);
  ai.lanes = map.lanes.length > 0;
  ai.houses = [];
  ai.garr = [];
  for (let t = 0; t < map.townCount; t++) {
    // The front of a settlement is the side its twin across the river is on.
    const twin = t ^ 1;
    const fxp = twin < map.townCount ? map.townX[twin] : ai.foeX;
    const fyp = twin < map.townCount ? map.townY[twin] : ai.foeY;
    const list: number[] = [];
    for (let s = 0; s < map.structCount; s++) {
      if (map.sKind[s] === S_BUILDING && map.sTown[s] === t) list.push(s);
    }
    list.sort(
      (a, b) =>
        dist(structX(map, a), structY(map, a), fxp, fyp) -
          dist(structX(map, b), structY(map, b), fxp, fyp) || a - b,
    );
    ai.houses.push(list);
    ai.garr.push([]);
  }
  ai.stageX = ai.homeX + ai.fwd * fx(40);
  ai.stageY = ai.homeY;
  ai.ready = true;
  return true;
}

// ---------------------------------------------------------------- perception

/**
 * Look at the world: sort its own units by job, and note which enemies are in sight. An
 * enemy is in sight if the sim says someone has it spotted, or if it stands in the open
 * right next to the AI's own troops.
 */
function perceive(ai: Ai, w: World): void {
  const n = w.count;
  const tick = w.tick;
  const map = w.map;
  eyes.fill(0);
  ai.have.fill(0);
  ai.trucks.length = 0;
  ai.fresh.length = 0;
  ai.reserve.length = 0;
  ai.joining.length = 0;
  ai.scouts.length = 0;
  ai.sappers.length = 0;
  ai.members[0].length = 0;
  ai.members[1].length = 0;
  ai.loaded.length = 0;
  ai.aboard[0] = 0;
  ai.aboard[1] = 0;
  for (const g of ai.garr) g.length = 0;
  for (let i = 0; i < n; i++) {
    if (w.state[i] !== STATE_ALIVE || w.team[i] !== ai.team) {
      ai.role[i] = R_NONE;
      ai.post[i] = -1;
      continue;
    }
    const kind = w.kind[i];
    ai.have[kind]++;
    eyes[square(w.posX[i], w.posY[i])] = 1;
    if (kind === KIND_TRUCK) {
      ai.trucks.push(i);
      continue;
    }
    if (ai.roleKind[i] !== kind) {
      ai.role[i] = R_NONE;
      ai.post[i] = -1;
      ai.roleKind[i] = kind;
    }
    if (w.load[i] > 0) ai.loaded.push(i);
    if (w.carrier[i] >= 0) {
      // Riding: out of reach of orders, but still part of the body it set out with.
      const r = ai.role[i];
      if (r === R_ARMY || r === R_RAID) {
        ai.aboard[r === R_ARMY ? 0 : 1] += Math.trunc((POWER[kind] * w.hp[i]) / KINDS[kind].hp);
      }
      continue;
    }
    const role = ai.role[i];
    if (role === R_NONE) ai.fresh.push(i);
    else if (role === R_RESERVE) ai.reserve.push(i);
    else if (role === R_ARMY) ai.members[0].push(i);
    else if (role === R_RAID) ai.members[1].push(i);
    else if (role === R_SCOUT) ai.scouts.push(i);
    else if (role === R_JOIN) ai.joining.push(i);
    else if (role === R_SAPPER) ai.sappers.push(i);
    else if (role - R_TOWN < ai.garr.length) ai.garr[role - R_TOWN].push(i);
    else ai.role[i] = R_NONE;
  }
  for (let s = 0; s < map.structCount; s++) {
    if (w.sTeam[s] === ai.team && w.sHp[s] > 0) eyes[square(structX(map, s), structY(map, s))] = 1;
  }
  // A square is watched if the AI has someone in it or next to it.
  for (let y = 0; y < CD; y++) {
    for (let x = 0; x < CD; x++) {
      let on = 0;
      for (let dy = -1; dy <= 1 && on === 0; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < CD && ny < CD && eyes[ny * CD + nx] !== 0) on = 1;
        }
      }
      watched[y * CD + x] = on;
    }
  }
  scratch.fill(0);
  mixNow.fill(0);
  ai.seen.length = 0;
  for (let i = 0; i < n; i++) {
    if (w.state[i] !== STATE_ALIVE || w.team[i] === ai.team || w.carrier[i] >= 0) continue;
    const c = square(w.posX[i], w.posY[i]);
    if (w.spotted[i] <= tick && (watched[c] === 0 || concealed(w, i))) continue;
    const kind = w.kind[i];
    ai.seen.push(i);
    mixNow[kind]++;
    let p = Math.trunc((POWER[kind] * w.hp[i]) / KINDS[kind].hp) + 1;
    if (w.inside[i] >= 0) {
      // Troops in a house are worth twice their number to whoever has to get them out.
      p *= 2;
      ai.occupied[w.inside[i]] = tick + 3 * MINUTE;
    }
    scratch[c] += p;
    eyes[c] |= 2;
  }
  const fade = tick % (20 * TICK_RATE) < ai.tune.period >> 1;
  for (let c = 0; c < CC; c++) {
    if (watched[c] !== 0 || (eyes[c] & 2) !== 0) {
      ai.threat[c] = scratch[c];
      ai.seenAt[c] = tick;
    } else if (fade) {
      ai.threat[c] -= ai.threat[c] >> 3;
    }
  }
  const forget = tick % (10 * TICK_RATE) < ai.tune.period >> 1;
  for (let k = 0; k < KIND_COUNT; k++) {
    if (forget && ai.foeMix[k] > 0) ai.foeMix[k]--;
    if (mixNow[k] > ai.foeMix[k]) ai.foeMix[k] = mixNow[k];
  }
  for (let s = 0; s < map.structCount; s++) {
    if (w.sTeam[s] === NO_TEAM || w.sTeam[s] === ai.team || ai.known[s] !== 0) continue;
    if (watched[square(structX(map, s), structY(map, s))] !== 0) ai.known[s] = 1;
  }
  // Enemy field works: the ones standing where it has looked lately.
  let works = 0;
  for (let k = 0; k < w.workCount; k++) {
    const c = w.workCells[k];
    if (w.wTeam[c] === ai.team || !workStands(w, c) || w.wKind[c] >= WORK_TRENCH) continue;
    if (tick - ai.seenAt[square(cellX(c), cellY(c))] < 4 * MINUTE) works++;
  }
  ai.foeWorks = works;
  for (let t = 0; t < map.townCount; t++) if (w.townOwner[t] === ai.team) ai.held[t] = 1;
  // Old defeats fade: the enemy who stopped it then may be somewhere else by now.
  if (tick % MINUTE < ai.tune.period >> 1) {
    for (let k = 0; k <= MAX_TOWNS; k++) ai.grudge[k] -= ai.grudge[k] >> 3;
  }
}

/**
 * Enemy strength the AI expects within `r` squares of a point: what it last saw there, or,
 * for squares it has not looked at for three minutes, a share of `assumed`.
 */
function expect(ai: Ai, w: World, x: number, y: number, r: number, assumed: number): number {
  const cx = clampInt(x >> CS, 0, CD - 1);
  const cy = clampInt(y >> CS, 0, CD - 1);
  let sum = 0;
  let blind = 0;
  let cells = 0;
  for (let j = cy - r; j <= cy + r; j++) {
    for (let i = cx - r; i <= cx + r; i++) {
      if (i < 0 || j < 0 || i >= CD || j >= CD) continue;
      cells++;
      const c = j * CD + i;
      if (w.tick - ai.seenAt[c] > 3 * MINUTE) blind++;
      else sum += ai.threat[c];
    }
  }
  return cells === 0 ? 0 : sum + Math.trunc((assumed * blind) / cells);
}

function strength(w: World, units: readonly number[]): number {
  let sum = 0;
  for (let k = 0; k < units.length; k++) {
    const i = units[k];
    sum += Math.trunc((POWER[w.kind[i]] * w.hp[i]) / KINDS[w.kind[i]].hp);
  }
  return sum;
}

/** Where a body of troops is: the middle of its line units (of all of them, if it has none). */
function centre(w: World, units: readonly number[]): [number, number] {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let pass = 0; pass < 2 && n === 0; pass++) {
    for (let k = 0; k < units.length; k++) {
      const i = units[k];
      if (pass === 0 && !LINE[w.kind[i]]) continue;
      sx += w.posX[i];
      sy += w.posY[i];
      n++;
    }
  }
  return n === 0 ? [0, 0] : [Math.trunc(sx / n), Math.trunc(sy / n)];
}

// ---------------------------------------------------------------- economy

const DEPOT_REACH = fx(60);
/** A depot this near a stockpile makes the trucks' trips short. */
const DEPOT_CLOSE = fx(30);

function canPay(w: World, team: number, p: Price, s: number, f: number, c: number): boolean {
  return (
    w.supplies[team] - s >= p.supplies &&
    w.fuel[team] - f >= p.fuel &&
    w.credits[team] - c >= p.credits
  );
}

function finished(w: World, s: number): boolean {
  return w.sBuild[s] >= BUILDINGS[w.sType[s]].ticks;
}

/** A plot for a building near cell (cx, cy) that leaves a lane on every side, or -1. */
function findPlot(w: World, type: number, cx: number, cy: number, reach: number): number {
  const b = BUILDINGS[type];
  const map = w.map;
  return findCell(cx, cy, reach, (x, y) => {
    if (x < 5 || y < 5 || x + b.w > MAP_CELLS - 5 || y + b.h > MAP_CELLS - 5) return false;
    if (!canPlace(map, x, y, b.w, b.h)) return false;
    for (let j = y - 3; j <= y + b.h + 2; j++) {
      for (let i = x - 3; i <= x + b.w + 2; i++) {
        const t = map.type[j * MAP_CELLS + i];
        if (t !== T_OPEN && t !== T_FOREST) return false;
      }
    }
    return true;
  });
}

/** The `n` trucks nearest a point that are not already building something. */
function nearestTrucks(ai: Ai, w: World, x: number, y: number, n: number): number[] {
  const free = ai.trucks.filter((i) => w.job[i] !== JOB_BUILD);
  free.sort((a, b) => dist(w.posX[a], w.posY[a], x, y) - dist(w.posX[b], w.posY[b], x, y) || a - b);
  return free.slice(0, n);
}

function economy(ai: Ai, w: World, out: Command[]): void {
  const map = w.map;
  const team = ai.team;
  const tune = ai.tune;
  const tick = w.tick;
  const count = new Array<number>(BUILDINGS.length).fill(0);
  const drops: number[] = [];
  const rising: number[] = [];
  const hurt: number[] = [];
  let researching = false;
  let risingDepots = 0;
  let queuedTrucks = 0;
  let busy = true;
  for (let s = 0; s < map.structCount; s++) {
    if (w.sTeam[s] !== team || w.sHp[s] <= 0) continue;
    const type = w.sType[s];
    count[type]++;
    if (!finished(w, s)) {
      rising.push(s);
      if (type === B_DEPOT) risingDepots++;
      continue;
    }
    if (BUILDINGS[type].dropOff) drops.push(s);
    if (w.sHp[s] * 10 < map.sMaxHp[s] * 6) hurt.push(s);
    if (type !== B_HQ && type !== B_DEPOT && w.sQueueLen[s] === 0) busy = false;
    for (let q = 0; q < w.sQueueLen[s]; q++) {
      const item = w.sQueue[s * QUEUE_MAX + q];
      if (item === TIER_ITEM) researching = true;
      else if (item === KIND_TRUCK) queuedTrucks++;
    }
  }

  // Sites: which can be worked (a depot in reach, no enemy about) and by how many trucks.
  perSite.fill(0);
  let capTotal = 0;
  let expand = -1;
  let expandD = 0;
  let feeder = -1;
  let feederStock = 0;
  for (let k = 0; k < map.siteCount; k++) {
    const fuel = map.siteKind[k] === SITE_FUEL;
    const sx = map.siteX[k];
    const sy = map.siteY[k];
    let served = false;
    let close = false;
    for (const d of drops) {
      const d2 = structDist2(w, d, sx, sy);
      if (d2 <= DEPOT_REACH * DEPOT_REACH) served = true;
      if (d2 <= DEPOT_CLOSE * DEPOT_CLOSE) close = true;
    }
    for (const d of rising) {
      if (w.sType[d] !== B_DEPOT) continue;
      if (structDist2(w, d, sx, sy) <= DEPOT_CLOSE * DEPOT_CLOSE) close = true;
    }
    const alive = fuel || w.siteStock[k] > 0;
    const safe = ai.siteBad[k] <= tick;
    ai.siteCap[k] = alive && served && safe ? (fuel ? (w.fuel[team] > 900 ? 1 : 3) : 8) : 0;
    capTotal += ai.siteCap[k];
    // A stockpile it works from far off: most of each trip is the drive. A depot beside
    // it pays for itself within a minute or two, so the richest such stockpile gets one.
    if (
      !fuel &&
      served &&
      safe &&
      !close &&
      w.siteStock[k] > 1500 &&
      w.siteStock[k] > feederStock
    ) {
      feeder = k;
      feederStock = w.siteStock[k];
    }
    if (served || fuel || !alive || !safe || bankOf(ai, sx, sy) !== ai.side) continue;
    if (expect(ai, w, sx, sy, 2, 0) > 0) continue;
    const d = dist(sx, sy, ai.homeX, ai.homeY);
    if (expand < 0 || d < expandD) {
      expand = k;
      expandD = d;
    }
  }
  const idle: number[] = [];
  for (const i of ai.trucks) {
    const job = w.job[i];
    if (job === JOB_BUILD) continue;
    // Idle, or one too many on its site (a site that has run dry or come under fire takes
    // none): to be placed again.
    if (job === JOB_NONE || perSite[w.jobSite[i]] >= ai.siteCap[w.jobSite[i]]) idle.push(i);
    else perSite[w.jobSite[i]]++;
  }
  const wantFuel = count[B_BARRACKS] + count[B_WORKS] > 0 && w.fuel[team] < 500;
  if (wantFuel && idle.length === 0) {
    // A well nobody empties is fuel thrown away: take a truck off the busiest stockpile.
    let well = -1;
    let from = -1;
    for (let k = 0; k < map.siteCount; k++) {
      if (map.siteKind[k] === SITE_FUEL) {
        if (perSite[k] < ai.siteCap[k] && well < 0) well = k;
      } else if (perSite[k] > 2 && (from < 0 || perSite[k] > perSite[from])) from = k;
    }
    if (well >= 0 && from >= 0) {
      for (const i of ai.trucks) {
        if (w.job[i] === JOB_BUILD || w.job[i] === JOB_NONE || w.jobSite[i] !== from) continue;
        if (w.cargo[i] > 0) continue;
        idle.push(i);
        perSite[from]--;
        break;
      }
    }
  }
  // Fuel first once there is something to spend it on, then the nearest stockpile.
  const batches = new Map<number, number[]>();
  let unplaced = 0;
  for (const i of idle) {
    let best = -1;
    let bestD = 0;
    for (let pass = wantFuel ? 0 : 1; pass < 3 && best < 0; pass++) {
      for (let k = 0; k < map.siteCount; k++) {
        if (perSite[k] >= ai.siteCap[k]) continue;
        if ((map.siteKind[k] === SITE_FUEL) !== (pass !== 1)) continue;
        const d = dist(w.posX[i], w.posY[i], map.siteX[k], map.siteY[k]);
        if (best < 0 || d < bestD) {
          best = k;
          bestD = d;
        }
      }
    }
    if (best < 0) {
      unplaced++;
      continue;
    }
    perSite[best]++;
    const list = batches.get(best);
    if (list) list.push(i);
    else batches.set(best, [i]);
  }
  for (const [site, units] of batches) out.push({ type: CMD_GATHER, units, site });

  let s0 = 0;
  let f0 = 0;
  let c0 = 0;
  const hqDone = finished(w, ai.hq);
  const trucksAll = ai.trucks.length + queuedTrucks;
  const truckTarget = clampInt(capTotal + 1, 6, tune.trucks);
  if (
    hqDone &&
    trucksAll < truckTarget &&
    w.sQueueLen[ai.hq] < 2 &&
    w.pop[team] + POINTS[KIND_TRUCK] <= w.popCap[team] &&
    canPay(w, team, UNIT_PRICE[KIND_TRUCK], 0, 0, 0)
  ) {
    out.push({ type: CMD_TRAIN, structure: ai.hq, kind: KIND_TRUCK });
    s0 += UNIT_PRICE[KIND_TRUCK].supplies;
  }

  // Building sites and damaged buildings get trucks; nothing new goes up meanwhile.
  const crew = new Int32Array(map.structCount);
  for (const i of ai.trucks) if (w.job[i] === JOB_BUILD) crew[w.jobStruct[i]]++;
  for (const s of rising) {
    if (crew[s] >= tune.builders) continue;
    const units = nearestTrucks(ai, w, structX(map, s), structY(map, s), tune.builders - crew[s]);
    if (units.length > 0) out.push({ type: CMD_ASSIST, units, structure: s });
  }
  if (ai.alarm === null) {
    for (const s of hurt) {
      if (crew[s] > 0) continue;
      const units = nearestTrucks(ai, w, structX(map, s), structY(map, s), 1);
      if (units.length > 0) out.push({ type: CMD_ASSIST, units, structure: s });
    }
  }

  ai.resS = 0;
  ai.resF = 0;
  ai.resC = 0;
  const hx = map.sX[ai.hq];
  const hy = map.sY[ai.hq];
  const minute = Math.trunc(tick / MINUTE);
  const factories = count[B_BARRACKS] + count[B_WORKS] + count[B_DRONES];
  // What to put up next, and where: the first thing on this list that is missing.
  let type = -1;
  let px = hx + ai.fwd * 9;
  let py = hy;
  let reach = 30;
  const atSite = (k: number) => {
    // Between the stockpile and the well that goes with it, so one depot serves both.
    let mx = map.siteX[k] + (ai.homeX > map.siteX[k] ? fx(16) : -fx(16));
    let my = map.siteY[k];
    for (let o = 0; o < map.siteCount; o++) {
      if (map.siteKind[o] !== SITE_FUEL) continue;
      if (dist(map.siteX[o], map.siteY[o], map.siteX[k], map.siteY[k]) > fx(80)) continue;
      mx = (map.siteX[o] + map.siteX[k]) >> 1;
      my = (map.siteY[o] + map.siteY[k]) >> 1;
    }
    px = (mx >> CELL_SHIFT) - 1;
    py = (my >> CELL_SHIFT) - 1;
  };
  // Short of fuel with supplies to spare: the next well is worth a depot.
  const dry = count[B_WORKS] > 0 && w.fuel[team] < 150 && w.supplies[team] > 400;
  if (count[B_BARRACKS] === 0) type = B_BARRACKS;
  else if (feeder >= 0 && perSite[feeder] >= 2) {
    type = B_DEPOT;
    px = (map.siteX[feeder] >> CELL_SHIFT) - 1;
    py = (map.siteY[feeder] >> CELL_SHIFT) - 1;
    reach = 6;
  } else if (
    w.popCap[team] < Math.min(POP_MAX, ai.tune.size) &&
    w.pop[team] + 40 >= w.popCap[team] + 40 * risingDepots
  ) {
    type = B_DEPOT;
    if (expand >= 0) atSite(expand);
    else px = hx - ai.fwd * 8;
  } else if (
    expand >= 0 &&
    (unplaced > 0 || trucksAll >= capTotal || dry) &&
    ai.trucks.length >= 7
  ) {
    type = B_DEPOT;
    atSite(expand);
  } else if (count[B_WORKS] === 0 && ai.trucks.length >= 7) type = B_WORKS;
  else if (w.tier[team] >= 2 && count[B_DRONES] === 0) type = B_DRONES;
  else if (count[B_BARRACKS] < 2 && minute >= 4 && factories < tune.factories) type = B_BARRACKS;
  else if (factories < tune.factories && busy && w.supplies[team] >= 500) {
    // More of whatever it can keep fed: a motor pool only where there is fuel for it.
    type = count[B_WORKS] <= count[B_BARRACKS] && w.fuel[team] >= 250 ? B_WORKS : B_BARRACKS;
    if (w.tier[team] >= 2 && count[B_DRONES] < 2 && w.credits[team] > 400) type = B_DRONES;
  }
  // One building at a time, except that a depot never waits for another building.
  // A rich army held back only by its unit limit puts up two depots at a time.
  const depotsAtOnce = w.supplies[team] > 800 ? 2 : 1;
  const free = type === B_DEPOT ? risingDepots < depotsAtOnce : rising.length === risingDepots;
  if (type >= 0 && free && BUILDINGS[type].tier <= w.tier[team]) {
    const b = BUILDINGS[type];
    if (canPay(w, team, b, s0, 0, 0)) {
      const plot = findPlot(w, type, px, py, reach);
      if (plot >= 0) {
        const x = plot % MAP_CELLS;
        const y = Math.trunc(plot / MAP_CELLS);
        const units = nearestTrucks(ai, w, cellX(plot), cellY(plot), tune.builders);
        if (units.length > 0) {
          out.push({ type: CMD_BUILD, units, building: type, x, y });
          s0 += b.supplies;
          f0 += b.fuel;
          c0 += b.credits;
          ai.plan = `build ${b.name}`;
        }
      }
    } else {
      ai.resS = b.supplies;
      ai.resF = b.fuel;
      ai.resC = b.credits;
    }
  }

  // Technology: as soon as the towns have paid for it and there is an army to use it.
  if (w.tier[team] < MAX_TIER && hqDone && !researching) {
    const p = TIER_PRICE[w.tier[team]];
    const due = w.tier[team] === 1 ? count[B_BARRACKS] > 0 : count[B_WORKS] > 0 && minute >= 6;
    if (p && due) {
      if (canPay(w, team, p, s0, f0, c0) && w.sQueueLen[ai.hq] < QUEUE_MAX) {
        out.push({ type: CMD_RESEARCH, structure: ai.hq });
        ai.plan = `research tier ${w.tier[team] + 1}`;
      } else if (w.credits[team] >= p.credits) {
        if (p.supplies > ai.resS) ai.resS = p.supplies;
        if (p.fuel > ai.resF) ai.resF = p.fuel;
        ai.resC += p.credits;
      }
    }
  }
}

// ---------------------------------------------------------------- production

/** The army it wants, as weights per unit type, from its technology and the enemy seen. */
function wantedMix(ai: Ai, w: World): void {
  const tier = w.tier[ai.team];
  want.fill(0);
  // Roughly by head count: a mass of rifles and missile teams, a few carriers, and tanks
  // as the scarce asset (about one unit in ten) since they cost five army points each.
  if (tier === 1) {
    want[KIND_INFANTRY] = 62;
    want[KIND_ATGM] = 18;
    want[KIND_IFV] = 20;
  } else {
    want[KIND_INFANTRY] = 48;
    want[KIND_ATGM] = 18;
    want[KIND_IFV] = 12;
    want[KIND_TANK] = 10;
    want[KIND_AD] = 3;
    want[KIND_STRIKE] = 6;
    if (tier >= 3) {
      want[KIND_ARTILLERY] = 4;
      want[KIND_EW] = 1;
    }
  }
  if (!ai.tune.counter) return;
  const foe = ai.foeMix;
  const armour = 2 * foe[KIND_TANK] + foe[KIND_IFV] + foe[KIND_ARTILLERY] + foe[KIND_AD];
  const foot = foe[KIND_INFANTRY] + foe[KIND_ATGM];
  const air = foe[KIND_DRONE] + foe[KIND_STRIKE];
  let dug = 0;
  for (let s = 0; s < w.map.structCount; s++) if (ai.occupied[s] > w.tick && w.sHp[s] > 0) dug++;
  if (armour > foot && armour >= 4) {
    // Armour: missiles from cover, and drones on its roof.
    want[KIND_ATGM] += 10;
    want[KIND_TANK] += 2;
    want[KIND_STRIKE] += 4;
    want[KIND_INFANTRY] -= 8;
  } else if (foot > 2 * armour && foot >= 6) {
    // Infantry: autocannon and shells.
    want[KIND_IFV] += 8;
    want[KIND_ARTILLERY] += 3;
    want[KIND_TANK] -= 4;
  }
  if (air >= 2) {
    want[KIND_AD] += 5;
    want[KIND_EW] += 2;
  }
  if (dug >= 3) {
    // A dug-in enemy (houses today, field works later) is a job for guns.
    want[KIND_ARTILLERY] += 5;
    want[KIND_TANK] += 2;
  }
  if (ai.foeWorks >= 6) {
    // Wire and walls in the way: charges, and guns to shoot the gaps.
    want[KIND_ENGINEER] += 5;
    want[KIND_ARTILLERY] += 4;
    want[KIND_TANK] += 2;
  }
  for (let k = 0; k < KIND_COUNT; k++) {
    if (want[k] < 0 || UNIT_PRICE[k].tier > tier) want[k] = 0;
  }
}

function production(ai: Ai, w: World, out: Command[]): void {
  const map = w.map;
  const team = ai.team;
  const have = ai.have.slice();
  const lines: number[] = [];
  let queued = 0;
  for (let s = 0; s < map.structCount; s++) {
    if (w.sTeam[s] !== team || w.sHp[s] <= 0 || !finished(w, s)) continue;
    for (let q = 0; q < w.sQueueLen[s]; q++) {
      const item = w.sQueue[s * QUEUE_MAX + q];
      if (item === TIER_ITEM) continue;
      have[item]++;
      queued += POINTS[item];
    }
    if (w.sType[s] !== B_HQ && w.sType[s] !== B_DEPOT) lines.push(s);
  }
  wantedMix(ai, w);
  let sumWant = 0;
  let total = 0;
  for (let k = 0; k < KIND_COUNT; k++) {
    sumWant += want[k];
    if (want[k] > 0) total += have[k];
  }
  const tier = w.tier[team];
  const scouts = 2 + (tier >= 2 ? 1 : 0) + (ai.level === 'hard' ? 1 : 0);
  const drones = tier >= 1 && ai.level !== 'recruit' ? (ai.level === 'hard' ? 3 : 2) : 0;
  // Under attack, everything goes into units: the plans can wait.
  const calm = ai.alarm === null;
  const sappers = calm && w.tick > 3 * MINUTE ? ai.tune.sappers : 0;
  let s0 = calm ? ai.resS : 0;
  let f0 = calm ? ai.resF : 0;
  let c0 = calm ? ai.resC : 0;
  let room = Math.min(w.popCap[team], ai.tune.size) - w.pop[team] - queued;
  if (calm && Math.trunc(w.tick / ai.tune.period) % ai.tune.slow !== 0) room = 0;
  for (const s of lines) {
    if (room <= 0) break;
    if (w.sQueueLen[s] >= ai.tune.queue) continue;
    let best = -1;
    let bestScore = 0;
    for (let k = 0; k < KIND_COUNT; k++) {
      const p = UNIT_PRICE[k];
      if (p.from !== w.sType[s] || p.tier > tier || !canPay(w, team, p, s0, f0, c0)) continue;
      if (POINTS[k] > room) continue;
      let score = want[k] * (total + 10) - have[k] * sumWant;
      if (k === KIND_RECON || k === KIND_DRONE) {
        // Eyes are bought by the head, not as a share of the army.
        if (have[k] >= (k === KIND_RECON ? scouts : drones)) continue;
        score = 1 << 20;
      } else if (k === KIND_ENGINEER && have[k] < sappers) {
        // So are the sappers, once there is a town to dig in at.
        score = 1 << 19;
      } else if (want[k] === 0) continue;
      if (best < 0 || score > bestScore) {
        best = k;
        bestScore = score;
      }
    }
    // Nothing it is short of: still spend a full purse rather than sit on it.
    if (best < 0 || (bestScore <= 0 && w.supplies[team] - s0 < 700)) continue;
    out.push({ type: CMD_TRAIN, structure: s, kind: best });
    const p = UNIT_PRICE[best];
    s0 += p.supplies;
    f0 += p.fuel;
    c0 += p.credits;
    have[best]++;
    total++;
    room -= POINTS[best];
  }
  // New units report to the staging area.
  for (const s of lines) {
    if (dist(w.sRallyX[s], w.sRallyY[s], ai.stageX, ai.stageY) > fx(12)) {
      out.push({ type: CMD_RALLY, structure: s, x: ai.stageX, y: ai.stageY });
    }
  }
}

// ---------------------------------------------------------------- military

function military(ai: Ai, w: World, out: Command[]): void {
  const map = w.map;
  // The staging area: behind the central settlement while it is safe, else at the base.
  const tc = ai.side;
  ai.stageX = ai.homeX + ai.fwd * fx(40);
  ai.stageY = ai.homeY;
  if (tc < map.townCount && w.townOwner[tc] !== ai.enemy) {
    const [sx, sy] = ground(map, map.townX[tc] - ai.fwd * (map.townR[tc] + fx(22)), map.townY[tc]);
    if (expect(ai, w, sx, sy, 2, 0) < 30) {
      ai.stageX = sx;
      ai.stageY = sy;
    }
  }
  ai.alarm = findAlarm(ai, w);
  enlist(ai, w);
  garrisons(ai, w, out);
  scouting(ai, w, out);
  runReserve(ai, w, out);
  runForce(ai, w, out, 0);
  runForce(ai, w, out, 1);
  dismount(ai, w, out);
}

/**
 * Squads get down where the ride ends: at the objective once the assault is on (a carrier
 * that meets the enemy on the way puts them down by itself), and at home after a retreat.
 */
/** A loaded carrier puts its squads down when enemy ground troops are this near. */
const DISMOUNT = fx(52);
function dismount(ai: Ai, w: World, out: Command[]): void {
  const f = ai.forces[0];
  const down: number[] = [];
  for (const i of ai.loaded) {
    const still = (w.flags[i] & FLAG_MOVING) === 0;
    // Enemy ground troops close by: out, before a missile finds the vehicle full.
    let danger = false;
    for (const e of ai.seen) {
      if (KINDS[w.kind[e]].cls === CLASS_AIR || POWER[w.kind[e]] <= 2) continue;
      if (dist(w.posX[e], w.posY[e], w.posX[i], w.posY[i]) < DISMOUNT) {
        danger = true;
        break;
      }
    }
    if (danger) {
      down.push(i);
      continue;
    }
    if (ai.role[i] === R_ARMY && f.state === F_MARCH) continue;
    if (ai.role[i] === R_ARMY && f.state === F_ASSAULT && f.obj !== null) {
      if (still || dist(w.posX[i], w.posY[i], f.obj.x, f.obj.y) < fx(70)) down.push(i);
    } else if (still) down.push(i);
  }
  if (down.length > 0) out.push({ type: CMD_UNLOAD, units: down });
}

function order(out: Command[], type: number, units: number[], x: number, y: number): void {
  if (units.length === 0) return;
  if (type === CMD_MOVE) out.push({ type: CMD_MOVE, units, x, y });
  else out.push({ type: CMD_ATTACK_MOVE, units, x, y });
}

/** Squads it wants in a town. */
function wantedIn(ai: Ai, w: World, t: number): number {
  const map = w.map;
  const owner = w.townOwner[t];
  let g = ai.tune.garrison + Math.min(ai.tune.garrison, Math.trunc(w.tick / (4 * MINUTE)));
  if (t < 2) g += g >> 1;
  if (bankOf(ai, map.townX[t], map.townY[t]) !== ai.side) {
    return owner === ai.team ? Math.max(3, g >> 1) : 0;
  }
  // A cautious opponent holds the town at its gate and little else until it has attacked.
  if (ai.attacks === 0 && owner !== ai.team && ai.tune.reach < 9) {
    const d = dist(map.townX[t], map.townY[t], ai.homeX, ai.homeY);
    let nearer = 0;
    for (let o = 0; o < map.townCount; o++) {
      if (o === t || bankOf(ai, map.townX[o], map.townY[o]) !== ai.side) continue;
      const od = dist(map.townX[o], map.townY[o], ai.homeX, ai.homeY);
      if (od < d || (od === d && o < t)) nearer++;
    }
    if (nearer > ai.tune.reach) return 0;
  }
  // Its own bank. A town the enemy has taken is the army's business, not the garrison's.
  if (owner === ai.enemy && expect(ai, w, map.townX[t], map.townY[t], 2, 0) > 16) return 0;
  if (ai.alarm !== null && ai.alarm.town === t) g += g >> 1;
  return g;
}

// ---------------------------------------------------------------- field works

const isCoverCell = (map: GameMap, c: number) => map.type[c] >= T_SANDBAG - 1;

/**
 * A belt across the enemy's way to (x, y): wire, tank obstacles one cell behind it, gaps
 * two cells wide every seven so that nobody (the AI's own army least of all) is shut in or
 * out, and sandbags behind each gap. `half` is half its length in cells.
 */
function belt(
  ai: Ai,
  w: World,
  x: number,
  y: number,
  half: number,
  wire: number[],
  traps: number[],
  bags: number[],
): boolean {
  const map = w.map;
  const cx = clampInt(x >> CELL_SHIFT, 4, MAP_CELLS - 5);
  const cy = clampInt(y >> CELL_SHIFT, 4, MAP_CELLS - 5);
  const veh = map.natural[CLASS_VEHICLE];
  let gaps = 0;
  for (let k = -half; k <= half; k++) {
    const yy = cy + k;
    if (yy < 3 || yy >= MAP_CELLS - 3) continue;
    const c = yy * MAP_CELLS + cx;
    const phase = (((k + half) % 7) + 7) % 7;
    if (phase >= 5) {
      if (veh[c] !== 0 && w.wKind[c] === 0) gaps++;
      const b = c - 3 * ai.fwd;
      if (phase === 5 && w.wKind[b] === 0 && canFortify(map, WORK_SANDBAG, b)) bags.push(b);
      continue;
    }
    if (w.wKind[c] === 0 && canFortify(map, WORK_WIRE, c)) wire.push(c);
    const t = c - ai.fwd;
    if (w.wKind[t] === 0 && canFortify(map, WORK_TRAP, t)) traps.push(t);
  }
  return gaps >= 2;
}

/**
 * Field works: the towns it holds get a belt of wire and obstacles on the side the enemy
 * comes from, and so does its bank of a bare ford. Its sappers put them up when nothing is
 * burning, with what money is left over, and mend them when they have been shot up.
 */
function fortify(ai: Ai, w: World, out: Command[]): void {
  const map = w.map;
  const tick = w.tick;
  if (ai.sappers.length === 0 || ai.alarm !== null) return;
  const free = ai.sappers.filter(
    (i) => w.job[i] === JOB_NONE && (w.flags[i] & FLAG_MOVING) === 0 && w.attack[i] === NO_TARGET,
  );
  if (free.length === 0) return;
  let purse = w.supplies[ai.team] - ai.resS - 120;
  if (purse < 60) return;
  const sites = map.townCount + ai.crossings.length;
  for (let k = 0; k < sites && k < ai.fortAt.length; k++) {
    if (ai.fortAt[k] > tick) continue;
    let x: number;
    let y: number;
    let half: number;
    if (k < map.townCount) {
      if (w.townOwner[k] !== ai.team || bankOf(ai, map.townX[k], map.townY[k]) !== ai.side) {
        continue;
      }
      x = map.townX[k] + ai.fwd * (map.townR[k] + fx(14));
      y = map.townY[k];
      half = clampInt((map.townR[k] >> CELL_SHIFT) + 2, 6, 16);
    } else {
      const c = ai.crossings[k - map.townCount];
      if (c.town[ai.side] >= 0 || !ai.tune.traps) continue;
      x = c.bankX[ai.side];
      y = c.bankY[ai.side];
      half = 6;
    }
    if (expect(ai, w, x, y, 1, 0) > 12) continue;
    const wire: number[] = [];
    const traps: number[] = [];
    const bags: number[] = [];
    const open = belt(ai, w, x, y, half, wire, traps, bags);
    ai.fortAt[k] = tick + 4 * MINUTE;
    if (!open) continue;
    if (!ai.tune.traps) traps.length = 0;
    // Sandbags first (the garrison's), then the wire, then the obstacles: as far as the
    // money goes.
    const jobs: [number, number[]][] = [
      [WORK_SANDBAG, bags],
      [WORK_WIRE, wire],
      [WORK_TRAP, traps],
    ];
    let ordered = 0;
    for (const [kind, cells] of jobs) {
      const n = Math.min(cells.length, Math.trunc(purse / WORKS[kind].supplies));
      if (n <= 0) continue;
      cells.length = n;
      purse -= n * WORKS[kind].supplies;
      ordered += n;
      out.push({ type: CMD_FORTIFY, units: free, work: kind, cells });
    }
    if (k < map.townCount && bags.length > 0 && ai.nest[k] < 0) ai.nest[k] = bags[0];
    if (ordered > 0) {
      ai.laid += ordered;
      // Not everything was affordable: look again sooner.
      if (purse < 60) ai.fortAt[k] = tick + MINUTE;
      return;
    }
  }
  // Nothing to do: wait at the staging area.
  const back = free.filter((i) => dist(w.posX[i], w.posY[i], ai.stageX, ai.stageY) > fx(34));
  order(out, CMD_MOVE, back, ai.stageX, ai.stageY);
}

/** Give every new unit a job. */
function enlist(ai: Ai, w: World): void {
  const map = w.map;
  let inTowns = 0;
  const wanted: number[] = [];
  for (let t = 0; t < map.townCount; t++) {
    wanted.push(wantedIn(ai, w, t));
    inTowns += ai.garr[t].length;
    // Too many in a town (it was lost, or the alarm is over): the surplus joins the reserve.
    while (ai.garr[t].length > wanted[t] + 2) {
      const i = ai.garr[t].pop()!;
      ai.role[i] = R_RESERVE;
      ai.reserve.push(i);
      inTowns--;
    }
  }
  const foot = ai.have[KIND_INFANTRY] + ai.have[KIND_ATGM];
  const cap = Math.max(12, Math.trunc((foot * 6) / 10));
  let recon = 0;
  let drones = 0;
  for (const i of ai.scouts) {
    if (w.kind[i] === KIND_RECON) recon++;
    else drones++;
  }
  const tier = w.tier[ai.team];
  const reconPosts = Math.min(2 + (tier >= 2 ? 1 : 0) + (ai.level === 'hard' ? 1 : 0), 4);
  for (const i of ai.fresh) {
    const kind = w.kind[i];
    let role = R_RESERVE;
    if (kind === KIND_RECON && recon < reconPosts) {
      role = R_SCOUT;
      recon++;
    } else if (kind === KIND_DRONE && drones < 3) {
      role = R_SCOUT;
      drones++;
    } else if (kind === KIND_ENGINEER && ai.sappers.length < ai.tune.sappers) {
      role = R_SAPPER;
      ai.sappers.push(i);
    } else if (FOOT(kind) || kind === KIND_RECON) {
      let best = -1;
      let need = 0;
      for (let t = 0; t < map.townCount && inTowns < cap; t++) {
        const d = wanted[t] - ai.garr[t].length;
        if (d > need) {
          need = d;
          best = t;
        }
      }
      if (best >= 0) {
        role = R_TOWN + best;
        ai.garr[best].push(i);
        inTowns++;
      }
    }
    ai.role[i] = role;
    ai.post[i] = -1;
    ai.leg[i] = 0;
    if (role === R_RESERVE) ai.reserve.push(i);
    else if (role === R_SCOUT) ai.scouts.push(i);
  }
  ai.fresh.length = 0;
}

/**
 * Town garrisons go into the houses: the ones facing the crossing first, a few squads to a
 * house so that one collapse does not take the whole garrison, and out of any house that
 * is about to come down.
 */
function garrisons(ai: Ai, w: World, out: Command[]): void {
  const map = w.map;
  pendingIn.fill(0, 0, map.structCount);
  for (let t = 0; t < map.townCount; t++) {
    for (const i of ai.garr[t]) {
      if (w.inside[i] < 0 && (w.flags[i] & FLAG_GARRISON) !== 0) pendingIn[w.orderStruct[i]]++;
    }
  }
  for (let t = 0; t < map.townCount; t++) {
    const batches = new Map<number, number[]>();
    const loose: number[] = [];
    for (const i of ai.garr[t]) {
      const at = w.inside[i];
      if (at >= 0) {
        if (w.sHp[at] * 3 >= map.sMaxHp[at]) continue;
      } else if ((w.flags[i] & FLAG_GARRISON) !== 0) continue;
      let best = -1;
      for (let pass = 0; pass < 2 && best < 0; pass++) {
        for (const s of ai.houses[t]) {
          if (s === at || w.sHp[s] <= 0 || w.sHp[s] * 3 < map.sMaxHp[s]) continue;
          if (w.sOcc[s] > 0 && w.sOccTeam[s] !== ai.team) continue;
          const room = Math.min(map.sW[s] * map.sH[s], GARRISON_MAX, pass === 0 ? 3 : GARRISON_MAX);
          if (w.sOcc[s] + pendingIn[s] >= room) continue;
          best = s;
          break;
        }
      }
      if (best < 0) {
        if (at < 0 && (w.flags[i] & FLAG_MOVING) === 0) loose.push(i);
        continue;
      }
      pendingIn[best]++;
      const list = batches.get(best);
      if (list) list.push(i);
      else batches.set(best, [i]);
    }
    for (const [structure, units] of batches) out.push({ type: CMD_GARRISON, units, structure });
    // No house left to hold: the rubble of the town is cover too.
    const nest = ai.nest[t];
    if (nest >= 0 && map.type[nest] === T_SANDBAG && loose.length > 0) {
      // Unless it has dug positions at the edge: those face the enemy.
      const idle = loose.filter((i) => !isCoverCell(map, cellAt(w.posX[i], w.posY[i])));
      if (idle.length > 0) {
        out.push({ type: CMD_OCCUPY, units: idle, x: cellX(nest), y: cellY(nest) });
      }
      continue;
    }
    const far = loose.filter(
      (i) => dist(w.posX[i], w.posY[i], map.townX[t], map.townY[t]) > map.townR[t] >> 1,
    );
    order(out, CMD_ATTACK_MOVE, far, map.townX[t], map.townY[t]);
  }
}

/** The outer crossing (a bare ford) with the least enemy on its far bank, or -1. */
function quietFord(ai: Ai, w: World, x: number, y: number): number {
  let best = -1;
  let bestCost = 0;
  for (let k = 0; k < ai.crossings.length; k++) {
    const c = ai.crossings[k];
    if (c.town[0] >= 0 || c.town[1] >= 0) continue;
    const far = 1 - ai.side;
    const cost =
      (dist(x, y, c.x, c.y) >> FP_SHIFT) + 6 * expect(ai, w, c.bankX[far], c.bankY[far], 2, 0);
    if (best < 0 || cost < bestCost) {
      best = k;
      bestCost = cost;
    }
  }
  return best;
}

/**
 * Scouts. Recon teams take posts in order: the central crossing, a hide in sight of the
 * enemy base (reached over a quiet outer ford), then the two outer fords. Drones fly a
 * round over the enemy base, his towns and whatever the army is attacking.
 */
function scouting(ai: Ai, w: World, out: Command[]): void {
  const map = w.map;
  const taken = [false, false, false, false];
  let slot = 0;
  for (const i of ai.scouts)
    if (w.kind[i] === KIND_RECON && ai.post[i] >= 0) taken[ai.post[i]] = true;
  const outer = ai.crossings.filter((c) => c.town[0] < 0 && c.town[1] < 0);
  const rounds: number[] = [ai.foeX, ai.foeY];
  for (let t = 0; t < map.townCount; t++) {
    if (bankOf(ai, map.townX[t], map.townY[t]) !== ai.side) rounds.push(map.townX[t], map.townY[t]);
  }
  const obj = ai.forces[0].obj;
  if (obj !== null && ai.forces[0].state !== F_IDLE) rounds.push(obj.x, obj.y, obj.x, obj.y);
  const turn = Math.trunc(w.tick / (30 * TICK_RATE));
  for (const i of ai.scouts) {
    if ((w.flags[i] & FLAG_MOVING) !== 0) continue;
    let tx = ai.stageX;
    let ty = ai.stageY;
    if (w.kind[i] === KIND_DRONE) {
      const k = (slot++ + turn) % (rounds.length >> 1);
      tx = rounds[2 * k];
      ty = rounds[2 * k + 1];
    } else {
      if (ai.post[i] < 0) {
        const free = taken.indexOf(false);
        ai.post[i] = free < 0 ? 0 : free;
        taken[ai.post[i]] = true;
        ai.leg[i] = 0;
      }
      const post = ai.post[i];
      const mid = ai.crossings.find((c) => c.town[ai.side] === ai.side);
      if (post === 0 && mid) {
        tx = mid.bankX[ai.side] + ai.fwd * fx(14);
        ty = mid.bankY[ai.side];
      } else if (post === 1) {
        // Leg 0: over a quiet ford. Leg 1: to a hide short of the enemy base.
        const ford = quietFord(ai, w, w.posX[i], w.posY[i]);
        const far = 1 - ai.side;
        if (ai.leg[i] === 0 && ford >= 0) {
          tx = ai.crossings[ford].bankX[far];
          ty = ai.crossings[ford].bankY[far];
          if (bankOf(ai, w.posX[i], w.posY[i]) === far) ai.leg[i] = 1;
        }
        if (ai.leg[i] === 1 || ford < 0) {
          tx = ai.foeX - ai.fwd * fx(62);
          ty = ai.foeY + (w.posY[i] < ai.foeY ? -fx(30) : fx(30));
        }
      } else if (post >= 2 && post - 2 < outer.length) {
        tx = outer[post - 2].bankX[ai.side];
        ty = outer[post - 2].bankY[ai.side];
      }
    }
    if (dist(w.posX[i], w.posY[i], tx, ty) > fx(10)) order(out, CMD_MOVE, [i], tx, ty);
  }
}

/** The worst intrusion on what the AI holds: its base, its towns, the sites it works. */
function findAlarm(ai: Ai, w: World): Alarm | null {
  if (ai.seen.length === 0) return null;
  const map = w.map;
  // x, y, radius, town or -1, site or -1, base flag: six numbers per asset.
  const assets: number[] = [];
  for (let s = 0; s < map.structCount; s++) {
    if (w.sTeam[s] === ai.team && w.sHp[s] > 0) {
      assets.push(structX(map, s), structY(map, s), fx(55), -1, -1, 1);
    }
  }
  for (let t = 0; t < map.townCount; t++) {
    if (w.townOwner[t] === ai.team || ai.garr[t].length > 0) {
      assets.push(map.townX[t], map.townY[t], map.townR[t] + fx(30), t, -1, 0);
    }
  }
  for (let k = 0; k < map.siteCount; k++) {
    if (ai.siteCap[k] > 0 || ai.siteBad[k] > w.tick) {
      assets.push(map.siteX[k], map.siteY[k], fx(45), -1, k, 0);
    }
  }
  const count = assets.length / 6;
  const sum = new Int32Array(count);
  const sx = new Float64Array(count);
  const sy = new Float64Array(count);
  const num = new Int32Array(count);
  for (const e of ai.seen) {
    const kind = w.kind[e];
    if (POWER[kind] <= 2) continue;
    const x = w.posX[e];
    const y = w.posY[e];
    for (let a = 0; a < count; a++) {
      const r = assets[6 * a + 2];
      const dx = x - assets[6 * a];
      const dy = y - assets[6 * a + 1];
      if (dx * dx + dy * dy > r * r) continue;
      sum[a] += Math.trunc((POWER[kind] * w.hp[e]) / KINDS[kind].hp) + 1;
      sx[a] += x;
      sy[a] += y;
      num[a]++;
      if (assets[6 * a + 4] >= 0) ai.siteBad[assets[6 * a + 4]] = w.tick + 30 * TICK_RATE;
      break;
    }
  }
  let best = -1;
  for (let a = 0; a < count; a++) {
    if (sum[a] === 0) continue;
    // The base outranks everything else.
    const key = sum[a] + (assets[6 * a + 5] !== 0 ? 1000000 : 0);
    if (best < 0 || key > sum[best] + (assets[6 * best + 5] !== 0 ? 1000000 : 0)) best = a;
  }
  if (best < 0) return null;
  return {
    x: Math.trunc(sx[best] / num[best]),
    y: Math.trunc(sy[best] / num[best]),
    threat: sum[best],
    base: assets[6 * best + 5] !== 0,
    town: assets[6 * best + 3],
  };
}

/**
 * The reserve waits at the staging area and goes for whatever sets off an alarm, if it can
 * win there (it always fights for the base).
 */
function runReserve(ai: Ai, w: World, out: Command[]): void {
  const a = ai.alarm;
  const units = ai.reserve.filter((i) => w.kind[i] !== KIND_STRIKE || a !== null);
  if (a !== null && (a.base || strength(w, ai.reserve) * 100 >= a.threat * 70)) {
    const go = units.filter(
      (i) =>
        w.attack[i] === NO_TARGET &&
        dist(w.targetX[i], w.targetY[i], a.x, a.y) > fx(24) &&
        dist(w.posX[i], w.posY[i], a.x, a.y) > fx(12),
    );
    order(out, CMD_ATTACK_MOVE, go, a.x, a.y);
    return;
  }
  const back = ai.reserve.filter(
    (i) =>
      (w.flags[i] & FLAG_MOVING) === 0 &&
      w.attack[i] === NO_TARGET &&
      dist(w.posX[i], w.posY[i], ai.stageX, ai.stageY) > fx(34),
  );
  order(out, CMD_ATTACK_MOVE, back, ai.stageX, ai.stageY);
}

/**
 * The way points from a point to an objective. On the same bank there are none. Across
 * the river: the two banks of the crossing that costs least, counting the distance, the enemy known to
 * stand on its far bank, and an enemy-held settlement in the way. So a defended bridge is
 * turned by a ford, not stormed, unless the bridge town is the objective itself.
 */
function route(ai: Ai, w: World, x: number, y: number, obj: Objective, raid: boolean): number[] {
  const from = bankOf(ai, x, y);
  const to = bankOf(ai, obj.x, obj.y);
  if (from === to || ai.crossings.length === 0) return [];
  let best = -1;
  let bestCost = 0;
  for (let k = 0; k < ai.crossings.length; k++) {
    const c = ai.crossings[k];
    let cost =
      (dist(x, y, c.bankX[from], c.bankY[from]) + dist(c.bankX[to], c.bankY[to], obj.x, obj.y)) >>
      FP_SHIFT;
    cost += 4 * expect(ai, w, c.bankX[to], c.bankY[to], 2, 0);
    const town = c.town[to];
    if (town >= 0 && !(obj.kind === OBJ_TOWN && obj.id === town)) {
      if (w.townOwner[town] === ai.enemy) cost += 150;
      else if (w.townOwner[town] !== ai.team) cost += 40;
    }
    // Raiders keep clear of settlements altogether; the hard AI varies its line of march.
    if (raid && town >= 0) cost += 400;
    if (ai.level === 'hard') cost += nextInt(ai.rng, 40);
    if (ai.lanes) {
      // Several ways, none of them obvious: no two attacks need come the same way, and a
      // raid goes where the army does not.
      cost += nextInt(ai.rng, 220);
      if (raid && k === ai.armyLane) cost += 300;
    }
    if (best < 0 || cost < bestCost) {
      best = k;
      bestCost = cost;
    }
  }
  const c = ai.crossings[best];
  if (!raid) ai.armyLane = best;
  // The way points end short of the objective: the last leg is the assault itself. A
  // town that is its own bridgehead is assaulted straight from the near bank.
  if (dist(c.bankX[to], c.bankY[to], obj.x, obj.y) < fx(60)) return [c.bankX[from], c.bankY[from]];
  return [c.bankX[from], c.bankY[from], c.bankX[to], c.bankY[to]];
}

/**
 * What to attack next with `power`, from (x, y): the objective with the best value for
 * the resistance expected, among those it can expect to take. Null if there is none.
 */
function chooseObjective(ai: Ai, w: World, x: number, y: number, power: number): Objective | null {
  const map = w.map;
  const minute = Math.trunc(w.tick / MINUTE);
  const ratio = ai.tune.ratio;
  let best: Objective | null = null;
  let bestScore = -1000000;
  let fallback: Objective | null = null;
  let fallbackScore = -1000000;
  const consider = (obj: Objective, value: number, need: number) => {
    const score = Math.trunc((value * 2000) / (200 + need)) - (dist(x, y, obj.x, obj.y) >> 13);
    if (power * 100 >= need * ratio) {
      if (score > bestScore) {
        best = obj;
        bestScore = score;
      }
    } else if (power >= need && score > fallbackScore) {
      fallback = obj;
      fallbackScore = score;
    }
  };
  let foeTowns = 0;
  for (let t = 0; t < map.townCount; t++) {
    const owner = w.townOwner[t];
    if (owner === ai.enemy) foeTowns++;
    if (owner === ai.team) continue;
    const mine = bankOf(ai, map.townX[t], map.townY[t]) === ai.side;
    // A town the enemy holds has a garrison whether or not it has shown itself: troops in
    // houses are seen only when they fire.
    const hidden = owner === ai.enemy ? Math.min(260, 50 + 8 * minute) : 0;
    const need = Math.max(
      ai.grudge[t],
      hidden,
      expect(ai, w, map.townX[t], map.townY[t], 3, mine ? 0 : Math.min(160, 8 * minute)),
    );
    let value = 100;
    if (ai.held[t] !== 0) value += 60;
    if (mine) value += 40;
    if (owner === ai.enemy) value += 30;
    consider({ kind: OBJ_TOWN, id: t, x: map.townX[t], y: map.townY[t] }, value, need);
  }
  for (let s = 0; s < map.structCount; s++) {
    if (ai.known[s] === 0 || w.sHp[s] <= 0 || w.sTeam[s] !== ai.enemy) continue;
    const sx = structX(map, s);
    const sy = structY(map, s);
    if (w.sType[s] === B_HQ || dist(sx, sy, ai.foeX, ai.foeY) < fx(110)) continue;
    // An outlying depot: his income, and usually the softest thing he owns.
    consider({ kind: OBJ_POINT, id: s, x: sx, y: sy }, 70, expect(ai, w, sx, sy, 2, 4 * minute));
  }
  // The base last: it is the furthest, a headquarters takes long to bring down, and an
  // enemy who still holds towns pays for a new army while it burns.
  const need = Math.max(
    ai.grudge[MAX_TOWNS],
    100 + 40 * foeTowns + expect(ai, w, ai.foeX, ai.foeY, 4, Math.min(300, 60 + 10 * minute)),
  );
  let value = 60;
  if (foeTowns === 0) value += 150;
  if (w.pop[ai.team] * 10 >= Math.min(w.popCap[ai.team], ai.tune.size) * 9) value += 100;
  if (power > 700) value += 100;
  consider({ kind: OBJ_BASE, id: -1, x: ai.foeX, y: ai.foeY }, value, need);
  if (best !== null) return best;
  // Nothing it is sure of. An army that has grown large and has sat for four minutes goes
  // anyway, for the best of what it at least matches: waiting only helps the defender.
  // (For the small armies of the lower levels "large" is most of what they may keep.)
  const large = Math.min(3 * ai.tune.minArmy, 4 * ai.tune.size);
  if (power >= large && w.tick - ai.lastAttack > 4 * MINUTE) return fallback;
  return null;
}

/** A raid target: a resource site on the enemy bank, away from his base and his troops. */
function raidTarget(ai: Ai, w: World): Objective | null {
  const map = w.map;
  let best: Objective | null = null;
  let bestCost = 0;
  for (let k = 0; k < map.siteCount; k++) {
    const x = map.siteX[k];
    const y = map.siteY[k];
    if (bankOf(ai, x, y) === ai.side) continue;
    if (map.siteKind[k] !== SITE_FUEL && w.siteStock[k] <= 0) continue;
    if (dist(x, y, ai.foeX, ai.foeY) < fx(90)) continue;
    const cost = 10 * expect(ai, w, x, y, 2, 0) + nextInt(ai.rng, 60);
    if (best === null || cost < bestCost) {
      best = { kind: OBJ_POINT, id: -1, x, y };
      bestCost = cost;
    }
  }
  return best;
}

function setOut(ai: Ai, w: World, f: Force, units: number[], obj: Objective): void {
  const [cx, cy] = centre(w, units);
  if (f.role === R_ARMY) {
    const what = ['', 'the base', 'a depot'][obj.kind];
    ai.plan = `attack ${obj.kind === OBJ_TOWN ? w.map.townName[obj.id] : what}`;
  }
  f.obj = obj;
  f.wps = route(ai, w, cx, cy, obj, f.role === R_RAID);
  f.wp = 0;
  f.state = f.wps.length > 0 ? F_MARCH : F_ASSAULT;
  f.since = w.tick;
  f.quiet = 0;
  f.smoked = false;
  f.turned = false;
}

/** Break off. A beaten army remembers what it was beaten with, and comes back with more. */
function retreat(ai: Ai, f: Force, w: World, beaten: boolean): void {
  const obj = f.obj;
  if (beaten && f.role === R_ARMY && obj !== null && obj.kind !== OBJ_POINT) {
    const k = obj.kind === OBJ_TOWN ? obj.id : MAX_TOWNS;
    if (f.launch > ai.grudge[k]) ai.grudge[k] = f.launch;
  }
  if (f.role === R_ARMY) ai.restUntil = w.tick + ai.tune.rest;
  f.state = F_RETREAT;
  f.since = w.tick;
  f.obj = null;
}

/** One think of the field army (which = 0) or the raiding party (1). */
function runForce(ai: Ai, w: World, out: Command[], which: number): void {
  const f = ai.forces[which];
  const units = ai.members[which];
  const raid = which === 1;
  const tick = w.tick;
  const tune = ai.tune;
  if (!raid && (f.state === F_IDLE || f.state === F_RETREAT) && ai.joining.length > 0) {
    for (const i of ai.joining) ai.role[i] = R_RESERVE;
    ai.reserve.push(...ai.joining);
    ai.joining.length = 0;
  }
  if (f.state === F_IDLE) {
    let busy: Set<number> | undefined;
    // Not while the base is under attack or the reserve has its hands full with an intruder.
    const al = ai.alarm;
    if (al !== null && (al.base || al.threat * 3 > strength(w, ai.reserve))) return;
    if (!raid && tick < ai.restUntil) return;
    if (raid) {
      if (tune.raids === 0 || tick < tune.raids || tick - ai.lastRaid < 3 * MINUTE) return;
      const ifvs = ai.reserve.filter(
        (i) => w.kind[i] === KIND_IFV && w.hp[i] * 2 > KINDS[KIND_IFV].hp,
      );
      if (ifvs.length < tune.raidParty) return;
      const obj = raidTarget(ai, w);
      if (obj === null) return;
      const party = ifvs.slice(0, tune.raidParty);
      for (const i of party) ai.role[i] = R_RAID;
      ai.reserve = ai.reserve.filter((i) => ai.role[i] === R_RESERVE);
      f.launch = strength(w, party);
      f.done = 0;
      ai.lastRaid = tick;
      setOut(ai, w, f, party, obj);
      units.push(...party);
      ai.plan = 'raid';
    } else {
      const power = strength(w, ai.reserve);
      if (power < tune.minArmy) return;
      const [cx, cy] = centre(w, ai.reserve);
      const obj = chooseObjective(ai, w, cx, cy, power);
      if (obj === null) return;
      // Across the river only when the time has come; its own bank it clears at once.
      if (across(ai, obj.x, obj.y) && tick < tune.firstAttack) return;
      for (const i of ai.reserve) ai.role[i] = R_ARMY;
      units.push(...ai.reserve);
      ai.reserve.length = 0;
      f.launch = power;
      f.done = 0;
      ai.lastAttack = tick;
      if (across(ai, obj.x, obj.y)) ai.attacks++;
      setOut(ai, w, f, units, obj);
      if (tune.carriers && f.wps.length > 0) busy = mount(w, out, f, units);
    }
    if (f.wps.length > 0) marchOrders(ai, w, out, f, units, true, busy);
    return;
  }
  if (units.length === 0) {
    f.state = F_IDLE;
    f.obj = null;
    return;
  }
  const power = strength(w, units) + ai.aboard[which];
  const [cx, cy] = centre(w, units);
  if (f.state === F_RETREAT) {
    let home = 0;
    for (const i of units) if (dist(w.posX[i], w.posY[i], ai.stageX, ai.stageY) < fx(45)) home++;
    if (home * 10 >= units.length * 6 || tick - f.since > 2 * MINUTE) {
      for (const i of units) ai.role[i] = R_RESERVE;
      f.state = F_IDLE;
      return;
    }
    const lost = units.filter(
      (i) =>
        (w.flags[i] & FLAG_MOVING) === 0 &&
        dist(w.posX[i], w.posY[i], ai.stageX, ai.stageY) > fx(40),
    );
    order(out, CMD_MOVE, lost, ai.stageX, ai.stageY);
    return;
  }
  // Break off: too little left, the enemy in front too strong, or the base calling.
  const local = expect(ai, w, cx, cy, 2, 0);
  const a = ai.alarm;
  if (
    power * 100 < f.launch * tune.breakOff ||
    local > 2 * power + 40 ||
    (local * 10 > power * tune.odds && power * 10 < f.launch * 9) ||
    (a !== null && a.base && a.threat * 2 > 3 * strength(w, ai.reserve) + 20)
  ) {
    retreat(ai, f, w, true);
    order(out, CMD_MOVE, units, ai.stageX, ai.stageY);
    ai.plan = raid ? 'raid breaks off' : 'army falls back';
    return;
  }
  if (!raid) {
    // Reinforcements: a reserve that has grown to a third of the army goes after it, once
    // the army is where it is going (on the march they would only string it out). They
    // count as part of it when they have caught up.
    const more = strength(w, ai.reserve);
    if (a === null && f.state === F_ASSAULT && more >= Math.max(100, Math.trunc(f.launch / 3))) {
      for (const i of ai.reserve) ai.role[i] = R_JOIN;
      order(out, CMD_ATTACK_MOVE, ai.reserve.slice(), cx, cy);
      ai.joining.push(...ai.reserve);
      ai.reserve.length = 0;
    }
    const lagging: number[] = [];
    for (const i of ai.joining) {
      if (dist(w.posX[i], w.posY[i], cx, cy) < fx(50)) {
        ai.role[i] = R_ARMY;
        units.push(i);
        f.launch += Math.trunc((POWER[w.kind[i]] * w.hp[i]) / KINDS[w.kind[i]].hp);
      } else if ((w.flags[i] & FLAG_MOVING) === 0 && w.attack[i] === NO_TARGET) lagging.push(i);
    }
    order(out, CMD_ATTACK_MOVE, lagging, cx, cy);
  }
  if (f.state === F_MARCH) {
    const tx = f.wps[2 * f.wp];
    const ty = f.wps[2 * f.wp + 1];
    let line = 0;
    let there = 0;
    for (const i of units) {
      if (!LINE[w.kind[i]]) continue;
      line++;
      if (dist(w.posX[i], w.posY[i], tx, ty) < fx(38)) there++;
    }
    // Move on when half the line has closed up: an army that arrives in a trickle is
    // beaten in a trickle.
    if (there * 2 >= line || tick - f.since > 75 * TICK_RATE) {
      f.since = tick;
      if (2 * (f.wp + 1) >= f.wps.length) {
        f.state = F_ASSAULT;
        f.quiet = 0;
      } else {
        // On the near bank, about to cross. Look again: if the enemy now stands on the far
        // bank in strength, take another crossing (once), or do not cross at all.
        const nx = f.wps[2 * f.wp + 2];
        const ny = f.wps[2 * f.wp + 3];
        if (!raid && expect(ai, w, nx, ny, 2, 0) * 10 > power * 6) {
          const again = f.turned ? f.wps : route(ai, w, cx, cy, f.obj!, false);
          if (!f.turned && (again[0] !== f.wps[0] || again[1] !== f.wps[1])) {
            f.turned = true;
            f.wps = again;
            f.wp = 0;
            ai.plan = 'army takes another crossing';
          } else {
            retreat(ai, f, w, true);
            order(out, CMD_MOVE, units, ai.stageX, ai.stageY);
            ai.plan = 'army will not cross';
            return;
          }
        } else f.wp++;
        marchOrders(ai, w, out, f, units, true);
        return;
      }
    } else {
      marchOrders(ai, w, out, f, units, false);
      return;
    }
  }
  assault(ai, w, out, f, units, cx, cy, power);
}

/**
 * Mount up for the march: squads board the carriers the army has, the nearest first. The
 * army still keeps together at the pace of whoever walks (a mechanised spearhead that left
 * its walkers behind lost more games than it won in headless matches), but the squads
 * under armour arrive whole and get out when the enemy is near (see `dismount`).
 * Returns the units busy with boarding, to be left out of the march orders of this think.
 */
function mount(w: World, out: Command[], f: Force, units: number[]): Set<number> {
  const carriers: number[] = [];
  let seats = 0;
  let sx = 0;
  let sy = 0;
  for (const i of units) {
    const free = KINDS[w.kind[i]].carry - w.load[i];
    if (free <= 0 || w.hp[i] * 2 < KINDS[w.kind[i]].hp) continue;
    carriers.push(i);
    seats += free;
    sx += w.posX[i];
    sy += w.posY[i];
  }
  const busy = new Set<number>();
  if (seats === 0) return busy;
  sx = Math.trunc(sx / carriers.length);
  sy = Math.trunc(sy / carriers.length);
  const foot = units.filter((i) => FOOT(w.kind[i]) && w.inside[i] < 0);
  if (foot.length === 0) return busy;
  foot.sort(
    (a, b) => dist(w.posX[a], w.posY[a], sx, sy) - dist(w.posX[b], w.posY[b], sx, sy) || a - b,
  );
  const riders = foot.slice(0, seats);
  out.push({ type: CMD_LOAD, units: riders, carriers });
  for (const i of riders) busy.add(i);
  for (const i of carriers) busy.add(i);
  f.boardUntil = w.tick + 30 * TICK_RATE;
  return busy;
}

/** Orders for the march: the line attack-moves on the way point, the rest keep behind it. */
function marchOrders(
  ai: Ai,
  w: World,
  out: Command[],
  f: Force,
  units: number[],
  all: boolean,
  busy?: Set<number>,
): void {
  const tx = f.wps[2 * f.wp];
  const ty = f.wps[2 * f.wp + 1];
  // While the squads mount, they and the carriers they are walking to are left alone.
  const boarding = w.tick < f.boardUntil;
  const awaited = new Set<number>();
  if (boarding) {
    for (const i of units) if ((w.flags[i] & FLAG_BOARD) !== 0) awaited.add(w.orderUnit[i]);
  }
  const line = units.filter((i) => {
    if (!LINE[w.kind[i]] || busy?.has(i)) return false;
    if ((w.flags[i] & FLAG_BOARD) !== 0) return !boarding;
    if (awaited.has(i)) return false;
    return (
      all ||
      ((w.flags[i] & FLAG_MOVING) === 0 &&
        w.attack[i] === NO_TARGET &&
        dist(w.posX[i], w.posY[i], tx, ty) > fx(30))
    );
  });
  order(out, CMD_ATTACK_MOVE, line, tx, ty);
  const [cx, cy] = centre(w, units);
  follow(ai, w, out, units, cx, cy);
}

/**
 * The troops that do not fight in the line. Guns and strike drones wait a little behind
 * it, jammers and scouts in the middle of it. Strike drones go in when there is a vehicle
 * worth one: a gun, a jammer, air defence, a tank.
 */
function follow(ai: Ai, w: World, out: Command[], units: number[], cx: number, cy: number): void {
  const d = dist(cx, cy, ai.stageX, ai.stageY);
  const bx = d < fx(30) ? cx : cx + Math.trunc(((ai.stageX - cx) * fx(24)) / d);
  const by = d < fx(30) ? cy : cy + Math.trunc(((ai.stageY - cy) * fx(24)) / d);
  const mid: number[] = [];
  const rear: number[] = [];
  const strikes: number[] = [];
  for (const i of units) {
    const kind = w.kind[i];
    if (LINE[kind]) continue;
    if (kind === KIND_STRIKE) {
      if (w.attack[i] === NO_TARGET) strikes.push(i);
    } else if (kind === KIND_ARTILLERY) {
      if ((w.flags[i] & (FLAG_BOMBARD | FLAG_SIEGE)) !== 0) continue;
      if (dist(w.posX[i], w.posY[i], bx, by) > fx(22)) rear.push(i);
    } else if (dist(w.posX[i], w.posY[i], cx, cy) > fx(16)) mid.push(i);
  }
  order(out, CMD_MOVE, mid, cx, cy);
  order(out, CMD_MOVE, rear, bx, by);
  if (strikes.length === 0) return;
  const worth = [3, 0, 0, 1, 5, 0, 0, 0, 4, 4, 2, 0];
  let best = -1;
  let bestKey = 0;
  for (const e of ai.seen) {
    const v = worth[w.kind[e]];
    if (v === 0) continue;
    const de = dist(w.posX[e], w.posY[e], cx, cy);
    if (de > fx(120)) continue;
    const key = v * fx(40) - de;
    if (best < 0 || key > bestKey) {
      best = e;
      bestKey = key;
    }
  }
  if (best >= 0) order(out, CMD_ATTACK_MOVE, strikes, w.posX[best], w.posY[best]);
  else {
    const far = strikes.filter((i) => dist(w.posX[i], w.posY[i], bx, by) > fx(22));
    order(out, CMD_MOVE, far, bx, by);
  }
}

/**
 * The strong points of an objective: what has to be reduced before the infantry goes in.
 * Today these are the houses the enemy is known to hold in a town, and his base buildings.
 * Field works are not in this list (they are cells, not structures): `assault` picks
 * the nearest standing one on the way and sends engineers and guns against it.
 */
function strongPoints(ai: Ai, w: World, obj: Objective): number[] {
  const map = w.map;
  const list: number[] = [];
  if (obj.kind === OBJ_TOWN) {
    for (const s of ai.houses[obj.id]) {
      if (
        w.sHp[s] > 0 &&
        ai.occupied[s] > w.tick &&
        (w.sOcc[s] === 0 || w.sOccTeam[s] !== ai.team)
      ) {
        list.push(s);
      }
    }
  } else {
    for (let s = 0; s < map.structCount; s++) {
      if (ai.known[s] === 0 || w.sHp[s] <= 0 || w.sTeam[s] !== ai.enemy) continue;
      if (dist(structX(map, s), structY(map, s), obj.x, obj.y) < fx(130)) list.push(s);
    }
  }
  return list;
}

function assault(
  ai: Ai,
  w: World,
  out: Command[],
  f: Force,
  units: number[],
  cx: number,
  cy: number,
  power: number,
): void {
  const map = w.map;
  const obj = f.obj!;
  const tick = w.tick;
  const raid = f.role === R_RAID;
  const reach = obj.kind === OBJ_TOWN ? map.townR[obj.id] + fx(30) : fx(70);
  let foes = 0;
  for (const e of ai.seen) {
    if (KINDS[w.kind[e]].cls !== CLASS_AIR && dist(w.posX[e], w.posY[e], obj.x, obj.y) < reach)
      foes++;
  }
  f.quiet = foes === 0 && dist(cx, cy, obj.x, obj.y) < reach ? f.quiet + 1 : 0;
  const points = strongPoints(ai, w, obj);
  // Each strong point in turn, the nearest first (the headquarters, once found, before
  // anything else: with it the game is won).
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
  let done = false;
  if (obj.kind === OBJ_TOWN) {
    const owner = w.townOwner[obj.id];
    if (f.quiet >= 6 && points.length === 0) {
      // The town is quiet: leave a garrison in it, which also takes it.
      let need = Math.max(3, wantedIn(ai, w, obj.id)) - ai.garr[obj.id].length;
      for (let k = units.length - 1; k >= 0 && need > 0; k--) {
        const i = units[k];
        if (!FOOT(w.kind[i])) continue;
        ai.role[i] = R_TOWN + obj.id;
        units.splice(k, 1);
        need--;
      }
      if (owner === ai.team || f.quiet >= 40) done = true;
    }
  } else if (obj.kind === OBJ_BASE) {
    done = f.quiet >= 10 && points.length === 0;
  } else {
    done = f.quiet >= (raid ? 12 : 6) && (obj.id < 0 || w.sHp[obj.id] <= 0);
    if (raid && tick - f.since > 90 * TICK_RATE) done = true;
  }
  if (done || tick - f.since > 6 * MINUTE) {
    f.done++;
    let next = raid
      ? f.done < 2
        ? raidTarget(ai, w)
        : null
      : done
        ? chooseObjective(ai, w, cx, cy, power)
        : null;
    // One objective leads to the next, but not over the middle before its time has come.
    if (!raid && next !== null && across(ai, next.x, next.y) && tick < ai.tune.firstAttack) {
      next = null;
    }
    if (next === null) {
      retreat(ai, f, w, !done);
      order(out, CMD_MOVE, units, ai.stageX, ai.stageY);
      return;
    }
    f.launch = power;
    setOut(ai, w, f, units, next);
    if (f.wps.length > 0) marchOrders(ai, w, out, f, units, true);
    return;
  }
  // Smoke in front of a defended town, once, before the line closes with it.
  if (ai.tune.smoke && !f.smoked && obj.kind === OBJ_TOWN && points.length > 0) {
    const guns = units.filter((i) => w.kind[i] === KIND_ARTILLERY);
    if (guns.length >= 2) {
      const d = dist(cx, cy, obj.x, obj.y) || 1;
      const edge = map.townR[obj.id] >> 1;
      out.push({
        type: CMD_BOMBARD,
        units: guns.slice(0, guns.length >> 1),
        x: obj.x + Math.trunc(((cx - obj.x) * edge) / d),
        y: obj.y + Math.trunc(((cy - obj.y) * edge) / d),
        smoke: true,
      });
      f.smoked = true;
    }
  }
  const tx = point >= 0 ? structX(map, point) : obj.x;
  const ty = point >= 0 ? structY(map, point) : obj.y;
  // Enemy wire, walls or obstacles between it and the objective: the nearest is opened
  // by whoever can, while the rest of the line stands off.
  let gapCell = -1;
  let gapD = fx(60);
  for (let k = 0; k < w.workCount; k++) {
    const c = w.workCells[k];
    if (w.wTeam[c] === ai.team || !workStands(w, c) || w.wKind[c] >= WORK_TRENCH) continue;
    const wx = cellX(c);
    const wy = cellY(c);
    const d = dist(wx, wy, cx, cy);
    if (d >= gapD || dist(wx, wy, tx, ty) > dist(cx, cy, tx, ty) + fx(8)) continue;
    gapD = d;
    gapCell = c;
  }
  const sappers: number[] = [];
  const shell: number[] = [];
  const line: number[] = [];
  for (const i of units) {
    const kind = w.kind[i];
    const flags = w.flags[i];
    if (
      gapCell >= 0 &&
      (KINDS[kind].engineer || kind === KIND_ARTILLERY) &&
      canBreach(KINDS[kind], w.wKind[gapCell])
    ) {
      const at = cellAt(w.aimX[i], w.aimY[i]);
      const busy = (flags & (FLAG_BREACH | FLAG_BOMBARD)) !== 0 && w.wKind[at] !== 0;
      if (!busy && w.attack[i] === NO_TARGET) sappers.push(i);
      continue;
    }
    if (
      point >= 0 &&
      (kind === KIND_ARTILLERY || (kind === KIND_TANK && w.attack[i] === NO_TARGET))
    ) {
      const busy = (flags & (FLAG_SIEGE | FLAG_BOMBARD)) !== 0 && w.orderStruct[i] === point;
      if (!busy) shell.push(i);
      continue;
    }
    if (!LINE[kind]) continue;
    if ((flags & (FLAG_MOVING | FLAG_SIEGE)) !== 0 || w.attack[i] !== NO_TARGET) continue;
    if (dist(w.posX[i], w.posY[i], tx, ty) > fx(18)) line.push(i);
  }
  if (sappers.length > 0) {
    out.push({ type: CMD_BREACH, units: sappers, x: cellX(gapCell), y: cellY(gapCell) });
  }
  if (shell.length > 0) out.push({ type: CMD_ATTACK_STRUCTURE, units: shell, structure: point });
  order(out, CMD_ATTACK_MOVE, line, tx, ty);
  follow(ai, w, out, units, cx, cy);
}

/** Numbers for tests and for watching the AI play: what it has and what it is doing. */
export function aiReport(ai: Ai, w: World): string {
  const t = ai.team;
  const f = ai.forces[0];
  const states = ['idle', 'march', 'assault', 'retreat'];
  let towns = 0;
  for (let k = 0; k < w.map.townCount; k++) if (w.townOwner[k] === t) towns++;
  let garrison = 0;
  for (const g of ai.garr) garrison += g.length;
  return (
    `t${t} ${ai.level} tier ${w.tier[t]} pop ${w.pop[t]}/${w.popCap[t]} ` +
    `S ${w.supplies[t]} F ${w.fuel[t]} C ${w.credits[t]} trucks ${ai.trucks.length} towns ${towns} ` +
    `garrison ${garrison} reserve ${ai.reserve.length} army ${ai.members[0].length} ${states[f.state]} ` +
    `raid ${ai.members[1].length} scouts ${ai.scouts.length} seen ${ai.seen.length} ` +
    `works ${ai.laid} foe works ${ai.foeWorks} units ${Array.from(ai.have).join(',')} | ${ai.plan}`
  );
}
