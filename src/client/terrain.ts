import * as THREE from 'three/webgpu';
import { attribute, color } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { fromFx } from '../sim/fixed';
import {
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

// Draws the sim's map (src/sim/map.ts): the ground mesh coloured by terrain type, a water
// surface, and instanced trees on forest cells. Heights are the sim's integers as floats.

const GRID = MAP_CELLS;
const CELL = MAP_SIZE / GRID;
const VERTS = GRID + 1;
const TREE_CHUNK = 32; // cells per side of one tree batch, so off-screen forest is culled
const TREES_PER_CELL = 2;

function hash2(x: number, y: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** A conifer about 4 units tall: trunk and two tiers, a couple of dozen triangles. */
function treeGeometry(): THREE.BufferGeometry {
  const part = (g: THREE.BufferGeometry, y: number, color: number) => {
    g.translate(0, y, 0);
    g.deleteAttribute('uv');
    const c = new THREE.Color(color);
    const n = g.getAttribute('position').count;
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) c.toArray(colors, i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return g;
  };
  return mergeGeometries([
    part(new THREE.CylinderGeometry(0.1, 0.16, 1.2, 5, 1, true), 0.6, 0x4a3d2e),
    part(new THREE.ConeGeometry(1.0, 2.2, 6, 1, true), 2.0, 0x35462a),
    part(new THREE.ConeGeometry(0.68, 1.8, 6, 1, true), 3.2, 0x42553a),
  ]);
}

export class Terrain {
  readonly mesh: THREE.Mesh;
  readonly water: THREE.Mesh;
  readonly trees = new THREE.Group();
  private readonly heights = new Float32Array(VERTS * VERTS);
  /** Per structure: 1 while it is a standing bridge, whose deck units then stand on. */
  readonly bridgeUp = new Uint8Array(MAX_STRUCTS);

  constructor(
    readonly map: GameMap,
    private readonly fog: Fog,
    shadows: boolean,
  ) {
    for (let k = 0; k < VERTS * VERTS; k++) this.heights[k] = fromFx(map.heights[k]);

    const positions = new Float32Array(VERTS * VERTS * 3);
    const colors = new Float32Array(VERTS * VERTS * 3);
    const low = new THREE.Color(0x47583a);
    const mid = new THREE.Color(0x6a7446);
    const high = new THREE.Color(0x8a8660);
    const rock = new THREE.Color(0x6b665d);
    const mud = new THREE.Color(0x6f6650);
    const bed = new THREE.Color(0x3d3f33);
    const yard = new THREE.Color(0x67604f);
    const street = new THREE.Color(0x56544e);
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
    const floor = new THREE.Color(0x36422b);
    const c = new THREE.Color();
    const typeAt = (i: number, j: number) =>
      i < 0 || j < 0 || i >= GRID || j >= GRID ? T_OPEN : map.type[j * GRID + i];
    for (let j = 0; j < VERTS; j++) {
      for (let i = 0; i < VERTS; i++) {
        const k = j * VERTS + i;
        const h = this.heights[k];
        positions[3 * k] = i * CELL;
        positions[3 * k + 1] = h;
        positions[3 * k + 2] = j * CELL;
        // A vertex takes its colour from the four cells that share it.
        let cliff = 0;
        let forest = 0;
        let water = 0;
        for (let q = 0; q < 4; q++) {
          const t = typeAt(i - (q & 1), j - (q >> 1));
          if (t === T_CLIFF) cliff++;
          else if (t === T_FOREST) forest++;
          else if (t === T_WATER) water++;
        }
        const t = THREE.MathUtils.clamp((h + 2) / 14, 0, 1);
        if (t < 0.5) c.copy(low).lerp(mid, t * 2);
        else c.copy(mid).lerp(high, (t - 0.5) * 2);
        if (forest > 0) c.lerp(floor, forest / 4);
        const town = h > 0.2 ? built(i, j) : 0;
        if (town === 2) c.lerp(street, 0.85);
        else if (town === 1) c.lerp(yard, 0.6);
        if (h < 0.5) c.lerp(mud, THREE.MathUtils.clamp((0.5 - h) / 0.8, 0, 1));
        if (water > 0) c.lerp(bed, water / 4);
        if (cliff > 0) c.lerp(rock, Math.min(1, cliff / 2));
        // Fine-grained mottling so the ground does not look like a smooth gradient.
        const speckle = 0.92 + 0.16 * hash2(i * 7 + 3, j * 13 + 5);
        colors[3 * k] = c.r * speckle;
        colors[3 * k + 1] = c.g * speckle;
        colors[3 * k + 2] = c.b * speckle;
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
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    // Everything in the world is darkened by the fog of war texture.
    const ground = new THREE.MeshLambertNodeMaterial();
    ground.colorNode = attribute('color', 'vec3').mul(fog.shade());
    this.mesh = new THREE.Mesh(geometry, ground);
    this.mesh.matrixAutoUpdate = false;
    this.mesh.receiveShadow = shadows;

    const waterMaterial = new THREE.MeshStandardNodeMaterial({
      roughness: 0.18,
      metalness: 0,
      transparent: true,
      opacity: 0.8,
    });
    waterMaterial.colorNode = color(0x2c4347).mul(fog.shade());
    this.water = new THREE.Mesh(
      new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE).rotateX(-Math.PI / 2),
      waterMaterial,
    );
    this.water.position.set(MAP_SIZE / 2, fromFx(WATER_LEVEL), MAP_SIZE / 2);
    this.water.receiveShadow = shadows;

    this.buildTrees(shadows);
  }

  private buildTrees(shadows: boolean): void {
    const geometry = treeGeometry();
    const material = new THREE.MeshLambertNodeMaterial();
    material.colorNode = attribute('color', 'vec3').mul(this.fog.shade());
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const p = new THREE.Vector3();
    const scale = new THREE.Vector3();
    for (let cj = 0; cj < GRID; cj += TREE_CHUNK) {
      for (let ci = 0; ci < GRID; ci += TREE_CHUNK) {
        const cells: number[] = [];
        for (let j = cj; j < cj + TREE_CHUNK; j++) {
          for (let i = ci; i < ci + TREE_CHUNK; i++) {
            if (this.map.type[j * GRID + i] === T_FOREST) cells.push(j * GRID + i);
          }
        }
        if (cells.length === 0) continue;
        const mesh = new THREE.InstancedMesh(geometry, material, cells.length * TREES_PER_CELL);
        let n = 0;
        for (const cell of cells) {
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
        this.trees.add(mesh);
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
