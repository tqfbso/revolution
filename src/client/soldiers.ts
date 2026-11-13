// Foot soldiers: a jointed figure posed on the CPU and drawn as instanced parts.
//
// A man is a handful of rigid pieces (torso, head, thighs, shins, arms, rifle). Each frame a
// pose is blended from a few key stances, the joints are placed from it, and every piece
// goes to its own instanced batch with a full frame. That keeps soldiers on exactly the
// same material, shadow and upload path as the vehicles: nothing new for the GPU to get
// wrong, at the price of a few thousand small matrix writes a frame.
//
// The figure is modelled in metres at true proportions and scaled to the map, where a man
// stands a little taller than scale so he reads from an RTS camera. Forward is +Z, his
// right is -X, the origin is the ground under his hips.
import type * as THREE from 'three/webgpu';
import type { Batch } from './batch';
import { box, merge } from './models';

/** The colours of one army's kit. Build the rig with another to dress another faction. */
export interface Uniform {
  cloth: number;
  vest: number;
  pack: number;
  helmet: number;
  boots: number;
  gloves: number;
  skin: number;
  weapon: number;
}

/** No nation's pattern: worn olive drab cloth, darker webbing, black rifle. */
export const NEUTRAL: Uniform = {
  cloth: 0x6a6a4c,
  vest: 0x494c38,
  pack: 0x505238,
  helmet: 0x555a42,
  boots: 0x1b1a18,
  gloves: 0x2a2b26,
  skin: 0x9a7a62,
  weapon: 0x17181a,
};

/** Map units per metre of soldier: 1.8 m of man stands 0.62 units tall. */
const S = 0.62 / 1.8;
const THIGH = 0.44;
const SHIN = 0.48;
const NECK = 0.52;
const SHOULDER = 0.46;
const SHOULDER_X = 0.2;
const HIP_X = 0.09;
const UPPER = 0.29;
const FORE = 0.3;
/** Where the support hand holds the rifle, and where the muzzle is, ahead of the grip. */
const HANDGUARD = 0.2;
const MUZZLE = 0.62;

// A key stance: lean, left thigh, left knee, right thigh, right knee, head, then the rifle
// grip (x, height above the hips, z), the rifle's pitch, and the lowest the hips may sit.
// Angles are radians; a thigh swings forward for positive values, a knee only folds back.
const STAND_READY = [0.05, 0.06, 0.1, -0.06, 0.1, 0.05, -0.04, 0.26, 0.24, -0.5, 0];
const STAND_FIRE = [0.14, 0.28, 0.3, -0.22, 0.12, 0.1, -0.12, 0.47, 0.27, 0, 0];
const RUN = [0.3, 0, 0.25, 0, 0.25, 0.12, -0.05, 0.28, 0.24, -0.3, 0];
const KNEEL_READY = [0.12, 1.6, 1.75, -0.1, 1.7, 0.05, -0.05, 0.2, 0.3, -0.45, 0];
const KNEEL_FIRE = [0.22, 1.6, 1.75, -0.1, 1.7, 0.12, -0.12, 0.42, 0.3, 0, 0];
const PRONE_READY = [1.42, -1.5, 0.05, -1.5, 0.05, 0.55, -0.12, 0.02, 0.62, 0, 0.13];
const PRONE_FIRE = [1.4, -1.5, 0.05, -1.38, 0.18, 0.5, -0.12, 0.05, 0.66, 0.02, 0.13];
const FIELDS = STAND_READY.length;

/** The most men drawn in full detail at once; the rest of a crowd falls to the simple figure. */
export const NEAR_MEN = 4096;
export const FAR_MEN = 20000;

/** Builds one batch for a piece of the figure at a level of detail. */
export type MakeBatch = (g: THREE.BufferGeometry, capacity: number, lod: number) => Batch;

