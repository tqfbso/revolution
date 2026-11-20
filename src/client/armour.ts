// The ground vehicles of the three armies: each kind in each army's own shape, so a column
// can be told from its outline before its colour. Original designs in the manner of each
// army's present-day equipment: the alliance's are tall, slab-sided and few; Russia's low,
// rounded and hung with reactive armour, fuel drums and logs; China's angular, in sand, and
// on wheels wherever a wheel will do.
//
// Written in metres (kit.ts), each model once for all three levels of detail.
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  atLevels,
  CANVAS,
  GLASS,
  LAMP,
  M,
  PAINT_DARK,
  Parts,
  RUBBER,
  STEEL,
  TINT,
  TRACK,
  under,
} from './kit';
import type { VehicleModel } from './models';

const tint = { team: TINT };
const dark = { color: PAINT_DARK, team: TINT };
const WOOD = 0x6b5338;

/** One level of a vehicle on the bench: hull and turret apart, the turret about its ring. */
export interface Built {
  hull: Parts;
  turret: Parts;
  /** Where the turret ring is on the hull, and the muzzle from the ring, in metres. */
  turretY: number;
  turretZ: number;
  muzzleY: number;
  muzzleZ: number;
}

/** A vehicle from its builder: near and middle hull and turret, and the two as one far off. */
export function vehicle(
  build: (lod: number, hull: Parts, turret: Parts) => Omit<Built, 'hull' | 'turret'>,
): VehicleModel {
  const levels = atLevels((lod) => {
    const hull = new Parts(lod);
    const turret = new Parts(lod);
    return { hull, turret, ...build(lod, hull, turret) };
  });
  const [a, b, c] = levels;
  const farTurret = c.turret.list.length > 0 ? c.turret.done(1) : null;
  farTurret?.translate(0, c.turretY, c.turretZ);
  const farHull = c.hull.done(1);
  const plain = (g: THREE.BufferGeometry) => (g.index ? g.toNonIndexed() : g);
  // At this distance a vehicle is a few pixels: silhouette and team colour are all that
  // count, so the far model wears the army's colour over its paint, most on the turret.
  showTeam(farHull, 0.42);
  if (farTurret) showTeam(farTurret, 0.75);
  const far = farTurret ? mergeGeometries([plain(farHull), plain(farTurret)]) : farHull;
  far.scale(M, M, M);
  return {
    hull: [a.hull.done(), b.hull.done()],
    turret: a.turret.list.length > 0 ? [a.turret.done(), b.turret.done()] : [],
    far,
    turretY: a.turretY * M,
    turretZ: a.turretZ * M,
    muzzleY: a.muzzleY * M,
    muzzleZ: a.muzzleZ * M,
  };
}

/** Raise the team colour on everything painted (not rubber, steel or glass). */
export function showTeam(g: THREE.BufferGeometry, amount: number): void {
  const mask = g.getAttribute('teamMask');
  const col = g.getAttribute('color');
  for (let i = 0; i < mask.count; i++)
    if (col.getY(i) > 0.2) mask.setX(i, Math.max(mask.getX(i), amount));
}

interface TrackSpec {
  /** Length over the track, its width, how high the top run is, and its centre off the middle. */
  len: number;
  wide: number;
  high: number;
  x: number;
  /** Road wheels a side and their radius. */
  wheels: number;
  r: number;
  /** Where the drive sprocket is: Western and Chinese tanks drive from the rear too. */
  z?: number;
  /** Return rollers under the top run (none on the big-wheeled Russian running gear). */
  rollers?: boolean;
}

/** Both tracks with their wheels: the run itself, road wheels, sprocket, idler. */
function tracks(P: Parts, t: TrackSpec): void {
  const z0 = t.z ?? 0;
  const half = t.len / 2;
  const rise = t.high * 0.56;
  P.both((s) => {
    const x = s * t.x;
    P.prism(
      [
        [-half + 0.62, 0],
        [half - 0.7, 0],
        [half, rise],
        [half - 0.3, t.high],
        [-half + 0.3, t.high],
        [-half, rise],
      ],
      t.wide / 2,
      { at: [x, 0, z0], color: TRACK },
    );
    const out = x + s * (t.wide / 2 - 0.07);
    const span = t.len - 1.5 - t.r * 2;
    for (let k = 0; k < t.wheels; k++) {
      const z = z0 - span / 2 + (k * span) / (t.wheels - 1) - 0.05;
      P.cyl(t.r, 0.2, 'x', { at: [out, t.r + 0.02, z], color: RUBBER }, 10, 1);
      P.cyl(t.r * 0.74, 0.24, 'x', { at: [out, t.r + 0.02, z], ...dark }, 10, 0);
      P.cyl(t.r * 0.24, 0.3, 'x', { at: [out, t.r + 0.02, z], color: STEEL }, 6, 0);
    }
    // Sprocket at the back, idler at the front, both clear of the ground.
    P.cyl(t.r * 0.82, 0.22, 'x', { at: [out, rise + 0.02, z0 - half + 0.42], color: STEEL }, 9, 0);
    P.cyl(t.r * 0.4, 0.28, 'x', { at: [out, rise + 0.02, z0 - half + 0.42], ...dark }, 6, 0);
    P.cyl(t.r * 0.78, 0.22, 'x', { at: [out, rise + 0.02, z0 + half - 0.45], ...dark }, 9, 0);
    if (t.rollers) {
      for (let k = 0; k < 3; k++) {
        const z = z0 - span * 0.3 + k * span * 0.3;
        P.cyl(0.11, 0.2, 'x', { at: [out, t.high - 0.14, z], color: STEEL }, 6, 0);
      }
    }
  });
}

interface GunSpec {
  /** Where the barrel leaves the mantlet, its length and bore radius. */
  y: number;
  z: number;
  len: number;
  r: number;
  /** Fume extractor: how far along (0 to 1), or none. */
  fume?: number;
  /** A muzzle brake of this length (howitzers), or the plain muzzle of a tank gun. */
  brake?: number;
  /** Elevation, radians. */
  pitch?: number;
  x?: number;
  /** A thermal sleeve in the army's paint over the first part of the barrel. */
  sleeve?: boolean;
}

/** A gun barrel with its sleeve, fume extractor and muzzle. Returns the muzzle (y, z). */
function gun(P: Parts, g: GunSpec): [number, number] {
  const pitch = g.pitch ?? 0;
  const x = g.x ?? 0;
  const sp = Math.sin(pitch);
  const cp = Math.cos(pitch);
  const at = (along: number): [number, number, number] => [x, g.y + sp * along, g.z + cp * along];
  const rot: [number, number, number] = [-pitch, 0, 0];
  P.cyl(g.r, g.len, 'z', { at: at(g.len / 2), rot, color: STEEL }, 9);
  if (g.sleeve !== false) {
    P.cyl(g.r * 1.28, g.len * 0.36, 'z', { at: at(g.len * 0.2), rot, ...tint }, 9, 1);
    P.cyl(g.r * 1.22, g.len * 0.2, 'z', { at: at(g.len * 0.84), rot, ...tint }, 9, 0);
  }
  if (g.fume !== undefined)
    P.cyl(g.r * 1.75, g.len * 0.13, 'z', { at: at(g.len * g.fume), rot, ...tint }, 9, 1);
  if (g.brake) {
    P.cyl(g.r * 1.9, g.brake, 'z', { at: at(g.len - g.brake / 2), rot, color: STEEL }, 8, 1);
    P.box(
      g.r * 5,
      g.r * 1.5,
      g.brake * 0.34,
      { at: at(g.len - g.brake * 0.3), rot, color: STEEL },
      0,
    );
    P.box(
      g.r * 5,
      g.r * 1.5,
      g.brake * 0.24,
      { at: at(g.len - g.brake * 0.8), rot, color: STEEL },
      0,
    );
  } else P.cyl(g.r * 1.2, 0.16, 'z', { at: at(g.len - 0.08), rot, color: RUBBER }, 8, 0);
  return [g.y + sp * g.len, g.z + cp * g.len];
}

/** A machine gun on a pintle or a remote mount: its box, its barrel, its ammunition tin. */
function roofGun(P: Parts, x: number, y: number, z: number, remote: boolean, yaw = 0): void {
  const rot: [number, number, number] = [0, yaw, 0];
  P.cyl(0.05, 0.3, 'y', { at: [x, y + 0.15, z], color: STEEL }, 5, 0);
  if (remote) P.box(0.3, 0.3, 0.42, { at: [x, y + 0.42, z], rot, ...dark }, 1);
  P.box(0.11, 0.13, 0.5, { at: [x, y + (remote ? 0.5 : 0.36), z + 0.05], rot, color: STEEL }, 0);
  const sy = Math.sin(yaw);
  const cy = Math.cos(yaw);
  P.cyl(
    0.028,
    0.95,
    'z',
    { at: [x + sy * 0.62, y + (remote ? 0.5 : 0.36), z + cy * 0.62], rot, color: RUBBER },
    5,
    1,
  );
  P.box(
    0.16,
    0.18,
    0.24,
    { at: [x - cy * 0.2, y + (remote ? 0.42 : 0.3), z + sy * 0.2], rot, color: 0x3e4032 },
    0,
  );
}

/** A whip aerial on its base. */
function aerial(P: Parts, x: number, y: number, z: number, high = 2.0): void {
  P.cyl(0.04, 0.16, 'y', { at: [x, y + 0.08, z], color: STEEL }, 5, 0);
  P.box(0.025, high, 0.025, { at: [x, y + high / 2, z], rot: [-0.12, 0, 0], color: RUBBER }, 0);
}

/** A row of smoke dischargers on a turret cheek, fanned outward. */
function dischargers(P: Parts, s: number, x: number, y: number, z: number, n = 4): void {
  P.box(0.12, 0.3, 0.5, { at: [x, y, z], color: STEEL }, 1);
  for (let k = 0; k < n; k++) {
    P.cyl(
      0.05,
      0.26,
      'z',
      {
        at: [x + s * 0.1, y - 0.08 + (k % 2) * 0.14, z - 0.16 + (k >> 1) * 0.26],
        rot: [-0.5, s * 0.6, 0],
        color: RUBBER,
      },
      6,
      0,
    );
  }
}

