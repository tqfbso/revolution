import * as THREE from 'three/webgpu';
import {
  attribute,
  cameraViewMatrix,
  color,
  float,
  hash,
  instanceIndex,
  mix,
  normalWorld,
  positionWorld,
  smoothstep,
  texture,
  time,
  vec2,
  vec3,
} from 'three/tsl';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { fromFx } from '../sim/fixed';
import {
  CLASS_VEHICLE,
  MAP_CELLS,
  MAP_SIZE,
  MAX_STRUCTS,
  T_CLIFF,
  T_FOREST,
  T_OPEN,
  T_WATER,
  WATER_LEVEL,
  type GameMap,
} from '../sim/map';
import type { Fog } from './fog';
import type { Look } from './look';

// Draws the sim's map (src/sim/map.ts): the ground mesh, a water surface, and instanced
// trees on forest cells. Heights are the sim's integers as floats. The ground is one
// material that blends four surfaces (grass, earth, rock, asphalt) by weights stored in
// the vertices, plus a texture of wear that the battle writes into as it goes.

const GRID = MAP_CELLS;
const CELL = MAP_SIZE / GRID;
const VERTS = GRID + 1;
const TREE_CHUNK = 32; // cells per side of one tree batch, so off-screen forest is culled
const TREES_PER_CELL = 2;
/** Texels per side of the wear texture: one every 2 world units. */
const WEAR = 512;
const WEAR_SCALE = WEAR / MAP_SIZE;

