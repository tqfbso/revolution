// The aircraft of the three armies (models phase 3, decision 159): each army's gunship,
// transport helicopter, strike jet, transport plane and its two drones in its own shape.
// Original designs in the manner of each army's present-day types, chosen so the outline
// from above tells them apart: the alliance's gunship is a narrow tandem two-seater and its
// lifter has a rotor at each end; Russia's gunship has two rotors one over the other and no
// tail rotor, its lifter a round glazed nose; China's have a ducted fan in the tail and a
// long low cabin.
//
// Written in metres (kit.ts), each model once for all three levels of detail. An aircraft's
// origin is the middle of its fuselage; rotors and propellers are separate shapes that the
// unit view turns where the model says they sit.
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { showTeam } from './armour';
import { atLevels, GLASS, M, Parts, prism, RUBBER, STEEL, under, type Opts } from './kit';
import type { Rotor, VehicleModel } from './models';

type Plan = readonly (readonly [number, number])[];

/** Aircraft skins are thin and kept clean: a narrower band of wear than armour's, so a blade or a fin is not all edge. */
const AIR_WEAR = 0.02;
/** How far up its own origin an aircraft's model is stored, map units (see `aircraft`). */
const AIR_LIFT = 1.4;

/** What a builder hands back: where things turn, and where the weapons are. */
interface Flown {
  rotors?: Rotor[];
  /** One bench a rotor shape, in the order `Rotor.shape` counts them. */
  shapes?: Parts[];
  muzzleY?: number;
  muzzleZ?: number;
}

/**
 * An aircraft from its builder. `body` is the airframe; whatever is put on `tail` is the
 * part that snaps off when a helicopter comes down (wrecks). Rotors come back in metres.
 */
function aircraft(build: (lod: number, body: Parts, tail: Parts) => Flown): VehicleModel {
  const levels = atLevels((lod) => {
    const body = new Parts(lod);
    const tail = new Parts(lod);
    return { body, tail, ...build(lod, body, tail) };
  }, AIR_WEAR);
  const whole = (l: (typeof levels)[number]) => {
    const p = new Parts(l.body.lod);
    p.list.push(...l.body.list, ...l.tail.list);
    return p;
  };
  const [a, b, c] = levels;
  // Far off the rotors are a still disc and the army's colour is laid over the paint.
  const far = whole(c);
  for (const r of a.rotors ?? [])
    if (r.axis === 'y' && r.r > 1.5)
      far.cyl(r.r * 0.96, 0.05, 'y', { at: [r.x, r.y, r.z], color: 0x565a58 }, 8);
  const farG = far.done();
  showTeam(farG, 0.4);
  const plain = (g: THREE.BufferGeometry) => (g.index ? g.toNonIndexed() : g);
  // The unit paint throws mud over whatever is low on a model. An aircraft is modelled
  // about the middle of its fuselage, so it is all "low": the model is stored `AIR_LIFT`
  // up, out of the mud, and the unit view draws it that much down again.
  const up = (g: THREE.BufferGeometry) => g.translate(0, AIR_LIFT, 0);
  const lifted = new Set((a.rotors ?? []).filter((r) => r.axis === 'y').map((r) => r.shape));
  const rotors = (a.rotors ?? []).map((r) => ({
    ...r,
    x: r.x * M,
    y: r.y * M + (r.axis === 'y' ? 0 : AIR_LIFT),
    z: r.z * M,
    r: r.r * M,
  }));
  const model: VehicleModel = {
    hull: [up(whole(a).done()), up(whole(b).done()), up(whole(c).done())],
    turret: [],
    far: up(farG),
    turretY: 0,
    turretZ: 0,
    muzzleY: (a.muzzleY ?? 0) * M,
    muzzleZ: (a.muzzleZ ?? 0) * M,
    rotors,
    rotorShapes: (a.shapes ?? []).map((s, k) =>
      [s.done(), b.shapes![k].done()].map((g) => (lifted.has(k) ? up(g) : g)),
    ),
    lift: AIR_LIFT,
  };
  if (b.tail.list.length > 0)
    model.wreck = { body: plain(b.body.done()), tail: plain(b.tail.done()) };
  return model;
}

/** A flat surface seen from above: `plan` is [z, x] round its outline on the left (x > 0). */
function plate(
  plan: Plan,
  thick: number,
  side: number,
  y: number,
  o: Opts = {},
  dihedral = 0,
): THREE.BufferGeometry {
  const g = prism(plan, thick / 2, o);
  // The outline's second axis is laid out along x (left) or -x (right).
  g.rotateZ(side > 0 ? -Math.PI / 2 : Math.PI / 2);
  if (dihedral !== 0) g.rotateZ(side * dihedral);
  return g.translate(0, y, 0);
}

/** Both wings (or tailplanes, or canards) from the left one's outline. */
function wings(
  P: Parts,
  plan: Plan,
  thick: number,
  y: number,
  o: Opts = {},
  keep = 2,
  dihedral = 0,
): void {
  if (P.lod > keep) return;
  P.add([plate(plan, thick, 1, y, o, dihedral), plate(plan, thick, -1, y, o, dihedral)]);
}

/** A fin seen from the side: `side` is [z, y] round its outline; `cant` leans its top outward. */
function fin(
  P: Parts,
  side: Plan,
  thick: number,
  x: number,
  o: Opts = {},
  keep = 2,
  cant = 0,
  foot = 0,
): void {
  if (P.lod > keep) return;
  const g = prism(side, thick / 2, o);
  // Lean about the fin's own foot, not the middle of the aircraft.
  if (cant !== 0) g.translate(0, -foot, 0).rotateZ(-cant).translate(0, foot, 0);
  P.add(g.translate(x, 0, 0));
}

/** A rotor that turns about the upright: `n` blades of radius `r` and a hub. */
function rotorShape(lod: number, n: number, r: number, chord: number, colour: number): Parts {
  const P = new Parts(lod);
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    P.box(chord, 0.05, r, {
      at: [(Math.sin(a) * r) / 2, 0, (Math.cos(a) * r) / 2],
      rot: [0, a, 0],
      color: colour,
    });
  }
  P.cyl(chord * 1.1, 0.22, 'y', { color: STEEL }, 8, 1);
  return P;
}

/** A tail rotor (it turns about the sideways axis) or a propeller (about the fore-and-aft one). */
function fanShape(
  lod: number,
  axis: 'x' | 'z',
  n: number,
  r: number,
  chord: number,
  colour: number,
): Parts {
  const P = new Parts(lod);
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    if (axis === 'x')
      P.box(0.04, r, chord, {
        at: [0, (Math.cos(a) * r) / 2, (Math.sin(a) * r) / 2],
        rot: [a, 0, 0],
        color: colour,
      });
    else
      P.box(chord, r, 0.04, {
        at: [(-Math.sin(a) * r) / 2, (Math.cos(a) * r) / 2, 0],
        rot: [0, 0, a],
        color: colour,
      });
  }
  return P;
}

/** Stub wings with a rocket pod and a rack of missiles under each. */
function stores(P: Parts, span: number, y: number, z: number, paint: number, pods: number): void {
  P.box(span, 0.12, 0.95, { at: [0, y, z], top: [1, 0.7], color: paint, team: 0.25 }, 1);
  P.both((s) => {
    P.cyl(0.22, 1.7, 'z', { at: [s * span * 0.3, y - 0.36, z + 0.1], color: pods }, 8, 1);
    P.box(0.5, 0.2, 1.5, { at: [s * span * 0.45, y - 0.3, z + 0.05], color: pods }, 1);
    P.box(0.06, 0.26, 0.5, { at: [s * span * 0.3, y - 0.16, z], color: paint }, 0);
    P.box(0.06, 0.2, 0.5, { at: [s * span * 0.45, y - 0.13, z], color: paint }, 0);
  });
}

