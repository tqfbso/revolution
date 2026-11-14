import {
  MAP_CELLS,
  CELL_COUNT,
  CLASS_COUNT,
  S_BUILDING,
  wallMax,
  MAX_STRUCTS,
  MAX_TEAMS,
  MAX_TOWNS,
  generateMap,
  type GameMap,
} from './map';
import { seedRng } from './rng';
import { CIV_FLEEING, DANGER_DIM, MAX_CIVILIANS, placeCivilians } from './civilians';

/** Room per team in the per-kind tables of the world (at least KIND_COUNT of the unit table). */
export const KIND_SLOTS = 16;

/** Surveillance cameras on the map at once, all armies together (see the unit rules). */
export const MAX_CAMERAS = 64;

export { MAP_SIZE, MAP_SIZE_FX } from './map';
export const MAX_UNITS = 16384;
export { MAX_TEAMS } from './map';
export const TICK_RATE = 20;
export const TICK_MS = 1000 / TICK_RATE;

export const FLAG_MOVING = 1;
export const FLAG_WANDER = 2;
/** Attack-move: advance on the move target but stop to fight anything met on the way. */
export const FLAG_AMOVE = 4;
/** The straight line to the move target is walkable: no need to consult the flowfield. */
export const FLAG_DIRECT = 8;

/** Ordered to occupy the building `orderStruct`. */
export const FLAG_GARRISON = 16;
/** Ordered to shell the structure `orderStruct`. */
export const FLAG_SIEGE = 32;
/** Ordered to climb aboard the carrier `orderUnit`. */
export const FLAG_BOARD = 64;
/** Ordered to shell the point (`aimX`, `aimY`) until told otherwise. */
export const FLAG_BOMBARD = 128;
/** With FLAG_BOMBARD: fire one smoke shell at the point, and the order is done. */
export const FLAG_SMOKE = 256;
/** Hold position: shoot what comes into range, never leave the spot to chase. */
export const FLAG_HOLD = 512;
/** Ordered to attack the unit `orderUnit`: chase it and shoot it until it is gone. */
export const FLAG_FOCUS = 1024;
/**
 * Breaching the field work on the cell under (`aimX`, `aimY`): by order, or because it
 * stands in the way of a move order (which then goes on once it is down).
 */
export const FLAG_BREACH = 2048;
/**
 * At the wall of the enemy-held building `orderStruct`, fighting its garrison room by room
 * (set on top of FLAG_GARRISON by the sim when a squad sent into a house finds it held).
 */
export const FLAG_STORM = 4096;
/** Cells that can hold smoke at once. */
export const MAX_SMOKE = 4096;

/** Shells in the air at once. A gun whose shell finds no room simply misfires. */
export const MAX_SHELLS = 2048;

/** Where a kind's new units go (see CMD_DEST): the factory's rally point, a town, a commander. */
export const DEST_RALLY = 0;
export const DEST_TOWN = 1;
export const DEST_COMMANDER = 64;
/** Sub-commanders an army can have. */
export const MAX_COMMANDERS = 8;
/** A commander's mission (see src/sim/commanders.ts and, for how it is carried out, staff.ts). */
export const M_NONE = 0;
export const M_ATTACK = 1;
export const M_HOLD = 2;
export const M_DEFEND = 3;
export const M_PATROL = 4;
export const M_SCREEN = 5;
/** Go to a place and stand there: no fighting on the way, no houses, no falling back. */
export const M_MOVE = 6;
export const MISSION_COUNT = 7;
/** Commander flag: losses are ordered again and sent to it by themselves. */
export const CF_AUTO = 1;
/** The most of one kind that can be on bulk order, or kept in the field, at once. */
export const ORDER_MAX = 999;

