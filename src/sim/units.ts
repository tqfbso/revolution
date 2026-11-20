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
/**
 * Attack helicopter: rockets and a cannon from above the roofs, faster than anything on the
 * ground. Rifles and autocannon wear it down, air defence takes it apart. Lands only on a
 * helipad, so an army has as many as its pads hold (see HELIS_PER_PAD).
 */
export const KIND_HELI = 12;
/** Transport helicopter: lifts four squads over rivers, walls and front lines. Unarmed. */
export const KIND_LIFT = 13;
/**
 * Paratroopers: picked infantry that waits in reserve off the map and is dropped where the
 * army asks, by a transport plane (see src/sim/air.ts).
 */
export const KIND_PARA = 14;
/** The transport plane that drops them. Nobody orders it about; air defence shoots it down. */
export const KIND_PLANE = 15;
/**
 * Mortar team (I6): three men and a tube that lobs bombs over the houses at what someone
 * else has spotted. Short reach next to a gun, but it goes wherever infantry goes, up on a
 * roof too, and its bombs pin the men they land among in the open (PIN_TICKS).
 */
export const KIND_MORTAR = 16;
export const KIND_COUNT = 17;

/**
 * The kinds of unit each role of a shared army looks after, by role (the names are DUTIES in
 * client/net.ts): everything (no kinds of its own), armour, infantry, air and drones,
 * economy. A new unit goes to the player whose role covers it (`ownerFor` in sim.ts).
 */
export const DUTY_KINDS: readonly (readonly number[])[] = [
  [],
  [0, 3, 4, 8, 9],
  [1, 2, 5, 11, 16],
  [6, 7, 12, 13, 14],
  [10],
];

/**
 * What a unit is as a target (architecture review F3). The damage table has a column per
 * profile, not per kind: every kind with the same profile takes the same from every
 * weapon. A new kind of unit names its profile and needs no column of its own; a new
 * profile is one more number in each `vs` row.
 */
export const PROFILE_TANK = 0;
/** Men on foot: rifle squads, recon teams, engineers, paratroops, mortar teams. */
export const PROFILE_FOOT = 1;
export const PROFILE_ATGM = 2;
export const PROFILE_IFV = 3;
export const PROFILE_ARTILLERY = 4;
export const PROFILE_DRONE = 5;
export const PROFILE_STRIKE = 6;
/** Unarmoured vehicles: air defence, the jammer, trucks. */
export const PROFILE_SOFT = 7;
export const PROFILE_HELI = 8;
export const PROFILE_PLANE = 9;
export const PROFILE_COUNT = 10;

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
  /** What it is as a target (PROFILE_*): what a shot of each kind does to it. */
  profile: number;
  /**
   * Damage per shot against each target kind (this is where armour lives). Filled in from
   * the table's `vs` rows and the targets' profiles: read it as `damage[target's kind]`.
   */
  damage: readonly number[];
  /** Damage per shot against buildings and bridges. Rifles do nothing to masonry. */
  siege: number;
  /**
   * What a shot at a target in the open does to a building just behind or beside it
   * (decision 095): the structure takes this much. Below BLAST_STRAY it is bullets and
   * light cannon, which shoot a building up and gut it but cannot level it, and do half as much to the
   * wall. From BLAST_STRAY up it is a shell, a missile or a warhead: no such limit, and it
   * also catches a building the target is standing against.
   */
  stray: number;
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
  /**
   * Direct fire with a high-explosive round (I3, decision 145): besides what the shot does
   * to its target, every enemy squad on foot within `burst` of it takes `burstDamage` (at
   * the target, half at the rim). Rubble and sandbags halve that, a trench quarters it,
   * and men behind walls are not touched. 0 = no burst.
   */
  burst: number;
  burstDamage: number;
  /**
   * One man in the squad carries a light machine gun (I3): its fire pins enemy infantry
   * caught in the open (see PIN_TICKS), and from a rest (a ruin, sandbags, a trench, a
   * window) it does a third more to men on foot.
   */
  gunner: boolean;
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

