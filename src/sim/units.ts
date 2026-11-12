// Unit type table. All values are integers (distances fixed-point, times in ticks).
// One entity is one vehicle or one infantry squad.
import { fx } from './fixed';
import { CLASS_AIR, CLASS_FOOT, CLASS_VEHICLE } from './map';

export const KIND_TANK = 0;
export const KIND_INFANTRY = 1;
/** Anti-tank missile team: kills vehicles from beyond gun range, helpless against infantry. */
export const KIND_ATGM = 2;
/** Infantry fighting vehicle: carries squads fast and mows down infantry with its autocannon. */
export const KIND_IFV = 3;
/** Self-propelled gun: shells what others have spotted, from far behind the line. */
export const KIND_ARTILLERY = 4;
/** Recon team: sees far, is hard to see, carries nothing that can hurt anyone. */
export const KIND_RECON = 5;
/** Recon drone: eyes in the sky that no hill or house blocks. */
export const KIND_DRONE = 6;
/** Strike drone: flies into what it finds, once. */
export const KIND_STRIKE = 7;
/** Air-defence vehicle: the only thing that shoots drones down reliably. */
export const KIND_AD = 8;
/** Electronic-warfare vehicle: drones inside its bubble are blind and fall out of the sky. */
export const KIND_EW = 9;
/** Logistics truck: hauls supplies and fuel, puts up and repairs base buildings. Unarmed. */
export const KIND_TRUCK = 10;
/**
 * Engineer squad: puts up field works, and takes the enemy's down with charges and wire
 * cutters from right next to them. A poor rifle squad otherwise.
 */
export const KIND_ENGINEER = 11;
export const KIND_COUNT = 12;

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
  /**
   * Armour: percent of a hit's damage that gets through from the front, the side and the
   * rear. Null for units without a facing that matters (infantry).
   */
  armour: readonly [number, number, number] | null;
  /** How slowly the hull turns: 0 = no facing, higher = slower (see turnHull in the sim). */
  turn: number;
  /** Squads it can carry. */
  carry: number;
  /**
   * Indirect fire: lobs shells at targets someone else has spotted, without a line of
   * sight. `damage` is then the damage at the centre of the burst, `blast` its radius
   * (a third of that against armour), and nothing closer than `minRange` can be hit.
   */
  indirect: boolean;
  minRange: number;
  blast: number;
  /** How far it notices enemies by itself. Further out it depends on what others spot. */
  sight: number;
  /** A sensor: reports every enemy within sight to the whole army, not just its target. */
  spotter: boolean;
  /** Hard to see wherever it is, as if always in cover. */
  stealth: boolean;
  /** Radius within which it jams enemy drones; 0 = no jammer. */
  jam: number;
  /** Destroys itself when it attacks, and comes down on the roof: armour facing is ignored. */
  kamikaze: boolean;
  /**
   * Builds field works. Its `siege` is a demolition charge: laid from ENGINEER_REACH, not
   * fired from weapon range, and never a side effect of its rifle fire.
   */
  engineer: boolean;
}

const PLAIN = { spotter: false, stealth: false, jam: 0, kamikaze: false, engineer: false };

const DIRECT = { indirect: false, minRange: 0, blast: 0 };