/** Reactive armour: a field of small bricks on a plate, `nx` by `nz`, standing off it. */
function bricks(
  P: Parts,
  at: [number, number, number],
  rot: [number, number, number],
  nx: number,
  nz: number,
  w = 0.3,
  d = 0.22,
): void {
  const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...rot));
  const v = new THREE.Vector3();
  if (P.lod === 1) {
    // From the middle distance the field reads as one raised slab.
    P.box(nx * w, 0.1, nz * d, { at, rot, ...tint }, 1);
    return;
  }
  for (let i = 0; i < nx; i++)
    for (let k = 0; k < nz; k++) {
      v.set((i - (nx - 1) / 2) * w, 0, (k - (nz - 1) / 2) * d).applyMatrix4(m);
      P.box(
        w * 0.86,
        0.1,
        d * 0.84,
        { at: [at[0] + v.x, at[1] + v.y, at[2] + v.z], rot, ...tint },
        0,
      );
    }
}

/**
 * The alliance's main battle tank: the biggest of the three. A long flat hull under heavy
 * skirts, and a huge angular turret, wide flat cheeks either side of the gun and a bustle
 * with a stowage rack reaching back over the engine deck. Seven road wheels.
 */
export function tankAlliance(): VehicleModel {
  return vehicle((lod, H, T) => {
    tracks(H, { len: 7.5, wide: 0.64, high: 1.0, x: 1.44, wheels: 7, r: 0.33, rollers: true });
    // The tub between the tracks, and the deck over them with its long shallow glacis.
    H.prism(
      [
        [-3.7, 0.5],
        [-3.8, 1.1],
        [3.3, 1.0],
        [3.75, 0.78],
        [3.2, 0.42],
        [-3.3, 0.42],
      ],
      1.14,
      dark,
    );
    H.prism(
      [
        [-3.85, 1.0],
        [-3.85, 1.42],
        [0.9, 1.42],
        [3.3, 1.12],
        [3.8, 0.98],
      ],
      [1.83, 1.83, 1.83, 1.8, 1.72],
      tint,
    );
    // Skirts: seven heavy plates a side, the first swept up.
    H.both((s) => {
      for (let k = 0; k < 7; k++) {
        const z = -3.2 + k * 0.98;
        H.box(
          0.07,
          k === 6 ? 0.42 : 0.6,
          0.94,
          { at: [s * 1.84, k === 6 ? 0.9 : 0.8, z], ...tint },
          1,
        );
      }
      H.box(0.08, 0.2, 1.9, { at: [s * 1.85, 0.95, -0.9], team: 1 }, 1);
      // Fenders, head lamps, the exhaust grilles at the back.
      H.box(0.66, 0.05, 0.6, { at: [s * 1.46, 0.98, 3.6], rot: [0.6, 0, 0], ...dark }, 0);
      H.box(0.2, 0.14, 0.1, { at: [s * 1.3, 1.16, 3.42], color: LAMP }, 0);
      H.box(0.24, 0.2, 0.12, { at: [s * 1.3, 1.16, 3.36], ...dark }, 0);
      H.box(1.0, 0.36, 0.06, { at: [s * 0.95, 1.12, -3.87], color: STEEL }, 1);
      H.box(0.5, 0.22, 0.5, { at: [s * 1.5, 1.52, -3.3], ...dark }, 0);
      H.cyl(0.07, 0.3, 'x', { at: [s * 0.5, 0.62, 3.6], color: STEEL }, 6, 0); // tow eyes
    });
    // Engine deck: raised louvres across the back; the driver's hatch in the glacis.
    H.box(3.0, 0.08, 2.3, { at: [0, 1.46, -2.6], ...dark }, 1);
    for (let k = 0; k < 6; k++)
      H.box(2.7, 0.04, 0.16, { at: [0, 1.52, -3.5 + k * 0.38], color: STEEL }, 0);
    H.cyl(0.36, 0.06, 'y', { at: [0, 1.3, 2.0], rot: [0.13, 0, 0], ...dark }, 10, 0);
    H.box(0.5, 0.1, 0.12, { at: [0, 1.36, 2.3], color: GLASS }, 0);

    // Turret: a long faceted box, narrow at the gun, widest at the back of the cheeks.
    T.prism(
      [
        [2.35, 0.08],
        [2.45, 0.42],
        [1.5, 0.86],
        [-1.5, 0.9],
        [-3.1, 0.86],
        [-3.3, 0.5],
        [-3.1, 0.22],
        [-1.7, 0.02],
      ],
      [1.0, 1.08, 1.5, 1.72, 1.6, 1.6, 1.55, 1.45],
      tint,
    );
    T.box(0.9, 0.62, 0.5, { at: [0, 0.4, 2.5], ...dark }, 1); // mantlet
    const [my, mz] = gun(T, { y: 0.42, z: 2.6, len: 5.3, r: 0.085, fume: 0.52 });
    T.both((s) => {
      // Stowage boxes along the sides, the rack round the bustle and what is lashed in it.
      T.box(0.34, 0.4, 1.9, { at: [s * 1.78, 0.5, -1.5], ...dark }, 1);
      T.box(0.36, 0.3, 0.9, { at: [s * 1.79, 0.56, -1.5], team: 1 }, 1);
      T.box(0.05, 0.05, 1.3, { at: [s * 1.62, 0.92, -3.6], color: STEEL }, 0);
      T.box(0.05, 0.5, 0.05, { at: [s * 1.62, 0.68, -4.2], color: STEEL }, 0);
      dischargers(T, s, s * 1.5, 0.5, 0.9);
    });
    T.box(3.2, 0.5, 0.9, { at: [0, 0.6, -3.75], color: 0x4a4b38, cloth: true }, 1); // stowed kit
    T.box(3.3, 0.05, 0.05, { at: [0, 0.92, -4.22], color: STEEL }, 0);
    T.box(3.3, 0.05, 0.05, { at: [0, 0.42, -4.22], color: STEEL }, 0);
    T.cyl(0.2, 2.6, 'x', { at: [0, 1.0, -3.7], color: CANVAS, cloth: true }, 7, 0); // rolled tarp
    // Roof: the commander's sight, his remote gun, the loader's hatch and gun, the gunner's sight.
    T.cyl(0.26, 0.5, 'y', { at: [-0.75, 1.14, 0.5], ...dark }, 8, 1);
    T.box(0.3, 0.24, 0.06, { at: [-0.75, 1.24, 0.75], color: GLASS }, 0);
    T.cyl(0.46, 0.14, 'y', { at: [0.8, 0.95, -0.4], ...dark }, 10, 1);
    roofGun(T, 0.8, 0.98, -0.1, true);
    T.cyl(0.4, 0.08, 'y', { at: [-0.75, 0.93, -0.8], ...dark }, 10, 0);
    roofGun(T, -0.75, 0.9, -1.2, false, 0.5);
    T.box(0.5, 0.3, 0.6, { at: [0.85, 1.0, 1.0], ...dark }, 1);
    T.box(0.4, 0.2, 0.05, { at: [0.85, 1.02, 1.31], color: GLASS }, 0);
    T.box(1.2, 0.03, 0.9, { at: [0, 0.9, -2.3], team: 1 }, 1); // air recognition panel
    aerial(T, -1.3, 0.88, -2.9, 2.4);
    aerial(T, 1.3, 0.88, -2.9, 1.6);
    void lod;
    return { turretY: 1.42, turretZ: 0.15, muzzleY: my, muzzleZ: mz };
  });
}

/**
 * Russia's tank: a third lower than the alliance's. A small rounded turret buried in
 * wedges of reactive armour, a long gun, a snorkel across the back of the turret, and on
 * the hull's tail two fuel drums and a log for unditching. Six large road wheels.
 */
