import * as THREE from 'three/webgpu';
import { MAP_SIZE } from '../sim/world';

// Placeholder terrain: rolling hills, visual only. The simulation is flat for now; when
// terrain starts to matter for gameplay (passability, high ground) the heightmap moves into
// the sim as integer data and this module just draws it.

const GRID = 256;
const CELL = MAP_SIZE / GRID;
const VERTS = GRID + 1;

function hash2(x: number, y: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function fbm(x: number, y: number): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  for (let o = 0; o < 4; o++) {
    sum += amp * valueNoise(x * freq, y * freq);
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum;
}

export class Terrain {
  readonly mesh: THREE.Mesh;
  private readonly heights = new Float32Array(VERTS * VERTS);

  constructor() {
    for (let j = 0; j < VERTS; j++) {
      for (let i = 0; i < VERTS; i++) {
        const n = fbm((i * CELL) / 180, (j * CELL) / 180);
        this.heights[j * VERTS + i] = (n - 0.45) * 28;
      }
    }

    const positions = new Float32Array(VERTS * VERTS * 3);
    const colors = new Float32Array(VERTS * VERTS * 3);
    const low = new THREE.Color(0x3d5a36);
    const mid = new THREE.Color(0x6b7f45);
    const high = new THREE.Color(0x9a916c);
    const c = new THREE.Color();
    for (let j = 0; j < VERTS; j++) {
      for (let i = 0; i < VERTS; i++) {
        const k = j * VERTS + i;
        const h = this.heights[k];
        positions[3 * k] = i * CELL;
        positions[3 * k + 1] = h;
        positions[3 * k + 2] = j * CELL;
        const t = THREE.MathUtils.clamp((h + 10) / 22, 0, 1);
        if (t < 0.5) c.copy(low).lerp(mid, t * 2);
        else c.copy(mid).lerp(high, (t - 0.5) * 2);
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
    this.mesh = new THREE.Mesh(geometry, new THREE.MeshLambertNodeMaterial({ vertexColors: true }));
    this.mesh.matrixAutoUpdate = false;
  }

  /** Bilinear terrain height at world (x, z). */
  heightAt(x: number, z: number): number {
    const gx = Math.min(Math.max(x / CELL, 0), GRID - 0.0001);
    const gz = Math.min(Math.max(z / CELL, 0), GRID - 0.0001);
    const i = Math.floor(gx);
    const j = Math.floor(gz);
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