/** Wheels on legs: `at` is [x, z] of each on the left, mirrored. `floor` is where the tyres rest. */
function gear(P: Parts, at: Plan, floor: number, top: number, r = 0.3): void {
  for (const [x, z] of at) {
    P.both((s) => {
      if (x === 0 && s < 0) return;
      P.cyl(r, 0.2, 'x', { at: [s * x, floor + r, z], color: RUBBER }, 8, 1);
      P.box(
        0.07,
        top - floor - r,
        0.07,
        { at: [s * x, (top + floor + r) / 2, z], color: STEEL },
        0,
      );
    });
  }
}

/** Rotor blades: a worn grey-green, not black, or they are all the eye sees of the machine. */
const BLADE = 0x363a38;

// ---------------------------------------------------------------------------------------
// Gunships
// ---------------------------------------------------------------------------------------

/** The alliance's gunship: a narrow tandem two-seater, engines out on its shoulders, four blades. */
export function gunshipAlliance(): VehicleModel {
  const f = 1;
  const paint = under(0x4b5140, f);
  const dark = under(0x363b30, f);
  const glass = under(GLASS, f);
  const blade = under(BLADE, f);
  return aircraft((lod, B, T) => {
    B.fuselage(
      [
        { z: 5.6, w: 0.16, h: 0.2, y: -0.35 },
        { z: 5.0, w: 0.42, h: 0.5, y: -0.2 },
        { z: 3.4, w: 0.55, h: 0.78, y: 0 },
        { z: 1.6, w: 0.6, h: 0.95, y: 0.1 },
        { z: -0.4, w: 0.6, h: 0.9, y: 0.1 },
        { z: -2.0, w: 0.42, h: 0.6, y: 0.2 },
      ],
      { seg: 10, square: 3.4, color: paint, team: 0.06 },
    );
    // Two cockpits, the rear one a step higher, in flat panes.
    B.prism(
      [
        [4.7, 0.1],
        [3.9, 0.82],
        [3.0, 0.9],
        [2.7, 1.25],
        [1.5, 1.3],
        [1.1, 0.7],
      ],
      [0.3, 0.36, 0.38, 0.4, 0.4, 0.42],
      { color: glass },
    );
    B.box(0.5, 0.5, 0.5, { at: [0, -0.5, 5.2], color: dark }, 1); // sight turret
    B.cyl(0.045, 1.3, 'z', { at: [0, -0.95, 4.1], color: STEEL }, 6, 1); // chin gun
    B.box(0.2, 0.25, 0.5, { at: [0, -0.82, 3.6], color: STEEL }, 0);
    // Engines either side under the rotor, exhausts turned out.
    B.both((s) => {
      B.fuselage(
        [
          { z: 1.7, w: 0.22, h: 0.24 },
          { z: 1.2, w: 0.34, h: 0.36 },
          { z: -0.8, w: 0.36, h: 0.36 },
          { z: -1.5, w: 0.28, h: 0.3 },
        ].map((st) => ({ ...st, x: s * 0.92, y: 0.5 })),
        { seg: 8, square: 3, color: paint },
        1,
      );
      B.box(0.3, 0.4, 0.5, { at: [s * 1.02, 0.5, -1.6], color: dark }, 0);
    });
    B.box(0.8, 0.5, 2.0, { at: [0, 1.15, 0.2], top: [0.7, 0.8], color: paint }, 1); // gearbox hump
    B.cyl(0.11, 0.7, 'y', { at: [0, 1.7, 0.3], color: STEEL }, 6, 1);
    stores(B, 4.9, -0.1, 0.9, paint, dark);
    gear(B, [[1.1, 2.4]], -1.75, -0.4, 0.34);
    // The boom, the swept fin, the tailplane low on it, a wheel under the end.
    T.fuselage(
      [
        { z: -1.9, w: 0.42, h: 0.6, y: 0.2 },
        { z: -4.5, w: 0.26, h: 0.36, y: 0.35 },
        { z: -8.0, w: 0.14, h: 0.2, y: 0.5 },
      ],
      { seg: 8, square: 3, color: paint, team: 0.06 },
    );
    T.box(0.3, 0.3, 1.0, { at: [0, 0.4, -6.2], team: 1 }, 1);
    fin(
      T,
      [
        [-7.2, 0.4],
        [-8.0, 0.4],
        [-9.2, 2.6],
        [-8.5, 2.6],
      ],
      0.14,
      0,
      { color: paint },
    );
    T.box(3.0, 0.08, 0.8, { at: [0, 0.35, -8.3], color: paint });
    T.cyl(0.2, 0.14, 'x', { at: [0, -1.55, -8.0], color: RUBBER }, 7, 1);
    T.box(0.07, 1.7, 0.07, { at: [0, -0.6, -8.0], color: STEEL }, 0);
    return {
      rotors: [
        { x: 0, y: 2.05, z: 0.3, axis: 'y', rate: 19, shape: 0, r: 7.3 },
        { x: 0.3, y: 2.3, z: -8.9, axis: 'x', rate: 37, shape: 1, r: 1.4 },
      ],
      shapes: [rotorShape(lod, 4, 7.3, 0.5, blade), fanShape(lod, 'x', 4, 1.4, 0.24, blade)],
      muzzleY: -0.95,
      muzzleZ: 4.8,
    };
  });
}

/** Russia's gunship: two rotors one above the other, no tail rotor, a fat nose for two abreast. */
export function gunshipRussia(): VehicleModel {
  const f = 2;
  const paint = under(0x4a5340, f);
  const dark = under(0x343a2e, f);
  const glass = under(GLASS, f);
  const blade = under(BLADE, f);
  return aircraft((lod, B, T) => {
    B.fuselage(
      [
        { z: 5.4, w: 0.3, h: 0.3, y: -0.5 },
        { z: 4.6, w: 0.85, h: 0.7, y: -0.2 },
        { z: 3.0, w: 1.02, h: 1.0, y: 0 },
        { z: 0.5, w: 1.0, h: 1.05, y: 0.05 },
        { z: -2.0, w: 0.8, h: 0.9, y: 0.15 },
        { z: -3.4, w: 0.5, h: 0.6, y: 0.3 },
      ],
      { seg: 10, square: 3.2, color: paint, team: 0.06 },
    );
    // One wide flat-paned cockpit.
    B.prism(
      [
        [4.6, 0.25],
        [3.8, 1.05],
        [2.6, 1.2],
        [2.0, 0.8],
      ],
      [0.62, 0.78, 0.8, 0.82],
      { color: glass },
    );
    B.cyl(0.3, 0.4, 'y', { at: [0, -0.95, 4.2], color: dark }, 8, 1); // sight ball under the nose
    B.cyl(0.05, 1.6, 'z', { at: [-1.05, -0.5, 3.0], color: STEEL }, 6, 1); // cannon on the right cheek
    B.box(0.25, 0.35, 0.9, { at: [-1.02, -0.5, 2.1], color: dark }, 0);
    // Engines high on each side behind the cockpit, and the tall mast for two rotors.
    B.both((s) => {
      B.fuselage(
        [
          { z: 2.0, w: 0.3, h: 0.3 },
          { z: 1.5, w: 0.42, h: 0.42 },
          { z: -1.0, w: 0.44, h: 0.42 },
          { z: -1.9, w: 0.32, h: 0.34 },
        ].map((st) => ({ ...st, x: s * 1.05, y: 0.95 })),
        { seg: 8, square: 3, color: paint },
        1,
      );
    });
    B.box(0.9, 0.5, 1.8, { at: [0, 1.25, 0.2], top: [0.6, 0.7], color: paint }, 1);
    B.cyl(0.14, 2.0, 'y', { at: [0, 2.3, 0.2], color: STEEL }, 6, 1);
    stores(B, 6.2, -0.05, 0.4, paint, dark);
    gear(
      B,
      [
        [1.2, -0.6],
        [0, 3.6],
      ],
      -1.95,
      -0.6,
      0.32,
    );
    // A short tail: one big fin, a tailplane with a fin on each tip.
    T.fuselage(
      [
        { z: -3.3, w: 0.5, h: 0.6, y: 0.3 },
        { z: -5.2, w: 0.3, h: 0.5, y: 0.5 },
        { z: -6.9, w: 0.16, h: 0.36, y: 0.7 },
      ],
      { seg: 8, square: 3, color: paint, team: 0.06 },
    );
    fin(
      T,
      [
        [-5.2, 0.7],
        [-7.0, 0.6],
        [-7.5, 2.9],
        [-6.5, 2.9],
      ],
      0.16,
      0,
      { color: paint },
    );
    T.box(0.18, 0.6, 1.0, { at: [0, 2.3, -7.0], team: 1 }, 1);
    T.box(3.6, 0.09, 0.9, { at: [0, 0.75, -5.6], color: paint });
    T.both((s) => T.box(0.08, 1.1, 0.9, { at: [s * 1.8, 0.85, -5.7], color: paint }, 1));
    return {
      rotors: [
        { x: 0, y: 2.25, z: 0.2, axis: 'y', rate: 17, shape: 0, r: 7.2 },
        { x: 0, y: 3.3, z: 0.2, axis: 'y', rate: -17, shape: 0, r: 7.2 },
      ],
      shapes: [rotorShape(lod, 3, 7.2, 0.52, blade)],
      muzzleY: -0.5,
      muzzleZ: 3.8,
    };
  });
}

