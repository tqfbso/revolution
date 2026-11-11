// Procedural unit models. Everything is built from boxes and cylinders at start-up: no
// asset downloads, original designs, and each model comes in three levels of detail.
//
// Conventions: forward is +Z, the model sits on y = 0, 1 unit is about 3.8 m.
// Vertex attributes: `color` is the paint/metal albedo, `teamMask` says how much of the
// per-instance team colour replaces it (0 = none, 1 = recognition panel).
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const PAINT = 0x565c45;
const PAINT_DARK = 0x3f4434;
const RUBBER = 0x17181a;
const STEEL = 0x2b2e2c;
const CLOTH = 0x6a6a4c;
const SKIN = 0x9a7a62;
/**
 * Art direction is grounded realism (docs/DECISIONS.md 011): hulls keep muted service paint
 * and carry the team colour only on small markings. The barely visible tint below just
 * separates two paint batches. Readability at long range is the job of the far LOD and UI.
 */
const TINT = 0.05;

type Vec3 = [number, number, number];

interface Opts {
  at?: Vec3;
  rot?: Vec3;
  color?: number;
  team?: number;
  /** Scale the top face in x/z (boxes only): 1 = straight sides. */
  top?: [number, number];
  /** Slide the top face along z, for sloped fronts. */
  shear?: number;
}

function finish(g: THREE.BufferGeometry, o: Opts): THREE.BufferGeometry {
  const pos = g.getAttribute('position');
  if (o.top || o.shear) {
    g.computeBoundingBox();
    const midY = (g.boundingBox!.max.y + g.boundingBox!.min.y) / 2;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) <= midY) continue;
      pos.setX(i, pos.getX(i) * (o.top?.[0] ?? 1));
      pos.setZ(i, pos.getZ(i) * (o.top?.[1] ?? 1) + (o.shear ?? 0));
    }
  }
  if (o.rot) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...o.rot)));
  if (o.at) g.translate(...o.at);
  g.computeVertexNormals();
  g.deleteAttribute('uv');
  const c = new THREE.Color(o.color ?? PAINT);
  const colors = new Float32Array(pos.count * 3);
  const mask = new Float32Array(pos.count).fill(o.team ?? 0);
  for (let i = 0; i < pos.count; i++) c.toArray(colors, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.setAttribute('teamMask', new THREE.BufferAttribute(mask, 1));
  return g;
}

const box = (w: number, h: number, d: number, o: Opts = {}) =>
  finish(new THREE.BoxGeometry(w, h, d), o);

/** Cylinder whose axis runs along `axis`. */
function cyl(r: number, len: number, axis: 'x' | 'y' | 'z', o: Opts = {}, seg = 10) {
  const g = new THREE.CylinderGeometry(r, r, len, seg);
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  else if (axis === 'z') g.rotateX(Math.PI / 2);
  return finish(g, o);
}

const merge = (parts: THREE.BufferGeometry[]) => mergeGeometries(parts);

export interface VehicleModel {
  hull: THREE.BufferGeometry[]; // LOD 0, 1
  turret: THREE.BufferGeometry[]; // LOD 0, 1
  far: THREE.BufferGeometry; // LOD 2: hull and turret in one tiny mesh
  /** Turret ring position on the hull, and the muzzle relative to the turret pivot. */
  turretY: number;
  turretZ: number;
  muzzleY: number;
  muzzleZ: number;
}
export type TankModel = VehicleModel;

/** Turret ring position on the hull, and the muzzle relative to the turret pivot. */
export const TURRET_Y = 0.7;
export const TURRET_Z = -0.08;
export const MUZZLE_Z = 2.2;
export const MUZZLE_Y = 0.14;

