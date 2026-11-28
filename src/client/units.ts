import { factionOf, kindIn } from './army';
import { FACTIONS } from '../sim/factions';
import * as THREE from 'three/webgpu';
import { attribute, float, smoothstep, uv, vec3 } from 'three/tsl';
import {
  AIR_HEIGHT,
  BLAST_STRAY,
  KINDS,
  KIND_AD,
  KIND_ARTILLERY,
  KIND_ATGM,
  KIND_COUNT,
  KIND_DRONE,
  IS_DRONE,
  KIND_EW,
  KIND_HELI,
  KIND_IFV,
  KIND_LIFT,
  KIND_PARA,
  KIND_PLANE,
  KIND_MORTAR,
  KIND_INFANTRY,
  KIND_RECON,
  KIND_STRIKE,
  KIND_TANK,
  KIND_TRUCK,
  SMOKE_CELLS,
  BURN_TICKS,
  FLARE_RADIUS,
  FLASH_TICKS,
  NIGHT_SIGHT_PCT,
  PIN_TICKS,
  WEATHER_SIGHT_PCT,
} from '../sim/units';
import {
  CLASS_AIR,
  CLASS_FOOT,
  T_BRIDGE,
  T_FORD,
  T_RUBBLE,
  T_SANDBAG,
  T_TRENCH,
  T_WATER,
} from '../sim/map';
import {
  EV_BREACH,
  EV_COLLAPSE,
  EV_STORM,
  EV_STORMED,
  EV_DEATH,
  EV_GUTTED,
  EV_IMPACT,
  EV_AIRSTRIKE,
  EV_BOMB,
  EV_PLANE,
  EV_FLARE,
  EV_SMOKE,
  EV_LAUNCH,
  EV_SHOT,
  EV_SIEGE,
  EV_STRAY,
  EV_UNLOAD,
  EV_WALL,
  MAX_UNITS,
  NO_SEAT,
  STATE_ALIVE,
  STATE_FREE,
  TICK_MS,
  unpackX,
  unpackY,
} from '../sim/world';
import {
  INFO_CARRIED,
  INFO_INSIDE,
  TASK_ROOF,
  INFO_REVEALED,
  INFO_SPOTTED,
  INFO_STATE_MASK,
  INFO_TEAM_MASK,
  INFO_TEAM_SHIFT,
  NO_AIM,
  type Snapshot,
} from '../worker/protocol';
import { Batch } from './batch';
import { ARM_MG, ARM_RIFLE, ARM_TUBE, Soldiers, stillPose } from './soldiers';
import { CREW, WEAPON_LAUNCHER, WEAPON_MORTAR, serve } from './drills';
import { Bodies } from './bodies';
import { Wrecks } from './wrecks';
import type { Effects } from './effects';
import type { Fog } from './fog';
import { COMMANDER_RGB, ICON_FROM, ICON_FULL, ICON_PENNANT, Icons } from './icons';
import type { Look } from './look';
import { BURN_BASE, BURN_SCALE, SEEDS, unitMaterial } from './unitpaint';
import {
  LAUNCHER_AT,
  MORTAR_AT,
  SQUAD_OFFSETS,
  buildArsenal,
  buildBomb,
  box,
  buildInfantry,
  buildLauncher,
  buildMortar,
  type VehicleModel,
} from './models';
import { buildWrecks, strikeAlliance } from './aircraft';
import type { StructureView } from './structures';
import type { Scars } from './scars';
import {
  SND_AUTOCANNON,
  SND_CANNON,
  SND_COLLAPSE,
  SND_EXPLOSION,
  SND_HOWITZER,
  SND_IMPACT,
  SND_JET,
  SND_MORTAR,
  SND_MISSILE,
  SND_RIFLE,
  type Sound,
} from './sound';
import type { Terrain } from './terrain';

// Marking colours (linear RGB): red, blue, gold. Hulls stay in service paint.
export const TEAM_RGB = [
  [0.52, 0.045, 0.03],
  [0.03, 0.15, 0.62],
  [0.62, 0.36, 0.02],
  [0.1, 0.4, 0.12],
];
const HULL_TURN = 2.6; // rad/s, visual only
const TURRET_TURN = 3.2;
const SOLDIER_TURN = 9;
const CULL_RADIUS = 4;
/** Still figures never come nearer than this, however big the crowd: a man is 11 px tall here. */
const STILL_MIN = 80;
const WRECK_SMOKE_SECONDS = 50;
/**
 * How hard a hit from each kind throws the men it kills (I1, client only): shells,
 * missiles, rockets and cannon throw; rifles and machine guns do not.
 */
const THROW = KINDS.map((_, k) =>
  k === KIND_TANK || k === KIND_STRIKE || k === KIND_ARTILLERY
    ? 1
    : k === KIND_ATGM || k === KIND_HELI
      ? 0.85
      : k === KIND_IFV || k === KIND_AD
        ? 0.5
        : 0,
);
/** A shell that lands this close (world units) throws the men it kills. */
const IMPACT_THROW = 6;
/** How far the burst of each kind's direct-fire round throws men (I3), world units; 0 = none. */
const BURST_THROW = KINDS.map((k) => (k.burst > 0 ? k.burst / 1024 + 1 : 0));
const IS_FOOT = KINDS.map((k) => k.cls === CLASS_FOOT);
/** Squads climbing out of a carrier: each man this long after the one before, and how long his run out takes. */
const DISMOUNT_GAP = 0.2;
const DISMOUNT_RUN = 0.75;
const DISMOUNT_SECONDS = 2.2;
const LOD_HIDDEN = 3;
/** What the men of a foot unit do when it halts. */
const DRILL_SQUAD = 0;
const DRILL_CREW = 1;
const DRILL_SCOUT = 2;
/** Radians of stride per map unit walked: one full stride (two steps) carries a running man 1.6 units. */
const STRIDE_RATE = (Math.PI * 2) / 1.6;

/** Kinds drawn as one model (a vehicle or an aircraft), as against men on foot. */
const HAS_MODEL = KINDS.map((k) => k.cls !== CLASS_FOOT);
/** Room for each kind's instances at most. */
const FLEET_ROOM: Partial<Record<number, number>> = {
  [KIND_TANK]: MAX_UNITS,
  [KIND_IFV]: MAX_UNITS >> 1,
  [KIND_ARTILLERY]: MAX_UNITS >> 2,
  [KIND_AD]: MAX_UNITS >> 3,
  [KIND_EW]: MAX_UNITS >> 3,
  [KIND_TRUCK]: MAX_UNITS >> 4,
  [KIND_DRONE]: MAX_UNITS >> 2,
  [KIND_STRIKE]: MAX_UNITS >> 1,
  [KIND_HELI]: 128,
  [KIND_LIFT]: 128,
  [KIND_PLANE]: 32,
};

/** How far a vehicle rocks back from its own gun, radians: by the weight of the shot. */
const ROCK = KINDS.map((_, k) =>
  k === KIND_ARTILLERY
    ? 0.07
    : k === KIND_TANK
      ? 0.045
      : k === KIND_IFV || k === KIND_AD
        ? 0.012
        : 0,
);

/** One army's vehicles and aircraft as they are drawn. */
interface Fleet {
  vehicles: (VehicleDraw | null)[];
  jet: VehicleDraw;
  /** Where this army's helicopter wrecks are in `wreckShapes`: the gunship's, then the lifter's. */
  wrecks: number;
}

/** How a vehicle type is drawn: hull and turret batches per level of detail. */
interface VehicleDraw {
  model: VehicleModel;
  hull: Batch[];
  turret: Batch[];
  /** An aircraft's rotor and propeller shapes, near and middle level each. */
  rotors: Batch[][];
  far: Batch;
}
/** How a foot unit is drawn: figures (men, a launcher) around the unit's centre. */
interface SquadDraw {
  /** With `weapon` the figure is the team's weapon on the ground; without, a soldier, who may turn to face it. */
  figures: { weapon?: number; x: number; z: number; turn?: number }[];
  /** What the men do when halted: see DRILL_*. */
  drill: number;
  /** The weapon the team serves (drills.ts WEAPON_*), 0 for none. */
  weapon: number;
  far: Batch;
}
/** One army's men: its soldiers, the weapons its teams set down, and its dead (bodies.ts set). */
interface Troop {
  soldiers: Soldiers;
  weapons: (Batch[] | null)[];
  dead: number;
}
/** Kinds with a hull whose direction comes from the sim. */
const IS_VEHICLE = KINDS.map((k) => k.turn > 0);
const IS_AIR = KINDS.map((k) => k.cls === CLASS_AIR);
const ALTITUDE = AIR_HEIGHT / 1024;
/** The transport plane comes over well above the helicopters and the drones. */
const PLANE_ALTITUDE = ALTITUDE + 9;
const IS_HELI = KINDS.map((_, k) => k === KIND_HELI || k === KIND_LIFT);
/** The most an aircraft of each kind banks in a turn, and how far it puts its nose down to go forward, radians. */
const AIR_BANK = KINDS.map((_, k) =>
  k === KIND_PLANE ? 0.5 : k === KIND_HELI ? 0.42 : k === KIND_LIFT ? 0.28 : 0.5,
);
const AIR_NOSE = KINDS.map((_, k) =>
  k === KIND_HELI ? -0.13 : k === KIND_LIFT ? -0.09 : k === KIND_STRIKE ? -0.22 : 0,
);
/** Seconds a paratroop squad hangs under its canopy, and how high it starts. */
const CHUTE_SECONDS = 3.2;
const CHUTE_HEIGHT = 15;
/**
 * How far each type lifts the fog, in cells: its sight in the sim plus a little, negative
 * for drones, which look straight down past houses and hills.
 */
const FOG_SIGHT = FACTIONS.map((f) =>
  f.kinds.map((k) => (Math.ceil(k.sight / 4096) + 1) * (k.cls === CLASS_AIR ? -1 : 1)),
);
/** The same at night (decision 113): six tenths, except the scouts and their drone. */
const NIGHT_FOG_SIGHT = FACTIONS.map((f, n) =>
  f.kinds.map((k, i) =>
    i === KIND_RECON || i === KIND_DRONE
      ? FOG_SIGHT[n][i]
      : (Math.ceil((k.sight * NIGHT_SIGHT_PCT) / 100 / 4096) + 1) * (k.cls === CLASS_AIR ? -1 : 1),
  ),
);
/** What a flare shows, in cells, and how long a muzzle flash and a burning wreck do. */
const FLARE_CELLS = Math.round(FLARE_RADIUS / 4096);
const FLASH_SECONDS = FLASH_TICKS / 20;
const BURN_SECONDS = BURN_TICKS / 20;
/** How high a flare hangs: it bursts at 46 m and comes down under its parachute. */
export function flareHeight(
  f: { y: number; from: number; until: number },
  seconds: number,
): number {
  const t = Math.min(1, Math.max(0, (seconds - f.from) / (f.until - f.from)));
  return f.y + 46 - 24 * t;
}

export interface LodStats {
  /** Units drawn at each level of detail this frame, and units culled as off-screen. */
  lod: [number, number, number];
  /** Of the middle level, the units drawn as still figures (decision 135). */
  still: number;
  culled: number;
}

/**
 * Draws every unit with a handful of instanced draw calls. Each frame, per unit: interpolate
 * between the last two 20 Hz snapshots, cull against the view frustum, pick a level of
 * detail by distance, and write the instance into that level's batch.
 */
/** Room a unit batch starts with; it doubles as needed up to its capacity (see Batch). */
/** Room a unit batch starts with; it doubles as needed up to its capacity (see Batch). */
const UNIT_BATCH_START = 256;