export class Soldiers {
  /** Where the last man's muzzle is and which way it points, for the flash. */
  readonly muzzle = new Float32Array(5);
  private readonly torso: Batch;
  private readonly head: Batch;
  private readonly thigh: Batch;
  private readonly shin: Batch;
  private readonly upper: Batch;
  private readonly fore: Batch;
  private readonly rifle: Batch;
  private readonly body1: Batch;
  private readonly thigh1: Batch;
  private readonly shin1: Batch;
  private readonly rifle1: Batch;
  private readonly p = new Float32Array(FIELDS);
  private readonly f = new Float32Array(12);
  private ox = 0;
  private oy = 0;
  private oz = 0;
  private sin = 0;
  private cos = 1;
  private r = 0;
  private g = 0;
  private b = 0;
  private a = 0;

  constructor(make: MakeBatch, u: Uniform = NEUTRAL) {
    const m = buildParts(u);
    this.torso = make(m.torso, NEAR_MEN, 0);
    this.head = make(m.head, NEAR_MEN, 0);
    this.thigh = make(m.thigh, NEAR_MEN * 2, 0);
    this.shin = make(m.shin, NEAR_MEN * 2, 0);
    this.upper = make(m.upper, NEAR_MEN * 2, 0);
    this.fore = make(m.fore, NEAR_MEN * 2, 0);
    this.rifle = make(m.rifle, NEAR_MEN, 0);
    this.body1 = make(m.body1, FAR_MEN, 1);
    this.thigh1 = make(m.thigh1, FAR_MEN * 2, 1);
    this.shin1 = make(m.shin1, FAR_MEN * 2, 1);
    this.rifle1 = make(m.rifle1, FAR_MEN, 1);
  }

  /** Whether another man fits at full detail this frame. */
  get roomNear(): boolean {
    return this.torso.n < NEAR_MEN;
  }

  /** Triangles in one man at each level of detail. */
  triangles(): [number, number] {
    const t = (b: Batch) => (b.mesh.geometry.index?.count ?? 0) / 3;
    return [
      t(this.torso) +
        t(this.head) +
        2 * (t(this.thigh) + t(this.shin) + t(this.upper) + t(this.fore)) +
        t(this.rifle),
      t(this.body1) + 2 * (t(this.thigh1) + t(this.shin1)) + t(this.rifle1),
    ];
  }