export function tankRussia(): VehicleModel {
  return vehicle((lod, H, T) => {
    tracks(H, { len: 6.7, wide: 0.58, high: 0.92, x: 1.4, wheels: 6, r: 0.37 });
    // A pointed prow: the glacis runs from the nose most of the way to the turret.
    H.prism(
      [
        [-3.3, 0.5],
        [-3.4, 1.08],
        [1.9, 1.08],
        [3.4, 0.62],
        [3.0, 0.4],
        [-3.0, 0.4],
      ],
      1.12,
      dark,
    );
    H.prism(
      [
        [-3.45, 0.9],
        [-3.45, 1.12],
        [1.85, 1.12],
        [2.7, 0.9],
      ],
      1.72,
      tint,
    );
    bricks(H, [0, 0.93, 2.72], [0.3, 0, 0], 6, 3);
    H.box(2.2, 0.05, 0.3, { at: [0, 1.12, 1.75], rot: [0.9, 0, 0], ...dark }, 0); // splash board
    H.both((s) => {
      // Rubber skirts, reactive panels on the first third, scalloped where the rest hang.
      H.box(0.05, 0.42, 4.4, { at: [s * 1.73, 0.72, -1.0], color: 0x24251f }, 1);
      for (let k = 0; k < 3; k++)
        H.box(
          0.14,
          0.5,
          0.66,
          { at: [s * 1.78, 0.74, 1.6 + k * 0.7 - 0.6], rot: [0, s * -0.08, 0], ...tint },
          1,
        );
      H.box(0.06, 0.16, 1.2, { at: [s * 1.76, 0.82, -1.4], team: 1 }, 1);
      H.box(0.6, 0.05, 0.5, { at: [s * 1.42, 0.9, 3.1], rot: [0.7, 0, 0], color: 0x24251f }, 0);
      H.box(0.18, 0.16, 0.14, { at: [s * 0.9, 1.0, 2.75], color: LAMP }, 0);
      // Stowage bins along the fenders.
      H.box(0.5, 0.22, 1.3, { at: [s * 1.42, 1.23, -0.4 + s * 0.3], ...dark }, 0);
    });
    H.box(0.3, 0.26, 0.9, { at: [-1.6, 1.22, -2.0], color: STEEL }, 1); // exhaust, left side
    // The tail: two fuel drums on their cradles, the log under them.
    H.both((s) => {
      H.cyl(0.3, 1.0, 'x', { at: [s * 0.75, 1.2, -3.55], ...dark }, 10);
      H.box(0.06, 0.66, 0.06, { at: [s * 0.75, 1.2, -3.55], color: STEEL }, 0);
    });
    H.cyl(0.13, 2.9, 'x', { at: [0, 0.74, -3.56], color: WOOD, cloth: true }, 7, 1);
    H.box(2.4, 0.02, 0.5, { at: [0, 1.125, -2.4], color: STEEL }, 0); // engine grille

    // Turret: a low dome, wider than it is long.
    T.fuselage(
      [
        { z: -1.55, w: 0.9, h: 0.26, y: 0.3 },
        { z: -1.2, w: 1.3, h: 0.36, y: 0.36 },
        { z: 0, w: 1.42, h: 0.42, y: 0.4 },
        { z: 0.95, w: 1.2, h: 0.36, y: 0.36 },
        { z: 1.5, w: 0.7, h: 0.26, y: 0.3 },
      ],
      { seg: 12, square: 2.6, ...tint },
    );
    // Reactive armour in wedges round the front of the dome, leaning back, a gap for the gun.
    T.both((s) => {
      for (let k = 0; k < 4; k++) {
        const a = 0.3 + k * 0.36;
        const px = s * Math.sin(a) * 1.3;
        const pz = Math.cos(a) * 1.42;
        T.prism(
          [
            [-0.1, 0.02],
            [0.42, 0.1],
            [0.5, 0.3],
            [-0.1, 0.72],
          ],
          0.25,
          { at: [px, 0.04, pz], rot: [0, s * a, 0], ...tint },
          k < 3 ? 2 : 1,
        );
      }
      T.box(0.3, 0.36, 0.9, { at: [s * 1.42, 0.42, -0.9], ...dark }, 1); // side bins
      T.box(0.31, 0.2, 0.5, { at: [s * 1.43, 0.46, -0.9], team: 1 }, 1);
      dischargers(T, s, s * 1.36, 0.5, 0.1, 6);
    });
    T.box(0.5, 0.5, 0.5, { at: [0, 0.4, 1.5], ...dark }, 1);
    const [my, mz] = gun(T, { y: 0.4, z: 1.6, len: 6.0, r: 0.08, fume: 0.6 });
    T.box(0.46, 0.4, 0.3, { at: [0.72, 0.5, 1.72], color: STEEL }, 0); // searchlight
    T.box(0.38, 0.32, 0.04, { at: [0.72, 0.5, 1.88], color: 0x5a2420 }, 0);
    // Snorkel across the back, stowage box behind it.
    T.cyl(0.19, 2.5, 'x', { at: [0, 0.66, -1.62], ...dark }, 9, 1);
    T.box(1.6, 0.4, 0.5, { at: [0, 0.3, -1.8], ...dark }, 1);
    T.cyl(0.42, 0.24, 'y', { at: [0.5, 0.86, -0.25], ...dark }, 10, 1); // cupola
    roofGun(T, 0.5, 0.92, -0.2, false, -0.3);
    T.cyl(0.36, 0.08, 'y', { at: [-0.55, 0.8, -0.2], ...dark }, 10, 0);
    T.box(0.3, 0.26, 0.34, { at: [-0.5, 0.88, 0.5], color: STEEL }, 0); // gunner's sight
    T.box(0.8, 0.03, 0.6, { at: [0, 0.83, -0.9], team: 1 }, 1);
    aerial(T, -0.9, 0.7, -1.2, 2.6);
    void lod;
    return { turretY: 1.12, turretZ: 0.1, muzzleY: my, muzzleZ: mz };
  });
}

/**
 * China's tank: an arrowhead. The turret front is two long wedges meeting at the gun, the
 * sides are flat, and a slatted basket hangs off the back; a sight mast stands on the roof.
 * Six road wheels under skirts with reactive blocks.
 */
export function tankChina(): VehicleModel {
  return vehicle((lod, H, T) => {
    tracks(H, { len: 7.1, wide: 0.6, high: 0.96, x: 1.42, wheels: 6, r: 0.35, rollers: true });
    H.prism(
      [
        [-3.5, 0.5],
        [-3.6, 1.1],
        [2.4, 1.1],
        [3.6, 0.7],
        [3.1, 0.4],
        [-3.2, 0.4],
      ],
      1.12,
      dark,
    );
    H.prism(
      [
        [-3.65, 0.94],
        [-3.65, 1.3],
        [-1.9, 1.3],
        [-1.7, 1.18],
        [2.2, 1.18],
        [3.3, 0.94],
      ],
      1.76,
      tint,
    );
    bricks(H, [0, 1.12, 2.78], [0.22, 0, 0], 5, 2, 0.44, 0.34);
    H.both((s) => {
      for (let k = 0; k < 6; k++) {
        const z = -3.0 + k * 1.08;
        H.box(0.06, 0.5, 1.02, { at: [s * 1.78, 0.78, z], ...tint }, 1);
        if (k >= 3) H.box(0.16, 0.34, 0.9, { at: [s * 1.86, 0.86, z], ...tint }, 1);
      }
      H.box(0.07, 0.18, 1.4, { at: [s * 1.8, 0.9, -1.7], team: 1 }, 1);
      H.box(0.2, 0.14, 0.1, { at: [s * 1.2, 1.1, 3.0], color: LAMP }, 0);
      H.box(0.6, 0.05, 0.5, { at: [s * 1.44, 0.94, 3.36], rot: [0.65, 0, 0], ...dark }, 0);
      H.box(0.5, 0.18, 1.6, { at: [s * 1.46, 1.28, 0.2], ...dark }, 0);
    });
    // Engine deck raised at the back, grilles on it.
    for (let k = 0; k < 4; k++)
      H.box(2.4, 0.04, 0.2, { at: [0, 1.34, -3.4 + k * 0.4], color: STEEL }, 0);
    H.cyl(0.14, 0.5, 'z', { at: [1.5, 1.2, -3.7], color: STEEL }, 7, 0);
    H.cyl(0.34, 0.06, 'y', { at: [-0.5, 1.2, 1.5], ...dark }, 9, 0);

    // Turret: from above an arrowhead, its sides running straight back to the basket.
    T.prism(
      [
        [2.55, 0.1],
        [2.65, 0.36],
        [1.3, 0.84],
        [-1.7, 0.84],
        [-1.85, 0.3],
        [-1.6, 0.04],
        [1.2, 0.0],
      ],
      [0.42, 0.46, 1.46, 1.58, 1.58, 1.5, 1.4],
      tint,
    );
    T.both((s) => {
      // The seam down each wedge, and the plate over it.
      T.box(0.33, 0.3, 1.5, { at: [s * 1.66, 0.48, -0.5], ...dark }, 1);
      T.box(0.34, 0.2, 0.8, { at: [s * 1.67, 0.5, -0.5], team: 1 }, 1);
      dischargers(T, s, s * 1.5, 0.66, 0.5, 6);
      // The basket: four rails a side, closed across the back.
      for (let k = 0; k < 4; k++)
        T.box(0.04, 0.04, 1.3, { at: [s * 1.5, 0.14 + k * 0.2, -2.45], color: STEEL }, 0);
      T.box(0.05, 0.7, 0.05, { at: [s * 1.5, 0.42, -3.08], color: STEEL }, 0);
    });
    for (let k = 0; k < 4; k++)
      T.box(3.0, 0.04, 0.04, { at: [0, 0.14 + k * 0.2, -3.1], color: STEEL }, 0);
    T.box(2.7, 0.56, 1.1, { at: [0, 0.4, -2.45], color: 0x4a4b38, cloth: true }, 1);
    T.box(0.7, 0.5, 0.4, { at: [0, 0.34, 2.5], ...dark }, 1);
    const [my, mz] = gun(T, { y: 0.36, z: 2.6, len: 5.6, r: 0.082, fume: 0.45 });
    // Roof: the commander's sight on its mast, the dazzler box, his gun, the wind sensor.
    T.cyl(0.2, 0.7, 'y', { at: [0.7, 1.18, -0.2], ...dark }, 8, 1);
    T.box(0.34, 0.3, 0.34, { at: [0.7, 1.62, -0.2], ...dark }, 1);
    T.box(0.26, 0.2, 0.04, { at: [0.7, 1.62, 0.0], color: GLASS }, 0);
    T.box(0.6, 0.42, 0.7, { at: [-0.8, 1.04, -1.1], ...dark }, 1);
    T.box(0.4, 0.26, 0.04, { at: [-0.8, 1.06, -0.73], color: 0x3a2a4a }, 0);
    T.cyl(0.4, 0.1, 'y', { at: [-0.7, 0.88, 0.0], ...dark }, 10, 0);
    roofGun(T, -0.7, 0.9, 0.3, false, 0.2);
    T.box(0.5, 0.26, 0.5, { at: [0.75, 0.96, 1.0], ...dark }, 0);
    T.box(0.03, 1.5, 0.03, { at: [0, 1.6, -1.6], color: STEEL }, 1);
    T.box(0.2, 0.1, 0.2, { at: [0, 2.36, -1.6], color: STEEL }, 0);
    T.box(1.0, 0.03, 0.8, { at: [0, 0.85, -0.7], team: 1 }, 1);
    aerial(T, 1.2, 0.84, -1.5, 2.2);
    void lod;
    return { turretY: 1.18, turretZ: 0.0, muzzleY: my, muzzleZ: mz };
  });
}

/** Wheels down both sides at these stations, with the arch cut over each. */
function wheels(P: Parts, zs: readonly number[], x: number, r: number, wide = 0.42): void {
  P.both((s) => {
    for (const z of zs) P.wheel(s * x, r, z, r, wide, PAINT_DARK, 2);
  });
}

interface LorrySpec {
  /** Axle stations (z), wheel radius, half track width. */
  axles: readonly number[];
  r: number;
  x?: number;
  /** Frame from `back` to `front`; the cab stands at the front. */
  back: number;
  front: number;
  /** `over`: flat-faced, on top of the front axle. `bonnet`: engine out in front of it. `armour`: an angular armoured cab. */
  cab: 'over' | 'bonnet' | 'armour';
  /** Cab length and roof height. */
  cabLen?: number;
  roof?: number;
}

/**
 * A lorry's chassis and cab: what the trucks, the jammers and China's wheeled gun and
 * air-defence vehicles stand on. Returns the height of the load deck and where the cab ends.
 */