const BASE_KINDS: readonly UnitKind[] = [
  {
    name: 'Main battle tank',
    cls: CLASS_VEHICLE,
    hp: 240,
    speed: fx(0.3),
    range: fx(26),
    reload: 60,
    damage: [60, 50, 50, 80, 90, 50, 0, 0, 90, 90, 90, 50],
    siege: 60,
    garrison: false,
    wreckTicks: 1800,
    armour: [70, 115, 180],
    turn: 15,
    carry: 0,
    ...DIRECT,
    ...PLAIN,
    sight: fx(30),
  },
  {
    // Rifles against soft targets and a few shoulder-fired rockets: enough to finish a
    // carrier, not to stop a tank. In the open it loses to both; its place is in cover.
    name: 'Infantry squad',
    cls: CLASS_FOOT,
    hp: 100,
    speed: fx(0.16),
    range: fx(15),
    reload: 24,
    damage: [3, 9, 9, 5, 10, 9, 1, 1, 10, 10, 10, 9],
    siege: 0,
    garrison: true,
    wreckTicks: 200,
    armour: null,
    turn: 0,
    carry: 0,
    ...DIRECT,
    ...PLAIN,
    sight: fx(36),
  },
  {
    // Three men and a launcher. One missile every seven seconds, from further than a tank
    // gun reaches. Nothing to say to infantry: it needs riflemen around it.
    name: 'Missile team',
    cls: CLASS_FOOT,
    hp: 60,
    speed: fx(0.15),
    range: fx(34),
    reload: 140,
    damage: [134, 0, 0, 130, 130, 0, 0, 0, 130, 130, 130, 0],
    siege: 40,
    garrison: true,
    wreckTicks: 200,
    armour: null,
    turn: 0,
    carry: 0,
    ...DIRECT,
    ...PLAIN,
    sight: fx(38),
  },
  {
    name: 'Infantry fighting vehicle',
    cls: CLASS_VEHICLE,
    hp: 180,
    speed: fx(0.4),
    range: fx(20),
    reload: 8,
    damage: [3, 11, 11, 7, 9, 11, 2, 2, 9, 9, 9, 11],
    siege: 4,
    garrison: false,
    wreckTicks: 1800,
    armour: [100, 120, 150],
    turn: 10,
    carry: 2,
    ...DIRECT,
    ...PLAIN,
    sight: fx(32),
  },
  {
    // A shell every six seconds onto anything a friendly unit has in sight, up to 110 away.
    // The shell takes seconds to arrive and scatters, so it is for what stands still:
    // garrisons, missile teams, other guns. Firing gives the gun's own position away.
    name: 'Self-propelled gun',
    cls: CLASS_VEHICLE,
    hp: 110,
    speed: fx(0.22),
    range: fx(110),
    reload: 120,
    damage: [50, 70, 70, 60, 80, 70, 0, 0, 80, 80, 80, 70],
    siege: 120,
    garrison: false,
    wreckTicks: 1800,
    armour: null,
    turn: 12,
    carry: 0,
    indirect: true,
    minRange: fx(25),
    blast: fx(5),
    ...PLAIN,
    sight: fx(26),
  },
  {
    // Two men with optics and a radio. They see twice as far as anyone on the ground, find
    // hidden troops from further off, and are themselves only noticed from close by.
    name: 'Recon team',
    cls: CLASS_FOOT,
    hp: 50,
    speed: fx(0.2),
    range: 0,
    reload: 1000,
    damage: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    siege: 0,
    garrison: true,
    wreckTicks: 200,
    armour: null,
    turn: 0,
    carry: 0,
    ...DIRECT,
    ...PLAIN,
    sight: fx(75),
    spotter: true,
    stealth: true,
  },
  {
    name: 'Recon drone',
    cls: CLASS_AIR,
    hp: 20,
    speed: fx(0.6),
    range: 0,
    reload: 1000,
    damage: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    siege: 0,
    garrison: false,
    wreckTicks: 1,
    armour: null,
    turn: 4,
    carry: 0,
    ...DIRECT,
    ...PLAIN,
    sight: fx(55),
    spotter: true,
  },
  {
    // One-way attack drone. Fast, cheap, dies with its target. Goes for vehicles first.
    name: 'Strike drone',
    cls: CLASS_AIR,
    hp: 12,
    speed: fx(0.8),
    range: fx(1.5),
    reload: 1,
    damage: [170, 50, 60, 150, 120, 50, 0, 0, 130, 130, 130, 50],
    siege: 0,
    garrison: false,
    wreckTicks: 1,
    armour: null,
    turn: 3,
    carry: 0,
    ...DIRECT,
    ...PLAIN,
    sight: fx(32),
    kamikaze: true,
  },
  {
    // Twin cannon and a radar. Useless against anything on the ground.
    name: 'Air-defence vehicle',
    cls: CLASS_VEHICLE,
    hp: 130,
    speed: fx(0.32),
    range: fx(40),
    reload: 12,
    damage: [0, 0, 0, 0, 0, 0, 10, 12, 0, 0, 0, 0],
    siege: 0,
    garrison: false,
    wreckTicks: 1800,
    armour: null,
    turn: 10,
    carry: 0,
    ...DIRECT,
    ...PLAIN,
    sight: fx(44),
  },
  {
    // The jammer. Unarmed. Every enemy drone inside its bubble loses its link.
    name: 'Jammer',
    cls: CLASS_VEHICLE,
    hp: 110,
    speed: fx(0.3),
    range: 0,
    reload: 1000,
    damage: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    siege: 0,
    garrison: false,
    wreckTicks: 1800,
    armour: null,
    turn: 10,
    carry: 0,
    ...DIRECT,
    ...PLAIN,
    sight: fx(30),
    jam: fx(45),
  },
  {
    // The whole economy on six wheels. Loses to everything; a raid on the trucks is a raid
    // on the army that would have been built with what they carry.
    name: 'Logistics truck',
    cls: CLASS_VEHICLE,
    hp: 80,
    speed: fx(0.34),
    range: 0,
    reload: 1000,
    damage: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    siege: 0,
    garrison: false,
    wreckTicks: 1200,
    armour: null,
    turn: 8,
    carry: 0,
    ...DIRECT,
    ...PLAIN,
    sight: fx(24),
  },
  {
    // Sappers. They build what the trucks build in the field, and they are the answer to
    // it: a charge against a wall or an obstacle, cutters for wire. Half a rifle squad in
    // a firefight, so they need covering while they work.
    name: 'Engineer squad',
    cls: CLASS_FOOT,
    hp: 80,
    speed: fx(0.16),
    range: fx(13),
    reload: 50,
    damage: [2, 10, 10, 4, 8, 10, 0, 0, 8, 8, 8, 10],
    siege: 90,
    garrison: true,
    wreckTicks: 200,
    armour: null,
    turn: 0,
    carry: 0,
    ...DIRECT,
    ...PLAIN,
    engineer: true,
    sight: fx(34),
  },
];

