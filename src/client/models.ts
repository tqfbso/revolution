// Unit models, built in code at start-up: no asset downloads, original designs, three
// levels of detail each. The ground vehicles of each army are in armour.ts; the shapes they
// are all made from are in kit.ts.
//
// Conventions: forward is +Z, the model sits on y = 0, 1 unit is about 3.8 m.
// Vertex attributes: `color` is the paint/metal albedo, `teamMask` says how much of the
// per-instance team colour replaces it (0 = none, 1 = recognition panel).
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  KIND_AD,
  KIND_ARTILLERY,
  KIND_COUNT,
  KIND_DRONE,
  KIND_EW,
  KIND_HELI,
  KIND_IFV,
  KIND_LIFT,
  KIND_PLANE,
  KIND_STRIKE,
  KIND_TANK,
  KIND_TRUCK,
} from '../sim/units';
import {
  adAlliance,
  adChina,
  adRussia,
  gunAlliance,
  gunChina,
  gunRussia,
  ifvAlliance,
  ifvChina,
  ifvRussia,
  jammerAlliance,
  jammerChina,
  jammerRussia,
  tankAlliance,
  tankChina,
  tankRussia,
  truckAlliance,
  truckChina,
  truckRussia,
} from './armour';
import { box, cyl, merge, RUBBER, STEEL } from './kit';

export { box, cyl, merge };

export interface VehicleModel {
  hull: THREE.BufferGeometry[]; // LOD 0, 1
  turret: THREE.BufferGeometry[]; // LOD 0, 1
  far: THREE.BufferGeometry; // LOD 2: hull and turret in one tiny mesh
  /** Turret ring position on the hull, and the muzzle relative to the turret pivot. */
  turretY: number;
  turretZ: number;
  muzzleY: number;
  muzzleZ: number;
  /** Rotors, where the "turret" is one: each is drawn turning where it sits on the hull. */
  rotors?: Rotor[];
}
/** A rotor's hub on the airframe, the axis it turns about and which way. */
export interface Rotor {
  x: number;
  y: number;
  z: number;
  axis: 'x' | 'y';
  /** Turns a second, signed; a tail rotor turns faster than the main one. */
  rate: number;
  /** Which of the model's rotor shapes (index into `turret` pairs): 0 main, 1 tail. */
  shape: number;
}

const DRONE_GREY = 0x8b908d;

/** A small fixed-wing reconnaissance drone: long straight wing, twin tail, pusher propeller. */
export function buildReconDrone(): VehicleModel {
  const g = merge([
    box(0.22, 0.2, 1.3, { at: [0, 0, 0.05], top: [0.7, 0.9], color: DRONE_GREY }),
    box(2.6, 0.035, 0.34, { at: [0, 0.1, 0.1], color: DRONE_GREY }),
    box(0.5, 0.036, 0.3, { at: [-0.95, 0.102, 0.1], team: 1 }),
    box(0.5, 0.036, 0.3, { at: [0.95, 0.102, 0.1], team: 1 }),
    box(0.03, 0.3, 0.22, { at: [-0.25, 0.14, -0.75], rot: [0, 0, 0.5], color: DRONE_GREY }),
    box(0.03, 0.3, 0.22, { at: [0.25, 0.14, -0.75], rot: [0, 0, -0.5], color: DRONE_GREY }),
    box(0.035, 0.035, 0.7, { at: [0, 0.02, -0.45], color: STEEL }),
    cyl(0.1, 0.1, 'y', { at: [0, -0.13, 0.4], color: RUBBER }, 8), // sensor ball
  ]);
  const far = merge([
    box(0.3, 0.2, 1.3, { at: [0, 0, 0], color: DRONE_GREY, team: 0.4 }),
    box(2.6, 0.08, 0.4, { at: [0, 0.1, 0.1], color: DRONE_GREY, team: 0.6 }),
  ]);
  return { hull: [g, g.clone()], turret: [], far, turretY: 0, turretZ: 0, muzzleY: 0, muzzleZ: 0 };
}