function lorry(P: Parts, v: LorrySpec): { deck: number; cabBack: number } {
  const x = v.x ?? 1.05;
  const deck = v.r * 2 + 0.16;
  const cabLen = v.cabLen ?? 2.0;
  const roof = v.roof ?? deck + 1.55;
  wheels(P, v.axles, x, v.r);
  // Frame rails, axles, fuel tank, spare wheel behind the cab.
  P.box(
    1.0,
    0.3,
    v.front - v.back - 0.3,
    { at: [0, deck - 0.2, (v.front + v.back) / 2], color: STEEL },
    1,
  );
  for (const z of v.axles) P.cyl(0.11, x * 2, 'x', { at: [0, v.r, z], color: STEEL }, 6, 0);
  P.cyl(
    0.3,
    1.1,
    'z',
    { at: [-x + 0.1, deck - 0.45, (v.axles[0] + v.axles[1]) / 2 - 0.2], ...dark },
    8,
    0,
  );
  P.both((s) => {
    P.box(0.5, 0.06, v.r * 2.5, { at: [s * x, v.r * 2 + 0.1, v.axles[0]], ...dark }, 1); // front wings
  });
  const front = v.front;
  if (v.cab === 'bonnet') {
    // A long nose with the wings either side, the cab behind the front axle.
    const cb = front - 1.75;
    P.prism(
      [
        [front, deck - 0.3],
        [front, deck + 0.52],
        [cb, deck + 0.68],
        [cb, deck - 0.3],
      ],
      [0.62, 0.62, 0.78, 0.78],
      tint,
    );
    P.box(1.0, 0.5, 0.06, { at: [0, deck + 0.14, front + 0.02], color: STEEL }, 1); // grille
    P.prism(
      [
        [cb, deck - 0.3],
        [cb, deck + 0.7],
        [cb - 0.34, roof],
        [cb - cabLen, roof],
        [cb - cabLen, deck - 0.3],
      ],
      1.18,
      tint,
    );
    P.box(2.0, 0.5, 0.05, { at: [0, deck + 1.02, cb - 0.16], rot: [-0.56, 0, 0], color: GLASS }, 1);
    P.both((s) => {
      P.box(
        0.05,
        0.42,
        cabLen * 0.5,
        { at: [s * 1.19, deck + 1.06, cb - cabLen * 0.5], color: GLASS },
        1,
      );
      P.cyl(0.13, 0.1, 'z', { at: [s * 0.86, deck + 0.3, front + 0.04], color: LAMP }, 7, 0);
      P.box(0.5, 0.1, 0.24, { at: [s * 0.9, deck - 0.34, front + 0.12], color: STEEL }, 0); // bumper ends
    });
    P.box(2.4, 0.2, 0.14, { at: [0, deck - 0.36, front + 0.1], color: STEEL }, 1);
    return { deck, cabBack: cb - cabLen };
  }
  const cb = front - cabLen;
  if (v.cab === 'armour') {
    // Flat armour plate: a raked screen in two panes, the sides leaning in to the roof.
    P.prism(
      [
        [front, deck - 0.5],
        [front, deck + 0.5],
        [front - 0.6, roof],
        [cb, roof],
        [cb, deck - 0.3],
      ],
      [1.22, 1.22, 1.04, 1.04, 1.22],
      tint,
    );
    P.both((s) => {
      P.box(
        0.86,
        0.6,
        0.05,
        { at: [s * 0.5, deck + 1.08, front - 0.31], rot: [-0.52, 0, 0], color: GLASS },
        1,
      );
      P.box(
        0.05,
        0.36,
        0.7,
        { at: [s * 1.14, deck + 1.0, front - 1.15], rot: [0, 0, s * 0.11], color: GLASS },
        1,
      );
      P.box(0.2, 0.14, 0.08, { at: [s * 0.95, deck - 0.1, front + 0.03], color: LAMP }, 0);
    });
    P.box(2.5, 0.3, 0.2, { at: [0, deck - 0.52, front + 0.06], color: STEEL }, 1);
    return { deck, cabBack: cb };
  }
  // Cab over the engine: a tall flat face.
  P.prism(
    [
      [front, deck - 0.6],
      [front, deck + 0.75],
      [front - 0.22, roof],
      [cb, roof],
      [cb, deck - 0.3],
    ],
    1.2,
    tint,
  );
  P.box(
    2.1,
    0.62,
    0.05,
    { at: [0, deck + 1.12, front - 0.1], rot: [-0.26, 0, 0], color: GLASS },
    1,
  );
  P.both((s) => {
    P.box(
      0.05,
      0.5,
      cabLen * 0.5,
      { at: [s * 1.21, deck + 1.1, front - cabLen * 0.45], color: GLASS },
      1,
    );
    P.box(0.26, 0.16, 0.08, { at: [s * 0.9, deck - 0.2, front + 0.03], color: LAMP }, 0);
    P.box(0.08, 0.36, 0.12, { at: [s * 1.36, deck + 1.25, front - 0.25], color: RUBBER }, 0); // mirrors
  });
  P.box(1.3, 0.4, 0.05, { at: [0, deck + 0.3, front + 0.02], color: STEEL }, 0);
  P.box(2.46, 0.3, 0.2, { at: [0, deck - 0.6, front + 0.06], color: STEEL }, 1);
  return { deck, cabBack: cb };
}

/** A canvas tilt over hoops on a load bed from z0 to z1. */
function tilt(P: Parts, deck: number, z0: number, z1: number, high: number, half = 1.22): void {
  P.box(half * 2, 0.5, z1 - z0, { at: [0, deck + 0.25, (z0 + z1) / 2], ...tint }, 2);
  const canvas = { color: CANVAS, cloth: true };
  P.prism(
    [
      [z0, deck + 0.45],
      [z0, deck + high * 0.72],
      [z0 + 0.08, deck + high],
      [z1 - 0.08, deck + high],
      [z1, deck + high * 0.72],
      [z1, deck + 0.45],
    ],
    [half + 0.02, half + 0.02, half * 0.74, half * 0.74, half + 0.02, half + 0.02],
    canvas,
  );
  // The hoops show through the canvas as ridges.
  for (let z = z0 + 0.5; z < z1 - 0.2; z += 0.85)
    P.box(
      half * 1.52,
      0.04,
      0.07,
      { at: [0, deck + high + 0.01, z], color: 0x5c5b41, cloth: true },
      0,
    );
  P.box(
    half * 1.4,
    high * 0.5,
    0.04,
    { at: [0, deck + high * 0.42, z0 - 0.02], color: 0x5c5b41, cloth: true },
    0,
  );
}

const noTurret = { turretY: 0, turretZ: 0, muzzleY: 0, muzzleZ: 0 };

/** The alliance's truck: an armoured cab over the front axle and a flatrack of crates under a net. */
export function truckAlliance(): VehicleModel {
  return vehicle((_lod, H) => {
    const { deck, cabBack } = lorry(H, {
      axles: [2.5, -1.3, -2.7],
      r: 0.62,
      back: -3.9,
      front: 3.7,
      cab: 'armour',
      cabLen: 2.3,
    });
    H.box(2.5, 0.16, cabBack + 3.7, { at: [0, deck + 0.08, (cabBack - 3.9) / 2 + 0.1], ...tint });
    H.prism(
      [
        [cabBack - 0.25, deck],
        [cabBack - 0.25, deck + 1.9],
        [cabBack - 0.9, deck],
      ],
      1.0,
      { color: STEEL },
      1,
    ); // the flatrack's A-frame
    H.box(2.1, 0.9, 2.2, { at: [0, deck + 0.6, -1.0], color: 0x4f5340, cloth: true });
    H.box(2.2, 0.7, 1.4, { at: [0, deck + 0.5, -3.0], color: 0x5b5c44, cloth: true });
    H.box(1.2, 0.5, 1.2, { at: [-0.3, deck + 1.3, -1.2], color: 0x66624a, cloth: true }, 1);
    H.box(0.9, 0.02, 0.7, { at: [0.5, deck + 1.06, -0.6], team: 1 }, 1);
    H.box(1.4, 0.03, 0.9, { at: [0, deck + 1.56, 2.4], team: 1 }, 1);
    return noTurret;
  });
}

/** Russia's truck: a long bonnet, a round-shouldered cab, a low canvas tilt. */
export function truckRussia(): VehicleModel {
  return vehicle((_lod, H) => {
    const { deck, cabBack } = lorry(H, {
      axles: [2.3, -1.4, -2.75],
      r: 0.6,
      back: -3.8,
      front: 3.75,
      cab: 'bonnet',
      cabLen: 1.7,
      roof: 2.75,
    });
    tilt(H, deck, -3.85, cabBack - 0.15, 1.5, 1.2);
    H.cyl(
      0.58,
      0.3,
      'x',
      { at: [0, deck + 0.75, cabBack - 0.02], rot: [0, 0, 0], color: RUBBER },
      10,
      0,
    );
    H.box(0.06, 0.3, 1.2, { at: [1.23, deck + 0.28, -2.2], team: 1 }, 1);
    H.box(0.06, 0.3, 1.2, { at: [-1.23, deck + 0.28, -2.2], team: 1 }, 1);
    H.box(1.0, 0.03, 0.8, { at: [0, 2.77, cabBack + 0.75], team: 1 }, 1);
    return noTurret;
  });
}

/** China's truck: a tall flat-faced cab and a high tilt over the bed. */
export function truckChina(): VehicleModel {
  return vehicle((_lod, H) => {
    const { deck, cabBack } = lorry(H, {
      axles: [2.6, -1.2, -2.6],
      r: 0.62,
      back: -3.8,
      front: 3.8,
      cab: 'over',
      cabLen: 2.1,
      roof: 3.05,
    });
    tilt(H, deck, -3.85, cabBack - 0.2, 1.95, 1.24);
    H.box(1.9, 0.5, 0.3, { at: [0, 3.2, cabBack + 0.6], color: 0x4f5340, cloth: true }, 1); // roof rack roll
    H.box(0.06, 0.3, 1.4, { at: [1.27, deck + 0.28, -2.0], team: 1 }, 1);
    H.box(0.06, 0.3, 1.4, { at: [-1.27, deck + 0.28, -2.0], team: 1 }, 1);
    H.box(1.0, 0.03, 0.8, { at: [0, 3.07, cabBack + 1.4], team: 1 }, 1);
    return noTurret;
  });
}

