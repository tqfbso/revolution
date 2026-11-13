// The small things that stand on the land (see land.ts): hedges, bushes, bales, fences,
// poles, lamps, sheds. Instanced, one batch per kind and per 128 m square so that what is
// off screen is culled. Cosmetic only: units walk through them, and they are taken away
// where something is built.
import * as THREE from 'three/webgpu';
import { attribute, hash, instanceIndex } from 'three/tsl';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { MAP_SIZE } from '../sim/map';
import type { Fog } from './fog';
import {
  P_BALE,
  P_BUSH,
  P_FENCE,
  P_HEDGE,
  P_BIN,
  P_CAR,
  P_KINDS,
  P_VAN,
  P_LAMP,
  P_POLE,
  P_ROCK,
  P_SHED,
  P_SHELTER,
  P_STACK,
  P_TUFT,
  type Prop,
} from './land';
import type { Look } from './look';
import type { Terrain } from './terrain';

const CHUNK = 128;
const CHUNKS = Math.ceil(MAP_SIZE / CHUNK);
/** Things too small to see from far off are not drawn from far off. */
const SMALL_WITHIN = 170;

function tint(g: THREE.BufferGeometry, colour: number, shade = 1): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g;
  out.deleteAttribute('uv');
  const c = new THREE.Color(colour).multiplyScalar(shade);
  const n = out.getAttribute('position').count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.toArray(colors, i * 3);
  out.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return out;
}

function box(
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  colour: number,
  rot?: [number, number, number],
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rot) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...rot)));
  g.translate(x, y, z);
  return tint(g, colour);
}

/** A lump of leaves: smooth-shaded, lighter on top. */
function blob(
  rx: number,
  ry: number,
  rz: number,
  x: number,
  y: number,
  z: number,
  colour: number,
): THREE.BufferGeometry {
  const g = mergeVertices(new THREE.IcosahedronGeometry(1, 0));
  g.deleteAttribute('normal');
  g.scale(rx, ry, rz);
  g.translate(x, y, z);
  g.computeVertexNormals();
  return tint(g, colour);
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)));
  for (const p of parts) p.dispose();
  return merged;
}