/**
 * Pacing (decision 058): fights last about 1.7 times longer. Rather than shave the damage
 * tables, which hold small whole numbers, every ground unit is that much tougher: the same
 * as 40% less damage per shot, with no loss of resolution. Drones keep their health, since
 * jamming drains it at a fixed rate and a hit kills them either way; strike drones hit harder
 * by the same factor, so a tank still takes two of them.
 */
export const TOUGHNESS_NUM = 5;
export const TOUGHNESS_DEN = 3;

export const KINDS: readonly UnitKind[] = BASE_KINDS.map((k) => {
  const scale = (n: number) => Math.round((n * TOUGHNESS_NUM) / TOUGHNESS_DEN);
  if (k.cls === CLASS_AIR) {
    // A strike drone is a one-shot munition, not a firefight weapon: it hits as hard against
    // the tougher targets as it used to against the old ones.
    return k.kamikaze ? { ...k, damage: k.damage.map(scale) } : k;
  }
  return { ...k, hp: scale(k.hp) };
});

/** How close an engineer squad must be to what it blows up. */
export const ENGINEER_REACH = fx(7);

/** Sensors (recon teams, drones) find concealed troops from this far, others from CONCEAL_RANGE. */
export const DETECT_RANGE = fx(24);
/** A jammer that is jamming something is located by its own emissions for this long. */
export const JAM_REVEAL_TICKS = 100;
/** A jammed strike drone loses one point of health every this many ticks, until it crashes. */
export const JAM_DRAIN_TICKS = 3;
/** How high drones fly, for sight and for drawing them. */
export const AIR_HEIGHT = fx(12);

/** How long a unit stays known to the enemy after one of them last had it in sight. */
export const SPOT_TICKS = 30;
/** A gun that fires is located by the sound and the radar track of its shell: 12 seconds. */
export const COUNTER_BATTERY_TICKS = 240;
/** A shell flies this many ticks plus one per two units of distance. */
export const SHELL_BASE_TICKS = 30;
export const SHELL_TICKS_SHIFT = 11;
/** Shells land within this of the aim point, plus 1/32 of the distance flown. */
export const SCATTER_MIN = fx(1.5);
export const SCATTER_SHIFT = 5;
/** A smoke shell fills the cells within this many cells of where it lands, for this long. */
export const SMOKE_CELLS = 2;
export const SMOKE_TICKS = 600;
/** Guns do not fire by themselves at a target with friendly troops this close to it. */
export const DANGER_CLOSE = fx(9);

/** A hit within 60 degrees of the nose is frontal, within 60 of the tail a rear hit (Q10 cosine). */
export const FACING_COS = 512;
/** How close a squad must be to its carrier to climb aboard. */
export const BOARD_DIST = fx(3.5);

/** Units standing in forest are only noticed from this close: the ambush distance. */
export const CONCEAL_RANGE = fx(13);

/**
 * How far a unit engages enemies the army knows about. Its own eyes reach `sight`, which is
 * shorter. Must stay within ACQUIRE_CELLS coarse grid cells.
 */
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
export const TOWN_INCOME = 3;