/** A low, wedge-fronted main battle tank: original design, generic present-day shapes. */
export function buildTank(): TankModel {
  const tint = { team: TINT };
  const h: THREE.BufferGeometry[] = [];
  // Hull tub, sponsons with a sloped glacis, engine deck.
  h.push(box(1.02, 0.3, 2.36, { at: [0, 0.37, 0], color: PAINT_DARK, ...tint }));
  h.push(box(1.46, 0.2, 2.5, { at: [0, 0.6, -0.02], top: [0.94, 0.8], shear: -0.14, ...tint }));
  h.push(box(1.0, 0.05, 0.62, { at: [0, 0.715, -0.9], color: PAINT_DARK, ...tint }));
  for (let k = 0; k < 4; k++) {
    h.push(box(0.84, 0.02, 0.07, { at: [0, 0.75, -0.68 - k * 0.14], color: STEEL }));
  }
  h.push(box(0.5, 0.03, 0.34, { at: [0, 0.69, 0.62], rot: [0.5, 0, 0], team: 1 }));
  for (const s of [-1, 1]) {
    // Track run, skirt, fender, wheels.
    h.push(box(0.3, 0.36, 2.56, { at: [s * 0.6, 0.2, 0], color: RUBBER, top: [1, 1.04] }));
    h.push(box(0.05, 0.24, 2.3, { at: [s * 0.755, 0.42, -0.04], ...tint }));
    h.push(box(0.055, 0.1, 0.7, { at: [s * 0.76, 0.46, -0.2], team: 1 }));
    h.push(box(0.36, 0.03, 2.62, { at: [s * 0.6, 0.5, 0], color: PAINT_DARK, ...tint }));
    for (let k = 0; k < 6; k++) {
      h.push(cyl(0.135, 0.07, 'x', { at: [s * 0.74, 0.15, -0.95 + k * 0.38], color: STEEL }));
    }
    h.push(cyl(0.11, 0.07, 'x', { at: [s * 0.74, 0.27, 1.2], color: STEEL }, 8));
    h.push(cyl(0.12, 0.07, 'x', { at: [s * 0.74, 0.27, -1.2], color: STEEL }, 8));
    h.push(box(0.12, 0.06, 0.05, { at: [s * 0.45, 0.6, 1.1], color: 0xd8d2b0 })); // headlight
    h.push(box(0.1, 0.1, 0.3, { at: [s * 0.62, 0.62, -1.02], color: STEEL })); // exhaust
    h.push(cyl(0.11, 0.5, 'x', { at: [s * 0.3, 0.52, -1.33], color: PAINT_DARK, ...tint }, 8));
  }
  h.push(box(0.9, 0.04, 0.04, { at: [0, 0.3, 1.2], color: STEEL })); // tow bar

  const t: THREE.BufferGeometry[] = [];
  // Turret shell, arrow-shaped front armour, bustle with stowage rack.
  t.push(box(1.0, 0.28, 1.1, { at: [0, 0.14, 0], top: [0.82, 0.86], ...tint }));
  for (const s of [-1, 1]) {
    t.push(
      box(0.5, 0.25, 0.5, {
        at: [s * 0.24, 0.13, 0.5],
        rot: [0, s * 0.42, 0],
        top: [0.8, 0.8],
        ...tint,
      }),
    );
    t.push(box(0.1, 0.16, 0.9, { at: [s * 0.53, 0.14, -0.1], color: PAINT_DARK, ...tint }));
    for (let k = 0; k < 3; k++) {
      t.push(
        cyl(
          0.03,
          0.12,
          'z',
          { at: [s * 0.6, 0.12 + k * 0.065, 0.28], rot: [0, s * 0.5, 0], color: STEEL },
          6,
        ),
      );
    }
  }
  t.push(box(0.92, 0.2, 0.5, { at: [0, 0.14, -0.74], color: PAINT_DARK, ...tint }));
  t.push(box(0.98, 0.03, 0.03, { at: [0, 0.26, -1.0], color: STEEL }));
  t.push(box(0.56, 0.02, 0.4, { at: [0, 0.25, -0.74], team: 1 })); // recognition panel
  t.push(box(0.34, 0.22, 0.24, { at: [0, 0.14, 0.72], color: PAINT_DARK, ...tint })); // mantlet
  // Gun: barrel, thermal sleeve, bore evacuator, muzzle.
  t.push(cyl(0.05, 1.5, 'z', { at: [0, MUZZLE_Y, 1.45], color: STEEL }));
  t.push(cyl(0.065, 0.55, 'z', { at: [0, MUZZLE_Y, 1.1], ...tint }));
  t.push(cyl(0.085, 0.24, 'z', { at: [0, MUZZLE_Y, 1.62], ...tint }));
  t.push(cyl(0.062, 0.08, 'z', { at: [0, MUZZLE_Y, MUZZLE_Z - 0.04], color: RUBBER }));
  // Roof: commander's cupola with remote gun, loader's hatch, sight, antenna.
  t.push(cyl(0.17, 0.07, 'y', { at: [-0.24, 0.31, -0.1], color: PAINT_DARK, ...tint }));
  t.push(cyl(0.14, 0.03, 'y', { at: [0.26, 0.29, -0.16], color: PAINT_DARK, ...tint }));
  t.push(box(0.1, 0.1, 0.16, { at: [-0.24, 0.4, -0.1], color: STEEL }));
  t.push(cyl(0.015, 0.42, 'z', { at: [-0.24, 0.41, 0.16], color: RUBBER }, 5));
  t.push(box(0.16, 0.12, 0.14, { at: [0.28, 0.33, 0.28], color: STEEL }));
  t.push(box(0.012, 0.75, 0.012, { at: [0.4, 0.62, -0.9], color: RUBBER }));

  const hull1 = merge([
    box(1.02, 0.3, 2.36, { at: [0, 0.37, 0], color: PAINT_DARK, ...tint }),
    box(1.46, 0.2, 2.5, { at: [0, 0.6, -0.02], top: [0.94, 0.8], shear: -0.14, ...tint }),
    box(0.3, 0.36, 2.56, { at: [-0.6, 0.2, 0], color: RUBBER }),
    box(0.3, 0.36, 2.56, { at: [0.6, 0.2, 0], color: RUBBER }),
    box(0.055, 0.12, 0.8, { at: [-0.76, 0.46, -0.2], team: 1 }),
    box(0.055, 0.12, 0.8, { at: [0.76, 0.46, -0.2], team: 1 }),
  ]);
  const turret1 = merge([
    box(1.0, 0.28, 1.5, { at: [0, 0.14, 0.1], top: [0.82, 0.8], ...tint }),
    box(0.92, 0.2, 0.5, { at: [0, 0.14, -0.74], color: PAINT_DARK, ...tint }),
    box(0.56, 0.02, 0.4, { at: [0, 0.25, -0.74], team: 1 }),
    box(0.1, 0.1, 1.5, { at: [0, MUZZLE_Y, 1.45], color: STEEL }),
  ]);
  // At this distance a tank is a few pixels: silhouette and team colour are all that count.
  const far = merge([
    box(1.46, 0.6, 2.5, { at: [0, 0.3, 0], team: 0.45 }),
    box(0.95, 0.3, 1.3, { at: [0, 0.82, -0.1], team: 0.8 }),
    box(0.12, 0.12, 1.4, { at: [0, 0.84, 1.2], color: STEEL }),
  ]);
  return {
    hull: [merge(h), hull1],
    turret: [merge(t), turret1],
    far,
    turretY: TURRET_Y,
    turretZ: TURRET_Z,
    muzzleY: MUZZLE_Y,
    muzzleZ: MUZZLE_Z,
  };
}