/** A one-way attack quadcopter: four arms, four rotors, a warhead slung underneath. */
export function buildStrikeDrone(): VehicleModel {
  const parts = [
    box(0.2, 0.1, 0.34, { at: [0, 0, 0], color: RUBBER }),
    cyl(0.07, 0.5, 'z', { at: [0, -0.1, 0.12], color: 0x4a4f3c }, 8), // warhead
    box(0.08, 0.02, 0.1, { at: [0, 0.06, -0.08], team: 1 }),
  ];
  for (const [x, z] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ]) {
    parts.push(
      box(0.04, 0.03, 0.62, {
        at: [x * 0.2, 0.02, z * 0.2],
        rot: [0, x * z * 0.785, 0],
        color: RUBBER,
      }),
    );
    parts.push(cyl(0.2, 0.012, 'y', { at: [x * 0.4, 0.07, z * 0.4], color: 0x6f7472 }, 10));
  }
  const g = merge(parts);
  const far = box(0.9, 0.14, 0.9, { at: [0, 0, 0], color: RUBBER, team: 0.5 });
  return { hull: [g, g.clone()], turret: [], far, turretY: 0, turretZ: 0, muzzleY: 0, muzzleZ: 0 };
}

const AIRFRAME = 0x4b5140;
const GLASS = 0x1c2428;

/**
 * A helicopter: `gunship` is the narrow tandem two-seater with stub wings and rocket pods,
 * otherwise the fat-bodied transport with a sliding door. The rotor is the "turret", which
 * the unit renderer spins.
 */
function helicopterParts(gunship: boolean): THREE.BufferGeometry[] {
  const wid = gunship ? 0.62 : 1.05;
  const tall = gunship ? 0.8 : 1.0;
  const parts = [
    // Cabin, nose and the boom to the tail.
    box(wid, tall, 2.3, { at: [0, 0, 0.2], top: [0.8, 0.86], color: AIRFRAME, team: 0.1 }),
    box(wid * 0.8, tall * 0.6, 0.8, { at: [0, -0.12, 1.6], top: [0.6, 0.5], color: AIRFRAME }),
    box(wid * 0.74, tall * 0.4, 0.75, { at: [0, 0.14, 1.28], top: [0.8, 0.6], color: GLASS }),
    box(0.2, 0.24, 2.5, { at: [0, 0.14, -2.1], top: [0.7, 0.6], color: AIRFRAME }),
    box(0.06, 0.8, 0.46, { at: [0, 0.5, -3.2], top: [1, 0.55], color: AIRFRAME }),
    box(0.9, 0.05, 0.3, { at: [0, 0.22, -3.0], team: 1 }),
    cyl(0.42, 0.03, 'x', { at: [0.12, 0.62, -3.25], color: 0x6f7472 }, 10), // tail rotor disc
    // Engines on the roof and the mast.
    box(wid * 0.9, 0.26, 1.2, { at: [0, tall / 2 + 0.1, -0.1], top: [0.8, 0.8], color: AIRFRAME }),
    cyl(0.07, 0.3, 'y', { at: [0, tall / 2 + 0.34, 0.05], color: STEEL }, 6),
    // Skids.
    box(0.05, 0.05, 1.9, { at: [-wid * 0.62, -tall / 2 - 0.2, 0.25], color: STEEL }),
    box(0.05, 0.05, 1.9, { at: [wid * 0.62, -tall / 2 - 0.2, 0.25], color: STEEL }),
    box(wid * 1.24, 0.04, 0.05, { at: [0, -tall / 2 - 0.1, 0.8], color: STEEL }),
    box(wid * 1.24, 0.04, 0.05, { at: [0, -tall / 2 - 0.1, -0.3], color: STEEL }),
  ];
  if (gunship) {
    parts.push(
      box(2.2, 0.07, 0.5, { at: [0, -0.12, 0.1], color: AIRFRAME, team: 0.3 }),
      cyl(0.16, 0.9, 'z', { at: [-0.8, -0.28, 0.2], color: 0x3a3d33 }, 8),
      cyl(0.16, 0.9, 'z', { at: [0.8, -0.28, 0.2], color: 0x3a3d33 }, 8),
      cyl(0.035, 0.6, 'z', { at: [0, -0.42, 1.9], color: STEEL }, 6), // chin gun
    );
  } else {
    parts.push(
      box(0.03, tall * 0.55, 0.9, { at: [-wid / 2 - 0.01, 0, 0.1], color: 0x33382c }),
      box(0.03, tall * 0.55, 0.9, { at: [wid / 2 + 0.01, 0, 0.1], color: 0x33382c }),
      box(wid + 0.04, 0.1, 0.5, { at: [0, 0.05, -0.75], team: 1 }),
    );
  }
  return parts;
}

