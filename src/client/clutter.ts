// The small things that stand on the land (see land.ts): hedges, bushes, bales, fences,
// poles, lamps, sheds. Instanced, one batch per kind and per square of ground so that what
// is off screen is culled (see BATCH_SQUARE). Cosmetic only: units walk through them, and they are taken away
// where something is built.
import { weathered } from './weather';
import * as THREE from 'three/webgpu';
import { attribute, hash, instanceIndex, smoothstep, uv, vec3 } from 'three/tsl';
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
  P_TREE,
  P_TUFT,
  type Prop,
} from './land';
import type { Look } from './look';
import type { Terrain } from './terrain';

/**
 * A common kind is batched per BATCH_SQUARE m square, so that what is off screen is culled;
 * a kind with fewer than WHOLE_MAP_UNDER props on the map is one batch for the whole map.
 * Every batch is a draw call (two with shadows): 128 m squares made 475 of them for 14,000
 * props, about 30 each. Merging the props into static meshes instead would cut that further
 * but store 1.6 million vertices twice (CPU and GPU) for the same work on the GPU.
 */
const BATCH_SQUARE = 256;
const SQUARES = Math.ceil(MAP_SIZE / BATCH_SQUARE);
const WHOLE_MAP_UNDER = 400;
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
  detail = 0,
): THREE.BufferGeometry {
  const g = mergeVertices(new THREE.IcosahedronGeometry(1, detail));
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
  // A town tree: a clean trunk and a round crown, small enough for a pavement.
  const trunk = new THREE.CylinderGeometry(0.1, 0.15, 1.7, 5);
  trunk.translate(0, 0.85, 0);
  g[P_TREE] = merge([
    tint(trunk, 0x40362a),
    blob(1.25, 1.0, 1.2, 0, 2.5, 0, 0x435628, 1),
    blob(0.9, 0.75, 0.9, 0.6, 3.0, 0.3, 0x516a30),
    blob(0.85, 0.7, 0.9, -0.55, 2.8, -0.4, 0x3a4c24),
    blob(0.75, 0.6, 0.75, 0.05, 3.5, -0.2, 0x5b7335),
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
  /** The ground its props stand on: min x, min z, max x, max z. */
  box: [number, number, number, number];
}

export class Clutter {
  readonly group = new THREE.Group();
  private readonly batches: Batch[] = [];
  private smallShown = true;

  constructor(terrain: Terrain, fog: Fog, look: Look) {
    const land = terrain.land;
    if (!land) return;
    const geometry = shapes();
    const material = new THREE.MeshLambertNodeMaterial();
    const vary = hash(instanceIndex).mul(0.36).add(0.82);
    material.colorNode = weathered(attribute('color', 'vec3').mul(vary)).mul(fog.shade());
    // Sort the props by kind and, for the common kinds, by square.
    const inside = (p: Prop) => p.x >= 0 && p.z >= 0 && p.x < MAP_SIZE && p.z < MAP_SIZE;
    const perKind = new Array<number>(P_KINDS).fill(0);
    for (const p of land.props) if (inside(p)) perKind[p.kind]++;
    const lists = new Map<number, Prop[]>();
    for (const p of land.props) {
      if (!inside(p)) continue;
      const square =
        perKind[p.kind] < WHOLE_MAP_UNDER
          ? 0
          : Math.floor(p.z / BATCH_SQUARE) * SQUARES + Math.floor(p.x / BATCH_SQUARE);
      const key = square * P_KINDS + p.kind;
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
      const box: Batch['box'] = [Infinity, Infinity, -Infinity, -Infinity];
      list.forEach((p, n) => {
        box[0] = Math.min(box[0], p.x);
        box[1] = Math.min(box[1], p.z);
        box[2] = Math.max(box[2], p.x);
        box[3] = Math.max(box[3], p.z);
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
      this.batches.push({ mesh, at, small: SMALL.has(kind), box });
    }
    if (look.night && look.rich) this.lightLamps(land.props, terrain, fog);
  }

  /**
   * Night: two street lamps in three still burn. Each is a pool of light on the pavement
   * and a glow at its head: two flat quads, additive, one instanced mesh for the whole map.
   * No real lights, so a thousand lamps cost what a thousand quads cost.
   */
  private lightLamps(props: Prop[], terrain: Terrain, fog: Fog): void {
    const lamps = props.filter(
      (p, n) =>
        p.kind === P_LAMP && n % 3 !== 0 && p.x > 0 && p.z > 0 && p.x < MAP_SIZE && p.z < MAP_SIZE,
    );
    if (lamps.length === 0) return;
    const quad = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true });
    const d = uv().sub(0.5).length().mul(2);
    // Bright under the lamp, gone by the edge of the quad.
    const fall = smoothstep(1, 0, d).pow(2);
    const flicker = hash(instanceIndex).mul(0.25).add(0.85);
    material.colorNode = vec3(1.0, 0.7, 0.36).mul(fall).mul(flicker).mul(0.42).mul(fog.shade());
    material.opacityNode = fall;
    material.blending = THREE.AdditiveBlending;
    material.depthWrite = false;
    material.fog = false;
    const mesh = new THREE.InstancedMesh(quad, material, lamps.length * 2);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3();
    lamps.forEach((p, n) => {
      // The head hangs a metre out from the post, the way the post is turned.
      const hx = p.x + Math.sin(p.rot) * 0.95 * p.scale;
      const hz = p.z + Math.cos(p.rot) * 0.95 * p.scale;
      const y = terrain.heightAt(p.x, p.z);
      mesh.setMatrixAt(2 * n, m.compose(pos.set(hx, y + 0.12, hz), q, scale.set(13, 1, 13)));
      mesh.setMatrixAt(
        2 * n + 1,
        m.compose(pos.set(hx, y + 4.62 * p.scale, hz), q, scale.set(1.5, 1, 1.5)),
      );
    });
    mesh.computeBoundingSphere();
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 1;
    this.group.add(mesh);
  }

  /** Take away whatever stands within the rectangle (world units): something is built there. */
  clear(x0: number, z0: number, x1: number, z1: number): void {
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (const b of this.batches) {
      if (b.box[0] > x1 || b.box[2] < x0 || b.box[1] > z1 || b.box[3] < z0) continue;
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

  /** `distance` is how far the camera is from what it looks at. */
  /** Switched off by the frame governor when the scene is the limit. */
  small = true;

  update(distance: number): void {
    const show = this.small && distance < SMALL_WITHIN;
    if (show === this.smallShown) return;
    this.smallShown = show;
    for (const b of this.batches) if (b.small) b.mesh.visible = show;
  }
}
