import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MAX_UNITS, TICK_MS } from '../sim/world';
import {
  INFO_KIND_SHIFT,
  INFO_STATE_MASK,
  INFO_TEAM_SHIFT,
  type Snapshot,
} from '../worker/protocol';
import { STATE_ALIVE, STATE_FREE } from '../sim/world';
import type { Terrain } from './terrain';

const TEAM_COLORS = [
  new THREE.Color(0xc23b2e),
  new THREE.Color(0x2f6fd6),
  new THREE.Color(0xd9a520),
];
const SELECTED_TINT = new THREE.Color(0xffffff);
const TURN_RATE = 7; // rad/s, visual only

/** Placeholder vehicle: hull, turret and barrel merged into one mesh. Forward is +Z. */
function unitGeometry(): THREE.BufferGeometry {
  const hull = new THREE.BoxGeometry(1.3, 0.5, 2.1).translate(0, 0.35, 0);
  const turret = new THREE.BoxGeometry(0.8, 0.35, 0.95).translate(0, 0.77, -0.15);
  const barrel = new THREE.BoxGeometry(0.14, 0.14, 1.2).translate(0, 0.8, 0.9);
  return mergeGeometries([hull, turret, barrel]);
}

/**
 * Draws every unit with one instanced draw call. The sim ticks at 20 Hz; each frame we
 * interpolate between the last two snapshots so motion is smooth at any refresh rate.
 */
export class UnitView {
  readonly mesh: THREE.InstancedMesh;
  readonly rings: THREE.InstancedMesh;
  count = 0;
  /** Interpolated render positions (x, y, z per unit), reused by selection picking. */
  readonly renderPos = new Float32Array(MAX_UNITS * 3);
  readonly selected = new Uint8Array(MAX_UNITS);
  selectedCount = 0;

  private prev = new Float32Array(MAX_UNITS * 2);
  private curr = new Float32Array(MAX_UNITS * 2);
  private heading = new Float32Array(MAX_UNITS);
  private headingGoal = new Float32Array(MAX_UNITS);
  /** Latest per-unit state/kind/team bits from the sim (see INFO_* in the protocol). */
  readonly info = new Uint8Array(MAX_UNITS);
  private snapshotTime = 0;
  private colorsDirty = false;
  private readonly color = new THREE.Color();

  constructor(private readonly terrain: Terrain) {
    const material = new THREE.MeshLambertNodeMaterial();
    this.mesh = new THREE.InstancedMesh(unitGeometry(), material, MAX_UNITS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.setColorAt(0, TEAM_COLORS[0]); // allocates the instance colour buffer

    const ringGeometry = new THREE.RingGeometry(1.35, 1.6, 20).rotateX(-Math.PI / 2);
    const ringMaterial = new THREE.MeshBasicNodeMaterial({ color: 0x7dff8a, transparent: true });
    ringMaterial.opacity = 0.9;
    ringMaterial.depthWrite = false;
    this.rings = new THREE.InstancedMesh(ringGeometry, ringMaterial, MAX_UNITS);
    this.rings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.rings.frustumCulled = false;
    this.rings.count = 0;
  }

  applySnapshot(s: Snapshot, now: number): void {
    const n = s.count;
    const fresh = this.count; // units at index >= fresh are new this snapshot
    const swap = this.prev;
    this.prev = this.curr;
    this.curr = swap;
    this.curr.set(s.positions);
    if (n < fresh) {
      // World was reset.
      this.selected.fill(0);
      this.selectedCount = 0;
      this.prev.set(s.positions);
    }
    for (let i = 0; i < n; i++) {
      const alive = (s.info[i] & INFO_STATE_MASK) === STATE_ALIVE;
      const wasAlive = i < fresh && (this.info[i] & INFO_STATE_MASK) === STATE_ALIVE;
      if (alive && !wasAlive) {
        // New unit (or a reused slot): do not interpolate from wherever the slot was before.
        this.prev[2 * i] = this.curr[2 * i];
        this.prev[2 * i + 1] = this.curr[2 * i + 1];
        this.heading[i] = this.headingGoal[i] = (i * 2.399963) % (Math.PI * 2);
      } else if (!alive && this.selected[i]) {
        this.selected[i] = 0;
        this.selectedCount--;
      }
    }
    for (let i = 0; i < n; i++) {
      const dx = this.curr[2 * i] - this.prev[2 * i];
      const dz = this.curr[2 * i + 1] - this.prev[2 * i + 1];
      // Only turn when really moving, so separation nudges do not make idle units twitch.
      if (dx * dx + dz * dz > 0.01) this.headingGoal[i] = Math.atan2(dx, dz);
    }
    this.info.set(s.info);
    this.colorsDirty = true;
    this.count = n;
    this.snapshotTime = now;
  }

  setSelected(ids: Iterable<number>, additive: boolean): void {
    if (!additive) this.selected.fill(0);
    for (const id of ids) if (this.isAlive(id)) this.selected[id] = 1;
    let c = 0;
    for (let i = 0; i < this.count; i++) c += this.selected[i];
    this.selectedCount = c;
    this.colorsDirty = true;
  }

  isAlive(id: number): boolean {
    return id < this.count && (this.info[id] & INFO_STATE_MASK) === STATE_ALIVE;
  }

  selectedIds(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.count; i++) if (this.selected[i]) out.push(i);
    return out;
  }

