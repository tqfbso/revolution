// What people did to the land before the war: fields, hedges, roads, yards. Drawn once at
// start-up, from the sim's map, into two textures the ground material lays over the grass,
// plus a list of small things (hedges, bales, fences, poles) for `Clutter` to stand on it.
// All of it is cosmetic (decision 071): nothing here blocks a unit, hides one or slows one.
import * as THREE from 'three/webgpu';
import {
  MAP_CELLS,
  MAP_SIZE,
  S_BUILDING,
  START_PLOT,
  T_CLIFF,
  T_FOREST,
  T_OPEN,
  type GameMap,
} from '../sim/map';

const CELL = MAP_SIZE / MAP_CELLS;
const VERTS = MAP_CELLS + 1;

export const P_BUSH = 0;
export const P_HEDGE = 1;
export const P_BALE = 2;
export const P_ROCK = 3;
export const P_FENCE = 4;
export const P_POLE = 5;
export const P_LAMP = 6;
export const P_TUFT = 7;
export const P_SHED = 8;
export const P_SHELTER = 9;
export const P_STACK = 10;
export const P_CAR = 11;
export const P_VAN = 12;
export const P_BIN = 13;
export const P_KINDS = 14;

/** One small thing standing on the land. */
export interface Prop {
  kind: number;
  x: number;
  z: number;
  rot: number;
  scale: number;
}