/** China's gunship: slim and faceted, five blades, the tail rotor a fan inside the fin. */
export function gunshipChina(): VehicleModel {
  const f = 3;
  const paint = under(0x474d4a, f);
  const dark = under(0x30343a, f);
  const glass = under(GLASS, f);
  const blade = under(BLADE, f);
  return aircraft((lod, B, T) => {
    // A diamond section: flat panels meeting at a ridge along each side.
    B.fuselage(
      [
        { z: 5.9, w: 0.12, h: 0.14, y: -0.3 },
        { z: 4.8, w: 0.42, h: 0.42, y: -0.15 },
        { z: 3.0, w: 0.62, h: 0.75, y: 0 },
        { z: 0.8, w: 0.7, h: 0.92, y: 0.1 },
        { z: -1.2, w: 0.62, h: 0.85, y: 0.1 },
        { z: -2.6, w: 0.4, h: 0.55, y: 0.2 },
      ],
      { seg: 8, square: 1.6, color: paint, team: 0.06 },
    );
    B.prism(
      [
        [4.6, 0.05],
        [3.8, 0.72],
        [3.0, 0.8],
        [2.7, 1.12],
        [1.6, 1.18],
        [1.2, 0.6],
      ],
      [0.26, 0.32, 0.34, 0.36, 0.36, 0.38],
      { color: glass },
    );
    B.cyl(0.24, 0.3, 'y', { at: [0, -0.62, 5.1], color: dark }, 8, 1);
    B.cyl(0.045, 1.2, 'z', { at: [0, -0.9, 4.0], color: STEEL }, 6, 1);
    B.box(0.2, 0.22, 0.5, { at: [0, -0.8, 3.5], color: STEEL }, 0);
    // The engines are buried in one long hump behind the rotor, exhausts up and back.
    B.prism(
      [
        [1.6, 0.9],
        [1.0, 1.5],
        [-1.6, 1.5],
        [-2.8, 0.7],
        [-2.4, 0.6],
      ],
      [0.4, 0.62, 0.66, 0.4, 0.4],
      { color: paint },
      1,
    );
    B.both((s) => B.box(0.3, 0.26, 0.6, { at: [s * 0.5, 1.5, -1.5], color: dark }, 0));
    B.cyl(0.11, 0.6, 'y', { at: [0, 1.8, 0.2], color: STEEL }, 6, 1);
    // Stub wings that droop to their tips.
    wings(
      B,
      [
        [1.3, 0.5],
        [1.0, 2.3],
        [0.3, 2.3],
        [0.1, 0.5],
      ],
      0.12,
      -0.1,
      { color: paint, team: 0.25 },
      1,
      -0.14,
    );
    B.both((s) => {
      B.cyl(0.2, 1.6, 'z', { at: [s * 1.4, -0.62, 0.7], color: dark }, 8, 1);
      B.box(0.46, 0.2, 1.4, { at: [s * 2.1, -0.7, 0.7], color: dark }, 1);
    });
    gear(B, [[1.0, 2.2]], -1.7, -0.4, 0.32);
    T.fuselage(
      [
        { z: -2.5, w: 0.4, h: 0.55, y: 0.2 },
        { z: -5.0, w: 0.24, h: 0.34, y: 0.4 },
        { z: -7.2, w: 0.16, h: 0.3, y: 0.6 },
      ],
      { seg: 8, square: 1.8, color: paint, team: 0.06 },
    );
    T.box(0.28, 0.3, 1.0, { at: [0, 0.42, -5.6], team: 1 }, 1);
    // The fin is a ring round the fan, with a blade of fin above it.
    T.cyl(1.0, 0.36, 'x', { at: [0, 0.9, -8.0], color: paint }, 12);
    T.cyl(0.78, 0.38, 'x', { at: [0, 0.9, -8.0], color: dark }, 12, 1);
    fin(
      T,
      [
        [-7.4, 1.6],
        [-8.5, 1.7],
        [-9.2, 3.0],
        [-8.6, 3.0],
      ],
      0.14,
      0,
      { color: paint },
    );
    T.box(2.6, 0.08, 0.7, { at: [0, 0.6, -6.7], color: paint });
    T.cyl(0.2, 0.14, 'x', { at: [0, -1.5, -7.0], color: RUBBER }, 7, 1);
    T.box(0.07, 1.8, 0.07, { at: [0, -0.55, -7.0], color: STEEL }, 0);
    return {
      rotors: [
        { x: 0, y: 2.1, z: 0.2, axis: 'y', rate: 19, shape: 0, r: 6.5 },
        { x: 0.2, y: 0.9, z: -8.0, axis: 'x', rate: 41, shape: 1, r: 0.74 },
      ],
      shapes: [rotorShape(lod, 5, 6.5, 0.4, blade), fanShape(lod, 'x', 8, 0.74, 0.18, blade)],
      muzzleY: -0.9,
      muzzleZ: 4.6,
    };
  });
}

// ---------------------------------------------------------------------------------------
// Transport helicopters
// ---------------------------------------------------------------------------------------