  update(now: number, dt: number): void {
    const n = this.count;
    const alpha = Math.min(Math.max((now - this.snapshotTime) / TICK_MS, 0), 1);
    const m = this.mesh.instanceMatrix.array as Float32Array;
    const r = this.rings.instanceMatrix.array as Float32Array;
    const pos = this.renderPos;
    const maxTurn = TURN_RATE * dt;
    let ringCount = 0;
    for (let i = 0; i < n; i++) {
      const x = this.prev[2 * i] + (this.curr[2 * i] - this.prev[2 * i]) * alpha;
      const z = this.prev[2 * i + 1] + (this.curr[2 * i + 1] - this.prev[2 * i + 1]) * alpha;
      const y = this.terrain.heightAt(x, z);
      pos[3 * i] = x;
      pos[3 * i + 1] = y;
      pos[3 * i + 2] = z;

      // Turn toward the travel direction along the shortest arc.
      let d = this.headingGoal[i] - this.heading[i];
      if (d > Math.PI) d -= Math.PI * 2;
      else if (d < -Math.PI) d += Math.PI * 2;
      const h = this.heading[i] + (d > maxTurn ? maxTurn : d < -maxTurn ? -maxTurn : d);
      this.heading[i] = h > Math.PI ? h - Math.PI * 2 : h < -Math.PI ? h + Math.PI * 2 : h;
      // Placeholder until the real models land: infantry squads are small, free slots hidden.
      const state = this.info[i] & INFO_STATE_MASK;
      const scale = state === STATE_FREE ? 0 : (this.info[i] >> INFO_KIND_SHIFT) & 3 ? 0.55 : 1;
      const sin = Math.sin(h) * scale;
      const cos = Math.cos(h) * scale;

      const o = i * 16;
      m[o] = cos;
      m[o + 1] = 0;
      m[o + 2] = -sin;
      m[o + 3] = 0;
      m[o + 4] = 0;
      m[o + 5] = scale;
      m[o + 6] = 0;
      m[o + 7] = 0;
      m[o + 8] = sin;
      m[o + 9] = 0;
      m[o + 10] = cos;
      m[o + 11] = 0;
      m[o + 12] = x;
      m[o + 13] = y;
      m[o + 14] = z;
      m[o + 15] = 1;

      if (this.selected[i]) {
        const q = ringCount++ * 16;
        r[q] = 1;
        r[q + 1] = 0;
        r[q + 2] = 0;
        r[q + 3] = 0;
        r[q + 4] = 0;
        r[q + 5] = 1;
        r[q + 6] = 0;
        r[q + 7] = 0;
        r[q + 8] = 0;
        r[q + 9] = 0;
        r[q + 10] = 1;
        r[q + 11] = 0;
        r[q + 12] = x;
        r[q + 13] = y + 0.12;
        r[q + 14] = z;
        r[q + 15] = 1;
      }
    }
    this.mesh.count = n;
    uploadRange(this.mesh.instanceMatrix, n * 16);
    this.rings.count = ringCount;
    uploadRange(this.rings.instanceMatrix, ringCount * 16);

    if (this.colorsDirty && this.mesh.instanceColor) {
      for (let i = 0; i < n; i++) {
        this.color.copy(TEAM_COLORS[this.info[i] >> INFO_TEAM_SHIFT] ?? TEAM_COLORS[0]);
        if ((this.info[i] & INFO_STATE_MASK) !== STATE_ALIVE) this.color.multiplyScalar(0.12);
        else if (this.selected[i]) this.color.lerp(SELECTED_TINT, 0.3);
        this.mesh.setColorAt(i, this.color);
      }
      uploadRange(this.mesh.instanceColor, n * 3);
      this.colorsDirty = false;
    }
  }
}

/** Upload only the live part of a big preallocated instance buffer. */
function uploadRange(attribute: THREE.InstancedBufferAttribute, length: number): void {
  if (length === 0) return;
  attribute.clearUpdateRanges();
  attribute.addUpdateRange(0, length);
  attribute.needsUpdate = true;
}