export function buildHelicopter(gunship: boolean): VehicleModel {
  const wid = gunship ? 0.62 : 1.05;
  const tall = gunship ? 0.8 : 1.0;
  const parts = helicopterParts(gunship);
  const g = merge(parts);
  const span = gunship ? 4.6 : 5.2;
  const rotor = merge([
    box(span, 0.03, 0.2, { at: [0, 0, 0], color: RUBBER }),
    box(0.2, 0.03, span, { at: [0, 0, 0], color: RUBBER }),
    cyl(0.16, 0.08, 'y', { at: [0, 0, 0], color: STEEL }, 8),
  ]);
  const far = merge([
    box(wid, tall, 2.6, { at: [0, 0, 0.3], color: AIRFRAME, team: 0.4 }),
    box(0.22, 0.3, 2.6, { at: [0, 0.14, -2.1], color: AIRFRAME, team: 0.4 }),
    cyl(span / 2, 0.04, 'y', { at: [0, tall / 2 + 0.5, 0.05], color: 0x6f7472 }, 10),
  ]);
  return {
    hull: [g, g.clone()],
    turret: [rotor, rotor.clone()],
    far,
    turretY: tall / 2 + 0.5,
    turretZ: 0.05,
    muzzleY: -tall / 2 - 0.9,
    muzzleZ: 1.2,
  };
}

/**
 * A helicopter that came down (visual only; it stays for the rest of the game). Three ways
 * to lie, each the airframe itself turned over or nose-first into the ground, with the tail
 * boom snapped, the rotor gone and a bent blade lying alongside. Built from the flying
 * model's own parts, so the paint and the wear match; the burn material scorches it.
 */
export function buildHelicopterWrecks(gunship: boolean): THREE.BufferGeometry[] {
  const wid = gunship ? 0.62 : 1.05;
  const pose = (roll: number, pitch: number, yaw: number, snapTail: boolean) => {
    const parts = helicopterParts(gunship);
    // The tail (boom is part 3, fin 4, stabiliser 5, tail rotor disc 6) is thrown clear of the
    // fuselage when the boom snaps.
    const air = merge(snapTail ? [...parts.slice(0, 3), ...parts.slice(7)] : parts.slice());
    let tail: THREE.BufferGeometry | null = null;
    if (snapTail) {
      tail = merge(parts.slice(3, 7));
      tail.rotateY(0.55);
      tail.rotateZ(0.3);
      tail.translate(wid * 0.9, 0.05, -0.2);
    }
    const blades = merge([
      box(2.1, 0.03, 0.18, { at: [0, 0, 0], rot: [0.0, 0.3, 0.12], color: RUBBER }),
      box(1.4, 0.03, 0.18, { at: [0.9, 0, -1.1], rot: [0.1, -0.9, 0], color: RUBBER }),
    ]);
    blades.translate(-wid * 1.7, 0.07, 0.4);
    const all = mergeGeometries([air, ...(tail ? [tail] : []), blades]);
    all.applyMatrix4(
      new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ')),
    );
    all.computeBoundingBox();
    // Sits on the ground with a little of it sunk in.
    all.translate(0, 0.03 - all.boundingBox!.min.y, 0);
    return all;
  };
  return [
    pose(1.42, 0.12, 0.4, false), // on its side
    pose(0.1, 0.62, -0.5, true), // nose into the ground, tail snapped off
    pose(-0.18, -0.12, 1.1, true), // upright and broken, tilted on a skid
  ];
}