/** The alliance's lifter: a long box with a rotor on a pylon at each end. */
export function liftAlliance(): VehicleModel {
  const f = 1;
  const paint = under(0x4b5140, f);
  const dark = under(0x363b30, f);
  const glass = under(GLASS, f);
  const blade = under(BLADE, f);
  return aircraft((lod, B, T) => {
    B.fuselage(
      [
        { z: 7.4, w: 0.6, h: 0.6, y: -0.2 },
        { z: 6.6, w: 1.15, h: 1.05, y: 0 },
        { z: 4.5, w: 1.25, h: 1.25, y: 0.05 },
        { z: -3.5, w: 1.25, h: 1.25, y: 0.05 },
        { z: -6.4, w: 1.15, h: 1.0, y: 0.45 },
      ],
      { seg: 10, square: 4.5, color: paint, team: 0.06 },
    );
    B.prism(
      [
        [7.3, 0],
        [6.9, 0.95],
        [5.6, 1.15],
        [5.4, 0.2],
      ],
      [0.5, 0.95, 1.05, 1.1],
      { color: glass },
    );
    // Fuel in a long blister low on each side, with the wheels under them.
    B.both((s) =>
      B.fuselage(
        [
          { z: 4.6, w: 0.2, h: 0.3 },
          { z: 3.8, w: 0.42, h: 0.5 },
          { z: -3.4, w: 0.42, h: 0.5 },
          { z: -4.4, w: 0.2, h: 0.3 },
        ].map((st) => ({ ...st, x: s * 1.42, y: -0.75 })),
        { seg: 8, square: 3.5, color: paint },
        1,
      ),
    );
    gear(
      B,
      [
        [1.45, 3.4],
        [1.45, -3.2],
      ],
      -2.0,
      -1.1,
      0.36,
    );
    B.both((s) => B.box(0.04, 0.5, 0.5, { at: [s * 1.26, 0.4, 1.5], color: glass }, 0));
    B.box(2.56, 0.5, 1.4, { at: [0, 0.2, -1.5], team: 1 }, 1); // the army's band round the cabin
    // The front rotor on a low pylon over the cockpit.
    B.prism(
      [
        [6.4, 1.1],
        [5.7, 2.0],
        [4.2, 2.0],
        [3.4, 1.25],
      ],
      [0.5, 0.42, 0.42, 0.5],
      { color: paint },
    );
    B.cyl(0.12, 0.5, 'y', { at: [0, 2.2, 5.0], color: STEEL }, 6, 1);
    // The rear pylon is tall, with an engine on each side of its foot.
    T.prism(
      [
        [-3.2, 1.25],
        [-4.2, 3.2],
        [-6.4, 3.3],
        [-6.9, 1.3],
      ],
      [0.6, 0.4, 0.4, 0.55],
      { color: paint, team: 0.06 },
    );
    T.both((s) => {
      T.cyl(0.36, 1.8, 'z', { at: [s * 1.0, 1.45, -5.2], color: paint }, 8, 1);
      T.cyl(0.28, 0.3, 'z', { at: [s * 1.0, 1.45, -6.2], color: dark }, 8, 0);
    });
    T.cyl(0.12, 0.5, 'y', { at: [0, 3.5, -5.3], color: STEEL }, 6, 1);
    T.box(2.3, 0.1, 1.6, { at: [0, -0.6, -7.0], rot: [-0.5, 0, 0], color: dark }, 1); // ramp
    return {
      rotors: [
        { x: 0, y: 2.5, z: 5.0, axis: 'y', rate: 15, shape: 0, r: 8.6 },
        { x: 0, y: 3.8, z: -5.3, axis: 'y', rate: -15, shape: 0, r: 8.6 },
      ],
      shapes: [rotorShape(lod, 3, 8.6, 0.7, blade)],
      muzzleY: -2.2,
      muzzleZ: 2.5,
    };
  });
}

/** Russia's lifter: a round glazed nose, engines over the cabin, five blades, drums of fuel on its sides. */
export function liftRussia(): VehicleModel {
  const f = 2;
  const paint = under(0x4a5340, f);
  const dark = under(0x343a2e, f);
  const glass = under(GLASS, f);
  const blade = under(BLADE, f);
  return aircraft((lod, B, T) => {
    B.fuselage(
      [
        { z: 5.2, w: 0.55, h: 0.6, y: -0.25, color: glass },
        { z: 4.6, w: 1.0, h: 1.0, y: -0.05, color: glass },
        { z: 3.5, w: 1.22, h: 1.2, y: 0 },
        { z: -2.2, w: 1.22, h: 1.2, y: 0 },
        { z: -4.2, w: 0.7, h: 0.8, y: 0.45 },
      ],
      { seg: 12, square: 2.6, color: paint, team: 0.06 },
    );
    B.both((s) => {
      // The long drum of fuel along each side, and round windows above it.
      B.cyl(0.36, 3.6, 'z', { at: [s * 1.45, -0.55, 0.2], color: paint }, 8, 1);
      for (const z of [2.0, 0.8, -0.4])
        B.cyl(0.22, 0.05, 'x', { at: [s * 1.2, 0.35, z], color: glass }, 8, 0);
    });
    B.box(2.5, 0.5, 1.2, { at: [0, 0.1, -1.6], team: 1 }, 1);
    // The engines sit side by side over the cockpit, the gearbox behind them.
    B.fuselage(
      [
        { z: 4.0, w: 0.5, h: 0.3, y: 1.3 },
        { z: 3.2, w: 0.8, h: 0.45, y: 1.45 },
        { z: -0.6, w: 0.75, h: 0.5, y: 1.5 },
        { z: -2.2, w: 0.4, h: 0.3, y: 1.3 },
      ],
      { seg: 8, square: 3.5, color: paint },
    );
    B.both((s) => B.cyl(0.2, 0.3, 'x', { at: [s * 0.85, 1.5, 1.0], color: dark }, 7, 0));
    B.cyl(0.13, 0.6, 'y', { at: [0, 2.2, 0.6], color: STEEL }, 6, 1);
    gear(
      B,
      [
        [1.9, -0.6],
        [0, 3.9],
      ],
      -2.0,
      -0.9,
      0.38,
    );
    B.both((s) =>
      B.box(0.07, 0.07, 1.4, { at: [s * 1.6, -1.1, -0.2], rot: [0.5, 0, 0], color: STEEL }, 0),
    );
    // The boom comes off the top of the cabin and rises to the tail rotor.
    T.fuselage(
      [
        { z: -4.0, w: 0.7, h: 0.8, y: 0.45 },
        { z: -6.5, w: 0.3, h: 0.36, y: 0.9 },
        { z: -10.0, w: 0.18, h: 0.22, y: 1.1 },
      ],
      { seg: 8, color: paint, team: 0.06 },
    );
    fin(
      T,
      [
        [-9.4, 1.0],
        [-10.2, 1.0],
        [-11.4, 3.1],
        [-10.8, 3.1],
      ],
      0.18,
      0,
      { color: paint },
    );
    T.box(0.3, 0.3, 1.1, { at: [0, 1.0, -8.0], team: 1 }, 1);
    T.box(2.6, 0.08, 0.7, { at: [0, 1.0, -9.6], color: paint });
    return {
      rotors: [
        { x: 0, y: 2.55, z: 0.6, axis: 'y', rate: 15, shape: 0, r: 10.2 },
        { x: -0.35, y: 3.0, z: -11.1, axis: 'x', rate: 33, shape: 1, r: 1.9 },
      ],
      shapes: [rotorShape(lod, 5, 10.2, 0.52, blade), fanShape(lod, 'x', 3, 1.9, 0.3, blade)],
      muzzleY: -2.2,
      muzzleZ: 2.0,
    };
  });
}