/** Units a base building can have on order at once. */
export const QUEUE_MAX = 8;
/** What a truck is doing (see src/sim/economy.ts). */
export const JOB_NONE = 0;
export const JOB_GATHER = 1;
export const JOB_LOAD = 2;
export const JOB_RETURN = 3;
export const JOB_BUILD = 4;
/** Putting up the field work on cell `jobCell`, then the next one near it. */
export const JOB_WORK = 5;
/** Mending or fortifying the building `jobStruct`. */
export const JOB_ENTRENCH = 6;
/** Field works (planned and standing) on the map at once. */
export const MAX_WORKS = 4096;
/** Stances: fire at will (the default), or hold fire until told otherwise. */
export const STANCE_FREE = 0;
export const STANCE_HOLD_FIRE = 1;

/** Owner of a town nobody holds. */
export const NO_TEAM = 255;

/** Flowfields kept for move orders in progress. */
export const MAX_FIELDS = 96;
/** One "way to the nearest enemy" field per team and movement class. */
export const CHASE_FIELDS = MAX_TEAMS * CLASS_COUNT;

/** Life cycle of an entity slot. Free slots are reused by later spawns. */
export const STATE_FREE = 0;
export const STATE_ALIVE = 1;
export const STATE_WRECK = 2;

export const NO_TARGET = -1;

/** Presentation events produced by a tick: three integers each (type, a, b). Not state. */
export const EV_SHOT = 1; // a = shooter, b = target
export const EV_DEATH = 2; // a = unit, b = killer
export const EV_SIEGE = 3; // a = shooter, b = structure
export const EV_COLLAPSE = 4; // a = structure
export const EV_CAPTURE = 5; // a = town, b = team
export const EV_REPAIR = 6; // a = structure
export const EV_UNLOAD = 7; // a = carrier
export const EV_LAUNCH = 8; // a = gun, b = where the shell will land (see packPoint)
export const EV_IMPACT = 9; // a = where (see packPoint), b = 0
export const EV_SMOKE = 10; // a = where (see packPoint), b = how many ticks it will stand
export const EV_BUILT = 11; // a = structure, b = team
export const EV_TRAINED = 12; // a = unit, b = structure
export const EV_TIER = 13; // a = team, b = the tier reached
export const EV_WORK = 14; // a = cell, b = kind of field work | team << 8: finished
export const EV_WORK_LOST = 15; // a = cell, b = kind of field work: destroyed
export const EV_BREACH = 16; // a = unit, b = cell of the field work it hit
export const EV_GUTTED = 17; // a = structure: its roof and floors have come down
export const EV_WALL = 18; // a = structure, b = the face whose wall was breached
export const EV_CAMERA = 19; // a = camera slot, b = team: a surveillance camera was placed
export const EV_STORM = 21; // a = structure, b = the army storming it: a second of the fight inside
export const EV_STORMED = 22; // a = structure, b = the army that took it from its garrison
export const EV_STRIKE = 23; // a = target, b = drone: strike drones are lining up on it
export const EV_FORTIFIED = 24; // a = structure, b = 1 fortified, 0 mended back to whole
export const EV_STRAY = 25; // a = structure, b = shooter: a round meant for someone else hit it
/** a = where (see packPoint), b = the army whose fire killed a civilian there. */
export const EV_CIVILIAN = 26;
export const EV_CAMERA_LOST = 20; // a = camera slot, b = team: pulled down by the enemy

/** A map position squeezed into one event integer, to 1/64 of a unit. */
export function packPoint(x: number, y: number): number {
  return (x >> 4) | ((y >> 4) << 16) | 0;
}
export function unpackX(p: number): number {
  return (p & 0xffff) / 64;
}
export function unpackY(p: number): number {
  return (p >>> 16) / 64;
}

/**
 * Structure-of-arrays world state. An entity is an index in [0, count).
 * Everything that affects the simulation lives here and is covered by hashWorld().
 */
