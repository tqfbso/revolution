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

export const CMD_BOMBARD = 9;

/**
 * Guns shell a point on the ground until given another order, seen or not. Guns out of
 * range drive up until they can reach it. Only units with indirect fire obey.
 */
export interface BombardCommand {
  type: typeof CMD_BOMBARD;
  units: number[];
  x: number;
  y: number;
  /** One smoke shell per gun instead of high explosive until stopped. */
  smoke?: boolean;
}

export const CMD_ATTACK = 20;

/**
 * Units go after one enemy unit and keep shooting it until it dies or is lost to sight.
 * A move order (or stop) ends it. Guns with indirect fire ignore it; use bombard.
 */
export interface AttackCommand {
  type: typeof CMD_ATTACK;
  units: number[];
  target: number;
}

export const CMD_HOLD = 10;

/** Stop and hold position: fight what comes into range, do not chase. A move order ends it. */
export interface HoldCommand {
  type: typeof CMD_HOLD;
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

export const CMD_GATHER = 11;
export const CMD_BUILD = 12;
export const CMD_ASSIST = 13;
export const CMD_TRAIN = 14;
export const CMD_CANCEL = 15;
export const CMD_RALLY = 16;
export const CMD_RESEARCH = 17;
export const CMD_STANCE = 18;
export const CMD_FOUND = 19;

/** Trucks haul from a resource site to the nearest depot, back and forth, until told otherwise. */
export interface GatherCommand {
  type: typeof CMD_GATHER;
  units: number[];
  site: number;
}

/**
 * Start a base building with its north-west corner on cell (x, y) and send the trucks to
 * work on it. It is paid for at once by the army of the first truck; refused if that army
 * cannot pay, has not the technology, or the ground will not take it.
 */
export interface BuildCommand {
  type: typeof CMD_BUILD;
  units: number[];
  /** Building type (see BUILDINGS in src/sim/economy.ts). */
  building: number;
  x: number;
  y: number;
}

/** Trucks work on a base building of their own army: finish it, or repair it. */
export interface AssistCommand {
  type: typeof CMD_ASSIST;
  units: number[];
  structure: number;
}

/** Put a unit on a building's production queue. Paid for at once. */
export interface TrainCommand {
  type: typeof CMD_TRAIN;
  structure: number;
  kind: number;
}

/** Take the last entry off a building's queue again, for a full refund. */
export interface CancelCommand {
  type: typeof CMD_CANCEL;
  structure: number;
}

/** Where a building's new units go when they roll out. */
export interface RallyCommand {
  type: typeof CMD_RALLY;
  structure: number;
  x: number;
  y: number;
}

/** A headquarters works on the army's next technology tier. */
export interface ResearchCommand {
  type: typeof CMD_RESEARCH;
  structure: number;
}

/** Set a stance (STANCE_* in the world). It stays until changed. */
export interface StanceCommand {
  type: typeof CMD_STANCE;
  units: number[];
  stance: number;
}

/** Scenario command: a finished base building for `team`, free, as near to (x, y) as it fits. */
export interface FoundCommand {
  type: typeof CMD_FOUND;
  team: number;
  building: number;
  /** Cell wanted for the north-west corner. */
  x: number;
  y: number;
}

export const CMD_FORTIFY = 21;
export const CMD_DEMOLISH = 22;
export const CMD_BREACH = 23;
export const CMD_OCCUPY = 24;
export const CMD_FIELDWORK = 25;
export const CMD_REPEAT = 26;

/**
 * Trucks and engineers put up field works, one per cell, in the order given. Each is paid
 * for at once by the army of the first builder, as far as its money goes; a cell that
 * already holds an unfinished work of that army is simply worked on. Builders go on to
 * unfinished works nearby when theirs is done.
 */
export interface FortifyCommand {
  type: typeof CMD_FORTIFY;
  units: number[];
  /** Kind of field work (see WORKS in src/sim/works.ts). */
  work: number;
  /** Cell indices (y * MAP_CELLS + x). */
  cells: number[];
}

/** Take down field works of `team`, or give up planned ones (those for a full refund). */
export interface DemolishCommand {
  type: typeof CMD_DEMOLISH;
  team: number;
  cells: number[];
}

/**
 * Bring down the enemy field work on the cell under (x, y): tanks and missile teams fire
 * at it from range, engineers go up to it and lay charges, guns shell it.
 */
export interface BreachCommand {
  type: typeof CMD_BREACH;
  units: number[];
  x: number;
  y: number;
}

/**
 * Infantry takes position in the trench or sandbag line under (x, y), two squads to a
 * cell outward from that point, and holds it.
 */
export interface OccupyCommand {
  type: typeof CMD_OCCUPY;
  units: number[];
  x: number;
  y: number;
}

/** Scenario command: finished field works for `team`, free, wherever the ground takes them. */
export interface FieldworkCommand {
  type: typeof CMD_FIELDWORK;
  team: number;
  work: number;
  cells: number[];
}

/**
 * Switch a building's repeat on or off. While on, it queues the unit it last trained again
 * whenever its queue runs dry and the army can pay: fast squads without constant clicking.
 */
export interface RepeatCommand {
  type: typeof CMD_REPEAT;
  structure: number;
  on: boolean;
}

/** Each engineer squad in `units` leaves a surveillance camera where it stands. */
export const CMD_CAMERA = 27;
export interface CameraCommand {
  type: typeof CMD_CAMERA;
  units: number[];
}

export const CMD_ORDER = 28;
export const CMD_KEEP = 29;
export const CMD_DEST = 30;

/**
 * A bulk order to the army's whole production: `count` more of `kind` (negative takes
 * orders back; they were never paid for). The economy hands them out to whichever factory
 * of the right type has room, one at a time, and pays for each as it goes on a queue.
 */
export interface OrderCommand {
  type: typeof CMD_ORDER;
  team: number;
  kind: number;
  count: number;
}

/** Keep `count` of `kind` in the field: losses are ordered again by themselves. 0 ends it. */
export interface KeepCommand {
  type: typeof CMD_KEEP;
  team: number;
  kind: number;
  count: number;
}

/**
 * Where new units of `kind` go when they roll out: DEST_RALLY (their factory's rally
 * point), DEST_TOWN + a town, or DEST_COMMANDER + a commander, who takes them in.
 */
export interface DestCommand {
  type: typeof CMD_DEST;
  team: number;
  kind: number;
  dest: number;
}

export const CMD_ASSIGN = 31;
export const CMD_MISSION = 32;
export const CMD_REINFORCE = 33;

/**
 * Put `units` under commander `slot` of their army (0 to MAX_COMMANDERS - 1), or, with
 * slot -1, take them back under the player's own orders.
 */
export interface AssignCommand {
  type: typeof CMD_ASSIGN;
  units: number[];
  slot: number;
}

/**
 * Give commander `slot` of `team` a mission (M_*) at a point. M_NONE stands it down where
 * it is; mission -1 disbands it: its troops go back under the player's own orders.
 */
export interface MissionCommand {
  type: typeof CMD_MISSION;
  team: number;
  slot: number;
  mission: number;
  x: number;
  y: number;
}

/** Commander `slot` of `team` has its losses replaced by itself (or, off, not). */
export interface ReinforceCommand {
  type: typeof CMD_REINFORCE;
  team: number;
  slot: number;
  on: boolean;
}

export type Command =
  | AssignCommand
  | MissionCommand
  | ReinforceCommand
  | OrderCommand
  | KeepCommand
  | DestCommand
  | CameraCommand
  | RepeatCommand
  | FortifyCommand
  | DemolishCommand
  | BreachCommand
  | OccupyCommand
  | FieldworkCommand
  | GatherCommand
  | BuildCommand
  | AssistCommand
  | TrainCommand
  | CancelCommand
  | RallyCommand
  | ResearchCommand
  | StanceCommand
  | FoundCommand
  | MoveCommand
  | AttackMoveCommand
  | StopCommand
  | SpawnCommand
  | GarrisonCommand
  | AttackStructureCommand
  | LoadCommand
  | UnloadCommand
  | BombardCommand
  | HoldCommand
  | AttackCommand;