function hash(x: number, y: number, seed = 0): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi, seed);
  const b = hash(xi + 1, yi, seed);
  const c = hash(xi, yi + 1, seed);
  const d = hash(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

const rgba = (hex: number, a: number) =>
  `rgba(${(hex >> 16) & 255},${(hex >> 8) & 255},${hex & 255},${a})`;

interface FieldKind {
  base: number;
  stripe: number;
  /** Distance between rows in metres, and how wide the stripe is drawn. */
  period: number;
  width: number;
  cover: number;
}

/** Crops as they look from the air in late summer, kept dull: nothing here should shout. */
const FIELDS: readonly FieldKind[] = [
  // Stubble after the harvest.
  { base: 0x9c8f58, stripe: 0x857a49, period: 2.4, width: 0.9, cover: 0.86 },
  // A green crop in rows on bare soil.
  { base: 0x5c4c38, stripe: 0x4d6a34, period: 2.0, width: 1.1, cover: 0.88 },
  // Ploughed.
  { base: 0x574839, stripe: 0x43372c, period: 1.6, width: 0.6, cover: 0.92 },
  // A hay meadow, mown in wide swathes.
  { base: 0x6f8240, stripe: 0x5d7436, period: 7, width: 3.5, cover: 0.7 },
  // Standing grain.
  { base: 0xa39a4e, stripe: 0x978d44, period: 3.0, width: 1.2, cover: 0.84 },
  // Pasture, grazed short.
  { base: 0x587a3a, stripe: 0x587a3a, period: 0, width: 0, cover: 0.55 },
];
const F_STUBBLE = 0;
const F_PASTURE = 5;

export class Land {
  readonly fields: THREE.DataTexture;
  readonly marks: THREE.DataTexture;
  readonly props: Prop[] = [];
  private readonly fieldCanvas: HTMLCanvasElement;
  private readonly markCanvas: HTMLCanvasElement;
  private readonly fc: CanvasRenderingContext2D;
  private readonly mc: CanvasRenderingContext2D;
  private readonly heights: Float32Array;
  /** Cells something already stands on or runs through: no field, no clutter. */
  private readonly taken = new Uint8Array(MAP_CELLS * MAP_CELLS);

  constructor(
    private readonly map: GameMap,
    heights: Float32Array,
    markSize: number,
  ) {
    this.heights = heights;
    const canvas = (size: number) => {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.scale(size / MAP_SIZE, size / MAP_SIZE);
      return [c, ctx] as const;
    };
    [this.fieldCanvas, this.fc] = canvas(1024);
    [this.markCanvas, this.mc] = canvas(markSize);
    this.fields = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    this.marks = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    this.reserve();
    this.occlusion();
    if (map.streets.length > 0) this.city();
    else this.towns();
  }

  /** A cell is free for a field or a prop: open, level, and nothing planned on it. */
  private free(x: number, z: number): boolean {
    const i = Math.floor(x / CELL);
    const j = Math.floor(z / CELL);
    if (i < 2 || j < 2 || i >= MAP_CELLS - 2 || j >= MAP_CELLS - 2) return false;
    const c = j * MAP_CELLS + i;
    if (this.map.type[c] !== T_OPEN || this.taken[c] !== 0) return false;
    const h = this.heights;
    const k = j * VERTS + i;
    const lo = Math.min(h[k], h[k + 1], h[k + VERTS], h[k + VERTS + 1]);
    const hi = Math.max(h[k], h[k + 1], h[k + VERTS], h[k + VERTS + 1]);
    return hi - lo < 0.9;
  }

  private take(x: number, z: number, r: number): void {
    const i0 = Math.max(0, Math.floor((x - r) / CELL));
    const i1 = Math.min(MAP_CELLS - 1, Math.floor((x + r) / CELL));
    const j0 = Math.max(0, Math.floor((z - r) / CELL));
    const j1 = Math.min(MAP_CELLS - 1, Math.floor((z + r) / CELL));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.taken[j * MAP_CELLS + i] = 1;
  }

  /** Keep fields away from the towns, the two bases and the resource sites. */
  private reserve(): void {
    const map = this.map;
    for (let t = 0; t < map.townCount; t++) {
      this.take(map.townX[t] / 1024, map.townY[t] / 1024, map.townR[t] / 1024 + 14);
    }
    for (let side = 0; side < 2; side++) {
      if (map.startX[side] < 0) continue;
      const c = (START_PLOT * CELL) / 2;
      this.take(map.startX[side] * CELL + c, map.startY[side] * CELL + c, 56);
    }
    for (let k = 0; k < map.siteCount; k++) this.take(map.siteX[k] / 1024, map.siteY[k] / 1024, 14);
    for (let s = 0; s < map.structCount; s++) {
      this.take(
        (map.sX[s] + map.sW[s] / 2) * CELL,
        (map.sY[s] + map.sH[s] / 2) * CELL,
        (Math.max(map.sW[s], map.sH[s]) * CELL) / 2 + 3,
      );
    }
  }

  /** Soft darkness where the sky is shut out: at the foot of walls and under the trees. */
  private occlusion(): void {
    const map = this.map;
    const ctx = this.mc;
    const px = this.markCanvas.width / MAP_SIZE;
    ctx.fillStyle = 'rgba(0,0,0,0.045)';
    for (let j = 0; j < MAP_CELLS; j++) {
      for (let i = 0; i < MAP_CELLS; i++) {
        if (map.type[j * MAP_CELLS + i] !== T_FOREST) continue;
        ctx.beginPath();
        ctx.arc((i + 0.5) * CELL, (j + 0.5) * CELL, 3.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.75)';
    ctx.shadowBlur = 2.6 * px;
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    for (let s = 0; s < map.structCount; s++) {
      if (map.sKind[s] !== S_BUILDING) continue;
      ctx.fillRect(map.sX[s] * CELL, map.sY[s] * CELL, map.sW[s] * CELL, map.sH[s] * CELL);
    }
    ctx.restore();
  }

  /**
   * The city map: every street as pavements, kerbs and a carriageway, the squares and
   * forecourts paved, and the things that stand along a street.
   */
  private city(): void {
    const map = this.map;
    const ctx = this.mc;
    const px = this.markCanvas.width / MAP_SIZE;
    const st = map.streets;
    // Paved ground first: squares, forecourts, and the pavement under every street.
    for (let j = 0; j < MAP_CELLS; j++) {
      for (let i = 0; i < MAP_CELLS; i++) {
        const r = map.road[j * MAP_CELLS + i];
        if (r === 0) continue;
        this.taken[j * MAP_CELLS + i] = 1;
        const v = hash(i, j, 91);
        ctx.fillStyle = rgba(v < 0.33 ? 0x8b897f : v < 0.66 ? 0x85837a : 0x908e85, 0.96);
        ctx.fillRect(i * CELL - 0.05, j * CELL - 0.05, CELL + 0.1, CELL + 0.1);
      }
    }
    // Round each building: a pavement apron in town, a yard with its fence outside it.
    for (let s = 0; s < map.structCount; s++) {
      if (map.sKind[s] !== S_BUILDING) continue;
      const x0 = map.sX[s] * CELL;
      const z0 = map.sY[s] * CELL;
      const w = map.sW[s] * CELL;
      const d = map.sH[s] * CELL;
      if (map.sTown[s] >= 0) {
        ctx.fillStyle = rgba(hash(s, 9, 3) < 0.5 ? 0x7d7b73 : 0x86847b, 0.9);
        ctx.fillRect(x0 - 1.6, z0 - 1.6, w + 3.2, d + 3.2);
      } else {
        const m = 2.2 + 2.2 * hash(s, 7, 3);
        ctx.save();
        ctx.shadowColor = rgba(0x6b6253, 0.9);
        ctx.shadowBlur = 2 * px;
        ctx.fillStyle = rgba(hash(s, 9, 3) < 0.5 ? 0x6f6657 : 0x7b7567, 0.78);
        ctx.fillRect(x0 - m, z0 - m, w + 2 * m, d + 2 * m);
        ctx.restore();
        this.yard(s, x0 - m, z0 - m, w + 2 * m, d + 2 * m, z0 + d + 20);
      }
    }
    // Carriageways, all of them before any line, so that crossings come out clean.
    const each = (
      f: (x0: number, z0: number, x1: number, z1: number, main: boolean, k: number) => void,
    ) => {
      for (let k = 0; k + 4 < st.length; k += 5) {
        const x0 = (Math.min(st[k], st[k + 2]) + 0.5) * CELL;
        const z0 = (Math.min(st[k + 1], st[k + 3]) + 0.5) * CELL;
        const x1 = (Math.max(st[k], st[k + 2]) + 0.5) * CELL;
        const z1 = (Math.max(st[k + 1], st[k + 3]) + 0.5) * CELL;
        f(x0, z0, x1, z1, st[k + 4] !== 0, k);
      }
    };
    const half = (main: boolean) => (main ? 4.3 : 3.5);
    each((x0, z0, x1, z1, main) => {
      const h = half(main);
      ctx.fillStyle = rgba(0x6a6861, 1);
      ctx.fillRect(x0 - h - 0.3, z0 - h - 0.3, x1 - x0 + 2 * h + 0.6, z1 - z0 + 2 * h + 0.6);
    });
    each((x0, z0, x1, z1, main) => {
      const h = half(main);
      ctx.fillStyle = rgba(main ? 0x45454a : 0x4b4b4f, 1);
      ctx.fillRect(x0 - h, z0 - h, x1 - x0 + 2 * h, z1 - z0 + 2 * h);
    });
    each((x0, z0, x1, z1, main, k) => {
      const along = x1 - x0 >= z1 - z0;
      const len = along ? x1 - x0 : z1 - z0;
      const h = half(main);
      // Patches and old repairs.
      for (let q = 0; q < len / 30; q++) {
        const t = hash(k, q, 21) * len;
        const o = (hash(k, q, 22) - 0.5) * 2 * (h - 1.2);
        const a = 1.5 + 4 * hash(k, q, 24);
        const b = 0.8 + 1.6 * hash(k, q, 25);
        ctx.fillStyle = rgba(hash(k, q, 23) < 0.5 ? 0x3a3a3e : 0x55555a, 0.8);
        if (along) ctx.fillRect(x0 + t, z0 + o, a, b);
        else ctx.fillRect(x0 + o, z0 + t, b, a);
      }
      if (main && len > 20) {
        ctx.strokeStyle = rgba(0xbdb9a6, 0.75);
        ctx.lineWidth = 0.28;
        ctx.setLineDash([2.2, 3.4]);
        ctx.beginPath();
        ctx.moveTo(x0, z0);
        ctx.lineTo(x1, z1);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // What stands along it: lamps on both pavements, cars at the kerb, bins, a shelter.
      const put = (kind: number, t: number, o: number, rot: number) => {
        const x = along ? x0 + t : x0 + o;
        const z = along ? z0 + o : z0 + t;
        // Not where another street comes in.
        const c = Math.floor(z / CELL) * MAP_CELLS + Math.floor(x / CELL);
        const far = along
          ? map.road[Math.floor((z0 + Math.sign(o) * 10) / CELL) * MAP_CELLS + Math.floor(x / CELL)]
          : map.road[
              Math.floor(z / CELL) * MAP_CELLS + Math.floor((x0 + Math.sign(o) * 10) / CELL)
            ];
        if (map.road[c] === 0 || far === 1 || map.structAt[c] >= 0) return;
        this.props.push({ kind, x, z, rot: along ? rot : rot + Math.PI / 2, scale: 1 });
      };
      for (let t = 9, n = 0; t < len - 6; t += 26, n++) {
        const side = (n + k / 5) % 2 === 0 ? -1 : 1;
        put(P_LAMP, t, side * (h + 1.0), side > 0 ? Math.PI : 0);
      }
      for (let t = 14, n = 0; t < len - 10; t += 7.5, n++) {
        const r = hash(k, n, 41);
        if (r > (main ? 0.1 : 0.2)) continue;
        const side = hash(k, n, 42) < 0.5 ? -1 : 1;
        put(
          hash(k, n, 43) < 0.75 ? P_CAR : P_VAN,
          t,
          side * (h - 1.15),
          side > 0 ? Math.PI / 2 : -Math.PI / 2,
        );
      }
      for (let t = 20, n = 0; t < len - 10; t += 34, n++) {
        const side = hash(k, n, 45) < 0.5 ? -1 : 1;
        put(P_BIN, t + hash(k, n, 46) * 12, side * (h + 1.5), 0);
      }
      if (main) {
        for (let t = 60, n = 0; t < len - 30; t += 170, n++) {
          const side = n % 2 === 0 ? -1 : 1;
          put(P_SHELTER, t, side * (h + 1.5), side > 0 ? Math.PI : 0);
        }
      }
    });
  }

  /** The main street of each settlement, the yards of its houses and what stands in them. */
  private towns(): void {
    const map = this.map;
    const ctx = this.mc;
    const px = this.markCanvas.width / MAP_SIZE;
    for (let t = 0; t < map.townCount; t++) {
      const tx = map.townX[t] / 1024;
      const tz = map.townY[t] / 1024;
      const half = map.townR[t] / 1024 + 12;
      // Yards: trodden earth and gravel round each house, a path to its door.
      for (let s = 0; s < map.structCount; s++) {
        if (map.sKind[s] !== S_BUILDING || map.sTown[s] !== t) continue;
        const x0 = map.sX[s] * CELL;
        const z0 = map.sY[s] * CELL;
        const w = map.sW[s] * CELL;
        const d = map.sH[s] * CELL;
        const m = 2.2 + 2.2 * hash(s, 7, 3);
        ctx.save();
        ctx.shadowColor = rgba(0x6b6253, 0.9);
        ctx.shadowBlur = 2 * px;
        ctx.fillStyle = rgba(hash(s, 9, 3) < 0.5 ? 0x6f6657 : 0x7b7567, 0.78);
        ctx.fillRect(x0 - m, z0 - m, w + 2 * m, d + 2 * m);
        ctx.restore();
        // The door is in the middle of the south face.
        const doorX = x0 + w / 2;
        const south = z0 + d;
        ctx.strokeStyle = rgba(0x8a8676, 0.9);
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.moveTo(doorX, south);
        ctx.lineTo(doorX, south < tz ? Math.max(south, tz - 6) : south + m + 1.5);
        ctx.stroke();
        this.yard(s, x0 - m, z0 - m, w + 2 * m, d + 2 * m, tz);
      }
      // The street: pavements, kerbs, a carriageway with a broken centre line.
      const x0 = tx - half - 10;
      const x1 = tx + half + 10;
      const stops = (hex: number, a: number) => {
        const g = ctx.createLinearGradient(x0, 0, x1, 0);
        g.addColorStop(0, rgba(hex, 0));
        g.addColorStop(0.07, rgba(hex, a));
        g.addColorStop(0.93, rgba(hex, a));
        g.addColorStop(1, rgba(hex, 0));
        return g;
      };
      ctx.fillStyle = stops(0x8b897f, 0.95);
      ctx.fillRect(x0, tz - 6.6, x1 - x0, 13.2);
      ctx.fillStyle = stops(0x6a6861, 1);
      ctx.fillRect(x0, tz - 4.7, x1 - x0, 9.4);
      ctx.fillStyle = stops(0x45454a, 1);
      ctx.fillRect(x0, tz - 4.4, x1 - x0, 8.8);
      // Patches and old repairs.
      for (let k = 0; k < 14; k++) {
        const pxm = x0 + 12 + hash(t, k, 21) * (x1 - x0 - 24);
        const pz = tz - 3.6 + hash(t, k, 22) * 6;
        ctx.fillStyle = rgba(hash(t, k, 23) < 0.5 ? 0x3a3a3e : 0x515156, 0.8);
        ctx.fillRect(pxm, pz, 1.5 + 4 * hash(t, k, 24), 0.8 + 1.6 * hash(t, k, 25));
      }
      ctx.strokeStyle = rgba(0xbdb9a6, 0.75);
      ctx.lineWidth = 0.28;
      ctx.setLineDash([2.2, 3.4]);
      ctx.beginPath();
      ctx.moveTo(x0 + 14, tz);
      ctx.lineTo(x1 - 14, tz);
      ctx.stroke();
      ctx.setLineDash([]);
      // A crossing or two.
      for (const cxm of [tx - half * 0.45, tx + half * 0.5]) {
        ctx.fillStyle = rgba(0xc4c1b2, 0.7);
        for (let k = 0; k < 6; k++) ctx.fillRect(cxm, tz - 4 + k * 1.4, 2.4, 0.7);
      }
      // Lamps along both pavements, a bus shelter, poles carrying the line out of town.
      for (let x = x0 + 18; x < x1 - 14; x += 22) {
        const side = Math.round((x - x0) / 22) % 2 === 0 ? -1 : 1;
        this.props.push({
          kind: P_LAMP,
          x,
          z: tz + side * 5.6,
          rot: side > 0 ? Math.PI : 0,
          scale: 1,
        });
      }
      this.props.push({
        kind: P_SHELTER,
        x: tx + (hash(t, 1, 31) - 0.5) * half,
        z: tz - 5.9,
        rot: 0,
        scale: 1,
      });
      this.take(tx, tz, 0);
    }
  }

  /** A fence round three sides of a yard, a shed or a wood stack in a corner. */
  private yard(s: number, x: number, z: number, w: number, d: number, streetZ: number): void {
    const open = z + d / 2 < streetZ ? 1 : -1;
    const r = hash(s, 11, 5);
    if (r < 0.7) {
      const run = (ax: number, az: number, bx: number, bz: number) => {
        const len = Math.hypot(bx - ax, bz - az);
        const n = Math.max(1, Math.round(len / 3));
        const rot = Math.atan2(-(bz - az), bx - ax);
        for (let k = 0; k < n; k++) {
          const f = (k + 0.5) / n;
          this.props.push({
            kind: P_FENCE,
            x: ax + (bx - ax) * f,
            z: az + (bz - az) * f,
            rot,
            scale: len / n / 3,
          });
        }
      };
      // The side that faces the street stays open.
      const back = open > 0 ? z : z + d;
      run(x, back, x + w, back);
      run(x, z, x, z + d);
      run(x + w, z, x + w, z + d);
    }
    const cornerX = x + (hash(s, 13, 5) < 0.5 ? 1.3 : w - 1.3);
    const cornerZ = open > 0 ? z + 1.3 : z + d - 1.3;
    const what = hash(s, 15, 5);
    if (what < 0.45) {
      this.props.push({ kind: P_SHED, x: cornerX, z: cornerZ, rot: 0, scale: 0.9 + 0.3 * what });
    } else if (what < 0.75) {
      this.props.push({ kind: P_STACK, x: cornerX, z: cornerZ, rot: what * 9, scale: 1 });
    }
    if (hash(s, 17, 5) < 0.6) {
      this.props.push({
        kind: P_BUSH,
        x: x + w * hash(s, 19, 5),
        z: open > 0 ? z + 0.8 : z + d - 0.8,
        rot: what * 20,
        scale: 0.7 + 0.5 * hash(s, 21, 5),
      });
    }
  }

  /** A dirt road along a line of (x, z) pairs: gravel, two ruts, a grass strip between them. */
  road(pts: number[]): void {
    const ctx = this.mc;
    const px = this.markCanvas.width / MAP_SIZE;
    const stroke = (width: number, style: string, blur = 0, dash: number[] = []) => {
      ctx.save();
      if (blur > 0) {
        ctx.shadowColor = style;
        ctx.shadowBlur = blur * px;
      }
      ctx.strokeStyle = style;
      ctx.lineWidth = width;
      ctx.lineJoin = ctx.lineCap = 'round';
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(pts[0], pts[1]);
      for (let k = 2; k + 1 < pts.length; k += 2) ctx.lineTo(pts[k], pts[k + 1]);
      ctx.stroke();
      ctx.restore();
    };
    stroke(3.6, rgba(0x7d7462, 0.62), 1.2);
    stroke(2.6, rgba(0x8d8470, 0.8));
    stroke(0.7, rgba(0x6f7a48, 0.45), 0, [5, 3, 9, 4]);
    for (let k = 0; k + 1 < pts.length; k += 2) this.take(pts[k], pts[k + 1], 3);
    // Poles along one side, every forty metres or so.
    let run = 20;
    for (let k = 0; k + 3 < pts.length; k += 2) {
      const dx = pts[k + 2] - pts[k];
      const dz = pts[k + 3] - pts[k + 1];
      const len = Math.hypot(dx, dz);
      run += len;
      if (run < 42 || len < 0.01) continue;
      run = 0;
      const x = pts[k] - (dz / len) * 4.2;
      const z = pts[k + 1] + (dx / len) * 4.2;
      if (this.free(x, z)) {
        this.props.push({ kind: P_POLE, x, z, rot: Math.atan2(-dz, dx), scale: 1 });
      }
    }
  }

  /**
   * Fields: blocks on a grid turned to suit the map, each cut into strips. Only where the
   * ground is open and level and noise says the land is farmed; the rest stays rough grass.
   */
  private layFields(): void {
    const theta = this.map.lanes.length > 0 ? Math.PI / 4 : 0.14;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const mid = MAP_SIZE / 2;
    const world = (u: number, v: number): [number, number] => [
      mid + u * cos - v * sin,
      mid + u * sin + v * cos,
    ];
    const BU = 84;
    const BV = 54;
    const n = Math.ceil((MAP_SIZE * 0.75) / BV);
    // Every corner and a grid of points inside must be free ground.
    const clear = (u0: number, v0: number, w: number, d: number) => {
      for (let a = 0; a <= w + 0.01; a += Math.min(4, w)) {
        for (let b = 0; b <= d + 0.01; b += Math.min(4, d)) {
          const [x, z] = world(u0 + a, v0 + b);
          if (!this.free(x, z)) return false;
        }
      }
      return true;
    };
    for (let bv = -n; bv < n; bv++) {
      for (let bu = -n; bu < n; bu++) {
        const [cx, cz] = world((bu + 0.5) * BU, (bv + 0.5) * BV);
        if (cx < 0 || cz < 0 || cx > MAP_SIZE || cz > MAP_SIZE) continue;
        const farmed = valueNoise(cx / 230, cz / 230, 77) + 0.25 * valueNoise(cx / 90, cz / 90, 78);
        if (farmed < 0.42) continue;
        const strips = 1 + Math.floor(hash(bu, bv, 41) * 2.4);
        const alongU = hash(bu, bv, 43) < 0.6;
        for (let k = 0; k < strips; k++) {
          const seed = bu * 4 + k;
          if (hash(seed, bv, 45) < 0.1) continue;
          let u0 = bu * BU + (alongU ? 0 : (k * BU) / strips) + 1.6;
          let v0 = bv * BV + (alongU ? (k * BV) / strips : 0) + 1.6;
          let w = (alongU ? BU : BU / strips) - 3.2;
          let d = (alongU ? BV / strips : BV) - 3.2;
          if (!clear(u0, v0, w, d)) {
            // Something is in the way: the half of the plot that is clear is still a field.
            const longU = w >= d;
            const hw = longU ? w / 2 - 1 : w;
            const hd = longU ? d : d / 2 - 1;
            if (clear(u0, v0, hw, hd)) {
              w = hw;
              d = hd;
            } else if (clear(longU ? u0 + w / 2 + 1 : u0, longU ? v0 : v0 + d / 2 + 1, hw, hd)) {
              if (longU) u0 += w / 2 + 1;
              else v0 += d / 2 + 1;
              w = hw;
              d = hd;
            } else continue;
          }
          const kind = Math.floor(hash(seed, bv, 47) * FIELDS.length);
          this.field(kind, u0, v0, w, d, theta, world, hash(seed, bv, 49));
        }
      }
    }
  }

  private field(
    kind: number,
    u0: number,
    v0: number,
    w: number,
    d: number,
    theta: number,
    world: (u: number, v: number) => [number, number],
    r: number,
  ): void {
    const ctx = this.fc;
    const f = FIELDS[kind];
    const [ox, oz] = world(u0, v0);
    ctx.save();
    ctx.translate(ox, oz);
    ctx.rotate(theta);
    ctx.beginPath();
    ctx.rect(0, 0, w, d);
    ctx.clip();
    ctx.fillStyle = rgba(f.base, f.cover);
    ctx.fillRect(0, 0, w, d);
    if (f.period > 0) {
      // Rows run the long way, as a tractor would drive them.
      const long = w >= d;
      ctx.strokeStyle = rgba(f.stripe, Math.min(1, f.cover + 0.08));
      ctx.lineWidth = f.width;
      ctx.beginPath();
      for (let p = f.period * 0.5; p < (long ? d : w); p += f.period) {
        if (long) {
          ctx.moveTo(0, p);
          ctx.lineTo(w, p);
        } else {
          ctx.moveTo(p, 0);
          ctx.lineTo(p, d);
        }
      }
      ctx.stroke();
      // The headland: a turn of the plough across both ends.
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = rgba(f.stripe, f.cover * 0.6);
      ctx.strokeRect(1.2, 1.2, w - 2.4, d - 2.4);
    }
    ctx.restore();

    // What stands on it and round it.
    const edge = (a: [number, number], b: [number, number], what: number, step: number) => {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const count = Math.max(1, Math.round(len / step));
      const rot = Math.atan2(-(b[1] - a[1]), b[0] - a[0]);
      for (let k = 0; k < count; k++) {
        const t = (k + 0.5) / count;
        // Gaps: a gate, a stretch that died.
        if (hash(Math.round(a[0] + k * 7), Math.round(a[1]), 53) < 0.14) continue;
        this.props.push({
          kind: what,
          x: a[0] + (b[0] - a[0]) * t,
          z: a[1] + (b[1] - a[1]) * t,
          rot: rot + (what === P_HEDGE ? (hash(k, Math.round(a[0]), 55) - 0.5) * 0.3 : 0),
          scale: what === P_HEDGE ? 0.85 + 0.4 * hash(k, Math.round(a[1]), 57) : len / count / step,
        });
      }
    };
    const c00 = world(u0 - 0.8, v0 - 0.8);
    const c10 = world(u0 + w + 0.8, v0 - 0.8);
    const c01 = world(u0 - 0.8, v0 + d + 0.8);
    const c11 = world(u0 + w + 0.8, v0 + d + 0.8);
    if (kind === F_PASTURE) {
      edge(c00, c10, P_FENCE, 3);
      edge(c10, c11, P_FENCE, 3);
      edge(c01, c11, P_FENCE, 3);
      edge(c00, c01, P_FENCE, 3);
    } else {
      if (r < 0.42) edge(c00, c10, P_HEDGE, 2.6);
      if (r > 0.3 && r < 0.62) edge(c00, c01, P_HEDGE, 2.6);
    }
    if (kind === F_STUBBLE) {
      const bales = 4 + Math.floor(r * 9);
      for (let k = 0; k < bales; k++) {
        const [x, z] = world(
          u0 + 4 + hash(k, Math.round(u0), 61) * (w - 8),
          v0 + 4 + hash(k, Math.round(v0), 63) * (d - 8),
        );
        this.props.push({ kind: P_BALE, x, z, rot: theta + (w >= d ? 0 : Math.PI / 2), scale: 1 });
      }
    }
  }

  /** Bushes at the edge of the woods, rocks under the cliffs, tufts in the rough grass. */
  private scatter(): void {
    const map = this.map;
    const type = (i: number, j: number) =>
      i < 0 || j < 0 || i >= MAP_CELLS || j >= MAP_CELLS ? T_OPEN : map.type[j * MAP_CELLS + i];
    for (let j = 2; j < MAP_CELLS - 2; j++) {
      for (let i = 2; i < MAP_CELLS - 2; i++) {
        const c = j * MAP_CELLS + i;
        if (map.type[c] !== T_OPEN || map.structAt[c] >= 0) continue;
        let forest = 0;
        let cliff = 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const t = type(i + di, j + dj);
            if (t === T_FOREST) forest++;
            else if (t === T_CLIFF) cliff++;
          }
        }
        const r = hash(i, j, 71);
        const x = (i + hash(i, j, 73)) * CELL;
        const z = (j + hash(i, j, 75)) * CELL;
        if (forest > 0 && r < 0.3) {
          this.props.push({ kind: P_BUSH, x, z, rot: r * 40, scale: 0.7 + 0.9 * hash(i, j, 77) });
        } else if (cliff > 0 && r < 0.4) {
          this.props.push({ kind: P_ROCK, x, z, rot: r * 40, scale: 0.5 + 1.3 * hash(i, j, 77) });
        } else if (this.taken[c] === 0) {
          // Rough grass: tufts in drifts, the odd bush or stone.
          const drift = valueNoise(x / 55, z / 55, 81);
          if (r < 0.012) {
            this.props.push({
              kind: P_BUSH,
              x,
              z,
              rot: r * 900,
              scale: 0.6 + 0.7 * hash(i, j, 77),
            });
          } else if (r < 0.02) {
            this.props.push({
              kind: P_ROCK,
              x,
              z,
              rot: r * 900,
              scale: 0.35 + 0.5 * hash(i, j, 77),
            });
          } else if (drift > 0.5 && r < 0.02 + (drift - 0.5) * 1.5) {
            this.props.push({ kind: P_TUFT, x, z, rot: r * 90, scale: 0.7 + 0.8 * hash(i, j, 77) });
            const x2 = (i + hash(i, j, 83)) * CELL;
            const z2 = (j + hash(i, j, 85)) * CELL;
            this.props.push({
              kind: P_TUFT,
              x: x2,
              z: z2,
              rot: r * 50,
              scale: 0.6 + 0.7 * hash(i, j, 79),
            });
          }
        }
      }
    }
  }

  /** Call once the roads are in: lays the fields in what is left and makes the textures. */
  finish(): void {
    this.layFields();
    // Field cells are taken too, so no tuft grows in the wheat: mark them from the canvas.
    const fsize = this.fieldCanvas.width;
    const fpx = this.fc.getImageData(0, 0, fsize, fsize);
    const k = fsize / MAP_CELLS;
    for (let j = 0; j < MAP_CELLS; j++) {
      for (let i = 0; i < MAP_CELLS; i++) {
        const a = fpx.data[4 * (Math.floor((j + 0.5) * k) * fsize + Math.floor((i + 0.5) * k)) + 3];
        if (a > 40) this.taken[j * MAP_CELLS + i] = 1;
      }
    }
    this.scatter();
    const upload = (
      target: THREE.DataTexture,
      canvas: HTMLCanvasElement,
      data: ImageData,
      blank: number,
    ) => {
      // An empty texel still needs a colour: filtering blends toward it at every edge.
      const d = data.data;
      for (let q = 0; q < d.length; q += 4) {
        if (d[q + 3] !== 0) continue;
        d[q] = (blank >> 16) & 255;
        d[q + 1] = (blank >> 8) & 255;
        d[q + 2] = blank & 255;
      }
      target.image = {
        data: new Uint8Array(data.data.buffer),
        width: canvas.width,
        height: canvas.height,
      };
      target.format = THREE.RGBAFormat;
      target.colorSpace = THREE.SRGBColorSpace;
      target.magFilter = THREE.LinearFilter;
      target.minFilter = THREE.LinearMipmapLinearFilter;
      target.generateMipmaps = true;
      target.anisotropy = 4;
      target.needsUpdate = true;
    };
    upload(this.fields, this.fieldCanvas, fpx, 0x6f7a48);
    const msize = this.markCanvas.width;
    upload(this.marks, this.markCanvas, this.mc.getImageData(0, 0, msize, msize), 0x4a4740);
  }
}
