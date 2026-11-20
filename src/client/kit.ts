// The modeller's kit: the shapes every unit model is put together from, and the bench they
// are put together on (`Parts`).
//
// Models are written in metres at their true size and scaled to the map when they are
// finished (`M` map units a metre), so a hull is as long as the real thing's and a man
// standing beside it is the right height. Forward is +Z, up is +Y, the model sits on y = 0.
//
// Every model is written once and built three times, at three levels of detail: each part
// says how far out it is still worth drawing (`keep`), and round things lose sides with
// distance. So the silhouette of the far model is the near model's own, not a guess at it.
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { creases, dress, loft, setWear, type Ring } from './shape';

/** Map units per metre for vehicles and aircraft (a man is 0.344: a touch over scale). */
export const M = 0.36;
/** A wear width on a vehicle, in metres: how wide the chipped band along an edge is. */
const VEHICLE_WEAR = 0.07;

export const PAINT = 0x565c45;
export const PAINT_DARK = 0x3f4434;
export const RUBBER = 0x17181a;
export const STEEL = 0x2b2e2c;
export const TRACK = 0x1f201f;
export const GLASS = 0x1c2428;
export const LAMP = 0xd8d2b0;
export const CANVAS = 0x6b6a4c;
/**
 * Art direction is grounded realism (docs/DECISIONS.md 011): hulls keep muted service paint
 * and carry the team colour only on small markings. The barely visible tint below just
 * separates two paint batches. Readability at long range is the job of the far LOD and UI.
 */
export const TINT = 0.05;

/**
 * The base coat of each faction's vehicles and uniforms, as a multiple of the model's own
 * olive: none, the alliance's olive drab, Russia's darker green, China's sand khaki. The
 * unit material multiplies every vertex colour by it.
 */
export const COATS: readonly (readonly [number, number, number])[] = [
  [1, 1, 1],
  [1, 1, 1],
  [0.66, 0.9, 0.62],
  [1.55, 1.38, 1.02],
];

/**
 * The vertex colour that comes out as `hex` on a unit of `faction` once its coat has been
 * laid over it: for things that are not painted in the army's coat (airframe grey, glass,
 * canvas, a rifle).
 */
export function under(hex: number, faction: number): number {
  const c = new THREE.Color(hex);
  const k = COATS[faction] ?? COATS[0];
  // Vertex colours are read as sRGB and the coat multiplies the linear value.
  c.setRGB(Math.min(1, c.r / k[0]), Math.min(1, c.g / k[1]), Math.min(1, c.b / k[2]));
  return c.getHex();
}

export type Vec3 = [number, number, number];

export interface Opts {
  at?: Vec3;
  rot?: Vec3;
  color?: number;
  team?: number;
  /** Scale the top face in x/z (boxes only): 1 = straight sides. */
  top?: [number, number];
  /** Slide the top face along z, for sloped fronts. */
  shear?: number;
  /** Slide the top face along x. */
  lean?: number;
  /** Fabric: its edges fray pale instead of chipping to bare metal. */
  cloth?: boolean;
}

/**
 * `half` is the part's half size before it is bent, turned or moved, and `local` where each
 * vertex is inside it: what the edge wear is measured from (see shape.ts).
 */
function finish(
  g: THREE.BufferGeometry,
  o: Opts,
  half: [number, number, number] | Float32Array,
  local?: Float32Array,
): THREE.BufferGeometry {
  const pos = g.getAttribute('position');
  const boxP = local ?? Float32Array.from(pos.array as Float32Array);
  if (o.top || o.shear || o.lean) {
    g.computeBoundingBox();
    const midY = (g.boundingBox!.max.y + g.boundingBox!.min.y) / 2;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) <= midY) continue;
      pos.setX(i, pos.getX(i) * (o.top?.[0] ?? 1) + (o.lean ?? 0));
      pos.setZ(i, pos.getZ(i) * (o.top?.[1] ?? 1) + (o.shear ?? 0));
    }
  }
  if (o.rot) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...o.rot)));
  if (o.at) g.translate(...o.at);
  g.computeVertexNormals();
  g.deleteAttribute('uv');
  return dress(g, { color: o.color ?? PAINT, team: o.team, cloth: o.cloth }, boxP, half);
}

export const box = (w: number, h: number, d: number, o: Opts = {}) =>
  finish(new THREE.BoxGeometry(w, h, d), o, [w / 2, h / 2, d / 2]);

/** Cylinder whose axis runs along `axis`; `r1` is the radius at its far (+axis) end. */
export function cyl(
  r: number,
  len: number,
  axis: 'x' | 'y' | 'z',
  o: Opts = {},
  seg = 10,
  r1 = r,
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r, len, seg);
  // A cylinder's only edges are its two rims: measured by distance from the axis and
  // along it, so the side wears at its ends and each end wears at its rim.
  const pos = g.getAttribute('position');
  const local = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    local[i * 3] = Math.hypot(pos.getX(i), pos.getZ(i));
    local[i * 3 + 1] = pos.getY(i);
  }
  if (axis === 'x') g.rotateZ(-Math.PI / 2);
  else if (axis === 'z') g.rotateX(Math.PI / 2);
  return finish(g, o, [Math.max(r, r1), len / 2, 1e9], local);
}