function shapes(): THREE.BufferGeometry[] {
  const g: THREE.BufferGeometry[] = new Array(P_KINDS);
  g[P_BUSH] = merge([
    blob(0.75, 0.6, 0.7, 0, 0.5, 0, 0x3f5527),
    blob(0.5, 0.45, 0.5, 0.55, 0.4, 0.2, 0x4d652d),
    blob(0.5, 0.5, 0.55, -0.4, 0.55, -0.3, 0x36491f),
  ]);
  g[P_HEDGE] = merge([
    blob(1.0, 0.75, 0.6, -0.7, 0.62, 0, 0x34491f),
    blob(1.0, 0.85, 0.62, 0.65, 0.68, 0.06, 0x3d5325),
    blob(0.6, 0.45, 0.5, 0, 1.05, -0.05, 0x46602a),
  ]);
  const bale = new THREE.CylinderGeometry(0.62, 0.62, 1.25, 10);
  bale.rotateZ(Math.PI / 2);
  bale.translate(0, 0.6, 0);
  g[P_BALE] = merge([tint(bale, 0xb09f62)]);
  const rock = new THREE.IcosahedronGeometry(1, 0);
  rock.scale(1, 0.62, 0.8);
  rock.rotateY(0.6);
  rock.translate(0, 0.22, 0);
  const pebble = new THREE.IcosahedronGeometry(0.45, 0);
  pebble.scale(1, 0.6, 1.2);
  pebble.translate(0.9, 0.1, 0.4);
  g[P_ROCK] = merge([tint(rock, 0x77736a), tint(pebble, 0x6a665e)]);
  const wood = 0x6b604f;
  g[P_FENCE] = merge([
    box(0.1, 1.05, 0.1, -1.45, 0.5, 0, wood),
    box(0.1, 1.05, 0.1, 0, 0.5, 0, wood),
    box(3, 0.09, 0.04, 0, 0.42, 0.04, 0x7a6f5c),
    box(3, 0.09, 0.04, 0, 0.82, 0.04, 0x7a6f5c),
  ]);
  const pole = new THREE.CylinderGeometry(0.07, 0.11, 7, 6);
  pole.translate(0, 3.5, 0);
  g[P_POLE] = merge([
    tint(pole, 0x4b4136),
    box(0.1, 0.1, 1.7, 0, 6.5, 0, 0x4b4136),
    box(0.06, 0.14, 0.06, 0, 6.62, 0.7, 0x8f9a94),
    box(0.06, 0.14, 0.06, 0, 6.62, -0.7, 0x8f9a94),
    box(0.06, 0.14, 0.06, 0, 6.62, 0, 0x8f9a94),
  ]);
  const post = new THREE.CylinderGeometry(0.05, 0.07, 4.6, 6);
  post.translate(0, 2.3, 0);
  g[P_LAMP] = merge([
    tint(post, 0x5a5d5c),
    box(0.06, 0.06, 1.0, 0, 4.58, 0.45, 0x5a5d5c),
    box(0.2, 0.08, 0.42, 0, 4.54, 0.95, 0xbdbba8),
  ]);
  // Grass standing higher than the rest. Its normals point straight up, so that it takes
  // the light as the ground does and reads as part of it, not as a dark thing on it.
  const cone = (x: number, z: number, lean: number, colour: number) => {
    const c = new THREE.ConeGeometry(0.16, 0.5, 4, 1, true);
    c.translate(0, 0.25, 0);
    c.rotateZ(lean);
    c.translate(x, 0, z);
    const t = tint(c, colour);
    const n = t.getAttribute('normal');
    for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
    return t;
  };
  g[P_TUFT] = merge([
    cone(0, 0, 0.12, 0x8d9352),
    cone(0.2, 0.1, -0.3, 0x7c8a47),
    cone(-0.15, 0.2, 0.35, 0x9a965a),
    cone(-0.05, -0.2, -0.1, 0x77853f),
    cone(0.12, -0.14, 0.4, 0x8d9352),
  ]);
  g[P_SHED] = merge([
    box(2.3, 1.7, 1.9, 0, 0.85, 0, 0x64594a),
    box(1.55, 0.07, 2.2, -0.62, 1.95, 0, 0x3a3734, [0, 0, 0.5]),
    box(1.55, 0.07, 2.2, 0.62, 1.95, 0, 0x343230, [0, 0, -0.5]),
    box(0.6, 1.2, 0.05, 0.3, 0.6, 0.96, 0x4a4136),
  ]);
  g[P_SHELTER] = merge([
    box(3.2, 1.9, 0.06, 0, 1.15, -0.6, 0x77878c),
    box(0.06, 1.9, 1.2, -1.6, 1.15, 0, 0x77878c),
    box(0.06, 1.9, 1.2, 1.6, 1.15, 0, 0x77878c),
    box(3.5, 0.09, 1.6, 0, 2.2, 0.05, 0x3d4144),
    box(2.2, 0.08, 0.38, 0, 0.5, -0.3, 0x5d5448),
    box(0.07, 2.6, 0.07, 2.2, 1.3, 0.3, 0x5a5d5c),
    box(0.5, 0.5, 0.05, 2.2, 2.4, 0.3, 0x8a7e3c),
  ]);
  g[P_STACK] = merge([
    box(1.9, 0.9, 0.65, 0, 0.45, 0, 0x6c5339),
    box(1.95, 0.08, 0.75, 0, 0.94, 0, 0x4a4138),
  ]);
  // Parked along the kerb, nose along +x.
  const car = (body: number, glass: number) =>
    merge([
      box(4.2, 0.62, 1.72, 0, 0.62, 0, body),
      box(2.2, 0.56, 1.56, -0.2, 1.2, 0, glass),
      box(2.3, 0.06, 1.6, -0.2, 1.5, 0, body),
      box(0.62, 0.62, 1.8, 1.3, 0.31, 0, 0x1c1c1e),
      box(0.62, 0.62, 1.8, -1.3, 0.31, 0, 0x1c1c1e),
    ]);
  g[P_CAR] = car(0x6d7478, 0x23292e);
  g[P_VAN] = merge([
    box(5.0, 1.55, 1.9, 0, 1.12, 0, 0xa8a69c),
    box(1.2, 0.6, 1.92, 1.75, 1.5, 0, 0x23292e),
    box(0.66, 0.66, 2.0, 1.55, 0.33, 0, 0x1c1c1e),
    box(0.66, 0.66, 2.0, -1.55, 0.33, 0, 0x1c1c1e),
  ]);
  g[P_BIN] = merge([
    box(0.6, 1.0, 0.7, 0, 0.5, 0, 0x33473a),
    box(0.64, 0.08, 0.76, 0, 1.03, 0, 0x26352b),
  ]);
  return g;
}

