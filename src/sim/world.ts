import {
  CELL_COUNT,
  CLASS_COUNT,
  MAX_STRUCTS,
  MAX_TEAMS,
  MAX_TOWNS,
  generateMap,
  type GameMap,
} from './map';
import { seedRng } from './rng';

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
/** Cells that can hold smoke at once. */
export const MAX_SMOKE = 4096;

/** Shells in the air at once. A gun whose shell finds no room simply misfires. */
export const MAX_SHELLS = 2048;

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
  /** Structures: health (0 or less = destroyed), repair work done, occupants and their team. */
  sHp: Int32Array;
  sRepair: Int32Array;
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
  sProgress: Int32Array;
  sRallyX: Int32Array;
  sRallyY: Int32Array;
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
  /** Flowfields for move orders: goal cell (-1 = unused), movement class, cost-to-goal. */
  fieldGoal: Int32Array;
  fieldClass: Uint8Array;
  fieldDist: (Uint16Array | null)[];
  /** Tick on which every field slot was found in use (no more are tried that tick). */
  fieldsFullTick: number;
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
    sHp: map.sMaxHp.slice(),
    sRepair: new Int32Array(MAX_STRUCTS),
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
    sProgress: new Int32Array(MAX_STRUCTS),
    sRallyX: new Int32Array(MAX_STRUCTS),
    sRallyY: new Int32Array(MAX_STRUCTS),
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
    fieldGoal: new Int32Array(MAX_FIELDS).fill(-1),
    fieldClass: new Uint8Array(MAX_FIELDS),
    fieldDist: new Array<Uint16Array | null>(MAX_FIELDS).fill(null),
    fieldsFullTick: -1,
    chaseDist: new Array<Uint16Array | null>(CHASE_FIELDS).fill(null),
    chaseBuilt: new Int32Array(CHASE_FIELDS).fill(-1),
    chaseWanted: new Int32Array(CHASE_FIELDS).fill(-1000),
    events: [],
  };
  seedRng(world.rng, seed);
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
  mix(w.map.structCount);
  for (let s = 0; s < w.map.structCount; s++) {
    mix(w.sHp[s]);
    mix(w.sRepair[s] ^ (w.sOcc[s] << 20) ^ (w.sOccTeam[s] << 28));
    if (w.sTeam[s] === NO_TEAM) continue;
    mix(w.map.sX[s] | (w.map.sY[s] << 8) | (w.sType[s] << 16) | (w.sTeam[s] << 24));
    mix(w.sBuild[s]);
    mix(w.sProgress[s] ^ (w.sQueueLen[s] << 24));
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
  const n = w.count;
  for (let i = 0; i < n; i++) {
    mix(w.jobCell[i]);
    mix(w.inside[i] ^ (w.orderStruct[i] << 12) ^ (w.los[i] << 28));
    mix(w.reveal[i]);
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
    mix(w.orderSpeed[i] ^ (w.path[i] << 20));
    mix(w.goal[i]);
    mix(w.job[i] | (w.stance[i] << 4) | (w.cargoKind[i] << 8) | (w.cargo[i] << 16));
    mix((w.jobSite[i] & 0xff) | ((w.jobStruct[i] & 0xfff) << 8) | (w.jobTimer[i] << 20));
  }
  return h >>> 0;
}
