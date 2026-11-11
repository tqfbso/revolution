import { CLASS_COUNT, MAX_STRUCTS, MAX_TOWNS, generateMap, type GameMap } from './map';
import { seedRng } from './rng';

export { MAP_SIZE, MAP_SIZE_FX } from './map';
export const MAX_UNITS = 16384;
export const MAX_TEAMS = 3;
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
/** Cells that can hold smoke at once. */
export const MAX_SMOKE = 4096;

/** Shells in the air at once. A gun whose shell finds no room simply misfires. */
export const MAX_SHELLS = 2048;

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
  /** Income collected per team. Nothing to spend it on until the economy milestone. */
  credits: Int32Array;
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
  for (let s = 0; s < w.map.structCount; s++) {
    mix(w.sHp[s]);
    mix(w.sRepair[s] ^ (w.sOcc[s] << 20) ^ (w.sOccTeam[s] << 28));
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
  const n = w.count;
  for (let i = 0; i < n; i++) {
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
  }
  return h >>> 0;
}