  /**
   * Draw one man standing at (x, y, z) facing (sin, cos). `kneel`, `prone`, `run` and `aim`
   * are 0 to 1 and blend the stance; `stride` is where he is in his step; `kick` is recoil.
   */
  man(
    lod: number,
    x: number,
    y: number,
    z: number,
    sin: number,
    cos: number,
    kneel: number,
    prone: number,
    run: number,
    aim: number,
    stride: number,
    kick: number,
    r: number,
    g: number,
    b: number,
    a: number,
  ): void {
    this.ox = x;
    this.oy = y;
    this.oz = z;
    this.sin = sin;
    this.cos = cos;
    this.r = r;
    this.g = g;
    this.b = b;
    this.a = a;

    // Blend the stance. Prone wins over kneeling, kneeling over standing; running only
    // counts on his feet.
    const wP = prone;
    const wK = kneel * (1 - prone);
    const wS = 1 - wP - wK;
    const go = run * wS;
    const p = this.p;
    for (let k = 0; k < FIELDS; k++) {
      const stand = STAND_READY[k] + (STAND_FIRE[k] - STAND_READY[k]) * aim;
      p[k] =
        wS * (stand + (RUN[k] - stand) * run) +
        wK * (KNEEL_READY[k] + (KNEEL_FIRE[k] - KNEEL_READY[k]) * aim) +
        wP * (PRONE_READY[k] + (PRONE_FIRE[k] - PRONE_READY[k]) * aim);
    }
    const swing = Math.sin(stride);
    const lift = Math.cos(stride);
    const lean = p[0];
    const thL = p[1] + 0.75 * swing * go;
    const knL = p[2] + 0.9 * (lift > 0 ? lift : 0) * go;
    const thR = p[3] - 0.75 * swing * go;
    const knR = p[4] + 0.9 * (lift < 0 ? -lift : 0) * go;

    // The hips sit as low as the lowest knee or foot allows, so feet stay on the ground
    // through a stride and a knee meets it when he kneels.
    const kneeL = THIGH * Math.cos(thL);
    const kneeR = THIGH * Math.cos(thR);
    const footL = kneeL + SHIN * Math.cos(thL - knL);
    const footR = kneeR + SHIN * Math.cos(thR - knR);
    const hy = Math.max(p[10], kneeL + 0.06, kneeR + 0.06, footL, footR);
    const hz = -0.3 * wP;

    const sl = Math.sin(lean);
    const cl = Math.cos(lean);
    const neckY = hy + NECK * cl;
    const neckZ = hz + NECK * sl;
    const shY = hy + SHOULDER * cl;
    const shZ = hz + SHOULDER * sl;

    // The rifle: held where the stance says, bobbing a little on the run, kicked back on a shot.
    const pitch = p[9] + 0.05 * swing * go;
    const sp = Math.sin(pitch);
    const cp = Math.cos(pitch);
    const gx = p[6];
    const gy = hy + p[7] + (0.02 * lift * go - kick * sp);
    const gz = hz + p[8] - kick * cp;
    const mz = this.muzzle;
    mz[0] = x + (gx * cos + (gz + MUZZLE * cp) * sin) * S;
    mz[1] = y + (gy + MUZZLE * sp + 0.035) * S;
    mz[2] = z + (-gx * sin + (gz + MUZZLE * cp) * cos) * S;
    mz[3] = sin;
    mz[4] = cos;

    if (lod === 0) {
      this.sag(this.torso, 0, hy, hz, -lean);
      this.sag(this.head, 0, neckY, neckZ, -p[5]);
      this.leg(this.thigh, this.shin, HIP_X, hy, hz, thL, knL);
      this.leg(this.thigh, this.shin, -HIP_X, hy, hz, thR, knR);
      this.sag(this.rifle, gx, gy, gz, pitch);
      // Trigger hand on the grip, support hand out on the handguard.
      this.reach(-1, shY, shZ, gx, gy - 0.02, gz, wP);
      this.reach(1, shY, shZ, gx, gy + HANDGUARD * sp, gz + HANDGUARD * cp, wP);
    } else {
      this.sag(this.body1, 0, hy, hz, -lean);
      this.leg(this.thigh1, this.shin1, HIP_X, hy, hz, thL, knL);
      this.leg(this.thigh1, this.shin1, -HIP_X, hy, hz, thR, knR);
      this.sag(this.rifle1, gx, gy, gz, pitch);
    }
  }

  /** A thigh from the hip and a shin from the knee it ends at. */
  private leg(
    thigh: Batch,
    shin: Batch,
    x: number,
    hy: number,
    hz: number,
    a: number,
    knee: number,
  ): void {
    this.sag(thigh, x, hy, hz, a);
    this.sag(shin, x, hy - THIGH * Math.cos(a), hz + THIGH * Math.sin(a), a - knee);
  }

  /** A piece turned only in the fore-and-aft plane: its down swings forward by `a`. */
  private sag(b: Batch, jx: number, jy: number, jz: number, a: number): void {
    const s = Math.sin(a);
    const c = Math.cos(a);
    this.put(b, jx, jy, jz, 1, 0, 0, 0, c, -s, 0, s, c);
  }