/** China's lifter: a long low cabin, engines in pods above it, a big tailplane and a tail wheel. */
export function liftChina(): VehicleModel {
  const f = 3;
  const paint = under(0x474d4a, f);
  const dark = under(0x30343a, f);
  const glass = under(GLASS, f);
  const blade = under(BLADE, f);
  return aircraft((lod, B, T) => {
    B.fuselage(
      [
        { z: 6.0, w: 0.35, h: 0.35, y: -0.45 },
        { z: 5.2, w: 0.95, h: 0.75, y: -0.2 },
        { z: 3.6, w: 1.15, h: 0.95, y: 0 },
        { z: -1.6, w: 1.15, h: 0.95, y: 0 },
        { z: -3.6, w: 0.6, h: 0.65, y: 0.3 },
      ],
      { seg: 10, square: 4, color: paint, team: 0.06 },
    );
    B.prism(
      [
        [5.6, -0.1],
        [4.9, 0.7],
        [3.7, 0.95],
        [3.4, 0.1],
      ],
      [0.6, 0.9, 1.0, 1.05],
      { color: glass },
    );
    B.both((s) => {
      B.box(0.04, 0.6, 1.6, { at: [s * 1.16, 0.15, 0.6], color: dark }, 1); // the sliding door
      B.fuselage(
        [
          { z: 2.6, w: 0.26, h: 0.28 },
          { z: 2.0, w: 0.4, h: 0.4 },
          { z: -0.4, w: 0.4, h: 0.4 },
          { z: -1.4, w: 0.28, h: 0.3 },
        ].map((st) => ({ ...st, x: s * 0.62, y: 1.25 })),
        { seg: 8, square: 3, color: paint },
        1,
      );
    });
    B.box(2.34, 0.4, 1.0, { at: [0, 0.1, -1.6], team: 1 }, 1);
    B.box(0.7, 0.5, 1.8, { at: [0, 1.5, 0.4], top: [0.7, 0.7], color: paint }, 1);
    B.cyl(0.12, 0.5, 'y', { at: [0, 1.95, 0.5], color: STEEL }, 6, 1);
    gear(B, [[1.35, 2.6]], -1.7, -0.7, 0.36);
    T.fuselage(
      [
        { z: -3.4, w: 0.6, h: 0.65, y: 0.3 },
        { z: -6.0, w: 0.3, h: 0.4, y: 0.5 },
        { z: -9.0, w: 0.2, h: 0.3, y: 0.7 },
      ],
      { seg: 8, square: 3, color: paint, team: 0.06 },
    );
    // The fin leans back and the tail rotor is tilted with it; one wide slab of tailplane.
    fin(
      T,
      [
        [-8.4, 0.7],
        [-9.3, 0.7],
        [-10.6, 3.0],
        [-10.0, 3.0],
      ],
      0.18,
      0,
      { color: paint },
    );
    T.box(0.3, 0.32, 1.1, { at: [0, 0.55, -7.0], team: 1 }, 1);
    T.box(4.2, 0.1, 1.1, { at: [0, 0.75, -9.4], color: paint });
    T.cyl(0.22, 0.16, 'x', { at: [0, -1.48, -7.6], color: RUBBER }, 7, 1);
    T.box(0.07, 1.9, 0.07, { at: [0, -0.5, -7.6], color: STEEL }, 0);
    return {
      rotors: [
        { x: 0, y: 2.25, z: 0.5, axis: 'y', rate: 17, shape: 0, r: 8.2 },
        { x: 0.35, y: 2.9, z: -10.4, axis: 'x', rate: 35, shape: 1, r: 1.6 },
      ],
      shapes: [rotorShape(lod, 5, 8.2, 0.5, blade), fanShape(lod, 'x', 4, 1.6, 0.26, blade)],
      muzzleY: -1.9,
      muzzleZ: 2.0,
    };
  });
}

// ---------------------------------------------------------------------------------------
// Strike jets
// ---------------------------------------------------------------------------------------

function exhaust(P: Parts, x: number, y: number, z: number, r: number, f: number): void {
  P.cyl(r, 0.7, 'z', { at: [x, y, z], color: under(0x2a2b2c, f) }, 10, 1, r * 0.8);
}

function load(P: Parts, at: readonly number[], y: number, z: number, f: number): void {
  for (const x of at)
    P.both((s) => {
      P.cyl(0.2, 2.4, 'z', { at: [s * x, y - 0.32, z], color: under(0x4b5141, f) }, 7, 1);
      P.box(0.07, 0.3, 0.8, { at: [s * x, y - 0.12, z], color: under(0x4a4f54, f) }, 0);
    });
}

/** The alliance's jet: one engine, a chined nose, cropped wings and two fins leaning out. */
export function jetAlliance(): VehicleModel {
  const f = 1;
  const grey = under(0x6a7076, f);
  const dark = under(0x4a4f54, f);
  return aircraft((_lod, B) => {
    B.fuselage(
      [
        { z: 8.2, w: 0.1, h: 0.1, y: -0.1 },
        { z: 6.6, w: 0.62, h: 0.42, y: 0 },
        { z: 4.0, w: 1.15, h: 0.7, y: 0.05 },
        { z: 0.5, w: 1.5, h: 0.8, y: 0 },
        { z: -4.0, w: 1.2, h: 0.75, y: 0 },
        { z: -6.6, w: 0.7, h: 0.62, y: 0.05 },
      ],
      { seg: 10, square: 3, color: grey },
    );
    B.fuselage(
      [
        { z: 6.4, w: 0.2, h: 0.1, y: 0.4 },
        { z: 5.4, w: 0.42, h: 0.36, y: 0.62 },
        { z: 4.2, w: 0.44, h: 0.34, y: 0.72 },
        { z: 3.2, w: 0.3, h: 0.14, y: 0.7 },
      ],
      { seg: 8, color: under(GLASS, f) },
    );
    B.both((s) =>
      B.box(0.5, 0.7, 1.4, { at: [s * 1.25, -0.15, 3.0], top: [0.8, 0.9], color: dark }, 1),
    );
    wings(
      B,
      [
        [2.2, 1.2],
        [-1.6, 5.3],
        [-3.0, 5.3],
        [-3.6, 1.2],
      ],
      0.16,
      0,
      { color: grey },
    );
    wings(
      B,
      [
        [-4.6, 1.0],
        [-6.6, 3.3],
        [-7.6, 3.3],
        [-7.0, 1.0],
      ],
      0.12,
      0,
      { color: grey },
    );
    B.both((s) => {
      fin(
        B,
        [
          [-3.4, 0.6],
          [-6.4, 0.6],
          [-7.4, 2.9],
          [-6.2, 2.9],
        ],
        0.12,
        s * 0.95,
        { color: grey },
        2,
        s * 0.42,
        0.6,
      );
      fin(
        B,
        [
          [-6.0, 2.1],
          [-7.05, 2.1],
          [-7.38, 2.86],
          [-6.25, 2.86],
        ],
        0.14,
        s * 0.95,
        { team: 1 },
        1,
        s * 0.42,
        0.6,
      );
    });
    exhaust(B, 0, 0.05, -6.9, 0.58, f);
    load(B, [2.4, 3.6], -0.1, -0.6, f);
    return {};
  });
}

/** Russia's jet: built to work low over the front. Straight wings with pods on the tips, an engine along each side, one tall fin. */
export function jetRussia(): VehicleModel {
  const f = 2;
  const grey = under(0x5f6b62, f);
  const dark = under(0x444c47, f);
  return aircraft((_lod, B) => {
    B.fuselage(
      [
        { z: 7.4, w: 0.25, h: 0.3, y: -0.2 },
        { z: 6.2, w: 0.62, h: 0.7, y: 0 },
        { z: 3.5, w: 0.8, h: 0.95, y: 0.1 },
        { z: -2.0, w: 0.7, h: 0.85, y: 0.1 },
        { z: -7.2, w: 0.25, h: 0.4, y: 0.3 },
      ],
      { seg: 10, square: 2.8, color: grey },
    );
    B.fuselage(
      [
        { z: 6.0, w: 0.2, h: 0.1, y: 0.6 },
        { z: 5.2, w: 0.4, h: 0.4, y: 0.85 },
        { z: 4.2, w: 0.42, h: 0.34, y: 0.95 },
        { z: 3.4, w: 0.3, h: 0.14, y: 0.95 },
      ],
      { seg: 8, color: under(GLASS, f) },
    );
    B.both((s) => {
      // The engines lie along the fuselage under the wing roots.
      B.fuselage(
        [
          { z: 3.4, w: 0.44, h: 0.46 },
          { z: 2.4, w: 0.52, h: 0.54 },
          { z: -3.0, w: 0.5, h: 0.52 },
          { z: -4.2, w: 0.4, h: 0.42 },
        ].map((st) => ({ ...st, x: s * 1.15, y: -0.25 })),
        { seg: 8, color: grey },
      );
      exhaust(B, s * 1.15, -0.25, -4.4, 0.38, f);
      // The long pod on each wingtip that opens as an airbrake.
      B.fuselage(
        [
          { z: 1.2, w: 0.1, h: 0.1 },
          { z: 0.4, w: 0.24, h: 0.22 },
          { z: -1.6, w: 0.24, h: 0.22 },
          { z: -2.2, w: 0.1, h: 0.1 },
        ].map((st) => ({ ...st, x: s * 7.0, y: 0.35 })),
        { seg: 6, color: dark },
        1,
      );
    });
    wings(
      B,
      [
        [1.9, 0.9],
        [0.4, 7.0],
        [-1.5, 7.0],
        [-1.9, 0.9],
      ],
      0.2,
      0.35,
      { color: grey },
    );
    wings(
      B,
      [
        [-5.5, 0.3],
        [-6.2, 2.9],
        [-7.2, 2.9],
        [-7.3, 0.3],
      ],
      0.12,
      0.6,
      { color: grey },
      2,
      0.1,
    );
    fin(
      B,
      [
        [-4.2, 0.7],
        [-7.3, 0.6],
        [-7.9, 3.6],
        [-6.9, 3.6],
      ],
      0.16,
      0,
      { color: grey },
    );
    fin(
      B,
      [
        [-6.55, 2.7],
        [-7.72, 2.7],
        [-7.88, 3.55],
        [-6.92, 3.55],
      ],
      0.18,
      0,
      { team: 1 },
      1,
    );
    load(B, [2.2, 3.4, 4.6, 5.8], 0.3, 0, f);
    return {};
  });
}