/**
 * The alliance's infantry fighting vehicle: tracked, tall and slab-sided under bolted
 * armour boxes, a two-man turret with a cannon and a missile box on its left cheek.
 */
export function ifvAlliance(): VehicleModel {
  return vehicle((_lod, H, T) => {
    tracks(H, { len: 6.5, wide: 0.5, high: 0.9, x: 1.36, wheels: 6, r: 0.31, rollers: true });
    H.prism(
      [
        [-3.2, 0.5],
        [-3.3, 2.0],
        [1.3, 2.0],
        [3.1, 1.3],
        [3.3, 0.9],
        [2.8, 0.42],
        [-2.9, 0.42],
      ],
      1.12,
      dark,
    );
    H.prism(
      [
        [-3.35, 0.92],
        [-3.35, 2.02],
        [1.25, 2.02],
        [3.0, 1.34],
        [3.2, 0.92],
      ],
      [1.62, 1.62, 1.62, 1.6, 1.56],
      tint,
    );
    H.both((s) => {
      // Armour boxes bolted along the sides, the skirt under them.
      for (let k = 0; k < 4; k++)
        H.box(0.16, 0.74, 1.08, { at: [s * 1.7, 1.52, -2.7 + k * 1.14], ...tint }, 1);
      H.box(0.06, 0.5, 5.6, { at: [s * 1.64, 0.82, -0.3], ...dark }, 1);
      H.box(0.18, 0.24, 1.0, { at: [s * 1.71, 1.56, -1.56], team: 1 }, 1);
      H.box(0.22, 0.16, 0.1, { at: [s * 1.2, 1.5, 2.72], color: LAMP }, 0);
      H.box(0.28, 0.3, 0.5, { at: [s * 1.3, 2.16, -2.8], ...dark }, 0);
    });
    H.box(1.9, 1.3, 0.08, { at: [0, 1.25, -3.36], ...dark }, 1); // ramp
    H.box(0.5, 0.6, 0.06, { at: [0.4, 1.3, -3.41], color: STEEL }, 0);
    H.box(1.5, 0.04, 1.3, { at: [0, 2.04, -2.3], ...dark }, 0); // roof hatch
    H.box(1.2, 0.04, 0.9, { at: [-0.5, 1.72, 2.1], rot: [0.37, 0, 0], color: STEEL }, 0); // engine grille
    H.cyl(0.3, 0.08, 'y', { at: [0.75, 1.95, 1.5], rot: [0.1, 0, 0], ...dark }, 8, 0);

    T.prism(
      [
        [1.25, 0.05],
        [1.35, 0.4],
        [0.7, 0.72],
        [-1.2, 0.72],
        [-1.35, 0.3],
        [-1.2, 0.02],
      ],
      [0.7, 0.76, 0.98, 1.08, 1.08, 1.0],
      tint,
    );
    const [my, mz] = gun(T, { y: 0.38, z: 1.3, len: 2.9, r: 0.05, sleeve: false });
    T.cyl(0.075, 0.9, 'z', { at: [0, 0.38, 1.7], ...tint }, 7, 1);
    T.box(0.5, 0.46, 1.3, { at: [-1.3, 0.48, -0.1], ...dark }, 1); // missile box
    T.box(0.4, 0.36, 0.04, { at: [-1.3, 0.48, 0.56], color: RUBBER }, 0);
    T.box(0.52, 0.2, 0.6, { at: [-1.31, 0.5, -0.2], team: 1 }, 1);
    T.box(0.5, 0.36, 0.5, { at: [0.55, 0.9, 0.3], ...dark }, 1); // sight
    T.box(0.4, 0.22, 0.04, { at: [0.55, 0.92, 0.56], color: GLASS }, 0);
    T.cyl(0.36, 0.1, 'y', { at: [-0.3, 0.76, -0.5], ...dark }, 9, 0);
    T.box(1.9, 0.4, 0.4, { at: [0, 0.4, -1.5], color: 0x4a4b38, cloth: true }, 1);
    dischargers(T, 1, 1.0, 0.44, 0.6);
    aerial(T, 0.8, 0.72, -1.0, 2.0);
    return { turretY: 2.02, turretZ: 0.3, muzzleY: my, muzzleZ: mz };
  });
}

/**
 * Russia's: very low and flat, a sharp bow like a boat's, a small round turret with a
 * thick gun and a thin one side by side.
 */
export function ifvRussia(): VehicleModel {
  return vehicle((_lod, H, T) => {
    tracks(H, { len: 6.5, wide: 0.42, high: 0.8, x: 1.32, wheels: 6, r: 0.29 });
    H.prism(
      [
        [-3.25, 0.5],
        [-3.3, 1.42],
        [1.5, 1.5],
        [3.4, 0.98],
        [3.0, 0.42],
        [-3.0, 0.42],
      ],
      [1.5, 1.56, 1.56, 1.3, 1.12, 1.12],
      tint,
    );
    H.box(2.5, 0.05, 0.9, { at: [0, 1.3, 2.75], rot: [0.27, 0, 0], ...dark }, 1); // trim vane
    H.both((s) => {
      H.box(0.34, 0.06, 6.2, { at: [s * 1.42, 0.86, -0.1], ...dark }, 1); // track guards
      H.box(0.05, 0.2, 1.3, { at: [s * 1.58, 1.12, -1.2], team: 1 }, 1);
      H.cyl(0.11, 0.1, 'z', { at: [s * 1.0, 1.2, 3.02], color: LAMP }, 6, 0);
      H.box(0.6, 0.9, 0.3, { at: [s * 0.7, 0.95, -3.4], ...dark }, 1); // the fat rear doors
      H.cyl(0.2, 0.3, 'z', { at: [s * 1.2, 0.7, -3.35], color: STEEL }, 7, 0); // water jets
      for (let k = 0; k < 3; k++)
        H.cyl(0.19, 0.05, 'y', { at: [s * 0.95, 1.46, -2.6 + k * 0.7], ...dark }, 7, 0);
    });
    H.box(0.9, 0.04, 0.6, { at: [1.0, 1.5, 0.7], color: STEEL }, 0);
    H.cyl(0.28, 0.06, 'y', { at: [0, 1.5, 2.0], ...dark }, 8, 0);

    T.fuselage(
      [
        { z: -1.0, w: 0.6, h: 0.18, y: 0.2 },
        { z: -0.7, w: 0.95, h: 0.25, y: 0.25 },
        { z: 0.2, w: 1.0, h: 0.28, y: 0.27 },
        { z: 0.9, w: 0.6, h: 0.2, y: 0.22 },
      ],
      { seg: 10, square: 2.4, ...tint },
    );
    const [my, mz] = gun(T, { y: 0.3, z: 0.8, len: 3.6, r: 0.075, x: -0.1 });
    gun(T, { y: 0.32, z: 0.8, len: 2.6, r: 0.035, x: 0.22, sleeve: false });
    T.box(0.7, 0.34, 0.4, { at: [0, 0.3, 0.85], ...dark }, 1);
    T.cyl(0.3, 0.14, 'y', { at: [0.42, 0.56, -0.2], ...dark }, 8, 1);
    T.box(0.3, 0.24, 0.3, { at: [-0.45, 0.62, 0.2], color: STEEL }, 0);
    T.box(0.5, 0.03, 0.4, { at: [0, 0.535, -0.65], team: 1 }, 1);
    dischargers(T, 1, 0.92, 0.3, 0.1, 3);
    dischargers(T, -1, -0.92, 0.3, 0.1, 3);
    aerial(T, -0.6, 0.5, -0.7, 2.2);
    return { turretY: 1.48, turretZ: -0.2, muzzleY: my, muzzleZ: mz };
  });
}

/** China's: eight wheels under a long boat-nosed hull, a small turret with a missile either side. */
export function ifvChina(): VehicleModel {
  return vehicle((_lod, H, T) => {
    const zs = [2.5, 1.15, -0.75, -2.1];
    wheels(H, zs, 1.2, 0.56, 0.44);
    H.prism(
      [
        [-3.6, 0.75],
        [-3.7, 2.02],
        [1.2, 2.02],
        [3.3, 1.4],
        [3.75, 1.0],
        [3.0, 0.5],
        [-3.2, 0.5],
      ],
      [1.2, 1.28, 1.28, 1.26, 1.16, 0.9, 0.9],
      tint,
    );
    // The hull flares out over the wheels.
    H.prism(
      [
        [-3.7, 1.22],
        [-3.7, 1.6],
        [2.9, 1.6],
        [3.5, 1.22],
      ],
      1.46,
      tint,
    );
    H.both((s) => {
      for (const z of zs) H.cyl(0.12, 0.5, 'x', { at: [s * 0.9, 0.56, z], color: STEEL }, 5, 0);
      H.box(0.05, 0.22, 1.5, { at: [s * 1.47, 1.42, -1.4], team: 1 }, 1);
      H.box(0.24, 0.16, 0.1, { at: [s * 1.0, 1.5, 3.06], color: LAMP }, 0);
      H.box(0.12, 0.3, 0.16, { at: [s * 1.32, 2.2, 1.3], color: RUBBER }, 0);
      H.box(0.3, 0.26, 1.6, { at: [s * 1.1, 2.14, -2.4], ...dark }, 0);
    });
    H.box(2.2, 0.05, 1.0, { at: [0, 1.76, 2.2], rot: [0.29, 0, 0], ...dark }, 0);
    H.box(1.6, 1.1, 0.08, { at: [0, 1.4, -3.72], ...dark }, 1);
    H.cyl(0.11, 1.2, 'y', { at: [-1.1, 1.7, 0.6], rot: [0.9, 0, 0], color: STEEL }, 6, 0); // exhaust

    T.prism(
      [
        [1.0, 0.04],
        [1.1, 0.34],
        [0.5, 0.62],
        [-0.95, 0.62],
        [-1.1, 0.2],
        [-0.9, 0.0],
      ],
      [0.5, 0.56, 0.82, 0.9, 0.9, 0.84],
      tint,
    );
    const [my, mz] = gun(T, { y: 0.32, z: 1.05, len: 3.0, r: 0.045, sleeve: false });
    T.cyl(0.07, 0.7, 'z', { at: [0, 0.32, 1.35], ...tint }, 7, 1);
    T.both((s) => {
      T.cyl(0.16, 1.3, 'z', { at: [s * 1.05, 0.5, 0.0], rot: [-0.08, 0, 0], ...dark }, 8, 1);
      T.cyl(0.12, 0.06, 'z', { at: [s * 1.05, 0.55, 0.66], color: RUBBER }, 7, 0);
      T.box(0.2, 0.1, 0.5, { at: [s * 0.95, 0.4, -0.1], color: STEEL }, 0);
    });
    T.box(0.4, 0.3, 0.4, { at: [-0.4, 0.78, 0.2], ...dark }, 1);
    T.box(0.6, 0.03, 0.5, { at: [0.1, 0.635, -0.5], team: 1 }, 1);
    T.cyl(0.3, 0.08, 'y', { at: [0.4, 0.66, -0.1], ...dark }, 8, 0);
    aerial(T, 0.6, 0.6, -0.8, 2.0);
    return { turretY: 2.02, turretZ: 0.2, muzzleY: my, muzzleZ: mz };
  });
}