  /** An arm from its shoulder to a hand position: two bones, the elbow out of the way. */
  private reach(
    side: number,
    shY: number,
    shZ: number,
    tx: number,
    ty: number,
    tz: number,
    prone: number,
  ): void {
    const sx = side * SHOULDER_X;
    let nx = tx - sx;
    let ny = ty - shY;
    let nz = tz - shZ;
    const len = Math.hypot(nx, ny, nz) || 1e-6;
    const d = Math.min(Math.max(len, 0.08), UPPER + FORE - 0.005);
    nx /= len;
    ny /= len;
    nz /= len;
    // The elbow points down and out when he is up, flat out to the side when he lies.
    let ex = side * (0.5 + prone);
    let ey = -1 + 0.9 * prone;
    let ez = -0.3 * (1 - prone);
    const along = ex * nx + ey * ny + ez * nz;
    ex -= along * nx;
    ey -= along * ny;
    ez -= along * nz;
    const el = Math.hypot(ex, ey, ez) || 1e-6;
    const reachAlong = (UPPER * UPPER - FORE * FORE + d * d) / (2 * d);
    const out = Math.sqrt(Math.max(0, UPPER * UPPER - reachAlong * reachAlong)) / el;
    const kx = nx * reachAlong + ex * out;
    const ky = ny * reachAlong + ey * out;
    const kz = nz * reachAlong + ez * out;
    this.bone(this.upper, sx, shY, shZ, kx / UPPER, ky / UPPER, kz / UPPER);
    const hx = nx * d - kx;
    const hyy = ny * d - ky;
    const hzz = nz * d - kz;
    const hl = Math.hypot(hx, hyy, hzz) || 1e-6;
    this.bone(this.fore, sx + kx, shY + ky, shZ + kz, hx / hl, hyy / hl, hzz / hl);
  }

  /** A piece whose length runs from its joint along the unit vector (dx, dy, dz). */
  private bone(b: Batch, jx: number, jy: number, jz: number, dx: number, dy: number, dz: number) {
    const yx = -dx;
    const yy = -dy;
    const yz = -dz;
    // Sideways axis: square to the bone and to forward, or to up when the bone runs forward.
    let xx = yy;
    let xy = -yx;
    let xz = 0;
    let l = Math.hypot(xx, xy);
    if (l < 0.2) {
      xx = -yz;
      xy = 0;
      xz = yx;
      l = Math.hypot(xx, xz);
      if (yz > 0) {
        xx = -xx;
        xz = -xz;
      }
    }
    xx /= l;
    xy /= l;
    xz /= l;
    this.put(
      b,
      jx,
      jy,
      jz,
      xx,
      xy,
      xz,
      yx,
      yy,
      yz,
      xy * yz - xz * yy,
      xz * yx - xx * yz,
      xx * yy - xy * yx,
    );
  }

  /** Write one piece: a joint and three axes in the man's own frame, turned and placed. */
  private put(
    b: Batch,
    jx: number,
    jy: number,
    jz: number,
    xx: number,
    xy: number,
    xz: number,
    yx: number,
    yy: number,
    yz: number,
    zx: number,
    zy: number,
    zz: number,
  ): void {
    const f = this.f;
    const s = this.sin;
    const c = this.cos;
    f[0] = (xx * c + xz * s) * S;
    f[1] = xy * S;
    f[2] = (xz * c - xx * s) * S;
    f[3] = (yx * c + yz * s) * S;
    f[4] = yy * S;
    f[5] = (yz * c - yx * s) * S;
    f[6] = (zx * c + zz * s) * S;
    f[7] = zy * S;
    f[8] = (zz * c - zx * s) * S;
    f[9] = this.ox + (jx * c + jz * s) * S;
    f[10] = this.oy + jy * S;
    f[11] = this.oz + (jz * c - jx * s) * S;
    b.frame(f, this.r, this.g, this.b, this.a);
  }
}