export interface World {
  /** The battlefield. Owned by this world: structures on it are destroyed and repaired. */
  map: GameMap;
  tick: number;
  /** High-water mark: every slot in [0, count) is free, alive or a wreck. */
  count: number;
  groupCount: number;
  rng: Uint32Array;
  posX: Int32Array;
  posY: Int32Array;
  velX: Int32Array;
  velY: Int32Array;
  targetX: Int32Array;
  targetY: Int32Array;
  speed: Int32Array;
  group: Uint16Array;
  team: Uint8Array;
  flags: Uint16Array;
  state: Uint8Array;
  kind: Uint8Array;
  hp: Int16Array;
  /** Alive: ticks until the weapon is ready. Wreck: ticks until the wreck is cleared. */
  cooldown: Int16Array;
  /** Entity being attacked, or NO_TARGET. */
  attack: Int32Array;
  /** Speed while following a move order: the slowest of the group, so it stays together. */
  orderSpeed: Int32Array;
  /** Flowfield (index into the field arrays) the unit follows for its move order, or -1. */
  path: Int16Array;
  /** Goal cell of the unit's move order: where its flowfield leads. */
  goal: Int32Array;
  /** Building the unit is inside, or -1. */
  inside: Int16Array;
  /** Structure a garrison or siege order refers to (see FLAG_GARRISON, FLAG_SIEGE). */
  orderStruct: Int16Array;
  /** Tick until which a garrisoned unit that fired can be seen from afar. */
  reveal: Int32Array;
  /** 1 while the unit has a line of sight to its target. */
  los: Uint8Array;
  /** Which way the hull points: a unit vector in Q10. Decides which armour a hit meets. */
  faceX: Int16Array;
  faceY: Int16Array;
  /** Vehicle this squad rides in, or -1. A carried unit is out of play until it dismounts. */
  carrier: Int32Array;
  /** Squads aboard this vehicle. */
  load: Uint8Array;
  /** Carrier a boarding order refers to (see FLAG_BOARD). */
  orderUnit: Int32Array;
  /** Point a bombardment order is aimed at (see FLAG_BOMBARD). */
  aimX: Int32Array;
  aimY: Int32Array;
  /**
   * Tick until which the enemy knows where this unit is: someone has it in sight, or it is
   * a gun that fired. Indirect fire needs this. One value per unit, so with three armies
   * what one enemy spots the other knows too.
   */
  spotted: Int32Array;
  /** Shells in flight: where and when each lands, who fired it (unit, type, army). */
  shellCount: number;
  shX: Int32Array;
  shY: Int32Array;
  shTick: Int32Array;
  shOwner: Int32Array;
  shKind: Uint8Array;
  shSmoke: Uint8Array;
  /** Cells with smoke in them (the times are in the map, see GameMap.smoke). */
  smokeCount: number;
  smokeCells: Int32Array;
  /**
   * 1 for a drone inside an enemy jammer's bubble. Recomputed from positions at the start
   * of every tick before anything reads it, so it is not part of the hash.
   */
  jammed: Uint8Array;
  /**
   * Per unit: the tick from which a strike drone may next hit it (see STRIKE_RING). Open
   * for STRIKE_WINDOW_TICKS from then; before and after, nothing dives on it.
   */
  strikeAt: Int32Array;
  /**
   * Surveillance cameras, one per slot: owner (-1 = free slot), position, and the tick
   * until which the enemy knows where it is. `camBlind` is recomputed every tick.
   */
  camTeam: Int8Array;
  camX: Int32Array;
  camY: Int32Array;
  camSeen: Int32Array;
  camBlind: Uint8Array;
  /** Structures: health (0 or less = destroyed), repair work done, occupants and their team. */
  sHp: Int32Array;
  /**
   * Buildings: what is left of the wall on each of the four faces (see FACE_* in the map).
   * Direct fire breaks the face it hits; a breached face protects nobody behind it.
   */
  sWall: Int32Array;
  sRepair: Int32Array;
  /** Per building: work-ticks of fortification done (FORT_TICKS in urban.ts = fortified). */
  sFort: Uint16Array;
  sOcc: Uint8Array;
  sOccTeam: Uint8Array;
  /** Towns: owner (or NO_TEAM), the team capturing it and how far it has got. */
  townOwner: Uint8Array;
  townCapturer: Uint8Array;
  townProgress: Int16Array;
  /** Credits per team: paid by held towns, spent on technology and the advanced units. */
  credits: Int32Array;
  /** Supplies and fuel per team: hauled in by trucks, spent on everything. */
  supplies: Int32Array;
  fuel: Int32Array;
  /** Technology tier per team, 1 to 3. */
  tier: Uint8Array;
  /** Units a team has and may have (recounted once a second, raised by each new unit). */
  pop: Int32Array;
  popCap: Int32Array;
  /** What is left at each resource site. */
  siteStock: Int32Array;
  /**
   * Base buildings (structures of kind S_BASE): owner, type, construction work done, the
   * production queue (unit types, or TIER_ITEM), work done on its first entry, rally point.
   */
  sTeam: Uint8Array;
  sType: Uint8Array;
  sBuild: Int32Array;
  sQueue: Uint8Array;
  sQueueLen: Uint8Array;
  /** 1 while the building re-queues `sLast` whenever its queue is empty. */
  sRepeat: Uint8Array;
  /** Unit type last queued here (255 = none), for repeat. */
  sLast: Uint8Array;
  sProgress: Int32Array;
  sRallyX: Int32Array;
  sRallyY: Int32Array;
  /**
   * The war production centre, per team and unit kind (index team * KIND_SLOTS + kind):
   * units on bulk order and not yet on a factory's queue, the number to keep in the field
   * (0 = no standing order), and where new ones go (DEST_*).
   */
  orders: Int16Array;
  keep: Int16Array;
  dest: Uint8Array;
  /** Per team: whose turn it is among the kinds on order, and how long it has waited for money. */
  orderTurn: Uint8Array;
  orderWait: Uint8Array;
  /**
   * Sub-commanders. Per unit: the commander it answers to (-1 = the player). Per team and
   * commander (index team * MAX_COMMANDERS + slot): the mission, where it is to be carried
   * out, where the troops stood when it was given (the other end of a patrol), CF_* flags
   * and a counter that goes up with every new mission. `cEst` is its establishment per
   * kind (that index * KIND_SLOTS + kind): what it is to be kept at.
   */
  cmdr: Int8Array;
  cMission: Uint8Array;
  cX: Int32Array;
  cY: Int32Array;
  cAX: Int32Array;
  cAY: Int32Array;
  cFlags: Uint8Array;
  cSeq: Uint16Array;
  cEst: Int16Array;
  /**
   * Logistics (see src/sim/logistics.ts). Per unit: seconds of rations left. Per team and
   * 16-unit square: 1 where the army is in supply; worked out from the rest of the world
   * once a second (`supplyTick` is when, -1 = never), so not part of the hash.
   */
  ration: Uint8Array;
  supplyMap: Uint8Array;
  supplyTick: number;
  /** Trucks: the job, the site and the building it refers to, the load and a timer. */
  job: Uint8Array;
  jobSite: Int16Array;
  jobStruct: Int16Array;
  cargo: Int16Array;
  cargoKind: Uint8Array;
  jobTimer: Int16Array;
  /** STANCE_*. Unlike an order, a stance stays until it is changed. */
  stance: Uint8Array;
  /** Builders: the cell of the field work a JOB_WORK refers to. */
  jobCell: Int32Array;
  /**
   * Field works (see src/sim/works.ts), one per cell: the cells in the order they were
   * planned, and per cell the kind (0 = none), the owner, the health and the work done.
   * A work is planned (paid for, without effect) until its work is done; then it is
   * stamped into the terrain of the map.
   */
  workCount: number;
  workCells: Int32Array;
  wKind: Uint8Array;
  wTeam: Uint8Array;
  wHp: Int16Array;
  wBuild: Int16Array;
  /** Where each cell is in `workCells`. */
  wIndex: Int32Array;
  /** Counts changes to the field works, for whoever draws them. Not part of the state. */
  worksRev: number;
  /**
   * Civilians (see src/sim/civilians.ts): where each is, what it is doing, the house it
   * lives in; how many each army has killed and how many got away; per square of the map
   * the tick until which there is shooting there. `civField` is the way to the edge of
   * the map, worked out from the map every so often (`civFieldAt`); it is not hashed.
   */
  civCount: number;
  civX: Int32Array;
  civY: Int32Array;
  civState: Uint8Array;
  civHome: Int16Array;
  civKilled: Int32Array;
  civEscaped: number;
  danger: Int32Array;
  civField: Uint16Array | null;
  civFieldAt: number;
  /** Flowfields for move orders: goal cell (-1 = unused), movement class, cost-to-goal. */
  fieldGoal: Int32Array;
  fieldClass: Uint8Array;
  fieldDist: (Uint16Array | null)[];
  /** Tick on which every field slot was found in use (no more are tried that tick). */
  fieldsFullTick: number;
  /** Flowfields built this tick, and which tick that is: a few a tick at most (see acquireField). */
  fieldsBuilt: number;
  fieldsBuiltTick: number;
  /** Per team and class: cost to the nearest enemy, the tick it was built and last needed. */
  chaseDist: (Uint16Array | null)[];
  chaseBuilt: Int32Array;
  chaseWanted: Int32Array;
  /**
   * Events of the ticks since the consumer last emptied this (see EV_*). Output only:
   * never read by the sim and not part of the hashed state.
   */
  events: number[];
}