const PLAIN = {
  spotter: false,
  stealth: false,
  jam: 0,
  kamikaze: false,
  engineer: false,
  burst: 0,
  burstDamage: 0,
  gunner: false,
};

/** From this much `stray` a round is high explosive (see UnitKind.stray). */
export const BLAST_STRAY = 16;
const DIRECT = { indirect: false, minRange: 0, blast: 0 };

/** What the burst of each high-explosive direct-fire round does to men at its centre. */
const BURST_TANK = 30;
const BURST_MISSILE = 20;
const BURST_STRIKE = 35;
const BURST_HELI = 25;
/**
 * Infantry in the open hit by a squad's machine gun is pinned for this long (I3): it moves
 * at PIN_SPEED 256ths of its speed and takes PIN_RELOAD percent of its time between shots.
 * Men in a building, a ruin, a trench or behind sandbags are never pinned.
 */
export const PIN_TICKS = 60;
export const PIN_SPEED = 128;
export const PIN_RELOAD = 125;
/** Percent a squad's machine gun does to men on foot when it fires from a rest. */
export const REST_PCT = 133;

/** A row of the table as it is written: damage by the target's profile. */
type UnitSpec = Omit<UnitKind, 'damage'> & {
  /** Damage per shot against a target of each profile, in PROFILE_* order. */
  vs: readonly number[];
};

