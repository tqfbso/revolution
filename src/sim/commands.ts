// Commands are the ONLY way anything outside the simulation changes it. In multiplayer
// each client will broadcast its commands for a future tick and every client applies the
// same commands on the same tick (deterministic lockstep). Single player uses the same path.

export const CMD_MOVE = 1;
export const CMD_STOP = 2;
export const CMD_SPAWN = 3;
export const CMD_ATTACK_MOVE = 4;

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
}

export type Command = MoveCommand | AttackMoveCommand | StopCommand | SpawnCommand;
