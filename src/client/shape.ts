// Shapes with curves, and the "wear" attributes every code-built model carries (R2,
// decision 090).
//
// Wear is worked out once, when a model is built, and costs nothing per frame. A box has
// no vertices inside its faces, so "how sharp is this corner" stored per vertex would paint
// a whole face the same. Instead each vertex carries where it is inside its own box
// (`aBoxP`) and the box's half size (`aBoxH`), both measured in wear widths; the pixel
// shader then knows how far it is from the nearest edge of the box, exactly, anywhere on a
// face. `aBoxH.w` holds two more things: its fraction is "cavity" (0 to 0.9: the vertex
// sits in a crease, against or inside a neighbouring part, where dirt collects and light
// does not), and 2 is added for cloth, which frays pale instead of chipping to metal.
import * as THREE from 'three/webgpu';

/** No edge anywhere near: the half size given to shapes that have no hard edges. */
const FAR = 1e4;

/** World units of model space that one wear width stands for. Set per model family. */
let wearUnit = 0.045;
export function setWear(unit: number): void {
  wearUnit = unit;
}

export interface Surface {
  color?: number;
  team?: number;
  cloth?: boolean;
}

/** Colour, team mask and wear attributes for a part that has none yet. */
export function dress(
  g: THREE.BufferGeometry,
  s: Surface,
  boxP?: Float32Array,
  boxH?: [number, number, number],
  cavity?: Float32Array,
): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  if (!g.getAttribute('color')) {
    const c = new THREE.Color(s.color ?? 0x565c45);
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) c.toArray(colors, i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
  g.setAttribute('teamMask', new THREE.BufferAttribute(new Float32Array(n).fill(s.team ?? 0), 1));
  const p = new Float32Array(n * 3);
  const h = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      p[i * 3 + k] = boxP ? boxP[i * 3 + k] / wearUnit : 0;
      h[i * 4 + k] = boxH ? Math.min(FAR, boxH[k] / wearUnit) : FAR;
    }
    h[i * 4 + 3] = Math.min(0.9, cavity ? cavity[i] : 0) + (s.cloth ? 2 : 0);
  }
  g.setAttribute('aBoxP', new THREE.BufferAttribute(p, 3));
  g.setAttribute('aBoxH', new THREE.BufferAttribute(h, 4));
  return g;
}

/**
 * Mark the creases of an assembled model: a vertex of one part that lies against or inside
 * the bounding box of another is in a corner where two parts meet. Parts are the geometries
 * about to be merged; `reach` is how close counts, in model units.
 */
export function creases(parts: THREE.BufferGeometry[], reach = wearUnit * 1.5): void {
  const boxes = parts.map((g) => {
    g.computeBoundingBox();
    return g.boundingBox!;
  });
  const v = new THREE.Vector3();
  parts.forEach((g, a) => {
    const pos = g.getAttribute('position');
    const h = g.getAttribute('aBoxH');
    if (!h) return;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      let deep = 0;
      for (let b = 0; b < boxes.length; b++) {
        if (b === a) continue;
        const bb = boxes[b];
        // How far inside the other part's box (grown by `reach`) this vertex is.
        const inside = Math.min(
          v.x - bb.min.x,
          bb.max.x - v.x,
          v.y - bb.min.y,
          bb.max.y - v.y,
          v.z - bb.min.z,
          bb.max.z - v.z,
        );
        // Only the skin of the other part counts: deep inside it nothing can be seen anyway,
        // and a part that merely overlaps another must not go dark all over.
        if (inside > -reach && inside < reach) deep = Math.max(deep, 1 - Math.abs(inside) / reach);
      }
      if (deep > 0) {
        const w = h.getW(i);
        const cloth = w >= 2 ? 2 : 0;
        h.setW(i, cloth + Math.min(0.9, Math.max(w - cloth, deep * 0.9)));
      }
    }
  });
}

/** One cross-section of a lofted shape: an ellipse (or squarer) at a height. */
export interface Ring {
  y: number;
  rx: number;
  rz: number;
  /** Centre of the section. */
  x?: number;
  z?: number;
  color?: number;
  team?: number;
}

export interface LoftOpts extends Surface {
  /** Points round each ring. */
  seg?: number;
  /** 2 is an ellipse; higher is squarer with rounded corners. */
  square?: number;
  /** Close the ends. Default both. */
  cap?: 'both' | 'top' | 'bottom' | 'none';
  at?: [number, number, number];
  rot?: [number, number, number];
}

/**
 * A skin stretched over a stack of rings, smooth-shaded: limbs, torsos, helmets, packs.
 * Narrow places between wider ones (a waist, an ankle, a neck) are marked as creases.
 */
export function loft(rings: Ring[], o: LoftOpts = {}): THREE.BufferGeometry {
  const seg = o.seg ?? 8;
  const e = 2 / (o.square ?? 2);
  const cap = o.cap ?? 'both';
  const base = new THREE.Color(o.color ?? 0x565c45);
  const pos: number[] = [];
  const col: number[] = [];
  const mask: number[] = [];
  const cav: number[] = [];
  const idx: number[] = [];
  const c = new THREE.Color();
  rings.forEach((r, k) => {
    const size = (q: Ring) => q.rx + q.rz;
    const lo = rings[Math.max(0, k - 1)];
    const hi = rings[Math.min(rings.length - 1, k + 1)];
    const pinch = Math.max(0, ((size(lo) + size(hi)) / 2 - size(r)) / Math.max(1e-6, size(r)));
    if (r.color !== undefined) c.set(r.color);
    else c.copy(base);
    for (let s = 0; s < seg; s++) {
      const a = (s / seg) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      pos.push(
        (r.x ?? 0) + r.rx * Math.sign(ca) * Math.abs(ca) ** e,
        r.y,
        (r.z ?? 0) + r.rz * Math.sign(sa) * Math.abs(sa) ** e,
      );
      col.push(c.r, c.g, c.b);
      mask.push(r.team ?? o.team ?? 0);
      cav.push(Math.min(0.9, pinch * 2.2));
    }
  });
  for (let k = 0; k + 1 < rings.length; k++) {
    for (let s = 0; s < seg; s++) {
      const a = k * seg + s;
      const b = k * seg + ((s + 1) % seg);
      idx.push(a, a + seg, b, b, a + seg, b + seg);
    }
  }
  const close = (k: number, up: boolean) => {
    const r = rings[k];
    const centre = pos.length / 3;
    pos.push(r.x ?? 0, r.y, r.z ?? 0);
    if (r.color !== undefined) c.set(r.color);
    else c.copy(base);
    col.push(c.r, c.g, c.b);
    mask.push(r.team ?? o.team ?? 0);
    cav.push(0);
    for (let s = 0; s < seg; s++) {
      const a = k * seg + s;
      const b = k * seg + ((s + 1) % seg);
      if (up) idx.push(centre, b, a);
      else idx.push(centre, a, b);
    }
  };
  if (cap === 'both' || cap === 'bottom') close(0, false);
  if (cap === 'both' || cap === 'top') close(rings.length - 1, true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
  g.setIndex(idx);
  if (o.rot) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...o.rot)));
  if (o.at) g.translate(...o.at);
  g.computeVertexNormals();
  dress(g, o, undefined, undefined, new Float32Array(cav));
  g.setAttribute('teamMask', new THREE.BufferAttribute(new Float32Array(mask), 1));
  return g;
}