export interface VehicleSpec {
  /** Hull length, width and height (without running gear). */
  len: number;
  wid: number;
  height: number;
  /** Wheels per side; 0 = tracked. */
  wheels: number;
  /** Turret box and where it sits along the hull. */
  turret: { w: number; h: number; d: number; z: number };
  /** Gun barrels on the turret: sideways offset, length, radius, elevation in radians. */
  barrels: { x: number; len: number; r: number; pitch: number }[];
  /** A radar panel on the turret roof. */
  radar?: boolean;
  /** An antenna mast of this height on the turret, with cross-pieces. */
  mast?: number;
}

/**
 * A box-bodied armoured vehicle from a few numbers: sloped nose, wheels or tracks, a turret
 * with its guns. Every vehicle that is not the tank is one of these.
 */
export function buildVehicle(v: VehicleSpec): VehicleModel {
  const tint = { team: TINT };
  const gear = v.wheels > 0 ? 0.42 : 0.34;
  const top = gear + v.height;
  const h: THREE.BufferGeometry[] = [];
  h.push(
    box(v.wid * 0.78, v.height * 0.5, v.len * 0.94, {
      at: [0, gear * 0.6 + v.height * 0.25, 0],
      color: PAINT_DARK,
      ...tint,
    }),
  );
  h.push(
    box(v.wid, v.height * 0.62, v.len, {
      at: [0, top - v.height * 0.31, 0],
      top: [0.86, 0.84],
      shear: -v.len * 0.05,
      ...tint,
    }),
  );
  h.push(box(v.wid * 0.4, 0.02, v.len * 0.13, { at: [0, top + 0.005, -v.len * 0.36], team: 1 }));
  for (const s of [-1, 1]) {
    const x = s * v.wid * 0.5;
    if (v.wheels > 0) {
      for (let k = 0; k < v.wheels; k++) {
        const z = -v.len * 0.36 + (k * v.len * 0.72) / (v.wheels - 1);
        h.push(cyl(0.2, 0.16, 'x', { at: [x - s * 0.06, 0.2, z], color: RUBBER }, 10));
        h.push(cyl(0.09, 0.17, 'x', { at: [x - s * 0.05, 0.2, z], color: STEEL }, 6));
      }
    } else {
      h.push(box(0.28, 0.34, v.len * 1.02, { at: [x - s * 0.1, 0.18, 0], color: RUBBER }));
      for (let k = 0; k < 5; k++) {
        const z = -v.len * 0.4 + k * v.len * 0.2;
        h.push(cyl(0.12, 0.07, 'x', { at: [x + s * 0.045, 0.14, z], color: STEEL }, 8));
      }
    }
    h.push(
      box(0.04, v.height * 0.22, v.len * 0.3, { at: [x * 0.99, top - v.height * 0.3, 0], team: 1 }),
    );
    h.push(
      box(0.1, 0.05, 0.04, { at: [x * 0.7, top - v.height * 0.35, v.len * 0.46], color: 0xd8d2b0 }),
    );
  }
  h.push(
    box(v.wid * 0.6, v.height * 0.5, 0.04, {
      at: [0, gear + v.height * 0.4, -v.len * 0.5],
      color: PAINT_DARK,
    }),
  );

  const tu = v.turret;
  const t: THREE.BufferGeometry[] = [];
  const t1: THREE.BufferGeometry[] = [];
  t.push(box(tu.w, tu.h, tu.d, { at: [0, tu.h / 2, 0], top: [0.8, 0.8], ...tint }));
  t.push(box(tu.w * 0.4, 0.02, tu.d * 0.25, { at: [0, tu.h + 0.005, -tu.d * 0.28], team: 1 }));
  t.push(box(0.12, 0.1, 0.12, { at: [tu.w * 0.25, tu.h + 0.05, 0.05], color: STEEL }));
  t1.push(box(tu.w, tu.h, tu.d, { at: [0, tu.h / 2, 0], top: [0.8, 0.8], team: 0.3 }));
  let muzzleY = tu.h * 0.55;
  let muzzleZ = tu.d / 2;
  for (const b of v.barrels) {
    const cy = tu.h * 0.55 + (Math.sin(b.pitch) * b.len) / 2;
    const cz = tu.d * 0.4 + (Math.cos(b.pitch) * b.len) / 2;
    const o = { at: [b.x, cy, cz] as Vec3, rot: [-b.pitch, 0, 0] as Vec3, color: STEEL };
    t.push(cyl(b.r, b.len, 'z', o, 8));
    t1.push(box(b.r * 2, b.r * 2, b.len, o));
    muzzleY = tu.h * 0.55 + Math.sin(b.pitch) * b.len;
    muzzleZ = tu.d * 0.4 + Math.cos(b.pitch) * b.len;
  }
  if (v.radar) {
    const o = {
      at: [0, tu.h + 0.28, -tu.d * 0.3] as Vec3,
      rot: [-0.3, 0, 0] as Vec3,
      color: PAINT_DARK,
    };
    t.push(box(tu.w * 0.8, 0.42, 0.05, o));
    t1.push(box(tu.w * 0.8, 0.42, 0.05, o));
    t.push(box(0.08, 0.3, 0.08, { at: [0, tu.h + 0.1, -tu.d * 0.3], color: STEEL }));
  }
  if (v.mast) {
    const m = v.mast;
    t.push(box(0.05, m, 0.05, { at: [0, tu.h + m / 2, -tu.d * 0.25], color: STEEL }));
    t1.push(box(0.07, m, 0.07, { at: [0, tu.h + m / 2, -tu.d * 0.25], color: STEEL }));
    for (let k = 0; k < 3; k++) {
      const y = tu.h + m * (0.55 + k * 0.2);
      const o = { at: [0, y, -tu.d * 0.25] as Vec3, rot: [0, k * 1.05, 0] as Vec3, color: RUBBER };
      t.push(box(0.9 - k * 0.2, 0.025, 0.025, o));
      t1.push(box(0.9 - k * 0.2, 0.04, 0.04, o));
    }
    for (const sx of [-1, 1]) {
      t.push(
        cyl(0.012, 1.3, 'y', { at: [sx * tu.w * 0.4, tu.h + 0.65, tu.d * 0.35], color: RUBBER }, 5),
      );
    }
  }
  const hull1 = merge([
    box(v.wid, v.height, v.len, { at: [0, gear + v.height / 2, 0], top: [0.86, 0.84], ...tint }),
    box(v.wid * 0.96, gear, v.len * 0.9, { at: [0, gear / 2, 0], color: RUBBER }),
    box(v.wid * 0.5, 0.02, v.len * 0.2, { at: [0, top + 0.005, -v.len * 0.33], team: 1 }),
  ]);
  const longest = v.barrels.reduce((m, b) => Math.max(m, b.len * Math.cos(b.pitch)), 0);
  const far = merge([
    ...(v.mast
      ? [box(0.12, v.mast, 0.12, { at: [0, top + tu.h + v.mast / 2, tu.z], color: STEEL })]
      : []),
    ...(v.radar
      ? [box(tu.w, 0.4, 0.1, { at: [0, top + tu.h + 0.3, tu.z - tu.d * 0.3], color: PAINT_DARK })]
      : []),
    box(v.wid, top, v.len, { at: [0, top / 2, 0], team: 0.45 }),
    box(tu.w, tu.h + 0.1, tu.d, { at: [0, top + tu.h / 2, tu.z], team: 0.8 }),
    box(0.1, 0.1, longest || 0.1, {
      at: [0, top + tu.h * 0.6, tu.z + tu.d / 2 + longest / 2],
      color: STEEL,
    }),
  ]);
  return {
    hull: [merge(h), hull1],
    turret: [merge(t), merge(t1)],
    far,
    turretY: top,
    turretZ: tu.z,
    muzzleY,
    muzzleZ,
  };
}