/** China's jet: a delta wing with a small wing ahead of it, the intake under the chin, one fin. */
export function jetChina(): VehicleModel {
  const f = 3;
  const grey = under(0x7b8188, f);
  const dark = under(0x565c63, f);
  return aircraft((_lod, B) => {
    B.fuselage(
      [
        { z: 8.4, w: 0.08, h: 0.08, y: 0.05 },
        { z: 6.6, w: 0.5, h: 0.5, y: 0.1 },
        { z: 4.0, w: 0.75, h: 0.8, y: 0.1 },
        { z: -3.0, w: 0.85, h: 0.85, y: 0.05 },
        { z: -6.8, w: 0.62, h: 0.62, y: 0.1 },
      ],
      { seg: 10, color: grey },
    );
    B.fuselage(
      [
        { z: 6.2, w: 0.2, h: 0.1, y: 0.55 },
        { z: 5.2, w: 0.4, h: 0.4, y: 0.75 },
        { z: 4.0, w: 0.42, h: 0.34, y: 0.85 },
        { z: 3.0, w: 0.3, h: 0.14, y: 0.8 },
      ],
      { seg: 8, color: under(GLASS, f) },
    );
    // The intake: a box under the chin.
    B.prism(
      [
        [5.2, -0.5],
        [5.0, -1.1],
        [1.0, -1.0],
        [0.0, -0.6],
      ],
      [0.5, 0.55, 0.6, 0.5],
      { color: dark },
    );
    wings(
      B,
      [
        [2.2, 0.7],
        [-4.4, 4.7],
        [-5.2, 4.7],
        [-5.4, 0.7],
      ],
      0.16,
      -0.2,
      { color: grey },
    );
    // The foreplanes, just behind and above the cockpit.
    wings(
      B,
      [
        [4.2, 0.7],
        [3.0, 2.4],
        [2.5, 2.4],
        [2.7, 0.7],
      ],
      0.1,
      0.35,
      { color: grey },
      2,
      0.06,
    );
    fin(
      B,
      [
        [-2.6, 0.8],
        [-6.4, 0.7],
        [-7.4, 3.9],
        [-6.3, 3.9],
      ],
      0.16,
      0,
      { color: grey },
    );
    fin(
      B,
      [
        [-5.8, 2.9],
        [-7.1, 2.9],
        [-7.38, 3.85],
        [-6.32, 3.85],
      ],
      0.18,
      0,
      { team: 1 },
      1,
    );
    exhaust(B, 0, 0.1, -7.1, 0.56, f);
    load(B, [1.8, 3.0], -0.25, -2.4, f);
    return {};
  });
}

// ---------------------------------------------------------------------------------------
// Transport planes
// ---------------------------------------------------------------------------------------

/** The alliance's transport: a high straight wing with four propellers, a fat body, a tall fin. */
export function planeAlliance(): VehicleModel {
  const f = 1;
  const grey = under(0x596057, f);
  const dark = under(0x3f443c, f);
  const blade = under(BLADE, f);
  return aircraft((lod, B) => {
    B.fuselage(
      [
        { z: 14.5, w: 0.5, h: 0.6, y: -0.6 },
        { z: 12.5, w: 1.7, h: 1.6, y: -0.1 },
        { z: 9.0, w: 2.15, h: 2.1, y: 0 },
        { z: -5.0, w: 2.15, h: 2.1, y: 0 },
        { z: -10.0, w: 1.2, h: 1.3, y: 1.0 },
        { z: -14.5, w: 0.4, h: 0.6, y: 2.0 },
      ],
      { seg: 12, square: 2.6, color: grey },
    );
    B.prism(
      [
        [13.6, 0.2],
        [12.6, 1.35],
        [11.2, 1.75],
        [11.0, 0.7],
      ],
      [0.9, 1.4, 1.6, 1.7],
      { color: under(GLASS, f) },
    );
    wings(
      B,
      [
        [3.6, 0],
        [2.6, 20],
        [0.2, 20],
        [-1.4, 0],
      ],
      0.5,
      2.1,
      { color: grey },
    );
    B.both((s) => {
      B.box(4.0, 0.52, 4.9, { at: [s * 12.5, 2.1, 1.3], team: 1 }, 1);
      B.fuselage(
        [
          { z: 5.0, w: 0.6, h: 0.9 },
          { z: -5.0, w: 0.6, h: 0.9 },
        ].map((st) => ({ ...st, x: s * 2.3, y: -1.5 })),
        { seg: 6, square: 3, color: grey },
        1,
      ); // wheel fairings
    });
    const rotors: Rotor[] = [];
    for (const x of [-11.2, -5.4, 5.4, 11.2]) {
      B.fuselage(
        [
          { z: 5.6, w: 0.3, h: 0.3 },
          { z: 5.0, w: 0.62, h: 0.62 },
          { z: 1.5, w: 0.6, h: 0.6 },
          { z: -0.5, w: 0.3, h: 0.4 },
        ].map((st) => ({ ...st, x, y: 1.65 })),
        { seg: 8, color: dark },
      );
      rotors.push({ x, y: 1.65, z: 5.75, axis: 'z', rate: x < 0 ? 33 : -33, shape: 0, r: 2.05 });
    }
    fin(
      B,
      [
        [-8.4, 2.4],
        [-14.2, 2.4],
        [-15.0, 9.0],
        [-12.6, 9.0],
      ],
      0.4,
      0,
      { color: grey },
    );
    B.box(0.44, 1.8, 2.6, { at: [0, 7.9, -13.9], team: 1 }, 1);
    wings(
      B,
      [
        [-10.6, 0],
        [-12.2, 7.6],
        [-14.0, 7.6],
        [-14.4, 0],
      ],
      0.3,
      2.6,
      { color: grey },
    );
    return { rotors, shapes: [fanShape(lod, 'z', 4, 2.05, 0.4, blade)] };
  });
}

/** A jet engine in its pod, hung ahead of and under the wing on a pylon. */
function pod(
  P: Parts,
  x: number,
  y: number,
  z: number,
  r: number,
  colour: number,
  f: number,
): void {
  P.fuselage(
    [
      { z: z + 2.2, w: r * 0.9, h: r * 0.9 },
      { z: z + 1.2, w: r, h: r },
      { z: z - 1.4, w: r * 0.9, h: r * 0.9 },
      { z: z - 2.6, w: r * 0.55, h: r * 0.55 },
    ].map((st) => ({ ...st, x, y })),
    { seg: 8, color: colour },
  );
  P.cyl(r * 0.8, 0.1, 'z', { at: [x, y, z + 2.2], color: under(0x202224, f) }, 8, 1);
  P.box(0.2, 0.8, 2.6, { at: [x, y + r + 0.3, z - 0.6], color: colour }, 1);
}

