import type { AiLevel } from '../sim/ai';
import type { Command } from '../sim/commands';
import type { Layout } from '../sim/map';

/** assault: storm a held town. clash: two armies meet head on. roam: stress test. */
/** skirmish: build a base and beat the AI, which starts with what you start with. */
export type Scenario = 'skirmish' | 'assault' | 'clash' | 'roam';

/** Integers per base building in Snapshot.bases. */
export const BASE_STRIDE = 19;
/** Bits of Snapshot.task: the truck's job (JOB_*), then the stance. */
export const TASK_JOB_MASK = 7;
export const TASK_HOLD_FIRE = 8;
/** Under way on a move order. */
export const TASK_MOVING = 16;
/** Out of rations: beyond supply for too long (see the logistics). */
export const TASK_HUNGRY = 32;
export const COMMANDER_STRIDE = 10;
/** Its losses are replaced by themselves; it is asking for reinforcements; it is in a fight. */
export const COMMANDER_AUTO = 1;
export const COMMANDER_NEED = 2;
export const COMMANDER_FIGHTING = 4;

/**
 * Bits of Snapshot.info: life state (2 bits), team (2 bits), inside a building, (for a
 * garrison) given away by its own fire, and riding in a carrier.
 */
export const INFO_STATE_MASK = 3;
export const INFO_TEAM_SHIFT = 2;
export const INFO_TEAM_MASK = 3;
export const INFO_INSIDE = 16;
export const INFO_REVEALED = 32;
export const INFO_CARRIED = 64;
/** The enemy knows where it is: in someone's sight, or a gun located by its own fire. */
export const INFO_SPOTTED = 128;
/** Camera flags: the enemy knows where it is; an enemy jammer has blinded it. */
export const CAMERA_KNOWN = 16;
export const CAMERA_BLIND = 32;
export const NO_AIM = 0xffff;

/** Main thread -> simulation worker. */
export type ToWorker =
  | {
      type: 'init';
      seed: number;
      /** Which battlefield (see generateMap). */
      layout: Layout;
      units: number;
      scenario: Scenario;
      /** Who plays blue in the skirmish. */
      ai: AiLevel | 'off';
      demo: boolean;
      /** Game speed, 1 = real time. */
      speed: number;
    }
  | { type: 'command'; command: Command }
  /** Game speed (0.5 to 16) and pause: both only change when ticks run, never what a tick does. */
  | { type: 'speed'; speed: number }
  | { type: 'pause'; paused: boolean };

/** Simulation worker -> main thread, once per simulated tick batch. */
export interface Snapshot {
  type: 'snapshot';
  tick: number;
  count: number;
  /** Interleaved x, y in world units (floats, presentation only). */
  positions: Float32Array;
  /** Per unit: state | team << 2 | flags (see INFO_*). */
  info: Uint8Array;
  /** Per unit: its type (see KIND_* in the sim). */
  kind: Uint8Array;
  /** Per unit: where the hull points, 0..255 for a full turn, 0 = +z, 64 = +x. */
  heading: Uint8Array;
  /** Per unit: squads aboard a carrier. For a drone: 1 while it is being jammed. */
  load: Uint8Array;
  /** Per unit: health as 0..255 of its maximum. */
  hp: Uint8Array;
  /** Per unit: id of the unit it is attacking, or NO_AIM. */
  aim: Uint16Array;
  /** Combat events since the previous snapshot: (type, a, b) triples, see EV_* in the sim. */
  events: Int32Array;
  /** Living units per team. */
  alive: number[];
  /** Per structure: health as 0..255 of its maximum; 0 = destroyed. */
  structHp: Uint8Array;
  /**
   * Per structure: its state (STAGE_* in the map) in the low two bits, then one bit per
   * face (FACE_*) whose wall has been breached.
   */
  structStage: Uint8Array;
  /**
   * Surveillance cameras standing: four numbers each. Slot, x and z in world units, then
   * the owner's team in the low four bits with CAMERA_KNOWN and CAMERA_BLIND above.
   */
  cameras: Float32Array;
  /** Per town: owner and capturing team (255 = none), capture progress 0..100. */
  townOwner: Uint8Array;
  townCapturer: Uint8Array;
  townProgress: Uint8Array;
  /** Per team: credits, supplies, fuel, technology tier, units and the limit on them. */
  credits: number[];
  supplies: number[];
  fuel: number[];
  tier: number[];
  pop: number[];
  popCap: number[];
  /** Per team: supplies a minute the army costs to keep. */
  upkeep: number[];
  /**
   * The war production centre, per team and kind (index team * KIND_SLOTS + kind): units
   * on bulk order, the number to keep in the field, where new ones go (DEST_*).
   */
  orders: Int16Array;
  keep: Int16Array;
  dest: Uint8Array;
  /** Per unit: the sub-commander it answers to, or -1. */
  cmdr: Int8Array;
  /**
   * The player's sub-commanders, COMMANDER_STRIDE numbers each: mission (M_*), where
   * (x, z), status (ST_*), strength now and at its best, units, where its body is (x, z),
   * and COMMANDER_* flags.
   */
  commanders: Int32Array;
  /** Per unit: job | stance | moving (see TASK_*). */
  task: Uint8Array;
  /** Per resource site: what is left. */
  siteStock: Int32Array;
  /**
   * Base buildings, BASE_STRIDE integers each: structure id, type, team, cell x, cell y,
   * construction 0..100, entries queued, progress of the first 0..100, the eight queue
   * entries, rally x and y in world units, repeat on (0 or 1).
   */
  bases: Int32Array;
  /**
   * Field works, sent whenever one changed: two integers each, the cell and
   * kind | team << 4 | finished << 7 | value << 8, where value is the health as 0..255 of
   * the maximum for a finished one and the work done as 0..100 for a planned one.
   */
  works?: Int32Array;
  /** Wall-clock cost of the last sim tick, in milliseconds. */
  simMs: number;
  /** State hash, sent once per second. Two clients in sync show the same value. */
  hash?: number;
}