/**
 * The alliance's self-propelled gun: a tracked hull with the engine in front and, filling
 * the back two thirds of it, an enormous slab-sided gun house with a very long barrel.
 */
export function gunAlliance(): VehicleModel {
  return vehicle((_lod, H, T) => {
    tracks(H, { len: 7.4, wide: 0.56, high: 0.98, x: 1.42, wheels: 7, r: 0.33, rollers: true });
    H.prism(
      [
        [-3.7, 0.5],
        [-3.8, 1.7],
        [2.2, 1.7],
        [3.7, 1.15],
        [3.75, 0.85],
        [3.2, 0.42],
        [-3.3, 0.42],
      ],
      1.14,
      dark,
    );
    H.prism(
      [
        [-3.85, 1.0],
        [-3.85, 1.72],
        [2.15, 1.72],
        [3.6, 1.2],
        [3.7, 1.0],
      ],
      1.74,
      tint,
    );
    H.both((s) => {
      H.box(0.06, 0.5, 6.6, { at: [s * 1.76, 0.86, -0.2], ...tint }, 1);
      H.box(0.07, 0.2, 1.6, { at: [s * 1.77, 1.4, 1.2], team: 1 }, 1);
      H.box(0.2, 0.14, 0.1, { at: [s * 1.3, 1.36, 3.3], color: LAMP }, 0);
    });
    H.box(1.5, 0.04, 1.4, { at: [0.7, 1.74, 1.3], color: STEEL }, 0); // engine grilles
    H.cyl(0.3, 0.06, 'y', { at: [-0.9, 1.72, 1.9], ...dark }, 8, 0);
    // The travel lock that holds the barrel on the march, folded on the glacis.
    H.box(0.08, 0.08, 1.2, { at: [0.3, 1.52, 3.0], rot: [0.36, 0, 0], color: STEEL }, 0);
    H.box(0.08, 0.08, 1.2, { at: [-0.3, 1.52, 3.0], rot: [0.36, 0, 0], color: STEEL }, 0);

    T.prism(
      [
        [1.9, 0.02],
        [2.0, 0.8],
        [1.5, 1.42],
        [-2.3, 1.42],
        [-2.45, 0.3],
        [-2.3, 0.02],
      ],
      [1.5, 1.56, 1.62, 1.66, 1.66, 1.6],
      tint,
    );
    T.box(0.9, 0.9, 0.5, { at: [0, 0.75, 2.05], ...dark }, 1);
    const [my, mz] = gun(T, {
      y: 0.78,
      z: 2.2,
      len: 8.0,
      r: 0.1,
      pitch: 0.38,
      fume: 0.5,
      brake: 0.9,
    });
    T.both((s) => {
      T.box(0.2, 0.7, 1.6, { at: [s * 1.74, 0.7, -1.2], ...dark }, 1);
      T.box(0.22, 0.3, 0.9, { at: [s * 1.75, 0.8, -1.2], team: 1 }, 1);
      T.box(0.05, 0.3, 2.6, { at: [s * 1.7, 1.2, 0.2], color: STEEL }, 0);
    });
    T.box(1.6, 1.0, 0.06, { at: [0, 0.7, -2.5], ...dark }, 0); // rear doors
    T.cyl(0.42, 0.16, 'y', { at: [0.8, 1.5, 0.6], ...dark }, 9, 1);
    roofGun(T, 0.8, 1.5, 0.8, false, 0.2);
    T.cyl(0.36, 0.08, 'y', { at: [-0.8, 1.46, -0.6], ...dark }, 9, 0);
    T.box(0.4, 0.3, 0.4, { at: [-0.9, 1.56, 1.0], ...dark }, 0);
    T.box(1.4, 0.03, 1.2, { at: [0, 1.43, -1.5], team: 1 }, 1);
    aerial(T, 1.3, 1.42, -2.1, 2.6);
    aerial(T, -1.3, 1.42, -2.1, 1.8);
    return { turretY: 1.72, turretZ: -1.1, muzzleY: my, muzzleZ: mz };
  });
}

/**
 * Russia's: the tank's low hull under a big rounded gun house set in the middle, the
 * barrel ending in a fat two-chambered brake; a log and stowage as on everything Russian.
 */
export function gunRussia(): VehicleModel {
  return vehicle((_lod, H, T) => {
    tracks(H, { len: 6.9, wide: 0.58, high: 0.92, x: 1.4, wheels: 6, r: 0.37 });
    H.prism(
      [
        [-3.4, 0.5],
        [-3.5, 1.1],
        [2.0, 1.1],
        [3.5, 0.62],
        [3.1, 0.4],
        [-3.1, 0.4],
      ],
      1.12,
      dark,
    );
    H.prism(
      [
        [-3.55, 0.9],
        [-3.55, 1.14],
        [1.95, 1.14],
        [2.8, 0.9],
      ],
      1.72,
      tint,
    );
    H.both((s) => {
      H.box(0.05, 0.4, 5.6, { at: [s * 1.73, 0.74, -0.4], color: 0x24251f }, 1);
      H.box(0.06, 0.16, 1.2, { at: [s * 1.75, 0.84, -1.6], team: 1 }, 1);
      H.box(0.5, 0.2, 1.4, { at: [s * 1.42, 1.24, 1.0], ...dark }, 0);
      H.box(0.18, 0.16, 0.14, { at: [s * 0.9, 1.0, 2.8], color: LAMP }, 0);
    });
    H.cyl(0.13, 2.9, 'x', { at: [0, 0.76, -3.62], color: WOOD, cloth: true }, 7, 1);
    H.box(0.9, 0.5, 0.1, { at: [0, 1.0, 2.5], rot: [0.9, 0, 0], color: STEEL }, 0);

    T.prism(
      [
        [2.0, 0.04],
        [2.1, 0.6],
        [1.3, 1.25],
        [-1.9, 1.25],
        [-2.3, 0.7],
        [-2.2, 0.04],
      ],
      [1.2, 1.3, 1.36, 1.5, 1.52, 1.46],
      tint,
    );
    T.both((s) => {
      // The corners are cut off: plates leaning in from the sides to the roof.
      T.box(0.5, 0.06, 3.3, { at: [s * 1.34, 1.1, -0.2], rot: [0, 0, s * -0.75], ...tint }, 1);
      T.box(0.3, 0.5, 1.3, { at: [s * 1.62, 0.5, -1.0], ...dark }, 1);
      T.box(0.31, 0.24, 0.7, { at: [s * 1.63, 0.56, -1.0], team: 1 }, 1);
    });
    T.box(0.8, 0.8, 0.5, { at: [0, 0.62, 2.1], ...dark }, 1);
    const [my, mz] = gun(T, {
      y: 0.64,
      z: 2.2,
      len: 7.0,
      r: 0.095,
      pitch: 0.4,
      fume: 0.62,
      brake: 1.1,
    });
    T.cyl(0.44, 0.3, 'y', { at: [0.7, 1.4, 0.3], ...dark }, 9, 1);
    roofGun(T, 0.7, 1.5, 0.3, true, -0.2);
    T.box(0.6, 0.4, 2.4, { at: [-1.0, 1.4, -0.9], ...dark }, 1); // the loading conveyor's housing
    T.box(0.8, 0.03, 0.8, { at: [0.3, 1.26, -1.2], team: 1 }, 1);
    aerial(T, -1.2, 1.25, -1.9, 2.8);
    return { turretY: 1.14, turretZ: -0.5, muzzleY: my, muzzleZ: mz };
  });
}

/**
 * China's gun rides a six-wheeled lorry: an armoured cab in front and the bare gun on its
 * cradle over the back axles, with spades to dig in behind. Nothing else looks like it.
 */
export function gunChina(): VehicleModel {
  return vehicle((_lod, H, T) => {
    const { deck, cabBack } = lorry(H, {
      axles: [2.6, -1.1, -2.5],
      r: 0.64,
      back: -3.9,
      front: 3.9,
      cab: 'armour',
      cabLen: 2.4,
      roof: 3.0,
    });
    H.box(2.5, 0.2, cabBack + 3.9, { at: [0, deck + 0.1, (cabBack - 3.9) / 2], ...tint });
    H.box(2.4, 0.9, 1.3, { at: [0, deck + 0.65, cabBack - 0.8], ...tint }); // ammunition lockers
    H.box(2.42, 0.3, 0.7, { at: [0, deck + 0.7, cabBack - 0.8], team: 1 }, 1);
    H.both((s) => {
      // Spades folded up behind, their rams.
      H.box(0.7, 1.0, 0.1, { at: [s * 0.8, deck + 0.1, -4.1], rot: [0.5, 0, 0], color: STEEL }, 1);
      H.cyl(
        0.07,
        1.2,
        'z',
        { at: [s * 0.8, deck - 0.1, -3.6], rot: [0.3, 0, 0], color: STEEL },
        5,
        0,
      );
    });
    // The gun on its ring: cradle, recoil cylinders, a small shield, the layer's seat.
    T.cyl(0.9, 0.2, 'y', { at: [0, 0.1, 0], ...dark }, 10, 1);
    T.both((s) => {
      T.prism(
        [
          [-0.9, 0.2],
          [-0.6, 1.1],
          [0.5, 1.3],
          [0.9, 0.2],
        ],
        0.08,
        { at: [s * 0.5, 0, 0], ...tint },
      );
      T.cyl(0.09, 1.6, 'z', { at: [s * 0.24, 1.36, 0.9], rot: [-0.42, 0, 0], color: STEEL }, 6, 1);
    });
    T.box(0.9, 0.5, 1.5, { at: [0, 1.0, -0.1], rot: [-0.42, 0, 0], ...dark });
    const [my, mz] = gun(T, { y: 1.1, z: 0.3, len: 7.2, r: 0.095, pitch: 0.42, brake: 0.9 });
    T.box(0.5, 0.7, 0.06, { at: [-0.85, 1.3, 0.5], ...tint }, 1);
    T.box(0.3, 0.3, 0.3, { at: [-0.85, 0.9, -0.3], color: 0x33342a, cloth: true }, 0);
    T.box(0.5, 0.03, 0.9, { at: [0, 1.27, -0.3], rot: [-0.42, 0, 0], team: 1 }, 1);
    return { turretY: deck + 0.2, turretZ: -2.0, muzzleY: my, muzzleZ: mz };
  });
}