/** Russia's transport: swept wings that droop, four jets on pylons, the tailplane on top of the fin, a glazed nose. */
export function planeRussia(): VehicleModel {
  const f = 2;
  const grey = under(0x6b7078, f);
  const dark = under(0x50555c, f);
  return aircraft((_lod, B) => {
    B.fuselage(
      [
        { z: 17.0, w: 0.7, h: 0.7, y: -0.7, color: under(GLASS, f) },
        { z: 15.4, w: 1.7, h: 1.6, y: -0.2 },
        { z: 11.0, w: 2.3, h: 2.3, y: 0 },
        { z: -6.0, w: 2.3, h: 2.3, y: 0 },
        { z: -12.0, w: 1.3, h: 1.4, y: 1.2 },
        { z: -17.0, w: 0.4, h: 0.6, y: 2.4 },
      ],
      { seg: 12, color: grey },
    );
    B.prism(
      [
        [16.0, 0.4],
        [15.0, 1.45],
        [13.6, 1.9],
        [13.4, 0.9],
      ],
      [0.9, 1.4, 1.6, 1.7],
      { color: under(GLASS, f) },
    );
    wings(
      B,
      [
        [6.5, 0],
        [-5.5, 23],
        [-8.0, 23],
        [-1.0, 0],
      ],
      0.55,
      2.3,
      { color: grey },
      2,
      -0.06,
    );
    B.both((s) => {
      B.box(4.2, 0.57, 3.6, { at: [s * 15.0, 1.4, -2.9], rot: [0, s * 0.42, 0], team: 1 }, 1);
      pod(B, s * 7.5, 0.4, 3.0, 0.85, dark, f);
      pod(B, s * 12.5, 0.1, 0.2, 0.85, dark, f);
      B.fuselage(
        [
          { z: 4.0, w: 0.5, h: 0.9 },
          { z: 2.0, w: 0.8, h: 1.1 },
          { z: -4.0, w: 0.8, h: 1.1 },
          { z: -6.0, w: 0.5, h: 0.9 },
        ].map((st) => ({ ...st, x: s * 2.4, y: -1.6 })),
        { seg: 6, square: 3, color: grey },
        1,
      );
    });
    fin(
      B,
      [
        [-9.0, 2.6],
        [-15.6, 3.0],
        [-18.6, 9.6],
        [-15.0, 9.6],
      ],
      0.5,
      0,
      { color: grey },
    );
    B.box(0.54, 1.6, 3.0, { at: [0, 7.6, -15.9], team: 1 }, 1);
    wings(
      B,
      [
        [-14.6, 0],
        [-18.2, 8.2],
        [-19.8, 8.2],
        [-18.4, 0],
      ],
      0.3,
      9.6,
      { color: grey },
    );
    return {};
  });
}

/** China's transport: the widest body of the three, two very large engines, tips turned up, a T tail. */
export function planeChina(): VehicleModel {
  const f = 3;
  const grey = under(0x5a6068, f);
  const dark = under(0x42474e, f);
  return aircraft((_lod, B) => {
    B.fuselage(
      [
        { z: 16.0, w: 0.6, h: 0.6, y: -0.4 },
        { z: 14.0, w: 2.0, h: 1.7, y: 0 },
        { z: 10.0, w: 2.7, h: 2.4, y: 0.1 },
        { z: -6.0, w: 2.7, h: 2.4, y: 0.1 },
        { z: -11.0, w: 1.5, h: 1.5, y: 1.3 },
        { z: -15.5, w: 0.5, h: 0.7, y: 2.4 },
      ],
      { seg: 12, square: 2.8, color: grey },
    );
    B.prism(
      [
        [15.0, 0.5],
        [13.8, 1.6],
        [12.2, 2.1],
        [12.0, 1.0],
      ],
      [1.0, 1.6, 1.9, 2.0],
      { color: under(GLASS, f) },
    );
    wings(
      B,
      [
        [5.5, 0],
        [-3.5, 21],
        [-6.0, 21],
        [-2.5, 0],
      ],
      0.55,
      2.5,
      { color: grey },
    );
    B.both((s) => {
      // Winglets, in the army's colour.
      fin(
        B,
        [
          [-3.4, 2.6],
          [-6.0, 2.6],
          [-6.8, 5.0],
          [-5.6, 5.0],
        ],
        0.2,
        s * 21,
        { team: 1 },
        2,
        s * 0.3,
        2.6,
      );
      pod(B, s * 8.0, 0.2, 3.2, 1.35, dark, f);
      // The wheels live in a long blister low on each side.
      B.fuselage(
        [
          { z: 5.0, w: 0.5, h: 0.8 },
          { z: 3.0, w: 1.0, h: 1.2 },
          { z: -5.0, w: 1.0, h: 1.2 },
          { z: -7.0, w: 0.5, h: 0.8 },
        ].map((st) => ({ ...st, x: s * 2.7, y: -1.7 })),
        { seg: 6, square: 3, color: grey },
      );
    });
    fin(
      B,
      [
        [-8.4, 2.8],
        [-14.6, 3.2],
        [-17.6, 10.0],
        [-14.2, 10.0],
      ],
      0.5,
      0,
      { color: grey },
    );
    B.box(0.54, 1.6, 3.0, { at: [0, 8.0, -15.0], team: 1 }, 1);
    wings(
      B,
      [
        [-13.8, 0],
        [-17.2, 7.4],
        [-18.6, 7.4],
        [-17.4, 0],
      ],
      0.3,
      10.0,
      { color: grey },
    );
    return {};
  });
}

// ---------------------------------------------------------------------------------------
// Drones
// ---------------------------------------------------------------------------------------

/** The alliance's scout drone: a pod under a straight wing, twin booms back to an upturned-V tail, the propeller behind. */
export function reconAlliance(): VehicleModel {
  const f = 1;
  const grey = under(0x8b908d, f);
  const blade = under(BLADE, f);
  return aircraft((lod, B) => {
    B.fuselage(
      [
        { z: 1.9, w: 0.1, h: 0.12 },
        { z: 1.2, w: 0.3, h: 0.34 },
        { z: -0.6, w: 0.32, h: 0.36 },
        { z: -1.1, w: 0.2, h: 0.24 },
      ],
      { seg: 8, square: 3, color: grey },
    );
    B.cyl(0.2, 0.26, 'y', { at: [0, -0.42, 1.0], color: under(RUBBER, f) }, 8, 1);
    B.box(7.0, 0.07, 0.75, { at: [0, 0.4, 0.1], color: grey });
    B.both((s) => {
      B.box(1.3, 0.075, 0.76, { at: [s * 2.7, 0.4, 0.1], team: 1 }, 1);
      B.box(0.1, 0.1, 3.4, { at: [s * 1.0, 0.3, -1.6], color: grey });
      B.box(0.06, 1.1, 0.5, { at: [s * 0.62, 0.72, -3.1], rot: [0, 0, s * 0.72], color: grey });
    });
    return {
      rotors: [{ x: 0, y: 0, z: -1.25, axis: 'z', rate: 43, shape: 0, r: 0.5 }],
      shapes: [fanShape(lod, 'z', 2, 0.5, 0.12, blade)],
    };
  });
}

/** Russia's scout drone: a boxy body under a high wing, the propeller on the nose, an ordinary tail. */
export function reconRussia(): VehicleModel {
  const f = 2;
  const grey = under(0x8a8f86, f);
  const blade = under(BLADE, f);
  return aircraft((lod, B) => {
    B.fuselage(
      [
        { z: 1.7, w: 0.16, h: 0.18 },
        { z: 1.2, w: 0.28, h: 0.36 },
        { z: -0.2, w: 0.28, h: 0.4 },
        { z: -2.9, w: 0.07, h: 0.1, y: 0.15 },
      ],
      { seg: 8, square: 4, color: grey },
    );
    B.box(0.3, 0.3, 0.4, { at: [0, -0.5, 0.3], color: under(RUBBER, f) }, 1);
    B.box(6.2, 0.07, 0.9, { at: [0, 0.48, 0.3], top: [1, 0.9], color: grey });
    B.both((s) => B.box(1.2, 0.075, 0.91, { at: [s * 2.4, 0.48, 0.3], team: 1 }, 1));
    B.box(2.0, 0.05, 0.5, { at: [0, 0.2, -2.8], color: grey });
    fin(
      B,
      [
        [-2.3, 0.2],
        [-3.0, 0.2],
        [-3.2, 1.0],
        [-2.8, 1.0],
      ],
      0.05,
      0,
      { color: grey },
    );
    return {
      rotors: [{ x: 0, y: 0, z: 1.8, axis: 'z', rate: 43, shape: 0, r: 0.55 }],
      shapes: [fanShape(lod, 'z', 2, 0.55, 0.12, blade)],
    };
  });
}