export class UnitView {
  readonly group = new THREE.Group();
  readonly rings: THREE.InstancedMesh;
  count = 0;
  /** Interpolated render positions (x, y, z per unit), reused by selection picking. */
  readonly renderPos = new Float32Array(MAX_UNITS * 3);
  readonly selected = new Uint8Array(MAX_UNITS);
  selectedCount = 0;
  /** Latest per-unit state/kind/team bits from the sim (see INFO_* in the protocol). */
  readonly info = new Uint8Array(MAX_UNITS);
  readonly stats: LodStats = { lod: [0, 0, 0], still: 0, culled: 0 };
  /** Distances (world units) at which units drop to LOD 1 and LOD 2. */
  lodNear = 120;
  /** Inside this a vehicle is drawn with everything on it; from here to `lodNear`, its masses. */
  lodFull = 50;
  /** At most about this many vehicles in full detail at once: a parked army is not all of it. */
  fullBudget = 20;
  private fullScale = 1;
  /** Beyond this a still soldier is a figure of boxes: a few pixels of the right colours. */
  lodBlock = 150;
  lodFar = 340;
  /**
   * From here out to `lodFar` a foot soldier is a still figure: one instance in a fixed pose
   * instead of eight posed pieces (decision 135). A man there is under seven pixels tall.
   */
  lodStill = 135;
  /**
   * Units posed in pieces at the middle level at most this many: in a crowd the still
   * figures come in closer (never nearer than `STILL_MIN`), as the near level does.
   */
  midBudget = 300;
  private stillScale = 1;
  /**
   * Full-detail units drawn at most this many (the nearest distance shrinks until it is so,
   * and grows back when there is room): looking down into a battle from close by must not
   * mean thousands of soldiers modelled in full. Set from the graphics level.
   */
  nearBudget = 300;
  private nearScale = 1;

  private prev = new Float32Array(MAX_UNITS * 2);
  private curr = new Float32Array(MAX_UNITS * 2);
  private readonly hp = new Uint8Array(MAX_UNITS);
  private readonly aim = new Uint16Array(MAX_UNITS).fill(NO_AIM);
  private readonly heading = new Float32Array(MAX_UNITS);
  private readonly headingGoal = new Float32Array(MAX_UNITS);
  private readonly turret = new Float32Array(MAX_UNITS);
  private readonly moving = new Uint8Array(MAX_UNITS);
  /** Seconds (client clock) of the last shot and of death, for recoil and wreck smoke. */
  private readonly shotAt = new Float32Array(MAX_UNITS).fill(-1e9);
  /** Per foot unit, eased 0 to 1: how settled it is at the halt, and how much in a fight. */
  private readonly halted = new Float32Array(MAX_UNITS);
  private readonly fight = new Float32Array(MAX_UNITS);
  private readonly troops: (Troop | undefined)[] = [];
  /** How far each squad has walked while in view, and from where: the men's stride follows it. */
  /** The heading each aircraft had last frame: how hard it is turning sets its bank. */
  private readonly airH = new Float32Array(MAX_UNITS);
  private readonly gait = new Float32Array(MAX_UNITS);
  private readonly gaitX = new Float32Array(MAX_UNITS);
  private readonly gaitZ = new Float32Array(MAX_UNITS);
  /** For tuning and screenshots: force every foot unit to [halted, fight, seconds since a shot]. */
  pose: [number, number, number] | null = null;
  private readonly diedAt = new Float32Array(MAX_UNITS).fill(-1e9);
  /** The dead, who stay where they fell all game (I1). */
  readonly bodies: Bodies;
  /** Helicopters that came down stay where they fell (wrecks.ts). */
  readonly wrecks: Wrecks;
  /** The last blast that hit each unit (client seconds), its strength and where it came from. */
  private readonly blastAt = new Float32Array(MAX_UNITS).fill(-1e9);
  private readonly blastPow = new Float32Array(MAX_UNITS);
  /** Until when (seconds) each squad is pinned by a machine gun, as far as the screen knows. */
  private readonly pinnedUntil = new Float32Array(MAX_UNITS).fill(-1e9);
  private readonly blastX = new Float32Array(MAX_UNITS);
  private readonly blastZ = new Float32Array(MAX_UNITS);
  /** Shells landed lately: x, z, seconds. */
  private readonly impacts: number[] = [];
  /** Men who dropped out of their squads in this snapshot: unit, x, z, heading, team, paint, seen. */
  private readonly fallen: number[] = [];
  /** Squads climbing out of a carrier: when, and the carrier's door (x, y above ground, z). */
  private readonly dismountAt = new Float32Array(MAX_UNITS).fill(-1e9);
  private readonly doorX = new Float32Array(MAX_UNITS);
  private readonly doorY = new Float32Array(MAX_UNITS);
  private readonly doorZ = new Float32Array(MAX_UNITS);
  private snapshotTime = 0;
  private fogAge = 0;
  /** Bumped each time a slot gets a new occupant, so stale references can be told apart. */
  readonly gen = new Uint16Array(MAX_UNITS);
  /** The army the player commands and sees through. */
  playerTeam = 0;
  /** Level of detail each unit was last drawn at; LOD_HIDDEN when off-screen. */
  private readonly lodOf = new Uint8Array(MAX_UNITS).fill(LOD_HIDDEN);

  /** Latest per-unit type, hull heading and passengers from the sim. */
  readonly kind = new Uint8Array(MAX_UNITS);
  readonly load = new Uint8Array(MAX_UNITS);
  private readonly shots = new Uint8Array(MAX_UNITS);
  /** Per unit: job | stance, see TASK_* in the protocol. */
  readonly task = new Uint8Array(MAX_UNITS);
  /** Per unit: how it is told to move (SHAPE_*). */
  readonly shape = new Uint8Array(MAX_UNITS);
  /** Per unit: the sub-commander it answers to, or -1. */
  readonly cmdr = new Int8Array(MAX_UNITS).fill(-1);
  /** Per unit: the player of a shared army whose it is, or NO_SEAT (decision 146). */
  readonly owner = new Uint8Array(MAX_UNITS).fill(NO_SEAT);
  /** A shared army: our seat, and a colour per seat for the marks under teammates' units. */
  mySeat = -1;
  seatRgb: readonly (readonly number[])[] = [];
  /** Whether teammates' units carry a mark in their colour on the ground. */
  ownerMarks = true;
  private readonly ownerRings: Batch;
  /** Each army's vehicles, by faction then kind, built when that faction first takes the field. */
  private readonly fleets: (Fleet | undefined)[] = [];
  /** Every army's helicopter wrecks, three ways to lie each (wrecks.ts reads it as it grows). */
  private readonly wreckShapes: Batch[][] = [];
  private readonly material: THREE.MeshStandardNodeMaterial;
  private readonly castShadows: boolean;
  /** How each ground vehicle lies on its slope and its springs: pitch and roll, eased. */
  private readonly tiltP = new Float32Array(MAX_UNITS);
  private readonly tiltR = new Float32Array(MAX_UNITS);
  private readonly hullFrame = new Float32Array(12);
  private readonly squads: (SquadDraw | null)[] = new Array(KIND_COUNT).fill(null);
  private readonly batches: Batch[] = [];
  private readonly chutes: Batch;
  /** Planes that are strike jets (I7), drawn as one: set by EV_AIRSTRIKE, cleared by EV_PLANE. */
  private readonly jets = new Uint8Array(MAX_UNITS);
  /** Bombs and swarm munitions on their way down (EV_BOMB), drawn until they land. */
  private readonly falling: {
    x0: number;
    y0: number;
    z0: number;
    x1: number;
    z1: number;
    t0: number;
    t1: number;
    swarm: boolean;
  }[] = [];
  private readonly bombs: Batch;
  private readonly munitions: Batch;
  /** When each paratroop squad left the plane. */
  private readonly dropAt = new Float64Array(MAX_UNITS).fill(-1e9);
  private readonly jamRings: Batch;
  private readonly shade: Batch;
  private readonly realShadows: boolean;
  /** Squads on the move in view last frame: sets how often each may raise dust. */
  private walkers = 0;
  private readonly icons = new Icons(MAX_UNITS * 2);
  /** Draw a pennant over troops that answer to a sub-commander. */
  pennants = true;
  /** How far the camera is from what it looks at: decides when the map symbols show. */
  zoom = 0;
  private readonly camRight = new THREE.Vector3();
  private readonly camUp = new THREE.Vector3();
  private readonly frustum = new THREE.Frustum();
  private readonly projScreen = new THREE.Matrix4();

