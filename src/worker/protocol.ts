import type { Command } from '../sim/commands';

/** Main thread -> simulation worker. */
export type ToWorker =
  { type: 'init'; seed: number; units: number } | { type: 'command'; command: Command };

/** Simulation worker -> main thread, once per simulated tick batch. */
export interface Snapshot {
  type: 'snapshot';
  tick: number;
  count: number;
  /** Interleaved x, y in world units (floats, presentation only). */
  positions: Float32Array;
  /** Team per unit; only sent when the unit count changed. */
  teams?: Uint8Array;
  /** Wall-clock cost of the last sim tick, in milliseconds. */
  simMs: number;
  /** State hash, sent once per second. Two clients in sync show the same value. */
  hash?: number;
}
