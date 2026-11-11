import { CLASS_COUNT, generateMap, type GameMap } from './map';
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

/**
 * Structure-of-arrays world state. An entity is an index in [0, count).
 * Everything that affects the simulation lives here and is covered by hashWorld().
 */
export interface World {
  /** The battlefield. Fixed for the life of the world. */
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
  flags: Uint8Array;
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
    flags: new Uint8Array(MAX_UNITS),
    state: new Uint8Array(MAX_UNITS),
    kind: new Uint8Array(MAX_UNITS),
    hp: new Int16Array(MAX_UNITS),
    cooldown: new Int16Array(MAX_UNITS),
    attack: new Int32Array(MAX_UNITS),
    orderSpeed: new Int32Array(MAX_UNITS),
    path: new Int16Array(MAX_UNITS).fill(-1),
    goal: new Int32Array(MAX_UNITS),
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
  const n = w.count;
  for (let i = 0; i < n; i++) {
    mix(w.posX[i]);
    mix(w.posY[i]);
    mix(w.velX[i]);
    mix(w.velY[i]);
    mix(w.targetX[i]);
    mix(w.targetY[i]);
    mix(w.speed[i]);
    mix(w.group[i] | (w.team[i] << 16) | (w.flags[i] << 24));
    mix(w.state[i] | (w.kind[i] << 8) | ((w.hp[i] & 0xffff) << 16));
    mix(w.cooldown[i]);
    mix(w.attack[i]);
    mix(w.orderSpeed[i] ^ (w.path[i] << 20));
    mix(w.goal[i]);
  }
  return h >>> 0;
}