/** The pieces of the figure, in metres, each with its joint at the origin. */
function buildParts(u: Uniform) {
  const torso = merge([
    box(0.32, 0.18, 0.2, { at: [0, 0.07, 0], color: u.cloth }),
    box(0.345, 0.05, 0.225, { at: [0, 0.15, 0], color: u.vest }), // belt
    box(0.37, 0.34, 0.2, { at: [0, 0.34, 0], top: [1.08, 1], color: u.cloth }),
    box(0.4, 0.3, 0.27, { at: [0, 0.33, 0.005], color: u.vest }), // plate carrier
    box(0.3, 0.11, 0.06, { at: [0, 0.26, 0.16], color: u.pack }), // magazine pouches
    box(0.1, 0.09, 0.07, { at: [0.13, 0.4, 0.15], color: u.gloves }), // radio
    box(0.3, 0.36, 0.15, { at: [0, 0.36, -0.2], top: [0.9, 0.8], color: u.pack }),
    box(0.26, 0.1, 0.13, { at: [0, 0.58, -0.19], color: u.cloth }), // bedroll
    box(0.49, 0.08, 0.2, { at: [0, 0.47, 0], color: u.cloth }), // shoulders
    box(0.03, 0.09, 0.1, { at: [0.25, 0.44, 0], team: 1 }), // shoulder patches
    box(0.03, 0.09, 0.1, { at: [-0.25, 0.44, 0], team: 1 }),
  ]);
  const head = merge([
    box(0.11, 0.08, 0.11, { at: [0, 0.03, 0], color: u.skin }),
    box(0.15, 0.17, 0.17, { at: [0, 0.14, 0.005], color: u.skin }),
    box(0.215, 0.11, 0.25, { at: [0, 0.235, -0.005], top: [0.78, 0.8], color: u.helmet }),
    box(0.22, 0.09, 0.17, { at: [0, 0.16, -0.05], color: u.helmet, team: 0.12 }), // ear and nape
    box(0.13, 0.04, 0.03, { at: [0, 0.2, 0.12], color: u.weapon }), // goggles on the brow
  ]);
  const thigh = merge([
    box(0.155, THIGH, 0.175, { at: [0, -THIGH / 2, 0], top: [1.08, 1.08], color: u.cloth }),
    box(0.175, 0.14, 0.11, { at: [0, -0.24, -0.01], color: u.cloth }), // cargo pocket
  ]);
  const shin = merge([
    box(0.125, 0.36, 0.14, { at: [0, -0.18, 0], color: u.cloth }),
    box(0.135, 0.11, 0.05, { at: [0, -0.03, 0.075], color: u.vest }), // knee pad
    box(0.125, 0.13, 0.28, { at: [0, -0.415, 0.055], color: u.boots }),
  ]);
  const upper = box(0.105, UPPER + 0.04, 0.115, { at: [0, -UPPER / 2, 0], color: u.cloth });
  const fore = merge([
    box(0.088, 0.24, 0.095, { at: [0, -0.11, 0], color: u.cloth }),
    box(0.085, 0.1, 0.1, { at: [0, -0.27, 0], color: u.gloves }),
  ]);
  // Thicker than a real rifle so it does not vanish at arm's length from the camera.
  const rifle = merge([
    box(0.05, 0.075, 0.3, { at: [0, 0.03, 0.05], color: u.weapon }),
    box(0.045, 0.065, 0.24, { at: [0, 0.015, -0.2], color: u.weapon }),
    box(0.042, 0.05, 0.3, { at: [0, 0.035, 0.33], color: 0x2b2e2c }),
    box(0.024, 0.024, 0.16, { at: [0, 0.04, 0.54], color: u.weapon }),
    box(0.035, 0.15, 0.065, { at: [0, -0.075, 0.1], rot: [0.2, 0, 0], color: u.weapon }),
    box(0.035, 0.045, 0.1, { at: [0, 0.09, 0.04], color: 0x2b2e2c }),
  ]);

  const body1 = merge([
    box(0.36, 0.5, 0.2, { at: [0, 0.25, 0], color: u.cloth }),
    box(0.4, 0.34, 0.42, { at: [0, 0.35, -0.07], color: u.vest, team: 0.1 }),
    box(0.21, 0.26, 0.23, { at: [0, 0.66, 0], color: u.helmet, team: 0.3 }),
  ]);
  const thigh1 = box(0.16, THIGH, 0.17, { at: [0, -THIGH / 2, 0], color: u.cloth });
  const shin1 = box(0.13, SHIN, 0.17, { at: [0, -SHIN / 2, 0.015], color: u.cloth });
  const rifle1 = box(0.05, 0.08, 0.95, { at: [0, 0.03, 0.14], color: u.weapon });
  return { torso, head, thigh, shin, upper, fore, rifle, body1, thigh1, shin1, rifle1 };
}