/** A four-engined transport plane with a high wing and a tall tail. */
export function buildTransportPlane(): VehicleModel {
  const parts = [
    cyl(0.8, 8.2, 'z', { at: [0, 0, 0], color: 0x596057 }, 10),
    box(1.3, 1.2, 1.6, { at: [0, -0.05, 4.6], top: [0.5, 0.35], color: 0x596057 }),
    box(1.1, 0.4, 0.9, { at: [0, 0.3, 4.3], top: [0.8, 0.5], color: GLASS }),
    box(1.2, 1.1, 2.6, { at: [0, 0.25, -5.2], top: [0.4, 0.5], color: 0x596057 }),
    // Wing on top of the fuselage, with a band in the army's colour.
    box(13, 0.16, 1.7, { at: [0, 0.82, 0.5], color: 0x596057 }),
    box(1.6, 0.17, 1.72, { at: [-4.6, 0.82, 0.5], team: 1 }),
    box(1.6, 0.17, 1.72, { at: [4.6, 0.82, 0.5], team: 1 }),
    // Tail.
    box(0.14, 2.3, 1.5, { at: [0, 1.5, -5.8], top: [1, 0.55], color: 0x596057 }),
    box(4.6, 0.1, 1.0, { at: [0, 0.75, -5.9], color: 0x596057 }),
    box(0.16, 0.7, 1.2, { at: [0, 2.2, -5.9], team: 1 }),
  ];
  for (const x of [-4.1, -2.1, 2.1, 4.1]) {
    parts.push(cyl(0.3, 1.5, 'z', { at: [x, 0.6, 1.2], color: 0x3f443c }, 8));
    parts.push(cyl(0.95, 0.03, 'z', { at: [x, 0.6, 2.0], color: 0x7b807c }, 10)); // propeller disc
  }
  const g = merge(parts);
  const far = merge([
    box(1.5, 1.4, 11, { at: [0, 0, -0.4], color: 0x596057, team: 0.2 }),
    box(13, 0.2, 1.7, { at: [0, 0.8, 0.5], color: 0x596057, team: 0.5 }),
    box(0.2, 2.2, 1.5, { at: [0, 1.5, -5.8], color: 0x596057, team: 0.6 }),
  ]);
  return { hull: [g, g.clone()], turret: [], far, turretY: 0, turretZ: 0, muzzleY: 0, muzzleZ: 0 };
}

/**
 * A strike jet (I7): a single-seat fighter-bomber in grey, swept wings, twin fins, the
 * load on pylons under the wings, the army's colour only on the fins.
 */
export function buildJet(): VehicleModel {
  const GREY = 0x6a7076;
  const DARK = 0x4a4f54;
  const parts = [
    cyl(0.55, 8.6, 'z', { at: [0, 0, -0.4], color: GREY }, 12),
    // Nose cone and canopy.
    box(0.95, 0.9, 2.2, {
      at: [0, 0, 4.9],
      rot: [Math.PI / 2, 0, 0],
      top: [0.18, 0.22],
      color: GREY,
    }),
    box(0.5, 0.4, 1.7, { at: [0, 0.55, 2.6], top: [0.55, 0.6], color: GLASS }),
    // Intakes either side.
    box(0.45, 0.6, 2.2, { at: [-0.7, -0.1, 1.0], color: DARK }),
    box(0.45, 0.6, 2.2, { at: [0.7, -0.1, 1.0], color: DARK }),
    // Swept wings.
    box(3.8, 0.12, 2.1, { at: [-2.2, -0.05, -0.9], rot: [0, -0.5, 0], color: GREY }),
    box(3.8, 0.12, 2.1, { at: [2.2, -0.05, -0.9], rot: [0, 0.5, 0], color: GREY }),
    // Tailplanes and twin fins with the army's colour.
    box(1.8, 0.1, 1.2, { at: [-1.1, 0, -4.2], rot: [0, -0.45, 0], color: GREY }),
    box(1.8, 0.1, 1.2, { at: [1.1, 0, -4.2], rot: [0, 0.45, 0], color: GREY }),
    box(0.1, 1.5, 1.5, {
      at: [-0.45, 0.85, -3.9],
      rot: [0, 0, -0.25],
      top: [1, 0.5],
      shear: -0.5,
      color: GREY,
    }),
    box(0.1, 1.5, 1.5, {
      at: [0.45, 0.85, -3.9],
      rot: [0, 0, 0.25],
      top: [1, 0.5],
      shear: -0.5,
      color: GREY,
    }),
    box(0.11, 0.5, 0.8, { at: [-0.62, 1.4, -4.2], rot: [0, 0, -0.25], team: 1 }),
    box(0.11, 0.5, 0.8, { at: [0.62, 1.4, -4.2], rot: [0, 0, 0.25], team: 1 }),
    // Exhausts.
    cyl(0.32, 0.5, 'z', { at: [-0.3, -0.05, -4.85], color: 0x2a2b2c }, 10),
    cyl(0.32, 0.5, 'z', { at: [0.3, -0.05, -4.85], color: 0x2a2b2c }, 10),
    // The load under the wings.
    cyl(0.2, 2.0, 'z', { at: [-1.9, -0.45, -0.4], color: 0x4b5141 }, 8),
    cyl(0.2, 2.0, 'z', { at: [1.9, -0.45, -0.4], color: 0x4b5141 }, 8),
  ];
  const g = merge(parts);
  const far = merge([
    box(1.2, 1.0, 10, { at: [0, 0, 0], color: GREY, team: 0.2 }),
    box(8, 0.2, 2.4, { at: [0, 0, -0.9], color: GREY, team: 0.4 }),
    box(1.4, 1.5, 1.4, { at: [0, 0.9, -3.9], color: GREY, team: 0.7 }),
  ]);
  return { hull: [g, g.clone()], turret: [], far, turretY: 0, turretZ: 0, muzzleY: 0, muzzleZ: 0 };
}