export function createWorld(seed: number, map: GameMap = generateMap(seed)): World {
  const world: World = {
    map,
    tick: 0,
    count: 0,
    groupCount: 0,
    rng: new Uint32Array(1),
    posX: new Int32Array(MAX_UNITS),
    posY: new Int32Array(MAX_UNITS),
    velX: new Int32Array(MAX_UNITS),
    velY: new Int32Array(MAX_UNITS),
    targetX: new Int32Array(MAX_UNITS),
    targetY: new Int32Array(MAX_UNITS),
    speed: new Int32Array(MAX_UNITS),
    group: new Uint16Array(MAX_UNITS),
    team: new Uint8Array(MAX_UNITS),
    flags: new Uint16Array(MAX_UNITS),
    state: new Uint8Array(MAX_UNITS),
    kind: new Uint8Array(MAX_UNITS),
    hp: new Int16Array(MAX_UNITS),
    cooldown: new Int16Array(MAX_UNITS),
    attack: new Int32Array(MAX_UNITS),
    orderSpeed: new Int32Array(MAX_UNITS),
    path: new Int16Array(MAX_UNITS).fill(-1),
    goal: new Int32Array(MAX_UNITS),
    inside: new Int16Array(MAX_UNITS).fill(-1),
    orderStruct: new Int16Array(MAX_UNITS).fill(-1),
    reveal: new Int32Array(MAX_UNITS),
    los: new Uint8Array(MAX_UNITS),
    faceX: new Int16Array(MAX_UNITS),
    faceY: new Int16Array(MAX_UNITS),
    carrier: new Int32Array(MAX_UNITS).fill(-1),
    load: new Uint8Array(MAX_UNITS),
    orderUnit: new Int32Array(MAX_UNITS).fill(-1),
    aimX: new Int32Array(MAX_UNITS),
    aimY: new Int32Array(MAX_UNITS),
    spotted: new Int32Array(MAX_UNITS),
    shellCount: 0,
    shX: new Int32Array(MAX_SHELLS),
    shY: new Int32Array(MAX_SHELLS),
    shTick: new Int32Array(MAX_SHELLS),
    shOwner: new Int32Array(MAX_SHELLS),
    shKind: new Uint8Array(MAX_SHELLS),
    shSmoke: new Uint8Array(MAX_SHELLS),
    smokeCount: 0,
    smokeCells: new Int32Array(MAX_SMOKE),
    jammed: new Uint8Array(MAX_UNITS),
    strikeAt: new Int32Array(MAX_UNITS),
    camTeam: new Int8Array(MAX_CAMERAS).fill(-1),
    camX: new Int32Array(MAX_CAMERAS),
    camY: new Int32Array(MAX_CAMERAS),
    camSeen: new Int32Array(MAX_CAMERAS),
    camBlind: new Uint8Array(MAX_CAMERAS),
    sHp: map.sMaxHp.slice(),
    sWall: new Int32Array(MAX_STRUCTS * 4),
    sRepair: new Int32Array(MAX_STRUCTS),
    sFort: new Uint16Array(MAX_STRUCTS),
    sOcc: new Uint8Array(MAX_STRUCTS),
    sOccTeam: new Uint8Array(MAX_STRUCTS),
    townOwner: new Uint8Array(MAX_TOWNS).fill(NO_TEAM),
    townCapturer: new Uint8Array(MAX_TOWNS).fill(NO_TEAM),
    townProgress: new Int16Array(MAX_TOWNS),
    credits: new Int32Array(MAX_TEAMS),
    supplies: new Int32Array(MAX_TEAMS).fill(400),
    fuel: new Int32Array(MAX_TEAMS).fill(150),
    tier: new Uint8Array(MAX_TEAMS).fill(1),
    pop: new Int32Array(MAX_TEAMS),
    popCap: new Int32Array(MAX_TEAMS),
    siteStock: map.siteStock.slice(),
    sTeam: new Uint8Array(MAX_STRUCTS).fill(NO_TEAM),
    sType: new Uint8Array(MAX_STRUCTS),
    sBuild: new Int32Array(MAX_STRUCTS),
    sQueue: new Uint8Array(MAX_STRUCTS * QUEUE_MAX),
    sQueueLen: new Uint8Array(MAX_STRUCTS),
    sRepeat: new Uint8Array(MAX_STRUCTS),
    sLast: new Uint8Array(MAX_STRUCTS).fill(255),
    sProgress: new Int32Array(MAX_STRUCTS),
    sRallyX: new Int32Array(MAX_STRUCTS),
    sRallyY: new Int32Array(MAX_STRUCTS),
    orders: new Int16Array(MAX_TEAMS * KIND_SLOTS),
    keep: new Int16Array(MAX_TEAMS * KIND_SLOTS),
    dest: new Uint8Array(MAX_TEAMS * KIND_SLOTS),
    orderTurn: new Uint8Array(MAX_TEAMS),
    orderWait: new Uint8Array(MAX_TEAMS),
    cmdr: new Int8Array(MAX_UNITS).fill(-1),
    cMission: new Uint8Array(MAX_TEAMS * MAX_COMMANDERS),
    cX: new Int32Array(MAX_TEAMS * MAX_COMMANDERS),
    cY: new Int32Array(MAX_TEAMS * MAX_COMMANDERS),
    cAX: new Int32Array(MAX_TEAMS * MAX_COMMANDERS),
    cAY: new Int32Array(MAX_TEAMS * MAX_COMMANDERS),
    cFlags: new Uint8Array(MAX_TEAMS * MAX_COMMANDERS),
    cSeq: new Uint16Array(MAX_TEAMS * MAX_COMMANDERS),
    cEst: new Int16Array(MAX_TEAMS * MAX_COMMANDERS * KIND_SLOTS),
    ration: new Uint8Array(MAX_UNITS),
    supplyMap: new Uint8Array(MAX_TEAMS * (MAP_CELLS >> 2) * (MAP_CELLS >> 2)),
    supplyTick: -1,
    job: new Uint8Array(MAX_UNITS),
    jobSite: new Int16Array(MAX_UNITS),
    jobStruct: new Int16Array(MAX_UNITS),
    cargo: new Int16Array(MAX_UNITS),
    cargoKind: new Uint8Array(MAX_UNITS),
    jobTimer: new Int16Array(MAX_UNITS),
    stance: new Uint8Array(MAX_UNITS),
    jobCell: new Int32Array(MAX_UNITS),
    workCount: 0,
    workCells: new Int32Array(MAX_WORKS),
    wKind: new Uint8Array(CELL_COUNT),
    wTeam: new Uint8Array(CELL_COUNT),
    wHp: new Int16Array(CELL_COUNT),
    wBuild: new Int16Array(CELL_COUNT),
    wIndex: new Int32Array(CELL_COUNT),
    worksRev: 0,
    civCount: 0,
    civX: new Int32Array(MAX_CIVILIANS),
    civY: new Int32Array(MAX_CIVILIANS),
    civState: new Uint8Array(MAX_CIVILIANS),
    civHome: new Int16Array(MAX_CIVILIANS),
    civKilled: new Int32Array(MAX_TEAMS),
    civEscaped: 0,
    danger: new Int32Array(DANGER_DIM * DANGER_DIM),
    civField: null,
    civFieldAt: 0,
    fieldGoal: new Int32Array(MAX_FIELDS).fill(-1),
    fieldClass: new Uint8Array(MAX_FIELDS),
    fieldDist: new Array<Uint16Array | null>(MAX_FIELDS).fill(null),
    fieldsFullTick: -1,
    fieldsBuilt: 0,
    fieldsBuiltTick: -1,
    chaseDist: new Array<Uint16Array | null>(CHASE_FIELDS).fill(null),
    chaseBuilt: new Int32Array(CHASE_FIELDS).fill(-1),
    chaseWanted: new Int32Array(CHASE_FIELDS).fill(-1000),
    events: [],
  };
  for (let s = 0; s < map.structCount; s++) {
    if (map.sKind[s] !== S_BUILDING) continue;
    for (let f = 0; f < 4; f++) world.sWall[4 * s + f] = wallMax(map, s, f);
  }
  seedRng(world.rng, seed);
  placeCivilians(world, seed);
  return world;
}

