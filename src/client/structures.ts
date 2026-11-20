import { weathered } from './weather';
import { ME } from './me';
import * as THREE from 'three/webgpu';
import {
  attribute,
  float,
  hash,
  mix,
  positionWorld,
  screenCoordinate,
  smoothstep,
  step,
  uniform,
  texture,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { fromFx } from '../sim/fixed';
import { BUILDINGS, B_BARRACKS, B_DEPOT, B_DRONES, B_HELIPAD, B_HQ, B_WORKS } from '../sim/economy';
import {
  FLOOR_HEIGHT,
  MAP_CELLS,
  MAP_SIZE,
  MAX_SITES,
  MAX_STRUCTS,
  BUILD_HALL,
  BUILD_HOUSE,
  FACE_EAST,
  FACE_NORTH,
  FACE_SOUTH,
  FACE_WEST,
  STAGE_DAMAGED,
  STAGE_GUTTED,
  DAMAGED_PCT,
  GROUND_PCT,
  GUTTED_PCT,
  SITE_SUPPLIES,
  S_BASE,
  S_BRIDGE,
  S_BUILDING,
  addStructure,
  type GameMap,
} from '../sim/map';
import { GARRISON_MAX } from '../sim/units';
import {
  BASE_STRIDE,
  STRUCT_ALIGHT,
  STRUCT_BURNT,
  STRUCT_FORTIFIED,
  STRUCT_PANCAKE,
  type Snapshot,
} from '../worker/protocol';
import { Batch } from './batch';
import { blockMass, flatStuff } from './blocks';
import type { Effects } from './effects';
import type { Fog } from './fog';
import type { Look } from './look';
import type { Clutter } from './clutter';
import { SIGN_HOARDINGS, SIGN_SHOPS, SIGN_STREETS, SIGN_TALL, makeSigns, signUV } from './signs';
import { cityFace, masonry } from './surface';
import {
  SURF_BRICK,
  SURF_FELT,
  SURF_PANEL,
  SURF_PLASTER,
  SURF_RUBBLE,
  SURF_SACK,
  SURF_SHEET,
  SURF_TILE,
} from './surfaces';
import type { Terrain } from './terrain';

// Buildings, bridges and town flags. Structures are few (dozens), so each is its own mesh,
// built from boxes when first needed in each of its three states: standing, shot up, and
// collapsed. A ruin is never removed. The readability layer on top (who holds a house, who
// holds the town) is drawn with two small instanced batches.

/** World units per map cell. */
const CELL = MAP_SIZE / MAP_CELLS;
/**
 * A storey as drawn: taller than the sim's (which only ranks buildings by height), so that
 * a five-floor block stands well over a tank and a street reads as a street.
 */
const FLOOR = fromFx(FLOOR_HEIGHT) * 1.7;
const WALLS = [0x8a8478, 0x7d6a58, 0x9a9384, 0x6f7272, 0x86705a, 0x77786a];
/** Roofing: clay tiles in three ages, slate, tarred felt. */
const TILES = [0x7b4d3c, 0x6c4436, 0x855a43, 0x4d5055, 0x43403d];
const TRIM = [0xa39c8c, 0x6d5a4a, 0x8f8a7c, 0x55585a, 0x9a8468, 0x8b8c7c];
const ROOF = 0x3e3c3a;
/** Brick as it is fired: reds, a brown, a buff. */
const BRICKS = [0x7d4e3e, 0x8a5a44, 0x6e4a3c, 0x9a7a5c, 0x74503f];
const ZINC = [0x4d5055, 0x5a5f5f, 0x43403d, 0x565248];
const AWNINGS = [0x7a2b24, 0x2c4a3a, 0x24385a, 0xb9a476, 0x8a6a2c, 0x5a5a56];
const SACK = 0x9c8c69;
const PLANK = 0x54432f;
const SHEET_RUST = 0x5f4a3c;
const GLASS = 0x1b2126;
/** The gloss of a window with a light on behind it: glass like any other by day. */
const LIT_GLOSS = 0.9;
const SOOT = 0x0d0c0b;
const CONCRETE = 0x77756e;
/**
 * Hong Kong (the Kowloon map): mosaic tile and painted render gone grey with damp and
 * traffic, in the pale colours the tower blocks were built in.
 */
const HK_WALLS = [
  0xa9a596, 0x9e9a8a, 0x939b8e, 0xa08f7f, 0x878b8c, 0x9c9580, 0x7c8789, 0xb0a998, 0x8e8577,
]; // prettier-ignore
/** Whether the buildings are drawn the Hong Kong way (set by the Structures of the map). */
let hk = false;
/** Their roofs: bare concrete and screed, a shade lighter than tarred felt. */
const HK_ROOFS = [0x66645e, 0x5c5a55, 0x716e66, 0x5f615e];
const ASPHALT = 0x39393a;
// Readability colours, as on the minimap: brighter than any paint on purpose.
const TEAM_UI = [
  [0.85, 0.16, 0.1],
  [0.12, 0.38, 1.0],
  [0.9, 0.62, 0.1],
];
const NEUTRAL_UI = [0.55, 0.55, 0.52];
const DAMAGED_BELOW = 150; // of 255
const SMOKE_SECONDS = 90;
/** How far a base building of yours sees, in cells. */
const BASE_SIGHT = 7;
/** Side of a square of ground whose buildings share one mesh, in metres and in squares. */
/**
 * Buildings are merged into one mesh per CHUNK x CHUNK m square. When one changes, its
 * square is merged again and uploaded: 64 m keeps that to about a megabyte.
 */
const CHUNK = 64;
const CHUNKS = Math.ceil(MAP_SIZE / CHUNK);

function rand(seed: number, k: number): number {
  let h = Math.imul(seed + 1, 0x27d4eb2d) ^ Math.imul(k + 1, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

export interface Part {
  size: [number, number, number];
  at: [number, number, number];
  color: number;
  rot?: [number, number, number];
  /** Multiplies the colour: soot and weathering. */
  shade?: number;
  /** 1 for glass: smooth enough to show the sky. */
  gloss?: number;
  /**
   * A roof instead of a box, `size` being its footprint and height: the ridge runs along
   * the longer side, and is drawn in from each end by `hip` (0 = plain gables).
   */
  hip?: number;
  /** Which of the city's materials it is made of (surfaces.ts). Plaster if not given. */
  surf?: number;
  /**
   * A sign instead of a box: a flat panel `size[0]` wide and `size[1]` high showing this
   * cell of the sign sheet (signs.ts), facing +z before `rot`.
   */
  sign?: number;
  /** A roof whose ridge runs along x or z whatever its proportions. */
  ridge?: 'x' | 'z';
  /** A box whose top is drawn in by this much on each side, in x and in z: a mansard. */
  taper?: [number, number];
}

/** A pitched roof as a closed solid: two slopes and two ends, flat-shaded. */
function roofGeometry(
  w: number,
  h: number,
  d: number,
  hip: number,
  axis?: 'x' | 'z',
): THREE.BufferGeometry {
  const alongX = axis ? axis === 'x' : w >= d;
  const L = (alongX ? w : d) / 2;
  const S = (alongX ? d : w) / 2;
  const r = Math.max(0, L - hip);
  // Along the ridge = a, across it = b.
  const corner = (a: number, b: number): [number, number, number] =>
    alongX ? [a, 0, b] : [b, 0, a];
  const ridge = (a: number): [number, number, number] => (alongX ? [a, h, 0] : [0, h, a]);
  const A = corner(-L, -S);
  const B = corner(L, -S);
  const C = corner(L, S);
  const D = corner(-L, S);
  const E = ridge(-r);
  const F = ridge(r);
  const tris = [A, E, F, A, F, B, C, F, E, C, E, D, B, F, C, D, E, A, A, B, C, A, C, D];
  const pos = new Float32Array(tris.length * 3);
  tris.forEach((v, i) => pos.set(v, i * 3));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.computeVertexNormals();
  // Whichever way round a face came out, its normal must point away from the middle.
  const n = g.getAttribute('normal');
  for (let t = 0; t < tris.length; t += 3) {
    const mx = (pos[3 * t] + pos[3 * t + 3] + pos[3 * t + 6]) / 3;
    const my = (pos[3 * t + 1] + pos[3 * t + 4] + pos[3 * t + 7]) / 3 - h * 0.3;
    const mz = (pos[3 * t + 2] + pos[3 * t + 5] + pos[3 * t + 8]) / 3;
    if (n.getX(t) * mx + n.getY(t) * my + n.getZ(t) * mz >= 0) continue;
    for (let k = 0; k < 3; k++) {
      const a = pos[3 * t + 3 + k];
      pos[3 * t + 3 + k] = pos[3 * t + 6 + k];
      pos[3 * t + 6 + k] = a;
    }
  }
  g.computeVertexNormals();
  g.setIndex([...Array(tris.length).keys()]);
  return g;
}

/**
 * A box, or for something as thin as a pane of glass just its two faces: a town has tens
 * of thousands of windows, and the four edges of each are never seen.
 */
function boxOrSlab(size: [number, number, number]): THREE.BufferGeometry {
  const k = size.findIndex((v) => v <= 0.06);
  if (k < 0 || size.filter((v) => v <= 0.06).length !== 1) return new THREE.BoxGeometry(...size);
  const a = size[(k + 1) % 3] / 2;
  const b = size[(k + 2) % 3] / 2;
  const t = size[k] / 2;
  const pos: number[] = [];
  const nor: number[] = [];
  const put = (u: number, v: number, w: number, side: number): void => {
    const q = [0, 0, 0];
    q[k] = w;
    q[(k + 1) % 3] = u;
    q[(k + 2) % 3] = v;
    pos.push(q[0], q[1], q[2]);
    const n = [0, 0, 0];
    n[k] = side;
    nor.push(n[0], n[1], n[2]);
  };
  for (const side of [1, -1]) {
    // Wound so that each face looks outward.
    const quad =
      side === 1
        ? [-a, -b, a, -b, a, b, -a, -b, a, b, -a, b]
        : [-a, -b, a, b, a, -b, -a, -b, -a, b, a, b];
    for (let i = 0; i < 12; i += 2) put(quad[i], quad[i + 1], side * t, side);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
  g.setIndex([...Array(12).keys()]);
  return g;
}

/** Beyond this many metres from the camera a square of the city is drawn simplified. */
const FAR_AT = 520;

/**
 * A building as it is drawn from far off (URBAN.md 5.4, "far facades"): its walls and
 * roofs, with each row of windows painted on as one band and everything smaller than a
 * car left out. At that distance a window is two pixels and a chimney less, so the eye
 * gets the same picture from a fraction of the triangles.
 */
export function farParts(parts: Part[]): Part[] {
  const out: Part[] = [];
  const rows = new Map<string, { lo: number; hi: number; p: Part; along: number }>();
  for (const p of parts) {
    const [sx, sy, sz] = p.size;
    if (p.sign !== undefined) continue;
    const glass = (p.gloss ?? 0) >= 1 && p.rot === undefined && p.hip === undefined;
    if (glass && Math.min(sx, sz) <= 0.12 && sy < 2.6) {
      // A window: thin in x or in z. Its row is every window on that wall at that height.
      const along = sx > sz ? 0 : 2;
      const thin = 2 - along;
      const key = `${along}:${Math.round(p.at[thin] * 8)}:${Math.round(p.at[1] * 8)}:${Math.round(sy * 8)}`;
      const lo = p.at[along] - p.size[along] / 2;
      const hi = p.at[along] + p.size[along] / 2;
      const row = rows.get(key);
      if (!row) rows.set(key, { lo, hi, p, along });
      else {
        // Windows of two houses side by side stay two bands: a gap wider than 5 m splits.
        if (lo - row.hi > 5 || row.lo - hi > 5) {
          out.push(band(row));
          rows.set(key, { lo, hi, p, along });
        } else {
          row.lo = Math.min(row.lo, lo);
          row.hi = Math.max(row.hi, hi);
        }
      }
      continue;
    }
    if (Math.max(sx, sy, sz) < 2.4) continue;
    out.push(p);
  }
  for (const row of rows.values()) out.push(band(row));
  return out;
}

/** One row of windows as a single dark band, lighter than glass for the wall between them. */
function band(row: { lo: number; hi: number; p: Part; along: number }): Part {
  const size: [number, number, number] = [...row.p.size];
  const at: [number, number, number] = [...row.p.at];
  size[row.along] = row.hi - row.lo;
  at[row.along] = (row.hi + row.lo) / 2;
  return { size, at, color: 0x4b4f50, gloss: 0.45 };
}

/** Unit shapes that most parts are scaled copies of (see `build`). */
let unitBox: THREE.BufferGeometry | null = null;
const unitSlabs: (THREE.BufferGeometry | null)[] = [null, null, null];
let unitPlane: THREE.BufferGeometry | null = null;
const tmpMatrix = new THREE.Matrix4();
const tmpEuler = new THREE.Euler();
const tmpColor = new THREE.Color();

/**
 * One geometry for a list of parts. A box, slab or sign is a unit shape scaled, turned and
 * moved, written straight into the output: a house is hundreds of parts and this is the
 * cost of every change of state, so no geometry is made per part. Roofs and tapered boxes
 * are made as their own geometry first. The result is the same as `buildEach`.
 */
export function build(parts: Part[]): THREE.BufferGeometry {
  const n = parts.length;
  const srcs: THREE.BufferGeometry[] = new Array(n);
  const scaled = new Uint8Array(n);
  let verts = 0;
  let indices = 0;
  for (let p = 0; p < n; p++) {
    const part = parts[p];
    let g: THREE.BufferGeometry;
    if (part.sign !== undefined) {
      g = unitPlane ??= new THREE.PlaneGeometry(1, 1);
      scaled[p] = 1;
    } else if (part.hip !== undefined || part.taper) {
      g = ownShape(part);
    } else {
      const size = part.size;
      const k = slabAxis(size);
      g = k < 0 ? (unitBox ??= new THREE.BoxGeometry(1, 1, 1)) : (unitSlabs[k] ??= unitSlab(k));
      scaled[p] = 1;
    }
    srcs[p] = g;
    verts += g.getAttribute('position').count;
    indices += g.index!.count;
  }
  const pos = new Float32Array(verts * 3);
  const nor = new Float32Array(verts * 3);
  const uv = new Float32Array(verts * 2);
  const surf = new Float32Array(verts);
  const sign = new Float32Array(verts);
  const col = new Float32Array(verts * 3);
  const gloss = new Float32Array(verts);
  const index = verts > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
  let v = 0;
  let i = 0;
  for (let p = 0; p < n; p++) {
    const part = parts[p];
    const g = srcs[p];
    const sp = g.getAttribute('position').array as Float32Array;
    const sn = g.getAttribute('normal').array as Float32Array;
    const su = g.getAttribute('uv')?.array as Float32Array | undefined;
    const count = sp.length / 3;
    const sx = scaled[p] ? part.size[0] : 1;
    const sy = scaled[p] ? part.size[1] : 1;
    const sz = scaled[p] ? (part.sign !== undefined ? 1 : part.size[2]) : 1;
    let e: ArrayLike<number> | null = null;
    if (part.rot) {
      tmpEuler.set(part.rot[0], part.rot[1], part.rot[2]);
      e = tmpMatrix.makeRotationFromEuler(tmpEuler).elements;
    }
    const [ax, ay, az] = part.at;
    for (let k = 0; k < count; k++) {
      let x = sp[3 * k] * sx;
      let y = sp[3 * k + 1] * sy;
      let z = sp[3 * k + 2] * sz;
      let nx = sn[3 * k];
      let ny = sn[3 * k + 1];
      let nz = sn[3 * k + 2];
      if (e) {
        const rx = e[0] * x + e[4] * y + e[8] * z;
        const ry = e[1] * x + e[5] * y + e[9] * z;
        const rz = e[2] * x + e[6] * y + e[10] * z;
        x = rx;
        y = ry;
        z = rz;
        const mx = e[0] * nx + e[4] * ny + e[8] * nz;
        const my = e[1] * nx + e[5] * ny + e[9] * nz;
        const mz = e[2] * nx + e[6] * ny + e[10] * nz;
        nx = mx;
        ny = my;
        nz = mz;
      }
      const o = 3 * (v + k);
      pos[o] = x + ax;
      pos[o + 1] = y + ay;
      pos[o + 2] = z + az;
      nor[o] = nx;
      nor[o + 1] = ny;
      nor[o + 2] = nz;
    }
    if (part.sign !== undefined) {
      const [u0, v0, du, dv] = signUV(part.sign);
      for (let k = 0; k < count; k++) {
        uv[2 * (v + k)] = u0 + su![2 * k] * du;
        uv[2 * (v + k) + 1] = v0 + su![2 * k + 1] * dv;
      }
    } else if (su) uv.set(su, 2 * v);
    surf.fill(part.surf ?? 0, v, v + count);
    sign.fill(part.sign === undefined ? 0 : 1, v, v + count);
    tmpColor.set(part.color).multiplyScalar(part.shade ?? 1);
    for (let k = 0; k < count; k++) tmpColor.toArray(col, 3 * (v + k));
    // One window in eight has a light on behind it (seen at night only). It is marked in
    // the gloss itself, which costs no extra attribute: LIT_GLOSS instead of 1.
    let gl = part.gloss ?? 0;
    if (gl === 1 && Math.max(part.size[0], part.size[1], part.size[2]) < 0.7) {
      const h = Math.sin(ax * 12.9898 + ay * 78.233 + az * 37.719) * 43758.5453;
      if (h - Math.floor(h) < 0.125) gl = LIT_GLOSS;
    }
    gloss.fill(gl, v, v + count);
    const si = g.index!.array;
    for (let k = 0; k < si.length; k++) index[i + k] = si[k] + v;
    if (!scaled[p]) g.dispose();
    v += count;
    i += si.length;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setAttribute('surf', new THREE.BufferAttribute(surf, 1));
  out.setAttribute('sign', new THREE.BufferAttribute(sign, 1));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setAttribute('gloss', new THREE.BufferAttribute(gloss, 1));
  out.setIndex(new THREE.BufferAttribute(index, 1));
  return out;
}

/** The axis along which a box is thin enough to be a slab (see boxOrSlab), or -1. */
function slabAxis(size: [number, number, number]): number {
  let k = -1;
  for (let a = 0; a < 3; a++) {
    if (size[a] > 0.06) continue;
    if (k >= 0) return -1;
    k = a;
  }
  return k;
}

/** The slab along axis `k` of a unit box. */
function unitSlab(k: number): THREE.BufferGeometry {
  const size: [number, number, number] = [1, 1, 1];
  size[k] = 0.05;
  const g = boxOrSlab(size);
  g.scale(k === 0 ? 20 : 1, k === 1 ? 20 : 1, k === 2 ? 20 : 1);
  return g;
}

/** A roof or a tapered box: a geometry of its own, at its own size. */
function ownShape(p: Part): THREE.BufferGeometry {
  const g =
    p.hip === undefined
      ? new THREE.BoxGeometry(...p.size)
      : roofGeometry(p.size[0], p.size[1], p.size[2], p.hip, p.ridge);
  if (p.taper) {
    const q = g.getAttribute('position');
    for (let i = 0; i < q.count; i++) {
      if (q.getY(i) <= 0) continue;
      q.setX(i, q.getX(i) - Math.sign(q.getX(i)) * p.taper[0]);
      q.setZ(i, q.getZ(i) - Math.sign(q.getZ(i)) * p.taper[1]);
    }
    g.computeVertexNormals();
  }
  return g;
}

/** `build` the plain way, a geometry per part merged: kept to check `build` against. */
export function buildEach(parts: Part[]): THREE.BufferGeometry {
  const c = new THREE.Color();
  const geometries = parts.map((p) => {
    const g =
      p.sign !== undefined
        ? new THREE.PlaneGeometry(p.size[0], p.size[1])
        : p.hip === undefined
          ? p.taper
            ? new THREE.BoxGeometry(...p.size)
            : boxOrSlab(p.size)
          : roofGeometry(p.size[0], p.size[1], p.size[2], p.hip, p.ridge);
    if (p.taper) {
      const q = g.getAttribute('position');
      for (let i = 0; i < q.count; i++) {
        if (q.getY(i) <= 0) continue;
        q.setX(i, q.getX(i) - Math.sign(q.getX(i)) * p.taper[0]);
        q.setZ(i, q.getZ(i) - Math.sign(q.getZ(i)) * p.taper[1]);
      }
      g.computeVertexNormals();
    }
    if (p.rot) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...p.rot)));
    g.translate(...p.at);
    const n = g.getAttribute('position').count;
    if (p.sign !== undefined) {
      const [u0, v0, du, dv] = signUV(p.sign);
      const t = g.getAttribute('uv');
      for (let i = 0; i < n; i++) t.setXY(i, u0 + t.getX(i) * du, v0 + t.getY(i) * dv);
    } else if (!g.getAttribute('uv')) {
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    }
    g.setAttribute('surf', new THREE.BufferAttribute(new Float32Array(n).fill(p.surf ?? 0), 1));
    g.setAttribute(
      'sign',
      new THREE.BufferAttribute(new Float32Array(n).fill(p.sign === undefined ? 0 : 1), 1),
    );
    const colors = new Float32Array(n * 3);
    c.set(p.color).multiplyScalar(p.shade ?? 1);
    for (let i = 0; i < n; i++) c.toArray(colors, i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    // One window in eight has a light on behind it (seen at night only). It is marked in
    // the gloss itself, which costs no extra attribute: LIT_GLOSS instead of 1.
    let gloss = p.gloss ?? 0;
    if (gloss === 1 && Math.max(p.size[0], p.size[1], p.size[2]) < 0.7) {
      const h = Math.sin(p.at[0] * 12.9898 + p.at[1] * 78.233 + p.at[2] * 37.719) * 43758.5453;
      if (h - Math.floor(h) < 0.125) gloss = LIT_GLOSS;
    }
    g.setAttribute('gloss', new THREE.BufferAttribute(new Float32Array(n).fill(gloss), 1));
    return g;
  });
  const merged = mergeGeometries(geometries);
  for (const g of geometries) g.dispose();
  return merged;
}

/**
 * One square's buildings as one geometry: each building's vertices and indices come from
 * its new look in `fresh` if it has one, else are copied from where `ranges` says they lie
 * in `old`, the square's mesh until now. Writes the new places back into `ranges` (first
 * vertex, vertex count, first index, index count, four per structure). Null if empty.
 */
function remerge(
  list: readonly number[],
  ranges: Int32Array,
  old: THREE.BufferGeometry | null,
  fresh: ReadonlyMap<number, { near: THREE.BufferGeometry; far: THREE.BufferGeometry | null }>,
  far: boolean,
): THREE.BufferGeometry | null {
  let verts = 0;
  let indices = 0;
  let model: THREE.BufferGeometry | null = null;
  for (const s of list) {
    const f = fresh.get(s);
    if (f) {
      const g = far ? f.far : f.near;
      if (g) {
        verts += g.getAttribute('position').count;
        indices += g.index!.count;
        model ??= g;
      }
    } else {
      verts += ranges[4 * s + 1];
      indices += ranges[4 * s + 3];
    }
  }
  model ??= old;
  if (verts === 0 || !model) return null;
  const out = new THREE.BufferGeometry();
  const names = Object.keys(model.attributes);
  const arrays: Float32Array[] = [];
  for (const name of names) {
    const size = model.getAttribute(name).itemSize;
    const array = new Float32Array(verts * size);
    arrays.push(array);
    out.setAttribute(name, new THREE.BufferAttribute(array, size));
  }
  const index = verts > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
  let v = 0;
  let i = 0;
  for (const s of list) {
    const f = fresh.get(s);
    const r = 4 * s;
    let src: THREE.BufferGeometry | null;
    let v0: number;
    let vn: number;
    let i0: number;
    let iN: number;
    if (f) {
      src = far ? f.far : f.near;
      v0 = 0;
      vn = src ? src.getAttribute('position').count : 0;
      i0 = 0;
      iN = src ? src.index!.count : 0;
    } else {
      src = old;
      v0 = ranges[r];
      vn = ranges[r + 1];
      i0 = ranges[r + 2];
      iN = ranges[r + 3];
    }
    ranges[r] = v;
    ranges[r + 1] = vn;
    ranges[r + 2] = i;
    ranges[r + 3] = iN;
    if (vn === 0 || !src) continue;
    for (let a = 0; a < names.length; a++) {
      const from = src.getAttribute(names[a]) as THREE.BufferAttribute;
      const size = from.itemSize;
      arrays[a].set((from.array as Float32Array).subarray(v0 * size, (v0 + vn) * size), v * size);
    }
    const idx = src.index!.array;
    const shift = v - v0;
    for (let k = 0; k < iN; k++) index[i + k] = idx[i0 + k] + shift;
    v += vn;
    i += iN;
  }
  out.setIndex(new THREE.BufferAttribute(index, 1));
  out.computeBoundingSphere();
  out.computeBoundingBox();
  return out;
}

/**
 * The windows of a Hong Kong block: a band of glass along each face at every floor and
 * the columns of the frame standing proud between them. Twenty floors cost what two would
 * window by window, which is what lets the Kowloon map have its towers.
 */
function ribbons(
  id: number,
  cx: number,
  cz: number,
  w: number,
  d: number,
  base: number,
  floors: number,
  shopFace: number,
  damaged: boolean,
  wall: number,
  wear: number,
  wsurf: number,
): Part[] {
  const parts: Part[] = [];
  const h = floors * FLOOR;
  const faces: [number, number, boolean, number][] = [
    [FACE_SOUTH, w, true, 1],
    [FACE_NORTH, w, true, -1],
    [FACE_EAST, d, false, 1],
    [FACE_WEST, d, false, -1],
  ];
  for (const [face, len, alongX, side] of faces) {
    const off = side * ((alongX ? d : w) / 2 + 0.02);
    for (let f = 0; f < floors; f++) {
      if (f === 0 && face === shopFace) continue;
      const y = base + f * FLOOR + FLOOR * 0.55;
      const lit = !damaged && rand(id, 5000 + face * 97 + f) < 0.16;
      parts.push({
        size: alongX ? [len - 0.5, FLOOR * 0.44, 0.05] : [0.05, FLOOR * 0.44, len - 0.5],
        at: alongX ? [cx, y, cz + off] : [cx + off, y, cz],
        color: GLASS,
        gloss: lit ? LIT_GLOSS : 1,
      });
    }
    // The frame: a column every two metres or so, the full height of the block.
    const n = Math.max(2, Math.round(len / 2.3));
    const out = side * ((alongX ? d : w) / 2 + 0.07);
    for (let i = 0; i <= n; i++) {
      const t = (i / n - 0.5) * (len - 0.2);
      parts.push({
        size: alongX ? [0.16, h, 0.12] : [0.12, h, 0.16],
        at: alongX ? [cx + t, base + h / 2, cz + out] : [cx + out, base + h / 2, cz + t],
        color: wall,
        shade: wear * (0.86 + rand(id, 5400 + i) * 0.1),
        surf: wsurf,
      });
    }
    if (damaged) {
      // Shot-out panes: black gaps in the bands.
      for (let q = 0; q < 2 + floors / 3; q++) {
        const f = Math.floor(rand(id, 5600 + face * 31 + q) * floors);
        const t = (rand(id, 5700 + face * 31 + q) - 0.5) * (len - 2);
        const y = base + f * FLOOR + FLOOR * 0.55;
        parts.push({
          size: alongX ? [1.6, FLOOR * 0.5, 0.08] : [0.08, FLOOR * 0.5, 1.6],
          at: alongX ? [cx + t, y, cz + off] : [cx + off, y, cz + t],
          color: SOOT,
        });
      }
    }
  }
  return parts;
}

/**
 * What hangs off a Hong Kong street front: signboards out over the pavement on steel
 * frames, read from up and down the street, and air conditioners under the windows.
 * Painted boards, no light of their own.
 */
function streetFront(
  id: number,
  cx: number,
  cz: number,
  w: number,
  d: number,
  base: number,
  floors: number,
  shopFace: number,
  damaged: boolean,
): Part[] {
  const parts: Part[] = [];
  const face = shopFace >= 0 ? shopFace : rand(id, 6000) < 0.5 ? FACE_SOUTH : FACE_EAST;
  const alongX = face === FACE_NORTH || face === FACE_SOUTH;
  const side = face === FACE_SOUTH || face === FACE_EAST ? 1 : -1;
  const len = alongX ? w : d;
  const half = (alongX ? d : w) / 2;
  const put = (t: number, y: number, out: number): [number, number, number] =>
    alongX ? [cx + t, y, cz + side * (half + out)] : [cx + side * (half + out), y, cz + t];
  // The boards stand edge on to the wall, so they face along the street.
  const yaw = alongX ? Math.PI / 2 : 0;
  const count = Math.min(3, Math.max(1, Math.floor(len / 4)));
  for (let i = 0; i < count; i++) {
    if (rand(id, 6010 + i) < 0.25) continue;
    const t = ((i + 0.5) / count - 0.5) * (len - 1.5) + (rand(id, 6020 + i) - 0.5);
    const tall = 3.4 + rand(id, 6030 + i) * 2.2;
    const wide = tall / 4;
    const y = base + FLOOR * (1.15 + rand(id, 6040 + i) * Math.min(2, floors - 2)) + tall / 2;
    const out = 0.85 + rand(id, 6050 + i) * 0.5;
    const cell = SIGN_TALL.from + Math.floor(rand(id, 6060 + i) * SIGN_TALL.count);
    const shade = damaged ? 0.5 : 0.82 + rand(id, 6070 + i) * 0.15;
    const frame: [number, number, number] = alongX
      ? [0.06, tall + 0.12, wide + 0.12]
      : [wide + 0.12, tall + 0.12, 0.06];
    parts.push({ size: frame, at: put(t, y, out), color: 0x2f302f });
    for (const back of [0, Math.PI]) {
      const nudge = (back === 0 ? 1 : -1) * 0.04;
      const at = put(t, y, out);
      if (alongX) at[0] += nudge;
      else at[2] += nudge;
      parts.push({
        size: [tall, wide, 0],
        at,
        rot: [0, yaw + back + (alongX ? 0 : 0), Math.PI / 2],
        color: 0xffffff,
        shade,
        sign: cell,
      });
    }
    // The bracket that holds it out from the wall.
    parts.push({
      size: alongX ? [0.07, 0.07, out] : [out, 0.07, 0.07],
      at: put(t, y + tall / 2 - 0.1, out / 2),
      color: 0x3a3d3d,
    });
  }
  // Air conditioners, here and there under the windows of every floor.
  const faces = [face, alongX ? FACE_EAST : FACE_SOUTH];
  for (const f of faces) {
    const ax = f === FACE_NORTH || f === FACE_SOUTH;
    const sd = f === FACE_SOUTH || f === FACE_EAST ? 1 : -1;
    const L = ax ? w : d;
    const hf = (ax ? d : w) / 2;
    const slots = Math.max(1, Math.floor(L / 2.6));
    for (let fl = 1; fl < Math.min(floors, 14); fl++) {
      for (let q = 0; q < slots; q++) {
        if (rand(id, 6200 + f * 300 + fl * 17 + q) > 0.2) continue;
        const t = ((q + 0.5) / slots - 0.5) * (L - 1);
        const y = base + fl * FLOOR + FLOOR * 0.16;
        parts.push({
          size: ax ? [0.62, 0.36, 0.34] : [0.34, 0.36, 0.62],
          at: ax ? [cx + t, y, cz + sd * (hf + 0.2)] : [cx + sd * (hf + 0.2), y, cz + t],
          color: 0x9a9890,
          shade: 0.8,
        });
      }
    }
  }
  return parts;
}

/** How far the roof of the building last drawn stands above its counted floors. */
let crest = 0.9;

/** A house: foundation, walls, rows of windows, a flat roof with a parapet and clutter. */
export function buildingParts(
  id: number,
  x0: number,
  z0: number,
  w: number,
  d: number,
  base: number,
  floors: number,
  stage: number,
  breached: number,
  cls: number,
  fort: boolean,
  level = 0,
  scorched = false,
): Part[] {
  const damaged = stage >= STAGE_DAMAGED;
  const parts: Part[] = [];
  const cx = x0 + w / 2;
  const cz = z0 + d / 2;
  const h = floors * FLOOR;
  // Plaster and brick for houses; precast panels for most blocks and halls.
  const brick = !hk && cls === BUILD_HOUSE && rand(id, 41) < 0.42;
  const wall =
    hk && cls !== BUILD_HALL
      ? HK_WALLS[Math.floor(rand(id, 1) * HK_WALLS.length)]
      : brick
        ? BRICKS[Math.floor(rand(id, 1) * BRICKS.length)]
        : cls === BUILD_HOUSE
          ? WALLS[Math.floor(rand(id, 1) * WALLS.length)]
          : [0x8a8a84, 0x7c7d78, 0x93908a][Math.floor(rand(id, 1) * 3)];
  const wsurf = brick
    ? SURF_BRICK
    : cls !== BUILD_HOUSE && rand(id, 42) < 0.7
      ? SURF_PANEL
      : SURF_PLASTER;
  // Things fixed to a face: `t` along it from its middle, `y` up, `out` proud of the wall.
  const faceX = (f: number): boolean => f === FACE_NORTH || f === FACE_SOUTH;
  const faceLen = (f: number): number => (faceX(f) ? w : d);
  const onFace = (f: number, t: number, y: number, out: number): [number, number, number] => {
    const side = f === FACE_SOUTH || f === FACE_EAST ? 1 : -1;
    return faceX(f)
      ? [cx + t, y, cz + side * (d / 2 + out)]
      : [cx + side * (w / 2 + out), y, cz + t];
  };
  const faceBox = (
    f: number,
    along: number,
    up: number,
    thick: number,
  ): [number, number, number] => (faceX(f) ? [along, up, thick] : [thick, up, along]);
  const faceTurn = (f: number): number =>
    f === FACE_SOUTH
      ? 0
      : f === FACE_NORTH
        ? Math.PI
        : f === FACE_EAST
          ? Math.PI / 2
          : -Math.PI / 2;
  // Sandbags along the foot of every wall: the mark of a house made into a strongpoint.
  const sandbags = (): void => {
    for (let f = 0; f < 4; f++) {
      const len = faceLen(f);
      parts.push({
        size: faceBox(f, len + 0.5, 0.42, 0.36),
        at: onFace(f, 0, base + 0.21, 0.16),
        color: SACK,
        shade: 0.9,
        surf: SURF_SACK,
      });
      for (const s of [-1, 1]) {
        const part = len * (0.22 + rand(id, 1700 + f * 4 + s) * 0.14);
        parts.push({
          size: faceBox(f, part, 0.36, 0.3),
          at: onFace(f, s * (len / 2 - part / 2 - 0.1), base + 0.6, 0.14),
          color: SACK,
          surf: SURF_SACK,
        });
      }
      // A breach is stopped with a breastwork of its own.
      if ((breached & (1 << f)) !== 0) {
        const gap = Math.min(len * 0.5, 3.4);
        const t = (rand(id, 880 + f) - 0.5) * (len - gap) * 0.5;
        parts.push({
          size: faceBox(f, gap + 0.5, 0.8, 0.55),
          at: onFace(f, t, base + 0.4, 0.05),
          color: SACK,
          shade: 0.95,
          surf: SURF_SACK,
        });
      }
    }
  };
  const wear = damaged ? 0.62 : 0.92 + rand(id, 2) * 0.12;
  parts.push({ size: [w + 0.3, 2.4, d + 0.3], at: [cx, base - 1.15, cz], color: 0x55524c });
  // A breached wall: a ragged hole from the ground up, and what came out of it in a heap.
  for (let f = 0; f < 4; f++) {
    if ((breached & (1 << f)) === 0) continue;
    const alongX = f === FACE_NORTH || f === FACE_SOUTH;
    const side = f === FACE_SOUTH || f === FACE_EAST ? 1 : -1;
    const len = alongX ? w : d;
    const off = (side * (alongX ? d : w)) / 2;
    const gap = Math.min(len * 0.5, 3.4);
    const gh = Math.min(h * 0.75, FLOOR * 1.7);
    const t = (rand(id, 880 + f) - 0.5) * (len - gap) * 0.5;
    for (let k = 0; k < 3; k++) {
      const gw = gap * (1 - k * 0.28);
      const gy = gh * (0.45 + k * 0.3);
      parts.push({
        size: alongX ? [gw, gy, 0.24] : [0.24, gy, gw],
        at: alongX ? [cx + t, base + gy / 2, cz + off] : [cx + off, base + gy / 2, cz + t],
        color: SOOT,
      });
    }
    for (let k = 0; k < 7; k++) {
      const s = 0.3 + rand(id, 890 + f * 9 + k) * 0.6;
      const out = 0.3 + rand(id, 930 + f * 9 + k) * 1.1;
      const along = t + (rand(id, 960 + f * 9 + k) - 0.5) * gap * 1.3;
      parts.push({
        size: [s, s * 0.5, s * 0.8],
        at: alongX
          ? [cx + along, base + s * 0.2, cz + off + side * out]
          : [cx + off + side * out, base + s * 0.2, cz + along],
        rot: [rand(id, 990 + k) - 0.5, rand(id, 995 + k) * 3, rand(id, 999 + k) - 0.5],
        color: wall,
        shade: 0.5,
      });
    }
  }
  if (stage === STAGE_GUTTED) {
    // A shell: the roof and the floors are in a heap inside, the walls stand at ragged
    // heights with the sky showing through, and a breached face is down to its footing.
    parts.push({ size: [w - 0.5, 0.3, d - 0.5], at: [cx, base + 0.15, cz], color: 0x2b2926 });
    // What is left of the roof timbers and floor beams, charred, hanging across the gap.
    for (let i = 0; i < 4; i++) {
      const alongX = w < d;
      const t = ((i + 0.5) / 4 - 0.5) * (alongX ? d : w) * 0.8;
      const drop = rand(id, 1500 + i) * 0.5;
      parts.push({
        size: alongX
          ? [w * (0.55 + rand(id, 1510 + i) * 0.4), 0.1, 0.12]
          : [0.12, 0.1, d * (0.55 + rand(id, 1510 + i) * 0.4)],
        at: alongX
          ? [cx, base + h * (0.85 - drop), cz + t]
          : [cx + t, base + h * (0.85 - drop), cz],
        rot: alongX
          ? [0, 0, (rand(id, 1520 + i) - 0.5) * 0.5]
          : [(rand(id, 1520 + i) - 0.5) * 0.5, 0, 0],
        color: SOOT,
      });
    }
    for (let i = 0; i < 10 + w * d * 0.25; i++) {
      const s = 0.7 + rand(id, 400 + i) * 1.8;
      parts.push({
        size: [s, 0.16 + rand(id, 460 + i) * 0.4, s * (0.5 + rand(id, 490 + i) * 0.6)],
        at: [
          cx + (rand(id, 520 + i) - 0.5) * (w - 1.2),
          base + 0.3 + rand(id, 550 + i) * 0.35,
          cz + (rand(id, 580 + i) - 0.5) * (d - 1.2),
        ],
        rot: [
          (rand(id, 610 + i) - 0.5) * 0.9,
          rand(id, 640 + i) * 3.1,
          (rand(id, 670 + i) - 0.5) * 0.9,
        ],
        color: i % 3 === 0 ? 0x4c4a46 : wall,
        shade: 0.38 + rand(id, 700 + i) * 0.25,
        surf: SURF_RUBBLE,
      });
    }
    if (fort) {
      // A fortified ruin: breastworks at the foot of the walls and in the breaches, a nest
      // of sandbags on the heap inside, a sheet of roofing propped over one corner.
      sandbags();
      const r = Math.min(w, d) * 0.22;
      for (let k = 0; k < 4; k++) {
        const alongX = k % 2 === 0;
        const side = k < 2 ? -1 : 1;
        parts.push({
          size: alongX ? [r * 2 + 0.4, 0.5, 0.4] : [0.4, 0.5, r * 2 + 0.4],
          at: alongX ? [cx, base + 0.85, cz + side * r] : [cx + side * r, base + 0.85, cz],
          color: SACK,
          shade: 0.92,
          surf: SURF_SACK,
        });
      }
      const sx = Math.min(w * 0.4, 3.2);
      const sz = Math.min(d * 0.4, 3.2);
      const qx = rand(id, 1750) < 0.5 ? -1 : 1;
      const qz = rand(id, 1751) < 0.5 ? -1 : 1;
      parts.push({
        size: [sx, 0.05, sz],
        at: [cx + qx * (w / 2 - sx / 2 - 0.3), base + 1.25, cz + qz * (d / 2 - sz / 2 - 0.3)],
        rot: [qz * 0.22, 0, 0],
        color: SHEET_RUST,
        surf: SURF_SHEET,
      });
      parts.push({
        size: [0.1, 1.2, 0.1],
        at: [cx + qx * (w / 2 - sx - 0.2), base + 0.6, cz + qz * (d / 2 - sz - 0.2)],
        color: PLANK,
      });
    }
    for (let f = 0; f < 4; f++) {
      const alongX = f === FACE_NORTH || f === FACE_SOUTH;
      const side = f === FACE_SOUTH || f === FACE_EAST ? 1 : -1;
      const len = alongX ? w : d;
      const off = (side * ((alongX ? d : w) - 0.3)) / 2;
      const n = Math.max(3, Math.round(len / 1.5));
      const open = (breached & (1 << f)) !== 0;
      for (let i = 0; i < n; i++) {
        const corner = i === 0 || i === n - 1;
        const r = rand(id, 1100 + f * 40 + i);
        let hh = h * (corner ? 0.85 + r * 0.15 : 0.5 + r * 0.5);
        if (open && !corner && Math.abs(i - (n - 1) / 2) < n * 0.3) hh = FLOOR * 0.25;
        const t = ((i + 0.5) / n - 0.5) * len;
        parts.push({
          size: alongX ? [len / n + 0.02, hh, 0.3] : [0.3, hh, len / n + 0.02],
          at: alongX ? [cx + t, base + hh / 2, cz + off] : [cx + off, base + hh / 2, cz + t],
          color: wall,
          shade: 0.4 + rand(id, 1300 + f * 40 + i) * 0.22,
          surf: wsurf,
        });
        // Empty window openings, as far up as this stretch of wall still goes.
        for (let fl = 0; fl < floors; fl++) {
          const wy = base + fl * FLOOR + FLOOR * 0.56;
          if (wy + 0.3 > base + hh) break;
          parts.push({
            size: alongX ? [0.5, 0.44, 0.34] : [0.34, 0.44, 0.5],
            at: alongX ? [cx + t, wy, cz + off] : [cx + off, wy, cz + t],
            color: SOOT,
          });
        }
      }
    }
    return parts;
  }
  // The bigger buildings are drawn as rows of houses (blocks.ts); the rest as one.
  const mass =
    cls === BUILD_HALL || hk
      ? null
      : blockMass({
          id,
          cx,
          cz,
          w,
          d,
          base,
          floors,
          floor: FLOOR,
          house: cls === BUILD_HOUSE,
          damaged,
          wall,
          wsurf,
          wear,
        });
  crest = mass ? mass.crest : 0.9;
  if (mass) parts.push(...mass.parts);
  else
    parts.push({
      size: [w, h, d],
      at: [cx, base + h / 2, cz],
      color: wall,
      shade: wear,
      surf: wsurf,
    });
  // A band round the house: one slab, or four strips where a courtyard must stay open.
  const belt = (y: number, up: number, out: number, color: number, shade: number): void => {
    if (!mass?.court) {
      parts.push({ size: [w + out, up, d + out], at: [cx, y, cz], color, shade });
      return;
    }
    for (const s of [-1, 1]) {
      parts.push({
        size: [w + out, up, 0.5],
        at: [cx, y, cz + s * (d / 2 + out / 2 - 0.25)],
        color,
        shade,
      });
      parts.push({
        size: [0.5, up, d + out],
        at: [cx + s * (w / 2 + out / 2 - 0.25), y, cz],
        color,
        shade,
      });
    }
  };
  const top = base + h;
  const S = Math.min(w, d);
  const L = Math.max(w, d);
  const ridgeX = w >= d;
  // Along the longer side and across it, as a point on the ground.
  const lay = (along: number, y: number, across: number): [number, number, number] =>
    ridgeX ? [cx + along, y, cz + across] : [cx + across, y, cz + along];
  const laid = (along: number, up: number, across: number): [number, number, number] =>
    ridgeX ? [along, up, across] : [across, up, along];
  // Small houses have pitched roofs of tile; big ones a flat roof, a set-back top storey
  // or a low hipped roof of zinc; halls a row of gables in sheet, or one low one.
  const rr = rand(id, 10);
  const roof = hk
    ? 'flat'
    : cls === BUILD_HALL
      ? rr < 0.55 && L / Math.max(2, Math.round(L / 4)) < S
        ? 'saw'
        : rr < 0.85
          ? 'shed'
          : 'flat'
      : floors <= 3 && S <= 12
        ? rr < 0.8
          ? 'gable'
          : 'flat'
        : rr < 0.22 && floors >= 4 && S >= 7
          ? 'pent'
          : rr < 0.5 && S <= 16
            ? 'hip'
            : 'flat';
  const pitched = mass !== null || roof === 'gable' || roof === 'shed';
  const stack = (along: number, across: number, tall: number): void => {
    parts.push({
      size: [0.32, tall, 0.32],
      at: lay(along, top + tall / 2, across),
      color: 0x6b4c3d,
      shade: wear * 0.9,
      surf: SURF_BRICK,
    });
    parts.push({ size: [0.4, 0.06, 0.4], at: lay(along, top + tall, across), color: 0x4a4744 });
  };
  if (mass) {
    // Roofed already, house by house.
  } else if (roof === 'gable' || roof === 'shed') {
    const sheet = roof === 'shed';
    const tile = sheet
      ? ZINC[Math.floor(rand(id, 7) * ZINC.length)]
      : TILES[Math.floor(rand(id, 7) * TILES.length)];
    const rise = S * (sheet ? 0.13 : 0.2 + rand(id, 8) * 0.1);
    const hip = !sheet && rand(id, 9) < 0.35 ? S * 0.45 : 0;
    const shade = damaged ? 0.5 : 0.68 + rand(id, 12) * 0.2;
    parts.push({
      size: [w + 0.5, rise, d + 0.5],
      at: [cx, top, cz],
      color: tile,
      shade,
      hip,
      surf: sheet ? SURF_SHEET : SURF_TILE,
    });
    // Eaves board under the tiles, and a chimney or two through them.
    parts.push({ size: [w + 0.3, 0.08, d + 0.3], at: [cx, top - 0.02, cz], color: TRIM[0] });
    const stacks = sheet ? 0 : 1 + (rand(id, 13) < 0.4 ? 1 : 0);
    for (let c = 0; c < stacks; c++) {
      stack(
        (rand(id, 14 + c) - 0.5) * (L - 2.4 - 2 * hip),
        (c === 0 ? 0.22 : -0.25) * S,
        rise + 0.35,
      );
    }
    if (!sheet && hip === 0 && !damaged) {
      // Dormers in the slope that faces the street, and now and then a gable across the house.
      const face = rand(id, 18) < 0.7 ? 1 : -1;
      const slope = (across: number): number => rise * (1 - Math.abs(across) / (S / 2 + 0.25));
      if (S >= 7 && rand(id, 17) < 0.3) {
        const wide = S * 0.45;
        const reach = S / 2 + 0.25;
        const at = (rand(id, 19) - 0.5) * (L - wide - 1.5);
        parts.push({
          size: laid(wide, rise * 0.85, reach),
          at: lay(at, top, (face * reach) / 2),
          color: tile,
          shade: shade * 0.95,
          hip: 0,
          surf: SURF_TILE,
        });
        parts.push({
          size: laid(0.46, 0.4, 0.05),
          at: lay(at, top + rise * 0.3, face * (reach - 0.02)),
          color: GLASS,
          gloss: 1,
        });
      } else if (L >= 6 && rand(id, 16) < 0.5) {
        const count = L > 9 ? 2 : 1;
        for (let i = 0; i < count; i++) {
          const along = ((i + 0.5) / count - 0.5) * L * 0.6;
          const across = face * S * 0.27;
          const y = top + slope(across);
          parts.push({
            size: laid(0.7, 0.5, 0.62),
            at: lay(along, y + 0.12, across),
            color: wall,
            shade: wear,
            surf: wsurf,
          });
          parts.push({
            size: laid(0.86, 0.2, 0.95),
            at: lay(along, y + 0.37, across - face * 0.08),
            color: tile,
            shade,
            hip: 0,
            surf: SURF_TILE,
          });
          parts.push({
            size: laid(0.42, 0.3, 0.04),
            at: lay(along, y + 0.14, across + face * 0.32),
            color: GLASS,
            gloss: 1,
          });
        }
      }
    }
  } else if (roof === 'saw') {
    // A workshop roof: a row of sheet gables across the hall, a vent on each, one tall flue.
    const n = Math.max(2, Math.round(L / 4));
    const bay = L / n;
    const tone = ZINC[Math.floor(rand(id, 7) * ZINC.length)];
    for (let i = 0; i < n; i++) {
      const along = ((i + 0.5) / n - 0.5) * L;
      parts.push({
        size: laid(bay + 0.06, 0.75, S + 0.4),
        at: lay(along, top, 0),
        color: tone,
        shade: (damaged ? 0.55 : 0.8) + rand(id, 300 + i) * 0.16,
        hip: 0,
        surf: SURF_SHEET,
      });
      parts.push({
        size: laid(0.3, 0.16, S * 0.5),
        at: lay(along, top + 0.78, 0),
        color: 0x6f726d,
      });
    }
    stack((rand(id, 14) - 0.5) * (L - 2), S * 0.3, 2.4);
  } else {
    // Roof slab, parapet, and what stands on a flat roof.
    parts.push({
      size: [w + 0.24, 0.12, d + 0.24],
      at: [cx, top + 0.06, cz],
      color: hk ? HK_ROOFS[Math.floor(rand(id, 79) * HK_ROOFS.length)] : ROOF,
      surf: SURF_FELT,
    });
    if (hk && floors >= 6 && S >= 4) {
      // The lift and stair house, the water tanks on their stand, a hut built on the roof.
      const hx = cx + (rand(id, 80) - 0.5) * (w - 3.2);
      const hz = cz + (rand(id, 81) - 0.5) * (d - 3.2);
      parts.push({
        size: [2.2, FLOOR * 1.3, 2.6],
        at: [hx, top + (FLOOR * 1.3) / 2, hz],
        color: wall,
        shade: wear * 0.9,
        surf: wsurf,
      });
      parts.push({
        size: [2.0, 0.9, 1.4],
        at: [hx, top + FLOOR * 1.3 + 0.45, hz],
        color: 0x8d9089,
        shade: 0.85,
      });
      if (rand(id, 82) < 0.45) {
        parts.push({
          size: [Math.min(3.4, w * 0.4), FLOOR * 0.8, Math.min(2.6, d * 0.35)],
          at: [cx - (hx - cx) * 0.8, top + FLOOR * 0.4, cz - (hz - cz) * 0.8],
          color: 0x6a655c,
          shade: 0.8,
          surf: SURF_SHEET,
        });
      }
    }
    for (const side of [-1, 1]) {
      parts.push({
        size: [w + 0.24, 0.22, 0.14],
        at: [cx, top + 0.2, cz + (side * (d + 0.1)) / 2],
        color: wall,
        shade: wear * 0.85,
        surf: wsurf,
      });
      parts.push({
        size: [0.14, 0.22, d + 0.24],
        at: [cx + (side * (w + 0.1)) / 2, top + 0.2, cz],
        color: wall,
        shade: wear * 0.85,
        surf: wsurf,
      });
    }
    if (roof === 'hip') {
      // A low hipped roof of zinc behind the parapet, chimneys along its ridge.
      const tone = ZINC[Math.floor(rand(id, 7) * ZINC.length)];
      parts.push({
        size: [w - 0.5, S * 0.2, d - 0.5],
        at: [cx, top + 0.12, cz],
        color: tone,
        shade: damaged ? 0.55 : 0.78 + rand(id, 12) * 0.16,
        hip: S * 0.46,
        surf: rand(id, 8) < 0.5 ? SURF_SHEET : SURF_TILE,
      });
      const stacks = 2 + Math.floor(rand(id, 13) * 2);
      for (let c = 0; c < stacks; c++) {
        stack(
          ((c + 0.5) / stacks - 0.5) * (L - S * 0.8),
          (c % 2 === 0 ? 0.16 : -0.16) * S,
          S * 0.2 + 0.4,
        );
      }
    } else if (roof === 'pent') {
      // A top storey set back from the street, glazed all round under its own slab.
      const ph = FLOOR * 0.9;
      parts.push({
        size: [w - 2.4, ph, d - 2.4],
        at: [cx, top + 0.12 + ph / 2, cz],
        color: wall,
        shade: wear * 1.04,
        surf: wsurf,
      });
      parts.push({
        size: [w - 2.34, ph * 0.42, d - 2.34],
        at: [cx, top + 0.12 + ph * 0.56, cz],
        color: GLASS,
        gloss: 1,
      });
      parts.push({
        size: [w - 1.9, 0.1, d - 1.9],
        at: [cx, top + 0.17 + ph, cz],
        color: ROOF,
        surf: SURF_FELT,
      });
    } else {
      parts.push(
        ...flatStuff(
          { cx, cz, len: L - 0.6, span: S - 0.6, alongX: ridgeX },
          top + 0.12,
          id,
          3,
          wall,
        ),
      );
      if (floors >= 3 && w >= 5.5 && !damaged && rand(id, 76) < 0.24) {
        // A hoarding on the roof, turned to the street.
        const bw = Math.min(w - 1, 4.8);
        const bh = bw / 4;
        const by = top + 0.75 + bh / 2;
        const bz = cz + d / 2 - 0.35;
        const k = SIGN_HOARDINGS.from + Math.floor(rand(id, 77) * SIGN_HOARDINGS.count);
        parts.push({ size: [bw + 0.12, bh + 0.12, 0.07], at: [cx, by, bz], color: 0x2e2d2b });
        parts.push({ size: [bw, bh, 0], at: [cx, by, bz + 0.045], color: 0xffffff, sign: k });
        for (const s of [-1, 1]) {
          parts.push({
            size: [0.08, 0.8 + bh, 0.08],
            at: [cx + s * bw * 0.36, top + (0.8 + bh) / 2, bz - 0.08],
            color: 0x3a3d3d,
          });
          parts.push({
            size: [0.05, 0.05, 1.1],
            at: [cx + s * bw * 0.36, top + 0.55, bz - 0.55],
            rot: [0.75, 0, 0],
            color: 0x3a3d3d,
          });
        }
      }
    }
    if (fort) {
      // Sandbagged positions on two corners of the roof.
      for (const q of [-1, 1]) {
        const px = cx + q * (w / 2 - 0.9);
        const pz = cz + q * (d / 2 - 0.9);
        parts.push({
          size: [1.5, 0.42, 0.34],
          at: [px, top + 0.33, pz - q * 0.75],
          color: SACK,
          surf: SURF_SACK,
        });
        parts.push({
          size: [0.34, 0.42, 1.5],
          at: [px - q * 0.75, top + 0.33, pz],
          color: SACK,
          shade: 0.92,
          surf: SURF_SACK,
        });
      }
    }
  }
  // A plinth in darker render, a string course under the top floor, a canopy over the door.
  const trim = TRIM[Math.floor(rand(id, 1) * TRIM.length)];
  belt(base + 0.13, 0.26, 0.08, wall, wear * 0.62);
  // Shops along the ground floor of one face; a ground floor in dressed render on the
  // taller houses; piers down the panel blocks; drainpipes; a street plate at a corner.
  const shopFace =
    cls === BUILD_HALL || rand(id, 70) >= (floors >= 2 ? 0.5 : 0.22)
      ? -1
      : rand(id, 71) < 0.6
        ? FACE_SOUTH
        : [FACE_EAST, FACE_WEST, FACE_NORTH][Math.floor(rand(id, 72) * 3)];
  const band = floors >= 3 && cls !== BUILD_HALL && rand(id, 44) < 0.55;
  const proud = band ? 0.035 : 0;
  if (band) {
    belt(base + FLOOR * 0.48, FLOOR * 0.96, 0.07, trim, wear * 0.8);
  }
  if (wsurf === SURF_PANEL && rand(id, 43) < 0.5) {
    for (let f = 0; f < 4; f++) {
      const len = faceLen(f);
      const n = Math.max(2, Math.round(len / 1.15));
      for (let i = 0; i <= n; i += 2) {
        parts.push({
          size: faceBox(f, 0.1, h, 0.1),
          at: onFace(f, (i / n - 0.5) * len, base + h / 2, 0),
          color: wall,
          shade: wear * 0.8,
          surf: wsurf,
        });
      }
    }
  }
  for (const f of [FACE_SOUTH, FACE_NORTH]) {
    parts.push({
      size: faceBox(f, 0.07, h, 0.07),
      at: onFace(f, (f === FACE_SOUTH ? 1 : -1) * (w / 2 - 0.25), base + h / 2, 0.05),
      color: 0x3a3d3d,
    });
  }
  if (shopFace >= 0) {
    const f = shopFace;
    const len = faceLen(f);
    const side = f === FACE_SOUTH || f === FACE_EAST ? 1 : -1;
    const n = Math.max(1, Math.min(3, Math.floor(len / 4.2)));
    const bay = len / n;
    for (let i = 0; i < n; i++) {
      const t = ((i + 0.5) / n - 0.5) * len;
      const sw = Math.min(bay - 0.6, 2.6);
      const sh = Math.min(0.46, sw / 3.6);
      const out = damaged && rand(id, 1800 + i) < 0.5;
      parts.push({
        size: faceBox(f, bay * 0.56, 0.6, 0.05),
        at: onFace(f, t - bay * 0.1, base + 0.58, proud),
        color: out ? SOOT : GLASS,
        gloss: out ? 0 : 1,
      });
      parts.push({
        size: faceBox(f, 0.36, 0.64, 0.05),
        at: onFace(f, t + bay * 0.31, base + 0.34, proud),
        color: 0x2a2622,
      });
      parts.push({
        size: faceBox(f, sw + 0.1, sh + 0.08, 0.05),
        at: onFace(f, t, base + 1.38, proud),
        color: 0x2e2c29,
      });
      parts.push({
        size: [sw, sh, 0],
        at: onFace(f, t, base + 1.38, proud + 0.035),
        rot: [0, faceTurn(f), 0],
        color: 0xffffff,
        shade: damaged ? 0.5 : 0.95,
        sign: SIGN_SHOPS.from + Math.floor(rand(id, 1810 + i) * SIGN_SHOPS.count),
      });
      if (!damaged && rand(id, 1820 + i) < 0.5) {
        parts.push({
          size: faceBox(f, bay * 0.66, 0.04, 0.55),
          at: onFace(f, t - bay * 0.1, base + 1.02, 0.27),
          rot: faceX(f) ? [side * 0.38, 0, 0] : [0, 0, -side * 0.38],
          color: AWNINGS[Math.floor(rand(id, 1830 + i) * AWNINGS.length)],
          shade: 0.9,
        });
      }
    }
  }
  if (floors >= 2 && rand(id, 75) < 0.3) {
    const k = SIGN_STREETS.from + Math.floor(rand(id, 78) * SIGN_STREETS.count);
    for (const f of [FACE_SOUTH, FACE_EAST]) {
      if (f === shopFace) continue;
      parts.push({
        size: [0.95, 0.24, 0],
        at: onFace(f, faceLen(f) / 2 - 0.75, base + 1.4, proud + 0.03),
        rot: [0, faceTurn(f), 0],
        color: 0xffffff,
        shade: damaged ? 0.55 : 1,
        sign: k,
      });
    }
  }
  if (fort) sandbags();
  if (floors >= 2) {
    belt(base + (floors - 1) * FLOOR + 0.05, 0.06, 0.1, trim, wear);
    // A cornice where the counted floors end, under whatever each house adds on top.
    if (mass) belt(top - 0.05, 0.1, 0.16, trim, wear * 0.9);
  }
  if (shopFace !== FACE_SOUTH)
    parts.push({
      size: [0.9, 0.05, 0.4],
      at: [
        cx +
          ((Math.floor(Math.max(2, Math.round(w / 1.15)) / 2) + 0.5) /
            Math.max(2, Math.round(w / 1.15)) -
            0.5) *
            w,
        base + 0.7,
        cz + d / 2 + 0.2,
      ],
      color: trim,
      shade: wear * 0.8,
    });
  // Balconies on the upper floors of the bigger houses, here and there.
  if (!pitched && floors >= 3) {
    for (let f = 1; f < floors; f++) {
      for (let i = 0; i < Math.floor(w / 3.4); i++) {
        if (rand(id, 60 + f * 9 + i) < 0.45) continue;
        const bx = cx + ((i + 0.5) / Math.floor(w / 3.4) - 0.5) * w;
        const by = base + f * FLOOR + 0.2;
        parts.push({ size: [1.0, 0.05, 0.36], at: [bx, by, cz + d / 2 + 0.18], color: CONCRETE });
        parts.push({
          size: [1.0, 0.24, 0.03],
          at: [bx, by + 0.14, cz + d / 2 + 0.35],
          color: trim,
          shade: 0.8,
        });
      }
    }
  }
  // Windows on all four faces: dark glass set just proud of the wall. A Hong Kong block
  // has them in bands, one to a floor, between the columns of its frame.
  let k = 10;
  if (hk && floors >= 5)
    parts.push(...ribbons(id, cx, cz, w, d, base, floors, shopFace, damaged, wall, wear, wsurf));
  for (let f = 0; f < (hk && floors >= 5 ? 0 : floors); f++) {
    const y = base + f * FLOOR + FLOOR * 0.56;
    for (const [len, alongX] of [
      [w, true],
      [d, false],
    ] as const) {
      const n = Math.max(2, Math.round(len / 1.15));
      for (let i = 0; i < n; i++) {
        const t = ((i + 0.5) / n - 0.5) * len;
        for (const side of [-1, 1]) {
          k++;
          // A ground-floor doorway on one face; shot-out or boarded windows when damaged.
          const door = f === 0 && alongX && side === 1 && i === Math.floor(n / 2);
          const face = alongX
            ? side === 1
              ? FACE_SOUTH
              : FACE_NORTH
            : side === 1
              ? FACE_EAST
              : FACE_WEST;
          if (f === 0 && face === shopFace) continue;
          const blown = damaged && rand(id, k) < 0.45;
          // Fortified: most windows are boarded over, a slit left to fire through.
          const boarded = fort && !door && !blown && rand(id, k + 7000) < 0.7;
          const size: [number, number, number] = alongX
            ? [door ? 0.5 : 0.46, door ? 0.62 : 0.4, 0.05]
            : [0.05, 0.4, 0.46];
          const yy = door ? base + 0.31 : y;
          const off = side * ((alongX ? d : w) / 2 + (f === 0 ? proud : 0));
          parts.push({
            size: blown ? [size[0] * 1.5, size[1] * 1.6, size[2] * 1.5] : size,
            at: alongX ? [cx + t, yy, cz + off] : [cx + off, yy, cz + t],
            color: blown ? SOOT : boarded ? PLANK : door ? 0x2a2622 : GLASS,
            gloss: blown || door || boarded ? 0 : 1,
          });
        }
      }
    }
  }
  if (hk && floors >= 3 && cls !== BUILD_HALL) {
    parts.push(...streetFront(id, cx, cz, w, d, base, floors, shopFace, damaged));
  }
  if (damaged) {
    // Shell holes: big scorched patches on the walls, and part of the roof gone.
    for (let i = 0; i < 5 + w; i++) {
      const alongX = rand(id, 200 + i) < 0.5;
      const side = rand(id, 230 + i) < 0.5 ? -1 : 1;
      const t = (rand(id, 260 + i) - 0.5) * ((alongX ? w : d) - 1.6);
      const y = base + 0.5 + rand(id, 290 + i) * (h - 0.9);
      const s = 0.8 + rand(id, 320 + i) * 1.1;
      const off = (side * (alongX ? d : w)) / 2;
      parts.push({
        size: alongX ? [s, s * 0.8, 0.09] : [0.09, s * 0.8, s],
        at: alongX ? [cx + t, y, cz + off] : [cx + off, y, cz + t],
        color: SOOT,
        rot: alongX ? [0, 0, rand(id, 350 + i) - 0.5] : [rand(id, 350 + i) - 0.5, 0, 0],
      });
    }
    const sag = pitched ? Math.min(w, d) * 0.1 : 0;
    if (!mass)
      parts.push({
        size: [w * 0.45, 0.16 + sag * 1.6, d * 0.5],
        at: [
          cx + (rand(id, 5) - 0.5) * w * 0.5,
          base + h + 0.07 + sag * 0.8,
          cz + (rand(id, 6) - 0.5) * d * 0.4,
        ],
        color: SOOT,
      });
  }
  if (scorched) {
    // The ground floor has burnt (I5): its windows are black holes, soot stands up the
    // wall over each of them, and the foot of the wall is smoked dark.
    const reach = Math.min(h - 0.1, FLOOR * 1.9);
    for (let f = 0; f < 4; f++) {
      const len = faceLen(f);
      parts.push({
        size: faceBox(f, len - 0.1, FLOOR * 0.5, 0.05),
        at: onFace(f, 0, base + FLOOR * 0.25, 0.01),
        color: 0x1b1917,
      });
      const n = Math.max(2, Math.round(len / 1.5));
      for (let k = 0; k < n; k++) {
        const r = rand(id, 2600 + f * 40 + k);
        const t = ((k + 0.5) / n - 0.5) * (len - 0.5) + (r - 0.5) * 0.3;
        const tall = reach * (0.55 + rand(id, 2800 + f * 40 + k) * 0.45);
        const wide = 0.55 + r * 0.45;
        parts.push({
          size: faceBox(f, wide, tall, 0.07),
          at: onFace(f, t, base + FLOOR * 0.3 + tall / 2, 0.02),
          color: SOOT,
        });
        parts.push({
          size: faceBox(f, wide * 0.55, tall * 0.5, 0.07),
          at: onFace(f, t + (r - 0.5) * 0.4, base + FLOOR * 0.3 + tall * 1.2, 0.02),
          color: 0x1b1917,
        });
      }
    }
  }
  return level > 0 ? breakTop(parts, id, cx, cz, w, d, base, floors, level, wall, wsurf) : parts;
}

/**
 * How far a shot-up building has burnt down from the top (I1): 0 none, 1 the roof is off,
 * then a storey more for each step, all within the health the sim calls damaged, so it
 * is gutted on the very hit it always was. `hp` is 0..255 of the maximum.
 */
export function brokenLevel(hp: number, floors: number): number {
  const t = (DAMAGED_PCT - (hp * 100) / 255) / (DAMAGED_PCT - GUTTED_PCT);
  if (t <= 0) return 0;
  return Math.min(floors, Math.floor(Math.min(1, t) * (floors + 1)));
}

/** Storeys a building has lost at a broken level: the roof goes first, then a floor a step. */
export function lostFloors(level: number, floors: number): number {
  return Math.min(floors - 1, Math.max(0, level - 1));
}

/**
 * A building burnt down from the top: the roof and the top storeys gone, ragged walls
 * standing where they were with the sky through their windows, charred beams across, the
 * fallen roof in heaps on the floor that held, and soot up the face over the windows the
 * fire came out of.
 */
function breakTop(
  parts: Part[],
  id: number,
  cx: number,
  cz: number,
  w: number,
  d: number,
  base: number,
  floors: number,
  level: number,
  wall: number,
  wsurf: number,
): Part[] {
  const lost = lostFloors(level, floors);
  const cut = base + (floors - lost) * FLOOR;
  const out: Part[] = [];
  for (const p of parts) {
    const half = p.size[1] / 2;
    const bottom = p.at[1] - half;
    const fancy =
      p.rot !== undefined || p.hip !== undefined || p.sign !== undefined || p.taper !== undefined;
    if (fancy) {
      if (p.at[1] < cut - 0.05) out.push(p);
      continue;
    }
    if (bottom >= cut - 0.02) continue;
    if (p.at[1] + half <= cut) {
      out.push(p);
      continue;
    }
    const up = cut - bottom;
    out.push({ ...p, size: [p.size[0], up, p.size[2]], at: [p.at[0], bottom + up / 2, p.at[2]] });
    // The top of what held is the charred floor of the storey that burnt.
    if (p.size[0] > 2 && p.size[2] > 2) {
      out.push({
        size: [p.size[0] - 0.12, 0.08, p.size[2] - 0.12],
        at: [p.at[0], cut + 0.04, p.at[2]],
        color: 0x2b2926,
      });
    }
  }
  // Ragged walls where the lost storeys were (a low burnt parapet when only the roof went).
  const tall = lost * FLOOR + FLOOR * 0.55;
  for (let f = 0; f < 4; f++) {
    const alongX = f === FACE_NORTH || f === FACE_SOUTH;
    const side = f === FACE_SOUTH || f === FACE_EAST ? 1 : -1;
    const len = alongX ? w : d;
    const off = (side * ((alongX ? d : w) - 0.3)) / 2;
    const n = Math.max(3, Math.round(len / 1.6));
    for (let i = 0; i < n; i++) {
      const corner = i === 0 || i === n - 1;
      const r = rand(id, 2100 + f * 40 + i);
      const hh = tall * (corner ? 0.7 + r * 0.3 : r < 0.18 ? 0 : 0.12 + r * r * 0.88);
      if (hh < 0.15) continue;
      const t = ((i + 0.5) / n - 0.5) * len;
      out.push({
        size: alongX ? [len / n + 0.02, hh, 0.3] : [0.3, hh, len / n + 0.02],
        at: alongX ? [cx + t, cut + hh / 2, cz + off] : [cx + off, cut + hh / 2, cz + t],
        color: wall,
        shade: 0.38 + rand(id, 2300 + f * 40 + i) * 0.2,
        surf: wsurf,
      });
      for (let fl = 0; fl < lost; fl++) {
        const wy = cut + fl * FLOOR + FLOOR * 0.56;
        if (wy + 0.3 > cut + hh) break;
        out.push({
          size: alongX ? [0.5, 0.44, 0.34] : [0.34, 0.44, 0.5],
          at: alongX ? [cx + t, wy, cz + off] : [cx + off, wy, cz + t],
          color: SOOT,
        });
      }
    }
    // Soot licked up the face from the windows of the top storey that still stands.
    const streaks = 2 + Math.floor(rand(id, 2500 + f) * 3);
    for (let k = 0; k < streaks; k++) {
      const t = (rand(id, 2510 + f * 8 + k) - 0.5) * (len - 1.2);
      const up = FLOOR * (0.45 + rand(id, 2530 + f * 8 + k) * 0.3);
      const y = cut - FLOOR * 0.44 + up / 2;
      const o = (side * (alongX ? d : w)) / 2 + side * 0.04;
      out.push({
        size: alongX ? [0.62, up, 0.05] : [0.05, up, 0.62],
        at: alongX ? [cx + t, y, cz + o] : [cx + o, y, cz + t],
        color: SOOT,
      });
    }
  }
  // Charred beams across the gap, and the roof that came down, in heaps on the floor.
  for (let i = 0; i < 3; i++) {
    const across = w < d;
    const t = ((i + 0.5) / 3 - 0.5) * (across ? d : w) * 0.7;
    const y = cut + Math.min(tall * 0.8, 0.3 + rand(id, 2600 + i) * tall * 0.7);
    out.push({
      size: across
        ? [w * (0.5 + rand(id, 2610 + i) * 0.45), 0.1, 0.12]
        : [0.12, 0.1, d * (0.5 + rand(id, 2610 + i) * 0.45)],
      at: across ? [cx, y, cz + t] : [cx + t, y, cz],
      rot: across
        ? [0, 0, (rand(id, 2620 + i) - 0.5) * 0.6]
        : [(rand(id, 2620 + i) - 0.5) * 0.6, 0, 0],
      color: SOOT,
    });
  }
  for (let i = 0; i < 4 + Math.min(14, w * d * 0.04); i++) {
    const s = 0.5 + rand(id, 2700 + i) * 1.3;
    out.push({
      size: [s, 0.14 + rand(id, 2730 + i) * 0.3, s * (0.5 + rand(id, 2760 + i) * 0.6)],
      at: [
        cx + (rand(id, 2790 + i) - 0.5) * (w - 1.5),
        cut + 0.12 + rand(id, 2820 + i) * 0.2,
        cz + (rand(id, 2850 + i) - 0.5) * (d - 1.5),
      ],
      rot: [
        (rand(id, 2880 + i) - 0.5) * 0.7,
        rand(id, 2910 + i) * 3.1,
        (rand(id, 2940 + i) - 0.5) * 0.7,
      ],
      color: i % 3 === 0 ? 0x4c4a46 : i % 3 === 1 ? TILES[i % TILES.length] : wall,
      shade: 0.35 + rand(id, 2970 + i) * 0.25,
      surf: SURF_RUBBLE,
    });
  }
  return out;
}

/** What is left: a scorched heap of slabs with stumps of wall still standing. */
// Base buildings: prefabricated, drab, low and wide. The only colour is a band of the
// owner's paint along the roof line.
const DRAB = 0x5d6149;
const DRAB_DARK = 0x3f4434;
const PANEL = 0x8b8c84;
const SHEET = 0x4c514d;
const TEAM_PAINT = [0x8a2b22, 0x27467a, 0x9a7a1e];
const CRATES = [0x5d6149, 0x6b4a36, 0x4b5560, 0x7a7466, 0x55503f];

/**
 * A base building on the plot (x0, z0, w, d). `stage` 0 = finished, 1 = shot up,
 * 3 = going up: a slab, posts and the first course of wall.
 */
function baseParts(
  id: number,
  type: number,
  team: number,
  x0: number,
  z0: number,
  w: number,
  d: number,
  base: number,
  stage: number,
): Part[] {
  const parts: Part[] = [];
  const cx = x0 + w / 2;
  const cz = z0 + d / 2;
  const wear = stage === 1 ? 0.6 : 1;
  const paint = TEAM_PAINT[team] ?? 0x777777;
  parts.push({ size: [w + 0.6, 2.2, d + 0.6], at: [cx, base - 1.0, cz], color: 0x6a6861 });
  if (stage === 3) {
    for (const [px, pz] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
      [0.5, 0],
      [0.5, 1],
    ]) {
      parts.push({
        size: [0.16, 1.6, 0.16],
        at: [x0 + 0.3 + px * (w - 0.6), base + 0.9, z0 + 0.3 + pz * (d - 0.6)],
        color: 0x9a968c,
      });
    }
    parts.push({ size: [w - 0.4, 0.5, 0.2], at: [cx, base + 0.35, z0 + 0.3], color: PANEL });
    parts.push({ size: [0.2, 0.5, d - 0.4], at: [x0 + 0.3, base + 0.35, cz], color: PANEL });
    parts.push({ size: [1.6, 0.5, 1.1], at: [cx + 1, base + 0.35, cz + 0.6], color: CRATES[1] });
    parts.push({ size: [w - 0.4, 0.1, 0.1], at: [cx, base + 1.7, z0 + 0.3], color: 0x9a968c });
    parts.push({ size: [w - 0.4, 0.1, 0.1], at: [cx, base + 1.7, z0 + d - 0.3], color: 0x9a968c });
    return parts;
  }
  // A long shed with a low pitched roof and a band of team paint under the eaves.
  const shed = (sx: number, sz: number, sw: number, sd: number, h: number, color: number) => {
    parts.push({ size: [sw, h, sd], at: [sx, base + h / 2, sz], color, shade: wear });
    // Sheet-metal roof with a low pitch, and vents along the ridge.
    parts.push({
      size: [sw + 0.3, Math.min(sw, sd) * 0.14, sd + 0.3],
      at: [sx, base + h, sz],
      color: SHEET,
      shade: wear,
      hip: 0,
      surf: SURF_SHEET,
    });
    const long = Math.max(sw, sd);
    for (let k = 0; k < Math.floor(long / 3); k++) {
      const a = ((k + 0.5) / Math.floor(long / 3) - 0.5) * long * 0.8;
      parts.push({
        size: [0.3, 0.2, 0.3],
        at: [sx + (sw >= sd ? a : 0), base + h + Math.min(sw, sd) * 0.14, sz + (sw >= sd ? 0 : a)],
        color: 0x6f726d,
      });
    }
    parts.push({ size: [sw + 0.06, 0.16, sd + 0.06], at: [sx, base + h - 0.2, sz], color: paint });
    // Frame posts down the walls, a footing, a door and a row of small windows to the south.
    parts.push({ size: [sw + 0.1, 0.18, sd + 0.1], at: [sx, base + 0.09, sz], color: 0x55534d });
    const bays = Math.max(2, Math.round(sw / 1.5));
    for (let k = 0; k <= bays; k++) {
      const px = sx + (k / bays - 0.5) * sw;
      for (const side of [-1, 1]) {
        parts.push({
          size: [0.07, h, 0.05],
          at: [px, base + h / 2, sz + side * (sd / 2 + 0.02)],
          color,
          shade: wear * 0.7,
        });
      }
    }
    if (h > 1.2) {
      for (let k = 0; k < bays; k++) {
        const px = sx + ((k + 0.5) / bays - 0.5) * sw;
        if (k === Math.floor(bays / 2)) {
          parts.push({
            size: [0.6, Math.min(1.0, h * 0.6), 0.05],
            at: [px, base + Math.min(1.0, h * 0.6) / 2, sz + sd / 2 + 0.03],
            color: DRAB_DARK,
          });
        } else if (k % 2 === 0) {
          parts.push({
            size: [0.55, 0.3, 0.05],
            at: [px, base + h * 0.62, sz + sd / 2 + 0.03],
            color: GLASS,
            gloss: 1,
          });
        }
      }
    }
  };
  /** A short wall of sandbags, two courses, the top one set back. */
  const bags = (bx: number, bz: number, len: number, alongX: boolean) => {
    parts.push({
      size: alongX ? [len, 0.3, 0.42] : [0.42, 0.3, len],
      at: [bx, base + 0.15, bz],
      color: 0x8a7f62,
      shade: wear,
    });
    parts.push({
      size: alongX ? [len - 0.3, 0.26, 0.32] : [0.32, 0.26, len - 0.3],
      at: [bx, base + 0.43, bz],
      color: 0x7d7358,
      shade: wear,
    });
  };
  const mast = (mx: number, mz: number, h: number) => {
    parts.push({ size: [0.08, h, 0.08], at: [mx, base + h / 2, mz], color: 0x9a9a96 });
    parts.push({ size: [0.7, 0.05, 0.05], at: [mx, base + h * 0.8, mz], color: 0x9a9a96 });
    parts.push({ size: [0.05, 0.05, 0.5], at: [mx, base + h * 0.92, mz], color: 0x9a9a96 });
  };
  if (type === B_HQ) {
    shed(cx, cz - d * 0.12, w * 0.8, d * 0.5, 2.3, PANEL);
    shed(cx - w * 0.18, cz + d * 0.3, w * 0.44, d * 0.3, 1.4, DRAB);
    mast(cx + w * 0.3, cz + d * 0.3, 6.5);
    mast(cx + w * 0.22, cz + d * 0.36, 4.2);
    // A dish on the annexe, a generator beside it, sandbags at the door.
    parts.push({
      size: [0.9, 0.06, 0.9],
      at: [cx - w * 0.3, base + 2.05, cz + d * 0.3],
      color: 0xa3a5a0,
      rot: [0.7, 0.5, 0],
    });
    parts.push({
      size: [0.08, 0.5, 0.08],
      at: [cx - w * 0.3, base + 1.7, cz + d * 0.3],
      color: 0x777a78,
    });
    parts.push({
      size: [1.3, 0.7, 0.7],
      at: [cx + w * 0.34, base + 0.35, cz - d * 0.3],
      color: CRATES[2],
    });
    parts.push({
      size: [0.1, 0.5, 0.1],
      at: [cx + w * 0.38, base + 0.95, cz - d * 0.3],
      color: 0x3b3d3d,
    });
    bags(cx + w * 0.12, cz + d * 0.44, w * 0.3, true);
    bags(cx + w * 0.3, cz + d * 0.22, d * 0.2, false);
    // The flag of whoever commands from here.
    parts.push({
      size: [0.07, 4.6, 0.07],
      at: [cx - w * 0.42, base + 2.3, cz + d * 0.42],
      color: 0x9a9a96,
    });
    parts.push({
      size: [1.5, 0.9, 0.05],
      at: [cx - w * 0.42 + 0.78, base + 4.1, cz + d * 0.42],
      color: paint,
    });
  } else if (type === B_DEPOT) {
    // An open yard of containers and crates under a lean-to.
    shed(cx - w * 0.22, cz - d * 0.2, w * 0.45, d * 0.5, 1.5, DRAB);
    for (let k = 0; k < 7; k++) {
      const col = k % 3;
      const row = Math.floor(k / 3);
      const tall = rand(id, 20 + k) > 0.55 ? 2 : 1;
      parts.push({
        size: [1.9, 0.75 * tall, 0.85],
        at: [
          x0 + w * 0.6 + (col - 0.5) * 1.0 * (k % 2 ? 1 : 0.2),
          base + 0.375 * tall,
          z0 + 1.0 + row * 1.35 + col * 0.3,
        ],
        color: CRATES[Math.floor(rand(id, 40 + k) * CRATES.length)],
        shade: wear,
      });
    }
    parts.push({ size: [w * 0.9, 0.14, 0.14], at: [cx, base + 0.5, z0 + d - 0.2], color: paint });
  } else if (type === B_BARRACKS) {
    shed(cx, cz - d * 0.24, w * 0.9, d * 0.36, 1.25, DRAB);
    shed(cx, cz + d * 0.24, w * 0.9, d * 0.36, 1.25, DRAB);
    // Kit crates in the yard between the huts, sandbags at each end of it.
    for (let k = 0; k < 4; k++) {
      parts.push({
        size: [0.8, 0.4 + 0.3 * rand(id, 50 + k), 0.5],
        at: [x0 + (w * (k + 1)) / 5, base + 0.25, cz + (rand(id, 54 + k) - 0.5) * d * 0.08],
        color: CRATES[Math.floor(rand(id, 58 + k) * CRATES.length)],
        shade: wear,
      });
    }
    bags(x0 + 0.4, cz, d * 0.14, false);
    bags(x0 + w - 0.4, cz, d * 0.14, false);
  } else if (type === B_WORKS) {
    // A vehicle hall with two dark doors on the south side and a workshop annexe.
    shed(cx, cz - d * 0.1, w * 0.86, d * 0.62, 2.1, PANEL);
    for (const side of [-1, 1]) {
      parts.push({
        size: [w * 0.3, 1.5, 0.06],
        at: [cx + side * w * 0.2, base + 0.75, cz - d * 0.1 + d * 0.31],
        color: DRAB_DARK,
      });
    }
    shed(cx + w * 0.25, cz + d * 0.36, w * 0.3, d * 0.18, 1.1, DRAB);
    parts.push({
      size: [0.5, 2.9, 0.5],
      at: [cx - w * 0.36, base + 1.45, cz + d * 0.36],
      color: 0x55524c,
    });
  } else if (type === B_DRONES) {
    shed(cx - w * 0.14, cz - d * 0.1, w * 0.55, d * 0.6, 1.3, DRAB);
    parts.push({
      size: [2.0, 0.8, 0.9],
      at: [cx + w * 0.26, base + 0.4, cz + d * 0.2],
      color: CRATES[2],
    });
    mast(cx + w * 0.3, cz - d * 0.3, 4.8);
    // A launch rail pointing at the sky.
    parts.push({
      size: [0.12, 0.08, 2.2],
      at: [cx - w * 0.1, base + 0.65, cz + d * 0.34],
      color: 0x9a9a96,
      rot: [-0.35, 0.6, 0],
    });
    parts.push({
      size: [1.0, 0.06, 1.0],
      at: [cx + w * 0.26, base + 1.5, cz - d * 0.05],
      color: 0x8f918c,
      rot: [0.5, 0, 0.2],
    });
  } else if (type === B_HELIPAD) {
    // A concrete pad with a painted H in a ring of the army's colour, lamps at the
    // corners, and a hut and a windsock mast at the back.
    const r = Math.min(w, d) * 0.3;
    parts.push({
      size: [r * 2.5, 1.2, r * 2.5],
      at: [cx, base - 0.2, cz + d * 0.08],
      color: 0x77786f,
    });
    for (const side of [-1, 1]) {
      parts.push({
        size: [0.34, 0.03, r * 1.1],
        at: [cx + side * r * 0.42, base + 0.42, cz + d * 0.08],
        color: 0xd8d6c8,
      });
      parts.push({
        size: [r * 2.3, 0.03, 0.22],
        at: [cx, base + 0.42, cz + d * 0.08 + side * r * 1.12],
        color: paint,
      });
      parts.push({
        size: [0.22, 0.03, r * 2.3],
        at: [cx + side * r * 1.12, base + 0.42, cz + d * 0.08],
        color: paint,
      });
      for (const end of [-1, 1]) {
        parts.push({
          size: [0.16, 0.3, 0.16],
          at: [cx + side * r * 1.2, base + 0.5, cz + d * 0.08 + end * r * 1.2],
          color: 0xc9b458,
        });
      }
    }
    parts.push({
      size: [r * 0.84, 0.03, 0.3],
      at: [cx, base + 0.42, cz + d * 0.08],
      color: 0xd8d6c8,
    });
    shed(cx - w * 0.3, cz - d * 0.4, w * 0.3, d * 0.14, 1.2, DRAB);
    mast(cx + w * 0.4, cz - d * 0.4, 3.6);
    parts.push({
      size: [0.9, 0.22, 0.22],
      at: [cx + w * 0.4 + 0.5, base + 3.4, cz - d * 0.4],
      color: 0xc8643c,
    });
  }
  if (stage === 1) {
    parts.push({
      size: [w * 0.4, 0.5, d * 0.3],
      at: [cx + 0.6, base + 0.25, cz + 0.4],
      color: SOOT,
    });
  }
  return parts;
}

/** A resource site: a stockpile of crates under tarpaulins, or a pumpjack and its tank. */
function siteParts(k: number, kind: number, x: number, y: number, z: number): Part[] {
  const parts: Part[] = [];
  if (kind === SITE_SUPPLIES) {
    for (let i = 0; i < 9; i++) {
      const a = rand(k, i) * 6.283;
      const r = 0.6 + rand(k, 30 + i) * 2.1;
      const tall = i < 3 ? 2 : 1;
      parts.push({
        size: [1.7, 0.7 * tall, 0.8],
        at: [x + Math.cos(a) * r, y + 0.35 * tall, z + Math.sin(a) * r],
        color: CRATES[i % CRATES.length],
        rot: [0, rand(k, 60 + i) * 3.1, 0],
      });
    }
    parts.push({ size: [2.4, 1.0, 1.8], at: [x, y + 0.5, z], color: 0x4a4f3a, rot: [0, 0.4, 0] });
  } else {
    parts.push({ size: [4.2, 0.12, 3.2], at: [x, y + 0.06, z], color: 0x4b4a46 });
    parts.push({ size: [1.5, 1.5, 1.5], at: [x - 1.2, y + 0.75, z + 0.6], color: 0x2c2d2e });
    parts.push({ size: [1.56, 0.12, 1.56], at: [x - 1.2, y + 1.2, z + 0.6], color: 0xb58a1c });
    parts.push({ size: [0.16, 1.7, 0.16], at: [x + 0.8, y + 0.85, z - 0.5], color: 0x2c2d2e });
    parts.push({
      size: [2.5, 0.16, 0.16],
      at: [x + 0.9, y + 1.75, z - 0.5],
      color: 0xb58a1c,
      rot: [0, 0, 0.22],
    });
    parts.push({ size: [0.3, 0.6, 0.3], at: [x + 2.05, y + 1.75, z - 0.5], color: 0x2c2d2e });
    parts.push({ size: [0.6, 0.5, 0.7], at: [x - 0.2, y + 0.25, z - 0.5], color: 0x3f4434 });
  }
  return parts;
}
/** Colours of the marker over a site: supplies tan, fuel amber. */
const SITE_UI = [
  [0.86, 0.74, 0.5],
  [0.95, 0.66, 0.1],
];

export function rubbleParts(
  id: number,
  x0: number,
  z0: number,
  w: number,
  d: number,
  base: number,
  floors: number,
  pancake = false,
): Part[] {
  const parts: Part[] = [];
  const cx = x0 + w / 2;
  const cz = z0 + d / 2;
  const wall = WALLS[Math.floor(rand(id, 1) * WALLS.length)];
  parts.push({ size: [w + 1.2, 2.4, d + 1.2], at: [cx, base - 1.14, cz], color: 0x3a3733 });
  if (pancake) return pancakeParts(parts, id, cx, cz, w, d, base, floors, wall);
  const slabs = 14 + w * d * 0.5;
  for (let i = 0; i < slabs; i++) {
    const s = 0.8 + rand(id, 400 + i) * 2.2;
    const central = 1 - Math.abs(rand(id, 430 + i) - 0.5) * 2;
    parts.push({
      size: [s, 0.18 + rand(id, 460 + i) * 0.5, s * (0.5 + rand(id, 490 + i) * 0.7)],
      at: [
        cx + (rand(id, 520 + i) - 0.5) * (w + 0.6),
        base + 0.1 + central * 0.55 * Math.min(2, floors * 0.5) * rand(id, 550 + i),
        cz + (rand(id, 580 + i) - 0.5) * (d + 0.6),
      ],
      rot: [
        (rand(id, 610 + i) - 0.5) * 0.9,
        rand(id, 640 + i) * 3.1,
        (rand(id, 670 + i) - 0.5) * 0.9,
      ],
      color: i % 3 === 0 ? 0x4c4a46 : wall,
      shade: 0.42 + rand(id, 700 + i) * 0.3,
      surf: SURF_RUBBLE,
    });
  }
  // Corners and stretches of wall that did not come down, at ragged heights.
  for (let i = 0; i < 5; i++) {
    const alongX = i % 2 === 0;
    const side = rand(id, 800 + i) < 0.5 ? -1 : 1;
    const len = 1 + rand(id, 810 + i) * (alongX ? w : d) * 0.4;
    const t = (rand(id, 820 + i) - 0.5) * ((alongX ? w : d) - len);
    const hh = FLOOR * (0.5 + rand(id, 830 + i) * Math.min(floors - 0.6, 1.7));
    const off = (side * (alongX ? d : w)) / 2;
    parts.push({
      size: alongX ? [len, hh, 0.3] : [0.3, hh, len],
      at: alongX ? [cx + t, base + hh / 2, cz + off] : [cx + off, base + hh / 2, cz + t],
      rot: alongX
        ? [0, 0, (rand(id, 840 + i) - 0.5) * 0.12]
        : [(rand(id, 840 + i) - 0.5) * 0.12, 0, 0],
      color: wall,
      shade: 0.5,
    });
  }
  return parts;
}

/**
 * A building whose ground floor gave way (I5): the floors came straight down on each
 * other and lie stacked where it stood, the roof on top, each a little off the one below,
 * with what was between them squeezed out round the edge. No wall is left standing.
 */
function pancakeParts(
  parts: Part[],
  id: number,
  cx: number,
  cz: number,
  w: number,
  d: number,
  base: number,
  floors: number,
  wall: number,
): Part[] {
  const gap = 0.5;
  let y = base + 0.25;
  for (let k = 0; k <= floors; k++) {
    const roof = k === floors;
    // Each slab slid a little further than the one under it, so their pale edges show
    // as steps from above; the roof broke in two across the middle.
    const sx = (rand(id, 920 + k) - 0.5) * 1.6;
    const sz = (rand(id, 930 + k) - 0.5) * 1.6;
    for (const half of roof ? [-1, 1] : [0]) {
      parts.push({
        size: [
          w * (0.97 - rand(id, 900 + k) * 0.06) * (roof ? 0.49 : 1),
          roof ? 0.2 : 0.26,
          d * (0.97 - rand(id, 910 + k) * 0.06),
        ],
        at: [cx + sx + half * w * 0.26, y + (roof ? 0.12 : 0), cz + sz],
        rot: [
          (rand(id, 940 + k) - 0.5) * 0.1,
          (rand(id, 950 + k + half) - 0.5) * 0.12,
          roof ? half * (0.1 + rand(id, 960 + k) * 0.1) : (rand(id, 960 + k) - 0.5) * 0.1,
        ],
        color: roof ? 0x5b5750 : 0x8e8c85,
        shade: roof ? 0.7 : 0.7 + rand(id, 970 + k) * 0.22,
        surf: SURF_RUBBLE,
      });
    }
    // Crushed walls and furniture between this slab and the next.
    if (!roof) {
      parts.push({
        size: [w * 0.9, gap - 0.2, d * 0.9],
        at: [cx + sx * 0.5, y + gap / 2, cz + sz * 0.5],
        color: wall,
        shade: 0.32,
        surf: SURF_RUBBLE,
      });
    }
    y += gap;
  }
  // What burst out sideways as it came down: a skirt of broken wall round the stack.
  const bits = 10 + Math.round((w + d) * 1.2);
  for (let i = 0; i < bits; i++) {
    const alongX = i % 2 === 0;
    const side = rand(id, 1000 + i) < 0.5 ? -1 : 1;
    const t = (rand(id, 1030 + i) - 0.5) * (alongX ? w : d);
    const out = (alongX ? d : w) / 2 + 0.2 + rand(id, 1060 + i) * 1.1;
    const s = 0.5 + rand(id, 1090 + i) * 1.3;
    parts.push({
      size: [s, 0.16 + rand(id, 1120 + i) * 0.4, s * (0.5 + rand(id, 1150 + i) * 0.6)],
      at: alongX
        ? [cx + t, base + 0.12 + rand(id, 1180 + i) * 0.3, cz + side * out]
        : [cx + side * out, base + 0.12 + rand(id, 1180 + i) * 0.3, cz + t],
      rot: [
        (rand(id, 1210 + i) - 0.5) * 1.1,
        rand(id, 1240 + i) * 3.1,
        (rand(id, 1270 + i) - 0.5) * 1.1,
      ],
      color: i % 3 === 0 ? 0x4c4a46 : wall,
      shade: 0.42 + rand(id, 1300 + i) * 0.3,
      surf: SURF_RUBBLE,
    });
  }
  return parts;
}

/** A road bridge: sloped deck with kerbs on piers; when cut, the middle spans are gone. */
function bridgeParts(
  x0: number,
  z0: number,
  len: number,
  width: number,
  west: number,
  east: number,
  cut: boolean,
): Part[] {
  const parts: Part[] = [];
  const cz = z0 + width / 2;
  const slope = Math.atan2(east - west, len);
  const span = (from: number, to: number, sag = 0, tilt = 0) => {
    const mid = (from + to) / 2;
    const l = (to - from) / Math.cos(slope);
    const y = west + (east - west) * mid - sag;
    const x = x0 + len * mid;
    const rot: [number, number, number] = [0, 0, slope + tilt];
    parts.push({ size: [l * len, 0.36, width - 0.9], at: [x, y - 0.18, cz], rot, color: CONCRETE });
    parts.push({ size: [l * len, 0.03, width - 2], at: [x, y + 0.012, cz], rot, color: ASPHALT });
    for (const side of [-1, 1]) {
      parts.push({
        size: [l * len, 0.26, 0.14],
        at: [x, y + 0.13, cz + side * (width / 2 - 0.55)],
        rot,
        color: CONCRETE,
        shade: 0.85,
      });
    }
  };
  if (cut) {
    span(-0.04, 0.2);
    span(0.8, 1.04);
    // Fallen spans lying broken in the river.
    span(0.24, 0.46, 1.9, -0.35);
    span(0.54, 0.76, 2.0, 0.4);
  } else {
    span(-0.04, 1.04);
  }
  const piers = Math.max(2, Math.round(len / 9));
  for (let i = 1; i < piers; i++) {
    const t = i / piers;
    const top = west + (east - west) * t - 0.36 - (cut && t > 0.2 && t < 0.8 ? 0.8 : 0);
    parts.push({
      size: [0.9, top + 4, width - 2.4],
      at: [x0 + len * t, (top - 4) / 2, cz],
      color: CONCRETE,
      shade: 0.8,
    });
  }
  return parts;
}

/**
 * A bridge that is a square over a river running under it corner to corner (the European
 * city): stone paving, a carriageway each way across it, and a balustrade along the edges
 * that stand over the water. Cut, only the two corners that rest on the banks are left.
 */
function squareBridgeParts(
  x0: number,
  z0: number,
  side: number,
  top: number,
  cut: boolean,
): Part[] {
  const parts: Part[] = [];
  const STONE = 0x8a877d;
  const mid = side / 2;
  const slab = (
    cx: number,
    cz: number,
    w: number,
    d: number,
    sag = 0,
    rot?: [number, number, number],
  ) =>
    parts.push({ size: [w, 0.4, d], at: [x0 + cx, top - 0.2 - sag, z0 + cz], rot, color: STONE });
  const lane = 11.2;
  if (cut) {
    // What rests on the west bank (south-west corner) and on the east bank (north-east).
    const keep = side * 0.3;
    slab(keep / 2, side - keep / 2, keep, keep);
    slab(side - keep / 2, keep / 2, keep, keep);
    slab(mid - 4, mid + 5, side * 0.34, side * 0.3, 2.3, [0.3, 0.5, -0.2]);
    slab(mid + 5, mid - 4, side * 0.3, side * 0.34, 2.5, [-0.25, 0.3, 0.3]);
    slab(mid, mid, side * 0.22, side * 0.2, 3, [0.15, 0.8, 0.1]);
  } else {
    slab(mid, mid, side, side);
    parts.push({ size: [side, 0.04, lane], at: [x0 + mid, top + 0.02, z0 + mid], color: ASPHALT });
    parts.push({ size: [lane, 0.04, side], at: [x0 + mid, top + 0.021, z0 + mid], color: ASPHALT });
    // Balustrades over the water: the north-west and the south-east corner.
    const run = mid - lane / 2 - 0.6;
    const rail = (cx: number, cz: number, w: number, d: number) =>
      parts.push({
        size: [w, 1.0, d],
        at: [x0 + cx, top + 0.5, z0 + cz],
        color: STONE,
        shade: 0.86,
      });
    rail(run / 2, 0.25, run, 0.5);
    rail(0.25, run / 2, 0.5, run);
    rail(side - run / 2, side - 0.25, run, 0.5);
    rail(side - 0.25, side - run / 2, 0.5, run);
    for (const [cx, cz] of [
      [0.4, 0.4],
      [run, 0.4],
      [0.4, run],
      [side - 0.4, side - 0.4],
      [side - run, side - 0.4],
      [side - 0.4, side - run],
    ]) {
      parts.push({ size: [0.8, 1.5, 0.8], at: [x0 + cx, top + 0.75, z0 + cz], color: STONE });
      parts.push({ size: [0.12, 3.4, 0.12], at: [x0 + cx, top + 3.2, z0 + cz], color: SHEET });
      parts.push({ size: [0.4, 0.3, 0.4], at: [x0 + cx, top + 5, z0 + cz], color: 0xd8d2b4 });
    }
  }
  // Two piers in the stream.
  for (const k of [-1, 1]) {
    parts.push({
      size: [2.2, top + 3, 2.2],
      at: [x0 + mid + k * 3, (top - 3) / 2 - (cut ? 1 : 0.4), z0 + mid + k * 3],
      color: CONCRETE,
      shade: 0.8,
    });
  }
  return parts;
}

export class StructureView {
  readonly group = new THREE.Group();
  /** Per structure, refilled every frame by the unit view: own (or revealed) occupants. */
  readonly occ = new Uint8Array(MAX_STRUCTS);
  readonly occTeam = new Uint8Array(MAX_STRUCTS);
  readonly occSelected = new Uint8Array(MAX_STRUCTS);
  /** Latest health per structure (0..255, 0 = destroyed) and town state from the sim. */
  readonly hp = new Uint8Array(MAX_STRUCTS).fill(255);
  townOwner: Uint8Array = new Uint8Array(0);
  townCapturer: Uint8Array = new Uint8Array(0);
  townProgress: Uint8Array = new Uint8Array(0);
  credits: number[] = [];
  /** Base buildings: owner (-1 = not one), type and construction 0..100; the raw records. */
  readonly baseTeam = new Int8Array(MAX_STRUCTS).fill(-1);
  readonly baseType = new Uint8Array(MAX_STRUCTS);
  readonly basePct = new Uint8Array(MAX_STRUCTS);
  bases: Int32Array = new Int32Array(0);
  /** Enemy base buildings stay off the map until one of your units has laid eyes on them. */
  private readonly found = new Uint8Array(MAX_STRUCTS);
  /** Show every base building from the start (spectating, commanding both armies). */
  revealAll = false;
  /** What is left at each resource site. */
  readonly siteStock = new Int32Array(MAX_SITES).fill(1);
  private readonly siteMeshes: THREE.Mesh[] = [];
  /** Bumped whenever a structure changes state, so the minimap knows to redraw its base. */
  version = 0;

  private readonly material: THREE.MeshStandardNodeMaterial;
  private readonly meshes: (THREE.Mesh | null)[] = [];
  /**
   * The map's own buildings are not drawn one by one (a city has hundreds): all those of a
   * square of ground are merged into one mesh. A building keeps no geometry of its own:
   * where it lies in its square's mesh is in `near` and `far` (first vertex, vertices,
   * first index, indices), and when it changes, its new geometry waits in `fresh` until
   * the square is merged again from the old mesh and the new pieces.
   */
  private readonly near = new Int32Array(MAX_STRUCTS * 4);
  private readonly far = new Int32Array(MAX_STRUCTS * 4);
  private readonly fresh = new Map<
    number,
    { near: THREE.BufferGeometry; far: THREE.BufferGeometry | null }
  >();
  /** Buildings whose look changed and is still to be built (structure id to `shown` key). */
  private readonly pending = new Map<number, number>();
  /** Per square: how many of its buildings are still in `pending`. */
  private readonly pendingIn = new Int32Array(CHUNKS * CHUNKS);
  /** Set once the town is built: from then on, changed buildings are rebuilt a few a frame. */
  private ready = false;
  private readonly chunks: (THREE.Mesh | null)[] = new Array(CHUNKS * CHUNKS).fill(null);
  private readonly farChunks: (THREE.Mesh | null)[] = new Array(CHUNKS * CHUNKS).fill(null);
  /** Which squares are drawn simplified just now. */
  private readonly isFar = new Uint8Array(CHUNKS * CHUNKS);
  /** `?far=0`: never simplify (to compare). */
  farDetail = true;
  /** The cutaway: what the camera looks at, the way from there to the camera, how strong. */
  private readonly cutFocus = uniform(new THREE.Vector3());
  private readonly cutDir = uniform(new THREE.Vector2(0, 1));
  private readonly cutStrength = uniform(0);
  /** Whether buildings in front of the view are seen through from close up (Y). */
  seeThrough = false;
  private readonly chunkOf: number[][] = Array.from({ length: CHUNKS * CHUNKS }, () => []);
  private readonly dirty = new Set<number>();
  /** Latest state per structure (STAGE_*) and its breached faces, one bit each (FACE_*). */
  readonly stage = new Uint8Array(MAX_STRUCTS);
  readonly breached = new Uint8Array(MAX_STRUCTS);
  /** 1 where engineers have fortified the building. */
  readonly fort = new Uint8Array(MAX_STRUCTS);
  /** How far each shot-up building has burnt down from the top (brokenLevel), and since when. */
  readonly broken = new Uint8Array(MAX_STRUCTS);
  /**
   * The fire in the ground floor (I5): floors alight now, 1 where the ground floor is or
   * has been on fire, and 1 where the building came down as a pancake.
   */
  readonly alight = new Uint8Array(MAX_STRUCTS);
  readonly scorched = new Uint8Array(MAX_STRUCTS);
  readonly pancaked = new Uint8Array(MAX_STRUCTS);
  private readonly burnAt = new Float32Array(MAX_STRUCTS).fill(-1e9);
  /** Where the camera is, for the fires: only those near enough to see are lit. */
  private readonly eye = new THREE.Vector3(0, 1e6, 0);
  /**
   * What is drawn: 0 standing, 1 damaged, 2 destroyed, 3 going up, 4 gutted, plus the
   * breached faces times eight.
   */
  private readonly shown = new Int16Array(MAX_STRUCTS).fill(-1);
  private readonly fellAt = new Float32Array(MAX_STRUCTS).fill(-1e9);
  /** How far each building's roof stands above its counted floors (chimneys and all). */
  private readonly crest = new Float32Array(MAX_STRUCTS).fill(0.9);
  private readonly pips: Batch;
  private readonly flags: Batch;
  private readonly shadows: boolean;
  /** Set by the game once the land's small things exist. */
  clutter: Clutter | null = null;

  constructor(
    private readonly map: GameMap,
    private readonly terrain: Terrain,
    private readonly fog: Fog,
    private readonly effects: Effects,
    look: Look,
  ) {
    this.shadows = look.shadows;
    this.material = new THREE.MeshStandardNodeMaterial({ roughness: 0.93, metalness: 0 });
    // The cutaway ("roof fade", URBAN.md 5.5): seen from close up, whatever stands between
    // the camera and the street it looks at is drawn as a screen of dots above the ground
    // floor, so the troops behind a six-floor block can be seen and clicked. The walls keep
    // their footprint and their ground floor; nothing changes in the sim or in picking.
    const cutaway =
      typeof location === 'undefined' ||
      new URLSearchParams(location.search).get('cutaway') !== '0';
    if (cutaway) {
      const rel = positionWorld.xz.sub(this.cutFocus.xz);
      // How far this point is toward the camera from what it looks at, and how far to the side.
      const toward = rel.dot(this.cutDir);
      const aside = rel.x.mul(this.cutDir.y).sub(rel.y.mul(this.cutDir.x)).abs();
      const zone = smoothstep(2.5, 5, toward)
        .mul(smoothstep(52, 44, toward))
        .mul(smoothstep(19, 15, aside));
      const above = smoothstep(3.1, 3.5, positionWorld.y.sub(this.cutFocus.y));
      const fade = zone.mul(above).mul(this.cutStrength);
      // A fixed pattern on the screen that spreads the kept dots evenly at any density.
      const cell = screenCoordinate.xy.floor();
      const dot = cell.x.mul(0.7548776662).add(cell.y.mul(0.5698402909)).fract();
      this.material.opacityNode = step(fade.mul(0.94), dot);
      this.material.alphaTest = 0.5;
    }
    // Signs: a panel shows its cell of the sign sheet instead of its own colour.
    hk = map.layout === 'kowloon';
    const signs = makeSigns(hk);
    const tint = attribute('color', 'vec3');
    const sign = attribute('sign', 'float');
    const painted = (plain: THREE.Node<'vec3'>): THREE.Node<'vec3'> =>
      signs ? mix(plain, texture(signs, uv()).xyz.mul(tint), sign) : plain;
    if (look.rich) {
      // Each wall and roof in its own material; glass stays clean enough to show the sky.
      // `?city=plain` is the way out if a graphics card dislikes the material layers: every
      // wall goes back to the one plaster texture.
      const plain =
        typeof location !== 'undefined' &&
        new URLSearchParams(location.search).get('city') === 'plain';
      const wall = plain ? masonry(look, 7) : cityFace(look, attribute('surf', 'float'));
      const gloss = attribute('gloss', 'float');
      this.material.colorNode = weathered(painted(tint.mul(mix(wall.tone, float(1), gloss)))).mul(
        fog.shade(),
      );
      this.material.roughnessNode = mix(wall.roughness, float(0.3), gloss);
      this.material.normalNode = wall.normal;
      if (look.night) {
        // Lamplight behind the lit windows, each a little different, dimmed by the fog
        // of war like the wall it is in.
        const lit = step(LIT_GLOSS - 0.05, gloss).mul(step(gloss, LIT_GLOSS + 0.05));
        const warm = mix(
          vec3(1.0, 0.66, 0.32),
          vec3(0.95, 0.86, 0.66),
          hash(positionWorld.xz.floor().dot(vec2(7, 13))),
        );
        this.material.emissiveNode = warm.mul(lit).mul(1.5).mul(fog.shade());
      }
    } else this.material.colorNode = weathered(painted(tint)).mul(fog.shade());
    const ui = new THREE.MeshBasicNodeMaterial();
    ui.colorNode = attribute('aTint', 'vec4').xyz;
    this.pips = new Batch(new THREE.BoxGeometry(0.62, 0.14, 0.62), ui, MAX_STRUCTS * 10 + 64);
    const flag = new THREE.BoxGeometry(2.6, 1.5, 0.08).translate(1.3, 0, 0);
    this.flags = new Batch(flag, ui, 16);
    this.group.add(this.pips.mesh, this.flags.mesh);

    // Flagpoles at the heart of each town.
    const poles: Part[] = [];
    for (let t = 0; t < map.townCount; t++) {
      const { x, z } = this.townPos(t);
      poles.push({
        size: [0.14, 9, 0.14],
        at: [x, terrain.heightAt(x, z) + 4.5, z],
        color: 0x9a9a96,
      });
      poles.push({
        size: [0.9, 0.3, 0.9],
        at: [x, terrain.heightAt(x, z) + 0.15, z],
        color: 0x55524c,
      });
    }
    if (poles.length > 0) this.group.add(this.mesh(build(poles)));
    for (let s = 0; s < map.structCount; s++) this.show(s, 0);
    this.flush(CHUNKS * CHUNKS);
    this.ready = true;
    for (let k = 0; k < map.siteCount; k++) {
      const x = fromFx(map.siteX[k]);
      const z = fromFx(map.siteY[k]);
      const mesh = this.mesh(build(siteParts(k, map.siteKind[k], x, terrain.heightAt(x, z), z)));
      this.siteMeshes.push(mesh);
      this.group.add(mesh);
    }
  }

  /** The resource site at a ground point (within a few units of it), or -1. */
  siteAt(x: number, z: number): number {
    const m = this.map;
    let best = -1;
    let bestD = 5.5 * 5.5;
    for (let k = 0; k < m.siteCount; k++) {
      if (m.siteKind[k] === SITE_SUPPLIES && this.siteStock[k] <= 0) continue;
      const dx = fromFx(m.siteX[k]) - x;
      const dz = fromFx(m.siteY[k]) - z;
      if (dx * dx + dz * dz < bestD) {
        best = k;
        bestD = dx * dx + dz * dz;
      }
    }
    return best;
  }

  townPos(t: number): { x: number; z: number } {
    return { x: fromFx(this.map.townX[t]), z: fromFx(this.map.townY[t]) };
  }

  /** Height of the roof (or deck) of a structure, for effects and picking. */
  topOf(s: number): number {
    const m = this.map;
    if (m.sKind[s] === S_BRIDGE) return Math.max(fromFx(m.sBase[s]), fromFx(m.sEast[s]));
    if (this.hp[s] === 0) return fromFx(m.sBase[s]) + 0.8;
    const b = this.broken[s];
    const lost = b > 0 && b < 250 ? lostFloors(b, m.sFloors[s]) : 0;
    return fromFx(m.sBase[s]) + (m.sFloors[s] - lost) * FLOOR + this.crest[s];
  }

  /**
   * Where a man stands on the roof of building `s` at (x, z) (I6): on a flat roof just behind
   * the parapet; on a pitched one on the slope, low at the eaves and high at the ridge.
   */
  roofAt(s: number, x: number, z: number): number {
    const m = this.map;
    const c = this.crest[s];
    const eaves = this.topOf(s) - c;
    if (c <= 1) return eaves + 0.05;
    const x0 = m.sX[s] * CELL;
    const z0 = m.sY[s] * CELL;
    const x1 = x0 + m.sW[s] * CELL;
    const z1 = z0 + m.sH[s] * CELL;
    const edge = Math.max(0, Math.min(x - x0, x1 - x, z - z0, z1 - z));
    const half = (Math.min(m.sW[s], m.sH[s]) * CELL) / 2;
    return eaves + c * Math.min(1, edge / half);
  }

  /** Keeps a point on the roof of building `s`, half a metre in from its edges. */
  onRoof(s: number, x: number, z: number): [number, number] {
    const m = this.map;
    const x0 = m.sX[s] * CELL + 0.5;
    const z0 = m.sY[s] * CELL + 0.5;
    const x1 = (m.sX[s] + m.sW[s]) * CELL - 0.5;
    const z1 = (m.sY[s] + m.sH[s]) * CELL - 0.5;
    return [Math.min(x1, Math.max(x0, x)), Math.min(z1, Math.max(z0, z))];
  }

  centreOf(s: number): { x: number; z: number } {
    const m = this.map;
    return { x: (m.sX[s] + m.sW[s] / 2) * CELL, z: (m.sY[s] + m.sH[s] / 2) * CELL };
  }

  private mesh(geometry: THREE.BufferGeometry): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = this.shadows;
    mesh.receiveShadow = this.shadows;
    return mesh;
  }

  private show(s: number, state: number): void {
    const holes = state === 2 || state === 3 ? 0 : this.breached[s];
    const fort = state === 2 || state === 3 ? 0 : this.fort[s];
    // How far it has burnt down from the top (I1): only a shot-up building shows it.
    const level = state === 1 ? Math.min(63, this.broken[s]) : 0;
    // A scorched ground floor on a standing building; the stacked floors of a pancake.
    const low =
      state === 2
        ? this.pancaked[s]
        : state === 0 || state === 1 || state === 4
          ? this.scorched[s]
          : 0;
    const key = state + 8 * holes + 128 * fort + 256 * level + 16384 * low;
    if (this.shown[s] === key && !this.pending.has(s)) return;
    if (this.pending.get(s) === key) return;
    if (this.map.sKind[s] === S_BUILDING && this.ready) {
      // Building one costs a few milliseconds: they are built in `update`, a few a frame,
      // so a bombardment that changes ten houses at once does not stall a frame.
      if (!this.pending.has(s)) this.pendingIn[this.chunkAt(s)]++;
      this.pending.set(s, key);
      this.mark(s, state);
      return;
    }
    this.draw(s, key);
    this.mark(s, state);
  }

  /** The square of ground a map building is merged into. */
  private chunkAt(s: number): number {
    const m = this.map;
    const cx = (m.sX[s] * CELL + (m.sW[s] * CELL) / 2) / CHUNK;
    const cz = (m.sY[s] * CELL + (m.sH[s] * CELL) / 2) / CHUNK;
    return Math.min(CHUNKS - 1, Math.floor(cz)) * CHUNKS + Math.min(CHUNKS - 1, Math.floor(cx));
  }

  /** What a change of state means beyond the look: sight lines, decks, the version. */
  private mark(s: number, state: number): void {
    const m = this.map;
    // Units drive on a standing deck; a standing house blocks the view.
    if (m.sKind[s] === S_BRIDGE) this.terrain.bridgeUp[s] = state === 2 ? 0 : 1;
    else {
      for (let j = m.sY[s]; j < m.sY[s] + m.sH[s]; j++) {
        for (let i = m.sX[s]; i < m.sX[s] + m.sW[s]; i++) {
          this.fog.setWall(j * MAP_CELLS + i, state !== 2);
        }
      }
    }
    this.version++;
  }

  /**
   * Build the look of structure `s` for `shown` key `key` (state, breached faces, fort,
   * broken level, scorched ground floor or pancake).
   */
  private draw(s: number, key: number): void {
    const state = key & 7;
    const holes = (key >> 3) & 15;
    const fort = (key >> 7) & 1;
    const level = (key >> 8) & 63;
    const low = ((key >> 14) & 1) === 1;
    const sm = this.map;
    if (sm.sKind[s] === S_BASE) {
      // A base building takes the place of whatever hedge or fence stood there.
      this.clutter?.clear(
        sm.sX[s] * CELL - 1,
        sm.sY[s] * CELL - 1,
        (sm.sX[s] + sm.sW[s]) * CELL + 1,
        (sm.sY[s] + sm.sH[s]) * CELL + 1,
      );
    }
    const m = this.map;
    const old = this.meshes[s];
    if (old) {
      this.group.remove(old);
      old.geometry.dispose();
    }
    const x0 = m.sX[s] * CELL;
    const z0 = m.sY[s] * CELL;
    const w = m.sW[s] * CELL;
    const d = m.sH[s] * CELL;
    const base = fromFx(m.sBase[s]);
    const bridge = m.sKind[s] === S_BRIDGE;
    const parts = bridge
      ? w === d
        ? squareBridgeParts(x0, z0, w, base, state === 2)
        : bridgeParts(x0, z0, w, d, base, fromFx(m.sEast[s]), state === 2)
      : m.sKind[s] === S_BASE && state !== 2
        ? baseParts(s, this.baseType[s], this.baseTeam[s], x0, z0, w, d, base, state)
        : state === 2
          ? rubbleParts(s, x0 + 0.5, z0 + 0.5, w - 1, d - 1, base, m.sFloors[s], low)
          : buildingParts(
              s,
              x0 + 0.5,
              z0 + 0.5,
              w - 1,
              d - 1,
              base,
              m.sFloors[s],
              state === 4 ? STAGE_GUTTED : state === 1 ? STAGE_DAMAGED : 0,
              holes,
              m.sClass[s],
              fort === 1,
              level,
              low,
            );
    if (m.sKind[s] === S_BUILDING) {
      this.crest[s] = level > 0 ? 0.6 : state === 0 || state === 1 ? Math.max(0.9, crest) : 0.9;
      const k = this.chunkAt(s);
      const old = this.fresh.get(s);
      if (old) {
        old.near.dispose();
        old.far?.dispose();
      } else if (this.near[4 * s + 1] === 0) this.chunkOf[k].push(s);
      const far = farParts(parts);
      this.fresh.set(s, { near: build(parts), far: far.length > 0 ? build(far) : null });
      this.dirty.add(k);
    } else {
      const mesh = this.mesh(build(parts));
      this.meshes[s] = mesh;
      this.group.add(mesh);
    }
    this.shown[s] = key;
  }

  /**
   * Build the looks still pending, for about `ms` milliseconds (at least one), oldest
   * change first.
   */
  private drawPending(ms: number): void {
    const t0 = performance.now();
    for (const [s, key] of this.pending) {
      this.pending.delete(s);
      this.pendingIn[this.chunkAt(s)]--;
      this.draw(s, key);
      if (performance.now() - t0 > ms) break;
    }
  }

  /**
   * Merge anew the squares of ground in which a building changed, `limit` at most. A
   * square with a building whose new look is not built yet waits for it.
   */
  private flush(limit: number): void {
    let done = 0;
    for (const k of this.dirty) {
      if (done >= limit) break;
      if (this.pendingIn[k] > 0) continue;
      done++;
      this.dirty.delete(k);
      const list = this.chunkOf[k];
      const near = this.chunks[k];
      const far = this.farChunks[k];
      const nearGeo = remerge(list, this.near, near?.geometry ?? null, this.fresh, false);
      const farGeo = remerge(list, this.far, far?.geometry ?? null, this.fresh, true);
      for (const s of list) {
        const f = this.fresh.get(s);
        if (!f) continue;
        f.near.dispose();
        f.far?.dispose();
        this.fresh.delete(s);
      }
      if (near) {
        this.group.remove(near);
        near.geometry.dispose();
        this.chunks[k] = null;
      }
      if (far) {
        this.group.remove(far);
        far.geometry.dispose();
        this.farChunks[k] = null;
      }
      if (nearGeo) {
        const mesh = this.mesh(nearGeo);
        this.chunks[k] = mesh;
        this.group.add(mesh);
      }
      if (farGeo) {
        const mesh = this.mesh(farGeo);
        this.farChunks[k] = mesh;
        this.group.add(mesh);
      }
      if (this.chunks[k]) this.chunks[k]!.visible = this.isFar[k] === 0 || !this.farChunks[k];
      if (this.farChunks[k]) this.farChunks[k]!.visible = this.isFar[k] === 1;
    }
  }

  applySnapshot(s: Snapshot, seconds: number): void {
    // Base buildings appear during the game: add each to this copy of the map, in the
    // order the sim did, so structure ids agree.
    const map = this.map;
    this.bases = s.bases;
    for (let o = 0; o < s.bases.length; o += BASE_STRIDE) {
      const id = s.bases[o];
      const type = s.bases[o + 1];
      if (id === map.structCount) {
        const b = BUILDINGS[type];
        addStructure(map, S_BASE, s.bases[o + 3], s.bases[o + 4], b.w, b.h, -1, b.floors);
        this.hp[id] = 255;
      }
      this.baseTeam[id] = s.bases[o + 2];
      this.baseType[id] = type;
      this.basePct[id] = s.bases[o + 5];
    }
    // Your standing base buildings keep watch over the ground around them.
    const posts: number[] = [];
    for (let o = 0; o < s.bases.length; o += BASE_STRIDE) {
      const id = s.bases[o];
      if (s.bases[o + 2] !== ME || s.structHp[id] === 0) continue;
      posts.push(map.sX[id] + (map.sW[id] >> 1), map.sY[id] + (map.sH[id] >> 1), BASE_SIGHT);
    }
    this.fog.posts = posts;
    const n = Math.min(s.structHp.length, map.structCount);
    for (let k = 0; k < n; k++) {
      const hp = s.structHp[k];
      if (hp === 0 && this.hp[k] !== 0) this.fellAt[k] = seconds;
      this.hp[k] = hp;
      const bits = s.structStage[k] ?? 0;
      this.stage[k] = bits & 3;
      this.breached[k] = (bits >> 2) & 15;
      this.fort[k] = bits & STRUCT_FORTIFIED ? 1 : 0;
      const fire = s.structFire?.[k] ?? 0;
      this.alight[k] = fire & STRUCT_ALIGHT;
      this.scorched[k] = fire & (STRUCT_ALIGHT | STRUCT_BURNT) ? 1 : 0;
      this.pancaked[k] = fire & STRUCT_PANCAKE ? 1 : 0;
      let look: number = this.stage[k];
      if (map.sKind[k] === S_BUILDING) {
        // What went in at the ground floor (I5) has not come off the top: such a building
        // keeps its storeys and burns from below.
        const low = Math.round(((255 - (s.structGround?.[k] ?? 255)) * GROUND_PCT) / 100);
        const top = Math.min(255, hp + low);
        // Gutted by what went in below, its walls and roof still stand: it is drawn shot
        // up and burning, not as an open shell, until it pancakes.
        if (look === STAGE_GUTTED && low > 0 && top * 100 >= 255 * GUTTED_PCT) look = STAGE_DAMAGED;
        const level = hp > 0 && look === STAGE_DAMAGED ? brokenLevel(top, map.sFloors[k]) : 0;
        if (level > this.broken[k] || (look === STAGE_GUTTED && this.broken[k] < 250))
          this.burnAt[k] = seconds;
        // Gutted keeps a mark, so its fire is lit once and then burns down.
        this.broken[k] = look === STAGE_GUTTED && hp > 0 ? 250 : level;
      }
      if (this.hidden(k) && !this.spot(k)) continue;
      const rising = this.baseTeam[k] >= 0 && this.basePct[k] < 100;
      this.show(
        k,
        hp === 0
          ? 2
          : rising
            ? 3
            : map.sKind[k] === S_BUILDING
              ? look === STAGE_GUTTED
                ? 4
                : look === STAGE_DAMAGED
                  ? 1
                  : 0
              : hp < DAMAGED_BELOW && this.baseTeam[k] < 0
                ? 1
                : hp < 110
                  ? 1
                  : 0,
      );
    }
    for (let k = 0; k < s.siteStock.length; k++) {
      this.siteStock[k] = s.siteStock[k];
      const gone = map.siteKind[k] === SITE_SUPPLIES && s.siteStock[k] <= 0;
      if (this.siteMeshes[k]) this.siteMeshes[k].visible = !gone;
    }
    this.townOwner = s.townOwner;
    this.townCapturer = s.townCapturer;
    this.townProgress = s.townProgress;
    this.credits = s.credits;
  }

  /** An enemy base building the player has not seen yet: not drawn, not on the minimap. */
  hidden(s: number): boolean {
    const team = this.baseTeam[s];
    return team >= 0 && team !== ME && this.found[s] === 0 && !this.revealAll;
  }

  /** Has the player a unit looking at any part of this building right now? */
  private spot(s: number): boolean {
    const m = this.map;
    for (let j = m.sY[s]; j < m.sY[s] + m.sH[s]; j++) {
      for (let i = m.sX[s]; i < m.sX[s] + m.sW[s]; i++) {
        if (this.fog.sees(i * CELL + CELL / 2, j * CELL + CELL / 2)) {
          this.found[s] = 1;
          return true;
        }
      }
    }
    return false;
  }

  /** A shell hitting a wall, and a structure coming down. */
  hit(s: number): { x: number; y: number; z: number } {
    const m = this.map;
    const k = Math.random();
    const x = (m.sX[s] + k * m.sW[s]) * CELL;
    const z = (m.sY[s] + Math.random() * m.sH[s]) * CELL;
    const y =
      m.sKind[s] === S_BRIDGE
        ? this.terrain.heightAt(x, z)
        : this.topOf(s) * 0.5 + fromFx(m.sBase[s]) * 0.5;
    return { x, y, z };
  }

  /** The roof and floors of a building come down inside its walls. */
  gut(s: number): void {
    const { x, z } = this.centreOf(s);
    const y = this.topOf(s);
    for (let i = 0; i < 5; i++) {
      const p = this.hit(s);
      this.effects.squadHit(p.x, y * 0.6 + fromFx(this.map.sBase[s]) * 0.4, p.z);
      this.effects.wreckSmoke(p.x, y, p.z, 0.5);
    }
    this.effects.explosion(x, y * 0.5 + fromFx(this.map.sBase[s]) * 0.5, z);
  }

  /** A wall is breached: dust and masonry out of face `f`. */
  breach(s: number, f: number): { x: number; z: number } {
    const m = this.map;
    const alongX = f === FACE_NORTH || f === FACE_SOUTH;
    const side = f === FACE_SOUTH || f === FACE_EAST ? 1 : -1;
    const c = this.centreOf(s);
    const x = c.x + (alongX ? 0 : (side * m.sW[s] * CELL) / 2);
    const z = c.z + (alongX ? (side * m.sH[s] * CELL) / 2 : 0);
    const y = fromFx(m.sBase[s]) + 0.6;
    for (let i = 0; i < 4; i++) {
      this.effects.squadHit(
        x + (Math.random() - 0.5) * 2,
        y + Math.random(),
        z + (Math.random() - 0.5) * 2,
      );
    }
    return { x, z };
  }

  collapse(s: number, pancake = false): void {
    const { x, z } = this.centreOf(s);
    const y = this.terrain.heightAt(x, z);
    if (pancake) {
      // Straight down: no blast, a wall of dust driven out along the street on every side.
      const m = this.map;
      const hw = (m.sW[s] * CELL) / 2;
      const hd = (m.sH[s] * CELL) / 2;
      const n = 14 + 2 * (m.sW[s] + m.sH[s]);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const ex = Math.max(-1, Math.min(1, Math.cos(a) * 1.5));
        const ez = Math.max(-1, Math.min(1, Math.sin(a) * 1.5));
        for (const out of [0.4, 1.6, 3]) {
          this.effects.dust(
            x + ex * (hw + out),
            y + 0.2,
            z + ez * (hd + out),
            false,
            2.2 - out * 0.3,
          );
        }
        if (i % 3 === 0) this.effects.squadHit(x + ex * hw, y + 0.4, z + ez * hd);
      }
      for (let i = 0; i < 5; i++) {
        const p = this.hit(s);
        this.effects.wreckSmoke(p.x, y + 0.5, p.z, 0.1);
      }
      return;
    }
    this.effects.explosion(x, y + 0.5, z);
    for (let i = 0; i < 6; i++) {
      const p = this.hit(s);
      this.effects.squadHit(p.x, y + 0.3, p.z);
    }
  }

  /**
   * The fire in the ground floor climbing (I5): flames out of the windows of every floor
   * it has, most out of the highest, and smoke off the top of the house.
   */
  private blaze(s: number, dt: number): void {
    const m = this.map;
    const lit = this.alight[s];
    const { x: cx, z: cz } = this.centreOf(s);
    const dx = cx - this.eye.x;
    const dz = cz - this.eye.z;
    if (dx * dx + dz * dz + this.eye.y * this.eye.y > 700 * 700) return;
    if (Math.random() > dt * (3 + lit * 2.5)) return;
    const b = this.broken[s];
    const stands = b === 250 ? 1 : m.sFloors[s] - (b > 0 ? lostFloors(b, m.sFloors[s]) : 0);
    const top = Math.max(1, Math.min(lit, stands));
    const w = m.sW[s] * CELL - 1;
    const d = m.sH[s] * CELL - 1;
    const base = fromFx(m.sBase[s]);
    // Half of the flames from the floor the fire has just reached, the rest from below.
    const floor = Math.random() < 0.5 ? top - 1 : Math.floor(Math.random() * top);
    const f = Math.floor(Math.random() * 4);
    const alongX = f === FACE_NORTH || f === FACE_SOUTH;
    const side = f === FACE_SOUTH || f === FACE_EAST ? 1 : -1;
    const t = (Math.random() - 0.5) * ((alongX ? w : d) - 1.2);
    const x = alongX ? cx + t : cx + side * (w / 2 + 0.15);
    const z = alongX ? cz + side * (d / 2 + 0.15) : cz + t;
    if (!this.fog.sees(x, z)) return;
    this.effects.thin = 0;
    this.effects.windowFire(
      x,
      base + floor * FLOOR + FLOOR * 0.56,
      z,
      alongX ? 0 : side,
      alongX ? side : 0,
      floor === top - 1 ? 1 : 0.6,
    );
    if (Math.random() < 0.35) this.effects.wreckSmoke(x, this.topOf(s) - 0.6, z, 0.4);
  }

  /**
   * A building burning down from the top (I1): flames out of the windows of the highest
   * storey that stands and along the broken top, hot for the first minute or two after each
   * storey goes, then smouldering. A gutted shell burns out over two minutes.
   */
  private burn(s: number, seconds: number, dt: number): void {
    const m = this.map;
    const gutted = this.broken[s] === 250;
    const age = seconds - this.burnAt[s];
    const heat = gutted ? Math.max(0, 1 - age / 120) : Math.max(0.22, 1 - age / 100);
    if (heat <= 0) return;
    const { x: cx, z: cz } = this.centreOf(s);
    const dx = cx - this.eye.x;
    const dz = cz - this.eye.z;
    if (dx * dx + dz * dz + this.eye.y * this.eye.y > 700 * 700) return;
    const level = gutted ? 1 : this.broken[s];
    if (Math.random() > dt * (0.8 + level * 0.6) * heat * 3) return;
    const w = m.sW[s] * CELL - 1;
    const d = m.sH[s] * CELL - 1;
    const base = fromFx(m.sBase[s]);
    const floors = gutted ? 1 : m.sFloors[s] - lostFloors(level, m.sFloors[s]);
    const top = base + floors * FLOOR;
    let x: number;
    let y: number;
    let z: number;
    let nx = 0;
    let nz = 0;
    if (!gutted && Math.random() < 0.6) {
      // Out of a window of the top storey left standing.
      const f = Math.floor(Math.random() * 4);
      const alongX = f === FACE_NORTH || f === FACE_SOUTH;
      const side = f === FACE_SOUTH || f === FACE_EAST ? 1 : -1;
      const t = (Math.random() - 0.5) * ((alongX ? w : d) - 1.2);
      x = alongX ? cx + t : cx + side * (w / 2 + 0.15);
      z = alongX ? cz + side * (d / 2 + 0.15) : cz + t;
      y = top - FLOOR * 0.44;
      nx = alongX ? 0 : side;
      nz = alongX ? side : 0;
    } else {
      // Off the broken top (or up out of a gutted shell).
      x = cx + (Math.random() - 0.5) * (w - 1.5);
      z = cz + (Math.random() - 0.5) * (d - 1.5);
      y = gutted ? base + 0.6 : top + 0.2;
    }
    if (!this.fog.sees(x, z)) return;
    this.effects.thin = 0;
    this.effects.windowFire(x, y, z, nx, nz, heat);
  }

  /** First standing structure a ray passes through before `maxT`, or -1. */
  pick(origin: THREE.Vector3, dir: THREE.Vector3, maxT: number): number {
    const m = this.map;
    for (let t = 0; t <= maxT; t += 0.5) {
      const x = origin.x + dir.x * t;
      const z = origin.z + dir.z * t;
      const i = Math.floor(x / CELL);
      const j = Math.floor(z / CELL);
      if (i < 0 || j < 0 || i >= MAP_CELLS || j >= MAP_CELLS) continue;
      const s = m.structAt[j * MAP_CELLS + i];
      if (s < 0 || this.hp[s] === 0 || this.hidden(s)) continue;
      if (origin.y + dir.y * t <= this.topOf(s) + 0.2) return s;
    }
    return -1;
  }

  /** Draw the readability layer. Call after the unit view has counted the occupants. */
  /** Which squares of the city are far enough from the camera to be drawn simplified. */
  view(camera: THREE.Camera, focus?: THREE.Vector3, distance = 1000): void {
    const p = camera.position;
    this.eye.copy(p);
    if (focus) {
      this.cutFocus.value.copy(focus);
      const dx = p.x - focus.x;
      const dz = p.z - focus.z;
      const len = Math.hypot(dx, dz) || 1;
      this.cutDir.value.set(dx / len, dz / len);
      // Only from close up: further out a block hides little, and the icons carry the units.
      const near = Math.min(1, Math.max(0, (175 - distance) / 45));
      this.cutStrength.value = this.seeThrough ? near : 0;
    }
    for (let k = 0; k < CHUNKS * CHUNKS; k++) {
      const near = this.chunks[k];
      const far = this.farChunks[k];
      if (!near || !far) continue;
      const dx = ((k % CHUNKS) + 0.5) * CHUNK - p.x;
      const dz = (Math.floor(k / CHUNKS) + 0.5) * CHUNK - p.z;
      const d2 = dx * dx + p.y * p.y + dz * dz;
      // A little slack either way, so a square on the line does not flicker.
      const edge = FAR_AT + (this.isFar[k] === 1 ? -25 : 25);
      const want = this.farDetail && d2 > edge * edge ? 1 : 0;
      if (want === this.isFar[k]) continue;
      this.isFar[k] = want;
      near.visible = want === 0;
      far.visible = want === 1;
    }
  }

  update(seconds: number, dt: number): void {
    const m = this.map;
    // About 2 ms a frame for changed buildings: a wall that turns to rubble a frame or two
    // late is not seen; a dropped frame is.
    if (this.pending.size > 0) this.drawPending(2);
    if (this.dirty.size > 0) this.flush(this.pending.size > 0 ? 1 : 2);
    const pips = this.pips;
    pips.n = 0;
    for (let s = 0; s < m.structCount; s++) {
      if (this.hidden(s)) continue;
      if (this.hp[s] === 0) {
        // Ruins smoulder for a while.
        const age = seconds - this.fellAt[s];
        if (age < SMOKE_SECONDS && Math.random() < dt * 2.5) {
          const p = this.hit(s);
          if (this.fog.sees(p.x, p.z)) {
            this.effects.wreckSmoke(p.x, fromFx(m.sBase[s]) + 0.4, p.z, Math.max(0, 1 - age / 25));
          }
        }
        continue;
      }
      if ((this.shown[s] & 7) === 1 && this.broken[s] === 0 && Math.random() < dt * 0.5) {
        const p = this.hit(s);
        if (this.fog.sees(p.x, p.z)) this.effects.wreckSmoke(p.x, this.topOf(s), p.z, 0.15);
      }
      if (this.broken[s] > 0) this.burn(s, seconds, dt);
      if (this.alight[s] > 0) this.blaze(s, dt);
      if (this.baseTeam[s] >= 0 && this.basePct[s] < 100) {
        // Going up: ten pips over the plot, filled as the work gets done.
        const { x, z } = this.centreOf(s);
        const c = TEAM_UI[this.baseTeam[s]] ?? NEUTRAL_UI;
        const done = Math.floor(this.basePct[s] / 10);
        for (let k = 0; k < 10; k++) {
          const lit = k < done ? 1 : 0.25;
          pips.put(
            x + (k - 4.5) * 0.82,
            fromFx(m.sBase[s]) + 3,
            z,
            0,
            1,
            1,
            c[0] * lit,
            c[1] * lit,
            c[2] * lit,
            1,
          );
        }
        continue;
      }
      const n = Math.min(this.occ[s], GARRISON_MAX);
      if (n === 0) continue;
      // One pip per squad inside, in a row above the roof.
      const { x, z } = this.centreOf(s);
      const y = this.topOf(s) + 1.1;
      const c = this.occSelected[s] ? [1, 1, 1] : (TEAM_UI[this.occTeam[s]] ?? NEUTRAL_UI);
      for (let k = 0; k < n; k++) {
        pips.put(x + (k - (n - 1) / 2) * 0.82, y, z, 0, 1, 1, c[0], c[1], c[2], 1);
      }
    }
    // A marker over every site still worth a trip, once you have seen the place.
    for (let k = 0; k < m.siteCount; k++) {
      if (m.siteKind[k] === SITE_SUPPLIES && this.siteStock[k] <= 0) continue;
      const x = fromFx(m.siteX[k]);
      const z = fromFx(m.siteY[k]);
      if (!this.fog.hasExplored(x, z)) continue;
      const c = SITE_UI[m.siteKind[k]] ?? NEUTRAL_UI;
      const y = this.terrain.heightAt(x, z) + 3.4 + Math.sin(seconds * 2 + k) * 0.12;
      pips.put(x, y, z, 0.9, 0.9, 1.3, c[0], c[1], c[2], 1);
    }
    const flags = this.flags;
    flags.n = 0;
    for (let t = 0; t < m.townCount; t++) {
      const { x, z } = this.townPos(t);
      if (!this.fog.hasExplored(x, z)) continue;
      const y = this.terrain.heightAt(x, z);
      const c = TEAM_UI[this.townOwner[t]] ?? NEUTRAL_UI;
      const wave = Math.sin(seconds * 1.7 + t) * 0.12;
      flags.put(x, y + 8.1, z, wave, 1, 1, c[0], c[1], c[2], 1);
      // Capture progress climbs the pole in the colour of the army taking the town.
      const taking = TEAM_UI[this.townCapturer[t]];
      const steps = taking ? Math.ceil((this.townProgress[t] ?? 0) / 10) : 0;
      for (let k = 0; k < steps; k++) {
        pips.put(x, y + 1 + k * 0.6, z + 0.5, 0, 1, 1.6, taking[0], taking[1], taking[2], 1);
      }
    }
    pips.flush();
    flags.flush();
    this.occ.fill(0);
    this.occSelected.fill(0);
  }
}
