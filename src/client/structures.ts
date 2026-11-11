import * as THREE from 'three/webgpu';
import { attribute } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { fromFx } from '../sim/fixed';
import { BUILDINGS, B_BARRACKS, B_DEPOT, B_DRONES, B_HQ, B_WORKS } from '../sim/economy';
import {
  FLOOR_HEIGHT,
  MAP_CELLS,
  MAX_SITES,
  MAX_STRUCTS,
  SITE_SUPPLIES,
  S_BASE,
  S_BRIDGE,
  addStructure,
  type GameMap,
} from '../sim/map';
import { GARRISON_MAX } from '../sim/units';
import { BASE_STRIDE, type Snapshot } from '../worker/protocol';
import { Batch } from './batch';
import type { Effects } from './effects';
import type { Fog } from './fog';
import type { Terrain } from './terrain';

// Buildings, bridges and town flags. Structures are few (dozens), so each is its own mesh,
// built from boxes when first needed in each of its three states: standing, shot up, and
// collapsed. A ruin is never removed. The readability layer on top (who holds a house, who
// holds the town) is drawn with two small instanced batches.

const CELL = 4;
const FLOOR = fromFx(FLOOR_HEIGHT);
const WALLS = [0x8a8478, 0x7d6a58, 0x9a9384, 0x6f7272, 0x86705a, 0x77786a];
const ROOF = 0x3e3c3a;
const GLASS = 0x1b2126;
const SOOT = 0x0d0c0b;
const CONCRETE = 0x77756e;
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

function rand(seed: number, k: number): number {
  let h = Math.imul(seed + 1, 0x27d4eb2d) ^ Math.imul(k + 1, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

interface Part {
  size: [number, number, number];
  at: [number, number, number];
  color: number;
  rot?: [number, number, number];
  /** Multiplies the colour: soot and weathering. */
  shade?: number;
}

function build(parts: Part[]): THREE.BufferGeometry {
  const c = new THREE.Color();
  const geometries = parts.map((p) => {
    const g = new THREE.BoxGeometry(...p.size);
    if (p.rot) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...p.rot)));
    g.translate(...p.at);
    g.deleteAttribute('uv');
    const n = g.getAttribute('position').count;
    const colors = new Float32Array(n * 3);
    c.set(p.color).multiplyScalar(p.shade ?? 1);
    for (let i = 0; i < n; i++) c.toArray(colors, i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return g;
  });
  const merged = mergeGeometries(geometries);
  for (const g of geometries) g.dispose();
  return merged;
}

/** A house: foundation, walls, rows of windows, a flat roof with a parapet and clutter. */
function buildingParts(
  id: number,
  x0: number,
  z0: number,
  w: number,
  d: number,
  base: number,
  floors: number,
  damaged: boolean,
): Part[] {
  const parts: Part[] = [];
  const cx = x0 + w / 2;
  const cz = z0 + d / 2;
  const h = floors * FLOOR;
  const wall = WALLS[Math.floor(rand(id, 1) * WALLS.length)];
  const wear = damaged ? 0.62 : 0.92 + rand(id, 2) * 0.12;
  parts.push({ size: [w + 0.3, 2.4, d + 0.3], at: [cx, base - 1.15, cz], color: 0x55524c });
  parts.push({ size: [w, h, d], at: [cx, base + h / 2, cz], color: wall, shade: wear });
  // Roof slab, parapet and a stair head.
  parts.push({ size: [w + 0.24, 0.12, d + 0.24], at: [cx, base + h + 0.06, cz], color: ROOF });
  for (const side of [-1, 1]) {
    parts.push({
      size: [w + 0.24, 0.22, 0.14],
      at: [cx, base + h + 0.2, cz + (side * (d + 0.1)) / 2],
      color: wall,
      shade: wear * 0.85,
    });
    parts.push({
      size: [0.14, 0.22, d + 0.24],
      at: [cx + (side * (w + 0.1)) / 2, base + h + 0.2, cz],
      color: wall,
      shade: wear * 0.85,
    });
  }
  parts.push({
    size: [1.3, 0.7, 1.6],
    at: [cx + (rand(id, 3) - 0.5) * (w - 2.5), base + h + 0.45, cz + (rand(id, 4) - 0.5) * (d - 3)],
    color: wall,
    shade: wear * 0.8,
  });
  // Windows on all four faces: dark glass set just proud of the wall.
  let k = 10;
  for (let f = 0; f < floors; f++) {
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
          const blown = damaged && rand(id, k) < 0.45;
          const size: [number, number, number] = alongX
            ? [door ? 0.5 : 0.46, door ? 0.62 : 0.4, 0.05]
            : [0.05, 0.4, 0.46];
          const yy = door ? base + 0.31 : y;
          const off = (side * (alongX ? d : w)) / 2;
          parts.push({
            size: blown ? [size[0] * 1.5, size[1] * 1.6, size[2] * 1.5] : size,
            at: alongX ? [cx + t, yy, cz + off] : [cx + off, yy, cz + t],
            color: blown ? SOOT : door ? 0x2a2622 : GLASS,
          });
        }
      }
    }
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
    parts.push({
      size: [w * 0.45, 0.16, d * 0.5],
      at: [cx + (rand(id, 5) - 0.5) * w * 0.5, base + h + 0.07, cz + (rand(id, 6) - 0.5) * d * 0.4],
      color: SOOT,
    });
  }
  return parts;
}