/** FNV-1a over the full live state. Equal hashes on two machines means they are in sync. */
export function hashWorld(w: World): number {
  let h = 0x811c9dc5;
  const mix = (v: number) => {
    h = Math.imul(h ^ (v & 0xff), 0x01000193);
    h = Math.imul(h ^ ((v >>> 8) & 0xff), 0x01000193);
    h = Math.imul(h ^ ((v >>> 16) & 0xff), 0x01000193);
    h = Math.imul(h ^ (v >>> 24), 0x01000193);
  };
  mix(w.tick);
  mix(w.count);
  mix(w.groupCount);
  mix(w.rng[0]);
  mix(w.map.hash);
  mix(w.fieldsFullTick);
  for (let f = 0; f < MAX_FIELDS; f++) mix(w.fieldGoal[f] ^ (w.fieldClass[f] << 24));
  for (let f = 0; f < CHASE_FIELDS; f++) mix(w.chaseBuilt[f] ^ Math.imul(w.chaseWanted[f], 31));
  for (let c = 0; c < MAX_CAMERAS; c++) {
    if (w.camTeam[c] < 0) continue;
    mix(c ^ (w.camTeam[c] << 8));
    mix(w.camX[c]);
    mix(w.camY[c]);
    mix(w.camSeen[c]);
  }
  mix(w.map.structCount);
  for (let s = 0; s < w.map.structCount; s++) {
    mix(w.sHp[s]);
    mix(w.sRepair[s] ^ (w.sOcc[s] << 20) ^ (w.sOccTeam[s] << 28));
    mix(w.sFort[s]);
    if (w.map.sKind[s] === S_BUILDING) for (let f = 0; f < 4; f++) mix(w.sWall[4 * s + f]);
    if (w.sTeam[s] === NO_TEAM) continue;
    mix(w.map.sX[s] | (w.map.sY[s] << 8) | (w.sType[s] << 16) | (w.sTeam[s] << 24));
    mix(w.sBuild[s]);
    mix(w.sProgress[s] ^ (w.sQueueLen[s] << 24));
    mix(w.sRepeat[s] | (w.sLast[s] << 8));
    mix(w.sRallyX[s]);
    mix(w.sRallyY[s]);
    for (let q = 0; q < w.sQueueLen[s]; q++) mix(w.sQueue[s * QUEUE_MAX + q]);
  }
  for (let k = 0; k < w.map.siteCount; k++) mix(w.siteStock[k]);
  for (let t = 0; t < MAX_TEAMS; t++) {
    mix(w.supplies[t]);
    mix(w.fuel[t]);
    mix(w.tier[t] | (w.pop[t] << 8));
    mix(w.popCap[t]);
  }
  for (let t = 0; t < w.map.townCount; t++) {
    mix(w.townOwner[t] | (w.townCapturer[t] << 8) | (w.townProgress[t] << 16));
  }
  for (let t = 0; t < MAX_TEAMS; t++) mix(w.credits[t]);
  for (let t = 0; t < MAX_TEAMS; t++) mix(w.orderTurn[t] | (w.orderWait[t] << 8));
  for (let k = 0; k < MAX_TEAMS * KIND_SLOTS; k++) {
    mix((w.orders[k] & 0xffff) | (w.keep[k] << 16));
    mix(w.dest[k]);
  }
  for (let c = 0; c < MAX_TEAMS * MAX_COMMANDERS; c++) {
    mix(w.cMission[c] | (w.cFlags[c] << 8) | (w.cSeq[c] << 16));
    mix(w.cX[c]);
    mix(w.cY[c]);
    mix(w.cAX[c]);
    mix(w.cAY[c]);
  }
  for (let k = 0; k < MAX_TEAMS * MAX_COMMANDERS * KIND_SLOTS; k++) mix(w.cEst[k]);
  mix(w.shellCount);
  for (let k = 0; k < w.shellCount; k++) {
    mix(w.shX[k]);
    mix(w.shY[k]);
    mix(w.shTick[k]);
    mix(w.shOwner[k] ^ (w.shKind[k] << 24) ^ (w.shSmoke[k] << 30));
  }
  mix(w.smokeCount);
  for (let k = 0; k < w.smokeCount; k++) {
    mix(w.smokeCells[k]);
    mix(w.map.smoke[w.smokeCells[k]]);
  }
  mix(w.workCount);
  for (let k = 0; k < w.workCount; k++) {
    const c = w.workCells[k];
    mix(c | (w.wKind[c] << 16) | (w.wTeam[c] << 24));
    mix((w.wHp[c] & 0xffff) | (w.wBuild[c] << 16));
  }
  mix(w.civCount ^ (w.civEscaped << 12));
  mix(w.civFieldAt);
  for (let t = 0; t < MAX_TEAMS; t++) mix(w.civKilled[t]);
  for (let k = 0; k < w.civCount; k++) {
    mix(w.civState[k] | (w.civHome[k] << 8));
    if (w.civState[k] !== CIV_FLEEING) continue;
    mix(w.civX[k]);
    mix(w.civY[k]);
  }
  for (let c = 0; c < DANGER_DIM * DANGER_DIM; c++)
    if (w.danger[c] > w.tick) mix(c ^ (w.danger[c] << 12));
  const n = w.count;
  for (let i = 0; i < n; i++) {
    mix(w.jobCell[i] ^ (w.ration[i] << 24));
    mix(w.inside[i] ^ (w.orderStruct[i] << 12) ^ (w.los[i] << 28));
    mix(w.reveal[i] ^ (w.cmdr[i] << 24));
    mix(w.posX[i]);
    mix(w.posY[i]);
    mix(w.velX[i]);
    mix(w.velY[i]);
    mix(w.targetX[i]);
    mix(w.targetY[i]);
    mix(w.speed[i]);
    mix(w.group[i] | (w.team[i] << 16) | (w.load[i] << 24));
    mix(w.flags[i] ^ (w.carrier[i] << 16));
    mix((w.faceX[i] & 0xffff) | (w.faceY[i] << 16));
    mix(w.orderUnit[i]);
    mix(w.aimX[i]);
    mix(w.aimY[i]);
    mix(w.spotted[i]);
    mix(w.state[i] | (w.kind[i] << 8) | ((w.hp[i] & 0xffff) << 16));
    mix(w.cooldown[i]);
    mix(w.attack[i]);
    mix(w.strikeAt[i]);
    mix(w.orderSpeed[i] ^ (w.path[i] << 20));
    mix(w.goal[i]);
    mix(w.job[i] | (w.stance[i] << 4) | (w.cargoKind[i] << 8) | (w.cargo[i] << 16));
    mix((w.jobSite[i] & 0xff) | ((w.jobStruct[i] & 0xfff) << 8) | (w.jobTimer[i] << 20));
  }
  return h >>> 0;
}