function hash2(x: number, y: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function paint(g: THREE.BufferGeometry, y: number, colour: number): THREE.BufferGeometry {
  g.translate(0, y, 0);
  g.deleteAttribute('uv');
  const c = new THREE.Color(colour);
  const n = g.getAttribute('position').count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.toArray(colors, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

/** A spruce about 4 units tall: trunk and three drooping tiers. */
function conifer(): THREE.BufferGeometry {
  return mergeGeometries([
    paint(new THREE.CylinderGeometry(0.09, 0.16, 1.3, 5, 1, true), 0.65, 0x4a3d2e),
    paint(new THREE.ConeGeometry(1.05, 1.7, 7, 1, true), 1.6, 0x35462a),
    paint(new THREE.ConeGeometry(0.8, 1.6, 7, 1, true), 2.5, 0x3c4d2f),
    paint(new THREE.ConeGeometry(0.5, 1.5, 6, 1, true), 3.45, 0x485a36),
  ]);
}

/** A broadleaf tree: a short trunk under a lumpy crown, lighter where the sun reaches it. */
function broadleaf(): THREE.BufferGeometry {
  const blob = (r: number, x: number, y: number, z: number, colour: number) => {
    // Indexed, like the trunk it is merged with.
    const g = mergeVertices(new THREE.IcosahedronGeometry(r, 0));
    g.deleteAttribute('normal');
    g.scale(1, 0.8, 1);
    g.translate(x, 0, z);
    return paint(g, y, colour);
  };
  return mergeGeometries(
    [
      paint(new THREE.CylinderGeometry(0.11, 0.19, 1.5, 5, 1, true), 0.75, 0x40362a),
      blob(1.05, 0, 2.2, 0, 0x435628),
      blob(0.8, 0.6, 2.7, 0.3, 0x516a30),
      blob(0.75, -0.55, 2.5, -0.4, 0x3a4c24),
      blob(0.7, 0.1, 3.1, -0.3, 0x5b7335),
    ].map((g) => {
      g.computeVertexNormals();
      return g;
    }),
  );
}

export class Terrain {
  readonly mesh: THREE.Mesh;
  readonly water: THREE.Mesh;
  readonly trees = new THREE.Group();
  private readonly heights = new Float32Array(VERTS * VERTS);
  /** Per structure: 1 while it is a standing bridge, whose deck units then stand on. */
  readonly bridgeUp = new Uint8Array(MAX_STRUCTS);
  /** How worn the ground is, 0..255 per texel: tracks, churned mud, shell-torn earth. */
  private readonly wear = new Uint8Array(WEAR * WEAR);
  private readonly wearTexture: THREE.DataTexture;
  private wearDirty = false;
  private wearAge = 0;

  constructor(
    readonly map: GameMap,
    private readonly fog: Fog,
    private readonly look: Look,
  ) {
    const shadows = look.shadows;
    for (let k = 0; k < VERTS * VERTS; k++) this.heights[k] = fromFx(map.heights[k]);
    this.wearTexture = new THREE.DataTexture(this.wear, WEAR, WEAR, THREE.RedFormat);
    this.wearTexture.magFilter = this.wearTexture.minFilter = THREE.LinearFilter;
    this.layTracks();
    this.wearTexture.needsUpdate = true;

    const positions = new Float32Array(VERTS * VERTS * 3);
    const colors = new Float32Array(VERTS * VERTS * 3);
    // Per vertex: how much of it is earth, rock, asphalt, and how wet it is.
    const splat = new Float32Array(VERTS * VERTS * 4);
    const low = new THREE.Color(0x4b5a39);
    const mid = new THREE.Color(0x6a7549);
    const high = new THREE.Color(0x8b8863);
    // Packed earth in the settlements, a paved road along the main street onto the bridge.
    const built = (i: number, j: number) => {
      let n = 0;
      for (let t = 0; t < map.townCount; t++) {
        const dx = i * CELL - map.townX[t] / 1024;
        const dz = j * CELL - map.townY[t] / 1024;
        const r = map.townR[t] / 1024 - 10;
        if (Math.abs(dz) < 7 && Math.abs(dx) < r + 22) return 2;
        if (Math.abs(dx) < r && Math.abs(dz) < r) n = 1;
      }
      return n;
    };
    const floor = new THREE.Color(0x2b3421);
    const c = new THREE.Color();
    const typeAt = (i: number, j: number) =>
      i < 0 || j < 0 || i >= GRID || j >= GRID ? T_OPEN : map.type[j * GRID + i];
    const water = fromFx(WATER_LEVEL);
    for (let j = 0; j < VERTS; j++) {
      for (let i = 0; i < VERTS; i++) {
        const k = j * VERTS + i;
        const h = this.heights[k];
        positions[3 * k] = i * CELL;
        positions[3 * k + 1] = h;
        positions[3 * k + 2] = j * CELL;
        // A vertex takes its surface from the four cells that share it.
        let cliff = 0;
        let forest = 0;
        let wet = 0;
        for (let q = 0; q < 4; q++) {
          const t = typeAt(i - (q & 1), j - (q >> 1));
          if (t === T_CLIFF) cliff++;
          else if (t === T_FOREST) forest++;
          else if (t === T_WATER) wet++;
        }
        const t = THREE.MathUtils.clamp((h + 2) / 14, 0, 1);
        if (t < 0.5) c.copy(low).lerp(mid, t * 2);
        else c.copy(mid).lerp(high, (t - 0.5) * 2);
        if (forest > 0) c.lerp(floor, forest / 4);
        const speckle = 0.94 + 0.12 * hash2(i * 7 + 3, j * 13 + 5);
        colors[3 * k] = c.r * speckle;
        colors[3 * k + 1] = c.g * speckle;
        colors[3 * k + 2] = c.b * speckle;
        const town = h > 0.2 ? built(i, j) : 0;
        // Bare earth: yards, the river banks and bed, a little under the trees.
        let earth = town === 1 ? 0.5 : 0;
        earth = Math.max(earth, THREE.MathUtils.clamp((0.75 - h) / 0.9, 0, 1), wet / 4);
        earth = Math.max(earth, forest * 0.09);
        splat[4 * k] = earth;
        splat[4 * k + 1] = Math.min(1, cliff / 2);
        splat[4 * k + 2] = town === 2 ? 1 : 0;
        splat[4 * k + 3] = THREE.MathUtils.clamp((water + 0.75 - h) / 0.9, 0, 1);
      }
    }
    const indices = new Uint32Array(GRID * GRID * 6);
    let q = 0;
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const a = j * VERTS + i;
        const b = a + 1;
        const d = a + VERTS;
        const e = d + 1;
        indices[q++] = a;
        indices[q++] = d;
        indices[q++] = b;
        indices[q++] = b;
        indices[q++] = d;
        indices[q++] = e;
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('splat', new THREE.BufferAttribute(splat, 4));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    this.mesh = new THREE.Mesh(geometry, this.groundMaterial());
    this.mesh.matrixAutoUpdate = false;
    this.mesh.receiveShadow = shadows;

    this.water = new THREE.Mesh(
      new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE).rotateX(-Math.PI / 2),
      this.waterMaterial(),
    );
    this.water.position.set(MAP_SIZE / 2, water, MAP_SIZE / 2);
    this.water.receiveShadow = shadows;

    this.buildTrees(shadows);
  }

  /** Everything in the world is darkened by the fog of war texture (and the clouds). */
  private groundMaterial(): THREE.Material {
    const shade = this.fog.shade();
    const tone = attribute('color', 'vec3');
    const xz = positionWorld.xz;
    const wear = texture(this.wearTexture, xz.div(MAP_SIZE)).r;
    if (!this.look.rich) {
      // Low quality: flat colours, as the game looked before the realism pass.
      const m = new THREE.MeshLambertNodeMaterial();
      const sp = attribute('splat', 'vec4');
      const base = mix(
        mix(mix(tone, color(0x5d5340), sp.x.max(wear)), color(0x5c5850), sp.y),
        color(0x45443f),
        sp.z,
      );
      m.colorNode = base.mul(shade);
      return m;
    }
    const tex = this.look.tex;
    const sp = attribute('splat', 'vec4');
    const G = texture(tex.grass, xz.div(6.5));
    const D = texture(tex.dirt, xz.div(8.5));
    // Rock is sampled sliding with height, so cliff faces do not smear.
    const R = texture(tex.rock, xz.add(positionWorld.y.mul(0.8)).div(13));
    const P = texture(tex.paved, xz.div(10));
    // Broad patches a field or two across: drier grass, thin soil, bare ground.
    const macro = texture(tex.noise, xz.div(210));
    type F = THREE.Node<'float'>;
    const sharp = (w: F, h: F) => smoothstep(0.38, 0.62, w.add(h.sub(0.5).mul(0.6)));
    const patch = texture(tex.noise, xz.div(47));
    const bare = macro.b.sub(0.63).max(0).mul(1.6).add(patch.g.sub(0.5).mul(0.45));
    const wEarth = sharp(
      sp.x.add(wear.mul(1.1)).add(bare).clamp(0, 1),
      D.b.add(float(1).sub(G.b)).mul(0.5),
    );
    const wRock = sharp(sp.y, R.b);
    const wPaved = sharp(sp.z, P.b);
    const dry = mix(tone, tone.mul(vec3(1.14, 1.04, 0.8)), macro.g.mul(macro.r).mul(1.8).min(1));
    const grass = dry
      .mul(G.b.mul(0.9).add(0.55))
      .mul(macro.r.mul(0.5).add(patch.r.mul(0.3)).add(0.62));
    // Wet earth is darker; so is earth that tracks have churned.
    const damp = sp.w.max(wear.mul(0.6));
    const earth = color(0x574f43)
      .mul(D.b.mul(0.9).add(0.55))
      .mul(mix(float(1), float(0.55), damp));
    const rock = color(0x6d675d).mul(R.b.mul(0.9).add(0.55));
    const paved = color(0x47464a).mul(P.b.mul(0.8).add(0.6));
    const albedo = mix(mix(mix(grass, earth, wEarth), rock, wRock), paved, wPaved);
    const detail = mix(mix(mix(G, D, wEarth), R, wRock), P, wPaved);
    const m = new THREE.MeshStandardNodeMaterial({ metalness: 0 });
    m.colorNode = albedo.mul(shade);
    m.roughnessNode = detail.a.sub(damp.mul(wEarth).mul(0.3)).clamp(0.25, 1);
    // The texture's slopes tilt the surface normal: its u runs east, its v south.
    const tilt = detail.xy.mul(2).sub(1);
    const n = normalWorld.add(vec3(tilt.x, 0, tilt.y).mul(0.9)).normalize();
    m.normalNode = cameraViewMatrix.transformDirection(n);
    return m;
  }

  private waterMaterial(): THREE.Material {
    const shade = this.fog.shade();
    if (!this.look.rich) {
      const flat = new THREE.MeshStandardNodeMaterial({
        roughness: 0.18,
        metalness: 0,
        transparent: true,
        opacity: 0.8,
      });
      flat.colorNode = color(0x2c4347).mul(shade);
      return flat;
    }
    // The depth of the water under each pixel, from a texture of the ground heights.
    let lo = Infinity;
    let hi = -Infinity;
    for (const h of this.heights) {
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    const px = new Uint8Array(VERTS * VERTS);
    for (let k = 0; k < px.length; k++)
      px[k] = Math.round(((this.heights[k] - lo) / (hi - lo)) * 255);
    const bed = new THREE.DataTexture(px, VERTS, VERTS, THREE.RedFormat);
    bed.magFilter = bed.minFilter = THREE.LinearFilter;
    bed.needsUpdate = true;
    const xz = positionWorld.xz;
    const ground = texture(bed, xz.add(CELL / 2).div(MAP_SIZE + CELL))
      .r.mul(hi - lo)
      .add(lo);
    const depth = float(fromFx(WATER_LEVEL)).sub(ground);
    const tex = this.look.tex;
    // Two layers of ripples sliding over each other, carried south by the current.
    const a = texture(tex.water, xz.div(9).add(vec2(time.mul(0.012), time.mul(0.05))));
    const b = texture(tex.water, xz.div(4.3).add(vec2(time.mul(-0.02), time.mul(0.085))));
    const tilt = a.xy.add(b.xy).sub(1);
    const m = new THREE.MeshStandardNodeMaterial({ metalness: 0, transparent: true });
    const deep = smoothstep(0, 2.2, depth);
    // Silt-laden in the shallows, dark green-brown in the channel, a pale line at the bank.
    const body = mix(color(0x4a4d3a), color(0x18262a), deep);
    const foam = float(1)
      .sub(smoothstep(0.02, 0.16, depth))
      .mul(a.b.add(b.b).mul(0.5).add(0.3));
    m.colorNode = mix(body, color(0xa9ab9c), foam.mul(0.3)).mul(shade);
    m.opacityNode = smoothstep(-0.02, 0.9, depth).mul(0.5).add(0.42).add(foam.mul(0.2)).min(0.94);
    m.roughnessNode = float(0.09).add(foam.mul(0.4));
    m.normalNode = cameraViewMatrix.transformDirection(
      vec3(tilt.x.mul(0.33), 1, tilt.y.mul(0.33)).normalize(),
    );
    return m;
  }

  /**
   * Cart tracks from each headquarters to the settlements on its bank, worn into the ground
   * before the game starts. Cosmetic: they follow the easy ground but give no speed.
   */
  private layTracks(): void {
    const map = this.map;
    const pass = map.natural[CLASS_VEHICLE];
    if (!pass || map.startX[0] < 0) return;
    const N = GRID;
    const dist = new Float32Array(N * N);
    const from = new Int32Array(N * N);
    for (let side = 0; side < 2; side++) {
      const sx = Math.min(N - 1, map.startX[side] + 3);
      const sy = Math.min(N - 1, map.startY[side] + 6);
      const start = sy * N + sx;
      dist.fill(Infinity);
      from.fill(-1);
      dist[start] = 0;
      // Dijkstra over the cells with a binary heap of (distance, cell) pairs.
      const heap: number[] = [0, start];
      const push = (d: number, c: number) => {
        let i = heap.length;
        heap.push(d, c);
        while (i > 0) {
          const p = (((i >> 1) - 1) >> 1) << 1;
          if (heap[p] <= d) break;
          heap[i] = heap[p];
          heap[i + 1] = heap[p + 1];
          i = p;
        }
        heap[i] = d;
        heap[i + 1] = c;
      };
      const pop = () => {
        const c = heap[1];
        const d = heap[heap.length - 2];
        const cell = heap[heap.length - 1];
        heap.length -= 2;
        const n = heap.length;
        if (n > 0) {
          let i = 0;
          for (;;) {
            let k = 2 * i + 2;
            if (k >= n) break;
            if (k + 2 < n && heap[k + 2] < heap[k]) k += 2;
            if (heap[k] >= d) break;
            heap[i] = heap[k];
            heap[i + 1] = heap[k + 1];
            i = k;
          }
          heap[i] = d;
          heap[i + 1] = cell;
        }
        return c;
      };
      while (heap.length > 0) {
        const d0 = heap[0];
        const c = pop();
        if (d0 > dist[c]) continue;
        const cx = c % N;
        const cy = (c - cx) / N;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const x = cx + dx;
            const y = cy + dy;
            if (x < 1 || y < 1 || x >= N - 1 || y >= N - 1) continue;
            const o = y * N + x;
            if (pass[o] === 0) continue;
            // Tracks keep to level ground and wander a little, as real ones do.
            const slope = Math.abs(this.heights[y * VERTS + x] - this.heights[cy * VERTS + cx]);
            const step =
              (dx !== 0 && dy !== 0 ? 1.414 : 1) * (pass[o] + slope * 2.5 + hash2(x, y) * 0.9);
            if (d0 + step < dist[o]) {
              dist[o] = d0 + step;
              from[o] = c;
              push(d0 + step, o);
            }
          }
        }
      }
      for (let t = 0; t < map.townCount; t++) {
        const tx = map.townX[t] / 1024;
        const hq = map.startX[side] * CELL;
        // Only to the settlements nearer this headquarters than the other one.
        const ty0 = map.townY[t] / 1024;
        const near = (k: number) =>
          Math.hypot(tx - map.startX[k] * CELL, ty0 - map.startY[k] * CELL);
        if (near(side) > near(1 - side)) continue;
        // Aim for the outer end of the main street.
        const out = hq < tx ? -1 : 1;
        const ex = Math.round((tx + out * (map.townR[t] / 1024 + 8)) / CELL);
        const ey = Math.round(map.townY[t] / 1024 / CELL);
        let c = Math.min(N - 1, Math.max(0, ey)) * N + Math.min(N - 1, Math.max(0, ex));
        if (!Number.isFinite(dist[c])) continue;
        const pts: number[] = [];
        for (let guard = 0; c >= 0 && guard < 4000; guard++) {
          if (guard % 3 === 0 || from[c] < 0)
            pts.push(((c % N) + 0.5) * CELL, (Math.floor(c / N) + 0.5) * CELL);
          c = from[c];
        }
        this.strokeTrack(smoothLine(smoothLine(pts)));
      }
    }
  }

  private strokeTrack(pts: number[]): void {
    for (let k = 0; k + 3 < pts.length; k += 2) {
      const len = Math.hypot(pts[k + 2] - pts[k], pts[k + 3] - pts[k + 1]);
      const steps = Math.max(1, Math.ceil(len));
      for (let s = 0; s < steps; s++) {
        const f = s / steps;
        this.stamp(
          pts[k] + (pts[k + 2] - pts[k]) * f,
          pts[k + 1] + (pts[k + 3] - pts[k + 1]) * f,
          1.5,
          70,
          175,
        );
      }
    }
  }

  /**
   * Wear the ground around world point (x, z): `amount` (of 255) is added at the centre,
   * fading to nothing at `radius`, and never beyond `cap`.
   */
  stamp(x: number, z: number, radius: number, amount: number, cap = 255): void {
    const r = radius * WEAR_SCALE;
    const cx = x * WEAR_SCALE - 0.5;
    const cy = z * WEAR_SCALE - 0.5;
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(WEAR - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(WEAR - 1, Math.ceil(cy + r));
    const wear = this.wear;
    for (let y = y0; y <= y1; y++) {
      for (let xx = x0; xx <= x1; xx++) {
        const d = Math.hypot(xx - cx, y - cy) / (r + 0.5);
        if (d >= 1) continue;
        const k = y * WEAR + xx;
        if (wear[k] >= cap) continue;
        wear[k] = Math.min(cap, wear[k] + amount * (1 - d * d));
        this.wearDirty = true;
      }
    }
  }

  /** Send the wear to the graphics card, at most twice a second. */
  update(dt: number): void {
    this.wearAge += dt;
    if (!this.wearDirty || this.wearAge < 0.5) return;
    this.wearAge = 0;
    this.wearDirty = false;
    this.wearTexture.needsUpdate = true;
  }

  private buildTrees(shadows: boolean): void {
    const kinds = [conifer(), broadleaf()];
    // Trees are many and small on screen: the cheap lighting model is enough for them.
    const material = new THREE.MeshLambertNodeMaterial();
    // No two trees quite the same green.
    const vary = hash(instanceIndex).mul(0.5).add(0.8);
    material.colorNode = attribute('color', 'vec3').mul(vary).mul(this.fog.shade());
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const p = new THREE.Vector3();
    const scale = new THREE.Vector3();
    for (let cj = 0; cj < GRID; cj += TREE_CHUNK) {
      for (let ci = 0; ci < GRID; ci += TREE_CHUNK) {
        // Broadleaf woods on the low ground and by the water, spruce higher up.
        const cells: number[][] = [[], []];
        for (let j = cj; j < cj + TREE_CHUNK; j++) {
          for (let i = ci; i < ci + TREE_CHUNK; i++) {
            if (this.map.type[j * GRID + i] !== T_FOREST) continue;
            const h = this.heights[j * VERTS + i];
            const leafy = h + (hash2(i >> 3, j >> 3) - 0.5) * 6 + (hash2(i, j) - 0.5) * 3 < 4.2;
            cells[leafy ? 1 : 0].push(j * GRID + i);
          }
        }
        for (let kind = 0; kind < 2; kind++) {
          if (cells[kind].length === 0) continue;
          const mesh = new THREE.InstancedMesh(
            kinds[kind],
            material,
            cells[kind].length * TREES_PER_CELL,
          );
          let n = 0;
          for (const cell of cells[kind]) {
            const i = cell % GRID;
            const j = (cell - i) / GRID;
            for (let k = 0; k < TREES_PER_CELL; k++) {
              const x = (i + 0.1 + 0.8 * hash2(cell * 3 + k, 11)) * CELL;
              const z = (j + 0.1 + 0.8 * hash2(cell * 3 + k, 29)) * CELL;
              const s = 0.75 + 0.6 * hash2(cell * 3 + k, 47);
              p.set(x, this.heightAt(x, z) - 0.05, z);
              q.setFromAxisAngle(up, hash2(cell * 3 + k, 61) * Math.PI * 2);
              scale.set(s, s * (0.9 + 0.3 * hash2(cell * 3 + k, 83)), s);
              mesh.setMatrixAt(n++, m.compose(p, q, scale));
            }
          }
          mesh.computeBoundingSphere();
          mesh.matrixAutoUpdate = false;
          mesh.castShadow = shadows;
          mesh.receiveShadow = shadows && this.look.rich;
          this.trees.add(mesh);
        }
      }
    }
  }

  /** Bilinear terrain height at world (x, z). */
  heightAt(x: number, z: number): number {
    const gx = Math.min(Math.max(x / CELL, 0), GRID - 0.0001);
    const gz = Math.min(Math.max(z / CELL, 0), GRID - 0.0001);
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const s = this.map.structAt[j * GRID + i];
    if (s >= 0 && this.bridgeUp[s] === 1) {
      const m = this.map;
      const t = Math.min(Math.max((gx - m.sX[s]) / m.sW[s], 0), 1);
      return (m.sBase[s] + (m.sEast[s] - m.sBase[s]) * t) / 1024;
    }
    const fx = gx - i;
    const fz = gz - j;
    const k = j * VERTS + i;
    const h = this.heights;
    const top = h[k] + (h[k + 1] - h[k]) * fx;
    const bottom = h[k + VERTS] + (h[k + VERTS + 1] - h[k + VERTS]) * fx;
    return top + (bottom - top) * fz;
  }

  /** Where a ray hits the ground, or null if it leaves the map. Ray-marches the heightfield. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 | null {
    if (dir.y >= -1e-4) return null;
    const maxT = (origin.y + 40) / -dir.y;
    const stepT = 2;
    let prevT = 0;
    for (let t = 0; t <= maxT; t += stepT) {
      const y = origin.y + dir.y * t;
      if (y <= this.heightAt(origin.x + dir.x * t, origin.z + dir.z * t)) {
        let lo = prevT;
        let hi = t;
        for (let k = 0; k < 12; k++) {
          const m = (lo + hi) / 2;
          const my = origin.y + dir.y * m;
          if (my <= this.heightAt(origin.x + dir.x * m, origin.z + dir.z * m)) hi = m;
          else lo = m;
        }
        out.copy(dir).multiplyScalar(hi).add(origin);
        if (out.x < 0 || out.z < 0 || out.x > MAP_SIZE || out.z > MAP_SIZE) return null;
        return out;
      }
      prevT = t;
    }
    return null;
  }
}

/** One pass of corner cutting over a line of (x, z) pairs: rounds the bends. */
function smoothLine(pts: number[]): number[] {
  if (pts.length < 6) return pts;
  const out = [pts[0], pts[1]];
  for (let k = 0; k + 3 < pts.length; k += 2) {
    out.push(
      pts[k] * 0.75 + pts[k + 2] * 0.25,
      pts[k + 1] * 0.75 + pts[k + 3] * 0.25,
      pts[k] * 0.25 + pts[k + 2] * 0.75,
      pts[k + 1] * 0.25 + pts[k + 3] * 0.75,
    );
  }
  out.push(pts[pts.length - 2], pts[pts.length - 1]);
  return out;
}
