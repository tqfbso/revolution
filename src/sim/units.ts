// Unit type table. All values are integers (distances fixed-point, times in ticks).
// One entity is one vehicle or one infantry squad.
import { fx } from './fixed';
import { CLASS_FOOT, CLASS_VEHICLE } from './map';

export const KIND_TANK = 0;
export const KIND_INFANTRY = 1;
export const KIND_COUNT = 2;

export interface UnitKind {
  name: string;
  /** Movement class: decides which terrain it can cross (see src/sim/map.ts). */
  cls: number;
  hp: number;
  /** World units per tick. */
  speed: number;
  /** Weapon range. */
  range: number;
  /** Ticks between shots. */
  reload: number;
  /** Damage per shot against each target kind (this is where armour lives). */
  damage: readonly number[];
  /** Ticks a wreck stays on the field before its slot is freed. */
  wreckTicks: number;
}

export const KINDS: readonly UnitKind[] = [
  {
    name: 'Main battle tank',
    cls: CLASS_VEHICLE,
    hp: 240,
    speed: fx(0.3),
    range: fx(26),
    reload: 60,
    damage: [60, 34],
    wreckTicks: 1800,
  },
  {
    // Rifles against soft targets, shoulder-fired rockets against armour.
    name: 'Infantry squad',
    cls: CLASS_FOOT,
    hp: 100,
    speed: fx(0.16),
    range: fx(15),
    reload: 24,
    damage: [14, 9],
    wreckTicks: 200,
  },
];

/** How far a unit notices enemies. Must stay within ACQUIRE_CELLS coarse grid cells. */
export const ACQUIRE_RANGE = fx(44);
