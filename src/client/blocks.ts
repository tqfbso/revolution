// The shape of the bigger town buildings, as seen from the height a battle is commanded
// from. The sim knows a building as one rectangle of cells with a number of floors; drawn
// as one box under one slab it reads as a crate. Here the same rectangle is drawn the way
// a European block is built: a row of houses side by side, each with its own colour, eaves
// height and roof, with firewalls and chimneys between them; the deepest ones as a ring of
// houses round a courtyard. Nothing here is known to the sim: the footprint, the outer
// walls and the number of floors that count are the same.
import { SURF_BRICK, SURF_FELT, SURF_PANEL, SURF_PLASTER, SURF_SHEET, SURF_TILE } from './surfaces';
import type { Part } from './structures';

const WALLS = [0x8a8478, 0x7d6a58, 0x9a9384, 0x6f7272, 0x86705a, 0x77786a, 0x948a72, 0x7f7466];
const BRICKS = [0x7d4e3e, 0x8a5a44, 0x6e4a3c, 0x9a7a5c, 0x74503f];
const TILES = [0x7b4d3c, 0x6c4436, 0x855a43, 0x4d5055, 0x43403d, 0x5e3f35];
const ZINC = [0x4d5055, 0x5a5f5f, 0x43403d, 0x565248];
const FELTS = [0x3e3c3a, 0x474541, 0x524f48, 0x5b584f, 0x414345];
const TRIM = 0x9a9486;
const GLASS = 0x1b2126;
const SOOT = 0x0d0c0b;
const STEEL = 0x8c8f8c;
const PANEL_BLUE = 0x1c2733;

