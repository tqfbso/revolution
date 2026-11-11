import type { AiLevel } from '../sim/ai';
import type { Command } from '../sim/commands';

/** assault: storm a held town. clash: two armies meet head on. roam: stress test. */
/** skirmish: build a base and beat the AI, which starts with what you start with. */
export type Scenario = 'skirmish' | 'assault' | 'clash' | 'roam';

/** Integers per base building in Snapshot.bases. */
export const BASE_STRIDE = 18;
/** Bits of Snapshot.task: the truck's job (JOB_*), then the stance. */
export const TASK_JOB_MASK = 7;
export const TASK_HOLD_FIRE = 8;
/** Under way on a move order. */
export const TASK_MOVING = 16;

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
export const NO_AIM = 0xffff;

/** Main thread -> simulation worker. */
export type ToWorker =
  | {
      type: 'init';
      seed: number;
      units: number;
      scenario: Scenario;
      /** Who plays blue in the skirmish. */
      ai: AiLevel | 'off';
      demo: boolean;
      /** Game speed, 1 = real time. */
      speed: number;
    }
  | { type: 'command'; command: Command };

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
  /** Per unit: job | stance | moving (see TASK_*). */
  task: Uint8Array;
  /** Per resource site: what is left. */
  siteStock: Int32Array;
  /**
   * Base buildings, BASE_STRIDE integers each: structure id, type, team, cell x, cell y,
   * construction 0..100, entries queued, progress of the first 0..100, the eight queue
   * entries, rally x and y in world units.
   */
  bases: Int32Array;
  /** Wall-clock cost of the last sim tick, in milliseconds. */
  simMs: number;
  /** State hash, sent once per second. Two clients in sync show the same value. */
  hash?: number;
}
