import * as THREE from 'three/webgpu';

/**
 * One instanced draw call whose contents are rewritten every frame. Per instance: a matrix
 * and a 4-float `aTint` the material reads (team colour + burn for units, colour + alpha
 * for particles).
 */
export class Batch {
  readonly mesh: THREE.InstancedMesh;
  readonly m: Float32Array;
  readonly t: Float32Array;
  n = 0;
  private readonly tint: THREE.InstancedBufferAttribute;

  constructor(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    readonly capacity: number,
  ) {
    this.t = new Float32Array(capacity * 4);
    this.tint = new THREE.InstancedBufferAttribute(this.t, 4);
    this.tint.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aTint', this.tint);
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false; // culled per instance on the CPU instead
    this.mesh.matrixAutoUpdate = false;
    this.mesh.count = 0;
    this.m = this.mesh.instanceMatrix.array as Float32Array;
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
    if (this.n >= this.capacity) return;
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

  /** Upload only the live part of the buffers. */
  flush(): void {
    this.mesh.count = this.n;
    if (this.n === 0) return;
    upload(this.mesh.instanceMatrix, this.n * 16);
    upload(this.tint, this.n * 4);
  }
}

function upload(attribute: THREE.InstancedBufferAttribute, length: number): void {
  attribute.clearUpdateRanges();
  attribute.addUpdateRange(0, length);
  attribute.needsUpdate = true;
}