function rand(seed: number, k: number): number {
  let h = Math.imul(seed + 1, 0x27d4eb2d) ^ Math.imul(k + 1, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** A stretch of roof or house in its own frame: `al` along the row, `ac` across it. */
interface Frame {
  cx: number;
  cz: number;
  len: number;
  span: number;
  alongX: boolean;
}

const at = (f: Frame, al: number, y: number, ac: number): [number, number, number] =>
  f.alongX ? [f.cx + al, y, f.cz + ac] : [f.cx + ac, y, f.cz + al];
const box = (f: Frame, al: number, up: number, ac: number): [number, number, number] =>
  f.alongX ? [al, up, ac] : [ac, up, al];
const ridgeOf = (f: Frame, across = false): 'x' | 'z' => (f.alongX !== across ? 'x' : 'z');

/**
 * What stands on a flat roof, sized to the roof: a stair head, skylights, plant with its
 * ducting, a tank, solar panels, aerials. `y` is the top of the roof slab.
 */
export function flatStuff(f: Frame, y: number, id: number, key: number, wall: number): Part[] {
  const parts: Part[] = [];
  const r = (k: number): number => rand(id, key + k);
  const lanes = f.span >= 5 ? 2 : 1;
  const slots = Math.max(1, Math.floor((f.len - 1.2) / 1.9));
  const used = new Set<number>();
  // Each thing takes a free place on the roof: `slot` along it, `lane` across.
  const place = (k: number): [number, number] | null => {
    for (let tries = 0; tries < 6; tries++) {
      const slot = Math.floor(r(k + tries * 7) * slots);
      const lane = Math.floor(r(k + tries * 7 + 3) * lanes);
      if (used.has(slot * 2 + lane)) continue;
      used.add(slot * 2 + lane);
      const al = ((slot + 0.5) / slots - 0.5) * (f.len - 1.2);
      const ac = lanes === 1 ? 0 : (lane === 0 ? -1 : 1) * f.span * 0.24;
      return [al, ac];
    }
    return null;
  };
  // The head of the stairs: the one thing on every roof, and big enough to read.
  if (f.span >= 3.2 && f.len >= 3.2) {
    const p = place(1);
    if (p) {
      const tall = 1.05 + r(2) * 0.35;
      parts.push({
        size: box(f, 1.5, tall, 1.2),
        at: at(f, p[0], y + tall / 2, p[1]),
        color: wall,
        shade: 0.8,
      });
      parts.push({
        size: box(f, 1.7, 0.07, 1.4),
        at: at(f, p[0], y + tall + 0.03, p[1]),
        color: FELTS[0],
        surf: SURF_FELT,
      });
      parts.push({
        size: box(f, 0.42, 0.7, 0.05),
        at: at(f, p[0] + 0.3, y + 0.36, p[1] + 0.6),
        color: 0x2a2622,
      });
    }
  }
  const things = Math.min(9, 1 + Math.floor((f.len * f.span) / 14 + r(5) * 2));
  for (let i = 0; i < things; i++) {
    const p = place(20 + i * 11);
    if (!p) continue;
    const [al, ac] = p;
    const t = r(60 + i);
    if (t < 0.3) {
      // A cooling unit and the duct that runs from it.
      parts.push({ size: box(f, 0.95, 0.45, 0.65), at: at(f, al, y + 0.27, ac), color: STEEL });
      parts.push({ size: box(f, 0.6, 0.05, 0.4), at: at(f, al, y + 0.52, ac), color: 0x4a4d4d });
      const run = Math.min(f.span * 0.3, 1.6);
      parts.push({
        size: box(f, 0.22, 0.2, run),
        at: at(f, al + 0.2, y + 0.14, ac - Math.sign(ac || 1) * (run / 2 + 0.3)),
        color: 0x777a78,
      });
    } else if (t < 0.52) {
      // A skylight on its kerb.
      parts.push({
        size: box(f, 0.95, 0.2, 0.95),
        at: at(f, al, y + 0.1, ac),
        color: TRIM,
        shade: 0.8,
      });
      parts.push({
        size: box(f, 0.8, 0.06, 0.8),
        at: at(f, al, y + 0.22, ac),
        color: GLASS,
        gloss: 0.8,
      });
    } else if (t < 0.66) {
      // Solar panels, tilted to the south.
      for (const o of [-0.38, 0.38]) {
        parts.push({
          size: [1.25, 0.04, 0.62],
          at: at(f, al, y + 0.24, ac + o),
          rot: [0.38, 0, 0],
          color: PANEL_BLUE,
          gloss: 0.55,
        });
      }
    } else if (t < 0.78) {
      // A water tank on a frame.
      parts.push({ size: [0.85, 0.55, 0.85], at: at(f, al, y + 0.66, ac), color: 0x5a6468 });
      parts.push({ size: [0.72, 0.3, 0.72], at: at(f, al, y + 0.2, ac), color: 0x3b3d3d });
    } else if (t < 0.9) {
      // Vent pipes in a cluster.
      for (let v = 0; v < 3; v++) {
        parts.push({
          size: [0.13, 0.45 + v * 0.12, 0.13],
          at: at(f, al + (v - 1) * 0.3, y + 0.25 + v * 0.06, ac + (v % 2) * 0.2),
          color: 0x5c5f5e,
        });
      }
    } else {
      // An aerial.
      parts.push({ size: [0.05, 1.7, 0.05], at: at(f, al, y + 0.85, ac), color: 0x777a78 });
      parts.push({ size: box(f, 0.6, 0.04, 0.04), at: at(f, al, y + 1.5, ac), color: 0x777a78 });
      parts.push({ size: box(f, 0.4, 0.04, 0.04), at: at(f, al, y + 1.25, ac), color: 0x777a78 });
    }
  }
  return parts;
}

/** A flat roof: slab, parapet with its coping, and what stands on it. */
function flatRoof(
  f: Frame,
  top: number,
  id: number,
  key: number,
  wall: number,
  wsurf: number,
  shade: number,
): Part[] {
  const parts: Part[] = [];
  parts.push({
    size: box(f, f.len, 0.12, f.span + 0.24),
    at: at(f, 0, top + 0.06, 0),
    color: FELTS[Math.floor(rand(id, key) * FELTS.length)],
    shade: 0.9 + rand(id, key + 1) * 0.2,
    surf: SURF_FELT,
  });
  for (const s of [-1, 1]) {
    parts.push({
      size: box(f, f.len, 0.3, 0.16),
      at: at(f, 0, top + 0.21, s * (f.span / 2 + 0.04)),
      color: wall,
      shade: shade * 0.85,
      surf: wsurf,
    });
    parts.push({
      size: box(f, f.len, 0.05, 0.24),
      at: at(f, 0, top + 0.38, s * (f.span / 2 + 0.04)),
      color: TRIM,
      shade: 0.85,
    });
    parts.push({
      size: box(f, 0.16, 0.3, f.span + 0.24),
      at: at(f, s * (f.len / 2 - 0.08), top + 0.21, 0),
      color: wall,
      shade: shade * 0.8,
      surf: wsurf,
    });
  }
  parts.push(...flatStuff(f, top + 0.12, id, key + 10, wall));
  return parts;
}

interface Roofed {
  parts: Part[];
  /** How far the roof stands above the eaves. */
  rise: number;
}

/** One house of a row: its roof on top of walls that end at `top`. */
function houseRoof(
  f: Frame,
  top: number,
  id: number,
  key: number,
  kind: string,
  wall: number,
  wsurf: number,
  shade: number,
  tile: number,
  damaged: boolean,
): Roofed {
  const parts: Part[] = [];
  const r = (k: number): number => rand(id, key + k);
  const stack = (al: number, ac: number, tall: number): void => {
    parts.push({
      size: [0.36, tall, 0.36],
      at: at(f, al, top + tall / 2, ac),
      color: 0x6b4c3d,
      shade: shade * 0.9,
      surf: SURF_BRICK,
    });
    parts.push({ size: [0.46, 0.07, 0.46], at: at(f, al, top + tall, ac), color: 0x4a4744 });
  };
  const tone = damaged ? 0.5 : 0.7 + r(1) * 0.2;
  if (kind === 'flat')
    return { parts: flatRoof(f, top, id, key + 100, wall, wsurf, shade), rise: 1.5 };
  if (kind === 'pent') {
    // A top storey set back from the street under its own slab.
    const flat = flatRoof(f, top, id, key + 100, wall, wsurf, shade).slice(0, 7);
    const ph = 1.25;
    const inset = Math.min(1.3, f.span * 0.18);
    parts.push(...flat);
    parts.push({
      size: box(f, f.len - inset * 1.2, ph, f.span - inset * 2),
      at: at(f, 0, top + 0.12 + ph / 2, 0),
      color: wall,
      shade: shade * 1.05,
      surf: wsurf,
    });
    parts.push({
      size: box(f, f.len - inset * 1.2 + 0.06, ph * 0.42, f.span - inset * 2 + 0.06),
      at: at(f, 0, top + 0.12 + ph * 0.56, 0),
      color: GLASS,
      gloss: 1,
    });
    parts.push({
      size: box(f, f.len - inset * 1.2 + 0.4, 0.1, f.span - inset * 2 + 0.5),
      at: at(f, 0, top + 0.17 + ph, 0),
      color: FELTS[1],
      surf: SURF_FELT,
    });
    return { parts, rise: ph + 0.3 };
  }
  if (kind === 'mansard') {
    // Steep slate sides under a flat top, a window in the slope for every one below.
    const mh = 1.2 + r(2) * 0.3;
    const t = Math.min(1.25, f.span * 0.2);
    for (const [len, extra, col, sh, sf] of [
      [f.len, 0, tile, tone, SURF_TILE],
      [0.2, 0.22, wall, shade * 0.72, wsurf],
      [0.2, 0.22, wall, shade * 0.72, wsurf],
    ] as const) {
      const end = extra === 0 ? 0 : parts.length === 1 ? -1 : 1;
      parts.push({
        size: box(f, len, mh + extra, f.span + 0.3 + extra * 2),
        at: at(f, end * (f.len / 2 - 0.1), top + (mh + extra) / 2, 0),
        color: col,
        shade: sh,
        surf: sf,
        taper: f.alongX ? [0, t] : [t, 0],
      });
    }
    parts.push({
      size: box(f, f.len - 0.4, 0.1, f.span + 0.36 - 2 * t),
      at: at(f, 0, top + mh + 0.04, 0),
      color: FELTS[0],
      surf: SURF_FELT,
    });
    const n = Math.max(1, Math.round(f.len / 1.5));
    for (let i = 0; i < n; i++) {
      const al = ((i + 0.5) / n - 0.5) * (f.len - 0.6);
      for (const s of [-1, 1]) {
        const ac = s * (f.span / 2 + 0.15 - t * 0.5);
        parts.push({
          size: box(f, 0.6, 0.58, 0.5),
          at: at(f, al, top + mh * 0.42, ac),
          color: TRIM,
          shade: shade * 0.9,
        });
        parts.push({
          size: box(f, 0.42, 0.36, 0.05),
          at: at(f, al, top + mh * 0.42, ac + s * 0.26),
          color: GLASS,
          gloss: 1,
        });
      }
    }
    stack(-(f.len / 2 - 0.4), f.span * 0.12, mh + 0.6);
    if (r(4) < 0.6) stack(f.len / 2 - 0.4, -f.span * 0.12, mh + 0.6);
    return { parts, rise: mh + 0.7 };
  }
  // Pitched: one roof across the whole depth, or two side by side with a valley between
  // them where the house is deep.
  const twin = kind === 'twin';
  const sheet = kind === 'shed';
  const half = twin ? f.span / 2 : f.span;
  const rise = Math.min(3.3, half * (sheet ? 0.13 : 0.22 + r(2) * 0.09));
  const centres = twin ? [-f.span / 4, f.span / 4] : [0];
  for (const c of centres) {
    const wide = half + (twin ? 0.2 : 0.5);
    if (damaged && r(7 + c) < 0.45) {
      // Burnt out: the rafters stand charred over a black loft.
      parts.push({
        size: box(f, f.len - 0.3, 0.1, half - 0.2),
        at: at(f, 0, top + 0.05, c),
        color: SOOT,
      });
      const n = Math.max(2, Math.round(f.len / 1.2));
      for (let i = 0; i < n; i++) {
        const al = ((i + 0.5) / n - 0.5) * (f.len - 0.5);
        for (const s of [-1, 1]) {
          parts.push({
            size: box(f, 0.09, 0.09, Math.hypot(half / 2, rise)),
            at: at(f, al, top + rise / 2, c + (s * half) / 4),
            rot: f.alongX
              ? [-s * Math.atan2(rise, half / 2), 0, 0]
              : [0, 0, s * Math.atan2(rise, half / 2)],
            color: SOOT,
          });
        }
      }
    } else {
      parts.push({
        size: box(f, f.len - 0.06, rise, wide),
        at: at(f, 0, top, c),
        color: tile,
        shade: tone,
        hip: 0,
        ridge: ridgeOf(f),
        surf: sheet ? SURF_SHEET : SURF_TILE,
      });
    }
    // The firewall at each end stands a hand above the tiles.
    for (const e of [-1, 1]) {
      parts.push({
        size: box(f, 0.2, rise + 0.2, wide + 0.12),
        at: at(f, e * (f.len / 2 - 0.1), top, c),
        color: wall,
        shade: shade * 0.72,
        hip: 0,
        ridge: ridgeOf(f),
        surf: wsurf,
      });
    }
  }
  parts.push({
    size: box(f, f.len, 0.08, f.span + 0.3),
    at: at(f, 0, top - 0.02, 0),
    color: TRIM,
    shade: 0.8,
  });
  const slope = (ac: number): number => {
    const c = twin ? (ac < 0 ? -f.span / 4 : f.span / 4) : 0;
    return rise * Math.max(0, 1 - Math.abs(ac - c) / (half / 2 + 0.1));
  };
  if (!sheet) {
    const ac1 = twin ? -f.span / 4 + 0.3 : f.span * 0.14;
    stack(-(f.len / 2 - 0.42), ac1, slope(ac1) + 0.6);
    if (r(4) < 0.55) stack(f.len / 2 - 0.42, -ac1, slope(-ac1) + 0.6);
  }
  if (!sheet && !damaged && r(5) < 0.7) {
    // Dormers in the slopes that face outward.
    const n = Math.max(1, Math.floor(f.len / 2.7));
    for (const s of [-1, 1]) {
      if (r(6 + s) < 0.3) continue;
      for (let i = 0; i < n; i++) {
        const al = ((i + 0.5) / n - 0.5) * f.len * 0.72;
        const ac = s * (twin ? f.span / 2 - half * 0.27 : f.span * 0.27);
        const y = top + slope(ac);
        parts.push({
          size: box(f, 0.7, 0.5, 0.62),
          at: at(f, al, y + 0.12, ac),
          color: wall,
          shade,
          surf: wsurf,
        });
        parts.push({
          size: box(f, 0.86, 0.2, 0.95),
          at: at(f, al, y + 0.37, ac - s * 0.08),
          color: tile,
          shade: tone,
          hip: 0,
          ridge: ridgeOf(f, true),
          surf: SURF_TILE,
        });
        parts.push({
          size: box(f, 0.42, 0.3, 0.04),
          at: at(f, al, y + 0.14, ac + s * 0.32),
          color: GLASS,
          gloss: 1,
        });
      }
    }
  }
  return { parts, rise: rise + 0.7 };
}

export interface Mass {
  parts: Part[];
  /** Height of the highest thing above the top of the counted floors. */
  crest: number;
  /** A courtyard in the middle: bands round the house must not be drawn across it. */
  court: boolean;
}

/**
 * The walls and roofs of a building big enough to be more than one house, or null for a
 * small one (which keeps its single roof). `w` by `d` centred on `cx`, `cz`; `floor` is the
 * height of a storey.
 */
export function blockMass(o: {
  id: number;
  cx: number;
  cz: number;
  w: number;
  d: number;
  base: number;
  floors: number;
  floor: number;
  house: boolean;
  damaged: boolean;
  wall: number;
  wsurf: number;
  wear: number;
}): Mass | null {
  const { id, cx, cz, w, d, base, floors, floor } = o;
  const S = Math.min(w, d);
  if (S < 10) return null;
  const parts: Part[] = [];
  const top = base + floors * floor;
  // Precast blocks are flat-roofed; some were given a proper roof later.
  const modern = o.wsurf === SURF_PANEL && rand(id, 905) < 0.6;
  const alongX = w === d ? rand(id, 900) < 0.5 : w > d;
  const L = alongX ? w : d;
  let crest = 0;
  // A block built in one go has one kind of roof and one tile; most grew house by house.
  const oneKind = rand(id, 901) < 0.3;
  const oneTile = TILES[Math.floor(rand(id, 902) * TILES.length)];

  /** A row of houses filling the rectangle `f`, their ridges along it. */
  const row = (f: Frame, key: number): void => {
    const n = Math.max(1, Math.round(f.len / (5.2 + rand(id, key) * 2.6)));
    const cuts = [-f.len / 2];
    for (let i = 1; i < n; i++) {
      cuts.push((i / n - 0.5) * f.len + ((rand(id, key + 10 + i) - 0.5) * f.len * 0.2) / n);
    }
    cuts.push(f.len / 2);
    for (let i = 0; i < n; i++) {
      const k = key + 40 + i * 30;
      const seg: Frame = {
        ...f,
        cx: f.alongX ? f.cx + (cuts[i] + cuts[i + 1]) / 2 : f.cx,
        cz: f.alongX ? f.cz : f.cz + (cuts[i] + cuts[i + 1]) / 2,
        len: cuts[i + 1] - cuts[i],
      };
      // Each house in its own colour, a little higher or lower at the eaves than the next.
      let wall = o.wall;
      let wsurf = o.wsurf;
      let shade = o.wear * (0.94 + rand(id, k) * 0.12);
      if (!modern && i > 0) {
        const brick = rand(id, k + 1) < 0.3;
        wall = brick
          ? BRICKS[Math.floor(rand(id, k + 2) * BRICKS.length)]
          : WALLS[Math.floor(rand(id, k + 2) * WALLS.length)];
        wsurf = brick ? SURF_BRICK : SURF_PLASTER;
      }
      if (o.damaged) shade = Math.min(shade, 0.66);
      const lr = rand(id, k + 3);
      const lift =
        floor *
        (modern
          ? lr < 0.6
            ? 0
            : lr < 0.8
              ? 0.5
              : 1
          : lr < 0.4
            ? 0
            : lr < 0.68
              ? 0.3
              : lr < 0.86
                ? 0.65
                : 1);
      const segTop = top + lift;
      parts.push({
        size: box(seg, seg.len, segTop - base, seg.span),
        at: at(seg, 0, (segTop + base) / 2, 0),
        color: wall,
        shade,
        surf: wsurf,
      });
      if (lift >= floor * 0.99) {
        const m = Math.max(1, Math.round(seg.len / 1.15));
        for (let j = 0; j < m; j++) {
          const al = ((j + 0.5) / m - 0.5) * seg.len;
          for (const s of [-1, 1]) {
            const out = o.damaged && rand(id, k + 200 + j * 2 + s) < 0.45;
            parts.push({
              size: box(seg, 0.46, 0.4, 0.05),
              at: at(seg, al, top + floor * 0.56, (s * seg.span) / 2),
              color: out ? SOOT : GLASS,
              gloss: out ? 0 : 1,
            });
          }
        }
      }
      const kr = rand(id, oneKind ? 903 : k + 4);
      const deep = seg.span > 8.5;
      const kind = modern
        ? kr < 0.62
          ? 'flat'
          : kr < 0.8
            ? 'pent'
            : 'shed'
        : deep
          ? kr < 0.34
            ? 'gable'
            : kr < 0.6
              ? 'twin'
              : kr < 0.82
                ? 'mansard'
                : 'flat'
          : kr < 0.74
            ? 'gable'
            : kr < 0.87 && seg.span >= 5.5
              ? 'mansard'
              : 'flat';
      const tile =
        kind === 'mansard' || kind === 'shed'
          ? ZINC[Math.floor(rand(id, k + 5) * ZINC.length)]
          : oneKind
            ? oneTile
            : TILES[Math.floor(rand(id, k + 5) * TILES.length)];
      const roof = houseRoof(seg, segTop, id, k + 6, kind, wall, wsurf, shade, tile, o.damaged);
      parts.push(...roof.parts);
      crest = Math.max(crest, lift + roof.rise);
    }
  };

  if (S >= 14 && rand(id, 904) < 0.68) {
    // A ring of houses round a courtyard: two rows the length of the block, two between.
    const D = Math.min(7.5, Math.max(4.6, S * 0.33));
    const acrossLen = S - 2 * D;
    for (const s of [-1, 1]) {
      row(
        {
          cx: alongX ? cx : cx + s * (S / 2 - D / 2),
          cz: alongX ? cz + s * (S / 2 - D / 2) : cz,
          len: L,
          span: D,
          alongX,
        },
        1000 + (s + 1) * 400,
      );
      row(
        {
          cx: alongX ? cx + s * (L / 2 - D / 2) : cx,
          cz: alongX ? cz : cz + s * (L / 2 - D / 2),
          len: acrossLen,
          span: D,
          alongX: !alongX,
        },
        3000 + (s + 1) * 400,
      );
    }
    // The yard inside: paving, a patch of green, a shed, and the windows that look onto it.
    const yard: Frame = { cx, cz, len: L - 2 * D, span: acrossLen, alongX };
    parts.push({
      size: box(yard, yard.len, 0.1, yard.span),
      at: at(yard, 0, base + 0.05, 0),
      color: 0x6a665c,
      shade: 0.8,
    });
    parts.push({
      size: box(yard, yard.len * 0.5, 0.08, yard.span * 0.45),
      at: at(yard, yard.len * 0.15, base + 0.13, -yard.span * 0.1),
      color: 0x46552f,
      shade: 0.8,
    });
    parts.push({
      size: box(yard, 1.5, 0.75, 1.1),
      at: at(yard, -yard.len / 2 + 0.8, base + 0.47, yard.span / 2 - 0.6),
      color: 0x5a5148,
      shade: 0.8,
    });
    for (let fl = 0; fl < floors; fl++) {
      const y = base + fl * floor + floor * 0.56;
      for (const [fr, len, off] of [
        [yard, yard.len, yard.span / 2],
        [{ ...yard, alongX: !alongX }, yard.span, yard.len / 2],
      ] as const) {
        const m = Math.max(1, Math.round(len / 1.4));
        for (let j = 0; j < m; j++) {
          for (const s of [-1, 1]) {
            parts.push({
              size: box(fr, 0.46, 0.4, 0.05),
              at: at(fr, ((j + 0.5) / m - 0.5) * len, y, s * off),
              color: GLASS,
              gloss: 1,
            });
          }
        }
      }
    }
    return { parts, crest, court: true };
  }
  if (S >= 14) {
    // Two rows back to back.
    for (const s of [-1, 1]) {
      row(
        {
          cx: alongX ? cx : cx + (s * S) / 4,
          cz: alongX ? cz + (s * S) / 4 : cz,
          len: L,
          span: S / 2,
          alongX,
        },
        1000 + (s + 1) * 400,
      );
    }
    return { parts, crest, court: false };
  }
  row({ cx, cz, len: L, span: S, alongX }, 1000);
  return { parts, crest, court: false };
}