  constructor(
    private readonly terrain: Terrain,
    private readonly effects: Effects,
    private readonly fog: Fog,
    look: Look,
    private readonly structures: StructureView,
    private readonly scars: Scars,
  ) {
    this.material = unitMaterial(look, fog.cloud());
    this.castShadows = look.shadows;
    this.nearBudget = look.quality === 'low' ? 120 : look.quality === 'high' ? 500 : 300;
    const batch = (g: THREE.BufferGeometry, cap: number, lod: number, men = false) =>
      this.batch(g, cap, lod, men);
    for (let t = 0; t < 4; t++) this.fleet(factionOf(t));
    this.bombs = batch(buildBomb(), 64, 1);
    this.munitions = batch(strikeAlliance().hull[1], 64, 1);
    this.chutes = batch(
      box(2.6, 0.9, 2.6, { at: [0, 0, 0], top: [0.45, 0.45], color: 0xa9ab98, team: 0.06 }),
      256,
      0,
    );
    const infantry = buildInfantry();
    // The dead keep their own batches, rewritten only when something changes (bodies.ts).
    this.bodies = new Bodies(
      [],
      [],
      this.kept(
        box(0.22, 0.09, 0.56, { at: [0, 0.045, 0], color: 0x4a4a38, team: 0.3, cloth: true }),
        32768,
        2,
      ),
      terrain,
      fog,
      effects,
      TEAM_RGB,
    );
    for (let t = 0; t < 4; t++) this.troop(factionOf(t));
    this.wrecks = new Wrecks(this.wreckShapes, terrain, fog, effects, TEAM_RGB, (x, z, seen) => {
      // It hits the ground: a second blast, a scorched patch, a thud.
      this.scars.add(x, z, 1.6, true);
      this.terrain.stamp(x, z, 2, 60);
      this.sound?.at(SND_EXPLOSION, x, z, seen);
      if (seen) effects.explosion(x, this.terrain.heightAt(x, z), z);
    });
    this.squads[KIND_INFANTRY] = {
      figures: SQUAD_OFFSETS.map(([x, z]) => ({ x, z })),
      drill: DRILL_SQUAD,
      weapon: 0,
      far: batch(infantry.far, MAX_UNITS, 2),
    };
    const crew = (weapon: number, at: readonly [number, number]) => [
      { weapon, x: at[0], z: at[1] },
      ...CREW[weapon].map(({ x, z, turn }) => ({ x, z, turn })),
    ];
    this.squads[KIND_ATGM] = {
      figures: crew(WEAPON_LAUNCHER, LAUNCHER_AT),
      drill: DRILL_CREW,
      weapon: WEAPON_LAUNCHER,
      far: batch(buildLauncher().far, MAX_UNITS >> 2, 2),
    };
    // The mortar team (I6): the tube in front, its two crewmen at it.
    this.squads[KIND_MORTAR] = {
      figures: crew(WEAPON_MORTAR, MORTAR_AT),
      drill: DRILL_CREW,
      weapon: WEAPON_MORTAR,
      far: batch(buildMortar().far, MAX_UNITS >> 3, 2),
    };
    // A recon team is two men: fewer, and that is how you tell it from a rifle squad.
    const pair: [number, number][] = [
      [-0.3, 0.1],
      [0.35, -0.2],
    ];
    this.squads[KIND_RECON] = {
      figures: pair.map(([x, z]) => ({ x, z })),
      drill: DRILL_SCOUT,
      weapon: 0,
      far: batch(
        new THREE.BoxGeometry(0.9, 0.5, 0.5).translate(0, 0.25, 0).deleteAttribute('uv'),
        MAX_UNITS >> 3,
        2,
      ),
    };

    // The jammer's bubble, drawn on the ground: yours in amber, the enemy's in red.
    const jamMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true });
    const jamTint = attribute('aTint', 'vec4');
    jamMaterial.colorNode = jamTint.xyz;
    jamMaterial.opacityNode = jamTint.w;
    jamMaterial.depthWrite = false;
    jamMaterial.depthTest = false;
    jamMaterial.fog = false;
    this.jamRings = new Batch(
      new THREE.RingGeometry(0.985, 1, 128).rotateX(-Math.PI / 2),
      jamMaterial,
      512,
    );
    this.jamRings.mesh.renderOrder = 3;
    this.group.add(this.jamRings.mesh);
    // A shared army: a thin ring in a teammate's colour under each of his units.
    const ownerMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true });
    ownerMaterial.colorNode = jamTint.xyz;
    ownerMaterial.opacityNode = jamTint.w;
    ownerMaterial.depthWrite = false;
    ownerMaterial.fog = false;
    this.ownerRings = new Batch(
      new THREE.RingGeometry(1.02, 1.3, 20).rotateX(-Math.PI / 2),
      ownerMaterial,
      MAX_UNITS,
      256,
    );
    this.group.add(this.ownerRings.mesh);

    // A soft patch of shade under each squad that is too far off to cast a real shadow:
    // it ties the men to the ground and darkens the spot they stand on. One flat quad a
    // squad, in one draw call.
    const shadeMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true });
    const fromCentre = uv().sub(0.5).length().mul(2);
    shadeMaterial.colorNode = vec3(0, 0, 0);
    shadeMaterial.opacityNode = attribute('aTint', 'vec4').w.mul(
      float(1).sub(smoothstep(0.25, 1, fromCentre)),
    );
    shadeMaterial.depthWrite = false;
    shadeMaterial.fog = false;
    shadeMaterial.polygonOffset = true;
    shadeMaterial.polygonOffsetFactor = -2;
    shadeMaterial.polygonOffsetUnits = -2;
    this.shade = new Batch(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      shadeMaterial,
      MAX_UNITS,
    );
    this.shade.mesh.renderOrder = 0;
    this.realShadows = look.shadows;
    this.group.add(this.shade.mesh);

    this.group.add(this.icons.batch.mesh);

    const ringGeometry = new THREE.RingGeometry(1.5, 1.72, 24).rotateX(-Math.PI / 2);
    const ringMaterial = new THREE.MeshBasicNodeMaterial({ color: 0x7dff8a, transparent: true });
    ringMaterial.opacity = 0.9;
    ringMaterial.depthWrite = false;
    this.rings = new THREE.InstancedMesh(ringGeometry, ringMaterial, MAX_UNITS);
    this.rings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.rings.frustumCulled = false;
    this.rings.count = 0;
    this.group.add(this.rings);
  }

  /** One more instanced draw call in the unit material, emptied and refilled every frame. */
  private batch(g: THREE.BufferGeometry, cap: number, lod: number, men = false): Batch {
    const b = new Batch(g, this.material, cap, UNIT_BATCH_START);
    // Far LOD is a few pixels: no shadow work for it. Soldiers are five meshes a squad, so
    // only the nearest cast any; a vehicle keeps its shadow one level further out.
    b.mesh.castShadow = this.castShadows && lod < (men ? 1 : 2);
    b.mesh.receiveShadow = this.castShadows && lod === 0;
    this.group.add(b.mesh);
    this.batches.push(b);
    return b;
  }

  /** A batch that is rewritten only when something changes (the dead), not every frame. */
  private kept(g: THREE.BufferGeometry, cap: number, lod: number): Batch {
    const b = new Batch(g, this.material, cap, UNIT_BATCH_START);
    b.mesh.castShadow = this.castShadows && lod === 0;
    b.mesh.receiveShadow = this.castShadows && lod === 0;
    this.group.add(b.mesh);
    return b;
  }

  /** The men of a faction: its own kit and weapons (soldiers.ts), built the first time it is asked for. */
  private troop(faction: number): Troop {
    const have = this.troops[faction];
    if (have) return have;
    const soldiers = new Soldiers((g, cap, lod) => this.batch(g, cap, lod, true), faction);
    const set = (g: THREE.BufferGeometry, cap: number) =>
      [0, 1].map((lod) => this.batch(lod === 0 ? g : g.clone(), cap, lod, true));
    const made: Troop = {
      soldiers,
      weapons: [
        null,
        set(buildLauncher(faction).launcher, MAX_UNITS >> 2),
        set(buildMortar(faction).tube, MAX_UNITS >> 3),
      ],
      dead: this.bodies.addSet(
        soldiers.deadPoses(0).map((g) => this.kept(g, 1024, 0)),
        soldiers.deadPoses(1).map((g) => this.kept(g, 8192, 1)),
      ),
    };
    this.troops[faction] = made;
    return made;
  }

  /** The vehicles of a faction: its own models (models.ts), built the first time it is asked for. */
  private fleet(faction: number): Fleet {
    const have = this.fleets[faction];
    if (have) return have;
    const arsenal = buildArsenal(faction);
    const draw = (model: VehicleModel, cap: number): VehicleDraw => ({
      model,
      // Three levels of shape over two of distance: the first two are both "near".
      hull: model.hull.map((g, level) => this.batch(g, cap, level < 2 ? 0 : 1)),
      turret: model.turret.map((g, level) => this.batch(g, cap, level < 2 ? 0 : 1)),
      rotors: (model.rotorShapes ?? []).map((levels, shape) =>
        levels.map((g, lod) =>
          this.batch(g, cap * model.rotors!.filter((r) => r.shape === shape).length, lod),
        ),
      ),
      far: this.batch(model.far, cap, 2),
    });
    const crashed = (model: VehicleModel) =>
      buildWrecks(model).map((g) => {
        const b = new Batch(g, this.material, 256, 16);
        b.mesh.castShadow = this.castShadows;
        b.mesh.receiveShadow = this.castShadows;
        this.group.add(b.mesh);
        return b;
      });
    const made: Fleet = {
      vehicles: arsenal.vehicles.map((m, kind) => (m ? draw(m, FLEET_ROOM[kind] ?? 256) : null)),
      jet: draw(arsenal.jet, 16),
      wrecks: this.wreckShapes.length,
    };
    this.wreckShapes.push(
      crashed(arsenal.vehicles[KIND_HELI]!),
      crashed(arsenal.vehicles[KIND_LIFT]!),
    );
    this.fleets[faction] = made;
    return made;
  }

  /** How unit `i` is drawn if it is a vehicle or an aircraft; null for men on foot. */
  private drawOf(i: number): VehicleDraw | null {
    const fleet = this.fleet(factionOf((this.info[i] >> INFO_TEAM_SHIFT) & INFO_TEAM_MASK));
    return this.kind[i] === KIND_PLANE && this.jets[i] !== 0
      ? fleet.jet
      : fleet.vehicles[this.kind[i]];
  }

  applySnapshot(s: Snapshot, now: number): void {
    const n = s.count;
    const before = this.count;
    const swap = this.prev;
    this.prev = this.curr;
    this.curr = swap;
    this.curr.set(s.positions);
    if (n < before) {
      // World was reset.
      this.selected.fill(0);
      this.selectedCount = 0;
      this.info.fill(0);
      this.diedAt.fill(-1e9);
      this.fog.reset();
      this.smokes.length = 0;
      this.flares.length = 0;
      this.scars.clear();
      this.bodies.clear();
      this.wrecks.clear();
      this.impacts.length = 0;
      this.blastAt.fill(-1e9);
      this.pinnedUntil.fill(-1e9);
      this.dismountAt.fill(-1e9);
    }
    const curr = this.curr;
    const prev = this.prev;
    // Carriers putting their squads down in this snapshot, for the men to climb out of.
    const unloading: number[] = [];
    for (let e = 0; e < s.events.length; e += 3) {
      if (s.events[e] === EV_UNLOAD && s.events[e + 1] < n) unloading.push(s.events[e + 1]);
    }
    const seconds = now / 1000;
    this.fallen.length = 0;
    for (let i = 0; i < n; i++) {
      const alive = (s.info[i] & INFO_STATE_MASK) === STATE_ALIVE;
      const wasAlive = (this.info[i] & INFO_STATE_MASK) === STATE_ALIVE;
      if (
        wasAlive &&
        i < before &&
        !HAS_MODEL[this.kind[i]] &&
        (this.info[i] & (INFO_CARRIED | INFO_INSIDE)) === 0
      ) {
        // Men drop out of a squad as it loses health: each leaves a body (I1).
        const figures = (this.squads[this.kind[i]] ?? this.squads[KIND_INFANTRY]!).figures;
        const was = Math.ceil((this.hp[i] * figures.length) / 255);
        const left =
          alive && s.kind[i] === this.kind[i] ? Math.ceil((s.hp[i] * figures.length) / 255) : 0;
        if (left < was) this.dropMen(i, left, was, figures);
      }
      if (
        alive &&
        wasAlive &&
        unloading.length > 0 &&
        s.kind[i] !== KIND_PARA &&
        (this.info[i] & INFO_CARRIED) !== 0 &&
        (s.info[i] & INFO_CARRIED) === 0
      ) {
        // Out of a carrier: the men climb out of its back, one after another.
        let best = unloading[0];
        let bestD = Infinity;
        for (const c of unloading) {
          const d = Math.hypot(curr[2 * c] - curr[2 * i], curr[2 * c + 1] - curr[2 * i + 1]);
          if (d < bestD) {
            bestD = d;
            best = c;
          }
        }
        if (bestD < 12) {
          const h = (s.heading[best] * Math.PI) / 128;
          this.doorX[i] = curr[2 * best] - Math.sin(h) * 1.1;
          this.doorZ[i] = curr[2 * best + 1] - Math.cos(h) * 1.1;
          this.doorY[i] = IS_AIR[s.kind[best]] ? ALTITUDE : 0.3;
          this.dismountAt[i] = seconds;
          prev[2 * i] = curr[2 * i];
          prev[2 * i + 1] = curr[2 * i + 1];
        }
      }
      if (!alive) {
        if (this.selected[i]) {
          this.selected[i] = 0;
          this.selectedCount--;
        }
        prev[2 * i] = curr[2 * i];
        prev[2 * i + 1] = curr[2 * i + 1];
        this.moving[i] = 0;
        continue;
      }
      if (
        s.kind[i] === KIND_PARA &&
        (s.info[i] & INFO_CARRIED) === 0 &&
        (this.info[i] & INFO_CARRIED) !== 0 &&
        wasAlive
      ) {
        // Out of the plane: it comes down under a canopy from here.
        this.dropAt[i] = now / 1000;
        prev[2 * i] = curr[2 * i];
        prev[2 * i + 1] = curr[2 * i + 1];
      }
      if (!wasAlive) {
        // New unit (or a reused slot): do not interpolate from wherever the slot was before.
        this.gen[i]++;
        this.tiltP[i] = this.tiltR[i] = 0;
        this.airH[i] = NaN;
        prev[2 * i] = curr[2 * i];
        prev[2 * i + 1] = curr[2 * i + 1];
        // Face the enemy side of the map until it moves.
        const h =
          ((s.info[i] >> INFO_TEAM_SHIFT) & INFO_TEAM_MASK) === 0 ? Math.PI / 2 : -Math.PI / 2;
        this.heading[i] = this.headingGoal[i] = this.turret[i] = h + ((i * 0.618) % 0.3) - 0.15;
        this.shotAt[i] = -1e9;
      }
      const dx = curr[2 * i] - prev[2 * i];
      const dz = curr[2 * i + 1] - prev[2 * i + 1];
      const d2 = dx * dx + dz * dz;
      // Only turn when really moving, so separation nudges do not make idle units twitch.
      this.moving[i] = d2 > 0.012 ? 1 : 0;
      if (IS_VEHICLE[s.kind[i]]) {
        // Hulls point where the sim says: that is the armour the enemy is shooting at.
        const h = (s.heading[i] * Math.PI) / 128;
        this.headingGoal[i] = h > Math.PI ? h - 2 * Math.PI : h;
        if (!wasAlive) this.heading[i] = this.turret[i] = this.headingGoal[i];
      } else if (this.moving[i]) this.headingGoal[i] = Math.atan2(dx, dz);
    }
    this.info.set(s.info);
    this.kind.set(s.kind);
    this.load.set(s.load);
    this.task.set(s.task);
    this.shape.set(s.shape);
    this.cmdr.set(s.cmdr);
    this.owner.set(s.owner);
    this.hp.set(s.hp);
    this.aim.set(s.aim);
    this.count = n;
    this.snapshotTime = now;
    // Sight is refreshed every other tick (10 Hz): plenty for units that move this slowly.
    if (this.fogAge++ % 2 === 0) {
      this.fog.clock = now / 1000;
      const sights =
        this.sights ?? (this.night ? NIGHT_FOG_SIGHT : FOG_SIGHT)[factionOf(this.playerTeam)];
      if (this.night) this.nightLights(n, now / 1000);
      this.fog.update(
        this.curr,
        n,
        (id) => this.isMine(id),
        // A jammed drone sends nothing back.
        (id) => (IS_DRONE[this.kind[id]] && this.load[id] > 0 ? 0 : sights[this.kind[id]]),
      );
    }
    // Vehicles wear the ground they drive over (where the player can see it happen): a
    // column's route turns to mud. Five times a second is plenty at these speeds.
    if (this.fogAge % 4 === 0) {
      for (let i = 0; i < n; i++) {
        const k = this.kind[i];
        if (this.moving[i] === 0 || !IS_VEHICLE[k] || IS_AIR[k]) continue;
        const x = curr[2 * i];
        const z = curr[2 * i + 1];
        if (this.teamOf(i) !== this.playerTeam && !this.fog.sees(x, z)) continue;
        this.terrain.stamp(x, z, 1.2, 3, 190);
      }
    }
    this.playEvents(s.events, seconds);
    this.layFallen(seconds);
    this.sound?.flush();
  }

  /** Men `from` to `to` - 1 of squad `i` have fallen: note where, to lay them down. */
  private dropMen(
    i: number,
    from: number,
    to: number,
    figures: readonly { weapon?: number; x: number; z: number }[],
  ): void {
    const pos = this.renderPos;
    const x = pos[3 * i];
    const z = pos[3 * i + 2];
    if (x === 0 && z === 0) return;
    const h = this.heading[i];
    const sin = Math.sin(h);
    const cos = Math.cos(h);
    const team = this.teamOf(i);
    const coat = factionOf(team) * SEEDS;
    for (let k = from; k < to; k++) {
      const f = figures[k];
      if (!f || f.weapon) continue;
      const mx = x + f.x * cos + f.z * sin;
      const mz = z - f.x * sin + f.z * cos;
      const seen = team === this.playerTeam || this.fog.sees(mx, mz) ? 1 : 0;
      this.fallen.push(i, mx, mz, h, team, ((i + k * 5) % SEEDS) + coat + BURN_BASE, seen);
    }
  }

  /**
   * Lay down the men who fell in this snapshot. One killed by a shell, a missile, a rocket
   * or a cannon round is thrown away from the blast first; one shot falls where he stood.
   */
  private layFallen(seconds: number): void {
    const fallen = this.fallen;
    const impacts = this.impacts;
    // Shells more than a second old have done their work.
    let keep = 0;
    for (let k = 0; k < impacts.length; k += 4) {
      if (seconds - impacts[k + 2] > 1.2) continue;
      impacts[keep++] = impacts[k];
      impacts[keep++] = impacts[k + 1];
      impacts[keep++] = impacts[k + 2];
      impacts[keep++] = impacts[k + 3];
    }
    impacts.length = keep;
    const pos = this.renderPos;
    for (let k = 0; k < fallen.length; k += 7) {
      const i = fallen[k];
      const x = fallen[k + 1];
      const z = fallen[k + 2];
      let dx = 0;
      let dz = 0;
      let power = 0;
      if (seconds - this.blastAt[i] < 0.8 && this.blastPow[i] > 0) {
        // Hit where the squad stands, from the shooter's side: thrown away from both.
        const ux = pos[3 * i] - this.blastX[i];
        const uz = pos[3 * i + 2] - this.blastZ[i];
        const ul = Math.hypot(ux, uz) || 1;
        const bx = pos[3 * i] - (ux / ul) * 0.6;
        const bz = pos[3 * i + 2] - (uz / ul) * 0.6;
        dx = x - bx;
        dz = z - bz;
        power = this.blastPow[i] * (0.7 + Math.random() * 0.3);
      }
      for (let m = 0; m < impacts.length; m += 4) {
        const ix = x - impacts[m];
        const iz = z - impacts[m + 1];
        const d = Math.hypot(ix, iz);
        const reach = impacts[m + 3];
        // (A shell throws harder than the burst of a tank round or a rocket.)
        const p = d < reach ? (1 - d / reach) * (reach >= IMPACT_THROW ? 1.1 : 0.9) : 0;
        if (p > power) {
          power = p;
          dx = ix;
          dz = iz;
        }
      }
      // Burnt a little by a blast, dusty either way.
      const paint = fallen[k + 5] + BURN_SCALE * (power > 0 ? 0.22 : 0.08);
      this.bodies.add(
        x,
        z,
        fallen[k + 3],
        fallen[k + 4],
        paint,
        dx,
        dz,
        power,
        fallen[k + 6] === 1,
        this.troop(factionOf(fallen[k + 4])).dead,
      );
    }
    fallen.length = 0;
  }

  /** Set by the game once there is sound; without it the battle is silent. */
  sound: Sound | null = null;

  /** The noise unit `a` makes when it fires. */
  private report(a: number): void {
    const sound = this.sound;
    if (sound === null) return;
    const kind = this.kind[a];
    const x = this.renderPos[3 * a];
    const z = this.renderPos[3 * a + 2];
    const snd =
      kind === KIND_ATGM || kind === KIND_STRIKE || kind === KIND_HELI
        ? SND_MISSILE
        : kind === KIND_IFV || kind === KIND_AD
          ? SND_AUTOCANNON
          : HAS_MODEL[kind]
            ? SND_CANNON
            : SND_RIFLE;
    sound.at(snd, x, z, this.fog.sees(x, z));
  }

  /** A night battle: shorter sight, and light shows what is near it. */
  night = false;
  /** In weather: how far each kind lifts the fog, in place of the tables (see setWeather). */
  private sights: number[] | null = null;

  /** Rain, fog and snow shorten what every unit shows of the map, as they do in the sim. */
  setWeather(weather: number): void {
    const pct = WEATHER_SIGHT_PCT[weather] ?? 100;
    if (pct === 100) return;
    this.sights = FACTIONS[factionOf(this.playerTeam)].kinds.map((k, i) => {
      const dark = this.night && i !== KIND_RECON && i !== KIND_DRONE ? NIGHT_SIGHT_PCT : 100;
      const cells = Math.ceil((k.sight * dark * pct) / 10000 / 4096) + 1;
      return cells * (k.cls === CLASS_AIR ? -1 : 1);
    });
  }
  /** Flares hanging over the field (world metres; `from` and `until` in seconds). */
  readonly flares: { x: number; y: number; z: number; from: number; until: number }[] = [];
  /** Where the player has troops, in 16 m squares. */
  private readonly mineNear = new Uint8Array(64 * 64);

  /**
   * Night: tell the fog what is lit. A flare shows the ground under it to everyone; an
   * enemy that has just fired, or the ground round a burning vehicle, shows to troops
   * within their daytime sight of it.
   */
  private nightLights(n: number, seconds: number): void {
    const lights = this.fog.lights;
    lights.length = 0;
    for (const f of this.flares) lights.push(f.x >> 2, f.z >> 2, FLARE_CELLS);
    const near = this.mineNear.fill(0);
    const pos = this.curr;
    const cell = (v: number) => Math.min(63, Math.max(0, v >> 4));
    for (let i = 0; i < n; i++) {
      if (this.isMine(i)) near[cell(pos[2 * i + 1]) * 64 + cell(pos[2 * i])] = 1;
    }
    for (let i = 0; i < n; i++) {
      if (this.teamOf(i) === this.playerTeam) continue;
      let r = 0;
      if (this.isAlive(i)) {
        if (seconds - this.shotAt[i] < FLASH_SECONDS) r = 1;
      } else if (IS_VEHICLE[this.kind[i]] && seconds - this.diedAt[i] < BURN_SECONDS) r = 3;
      if (r === 0) continue;
      const cx = cell(pos[2 * i]);
      const cy = cell(pos[2 * i + 1]);
      let seen = false;
      for (let dy = -2; dy <= 2 && !seen; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x >= 0 && y >= 0 && x < 64 && y < 64 && near[y * 64 + x] === 1) {
            seen = true;
            break;
          }
        }
      }
      if (seen) lights.push(pos[2 * i] >> 2, pos[2 * i + 1] >> 2, r);
    }
  }

  /** Keep the flares burning as they drift down, and drop the ones that have gone out. */
  private burnFlares(seconds: number): void {
    const flares = this.flares;
    for (let k = flares.length - 1; k >= 0; k--) {
      const f = flares[k];
      if (f.until < seconds) {
        flares[k] = flares[flares.length - 1];
        flares.pop();
        continue;
      }
      this.effects.thin = 0;
      this.effects.flare(f.x, flareHeight(f, seconds), f.z);
    }
  }

  /** Smoke screens standing on the field. */
  private smokes: { x: number; y: number; z: number; until: number }[] = [];

  /** Keep the smoke screens billowing until they blow away. */
  private billow(seconds: number, dt: number): void {
    const smokes = this.smokes;
    for (let k = smokes.length - 1; k >= 0; k--) {
      const s = smokes[k];
      if (s.until - 3 < seconds) {
        smokes[k] = smokes[smokes.length - 1];
        smokes.pop();
      } else if (Math.random() < dt * 7) {
        this.effects.thin = 0;
        this.effects.smokeScreen(s.x, s.y, s.z);
      }
    }
  }

  /** Bombs fall faster and faster from under the jet; a swarm munition curves over and dives. */
  private drawFalling(seconds: number): void {
    const list = this.falling;
    let keep = 0;
    for (let k = 0; k < list.length; k++) {
      const f = list[k];
      if (seconds >= f.t1) continue;
      list[keep++] = f;
      const u = Math.max(0, (seconds - f.t0) / (f.t1 - f.t0));
      const x = f.x0 + (f.x1 - f.x0) * u;
      const z = f.z0 + (f.z1 - f.z0) * u;
      const ground = this.terrain.heightAt(x, z);
      if (!this.fog.sees(x, z)) continue;
      const heading = Math.atan2(f.x1 - f.x0, f.z1 - f.z0);
      const sin = Math.sin(heading);
      const cos = Math.cos(heading);
      if (f.swarm) {
        const lift = Math.sin(u * Math.PI) * 6;
        const y = f.y0 + (ground + 0.5 - f.y0) * u * u + lift;
        this.munitions.put(x, y, z, sin, cos, 1, 0.5, 0.5, 0.5, BURN_BASE);
      } else {
        const y = f.y0 + (ground + 0.6 - f.y0) * u * u;
        this.bombs.put(x, y, z, sin, cos, 1, 0.5, 0.5, 0.5, BURN_BASE);
      }
    }
    list.length = keep;
  }

  private playEvents(ev: Int32Array, seconds: number): void {
    const pos = this.renderPos;
    const fx = this.effects;
    for (let e = 0; e < ev.length; e += 3) {
      const a = ev[e + 1];
      const b = ev[e + 2];
      if (ev[e] === EV_COLLAPSE) {
        const c = this.structures.centreOf(a);
        const seen = this.fog.sees(c.x, c.z);
        this.sound?.at(SND_COLLAPSE, c.x, c.z, seen);
        if (seen) this.structures.collapse(a, b === 1);
        continue;
      }
      if (ev[e] === EV_STORM || ev[e] === EV_STORMED) {
        // Fighting inside a building: shots and dust at its windows.
        const c = this.structures.centreOf(a);
        const seen = this.fog.sees(c.x, c.z);
        this.sound?.at(ev[e] === EV_STORM ? SND_RIFLE : SND_IMPACT, c.x, c.z, seen);
        if (seen) {
          const p = this.structures.hit(a);
          fx.thin = 0;
          fx.squadHit(p.x, p.y, p.z);
        }
        continue;
      }
      if (ev[e] === EV_GUTTED || ev[e] === EV_WALL) {
        const c = this.structures.centreOf(a);
        const seen = this.fog.sees(c.x, c.z);
        if (ev[e] === EV_GUTTED) {
          this.sound?.at(SND_COLLAPSE, c.x, c.z, seen);
          if (seen) this.structures.gut(a);
        } else {
          this.sound?.at(SND_IMPACT, c.x, c.z, seen);
          if (seen) this.structures.breach(a, b);
        }
        continue;
      }
      if (ev[e] === EV_STRAY) {
        // A round meant for someone else: dust and chips off the wall it hit.
        if (this.lodOf[b] === LOD_HIDDEN) continue;
        const p = this.structures.hit(a);
        if (!this.fog.sees(p.x, p.z)) continue;
        fx.thin = this.lodOf[b] >= 2 ? 1 : 0;
        if (KINDS[this.kind[b]].stray >= BLAST_STRAY) {
          this.sound?.at(SND_IMPACT, p.x, p.z, true);
          fx.shellImpact(p.x, p.y - 0.8, p.z);
        }
        fx.squadHit(p.x, p.y, p.z);
        continue;
      }
      if (ev[e] === EV_UNLOAD) continue;
      if (ev[e] === EV_SMOKE) {
        const x = unpackX(a);
        const z = unpackY(a);
        const until = seconds + b / 20;
        this.fog.addSmoke(x, z, SMOKE_CELLS, until);
        // Shells of one salvo landing together make one cloud, not a white-out.
        const near = this.smokes.find((s) => Math.abs(s.x - x) + Math.abs(s.z - z) < 7);
        if (near) near.until = until;
        else this.smokes.push({ x, y: this.terrain.heightAt(x, z), z, until });
        continue;
      }
      if (ev[e] === EV_FLARE) {
        const x = unpackX(a);
        const z = unpackY(a);
        const y = this.terrain.heightAt(x, z);
        this.flares.push({ x, y, z, from: seconds, until: seconds + b / 20 });
        this.sound?.at(SND_HOWITZER, x, z, false);
        continue;
      }
      if (ev[e] === EV_PLANE) {
        this.jets[a] = 0;
        continue;
      }
      if (ev[e] === EV_AIRSTRIKE) {
        // A strike jet over the edge of the map: heard right across it.
        this.jets[a] = 1;
        const x = pos[3 * a];
        const z = pos[3 * a + 2];
        this.sound?.at(SND_JET, x, z, true);
        continue;
      }
      if (ev[e] === EV_BOMB) {
        // Let go over the point: from under the jet to where it lands.
        const jet = b >> 12;
        const ticks = (b >> 4) & 255;
        const x1 = unpackX(a);
        const z1 = unpackY(a);
        const x0 = jet < this.kind.length ? pos[3 * jet] : x1;
        const z0 = jet < this.kind.length ? pos[3 * jet + 2] : z1;
        const y0 = this.terrain.heightAt(x0, z0) + PLANE_ALTITUDE - 0.6;
        this.falling.push({
          x0,
          y0,
          z0,
          x1,
          z1,
          t0: seconds,
          t1: seconds + ticks / 20,
          swarm: (b & 15) === 3,
        });
        if ((b & 15) === 3) this.sound?.at(SND_MISSILE, x1, z1, this.fog.sees(x1, z1));
        continue;
      }
      if (ev[e] === EV_IMPACT && b > 0) {
        // A bomb (1 guided, 2 one of a stick) or a swarm munition (3) lands.
        const x = unpackX(a);
        const z = unpackY(a);
        const big = b === 1 ? 1.6 : b === 2 ? 1.2 : 0.6;
        this.impacts.push(x, z, seconds, IMPACT_THROW * (b === 3 ? 0.7 : big * 1.4));
        this.scars.add(x, z, (1.8 + Math.random() * 0.8) * big, false);
        this.terrain.stamp(x, z, 3.6 * big, 150);
        const seen = this.fog.sees(x, z);
        this.sound?.at(b === 3 ? SND_IMPACT : SND_EXPLOSION, x, z, seen);
        if (b !== 3) this.sound?.at(SND_IMPACT, x, z, seen);
        if (seen) {
          const y = this.terrain.heightAt(x, z);
          fx.thin = 0;
          if (b === 3) {
            fx.explosion(x, y, z);
          } else {
            fx.explosion(x, y, z);
            fx.shellImpact(x, y, z);
            for (let k = 0; k < (b === 1 ? 4 : 2); k++) {
              const r = big * 2.2;
              fx.shellImpact(x + (Math.random() - 0.5) * r, y, z + (Math.random() - 0.5) * r);
            }
          }
        }
        continue;
      }
      if (ev[e] === EV_IMPACT) {
        // A shell lands. The crater stays whether or not anyone saw it fall.
        const x = unpackX(a);
        const z = unpackY(a);
        this.impacts.push(x, z, seconds, IMPACT_THROW);
        this.scars.add(x, z, 1.2 + Math.random() * 0.9, false);
        this.terrain.stamp(x, z, 3.2, 110);
        const seen = this.fog.sees(x, z);
        this.sound?.at(SND_IMPACT, x, z, seen);
        if (seen) fx.shellImpact(x, this.terrain.heightAt(x, z), z);
        continue;
      }
      if (ev[e] === EV_LAUNCH) {
        this.shotAt[a] = seconds;
        const tube = this.kind[a] === KIND_MORTAR;
        this.sound?.at(
          tube ? SND_MORTAR : SND_HOWITZER,
          pos[3 * a],
          pos[3 * a + 2],
          this.fog.sees(pos[3 * a], pos[3 * a + 2]),
        );
        if (this.lodOf[a] === LOD_HIDDEN) continue;
        const m = this.drawOf(a)?.model;
        const d = Math.hypot(unpackX(b) - pos[3 * a], unpackY(b) - pos[3 * a + 2]) || 1;
        const ux = (unpackX(b) - pos[3 * a]) / d;
        const uz = (unpackY(b) - pos[3 * a + 2]) / d;
        this.turret[a] = Math.atan2(ux, uz);
        fx.thin = this.lodOf[a] >= 2 ? 1 : 0;
        if (tube) {
          // A small flash and a puff at the muzzle, up and forward.
          fx.mortar(pos[3 * a] + ux * 0.5, pos[3 * a + 1] + 0.4, pos[3 * a + 2] + uz * 0.5, ux, uz);
          continue;
        }
        fx.howitzer(
          pos[3 * a] + ux * (m?.muzzleZ ?? 2),
          pos[3 * a + 1] + (m ? m.turretY + m.muzzleY : 1.5),
          pos[3 * a + 2] + uz * (m?.muzzleZ ?? 2),
          ux,
          uz,
        );
        continue;
      }
      const veh = this.drawOf(a);
      const ax = pos[3 * a];
      const ay = pos[3 * a + 1];
      const az = pos[3 * a + 2];
      if (ev[e] === EV_SIEGE) {
        // Shelling a building or a bridge.
        this.shotAt[a] = seconds;
        this.report(a);
        if (this.lodOf[a] === LOD_HIDDEN) continue;
        const p = this.structures.hit(b);
        fx.thin = this.lodOf[a] >= 2 ? 1 : 0;
        this.shoot(a, ax, ay, az, p.x, p.y, p.z);
        fx.squadHit(p.x, p.y, p.z);
        continue;
      }
      if (ev[e] === EV_BREACH) {
        // Firing at a field work, or laying a charge against it.
        this.shotAt[a] = seconds;
        if (KINDS[this.kind[a]].engineer) this.sound?.at(SND_IMPACT, ax, az, this.fog.sees(ax, az));
        else this.report(a);
        if (this.lodOf[a] === LOD_HIDDEN) continue;
        const px = ((b % 256) + 0.5) * 4;
        const pz = (Math.floor(b / 256) + 0.5) * 4;
        const py = this.terrain.heightAt(px, pz) + 1;
        fx.thin = this.lodOf[a] >= 2 ? 1 : 0;
        if (KINDS[this.kind[a]].engineer) fx.shellImpact(px, py - 0.8, pz);
        else {
          this.shoot(a, ax, ay, az, px, py, pz);
          fx.squadHit(px, py, pz);
        }
        continue;
      }
      if (ev[e] !== EV_SHOT && ev[e] !== EV_DEATH) continue;
      // Effects nobody can see are the main cost of a big battle: skip them when both ends
      // are off-screen and thin them when both are far away.
      const near = Math.min(this.lodOf[a], ev[e] === EV_SHOT ? this.lodOf[b] : LOD_HIDDEN);
      fx.thin = near >= 2 ? 1 : 0;
      if (ev[e] === EV_SHOT) {
        this.shotAt[a] = seconds;
        const throws = THROW[this.kind[a]];
        if (throws > 0 && b < MAX_UNITS) {
          this.blastAt[b] = seconds;
          this.blastPow[b] = throws;
          this.blastX[b] = ax;
          this.blastZ[b] = az;
        }
        this.report(a);
        const open = b < MAX_UNITS && (this.info[b] & INFO_INSIDE) === 0;
        const foot = open && IS_FOOT[this.kind[b]];
        const reach = BURST_THROW[this.kind[a]];
        if (reach > 0 && open && !IS_AIR[this.kind[b]]) {
          // High explosive among men in the open (I3): whoever it kills round the target
          // is thrown from where it burst, and it leaves its mark on the ground.
          this.impacts.push(pos[3 * b], pos[3 * b + 2], seconds, reach);
          if (foot) {
            this.scars.add(pos[3 * b], pos[3 * b + 2], 0.6 + Math.random() * 0.5, false);
            if (near !== LOD_HIDDEN) fx.burst(pos[3 * b], pos[3 * b + 1], pos[3 * b + 2]);
          }
        }
        if (foot && KINDS[this.kind[a]].gunner) {
          // The squad's machine gun: men caught in the open go to ground.
          const map = this.terrain.map;
          const cx = Math.min(255, Math.max(0, this.curr[2 * b] >> 2));
          const cy = Math.min(255, Math.max(0, this.curr[2 * b + 1] >> 2));
          const t = map.type[cy * 256 + cx];
          if (t !== T_RUBBLE && t !== T_TRENCH && t !== T_SANDBAG) {
            this.pinnedUntil[b] = seconds + PIN_TICKS / 20;
          }
        }
        if (near === LOD_HIDDEN) continue;
        const by = pos[3 * b + 1] + (IS_VEHICLE[this.kind[b]] ? 0.7 : 0.35);
        this.shoot(a, ax, ay, az, pos[3 * b], by, pos[3 * b + 2]);
      } else if (ev[e] === EV_DEATH) {
        this.diedAt[a] = seconds;
        // A drone just drops; a helicopter or a plane goes up like any vehicle.
        const air = IS_DRONE[this.kind[a]];
        if (veh && !air) {
          this.scars.add(ax, az, 2.3, true);
          this.terrain.stamp(ax, az, 2.6, 70);
          this.sound?.at(SND_EXPLOSION, ax, az, this.fog.sees(ax, az));
        }
        const kindDead = this.kind[a];
        if (kindDead === KIND_HELI || kindDead === KIND_LIFT) {
          const team = this.teamOf(a);
          const coat = factionOf(team) * SEEDS;
          this.wrecks.add(
            ax,
            az,
            ay - this.terrain.heightAt(ax, az),
            this.heading[a],
            this.fleet(factionOf(team)).wrecks + (kindDead === KIND_HELI ? 0 : 1),
            team,
            (a % SEEDS) + coat + BURN_BASE + BURN_SCALE,
            team === this.playerTeam || this.fog.sees(ax, az),
          );
        }
        if (near === LOD_HIDDEN) continue;
        if (veh && !air) fx.explosion(ax, ay, az);
        else fx.squadHit(ax, ay, az);
      }
    }
    fx.thin = 0;
  }

  /** The effect of unit `a` at (ax, ay, az) firing its weapon at a point. */
  private shoot(
    a: number,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
  ): void {
    const fx = this.effects;
    const kind = this.kind[a];
    const veh = this.drawOf(a);
    if (kind === KIND_STRIKE) {
      // The drone dives into its target.
      fx.missile(ax, ay, az, bx, by, bz);
      return;
    }
    if (kind === KIND_HELI) {
      // Rockets from the pods under the stub wings, one side then the other.
      const d = Math.hypot(bx - ax, bz - az) || 1;
      const side = (this.shots[a]++ & 1) === 0 ? 0.8 : -0.8;
      fx.missile(ax + ((bz - az) / d) * side, ay - 0.3, az - ((bx - ax) / d) * side, bx, by, bz);
      return;
    }
    if (!veh) {
      if (kind === KIND_ATGM) {
        // Out of the front of the launcher on its tripod, ahead of the team.
        const d = Math.hypot(bx - ax, bz - az) || 1;
        fx.missile(ax + ((bx - ax) / d) * 0.55, ay + 0.28, az + ((bz - az) / d) * 0.55, bx, by, bz);
      } else fx.rifleBurst(ax, ay + 0.42, az, bx, by, bz);
      return;
    }
    // The shot leaves along the turret, which is laid on the target.
    const d = Math.hypot(bx - ax, bz - az) || 1;
    const ux = (bx - ax) / d;
    const uz = (bz - az) / d;
    this.turret[a] = Math.atan2(ux, uz);
    const m = veh.model;
    const mx = ax + ux * m.muzzleZ;
    const my = ay + m.turretY + m.muzzleY;
    const mz = az + uz * m.muzzleZ;
    if (kind === KIND_IFV || kind === KIND_AD) fx.autocannon(mx, my, mz, bx, by, bz);
    else fx.cannonShot(mx, my, mz, bx, by, bz);
  }

  teamOf(id: number): number {
    return (this.info[id] >> INFO_TEAM_SHIFT) & INFO_TEAM_MASK;
  }

  /** Structure a unit is garrisoned in, or -1. */
  insideOf(id: number): number {
    if ((this.info[id] & INFO_INSIDE) === 0) return -1;
    const map = this.terrain.map;
    const cx = Math.min(255, Math.max(0, this.curr[2 * id] >> 2));
    const cy = Math.min(255, Math.max(0, this.curr[2 * id + 1] >> 2));
    return map.structAt[cy * 256 + cx];
  }

  kindOf(id: number): number {
    return this.kind[id];
  }

  /** Health out of 255. */
  healthOf(id: number): number {
    return this.hp[id];
  }

  /** One of the player's own, alive and in the open (not in a house or a carrier). */
  isOwnInOpen(id: number): boolean {
    return (
      this.isAlive(id) &&
      this.teamOf(id) === this.playerTeam &&
      (this.info[id] & INFO_INSIDE) === 0 &&
      this.lodOf[id] !== LOD_HIDDEN
    );
  }

  /** It has a target it is shooting at. */
  isFiring(id: number): boolean {
    return this.aim[id] !== NO_AIM;
  }

  /**
   * Every living ground unit the player knows of, for the front line: all of their own, and
   * enemies in sight (in a building only once their fire has given them away).
   */
  eachKnownGround(add: (x: number, z: number, team: number, weight: number) => void): void {
    const pos = this.curr;
    for (let i = 0; i < this.count; i++) {
      if (!this.isAlive(i)) continue;
      const k = this.kind[i];
      if (IS_AIR[k] || k === KIND_PLANE) continue;
      const x = pos[2 * i];
      const z = pos[2 * i + 1];
      const team = this.teamOf(i);
      if (team !== this.playerTeam) {
        const info = this.info[i];
        if ((info & INFO_INSIDE) !== 0 && (info & INFO_REVEALED) === 0) continue;
        if (!this.fog.sees(x, z)) continue;
      }
      add(x, z, team, IS_VEHICLE[k] ? 2 : 1);
    }
  }

  /** A living unit of the player's army. */
  isMine(id: number): boolean {
    // The transport plane flies itself: nobody selects it or gives it orders.
    return this.isAlive(id) && this.teamOf(id) === this.playerTeam && this.kind[id] !== KIND_PLANE;
  }

  /** A living enemy unit that is drawn this frame (so the player can see it), outside buildings. */
  isTargetable(id: number): boolean {
    return (
      this.isAlive(id) &&
      this.teamOf(id) !== this.playerTeam &&
      (this.info[id] & INFO_INSIDE) === 0 &&
      this.lodOf[id] !== LOD_HIDDEN
    );
  }

  /** Centre of the living units among `ids` (render x, z), or null if none are left. */
  centreOf(ids: readonly number[]): { x: number; z: number } | null {
    let x = 0;
    let z = 0;
    let n = 0;
    for (const id of ids) {
      if (!this.isAlive(id)) continue;
      x += this.renderPos[3 * id];
      z += this.renderPos[3 * id + 2];
      n++;
    }
    return n ? { x: x / n, z: z / n } : null;
  }

  isAlive(id: number): boolean {
    // A squad riding in a carrier is out of play: not drawn, not selectable.
    return id < this.count && (this.info[id] & (INFO_STATE_MASK | INFO_CARRIED)) === STATE_ALIVE;
  }

  /**
   * A shared army: the seat of the teammate whose unit `id` is, or -1 if it is ours, nobody's
   * in particular, the enemy's, or the army is not shared.
   */
  mateOf(id: number): number {
    if (this.mySeat < 0) return -1;
    const o = this.owner[id];
    return o === NO_SEAT || o === this.mySeat || this.teamOf(id) !== this.playerTeam ? -1 : o;
  }

  setSelected(ids: Iterable<number>, additive: boolean): void {
    if (!additive) this.selected.fill(0);
    for (const id of ids) if (this.isAlive(id)) this.selected[id] = 1;
    let c = 0;
    for (let i = 0; i < this.count; i++) c += this.selected[i];
    this.selectedCount = c;
  }

  selectedIds(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.count; i++) if (this.selected[i]) out.push(i);
    return out;
  }

  update(now: number, dt: number, camera: THREE.PerspectiveCamera): void {
    const n = this.count;
    const seconds = now / 1000;
    const alpha = Math.min(Math.max((now - this.snapshotTime) / TICK_MS, 0), 1);
    const pos = this.renderPos;
    const prev = this.prev;
    const curr = this.curr;
    const info = this.info;
    const fx = this.effects;
    this.billow(seconds, dt);
    if (this.night) this.burnFlares(seconds);

    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);
    const planes = this.frustum.planes;
    const cam = camera.position;
    const nearNow = this.lodNear * this.nearScale;
    const near2 = nearNow * nearNow;
    const fullNow = this.lodFull * Math.min(this.nearScale, this.fullScale);
    let fullCount = 0;
    const full2 = fullNow * fullNow;
    const far2 = this.lodFar * this.lodFar;
    const stillNow = Math.max(nearNow, STILL_MIN, this.lodStill * this.stillScale);
    const still2 = stillNow * stillNow;
    const blockNow = Math.max(stillNow, this.lodBlock);
    const block2 = blockNow * blockNow;
    let stillCount = 0;
    let jointedCount = 0;

    const batches = this.batches;
    for (const b of batches) b.n = 0;
    this.jamRings.n = 0;
    this.ownerRings.n = 0;
    this.shade.n = 0;
    // Dust is rationed: a few hundred puffs a second over the whole field at most.
    const dustRate = Math.min(2.4, 420 / Math.max(1, this.walkers));
    let walkers = 0;
    const shadeAlpha = this.night ? 0.12 : 0.22;
    const tmap = this.terrain.map;
    // Map symbols: nothing up close, solid when the camera is far out.
    const icons = this.icons;
    icons.batch.n = 0;
    this.drawFalling(seconds);
    const iconAlpha = Math.min(1, Math.max(0, (this.zoom - ICON_FROM) / (ICON_FULL - ICON_FROM)));
    const right = this.camRight.setFromMatrixColumn(camera.matrixWorld, 0);
    const up = this.camUp.setFromMatrixColumn(camera.matrixWorld, 1);
    const lodCount = this.stats.lod;
    lodCount[0] = lodCount[1] = lodCount[2] = 0;
    let culled = 0;
    let ringCount = 0;
    const r = this.rings.instanceMatrix.array as Float32Array;

    for (let i = 0; i < n; i++) {
      const state = info[i] & INFO_STATE_MASK;
      if (state === STATE_FREE) continue;
      const veh = this.drawOf(i);
      const isTank = veh !== null;
      const alive = state === STATE_ALIVE;
      // Fallen squads and shot-down drones leave no wreck.
      if (!alive && (!isTank || IS_AIR[this.kind[i]])) continue;
      if ((info[i] & INFO_CARRIED) !== 0) {
        this.lodOf[i] = LOD_HIDDEN;
        continue;
      }

      const x = prev[2 * i] + (curr[2 * i] - prev[2 * i]) * alpha;
      const z = prev[2 * i + 1] + (curr[2 * i + 1] - prev[2 * i + 1]) * alpha;
      const flying = IS_AIR[this.kind[i]];
      const kindNow = this.kind[i];
      // Coming down under a canopy.
      const fall =
        kindNow === KIND_PARA
          ? Math.max(0, 1 - (seconds - this.dropAt[i]) / CHUTE_SECONDS) * CHUTE_HEIGHT
          : 0;
      let y =
        this.terrain.heightAt(x, z) +
        fall +
        (flying
          ? (kindNow === KIND_PLANE ? PLANE_ALTITUDE : ALTITUDE) + Math.sin(seconds * 1.3 + i) * 0.3
          : 0);
      pos[3 * i] = x;
      pos[3 * i + 1] = y;
      pos[3 * i + 2] = z;
      const teamId = (info[i] >> INFO_TEAM_SHIFT) & INFO_TEAM_MASK;
      const onRoof = alive && (info[i] & INFO_INSIDE) !== 0 && (this.task[i] & TASK_ROOF) !== 0;
      if (onRoof) {
        // Up on the roof (I6): the men are drawn standing on it, for anyone who can see it.
        const st = this.insideOf(i);
        if (st >= 0) pos[3 * i + 1] = y = this.structures.roofAt(st, x, z);
      } else if (alive && (info[i] & INFO_INSIDE) !== 0) {
        // In a building: no model to draw. The house shows a pip per squad, for your own
        // garrisons always and for the enemy's once its fire has given it away.
        const st = this.insideOf(i);
        const known =
          teamId === this.playerTeam || ((info[i] & INFO_REVEALED) !== 0 && this.fog.sees(x, z));
        if (st >= 0) {
          pos[3 * i + 1] = this.structures.topOf(st) - 0.6;
          if (known) {
            this.structures.occ[st]++;
            this.structures.occTeam[st] = teamId;
            if (this.selected[i]) this.structures.occSelected[st] = 1;
          }
        }
        this.lodOf[i] = known ? 1 : LOD_HIDDEN;
        continue;
      }
      // Fog of war: enemies show only where the player can see, wrecks where they have been.
      if (teamId !== this.playerTeam || !alive) {
        // A unit the army has located (a gun that fired, say) shows through the fog.
        const located = (info[i] & INFO_SPOTTED) !== 0;
        if (alive ? !located && !this.fog.sees(x, z) : !this.fog.hasExplored(x, z)) {
          this.lodOf[i] = LOD_HIDDEN;
          continue;
        }
      }

      const target = this.aim[i];
      let aimAngle = NaN;
      if (alive) {
        this.heading[i] = turn(
          this.heading[i],
          this.headingGoal[i],
          (isTank ? HULL_TURN : SOLDIER_TURN) * dt,
        );
        if (target !== NO_AIM && target < n) {
          aimAngle = Math.atan2(pos[3 * target] - x, pos[3 * target + 2] - z);
        }
        if (isTank) {
          this.turret[i] = turn(
            this.turret[i],
            Number.isNaN(aimAngle) ? this.heading[i] : aimAngle,
            TURRET_TURN * dt,
          );
        }
      }

      // Rotors turn, whatever the helicopter is doing.
      if (alive && IS_HELI[kindNow]) this.turret[i] = (seconds * 19 + i) % (Math.PI * 2);
      let visible = true;
      for (let p = 0; p < 6; p++) {
        const pl = planes[p];
        if (pl.normal.x * x + pl.normal.y * y + pl.normal.z * z + pl.constant < -CULL_RADIUS) {
          visible = false;
          break;
        }
      }
      if (!visible) {
        culled++;
        this.lodOf[i] = LOD_HIDDEN;
        continue;
      }
      const dx = x - cam.x;
      const dy = y - cam.y;
      const dz = z - cam.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      const lod = d2 < near2 ? 0 : d2 < far2 ? 1 : 2;
      lodCount[lod]++;
      this.lodOf[i] = lod;

      const team = TEAM_RGB[teamId] ?? TEAM_RGB[0];
      const coatOf = factionOf(teamId) * SEEDS;
      if (iconAlpha > 0 && alive) {
        // The same size on screen at any distance; brighter than the paint, to carry far.
        const s = Math.sqrt(d2) * 0.018;
        const lift = flying ? 0 : 1.2 + s * 0.5;
        const sel = this.selected[i] ? 1.6 : 1;
        icons.put(
          x + up.x * lift,
          y + up.y * lift,
          z + up.z * lift,
          s,
          right,
          up,
          this.kind[i],
          Math.min(1, team[0] * 1.9 * sel + 0.04),
          Math.min(1, team[1] * 1.9 * sel + 0.04),
          Math.min(1, team[2] * 1.9 * sel + 0.04),
          iconAlpha,
        );
      }
      // Troops under a sub-commander carry its pennant, at any zoom: small up close, and
      // beside the map symbol when the camera is far out.
      const boss = this.cmdr[i];
      if (boss >= 0 && alive && teamId === this.playerTeam && this.pennants) {
        const dist = Math.sqrt(d2);
        const s = dist * (0.0135 + 0.002 * iconAlpha);
        const lift = (flying ? 0.8 : 2.7) + s * (0.6 + 1.5 * iconAlpha);
        const tint = COMMANDER_RGB[boss & 7];
        icons.put(
          x + up.x * lift,
          y + up.y * lift,
          z + up.z * lift,
          s,
          right,
          up,
          ICON_PENNANT + (boss & 7),
          tint[0],
          tint[1],
          tint[2],
          this.selected[i] ? 1 : 0.8,
        );
      }
      const h = this.heading[i];
      const sin = Math.sin(h);
      const cos = Math.cos(h);

      if (this.mySeat >= 0 && this.ownerMarks && alive && !flying) {
        const mate = this.mateOf(i);
        const c = mate >= 0 ? this.seatRgb[mate] : undefined;
        if (c)
          this.ownerRings.put(x, y + 0.1, z, 0, 1, 1, c[0] / 255, c[1] / 255, c[2] / 255, 0.85);
      }
      const jam = kindIn(teamId, this.kind[i]).jam / 1024;
      if (jam > 0 && alive) {
        const mine = teamId === this.playerTeam;
        const a = 0.35 + 0.15 * Math.sin(seconds * 3 + i);
        this.jamRings.put(x, y + 0.4, z, 0, jam, 1, 1, mine ? 0.72 : 0.22, mine ? 0.15 : 0.18, a);
      }
      if (veh) {
        // A jammed drone flickers: its link is gone.
        const jammedNow = IS_DRONE[kindNow] && alive && this.load[i] > 0;
        const burn =
          (i % SEEDS) +
          coatOf +
          BURN_BASE +
          BURN_SCALE * (alive ? (jammedNow ? 0.45 + 0.4 * Math.sin(seconds * 24 + i) : 0) : 1);
        const m = veh.model;
        if (lod === 2) {
          veh.far.put(x, y - (m.lift ?? 0), z, sin, cos, 1, team[0], team[1], team[2], burn);
        } else {
          // On the ground a vehicle lies along the slope under it, rocks back from its own
          // gun and works on its springs as it drives. A wreck stays as it stopped. In the
          // air it banks into its turns, and a helicopter puts its nose down to go forward.
          // Wrecks keep the turret where it died, knocked slightly askew.
          const th = this.turret[i] + (alive ? 0 : 0.5);
          const since = seconds - this.shotAt[i];
          if (flying) {
            let dh = h - this.airH[i];
            if (dh !== dh) dh = 0; // its first frame
            if (dh > Math.PI) dh -= Math.PI * 2;
            else if (dh < -Math.PI) dh += Math.PI * 2;
            this.airH[i] = h;
            // (Heading grows turning to the left, and the left side goes down in that turn.)
            const most = AIR_BANK[kindNow];
            const want = dt > 0 ? (-dh / dt) * 0.3 : 0;
            const going = this.moving[i] === 1 ? 1 : 0;
            const roll =
              (want > most ? most : want < -most ? -most : want) +
              0.02 * Math.sin(seconds * 0.9 + i * 1.7);
            const pitch = AIR_NOSE[kindNow] * going + 0.015 * Math.sin(seconds * 1.1 + i * 2.3);
            const ease = Math.min(1, dt * 2.5);
            this.tiltP[i] += (pitch - this.tiltP[i]) * ease;
            this.tiltR[i] += (roll - this.tiltR[i]) * ease;
          } else if (alive) {
            const reach = 1.1;
            const half = 0.6;
            const ht = this.terrain;
            const front = ht.heightAt(x + sin * reach, z + cos * reach);
            const back = ht.heightAt(x - sin * reach, z - cos * reach);
            const left = ht.heightAt(x + cos * half, z - sin * half);
            const right = ht.heightAt(x - cos * half, z + sin * half);
            let pitch = Math.atan2(front - back, reach * 2);
            let roll = Math.atan2(left - right, half * 2);
            // The gun's kick: a shove away from where the turret points, dying away in a
            // couple of swings. Heavier guns shove harder.
            if (since < 1.2) {
              const k = ROCK[kindNow] * Math.exp(-since * 4.2) * Math.cos(since * 11);
              const rel = th - h;
              pitch += k * Math.cos(rel);
              roll += k * Math.sin(rel);
            }
            if (this.moving[i] === 1) {
              pitch += 0.008 * Math.sin(seconds * 7.3 + i * 1.7);
              roll += 0.006 * Math.sin(seconds * 5.1 + i * 2.9);
            }
            const ease = Math.min(1, dt * 9);
            this.tiltP[i] += (pitch - this.tiltP[i]) * ease;
            this.tiltR[i] += (roll - this.tiltR[i]) * ease;
          }
          const pitch = this.tiltP[i];
          const roll = this.tiltR[i];
          const f = this.hullFrame;
          // Forward leans up the slope; the right-hand axis leans with the roll, then is
          // squared to forward; up is what is left.
          const cp = Math.cos(pitch);
          const zx = sin * cp;
          const zy = Math.sin(pitch);
          const zz = cos * cp;
          let xx = cos;
          let xy = Math.tan(roll);
          let xz = -sin;
          const along = xx * zx + xy * zy + xz * zz;
          xx -= zx * along;
          xy -= zy * along;
          xz -= zz * along;
          const xl = Math.hypot(xx, xy, xz);
          xx /= xl;
          xy /= xl;
          xz /= xl;
          const yx = zy * xz - zz * xy;
          const yy = zz * xx - zx * xz;
          const yz = zx * xy - zy * xx;
          f[0] = xx;
          f[1] = xy;
          f[2] = xz;
          f[3] = yx;
          f[4] = yy;
          f[5] = yz;
          f[6] = zx;
          f[7] = zy;
          f[8] = zz;
          // (An aircraft's model is stored above its origin: down its own upright by as much.)
          const lift = m.lift ?? 0;
          const ox = x - yx * lift;
          const oy = y - yy * lift;
          const oz = z - yz * lift;
          f[9] = ox;
          f[10] = oy;
          f[11] = oz;
          // All of a vehicle's detail only where it can be seen: right under the camera.
          const level = lod === 1 ? 2 : d2 < full2 ? 0 : 1;
          if (level === 0) fullCount++;
          veh.hull[level].frame(f, team[0], team[1], team[2], burn);
          if (veh.turret.length > 0) {
            // The turret turns on the hull's own deck, and its gun runs back on firing.
            const rel = th - h;
            const rs = Math.sin(rel);
            const rc = Math.cos(rel);
            const kick = since < 0.35 ? 0.1 * (1 - since / 0.35) ** 2 : 0;
            const tzx = xx * rs + zx * rc;
            const tzy = xy * rs + zy * rc;
            const tzz = xz * rs + zz * rc;
            f[0] = xx * rc - zx * rs;
            f[1] = xy * rc - zy * rs;
            f[2] = xz * rc - zz * rs;
            f[6] = tzx;
            f[7] = tzy;
            f[8] = tzz;
            f[9] = x + yx * m.turretY + zx * m.turretZ - tzx * kick;
            f[10] = y + yy * m.turretY + zy * m.turretZ - tzy * kick;
            f[11] = z + yz * m.turretY + zz * m.turretZ - tzz * kick;
            veh.turret[level].frame(f, team[0], team[1], team[2], burn);
          }
          const rotors = m.rotors;
          if (rotors) {
            // Rotors and propellers turn where they sit on the airframe, tilted with it.
            for (let q = 0; q < rotors.length; q++) {
              const r = rotors[q];
              const a = seconds * r.rate + i;
              const s = Math.sin(a);
              const c = Math.cos(a);
              if (r.axis === 'y') {
                f[0] = xx * c - zx * s;
                f[1] = xy * c - zy * s;
                f[2] = xz * c - zz * s;
                f[3] = yx;
                f[4] = yy;
                f[5] = yz;
                f[6] = xx * s + zx * c;
                f[7] = xy * s + zy * c;
                f[8] = xz * s + zz * c;
              } else if (r.axis === 'x') {
                f[0] = xx;
                f[1] = xy;
                f[2] = xz;
                f[3] = yx * c + zx * s;
                f[4] = yy * c + zy * s;
                f[5] = yz * c + zz * s;
                f[6] = zx * c - yx * s;
                f[7] = zy * c - yy * s;
                f[8] = zz * c - yz * s;
              } else {
                f[0] = xx * c + yx * s;
                f[1] = xy * c + yy * s;
                f[2] = xz * c + yz * s;
                f[3] = yx * c - xx * s;
                f[4] = yy * c - xy * s;
                f[5] = yz * c - xz * s;
                f[6] = zx;
                f[7] = zy;
                f[8] = zz;
              }
              f[9] = ox + xx * r.x + yx * r.y + zx * r.z;
              f[10] = oy + xy * r.x + yy * r.y + zy * r.z;
              f[11] = oz + xz * r.x + yz * r.y + zz * r.z;
              veh.rotors[r.shape][lod].frame(f, team[0], team[1], team[2], burn);
            }
          }
        }
        if (!alive && lod < 2) {
          const age = seconds - this.diedAt[i];
          if (age < WRECK_SMOKE_SECONDS && Math.random() < dt * 3) {
            // At night it burns for as long as the sim counts it a fire (decision 113).
            const glow = this.night ? 0.3 * Math.max(0, 1 - age / BURN_SECONDS) : 0;
            fx.wreckSmoke(x, y, z, Math.max(glow, 1 - age / 12));
          }
        }
      } else {
        const squad = this.squads[this.kind[i]] ?? this.squads[KIND_INFANTRY]!;
        if (alive && fall === 0) {
          if (lod >= 1 || !this.realShadows)
            this.shade.put(x, y + 0.07, z, 0, 3.2, 1, 0, 0, 0, shadeAlpha);
          if (this.moving[i] === 1) {
            walkers++;
            if (Math.random() < dt * dustRate) {
              const ci = Math.min(255, Math.max(0, x >> 2));
              const cj = Math.min(255, Math.max(0, z >> 2));
              const c = cj * 256 + ci;
              const ground = tmap.type[c];
              if (ground !== T_WATER && ground !== T_FORD && ground !== T_BRIDGE) {
                fx.thin = 0;
                fx.dust(x - sin * 0.7, y, z - cos * 0.7, tmap.road[c] !== 0, lod === 2 ? 1.5 : 1);
              }
            }
          }
        }
        if (lod === 2) {
          squad.far.put(
            x,
            y,
            z,
            sin,
            cos,
            1,
            team[0],
            team[1],
            team[2],
            (i % SEEDS) + coatOf + BURN_BASE,
          );
        } else {
          if (fall > 0) {
            this.chutes.put(x, y + 3.1, z, sin, cos, 1, team[0], team[1], team[2], BURN_BASE);
          }
          // Men drop out of the squad as it loses health.
          const figures = squad.figures;
          const men = Math.ceil((this.hp[i] * figures.length) / 255);
          const face = Number.isNaN(aimAngle) ? h : aimAngle;
          const fs = Math.sin(face);
          const fc = Math.cos(face);
          // Ease between halted and moving, and between at ease and in a fight, so a squad
          // settles into its stances instead of snapping.
          const forced = this.pose;
          const since = forced ? forced[2] : seconds - this.shotAt[i];
          const ease = Math.min(1, dt * 4.5);
          let halted = (this.halted[i] += ((this.moving[i] === 1 ? 0 : 1) - this.halted[i]) * ease);
          let fight = (this.fight[i] +=
            ((since < 3 || !Number.isNaN(aimAngle) ? 1 : 0) - this.fight[i]) * ease);
          if (forced) {
            halted = forced[0];
            fight = forced[1];
          }
          const drill = squad.drill;
          const troop = this.troop(factionOf(teamId));
          const soldiers = troop.soldiers;
          const near = lod === 0 && soldiers.roomNear ? 0 : 1;
          // The stride follows the ground covered, so feet do not slide whatever the pace.
          const gx = x - this.gaitX[i];
          const gz = z - this.gaitZ[i];
          const gone = Math.hypot(gx, gz);
          if (gone < 1.5) this.gait[i] += gone;
          this.gaitX[i] = x;
          this.gaitZ[i] = z;
          const paces = this.gait[i] * STRIDE_RATE + i * 1.3;
          // A team's weapon is set down once it has halted, and served from then on.
          const weapon = squad.weapon;
          const emplaced = weapon !== 0 && halted > 0.5;
          const reload = KINDS[this.kind[i]].reload / 20;
          const still = lod === 1 && d2 >= still2;
          if (still) stillCount++;
          else if (lod === 1) jointedCount++;
          // Just out of a carrier: the men are still climbing out of its back.
          const leaving = alive ? seconds - this.dismountAt[i] : DISMOUNT_SECONDS;
          for (let k = 0; k < men; k++) {
            const f = figures[k];
            let sx = x + f.x * cos + f.z * sin;
            let sz = z - f.x * sin + f.z * cos;
            let sy: number;
            if (onRoof) {
              const st = this.insideOf(i);
              [sx, sz] = this.structures.onRoof(st, sx, sz);
              sy = this.structures.roofAt(st, sx, sz);
            } else sy = this.terrain.heightAt(sx, sz) + fall;
            let mfs = fs;
            let mfc = fc;
            let out = 1;
            if (leaving < DISMOUNT_SECONDS) {
              out = (leaving - k * DISMOUNT_GAP) / DISMOUNT_RUN;
              if (out <= 0) continue; // still aboard
              if (out < 1) {
                const e = out * (2 - out);
                const dx = this.doorX[i];
                const dz = this.doorZ[i];
                const hx = sx - dx;
                const hz = sz - dz;
                const hl = Math.hypot(hx, hz) || 1;
                mfs = hx / hl;
                mfc = hz / hl;
                sx = dx + hx * e;
                sz = dz + hz * e;
                sy = this.terrain.heightAt(sx, sz) + this.doorY[i] * (1 - e) * (1 - e);
              }
            }
            const seed = ((i + k * 5) % SEEDS) + coatOf + BURN_BASE;
            if (f.weapon) {
              // Packed up and carried on the move (the first man has the tube on his back).
              if (emplaced)
                troop.weapons[f.weapon]![lod].put(
                  sx,
                  sy,
                  sz,
                  mfs,
                  mfc,
                  1,
                  team[0],
                  team[1],
                  team[2],
                  seed,
                );
              continue;
            }
            if (f.turn && out >= 1) {
              // Turned to face the weapon as he settles beside it.
              const t = face + f.turn * halted;
              mfs = Math.sin(t);
              mfc = Math.cos(t);
            }
            // Halted, a squad takes a knee, and in a fight some of it goes flat; a missile
            // crew kneels by its launcher; scouts lie up and watch.
            const role = (i + k) % 5;
            let kneel = halted;
            let prone = 0;
            if (drill === DRILL_SCOUT) prone = halted;
            else if (drill === DRILL_SQUAD) {
              if (role === 1 || role === 4) prone = halted * fight;
              else if (role === 3) kneel = halted * (1 - fight);
              else if (role === 0) kneel = halted * fight;
              // Pinned by a machine gun, the whole squad is flat.
              if (seconds < this.pinnedUntil[i]) prone = halted;
            }
            const burst = since * 7 + k * 0.37;
            const climbing = out < 1;
            const firing =
              weapon === 0 &&
              !climbing &&
              since < 0.9 &&
              halted > 0.6 &&
              ((burst | 0) + k) % 2 === 0;
            // What he carries: one machine gun and one rocket in a squad; a team's first man
            // has its weapon's tube on his back until it is set down.
            const arm =
              drill === DRILL_SQUAD
                ? role === 1
                  ? ARM_MG
                  : role === 2
                    ? ARM_TUBE
                    : ARM_RIFLE
                : weapon !== 0 && k === 1 && !emplaced
                  ? ARM_TUBE
                  : ARM_RIFLE;
            const phase = burst - (burst | 0);
            const run = climbing ? 1 : 1 - halted;
            const aim = climbing ? 0 : fight * halted;
            if (climbing) kneel = prone = 0;
            const stride = (climbing ? seconds * 11 + i * 1.3 : paces) + k * 2.1;
            const serving = emplaced && !climbing && (fight > 0.5 || k === 1);
            if (still && serving) kneel = 1;
            if (
              !still ||
              !soldiers.still(
                stillPose(kneel, prone, run, aim, stride),
                sx,
                sy,
                sz,
                mfs,
                mfc,
                team[0],
                team[1],
                team[2],
                seed,
                d2 >= block2,
              )
            ) {
              if (serving) serve(soldiers, weapon, k - 1, since, reload);
              soldiers.man(
                near,
                sx,
                sy,
                sz,
                mfs,
                mfc,
                kneel,
                prone,
                run,
                aim,
                stride,
                firing ? 0.035 * (1 - phase) : 0,
                team[0],
                team[1],
                team[2],
                seed,
                // At the halt and out of a fight each man watches his own arc, in his own time.
                halted *
                  (1 - fight) *
                  0.75 *
                  Math.sin(seconds * (0.35 + ((i * 7 + k * 3) % 5) * 0.06) + i * 2.3 + k * 1.9),
                arm,
                near === 0 ? halted * Math.sin(seconds * 1.7 + i * 1.1 + k * 2.3) : 0,
              );
            }
            if (firing && phase < dt * 7) {
              const mz = soldiers.muzzle;
              fx.thin = 0;
              fx.muzzle(mz[0], mz[1], mz[2], mz[3], mz[4]);
            }
          }
        }
      }

      if (this.selected[i]) {
        const q = ringCount++ * 16;
        r.fill(0, q, q + 16);
        r[q] = r[q + 5] = r[q + 10] = r[q + 15] = 1;
        r[q + 12] = x;
        r[q + 13] = y + 0.12;
        r[q + 14] = z;
      }
    }
    this.stats.culled = culled;
    this.stats.still = stillCount;
    this.bodies.update(seconds, dt, camera, nearNow, this.lodFar);
    this.wrecks.update(seconds, dt, camera);
    // An empty batch is hidden, so the armies' many kinds cost nothing until they are in view.
    for (const b of batches) {
      b.flush();
      b.mesh.visible = b.n > 0;
    }
    this.jamRings.flush();
    this.ownerRings.flush();
    this.shade.flush();
    this.walkers = walkers;
    icons.batch.flush();
    this.rings.count = ringCount;
    // Hold the number of full-detail units near the budget for the next frame.
    if (lodCount[0] > this.nearBudget) {
      this.nearScale = Math.max(
        0.25,
        this.nearScale * Math.max(0.5, Math.sqrt(this.nearBudget / lodCount[0])),
      );
    } else if (lodCount[0] < this.nearBudget * 0.7)
      this.nearScale = Math.min(1, this.nearScale * 1.03);
    if (fullCount > this.fullBudget) {
      this.fullScale = Math.max(
        0.2,
        this.fullScale * Math.max(0.5, Math.sqrt(this.fullBudget / fullCount)),
      );
    } else if (fullCount < this.fullBudget * 0.7)
      this.fullScale = Math.min(1, this.fullScale * 1.03);
    // And the number posed in pieces at the middle level near its own budget.
    const jointed = jointedCount;
    if (jointed > this.midBudget) {
      this.stillScale = Math.max(
        0.2,
        this.stillScale * Math.max(0.5, Math.sqrt(this.midBudget / jointed)),
      );
    } else if (jointed < this.midBudget * 0.7)
      this.stillScale = Math.min(1, this.stillScale * 1.03);
    if (ringCount > 0) {
      const attr = this.rings.instanceMatrix;
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, ringCount * 16);
      attr.needsUpdate = true;
    }
  }
}

/** Rotate `from` toward `to` along the shortest arc by at most `max` radians. */
function turn(from: number, to: number, max: number): number {
  let d = to - from;
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  const h = from + (d > max ? max : d < -max ? -max : d);
  return h > Math.PI ? h - Math.PI * 2 : h < -Math.PI ? h + Math.PI * 2 : h;
}
