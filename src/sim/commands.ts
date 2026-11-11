// Commands are the ONLY way anything outside the simulation changes it. In multiplayer
// each client will broadcast its commands for a future tick and every client applies the
// same commands on the same tick (deterministic lockstep). Single player uses the same path.

export const CMD_MOVE = 1;
export const CMD_STOP = 2;
export const CMD_SPAWN = 3;
export const CMD_ATTACK_MOVE = 4;
export const CMD_GARRISON = 5;
export const CMD_ATTACK_STRUCTURE = 6;

export const CMD_LOAD = 7;
export const CMD_UNLOAD = 8;

/**
 * Squads climb aboard carriers: each walks to the nearest of `carriers` that still has a
 * seat. The carriers wait for them.
 */
export interface LoadCommand {
  type: typeof CMD_LOAD;
  units: number[];
  carriers: number[];
}

/** Carriers put down everyone aboard, here and now. */
export interface UnloadCommand {
  type: typeof CMD_UNLOAD;
  units: number[];
}

export interface MoveCommand {
  type: typeof CMD_MOVE;
  units: number[];
  /** Destination in fixed-point world units. */
  x: number;
  y: number;
}

/** Like move, but the units stop and fight whatever comes into range on the way. */
export interface AttackMoveCommand {
  type: typeof CMD_ATTACK_MOVE;
  units: number[];
  x: number;
  y: number;
}

/** Infantry walks to a building and occupies it. Any later move order brings it out. */
export interface GarrisonCommand {
  type: typeof CMD_GARRISON;
  units: number[];
  /** Structure id (see the map). */
  structure: number;
}

/** Shell a building or a bridge until it comes down. Only units with siege damage obey. */
export interface AttackStructureCommand {
  type: typeof CMD_ATTACK_STRUCTURE;
  units: number[];
  structure: number;
}

export interface StopCommand {
  type: typeof CMD_STOP;
  units: number[];
}

/** Debug/scenario command: spawn a block of units. Positions come from the sim RNG. */
export interface SpawnCommand {
  type: typeof CMD_SPAWN;
  count: number;
  team: number;
  /** Centre and half-extent of the spawn square, fixed-point. */
  x: number;
  y: number;
  radius: number;
  /** Wandering units roam the map in squads until given an order. */
  wander: boolean;
  /** Unit type (see src/sim/units.ts). Defaults to the tank. */
  kind?: number;
  /** If set, the whole block attack-moves by this offset, keeping its shape. */
  advanceX?: number;
  advanceY?: number;
  /** If set, the units start inside the buildings of this town, as far as there is room. */
  garrisonTown?: number;
}

export type Command =
  | MoveCommand
  | AttackMoveCommand
  | StopCommand
  | SpawnCommand
  | GarrisonCommand
  | AttackStructureCommand
  | LoadCommand
  | UnloadCommand;