/** A free-fall bomb on its way down, nose first: body, the fins at the top. */
export function buildBomb(): THREE.BufferGeometry {
  return merge([
    cyl(0.22, 1.5, 'y', { at: [0, 0, 0], color: 0x4b5141 }, 10),
    box(0.3, 0.4, 0.3, {
      at: [0, -0.9, 0],
      top: [0.2, 0.2],
      rot: [Math.PI, 0, 0],
      color: 0x4b5141,
    }),
    box(0.7, 0.4, 0.05, { at: [0, 0.85, 0], color: 0x3f4434 }),
    box(0.05, 0.4, 0.7, { at: [0, 0.85, 0], color: 0x3f4434 }),
  ]);
}

export interface InfantryModel {
  far: THREE.BufferGeometry; // LOD 2: the whole squad in one mesh
}

export const SQUAD_SIZE = 5;
/** Wedge formation: where each soldier stands relative to the squad centre (x, z). */
export const SQUAD_OFFSETS: readonly [number, number][] = [
  [0, 0.55],
  [-0.5, 0.1],
  [0.5, 0.1],
  [-0.95, -0.4],
  [0.95, -0.4],
];

/** The far level of a rifle squad: one block per man. The men themselves are in soldiers.ts. */
export function buildInfantry(): InfantryModel {
  const far = merge(
    SQUAD_OFFSETS.flatMap(([x, z]) => [
      box(0.26, 0.5, 0.2, { at: [x, 0.25, z], top: [1.25, 1], color: 0x3a3d2e, team: 0.7 }),
      box(0.16, 0.14, 0.17, { at: [x, 0.56, z], color: 0x3a3d2e, team: 0.4 }),
    ]),
  );
  return { far };
}

/** Where the two crewmen of a missile team stand, and the launcher between them. */
export const TEAM_OFFSETS: readonly [number, number][] = [
  [-0.4, -0.05],
  [0.42, -0.3],
];

/**
 * Where a crew-served weapon stands in its team, ahead of the unit's centre, and where its
 * two men kneel to serve it (drills.ts), in map units. A man is `MAN` units to the metre.
 */
const MAN = 0.62 / 1.8;
export const MORTAR_AT: readonly [number, number] = [0, 0.3];
export const LAUNCHER_AT: readonly [number, number] = [0, 0.3];
/** How high the mortar's muzzle is and how far ahead of its base plate, in metres. */
export const MORTAR_MUZZLE: readonly [number, number] = [1.1, 0.6];

/**
 * The mortar team's weapon (I6), at the men's own scale: a tube on a bipod, its base plate
 * on the ground, a few bombs in their cases beside it. The alliance's is the plain medium
 * tube; Russia's sits on a wide square plate with a longer barrel; China's is the short
 * one with a carrying handle.
 */
