import type { Command } from '../sim/commands';

/** assault: storm a held town. clash: two armies meet head on. roam: stress test. */
export type Scenario = 'assault' | 'clash' | 'roam';

/**
 * Bits of Snapshot.info: life state (2 bits), unit kind (2 bits), team (2 bits), inside a
 * building, and (for a garrison) given away by its own fire.
 */
export const INFO_INSIDE = 64;
export const INFO_REVEALED = 128;
export const INFO_STATE_MASK = 3;
export const INFO_KIND_SHIFT = 2;
export const INFO_TEAM_SHIFT = 4;
export const INFO_TEAM_MASK = 3;
export const NO_AIM = 0xffff;

/** Main thread -> simulation worker. */
export type ToWorker =
  | { type: 'init'; seed: number; units: number; scenario: Scenario }
  | { type: 'command'; command: Command };

/** Simulation worker -> main thread, once per simulated tick batch. */
export interface Snapshot {
  type: 'snapshot';
  tick: number;
  count: number;
  /** Interleaved x, y in world units (floats, presentation only). */
  positions: Float32Array;
  /** Per unit: state | kind << 2 | team << 4 (see INFO_*). */
  info: Uint8Array;
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
  /** Income collected per team. */
  credits: number[];
  /** Wall-clock cost of the last sim tick, in milliseconds. */
  simMs: number;
  /** State hash, sent once per second. Two clients in sync show the same value. */
  hash?: number;
}