const SPECS: readonly UnitSpec[] = [
  {
    name: 'Main battle tank',
    cls: CLASS_VEHICLE,
    hp: 280,
    speed: fx(0.3),
    range: fx(26),
    reload: 60,
    profile: PROFILE_TANK,
    vs: [60, 75, 75, 80, 90, 0, 0, 90, 0, 0],
    siege: 60,
    stray: 30,
    garrison: false,
    wreckTicks: 1800,
    armour: [70, 115, 180],
    turn: 15,
    carry: 0,
    ...DIRECT,
    ...PLAIN,
    sight: fx(30),
    burst: fx(3.5),
    burstDamage: BURST_TANK,
  },
  {
    // Rifles against soft targets and a few shoulder-fired rockets: enough to finish a
    // carrier, not to stop a tank. In the open it loses to both; its place is in cover.
    // Against a building it has grenades and those rockets: a thirtieth of a tank gun, so a
    // squad alone gets nowhere and a company brings an undefended base down in the end.
    name: 'Infantry squad',
    cls: CLASS_FOOT,
    hp: 100,
    speed: fx(0.16),
    range: fx(15),
    reload: 24,
    profile: PROFILE_FOOT,
    vs: [3, 9, 9, 5, 10, 1, 1, 10, 2, 0],
    siege: 2,
    stray: 5,
    garrison: true,
    wreckTicks: 200,
    armour: null,
    turn: 0,
    carry: 0,
    ...DIRECT,
    ...PLAIN,
    sight: fx(36),
    gunner: true,
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
    profile: PROFILE_ATGM,
    vs: [134, 0, 0, 130, 130, 0, 0, 130, 0, 0],
    siege: 40,
    stray: 20,
    garrison: true,
    wreckTicks: 200,
    armour: null,
    turn: 0,
    carry: 0,
    ...DIRECT,
    ...PLAIN,
    sight: fx(38),
    burst: fx(3),
    burstDamage: BURST_MISSILE,
  },
  {
    name: 'Infantry fighting vehicle',
    cls: CLASS_VEHICLE,
    hp: 180,
    speed: fx(0.4),
    range: fx(20),
    reload: 8,
    profile: PROFILE_IFV,
    vs: [3, 11, 11, 7, 9, 2, 2, 9, 3, 0],
    siege: 4,
    stray: 4,
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
    profile: PROFILE_ARTILLERY,
    vs: [50, 70, 70, 60, 80, 0, 0, 80, 0, 0],
    siege: 160,
    stray: 0,
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
    profile: PROFILE_FOOT,
    vs: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    siege: 0,
    stray: 0,
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
    profile: PROFILE_DRONE,
    vs: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    siege: 0,
    stray: 0,
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
    // Carriers, guns and trucks it kills in one or two; a tank's roof takes four, and they
    // come one at a time (see STRIKE_RING), so armour has time to get under cover.
    name: 'Strike drone',
    cls: CLASS_AIR,
    hp: 12,
    speed: fx(0.8),
    range: fx(1.5),
    reload: 1,
    profile: PROFILE_STRIKE,
    vs: [75, 50, 60, 150, 120, 0, 0, 130, 0, 0],
    siege: 0,
    stray: 40,
    garrison: false,
    wreckTicks: 1,
    armour: null,
    turn: 3,
    carry: 0,
    ...DIRECT,
    ...PLAIN,
    sight: fx(32),
    burst: fx(4),
    burstDamage: BURST_STRIKE,
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
    profile: PROFILE_SOFT,
    vs: [0, 0, 0, 0, 0, 10, 12, 0, 11, 20],
    siege: 0,
    stray: 0,
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
    profile: PROFILE_SOFT,
    vs: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    siege: 0,
    stray: 0,
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
    profile: PROFILE_SOFT,
    vs: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    siege: 0,
    stray: 0,
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
    profile: PROFILE_FOOT,
    vs: [2, 10, 10, 4, 8, 0, 0, 8, 1, 0],
    siege: 90,
    stray: 5,
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
  {
    // Hovers out of rifle range of most things and works over what it finds: a tank in six
    // salvos, a squad in four. No armour at all, so a pair of air-defence vehicles or a
    // street full of rifles sends it home in pieces. It never needs supplying, only a pad.
    // It is also the only thing in the air that fights in the air: another helicopter is
    // down in five salvos, and it goes for one before anything on the ground (decision 116).
    name: 'Attack helicopter',
    cls: CLASS_AIR,
    hp: 150,
    speed: fx(0.62),
    range: fx(28),
    reload: 40,
    profile: PROFILE_HELI,
    vs: [80, 40, 40, 70, 70, 0, 0, 70, 35, 0],
    siege: 20,
    stray: 20,
    garrison: false,
    wreckTicks: 1,
    armour: null,
    turn: 6,
    carry: 0,
    ...DIRECT,
    ...PLAIN,
    sight: fx(46),
    burst: fx(4),
    burstDamage: BURST_HELI,
  },
  {
    name: 'Transport helicopter',
    cls: CLASS_AIR,
    hp: 170,
    speed: fx(0.66),
    range: 0,
    reload: 1000,
    profile: PROFILE_HELI,
    vs: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    siege: 0,
    stray: 0,
    garrison: false,
    wreckTicks: 1,
    armour: null,
    turn: 6,
    carry: 4,
    ...DIRECT,
    ...PLAIN,
    sight: fx(40),
  },
  {
    // A rifle squad and a half: more men, better shots, more rockets. They arrive with what
    // they can carry, so behind the lines they are on their own until the army reaches them.
    name: 'Paratroopers',
    cls: CLASS_FOOT,
    hp: 130,
    speed: fx(0.17),
    range: fx(16),
    reload: 22,
    profile: PROFILE_FOOT,
    vs: [5, 11, 11, 7, 12, 1, 1, 12, 2, 0],
    siege: 3,
    stray: 5,
    garrison: true,
    wreckTicks: 200,
    armour: null,
    turn: 0,
    carry: 0,
    ...DIRECT,
    ...PLAIN,
    sight: fx(36),
    gunner: true,
  },
  {
    name: 'Transport plane',
    cls: CLASS_AIR,
    hp: 170,
    speed: fx(1.1),
    range: 0,
    reload: 1000,
    profile: PROFILE_PLANE,
    vs: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    siege: 0,
    stray: 0,
    garrison: false,
    wreckTicks: 1,
    armour: null,
    turn: 14,
    carry: 8,
    ...DIRECT,
    ...PLAIN,
    sight: fx(20),
  },
  {
    // A bomb every five seconds onto men a friend has in sight, up to 65 away and over any
    // roof. A bomb that lands among men in the open pins them. Too light
    // to trouble armour or masonry, and helpless if the enemy walks up to it.
    name: 'Mortar team',
    cls: CLASS_FOOT,
    hp: 60,
    speed: fx(0.15),
    range: fx(65),
    reload: 100,
    profile: PROFILE_FOOT,
    vs: [10, 40, 40, 12, 40, 0, 0, 40, 0, 0],
    siege: 8,
    stray: 0,
    garrison: true,
    wreckTicks: 200,
    armour: null,
    turn: 0,
    carry: 0,
    indirect: true,
    minRange: fx(12),
    blast: fx(3.5),
    ...PLAIN,
    sight: fx(30),
  },
];

/** The table with every row's damage spread out over the kinds it can be fired at. */
const BASE_KINDS: readonly UnitKind[] = SPECS.map(({ vs, ...kind }) => {
  if (vs.length !== PROFILE_COUNT) throw new Error(`${kind.name}: a damage per profile`);
  return { ...kind, damage: SPECS.map((target) => vs[target.profile]) };
});

/**
 * Pacing (decision 058): fights last about 1.7 times longer. Rather than shave the damage
 * tables, which hold small whole numbers, every ground unit is that much tougher: the same
 * as 40% less damage per shot, with no loss of resolution. Drones keep their health, since
 * jamming drains it at a fixed rate and a hit kills them either way; strike drones hit harder
 * by the same factor, so each target still takes as many of them as the table says.
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

/**
 * Army points per unit type: what it counts against the army limit (decision 059b). Anyone
 * on foot or in the air is 1, light vehicles 2, guns 4 and tanks 5, so the limit stops being
 * a way to fit more tanks into the same slots.
 */
export const POINTS: readonly number[] = (() => {
  const t = new Array<number>(KIND_COUNT).fill(1);
  t[KIND_TANK] = 5;
  t[KIND_ARTILLERY] = 4;
  t[KIND_IFV] = 2;
  t[KIND_AD] = 2;
  t[KIND_EW] = 2;
  t[KIND_HELI] = 4;
  t[KIND_LIFT] = 3;
  t[KIND_PARA] = 2;
  t[KIND_PLANE] = 0;
  return t;
})();

/** How close an engineer squad must be to what it blows up. */
export const ENGINEER_REACH = fx(7);

/** Sensors (recon teams, drones) find concealed troops from this far, others from CONCEAL_RANGE. */
export const DETECT_RANGE = fx(24);
/** A jammer that is jamming something is located by its own emissions for this long. */
export const JAM_REVEAL_TICKS = 100;
/** A jammed strike drone loses one point of health every this many ticks, until it crashes. */
export const JAM_DRAIN_TICKS = 3;
/**
 * Strike drones attack in turn (decision 088). The first to come within STRIKE_RING of a
 * target has to line up for STRIKE_ARM_TICKS before anything may hit it; after every hit
 * the next has to wait STRIKE_GAP_TICKS. Drones waiting their turn circle the target at
 * the ring, where air defence can get at them, and the one that goes in starts its dive
 * STRIKE_DIVE_TICKS before the wait is over. A turn nobody takes within
 * STRIKE_WINDOW_TICKS is lost, and the lining up starts again.
 */
export const STRIKE_RING = fx(13);
export const STRIKE_ARM_TICKS = 50;
export const STRIKE_GAP_TICKS = 100;
export const STRIKE_WINDOW_TICKS = 40;
export const STRIKE_DIVE_TICKS = 16;
/**
 * Surveillance cameras (decision 076): an engineer squad leaves one where it stands. A
 * camera reports enemy ground troops in a small circle and cannot be seen or shot. An
 * enemy jammer blinds the cameras in its bubble and shows them to its army, and a camera
 * that has been shown is pulled down by the first enemy ground unit to walk up to it.
 */
export const CAMERA_LIMIT = 12;
export const CAMERA_COST = 20;
export const CAMERA_SIGHT = fx(38);
export const CAMERA_SPACING = fx(14);
export const CAMERA_PULL = fx(5);
export const CAMERA_HEIGHT = fx(2);
/** A camera a jammer has found stays known to the enemy for this long after it drives off. */
export const CAMERA_REVEAL_TICKS = 600;
/**
 * An attack helicopter left to itself hunts (decision 116): it flies at any enemy its army
 * knows of within HUNT_GROUND of where it was left, or any enemy helicopter within HUNT_AIR,
 * and comes back when there is nothing left. Told to hold, it stays.
 */
export const HUNT_GROUND = fx(110);
export const HUNT_AIR = fx(220);
/** How often a hunting helicopter looks again, in ticks. */
export const HUNT_PERIOD = 20;
/**
 * A gunship keeps this far from air defence its army knows of: the guns reach 40, its own
 * rockets 28. Hunting helicopters and the computer's gunships both leave alone what stands
 * under such guns.
 */
export const AA_AVOID = fx(52);
/** Helicopters an army can keep per finished helipad: landing space is what limits them. */
export const HELIS_PER_PAD = 3;
/** Paratroop squads that can wait in reserve, and the most one plane takes. */
export const PARA_RESERVE_MAX = 16;
export const PARA_PLANE_LOAD = 8;
/** Squads land within this of the point asked for, and need this long to get out of the harness. */
export const PARA_SCATTER = fx(9);
export const PARA_LAND_TICKS = 60;
/** Only drones have a radio link to jam: helicopters and planes have a crew aboard. */
export const IS_DRONE: readonly boolean[] = [
  false,
  false,
  false,
  false,
  false,
  false,
  true,
  true,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
];
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
export const TOWN_INCOME = 5;
/**
 * Supplies and fuel a held town pays per second (decision 098): a flag is worth about two
 * trucks, never runs dry, and is lost with the ground.
 */
export const TOWN_SUPPLIES = 2;
export const TOWN_FUEL = 1;

// Night (decision 113).
/** Out of 100: how far ground troops see in the dark. Recon teams and drones see as by day. */
export const NIGHT_SIGHT_PCT = 60;
/** The weather of a battle (decision 125). */
export const WEATHER_CLEAR = 0;
export const WEATHER_RAIN = 1;
export const WEATHER_FOG = 2;
export const WEATHER_SNOW = 3;
/** As an address or a menu names them, by WEATHER_*. */
export const WEATHER_NAMES = ['clear', 'rain', 'fog', 'snow'] as const;
/** How far everyone sees in each weather, percent of a clear day (and of a clear night). */
export const WEATHER_SIGHT_PCT = [100, 85, 55, 80];
/** A flare lights this far round where it bursts, for this long. */
export const FLARE_RADIUS = fx(42);
export const FLARE_TICKS = 30 * 20;
/** A weapon that has fired within this many ticks gives its owner away. */
export const FLASH_TICKS = 50;
/** A vehicle burns for this long after it is knocked out, and lights this far round it. */
export const BURN_TICKS = 45 * 20;
export const BURN_RADIUS = fx(14);

// I6: mortars, rooftops and ambushes.
/**
 * A squad on a roof (the Roof order) reaches at least this much further than its weapon
 * does on the ground, and sees ROOF_SIGHT_PCT percent as far (squared: of its sight
 * squared). Its eyes are a man's height above the top floor.
 */
export const ROOF_RANGE_BONUS = fx(6);
export const ROOF_SIGHT_PCT = 144;
/**
 * From a roof a rocket meets a vehicle's top, the thinnest plate: percent of the damage that
 * gets through, whichever way the vehicle faces (unless its rear, from behind, is thinner).
 */
export const ROOF_TOP_PCT = 200;
/**
 * The price of the roof: no walls round the men, only a parapet. They take this percent of
 * what a squad in the open would, splinters and bursts included, and can be pinned.
 */
export const ROOF_EXPOSED_PCT = 80;
/**
 * A tank gun cannot be raised far enough to hit men on a roof this close (horizontally):
 * the dead ground under the eaves that made rooftops the place to fight tanks from in a
 * city. Carriers' autocannon, helicopters and everything else can.
 */
export const ROOF_DEAD = fx(16);
/**
 * An ambush (the Ambush order) is drawn as a circle between these radii. Men waiting in it
 * hold their fire and, lying still, are as hard to see as in forest; vehicles are not.
 */
export const AMBUSH_MIN = fx(6);
export const AMBUSH_MAX = fx(40);
/** How often (ticks) a waiting ambush looks at its circle. */
export const AMBUSH_PERIOD = 4;