export function buildMortar(faction = 0): {
  tube: THREE.BufferGeometry;
  far: THREE.BufferGeometry;
} {
  const g: THREE.BufferGeometry[] = [];
  const [my, mz] = MORTAR_MUZZLE;
  const long = faction === 2 ? 1.12 : faction === 3 ? 0.9 : 1;
  const len = Math.hypot(my, mz);
  const tilt = -Math.atan2(my, mz);
  const along = (t: number): [number, number, number] => [0, my * t, mz * t];
  if (faction === 2) g.push(box(0.5, 0.05, 0.5, { at: [0, 0.025, -0.02], color: STEEL }));
  else g.push(cyl(0.26, 0.05, 'y', { at: [0, 0.025, -0.02], color: STEEL }, 10));
  g.push(cyl(0.06, len * long, 'z', { at: along(0.5 * long), rot: [tilt, 0, 0] }, 8));
  g.push(cyl(0.075, 0.1, 'z', { at: along(long - 0.04), rot: [tilt, 0, 0], color: STEEL }, 8));
  g.push(cyl(0.08, 0.12, 'z', { at: along(0.05), rot: [tilt, 0, 0], color: STEEL }, 8));
  // The bipod: two legs from two thirds up the tube out to the ground ahead, a brace.
  const [, cy, cz] = along(0.62);
  for (const x of [-1, 1]) {
    g.push(
      box(0.03, Math.hypot(cy, 0.3) + 0.04, 0.03, {
        at: [x * 0.15, cy / 2, cz + 0.07],
        rot: [0.16, 0, x * Math.atan2(0.3, cy)],
        color: STEEL,
      }),
    );
  }
  g.push(box(0.2, 0.025, 0.025, { at: [0, cy * 0.55, cz + 0.1], color: STEEL }));
  g.push(box(0.09, 0.1, 0.12, { at: [-0.1, cy + 0.03, cz - 0.02], team: 1 })); // the sight
  if (faction === 3)
    g.push(
      box(0.03, 0.05, 0.22, {
        at: [0, cy * 0.5 + 0.1, cz * 0.5 - 0.06],
        rot: [tilt, 0, 0],
        color: STEEL,
      }),
    );
  // Bomb cases, olive with a stencil of team colour, and two bombs stood ready.
  g.push(box(0.2, 0.14, 0.5, { at: [0.55, 0.07, -0.25] }));
  g.push(box(0.21, 0.03, 0.1, { at: [0.55, 0.13, -0.25], team: 0.6 }));
  g.push(box(0.2, 0.14, 0.5, { at: [0.8, 0.07, -0.2], rot: [0, 0.3, 0] }));
  for (const [x, z] of [
    [0.42, 0.12],
    [0.52, 0.2],
  ]) {
    g.push(cyl(0.04, 0.26, 'y', { at: [x, 0.13, z], color: STEEL }, 6, 0.03));
    g.push(cyl(0.03, 0.1, 'y', { at: [x, 0.31, z], color: STEEL }, 6, 0.008));
  }
  const far = merge([
    ...TEAM_OFFSETS.map(([x, z]) =>
      box(0.3, 0.6, 0.3, { at: [x, 0.3, z], color: 0x3a3d2e, team: 0.7 }),
    ),
    box(0.16, 0.16, 0.8, { at: [0, 0.35, 0.1], rot: [-0.87, 0, 0], color: 0x2c2f25, team: 0.5 }),
  ]);
  return { tube: merge(g).scale(MAN, MAN, MAN), far };
}

/** How high the launcher's tube is, and how far behind its tripod the gunner's grips are, in metres. */
export const LAUNCHER_GRIP: readonly [number, number] = [0.8, -0.32];

/**
 * An anti-tank missile launcher on its tripod, at the men's own scale. The alliance's is a
 * fat tube with a big boxy sight beside it; Russia's a long slim tube over a low sight
 * unit; China's a short thick tube with a round sight on top.
 */