/** A tracked gun carriage: a tall slab-sided turret far back, a very long barrel held high. */
export function buildArtillery(): VehicleModel {
  return buildVehicle({
    len: 2.7,
    wid: 1.3,
    height: 0.5,
    wheels: 0,
    turret: { w: 1.05, h: 0.6, d: 1.3, z: -0.45 },
    barrels: [{ x: 0, len: 2.6, r: 0.06, pitch: 0.45 }],
  });
}

/** Tracked, twin cannon pointing at the sky, a radar panel above them. */
export function buildAirDefence(): VehicleModel {
  return buildVehicle({
    len: 2.4,
    wid: 1.25,
    height: 0.45,
    wheels: 0,
    turret: { w: 0.95, h: 0.4, d: 0.95, z: 0 },
    barrels: [
      { x: -0.3, len: 1.25, r: 0.03, pitch: 0.55 },
      { x: 0.3, len: 1.25, r: 0.03, pitch: 0.55 },
    ],
    radar: true,
  });
}

/** A six-wheeled truck with a box body and a mast full of antennas. */
export function buildJammer(): VehicleModel {
  return buildVehicle({
    len: 2.5,
    wid: 1.1,
    height: 0.4,
    wheels: 3,
    turret: { w: 1.0, h: 0.62, d: 1.5, z: -0.35 },
    barrels: [],
    mast: 2.3,
  });
}

