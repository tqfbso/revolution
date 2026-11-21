// Unit models, built in code at start-up: no asset downloads, original designs, three
// levels of detail each. The ground vehicles of each army are in armour.ts, its aircraft in
// aircraft.ts; the shapes they are all made from are in kit.ts.
//
// Conventions: forward is +Z, the model sits on y = 0, 1 unit is about 3.8 m.
// Vertex attributes: `color` is the paint/metal albedo, `teamMask` says how much of the
// per-instance team colour replaces it (0 = none, 1 = recognition panel).
import * as THREE from 'three/webgpu';
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
import {
  gunshipAlliance,
  gunshipChina,
  gunshipRussia,
  jetAlliance,
  jetChina,
  jetRussia,
  liftAlliance,
  liftChina,
  liftRussia,
  planeAlliance,
  planeChina,
  planeRussia,
  reconAlliance,
  reconChina,
  reconRussia,
  strikeAlliance,
  strikeChina,
  strikeRussia,
} from './aircraft';
import { box, cyl, merge, RUBBER, STEEL } from './kit';

export { box, cyl, merge };

export interface VehicleModel {
  /** Three levels: all of it (close to), its masses (near), its outline (the middle distance). */
  hull: THREE.BufferGeometry[];
  turret: THREE.BufferGeometry[];
  /** Far off: hull and turret as a few boxes in one mesh. */
  far: THREE.BufferGeometry;
  /** Turret ring position on the hull, and the muzzle relative to the turret pivot. */
  turretY: number;
  turretZ: number;
  muzzleY: number;
  muzzleZ: number;
  /** What turns on an aircraft: each is drawn turning where it sits on the airframe. */
  rotors?: Rotor[];
  /** The shapes the rotors are drawn with, near and middle level each: `Rotor.shape` picks one. */
  rotorShapes?: THREE.BufferGeometry[][];
  /** An aircraft's model sits this far above its own origin (aircraft.ts): draw it that much lower. */
  lift?: number;
  /** A helicopter's airframe in two pieces, for the wrecks: the tail snaps off. */
  wreck?: { body: THREE.BufferGeometry; tail: THREE.BufferGeometry };
}
/** A rotor's or a propeller's hub on the airframe, the axis it turns about and how fast. */
export interface Rotor {
  x: number;
  y: number;
  z: number;
  /** `y` a main rotor, `x` a tail rotor, `z` a propeller. */
  axis: 'x' | 'y' | 'z';
  /** Radians a second, signed: two rotors on one airframe turn opposite ways. */
  rate: number;
  /** Index into the model's `rotorShapes`. */
  shape: number;
  /** Its radius. */
  r: number;
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
  vehicles[KIND_DRONE] = [reconAlliance, reconRussia, reconChina][f]();
  vehicles[KIND_STRIKE] = [strikeAlliance, strikeRussia, strikeChina][f]();
  vehicles[KIND_HELI] = [gunshipAlliance, gunshipRussia, gunshipChina][f]();
  vehicles[KIND_LIFT] = [liftAlliance, liftRussia, liftChina][f]();
  vehicles[KIND_PLANE] = [planeAlliance, planeRussia, planeChina][f]();
  return { vehicles, jet: [jetAlliance, jetRussia, jetChina][f]() };
}