export function buildLauncher(faction = 0): {
  launcher: THREE.BufferGeometry;
  far: THREE.BufferGeometry;
} {
  const g: THREE.BufferGeometry[] = [];
  const h = LAUNCHER_GRIP[0];
  const r = faction === 2 ? 0.075 : faction === 3 ? 0.11 : 0.095;
  const len = faction === 2 ? 1.35 : faction === 3 ? 1.05 : 1.2;
  g.push(cyl(r, len, 'z', { at: [0, h, 0.1], rot: [-0.05, 0, 0] }, 9));
  g.push(cyl(r + 0.02, 0.1, 'z', { at: [0, h + 0.03, 0.1 + len / 2], color: RUBBER }, 9));
  g.push(cyl(r + 0.02, 0.1, 'z', { at: [0, h - 0.03, 0.1 - len / 2], color: RUBBER }, 9));
  if (faction === 2) {
    g.push(box(0.2, 0.2, 0.3, { at: [0, h - 0.19, -0.05], color: STEEL }));
    g.push(cyl(0.05, 0.08, 'z', { at: [0.04, h - 0.17, 0.13], color: 0x1c2428 }, 7));
  } else if (faction === 3) {
    g.push(cyl(0.07, 0.3, 'z', { at: [0, h + 0.19, -0.1], color: STEEL }, 8));
    g.push(box(0.1, 0.1, 0.12, { at: [0, h + 0.13, -0.1], color: STEEL }));
  } else {
    g.push(box(0.2, 0.24, 0.34, { at: [0.2, h + 0.04, -0.1], color: STEEL }));
    g.push(cyl(0.06, 0.06, 'z', { at: [0.2, h + 0.06, 0.09], color: 0x1c2428 }, 7));
  }
  g.push(box(0.06, 0.04, 0.06, { at: [0, h + r + 0.02, 0.3], team: 1 }));
  // Grips at the back for the gunner, the head of the tripod, three legs.
  g.push(box(0.3, 0.03, 0.03, { at: [0, h - 0.12, LAUNCHER_GRIP[1]], color: STEEL }));
  g.push(box(0.03, 0.03, 0.3, { at: [0, h - 0.12, LAUNCHER_GRIP[1] + 0.15], color: STEEL }));
  g.push(cyl(0.06, 0.14, 'y', { at: [0, h - r - 0.07, 0.05], color: STEEL }, 7));
  const top = h - r - 0.12;
  for (const [x, z] of [
    [0, 0.5],
    [-0.42, -0.28],
    [0.42, -0.28],
  ]) {
    const run = Math.hypot(x, z);
    g.push(
      box(0.035, Math.hypot(top, run), 0.035, {
        at: [x / 2, top / 2, 0.05 + z / 2],
        rot: [Math.atan2(z, top), 0, -Math.atan2(x, top)],
        color: STEEL,
      }),
    );
  }
  const far = merge([
    ...TEAM_OFFSETS.map(([x, z]) =>
      box(0.3, 0.6, 0.3, { at: [x, 0.3, z], color: 0x3a3d2e, team: 0.7 }),
    ),
    box(0.22, 0.2, 1.1, { at: [0, 0.45, 0.15], color: 0x2c2f25, team: 0.5 }),
  ]);
  return { launcher: merge(g).scale(MAN, MAN, MAN), far };
}

/** Every model one army is drawn with. `vehicles[kind]` is null for the kinds on foot. */
export interface Arsenal {
  vehicles: (VehicleModel | null)[];
  /** The strike jet (I7), which flies as a transport plane in the sim. */
  jet: VehicleModel;
}

/** The models of the army of `faction` (sim/factions.ts). */
export function buildArsenal(faction: number): Arsenal {
  const vehicles = new Array<VehicleModel | null>(KIND_COUNT).fill(null);
  const f = faction === 2 ? 1 : faction === 3 ? 2 : 0;
  vehicles[KIND_TANK] = [tankAlliance, tankRussia, tankChina][f]();
  vehicles[KIND_IFV] = [ifvAlliance, ifvRussia, ifvChina][f]();
  vehicles[KIND_ARTILLERY] = [gunAlliance, gunRussia, gunChina][f]();
  vehicles[KIND_AD] = [adAlliance, adRussia, adChina][f]();
  vehicles[KIND_EW] = [jammerAlliance, jammerRussia, jammerChina][f]();
  vehicles[KIND_TRUCK] = [truckAlliance, truckRussia, truckChina][f]();
  vehicles[KIND_DRONE] = buildReconDrone();
  vehicles[KIND_STRIKE] = buildStrikeDrone();
  vehicles[KIND_HELI] = buildHelicopter(true);
  vehicles[KIND_LIFT] = buildHelicopter(false);
  vehicles[KIND_PLANE] = buildTransportPlane();
  return { vehicles, jet: buildJet() };
}