const DRONE_GREY = 0x8b908d;

/** A small fixed-wing reconnaissance drone: long straight wing, twin tail, pusher propeller. */
/** Logistics truck: a cab, and a covered load bed where other vehicles carry a turret. */
export function buildTruck(): VehicleModel {
  return buildVehicle({
    len: 3.1,
    wid: 1.15,
    height: 0.42,
    wheels: 3,
    turret: { w: 1.12, h: 0.85, d: 1.9, z: -0.5 },
    barrels: [],
  });
}

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

/** Eight wheels, a boat-shaped hull, a small turret with a long thin autocannon. */
export function buildIfv(): VehicleModel {
  return buildVehicle({
    len: 2.3,
    wid: 1.1,
    height: 0.52,
    wheels: 4,
    turret: { w: 0.6, h: 0.22, d: 0.7, z: 0.15 },
    barrels: [{ x: 0, len: 0.95, r: 0.028, pitch: 0.03 }],
  });
}

export interface InfantryModel {
  soldier: THREE.BufferGeometry[]; // LOD 0, 1: one soldier
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

/** A rifleman in helmet, vest and pack, weapon at the low ready. Taller than scale so he reads. */
export function buildInfantry(): InfantryModel {
  const s: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    s.push(box(0.075, 0.27, 0.09, { at: [side * 0.05, 0.135, 0], color: CLOTH }));
    s.push(box(0.08, 0.05, 0.13, { at: [side * 0.05, 0.025, 0.02], color: RUBBER }));
    s.push(
      box(0.06, 0.2, 0.07, { at: [side * 0.135, 0.38, 0.05], rot: [-0.7, 0, 0], color: CLOTH }),
    );
    s.push(box(0.065, 0.03, 0.065, { at: [side * 0.135, 0.45, 0], team: 1 })); // shoulder patch
  }
  s.push(box(0.21, 0.22, 0.13, { at: [0, 0.38, 0], color: CLOTH }));
  s.push(box(0.23, 0.15, 0.16, { at: [0, 0.37, 0.005], color: 0x494c38 })); // vest
  s.push(box(0.17, 0.17, 0.08, { at: [0, 0.39, -0.11], color: 0x505238 })); // pack
  s.push(box(0.085, 0.09, 0.09, { at: [0, 0.535, 0.005], color: SKIN }));
  s.push(
    box(0.12, 0.065, 0.13, { at: [0, 0.585, 0], top: [0.8, 0.8], color: 0x555a42, team: 0.12 }),
  );
  s.push(box(0.03, 0.045, 0.36, { at: [0.05, 0.34, 0.2], rot: [0.12, 0.15, 0], color: RUBBER }));

