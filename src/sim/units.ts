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
  /** Damage per shot against buildings and bridges. Rifles do nothing to masonry. */
  siege: number;
  /** Can occupy buildings. */
  garrison: boolean;
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
    siege: 60,
    garrison: false,
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
    siege: 0,
    garrison: true,
    wreckTicks: 200,
  },
];

/** Units standing in forest are only noticed from this close: the ambush distance. */
export const CONCEAL_RANGE = fx(13);

/** How far a unit notices enemies. Must stay within ACQUIRE_CELLS coarse grid cells. */
export const ACQUIRE_RANGE = fx(44);

/** Eye height above the ground, for line of sight. */
export const EYE_HEIGHT = fx(0.7);
/** Firing from upper floors reaches a little further. */
export const GARRISON_RANGE_BONUS = fx(3);
/** A garrison that fires gives its position away for this many ticks. */
export const REVEAL_TICKS = 100;
/** Squads a building holds per cell of floor plan, and the most any building holds. */
export const GARRISON_MAX = 8;
/** Range gained (or lost) per unit of height above (or below) the target, as a shift. */
export const HEIGHT_RANGE_SHIFT = 1;
export const HEIGHT_RANGE_MAX = fx(5);
export const HEIGHT_RANGE_MIN = fx(-2);
/** Capture points a town needs to change hands; a unit adds one per second, up to ten. */
export const CAPTURE_POINTS = 60;
/** Credits a held town pays per second. */
export const TOWN_INCOME = 10;