const SMALL = new Set([P_TUFT, P_ROCK, P_BALE, P_STACK, P_BIN]);
const NO_SHADOW = new Set([P_TUFT]);

interface Batch {
  mesh: THREE.InstancedMesh;
  /** x, z per instance; NaN once taken away. */
  at: Float32Array;
  small: boolean;
}

export class Clutter {
  readonly group = new THREE.Group();
  private readonly batches: Batch[][] = [];
  private smallShown = true;

  constructor(terrain: Terrain, fog: Fog, look: Look) {
    for (let c = 0; c < CHUNKS * CHUNKS; c++) this.batches.push([]);
    const land = terrain.land;
    if (!land) return;
    const geometry = shapes();
    const material = new THREE.MeshLambertNodeMaterial();
    const vary = hash(instanceIndex).mul(0.36).add(0.82);
    material.colorNode = attribute('color', 'vec3').mul(vary).mul(fog.shade());
    // Sort the props by square and kind.
    const lists = new Map<number, Prop[]>();
    for (const p of land.props) {
      if (p.x < 0 || p.z < 0 || p.x >= MAP_SIZE || p.z >= MAP_SIZE) continue;
      const key = (Math.floor(p.z / CHUNK) * CHUNKS + Math.floor(p.x / CHUNK)) * P_KINDS + p.kind;
      const list = lists.get(key);
      if (list) list.push(p);
      else lists.set(key, [p]);
    }
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3();
    for (const [key, list] of lists) {
      const kind = key % P_KINDS;
      const mesh = new THREE.InstancedMesh(geometry[kind], material, list.length);
      const at = new Float32Array(list.length * 2);
      list.forEach((p, n) => {
        pos.set(p.x, terrain.heightAt(p.x, p.z) - 0.04, p.z);
        q.setFromAxisAngle(up, p.rot);
        // Fences stretch along their length only.
        if (kind === P_FENCE) scale.set(p.scale, 1, 1);
        else scale.setScalar(p.scale);
        mesh.setMatrixAt(n, m.compose(pos, q, scale));
        at[2 * n] = p.x;
        at[2 * n + 1] = p.z;
      });
      mesh.computeBoundingSphere();
      mesh.matrixAutoUpdate = false;
      mesh.castShadow = look.shadows && !NO_SHADOW.has(kind);
      mesh.receiveShadow = look.shadows;
      this.group.add(mesh);
      this.batches[Math.floor(key / P_KINDS)].push({ mesh, at, small: SMALL.has(kind) });
    }
  }

  /** Take away whatever stands within the rectangle (world units): something is built there. */
  clear(x0: number, z0: number, x1: number, z1: number): void {
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    const c0 = Math.max(0, Math.floor(x0 / CHUNK));
    const c1 = Math.min(CHUNKS - 1, Math.floor(x1 / CHUNK));
    const r0 = Math.max(0, Math.floor(z0 / CHUNK));
    const r1 = Math.min(CHUNKS - 1, Math.floor(z1 / CHUNK));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        for (const b of this.batches[r * CHUNKS + c]) {
          let changed = false;
          for (let n = 0; n < b.at.length / 2; n++) {
            const x = b.at[2 * n];
            const z = b.at[2 * n + 1];
            if (!(x >= x0 && x <= x1 && z >= z0 && z <= z1)) continue;
            b.mesh.setMatrixAt(n, zero);
            b.at[2 * n] = NaN;
            changed = true;
          }
          if (changed) b.mesh.instanceMatrix.needsUpdate = true;
        }
      }
    }
  }

  /** `distance` is how far the camera is from what it looks at. */
  update(distance: number): void {
    const show = distance < SMALL_WITHIN;
    if (show === this.smallShown) return;
    this.smallShown = show;
    for (const chunk of this.batches) for (const b of chunk) if (b.small) b.mesh.visible = show;
  }
}