  const soldier1 = merge([
    box(0.17, 0.27, 0.1, { at: [0, 0.135, 0], color: CLOTH }),
    box(0.24, 0.23, 0.16, { at: [0, 0.385, 0], color: 0x3a3d2e, team: 0.1 }),
    box(0.12, 0.13, 0.13, { at: [0, 0.56, 0], color: 0x3d4232, team: 0.3 }),
  ]);
  const far = merge(
    SQUAD_OFFSETS.map(([x, z]) =>
      box(0.3, 0.62, 0.3, { at: [x, 0.31, z], color: 0x3a3d2e, team: 0.7 }),
    ),
  );
  return { soldier: [merge(s), soldier1], far };
}

/** Where the two crewmen of a missile team stand, and the launcher between them. */
export const TEAM_OFFSETS: readonly [number, number][] = [
  [-0.4, -0.05],
  [0.42, -0.3],
];

/** An anti-tank missile launcher on its tripod: a fat tube, a sight, three legs. */
export function buildLauncher(): { launcher: THREE.BufferGeometry; far: THREE.BufferGeometry } {
  const g: THREE.BufferGeometry[] = [];
  g.push(cyl(0.075, 0.95, 'z', { at: [0, 0.4, 0.1], rot: [-0.06, 0, 0], color: 0x3c4030 }, 8));
  g.push(cyl(0.09, 0.12, 'z', { at: [0, 0.43, 0.56], color: RUBBER }, 8));
  g.push(box(0.1, 0.12, 0.2, { at: [-0.12, 0.47, 0.0], color: STEEL }));
  g.push(box(0.05, 0.03, 0.05, { at: [-0.12, 0.54, 0.0], team: 1 }));
  for (const [x, z] of [
    [0, 0.3],
    [-0.22, -0.18],
    [0.22, -0.18],
  ]) {
    g.push(box(0.03, 0.36, 0.03, { at: [x * 0.6, 0.17, z * 0.6], rot: [z, 0, -x], color: STEEL }));
  }
  const far = merge([
    ...TEAM_OFFSETS.map(([x, z]) =>
      box(0.3, 0.6, 0.3, { at: [x, 0.3, z], color: 0x3a3d2e, team: 0.7 }),
    ),
    box(0.22, 0.2, 1.1, { at: [0, 0.45, 0.15], color: 0x2c2f25, team: 0.5 }),
  ]);
  return { launcher: merge(g), far };
}