/**
 * A side view pushed across the width: `profile` is the outline seen from the side as
 * [z, y] points in order round it, `half` the half width (one for all, or one a point, so
 * a turret can narrow to its front and its roof). Flat faces, hard edges: armour plate.
 */
export function prism(
  profile: readonly (readonly [number, number])[],
  half: number | readonly number[],
  o: Opts = {},
): THREE.BufferGeometry {
  const n = profile.length;
  const w = (i: number) => (typeof half === 'number' ? half : half[i % n]);
  // Wind every face outward whichever way round the outline was given.
  let area = 0;
  for (let i = 0; i < n; i++) {
    const [z0, y0] = profile[i];
    const [z1, y1] = profile[(i + 1) % n];
    area += z0 * y1 - z1 * y0;
  }
  const order = area < 0 ? [...profile.keys()].reverse() : [...profile.keys()];
  const pts = order.map((i) => ({ z: profile[i][0], y: profile[i][1], w: w(i) }));
  const pos: number[] = [];
  const p: number[] = [];
  const h: number[] = [];
  const tri = (a: number[], b: number[], c: number[]) => pos.push(...a, ...b, ...c);
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const len = Math.hypot(b.z - a.z, b.y - a.y) / 2;
    const wide = (a.w + b.w) / 2;
    tri([-a.w, a.y, a.z], [a.w, a.y, a.z], [b.w, b.y, b.z]);
    tri([-a.w, a.y, a.z], [b.w, b.y, b.z], [-b.w, b.y, b.z]);
    // Where each corner is on its own plate: across it and along it.
    for (const [x, v] of [
      [-a.w, -len],
      [a.w, -len],
      [b.w, len],
      [-a.w, -len],
      [b.w, len],
      [-b.w, len],
    ]) {
      p.push(x, v, 0);
      h.push(wide, len, 0);
    }
  }
  // The two sides, cut into triangles.
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const q of pts) {
    minY = Math.min(minY, q.y);
    maxY = Math.max(maxY, q.y);
    minZ = Math.min(minZ, q.z);
    maxZ = Math.max(maxZ, q.z);
  }
  const faces = THREE.ShapeUtils.triangulateShape(
    pts.map((q) => new THREE.Vector2(q.z, q.y)),
    [],
  );
  for (const side of [-1, 1]) {
    for (const f of faces) {
      const [a, b, c] = side < 0 ? [f[0], f[1], f[2]] : [f[0], f[2], f[1]];
      for (const k of [a, b, c]) {
        const q = pts[k];
        pos.push(side * q.w, q.y, q.z);
        p.push(q.y - (minY + maxY) / 2, q.z - (minZ + maxZ) / 2, 0);
        h.push((maxY - minY) / 2, (maxZ - minZ) / 2, 0);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  // ShapeUtils may wind the side either way: check one triangle against the side it is on.
  fixWinding(g);
  return finish(g, o, new Float32Array(h), new Float32Array(p));
}

/** Turn every triangle of a closed, roughly convex shape to face away from its middle. */
function fixWinding(g: THREE.BufferGeometry): void {
  const pos = g.getAttribute('position');
  g.computeBoundingBox();
  const mid = g.boundingBox!.getCenter(new THREE.Vector3());
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    nrm.crossVectors(b.clone().sub(a), c.clone().sub(a));
    // Only the flat sides can be wrong, and they face straight along x.
    if (Math.abs(nrm.x) < Math.abs(nrm.y) + Math.abs(nrm.z)) continue;
    if (nrm.x * (a.x + b.x + c.x - 3 * mid.x) < 0) {
      pos.setXYZ(i + 1, c.x, c.y, c.z);
      pos.setXYZ(i + 2, b.x, b.y, b.z);
    }
  }
}

/** One station along a fuselage: where along z, its half width and half height, its centre. */
export interface Station {
  z: number;
  w: number;
  h: number;
  y?: number;
  x?: number;
  color?: number;
  team?: number;
}

/**
 * A smooth skin over stations along the length: fuselages, tail booms, engine pods, gun
 * barrels with a taper. `square` 2 is round, higher is slab-sided with rounded corners.
 */
export function fuselage(
  stations: readonly Station[],
  o: { seg?: number; square?: number; color?: number; team?: number; cap?: 'both' | 'none' } = {},
): THREE.BufferGeometry {
  // The loft runs up y; laid over on its back it runs along z, its front (rz) pointing up.
  const rings: Ring[] = stations.map((s) => ({
    y: s.z,
    rx: s.w,
    rz: s.h,
    x: s.x ?? 0,
    z: s.y ?? 0,
    color: s.color,
    team: s.team,
  }));
  const g = loft(rings, {
    seg: o.seg ?? 10,
    square: o.square,
    color: o.color,
    team: o.team,
    cap: o.cap,
  });
  // (x, y, z) -> (x, z, y): a mirror, so the triangles are turned back over.
  const pos = g.getAttribute('position');
  for (let i = 0; i < pos.count; i++) pos.setXYZ(i, pos.getX(i), pos.getZ(i), pos.getY(i));
  const idx = g.getIndex()!;
  for (let i = 0; i < idx.count; i += 3) {
    const b = idx.getX(i + 1);
    idx.setX(i + 1, idx.getX(i + 2));
    idx.setX(i + 2, b);
  }
  g.computeVertexNormals();
  return g;
}

/** Join the parts of a model into one mesh, marking the creases where parts meet. */
export const merge = (parts: THREE.BufferGeometry[]) => {
  creases(parts);
  // Plates (prism) have no index; if any part is one, none may have.
  const plain = parts.some((g) => !g.index);
  return mergeGeometries(plain ? parts.map((g) => (g.index ? g.toNonIndexed() : g)) : parts);
};

/**
 * The bench a model is assembled on at one level of detail (0 near, 1 middle, 2 far).
 * `keep` on each call is the furthest level the part is still drawn at: 0 for detail seen
 * only close to, 1 for what shapes the model from the middle distance, 2 (the default) for
 * the masses that make its silhouette.
 */
export class Parts {
  readonly list: THREE.BufferGeometry[] = [];
  constructor(readonly lod: number) {}

  add(g: THREE.BufferGeometry | THREE.BufferGeometry[], keep = 2): this {
    if (this.lod <= keep) this.list.push(...(Array.isArray(g) ? g : [g]));
    return this;
  }
  box(w: number, h: number, d: number, o: Opts = {}, keep = 2): this {
    if (this.lod <= keep) this.list.push(box(w, h, d, o));
    return this;
  }
  /** Round things lose sides with distance: `seg` is the count close to. */
  cyl(
    r: number,
    len: number,
    axis: 'x' | 'y' | 'z',
    o: Opts = {},
    seg = 10,
    keep = 2,
    r1 = r,
  ): this {
    if (this.lod <= keep) this.list.push(cyl(r, len, axis, o, this.sides(seg), r1));
    return this;
  }
  prism(
    profile: readonly (readonly [number, number])[],
    half: number | readonly number[],
    o: Opts = {},
    keep = 2,
  ): this {
    if (this.lod <= keep) this.list.push(prism(profile, half, o));
    return this;
  }
  fuselage(
    stations: readonly Station[],
    o: { seg?: number; square?: number; color?: number; team?: number; cap?: 'both' | 'none' } = {},
    keep = 2,
  ): this {
    if (this.lod > keep) return this;
    // Further out, every other station goes too (never the ends).
    const s =
      this.lod === 0 || stations.length <= 4
        ? stations
        : stations.filter((_, k) => k === 0 || k === stations.length - 1 || k % 2 === 0);
    this.list.push(fuselage(s, { ...o, seg: this.sides(o.seg ?? 10) }));
    return this;
  }
  /** A road wheel with its tyre: rounded shoulders and a hub close to, a plain drum beyond. */
  wheel(x: number, y: number, z: number, r: number, wide: number, hub = STEEL, keep = 2): this {
    if (this.lod > keep) return this;
    if (this.lod === 0) {
      const tyre = fuselage(
        [
          { z: -wide / 2, w: r * 0.84, h: r * 0.84 },
          { z: -wide * 0.32, w: r, h: r },
          { z: wide * 0.32, w: r, h: r },
          { z: wide / 2, w: r * 0.84, h: r * 0.84 },
        ],
        { seg: 12, color: RUBBER },
      );
      tyre.rotateY(Math.PI / 2).translate(x, y, z);
      this.list.push(tyre);
      this.list.push(cyl(r * 0.56, wide * 1.04, 'x', { at: [x, y, z], color: hub }, 8));
      this.list.push(cyl(r * 0.2, wide * 1.12, 'x', { at: [x, y, z], color: STEEL }, 6));
    } else {
      this.list.push(cyl(r, wide, 'x', { at: [x, y, z], color: RUBBER }, this.lod === 1 ? 7 : 5));
    }
    return this;
  }
  /** Do something on both sides of the model: `s` is -1 then 1. */
  both(f: (s: number) => void): this {
    f(-1);
    f(1);
    return this;
  }
  sides(seg: number): number {
    return this.lod === 0 ? seg : this.lod === 1 ? Math.max(5, Math.round(seg * 0.6)) : 4;
  }
  /** The finished mesh, in map units. `scale` is map units a metre. */
  done(scale = M): THREE.BufferGeometry {
    const g = merge(this.list);
    g.scale(scale, scale, scale);
    return g;
  }
}

/** Build one model at each of the three levels, with the vehicles' wear width. */
export function atLevels<T>(build: (lod: number) => T): [T, T, T] {
  setWear(VEHICLE_WEAR);
  const out: [T, T, T] = [build(0), build(1), build(2)];
  setWear(0.045);
  return out;
}