/** A radar dish on its post: a shallow bowl of the given half width, facing forward and up. */
function dish(
  P: Parts,
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  tiltBack = 0.25,
  keep = 1,
): void {
  P.box(
    w * 2,
    h * 2,
    0.08,
    { at: [x, y, z], rot: [-tiltBack, 0, 0], top: [0.8, 1], ...dark },
    keep,
  );
  P.box(w * 1.9, h * 0.2, 0.2, { at: [x, y, z - 0.08], rot: [-tiltBack, 0, 0], color: STEEL }, 0);
  P.box(0.14, 0.14, 0.5, { at: [x, y, z + 0.26], rot: [-tiltBack, 0, 0], color: STEEL }, 0);
}

/**
 * The alliance's air-defence vehicle: a tracked hull under a tall turret with a cannon
 * slung outside each cheek, a search dish folded up behind and a round tracker in front.
 */
export function adAlliance(): VehicleModel {
  return vehicle((_lod, H, T) => {
    tracks(H, { len: 7.0, wide: 0.56, high: 0.96, x: 1.38, wheels: 7, r: 0.31, rollers: true });
    H.prism(
      [
        [-3.5, 0.5],
        [-3.6, 1.5],
        [2.0, 1.5],
        [3.5, 1.0],
        [3.55, 0.8],
        [3.0, 0.42],
        [-3.1, 0.42],
      ],
      1.12,
      dark,
    );
    H.prism(
      [
        [-3.65, 0.98],
        [-3.65, 1.52],
        [1.95, 1.52],
        [3.4, 1.04],
        [3.5, 0.98],
      ],
      1.7,
      tint,
    );
    H.both((s) => {
      H.box(0.06, 0.5, 6.2, { at: [s * 1.72, 0.84, -0.2], ...tint }, 1);
      H.box(0.07, 0.2, 1.5, { at: [s * 1.73, 1.28, -1.4], team: 1 }, 1);
      H.box(0.2, 0.14, 0.1, { at: [s * 1.2, 1.24, 3.1], color: LAMP }, 0);
    });
    H.box(2.6, 0.04, 1.4, { at: [0, 1.54, -2.8], color: STEEL }, 0);

    T.prism(
      [
        [1.3, 0.02],
        [1.4, 0.9],
        [0.9, 1.3],
        [-1.4, 1.3],
        [-1.6, 0.4],
        [-1.4, 0.02],
      ],
      [1.0, 1.06, 1.1, 1.16, 1.16, 1.1],
      tint,
    );
    let muzzle: [number, number] = [0, 0];
    T.both((s) => {
      T.box(0.5, 0.7, 1.8, { at: [s * 1.42, 0.75, 0.2], rot: [-0.3, 0, 0], ...dark });
      T.box(0.52, 0.3, 0.8, { at: [s * 1.43, 0.75, -0.1], rot: [-0.3, 0, 0], team: 1 }, 1);
      muzzle = gun(T, {
        y: 1.05,
        z: 1.0,
        len: 3.4,
        r: 0.045,
        pitch: 0.3,
        x: s * 1.42,
        sleeve: false,
      });
      T.cyl(
        0.07,
        0.4,
        'z',
        { at: [s * 1.42, muzzle[0] - 0.06, muzzle[1] - 0.2], rot: [-0.3, 0, 0], color: STEEL },
        6,
        0,
      );
    });
    T.cyl(0.5, 0.14, 'z', { at: [0, 0.9, 1.45], rot: [-0.2, 0, 0], ...dark }, 10, 1); // tracker
    T.cyl(0.12, 0.3, 'z', { at: [0, 0.94, 1.6], rot: [-0.2, 0, 0], color: STEEL }, 6, 0);
    T.box(0.16, 0.9, 0.16, { at: [0, 1.7, -1.3], color: STEEL }, 1);
    dish(T, 0, 2.2, -1.3, 0.95, 0.42, 0.15);
    T.box(0.9, 0.03, 0.9, { at: [0, 1.31, -0.4], team: 1 }, 1);
    aerial(T, 0.9, 1.3, -1.2, 1.8);
    return { turretY: 1.52, turretZ: 0, muzzleY: muzzle[0], muzzleZ: muzzle[1] };
  });
}

/**
 * Russia's: guns and missiles on one turret. A cluster of four missile tubes above twin
 * cannon on each side, a broad search antenna standing up at the back, a tracking cone in
 * front.
 */
export function adRussia(): VehicleModel {
  return vehicle((_lod, H, T) => {
    tracks(H, { len: 7.2, wide: 0.52, high: 0.94, x: 1.38, wheels: 6, r: 0.33, rollers: true });
    H.prism(
      [
        [-3.6, 0.5],
        [-3.7, 1.3],
        [2.4, 1.3],
        [3.65, 0.8],
        [3.2, 0.42],
        [-3.2, 0.42],
      ],
      1.12,
      dark,
    );
    H.prism(
      [
        [-3.75, 0.96],
        [-3.75, 1.34],
        [2.35, 1.34],
        [3.2, 0.96],
      ],
      1.68,
      tint,
    );
    H.both((s) => {
      H.box(0.34, 0.05, 6.8, { at: [s * 1.44, 0.98, -0.1], ...dark }, 1);
      H.box(0.05, 0.2, 1.5, { at: [s * 1.7, 1.16, -1.6], team: 1 }, 1);
      H.cyl(0.11, 0.1, 'z', { at: [s * 1.0, 1.1, 3.0], color: LAMP }, 6, 0);
      H.box(0.5, 0.2, 1.4, { at: [s * 1.4, 1.44, -2.6], ...dark }, 0);
    });

    T.prism(
      [
        [1.5, 0.02],
        [1.6, 0.5],
        [1.0, 1.0],
        [-1.7, 1.0],
        [-1.9, 0.4],
        [-1.7, 0.02],
      ],
      [0.9, 0.96, 1.0, 1.1, 1.1, 1.04],
      tint,
    );
    let muzzle: [number, number] = [0, 0];
    T.both((s) => {
      // Four tubes in a block, then the guns under and outside them.
      for (let k = 0; k < 4; k++) {
        const x = s * (1.3 + (k & 1) * 0.34);
        const y = 0.95 + (k >> 1) * 0.34;
        T.cyl(
          0.15,
          2.9,
          'z',
          { at: [x, y + 0.3, 0.2], rot: [-0.34, 0, 0], ...dark },
          7,
          k === 3 ? 2 : 1,
        );
        T.cyl(
          0.13,
          0.05,
          'z',
          { at: [x, y + 0.79, 1.58], rot: [-0.34, 0, 0], color: RUBBER },
          6,
          0,
        );
      }
      T.box(0.6, 0.5, 1.1, { at: [s * 1.44, 0.5, 0.1], ...dark }, 1);
      T.box(0.62, 0.2, 0.6, { at: [s * 1.45, 0.5, 0.0], team: 1 }, 1);
      for (const dx of [-0.1, 0.1])
        muzzle = gun(T, {
          y: 0.5,
          z: 0.6,
          len: 2.9,
          r: 0.035,
          pitch: 0.2,
          x: s * (1.5 + dx),
          sleeve: false,
        });
    });
    T.cyl(0.42, 0.9, 'z', { at: [0, 0.7, 1.5], rot: [-0.2, 0, 0], ...tint }, 9, 1, 0.2); // tracking cone
    T.box(0.2, 1.0, 0.2, { at: [0, 1.4, -1.5], color: STEEL }, 1);
    dish(T, 0, 2.3, -1.5, 1.3, 0.34, 0.1);
    T.box(0.8, 0.03, 0.8, { at: [0, 1.01, -0.5], team: 1 }, 1);
    return { turretY: 1.34, turretZ: -0.1, muzzleY: muzzle[0], muzzleZ: muzzle[1] };
  });
}

/**
 * China's: a six-wheeled armoured lorry with a small turret, a six-barrelled gun on one
 * cheek, four missile tubes on the other and a radar dome on top.
 */
