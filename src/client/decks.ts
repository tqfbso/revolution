// Carriageways carried over the ground (map.decks): the motorway of the European city, on
// its embankment and on a span over every street that passes under it. Scenery only: the
// sim knows the embankment as ground nobody can cross.
import * as THREE from 'three/webgpu';
import { attribute } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { fromFx } from '../sim/fixed';
import type { GameMap } from '../sim/map';
import type { Fog } from './fog';
const CELL = 4;

const WIDTH = 11.4;
const CONCRETE = new THREE.Color(0x8d8a82);
const ASPHALT = new THREE.Color(0x3d3d41);
const LINE = new THREE.Color(0xc9c5b6);
const STEEL = new THREE.Color(0x5d6266);

export class Decks {
  readonly group = new THREE.Group();

  constructor(map: GameMap, fog: Fog, shadows: boolean) {
    const d = map.decks;
    if (d.length === 0) return;
    const parts: THREE.BufferGeometry[] = [];
    const box = (
      cx: number,
      cy: number,
      cz: number,
      sx: number,
      sy: number,
      sz: number,
      color: THREE.Color,
    ) => {
      const g = new THREE.BoxGeometry(sx, sy, sz).toNonIndexed();
      g.translate(cx, cy, cz);
      const n = g.getAttribute('position').count;
      const colors = new Float32Array(3 * n);
      for (let k = 0; k < n; k++) color.toArray(colors, 3 * k);
      g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      parts.push(g);
    };
    for (let k = 0; k + 4 < d.length; k += 5) {
      const upright = d[k] === d[k + 2];
      const top = fromFx(d[k + 4]) + 0.5;
      const from =
        (Math.min(upright ? d[k + 1] : d[k], upright ? d[k + 3] : d[k + 2]) - 0.5) * CELL;
      const to = (Math.max(upright ? d[k + 1] : d[k], upright ? d[k + 3] : d[k + 2]) + 1.5) * CELL;
      const across = ((upright ? d[k] : d[k + 1]) + 0.5) * CELL;
      const len = to - from;
      const mid = (from + to) / 2;
      /** A box `l` long on the deck's line, `w` wide, centred `off` to one side. */
      const along = (
        at: number,
        l: number,
        off: number,
        y: number,
        w: number,
        h: number,
        c: THREE.Color,
      ) => (upright ? box(across + off, y, at, w, h, l, c) : box(at, y, across + off, l, h, w, c));
      along(mid, len, 0, top - 0.35, WIDTH, 0.7, CONCRETE);
      along(mid, len, 0, top + 0.02, WIDTH - 1.2, 0.04, ASPHALT);
      for (const side of [-1, 1]) {
        along(mid, len, side * (WIDTH / 2 - 0.25), top + 0.45, 0.3, 0.9, CONCRETE);
        along(mid, len, side * (WIDTH / 2 - 0.9), top + 0.045, 0.14, 0.02, LINE);
      }
      // The reservation down the middle, lane marks, and a lamp standard now and then.
      along(mid, len, 0, top + 0.3, 0.35, 0.56, STEEL);
      for (let at = from + 4; at < to - 2; at += 9) {
        for (const side of [-1, 1]) along(at, 3.2, side * 2.6, top + 0.045, 0.14, 0.02, LINE);
      }
      for (let at = from + 10; at < to - 4; at += 28) {
        along(at, 0.16, 0, top + 3.6, 0.16, 6.2, STEEL);
        along(at, 0.2, 0, top + 6.7, 4.4, 0.12, STEEL);
      }
    }
    const geometry = mergeGeometries(parts);
    const material = new THREE.MeshLambertNodeMaterial();
    material.colorNode = attribute('color', 'vec3').mul(fog.shade());
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    this.group.add(mesh);
  }
}