/** China's scout drone: long thin wings, a bulged nose, a V tail, the propeller behind. */
export function reconChina(): VehicleModel {
  const f = 3;
  const grey = under(0x9a9d9c, f);
  const blade = under(BLADE, f);
  return aircraft((lod, B) => {
    B.fuselage(
      [
        { z: 2.4, w: 0.12, h: 0.14, y: -0.05 },
        { z: 1.7, w: 0.3, h: 0.36, y: 0.08 },
        { z: 0.8, w: 0.24, h: 0.26 },
        { z: -1.6, w: 0.22, h: 0.26 },
        { z: -2.3, w: 0.12, h: 0.14 },
      ],
      { seg: 8, color: grey },
    );
    B.cyl(0.16, 0.22, 'y', { at: [0, -0.32, 1.5], color: under(RUBBER, f) }, 8, 1);
    wings(
      B,
      [
        [0.5, 0],
        [0.1, 4.2],
        [-0.3, 4.2],
        [-0.4, 0],
      ],
      0.07,
      -0.1,
      { color: grey },
    );
    B.both((s) => {
      B.box(1.0, 0.075, 0.5, { at: [s * 3.4, -0.1, -0.05], team: 1 }, 1);
      B.box(0.05, 1.3, 0.5, { at: [s * 0.45, 0.5, -1.9], rot: [0, 0, -s * 0.75], color: grey });
    });
    return {
      rotors: [{ x: 0, y: 0, z: -2.4, axis: 'z', rate: 43, shape: 0, r: 0.5 }],
      shapes: [fanShape(lod, 'z', 3, 0.5, 0.12, blade)],
    };
  });
}

/** The alliance's one-way attack drone: four arms, four rotors, a warhead slung underneath. */
export function strikeAlliance(): VehicleModel {
  const f = 1;
  const black = under(RUBBER, f);
  const blade = under(0x55595a, f);
  return aircraft((lod, B) => {
    B.box(0.5, 0.24, 0.9, { color: black });
    B.cyl(0.18, 1.3, 'z', { at: [0, -0.28, 0.3], color: under(0x4a4f3c, f) }, 8, 2, 0.1);
    B.box(0.22, 0.05, 0.28, { at: [0, 0.15, -0.2], team: 1 });
    B.box(0.16, 0.2, 0.1, { at: [0, 0.05, 0.5], color: under(STEEL, f) }, 0); // camera
    const rotors: Rotor[] = [];
    for (const [x, z] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ]) {
      B.box(0.1, 0.08, 1.7, {
        at: [x * 0.55, 0.04, z * 0.55],
        rot: [0, x * z * 0.785, 0],
        color: black,
      });
      B.cyl(0.1, 0.16, 'y', { at: [x * 1.1, 0.12, z * 1.1], color: black }, 6, 1);
      rotors.push({
        x: x * 1.1,
        y: 0.24,
        z: z * 1.1,
        axis: 'y',
        rate: 47 * x * z,
        shape: 0,
        r: 0.56,
      });
    }
    return { rotors, shapes: [rotorShape(lod, 2, 0.56, 0.1, blade)] };
  });
}

/** Russia's one-way attack drone: a tube with two crosses of wings, one behind the other. */
export function strikeRussia(): VehicleModel {
  const f = 2;
  const grey = under(0x767b78, f);
  const blade = under(BLADE, f);
  return aircraft((lod, B) => {
    B.fuselage(
      [
        { z: 1.5, w: 0.07, h: 0.07 },
        { z: 1.1, w: 0.14, h: 0.14 },
        { z: -1.2, w: 0.14, h: 0.14 },
        { z: -1.5, w: 0.09, h: 0.09 },
      ],
      { seg: 8, color: grey },
    );
    B.cyl(0.11, 0.2, 'z', { at: [0, 0, 1.35], color: under(GLASS, f) }, 8, 1);
    for (const [z, span, team] of [
      [0.35, 2.0, 0],
      [-0.95, 1.2, 1],
    ])
      for (const a of [0.785, -0.785])
        B.box(span, 0.035, 0.3, { at: [0, 0, z], rot: [0, 0, a], color: grey, team: team * 0.9 });
    return {
      rotors: [{ x: 0, y: 0, z: -1.6, axis: 'z', rate: 47, shape: 0, r: 0.3 }],
      shapes: [fanShape(lod, 'z', 2, 0.3, 0.08, blade)],
    };
  });
}

/** China's one-way attack drone: a tube with two pairs of straight wings, one low at the front and one high at the back. */
export function strikeChina(): VehicleModel {
  const f = 3;
  const grey = under(0x82867e, f);
  const blade = under(BLADE, f);
  return aircraft((lod, B) => {
    B.fuselage(
      [
        { z: 1.4, w: 0.08, h: 0.08 },
        { z: 1.0, w: 0.15, h: 0.15 },
        { z: -1.1, w: 0.15, h: 0.15 },
        { z: -1.4, w: 0.1, h: 0.1 },
      ],
      { seg: 8, color: grey },
    );
    B.cyl(0.12, 0.2, 'z', { at: [0, 0, 1.25], color: under(GLASS, f) }, 8, 1);
    B.box(2.2, 0.04, 0.28, { at: [0, -0.14, 0.5], color: grey });
    B.box(2.2, 0.04, 0.28, { at: [0, 0.14, -0.7], color: grey, team: 0.9 });
    B.both((s) =>
      B.box(0.04, 0.4, 0.3, { at: [s * 0.3, 0.12, -1.2], rot: [0, 0, -s * 0.5], color: grey }, 1),
    );
    return {
      rotors: [{ x: 0, y: 0, z: -1.5, axis: 'z', rate: 47, shape: 0, r: 0.3 }],
      shapes: [fanShape(lod, 'z', 2, 0.3, 0.08, blade)],
    };
  });
}

/**
 * A helicopter that came down (drawing only; it stays for the rest of the game). Three ways
 * to lie, each the airframe itself turned over or nose-first into the ground, with the tail
 * snapped off, the rotors gone and bent blades lying alongside. Built from the flying
 * model's own middle level, so the paint and the wear match; the burn material scorches it.
 */
export function buildWrecks(model: VehicleModel): THREE.BufferGeometry[] {
  const { body, tail } = model.wreck!;
  body.computeBoundingBox();
  const wid = (body.boundingBox!.max.x - body.boundingBox!.min.x) / 2;
  const back = body.boundingBox!.min.z;
  const pose = (roll: number, pitch: number, yaw: number, snapTail: boolean) => {
    const parts = [body.clone()];
    const t = tail.clone();
    if (snapTail) {
      // The tail is thrown clear of the fuselage when the boom snaps.
      t.translate(0, 0, -back);
      t.rotateY(0.55);
      t.rotateZ(0.3);
      t.translate(wid * 1.2, 0.05, back * 0.4);
    }
    parts.push(t);
    const blades = mergeGeometries(
      [
        new Parts(1).box(5.8, 0.08, 0.5, { rot: [0.0, 0.3, 0.12], color: BLADE }).done(),
        new Parts(1)
          .box(3.9, 0.08, 0.5, { at: [2.5, 0, -3.0], rot: [0.1, -0.9, 0], color: BLADE })
          .done(),
      ].map((g) => (g.index ? g.toNonIndexed() : g)),
    );
    blades.translate(-wid * 2.2, 0.07, 0.4);
    parts.push(blades);
    const all = mergeGeometries(parts);
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