export function adChina(): VehicleModel {
  return vehicle((_lod, H, T) => {
    const { deck, cabBack } = lorry(H, {
      axles: [2.5, -1.0, -2.4],
      r: 0.62,
      back: -3.7,
      front: 3.8,
      cab: 'armour',
      cabLen: 2.3,
      roof: 2.9,
    });
    H.prism(
      [
        [-3.75, deck - 0.1],
        [-3.75, deck + 1.0],
        [cabBack - 0.1, deck + 1.0],
        [cabBack - 0.1, deck - 0.1],
      ],
      [1.25, 1.12, 1.12, 1.25],
      tint,
    );
    H.both((s) => {
      H.box(0.05, 0.3, 1.6, { at: [s * 1.2, deck + 0.4, -2.0], rot: [0, 0, s * 0.12], team: 1 }, 1);
      H.box(0.5, 0.4, 0.9, { at: [s * 0.9, deck + 0.2, -3.9], color: STEEL }, 0); // jacks
    });

    T.prism(
      [
        [1.0, 0.02],
        [1.1, 0.5],
        [0.6, 0.86],
        [-1.1, 0.86],
        [-1.25, 0.3],
        [-1.1, 0.02],
      ],
      [0.6, 0.64, 0.7, 0.8, 0.8, 0.74],
      tint,
    );
    // The gun: six barrels round a hub, in a cradle on the right cheek.
    T.box(0.5, 0.56, 1.3, { at: [-0.95, 0.5, 0.2], rot: [-0.25, 0, 0], ...dark });
    T.cyl(0.14, 2.3, 'z', { at: [-0.95, 0.94, 1.7], rot: [-0.25, 0, 0], color: STEEL }, 8);
    T.cyl(0.17, 0.12, 'z', { at: [-0.95, 1.2, 2.72], rot: [-0.25, 0, 0], color: RUBBER }, 8, 0);
    T.cyl(0.17, 0.12, 'z', { at: [-0.95, 0.86, 1.4], rot: [-0.25, 0, 0], color: RUBBER }, 8, 0);
    // Four missiles in a box on the left.
    T.box(0.6, 0.6, 1.9, { at: [1.0, 0.7, 0.2], rot: [-0.25, 0, 0], ...dark });
    T.box(0.5, 0.5, 0.04, { at: [1.0, 0.94, 1.13], rot: [-0.25, 0, 0], color: RUBBER }, 0);
    T.box(0.62, 0.24, 0.8, { at: [1.01, 0.7, 0.1], rot: [-0.25, 0, 0], team: 1 }, 1);
    T.fuselage(
      [
        { z: -0.34, w: 0.1, h: 0.1, y: 1.26 },
        { z: -0.22, w: 0.3, h: 0.24, y: 1.26 },
        { z: 0, w: 0.36, h: 0.3, y: 1.26 },
        { z: 0.22, w: 0.3, h: 0.24, y: 1.26 },
        { z: 0.34, w: 0.1, h: 0.1, y: 1.26 },
      ],
      { seg: 8, color: under(0x6f736b, 3) },
      1,
    );
    T.box(0.12, 0.3, 0.12, { at: [0, 0.98, 0], color: STEEL }, 0);
    T.box(0.5, 0.03, 0.5, { at: [0, 0.87, -0.7], team: 1 }, 1);
    return { turretY: deck + 1.0, turretZ: -1.9, muzzleY: 1.26, muzzleZ: 2.8 };
  });
}

/**
 * The alliance's jammer is a light one (decision 131): a four-wheeled armoured car with a
 * short mast of ring aerials on the roof.
 */
export function jammerAlliance(): VehicleModel {
  return vehicle((_lod, H, T) => {
    wheels(H, [1.9, -1.9], 1.08, 0.56, 0.4);
    H.prism(
      [
        [-2.9, 0.75],
        [-3.0, 1.5],
        [-2.8, 2.55],
        [0.5, 2.55],
        [1.3, 1.75],
        [3.0, 1.55],
        [3.1, 1.0],
        [2.6, 0.7],
      ],
      [1.14, 1.2, 1.02, 1.02, 1.16, 1.12, 1.1, 1.0],
      tint,
    );
    H.both((s) => {
      H.box(0.72, 0.46, 0.05, { at: [s * 0.44, 2.14, 0.9], rot: [-0.78, 0, 0], color: GLASS }, 1);
      H.box(0.05, 0.4, 0.9, { at: [s * 1.1, 2.15, -0.2], rot: [0, 0, s * 0.16], color: GLASS }, 1);
      H.box(0.05, 0.4, 0.7, { at: [s * 1.1, 2.15, -1.3], rot: [0, 0, s * 0.16], color: GLASS }, 0);
      H.box(0.05, 0.24, 1.2, { at: [s * 1.19, 1.3, -1.0], team: 1 }, 1);
      H.box(0.24, 0.16, 0.08, { at: [s * 0.8, 1.4, 3.06], color: LAMP }, 0);
      H.box(0.5, 0.08, 1.5, { at: [s * 1.1, 1.2, 1.9], ...dark }, 0);
    });
    H.box(1.6, 0.4, 0.05, { at: [0, 1.25, 3.08], color: STEEL }, 0);
    H.box(1.4, 0.7, 0.3, { at: [0, 1.6, -3.1], color: 0x4a4b38, cloth: true }, 1);

    // The mast: three ring aerials, smaller as they go up, and two whips.
    T.cyl(0.3, 0.3, 'y', { at: [0, 0.15, 0], ...dark }, 8, 1);
    T.cyl(0.07, 2.6, 'y', { at: [0, 1.3, 0], color: STEEL }, 6);
    for (let k = 0; k < 3; k++) {
      T.cyl(0.62 - k * 0.14, 0.08, 'y', { at: [0, 1.2 + k * 0.6, 0], color: RUBBER }, 10, 1);
      T.box(1.24 - k * 0.28, 0.04, 0.04, { at: [0, 1.2 + k * 0.6, 0], color: STEEL }, 0);
    }
    T.cyl(0.14, 0.3, 'y', { at: [0, 2.7, 0], team: 1 }, 7, 1);
    aerial(T, 0.5, 0.0, -0.4, 2.2);
    aerial(T, -0.5, 0.0, -0.4, 2.2);
    return { turretY: 2.55, turretZ: -1.5, muzzleY: 0, muzzleZ: 0 };
  });
}

/**
 * Russia's jammer: the heaviest thing on wheels. An eight-wheeled carrier with a low cab,
 * a long equipment shelter, and on the roof two great dishes on a turning frame.
 */
export function jammerRussia(): VehicleModel {
  return vehicle((_lod, H, T) => {
    const { deck, cabBack } = lorry(H, {
      axles: [3.3, 1.8, -1.6, -3.1],
      r: 0.66,
      back: -4.3,
      front: 4.5,
      cab: 'over',
      cabLen: 1.9,
      roof: 2.75,
    });
    H.prism(
      [
        [-4.35, deck],
        [-4.35, deck + 1.75],
        [cabBack - 0.2, deck + 1.75],
        [cabBack - 0.2, deck],
      ],
      [1.3, 1.24, 1.24, 1.3],
      tint,
    );
    H.both((s) => {
      H.box(0.06, 0.9, 1.0, { at: [s * 1.29, deck + 0.8, -0.2], ...dark }, 0); // doors
      H.box(0.06, 0.3, 1.8, { at: [s * 1.3, deck + 1.3, -2.6], team: 1 }, 1);
      H.box(0.4, 0.5, 1.4, { at: [s * 1.1, deck - 0.5, 0.1], ...dark }, 1); // lockers between the axles
    });
    H.box(1.2, 0.5, 0.9, { at: [0, deck + 2.0, -3.6], ...dark }, 1); // generator

    T.cyl(0.6, 0.3, 'y', { at: [0, 0.15, 0], ...dark }, 9, 1);
    T.box(0.3, 1.2, 0.3, { at: [0, 0.8, 0], color: STEEL });
    T.box(3.4, 0.2, 0.2, { at: [0, 1.3, 0], color: STEEL }, 1);
    T.both((s) => {
      // A dish: a shallow bowl in rings, the feed horn on struts in front of it.
      T.cyl(1.25, 0.4, 'z', { at: [s * 1.5, 1.6, 0.1], rot: [-0.35, 0, 0], ...tint }, 12, 2, 0.4);
      T.cyl(
        1.2,
        0.04,
        'z',
        { at: [s * 1.5, 1.67, 0.3], rot: [-0.35, 0, 0], color: under(0x8b8f86, 2) },
        12,
        1,
      );
      T.cyl(0.12, 0.2, 'z', { at: [s * 1.5, 1.9, 0.95], rot: [-0.35, 0, 0], color: STEEL }, 6, 0);
      for (const a of [0.5, 2.6, 4.7])
        T.box(
          0.03,
          0.03,
          0.9,
          {
            at: [s * 1.5 + Math.cos(a) * 0.4, 1.78 + Math.sin(a) * 0.4, 0.62],
            rot: [-0.35, 0, 0],
            color: STEEL,
          },
          0,
        );
    });
    T.box(0.5, 0.3, 0.03, { at: [0, 1.0, 0.16], team: 1 }, 1);
    return { turretY: deck + 1.75, turretZ: -1.4, muzzleY: 0, muzzleZ: 0 };
  });
}

/** China's jammer: a six-wheeled lorry with a shelter and a tall mast of comb aerials. */
export function jammerChina(): VehicleModel {
  return vehicle((_lod, H, T) => {
    const { deck, cabBack } = lorry(H, {
      axles: [2.6, -1.2, -2.6],
      r: 0.62,
      back: -3.8,
      front: 3.8,
      cab: 'over',
      cabLen: 2.1,
      roof: 3.0,
    });
    H.box(2.46, 1.7, cabBack + 3.6, { at: [0, deck + 0.85, (cabBack - 3.9) / 2 + 0.1], ...tint });
    H.both((s) => {
      H.box(0.05, 0.36, 1.6, { at: [s * 1.25, deck + 1.2, -2.0], team: 1 }, 1);
      H.box(0.05, 1.0, 0.7, { at: [s * 1.24, deck + 0.7, -0.2], ...dark }, 0);
      H.box(0.3, 0.3, 0.9, { at: [s * 0.9, deck + 1.85, -3.0], ...dark }, 0);
    });
    H.box(0.9, 1.3, 0.05, { at: [0, deck + 0.8, -3.76], ...dark }, 0);

    // The mast: a lattice post, three combs of rods across it, each turned from the last.
    T.cyl(0.4, 0.3, 'y', { at: [0, 0.15, 0], ...dark }, 8, 1);
    T.box(0.16, 4.2, 0.16, { at: [0, 2.1, 0], color: STEEL });
    for (let k = 0; k < 3; k++) {
      const y = 1.9 + k * 1.0;
      const yaw = k * 1.05;
      T.box(0.07, 0.07, 2.4 - k * 0.5, { at: [0, y, 0], rot: [0, yaw, 0], color: STEEL }, 1);
      for (let j = -3; j <= 3; j++) {
        const along = j * (0.34 - k * 0.07);
        T.box(
          1.5 - Math.abs(j) * 0.16,
          0.035,
          0.035,
          {
            at: [Math.sin(yaw) * along, y, Math.cos(yaw) * along],
            rot: [0, yaw, 0],
            color: RUBBER,
          },
          j % 3 === 0 ? 1 : 0,
        );
      }
    }
    T.cyl(0.16, 0.3, 'y', { at: [0, 4.3, 0], team: 1 }, 7, 1);
    return { turretY: deck + 1.7, turretZ: -1.6, muzzleY: 0, muzzleZ: 0 };
  });
}
