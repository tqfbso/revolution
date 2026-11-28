import * as THREE from 'three/webgpu';

/**
 * One instanced draw call whose contents are rewritten every frame. Per instance: a matrix
 * and a 4-float `aTint` the material reads (team colour + burn for units, colour + alpha
 * for particles).
 */
export class Batch {
  /** Replaced by a larger one when a growing batch fills up: do not keep a reference. */
  mesh: THREE.InstancedMesh;
  m: Float32Array;
  t: Float32Array;
  n = 0;
  private tint: THREE.InstancedBufferAttribute;
  /** Instances there is room for now; grows by doubling up to `capacity`. */
  private size: number;

  /**
   * `start`: room to begin with, if less than `capacity`. A unit batch could be asked for
   * thousands of instances but seldom holds more than a few hundred: 71 of them reserving
   * their worst case cost 40 MB on each of the CPU and the GPU. The mesh is swapped for a
   * larger one in the same parent when it fills.
   */
  constructor(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    readonly capacity: number,
    start = capacity,
  ) {
    this.size = Math.min(start, capacity);
    this.t = new Float32Array(this.size * 4);
    this.tint = new THREE.InstancedBufferAttribute(this.t, 4);
    this.tint.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aTint', this.tint);
    this.mesh = new THREE.InstancedMesh(geometry, material, this.size);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false; // culled per instance on the CPU instead
    this.mesh.matrixAutoUpdate = false;
    this.mesh.count = 0;
    this.m = this.mesh.instanceMatrix.array as Float32Array;
  }

  /** Room for one more instance: false only at full capacity. */
  private room(): boolean {
    if (this.n < this.size) return true;
    if (this.size >= this.capacity) return false;
    const size = Math.min(this.capacity, this.size * 2);
    const old = this.mesh;
    const m = new Float32Array(size * 16);
    m.set(this.m);
    const t = new Float32Array(size * 4);
    t.set(this.t);
    // A new geometry that shares the shape and carries the larger tints: a renderer never
    // sees an attribute of a geometry it has drawn change size.
    const geometry = new THREE.BufferGeometry();
    for (const [name, a] of Object.entries(old.geometry.attributes)) {
      if (name !== 'aTint') geometry.setAttribute(name, a);
    }
    geometry.setIndex(old.geometry.index);
    for (const g of old.geometry.groups) geometry.addGroup(g.start, g.count, g.materialIndex);
    this.tint = new THREE.InstancedBufferAttribute(t, 4);
    this.tint.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aTint', this.tint);
    const mesh = new THREE.InstancedMesh(geometry, old.material, size);
    mesh.instanceMatrix = new THREE.InstancedBufferAttribute(m, 16);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.count = old.count;
    mesh.castShadow = old.castShadow;
    mesh.receiveShadow = old.receiveShadow;
    mesh.visible = old.visible;
    mesh.renderOrder = old.renderOrder;
    const parent = old.parent;
    if (parent) {
      parent.remove(old);
      parent.add(mesh);
    }
    old.dispose();
    this.mesh = mesh;
    this.m = m;
    this.t = t;
    this.size = size;
    return true;
  }

  /** Add an upright instance rotated about Y (sin/cos may carry a uniform scale `s`). */
  put(
    x: number,
    y: number,
    z: number,
    sin: number,
    cos: number,
    s: number,
    r: number,
    g: number,
    b: number,
    a: number,
  ): void {
    if (this.n >= this.size && !this.room()) return;
    const m = this.m;
    const o = this.n * 16;
    m[o] = cos;
    m[o + 1] = 0;
    m[o + 2] = -sin;
    m[o + 3] = 0;
    m[o + 4] = 0;
    m[o + 5] = s;
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
    const t = this.t;
    const q = this.n * 4;
    t[q] = r;
    t[q + 1] = g;
    t[q + 2] = b;
    t[q + 3] = a;
    this.n++;
  }

  /** Add an instance from a full frame: three axes (already scaled) and a position. */
  frame(f: Float32Array, r: number, g: number, b: number, a: number): void {
    if (this.n >= this.size && !this.room()) return;
    const m = this.m;
    const o = this.n * 16;
    m[o] = f[0];
    m[o + 1] = f[1];
    m[o + 2] = f[2];
    m[o + 3] = 0;
    m[o + 4] = f[3];
    m[o + 5] = f[4];
    m[o + 6] = f[5];
    m[o + 7] = 0;
    m[o + 8] = f[6];
    m[o + 9] = f[7];
    m[o + 10] = f[8];
    m[o + 11] = 0;
    m[o + 12] = f[9];
    m[o + 13] = f[10];
    m[o + 14] = f[11];
    m[o + 15] = 1;
    const t = this.t;
    const q = this.n * 4;
    t[q] = r;
    t[q + 1] = g;
    t[q + 2] = b;
    t[q + 3] = a;
    this.n++;
  }

  /** Upload only the live part of the buffers. */
  /** Send what was written to the GPU: all of it, or only the instances from `from` on. */
  flush(from = 0): void {
    this.mesh.count = this.n;
    if (this.n <= from) return;
    upload(this.mesh.instanceMatrix, from * 16, this.n * 16);
    upload(this.tint, from * 4, this.n * 4);
  }
}

function upload(attribute: THREE.InstancedBufferAttribute, start: number, end: number): void {
  attribute.clearUpdateRanges();
  attribute.addUpdateRange(start, end - start);
  attribute.needsUpdate = true;
}