/** What is left: a scorched heap of slabs with stumps of wall still standing. */
// Base buildings: prefabricated, drab, low and wide. The only colour is a band of the
// owner's paint along the roof line.
const DRAB = 0x5d6149;
const DRAB_DARK = 0x3f4434;
const PANEL = 0x8b8c84;
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
    parts.push({ size: [sw + 0.2, 0.14, sd + 0.2], at: [sx, base + h + 0.07, sz], color: ROOF });
    parts.push({ size: [sw * 0.55, 0.14, sd + 0.2], at: [sx, base + h + 0.2, sz], color: ROOF });
    parts.push({ size: [sw + 0.06, 0.16, sd + 0.06], at: [sx, base + h - 0.2, sz], color: paint });
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
    for (let k = 0; k < 5; k++) {
      parts.push({
        size: [0.5, 0.4, 0.04],
        at: [x0 + (w * (k + 1)) / 6, base + 0.75, cz - d * 0.06],
        color: GLASS,
      });
    }
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

function rubbleParts(
  id: number,
  x0: number,
  z0: number,
  w: number,
  d: number,
  base: number,
  floors: number,
): Part[] {
  const parts: Part[] = [];
  const cx = x0 + w / 2;
  const cz = z0 + d / 2;
  const wall = WALLS[Math.floor(rand(id, 1) * WALLS.length)];
  parts.push({ size: [w + 1.2, 2.4, d + 1.2], at: [cx, base - 1.14, cz], color: 0x3a3733 });
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
  /** What is left at each resource site. */
  readonly siteStock = new Int32Array(MAX_SITES).fill(1);
  private readonly siteMeshes: THREE.Mesh[] = [];
  /** Bumped whenever a structure changes state, so the minimap knows to redraw its base. */
  version = 0;

  private readonly material: THREE.MeshStandardNodeMaterial;
  private readonly meshes: (THREE.Mesh | null)[] = [];
  /** 0 standing, 1 damaged, 2 destroyed. */
  private readonly shown = new Int8Array(MAX_STRUCTS).fill(-1);
  private readonly fellAt = new Float32Array(MAX_STRUCTS).fill(-1e9);
  private readonly pips: Batch;
  private readonly flags: Batch;
  private readonly shadows: boolean;

  constructor(
    private readonly map: GameMap,
    private readonly terrain: Terrain,
    private readonly fog: Fog,
    private readonly effects: Effects,
    shadows: boolean,
  ) {
    this.shadows = shadows;
    this.material = new THREE.MeshStandardNodeMaterial({ roughness: 0.93, metalness: 0 });
    this.material.colorNode = attribute('color', 'vec3').mul(fog.shade());
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
    return fromFx(m.sBase[s]) + (this.hp[s] === 0 ? 0.8 : m.sFloors[s] * FLOOR);
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
    if (this.shown[s] === state) return;
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
      ? bridgeParts(x0, z0, w, d, base, fromFx(m.sEast[s]), state === 2)
      : m.sKind[s] === S_BASE && state !== 2
        ? baseParts(s, this.baseType[s], this.baseTeam[s], x0, z0, w, d, base, state)
        : state === 2
          ? rubbleParts(s, x0 + 0.5, z0 + 0.5, w - 1, d - 1, base, m.sFloors[s])
          : buildingParts(s, x0 + 0.5, z0 + 0.5, w - 1, d - 1, base, m.sFloors[s], state === 1);
    const mesh = this.mesh(build(parts));
    this.meshes[s] = mesh;
    this.group.add(mesh);
    this.shown[s] = state;
    // Units drive on a standing deck; a standing house blocks the view.
    if (bridge) this.terrain.bridgeUp[s] = state === 2 ? 0 : 1;
    else {
      for (let j = m.sY[s]; j < m.sY[s] + m.sH[s]; j++) {
        for (let i = m.sX[s]; i < m.sX[s] + m.sW[s]; i++) {
          this.fog.setWall(j * MAP_CELLS + i, state !== 2);
        }
      }
    }
    this.version++;
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
      if (s.bases[o + 2] !== 0 || s.structHp[id] === 0) continue;
      posts.push(map.sX[id] + (map.sW[id] >> 1), map.sY[id] + (map.sH[id] >> 1), BASE_SIGHT);
    }
    this.fog.posts = posts;
    const n = Math.min(s.structHp.length, map.structCount);
    for (let k = 0; k < n; k++) {
      const hp = s.structHp[k];
      if (hp === 0 && this.hp[k] !== 0) this.fellAt[k] = seconds;
      this.hp[k] = hp;
      const rising = this.baseTeam[k] >= 0 && this.basePct[k] < 100;
      this.show(
        k,
        hp === 0
          ? 2
          : rising
            ? 3
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

  collapse(s: number): void {
    const { x, z } = this.centreOf(s);
    const y = this.terrain.heightAt(x, z);
    this.effects.explosion(x, y + 0.5, z);
    for (let i = 0; i < 6; i++) {
      const p = this.hit(s);
      this.effects.squadHit(p.x, y + 0.3, p.z);
    }
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
      if (s < 0 || this.hp[s] === 0) continue;
      if (origin.y + dir.y * t <= this.topOf(s) + 0.2) return s;
    }
    return -1;
  }

  /** Draw the readability layer. Call after the unit view has counted the occupants. */
  update(seconds: number, dt: number): void {
    const m = this.map;
    const pips = this.pips;
    pips.n = 0;
    for (let s = 0; s < m.structCount; s++) {
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
      if (this.shown[s] === 1 && Math.random() < dt * 0.5) {
        const p = this.hit(s);
        if (this.fog.sees(p.x, p.z)) this.effects.wreckSmoke(p.x, this.topOf(s), p.z, 0.15);
      }
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
