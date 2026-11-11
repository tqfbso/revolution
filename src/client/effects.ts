// Battle effects: muzzle flashes, tracers, explosions, smoke. Presentation only: driven by
// the sim's combat events, simulated on the client with ordinary floats and Math.random.
import * as THREE from 'three/webgpu';
import { attribute, smoothstep, uv } from 'three/tsl';
import { Batch } from './batch';

const MAX_PARTICLES = 6000;
const MAX_TRACERS = 3000;
const FIELDS = 14; // x y z vx vy vz age life size0 size1 r g b alpha
const ADDITIVE = 0;
const SMOKE = 1;

function spriteMaterial(additive: boolean): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true });
  const tint = attribute('aTint', 'vec4');
  m.colorNode = tint.xyz;
  // Soft round sprite without a texture.
  m.opacityNode = tint.w.mul(smoothstep(0.08, 0.5, uv().sub(0.5).length()).oneMinus());
  m.depthWrite = false;
  m.fog = false;
  if (additive) m.blending = THREE.AdditiveBlending;
  return m;
}

export class Effects {
  readonly group = new THREE.Group();
  /** Live particle count, for the overlay. */
  count = 0;
  private readonly p = [
    new Float32Array(MAX_PARTICLES * FIELDS),
    new Float32Array(MAX_PARTICLES * FIELDS),
  ];
  private readonly n = [0, 0];
  private readonly sprites: Batch[];
  // Tracers: from xyz, to xyz, age, life, width, brightness
  private readonly tr = new Float32Array(MAX_TRACERS * 10);
  private trN = 0;
  private readonly tracers: Batch;

  constructor() {
    const quad = () => new THREE.PlaneGeometry(1, 1);
    this.sprites = [
      new Batch(quad(), spriteMaterial(true), MAX_PARTICLES),
      new Batch(quad(), spriteMaterial(false), MAX_PARTICLES),
    ];
    // A tracer is two crossed quads along +Z, one unit long, stretched per instance.
    const a = new THREE.PlaneGeometry(1, 1).rotateX(Math.PI / 2).translate(0, 0, 0.5);
    const b = a.clone().rotateZ(Math.PI / 2);
    const cross = new THREE.BufferGeometry();
    cross.setAttribute('position', merged(a, b, 'position'));
    cross.setAttribute('uv', merged(a, b, 'uv'));
    cross.setIndex([0, 2, 1, 2, 3, 1, 4, 6, 5, 6, 7, 5]);
    const tm = new THREE.MeshBasicNodeMaterial({ transparent: true, side: THREE.DoubleSide });
    const tint = attribute('aTint', 'vec4');
    tm.colorNode = tint.xyz;
    tm.opacityNode = tint.w.mul(smoothstep(0.1, 0.5, uv().x.sub(0.5).abs()).oneMinus());
    tm.depthWrite = false;
    tm.fog = false;
    tm.blending = THREE.AdditiveBlending;
    this.tracers = new Batch(cross, tm, MAX_TRACERS);
    this.sprites[SMOKE].mesh.renderOrder = 1;
    this.sprites[ADDITIVE].mesh.renderOrder = 2;
    this.tracers.mesh.renderOrder = 2;
    this.group.add(this.sprites[SMOKE].mesh, this.sprites[ADDITIVE].mesh, this.tracers.mesh);
  }

  private emit(
    kind: number,
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    life: number,
    size0: number,
    size1: number,
    r: number,
    g: number,
    b: number,
    alpha: number,
  ): void {
    if (this.n[kind] >= MAX_PARTICLES) return;
    const p = this.p[kind];
    const o = this.n[kind]++ * FIELDS;
    p[o] = x;
    p[o + 1] = y;
    p[o + 2] = z;
    p[o + 3] = vx;
    p[o + 4] = vy;
    p[o + 5] = vz;
    p[o + 6] = 0;
    p[o + 7] = life;
    p[o + 8] = size0;
    p[o + 9] = size1;
    p[o + 10] = r;
    p[o + 11] = g;
    p[o + 12] = b;
    p[o + 13] = alpha;
  }

  private tracer(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    life: number,
    width: number,
    bright: number,
  ): void {
    if (this.trN >= MAX_TRACERS) return;
    this.tr.set([x0, y0, z0, x1, y1, z1, 0, life, width, bright], this.trN++ * 10);
  }

  /** Tank main gun: flash and smoke at the muzzle, a fast shell trace, a burst at the target. */
  cannonShot(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const d = Math.hypot(dx, dz) || 1;
    const ux = dx / d;
    const uz = dz / d;
    this.emit(
      ADDITIVE,
      x0 + ux * 0.3,
      y0,
      z0 + uz * 0.3,
      ux * 4,
      0,
      uz * 4,
      0.09,
      1.6,
      2.6,
      1,
      0.78,
      0.4,
      1,
    );
    for (let k = 0; k < 3; k++) {
      const v = 2 + k * 2.5;
      this.emit(
        SMOKE,
        x0,
        y0,
        z0,
        ux * v + rnd(0.6),
        0.5 + rnd(0.3),
        uz * v + rnd(0.6),
        1.3 + k * 0.3,
        0.7,
        2.6,
        0.62,
        0.6,
        0.56,
        0.3,
      );
    }
    // Dust kicked up under the muzzle.
    this.emit(
      SMOKE,
      x0 - ux,
      y0 - 0.6,
      z0 - uz,
      rnd(1),
      0.4,
      rnd(1),
      1.6,
      1.5,
      4.5,
      0.55,
      0.5,
      0.4,
      0.2,
    );
    this.tracer(x0, y0, z0, x1, y1, z1, Math.min(0.14, d / 200), 0.16, 1);
    this.emit(ADDITIVE, x1, y1, z1, 0, 0, 0, 0.1, 1.2, 2.4, 1, 0.7, 0.35, 1);
    for (let k = 0; k < 4; k++) {
      this.emit(
        ADDITIVE,
        x1,
        y1,
        z1,
        rnd(9),
        2 + Math.random() * 6,
        rnd(9),
        0.25 + Math.random() * 0.2,
        0.18,
        0.05,
        1,
        0.75,
        0.4,
        1,
      );
    }
    this.emit(SMOKE, x1, y1, z1, rnd(1), 1.5, rnd(1), 1.4, 0.9, 3.2, 0.3, 0.29, 0.27, 0.4);
  }

  /** Squad fire: a few rifle tracers with spread and small flashes. */
  rifleBurst(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    const d = Math.hypot(x1 - x0, z1 - z0) || 1;
    for (let k = 0; k < 2; k++) {
      const sx = x0 + rnd(0.8);
      const sz = z0 + rnd(0.8);
      this.emit(ADDITIVE, sx, y0, sz, 0, 0, 0, 0.05, 0.35, 0.5, 1, 0.8, 0.45, 0.9);
      this.tracer(
        sx,
        y0,
        sz,
        x1 + rnd(1.2),
        y1 + rnd(0.4),
        z1 + rnd(1.2),
        Math.min(0.12, d / 160) + k * 0.03,
        0.05,
        0.75,
      );
    }
    if (Math.random() < 0.3) {
      this.emit(
        SMOKE,
        x1 + rnd(0.8),
        y1 - 0.2,
        z1 + rnd(0.8),
        rnd(0.5),
        0.8,
        rnd(0.5),
        0.7,
        0.3,
        1.1,
        0.5,
        0.46,
        0.38,
        0.25,
      );
    }
  }

  /** A vehicle brewing up: fireball, sparks, a column of black smoke. */
  explosion(x: number, y: number, z: number): void {
    this.emit(ADDITIVE, x, y + 0.8, z, 0, 0, 0, 0.16, 3, 7.5, 1, 0.82, 0.5, 1);
    for (let k = 0; k < 7; k++) {
      this.emit(
        ADDITIVE,
        x + rnd(0.6),
        y + 0.8,
        z + rnd(0.6),
        rnd(3),
        2 + Math.random() * 4,
        rnd(3),
        0.5 + Math.random() * 0.5,
        1.4,
        3.4,
        1,
        0.42,
        0.1,
        0.9,
      );
    }
    for (let k = 0; k < 10; k++) {
      this.emit(
        ADDITIVE,
        x,
        y + 1,
        z,
        rnd(16),
        4 + Math.random() * 11,
        rnd(16),
        0.5 + Math.random() * 0.5,
        0.2,
        0.04,
        1,
        0.7,
        0.35,
        1,
      );
    }
    for (let k = 0; k < 8; k++) {
      this.emit(
        SMOKE,
        x + rnd(1),
        y + 1,
        z + rnd(1),
        rnd(1.6),
        2 + Math.random() * 3,
        rnd(1.6),
        2.4 + Math.random() * 2,
        1.6,
        6.5,
        0.1,
        0.1,
        0.1,
        0.6,
      );
    }
    this.emit(SMOKE, x, y + 0.3, z, 0, 0.3, 0, 2.2, 3, 11, 0.5, 0.46, 0.38, 0.22); // dust ring
  }

  /** A squad going down: dust and a little smoke, nothing theatrical. */
  squadHit(x: number, y: number, z: number): void {
    for (let k = 0; k < 3; k++) {
      this.emit(
        SMOKE,
        x + rnd(0.8),
        y + 0.3,
        z + rnd(0.8),
        rnd(0.8),
        0.7 + Math.random(),
        rnd(0.8),
        1.6,
        0.8,
        2.8,
        0.45,
        0.41,
        0.34,
        0.32,
      );
    }
  }

  /** One puff of the oily smoke a burning wreck gives off; `heat` 1 = fresh fire. */
  wreckSmoke(x: number, y: number, z: number, heat: number): void {
    this.emit(
      SMOKE,
      x + rnd(0.3),
      y + 0.9,
      z + rnd(0.3),
      0.7 + rnd(0.3),
      2 + Math.random(),
      0.3 + rnd(0.3),
      3.2 + Math.random() * 1.5,
      0.9,
      4.2 + heat * 1.5,
      0.08,
      0.08,
      0.085,
      0.3 + heat * 0.25,
    );
    if (Math.random() < heat * 0.7) {
      this.emit(
        ADDITIVE,
        x + rnd(0.4),
        y + 0.8,
        z + rnd(0.4),
        rnd(0.4),
        1.3,
        rnd(0.4),
        0.4,
        0.9,
        0.3,
        1,
        0.45,
        0.1,
        0.7,
      );
    }
  }

  update(dt: number, camera: THREE.Camera): void {
    // Billboard basis from the camera.
    const e = camera.matrixWorld.elements;
    const rx = e[0],
      ry = e[1],
      rz = e[2];
    const ux = e[4],
      uy = e[5],
      uz = e[6];
    for (let kind = 0; kind < 2; kind++) {
      const p = this.p[kind];
      const batch = this.sprites[kind];
      const m = batch.m;
      const t = batch.t;
      const drag = kind === SMOKE ? Math.exp(-1.6 * dt) : Math.exp(-2.5 * dt);
      const gravity = kind === SMOKE ? 0 : -14;
      let n = this.n[kind];
      for (let i = 0; i < n;) {
        const o = i * FIELDS;
        const age = (p[o + 6] += dt);
        const life = p[o + 7];
        if (age >= life) {
          n--;
          p.copyWithin(o, n * FIELDS, (n + 1) * FIELDS);
          continue;
        }
        const size0 = p[o + 8];
        // Sparks (small, shrinking) fall; fireballs and smoke do not.
        const g = size0 < 0.3 ? gravity : 0;
        p[o + 3] *= drag;
        p[o + 4] = p[o + 4] * drag + g * dt;
        p[o + 5] *= drag;
        const x = (p[o] += p[o + 3] * dt);
        const y = (p[o + 1] += p[o + 4] * dt);
        const z = (p[o + 2] += p[o + 5] * dt);
        const k = age / life;
        const s = size0 + (p[o + 9] - size0) * (1 - (1 - k) * (1 - k));
        const q = i * 16;
        m[q] = rx * s;
        m[q + 1] = ry * s;
        m[q + 2] = rz * s;
        m[q + 3] = 0;
        m[q + 4] = ux * s;
        m[q + 5] = uy * s;
        m[q + 6] = uz * s;
        m[q + 7] = 0;
        m[q + 8] = 0;
        m[q + 9] = 0;
        m[q + 10] = 1;
        m[q + 11] = 0;
        m[q + 12] = x;
        m[q + 13] = y;
        m[q + 14] = z;
        m[q + 15] = 1;
        const c = i * 4;
        t[c] = p[o + 10];
        t[c + 1] = p[o + 11];
        t[c + 2] = p[o + 12];
        // Smoke fades in fast and out slowly; fire just fades out.
        t[c + 3] = p[o + 13] * (kind === SMOKE ? Math.min(1, k * 8) * (1 - k) : 1 - k * k);
        i++;
      }
      this.n[kind] = n;
      batch.n = n;
      batch.flush();
    }
    this.count = this.n[0] + this.n[1];

    const tr = this.tr;
    const tb = this.tracers;
    let n = this.trN;
    for (let i = 0; i < n;) {
      const o = i * 10;
      const age = (tr[o + 6] += dt);
      const life = tr[o + 7];
      if (age >= life) {
        n--;
        tr.copyWithin(o, n * 10, (n + 1) * 10);
        continue;
      }
      const dx = tr[o + 3] - tr[o];
      const dy = tr[o + 4] - tr[o + 1];
      const dz = tr[o + 5] - tr[o + 2];
      const d = Math.hypot(dx, dy, dz) || 1;
      const fx = dx / d,
        fy = dy / d,
        fz = dz / d;
      // Right = up x forward (forward is never vertical), up' = forward x right.
      const h = Math.hypot(fx, fz) || 1;
      const ax = fz / h,
        az = -fx / h;
      const bx = fy * az,
        by = fz * ax - fx * az,
        bz = -fy * ax;
      const k = age / life;
      const len = Math.min(d * 0.35, 9);
      const head = k * d;
      const tail = Math.max(0, head - len);
      const w = tr[o + 8];
      const q = i * 16;
      const m = tb.m;
      m[q] = ax * w;
      m[q + 1] = 0;
      m[q + 2] = az * w;
      m[q + 3] = 0;
      m[q + 4] = bx * w;
      m[q + 5] = by * w;
      m[q + 6] = bz * w;
      m[q + 7] = 0;
      m[q + 8] = fx * (head - tail);
      m[q + 9] = fy * (head - tail);
      m[q + 10] = fz * (head - tail);
      m[q + 11] = 0;
      m[q + 12] = tr[o] + fx * tail;
      m[q + 13] = tr[o + 1] + fy * tail;
      m[q + 14] = tr[o + 2] + fz * tail;
      m[q + 15] = 1;
      const c = i * 4;
      tb.t[c] = 1;
      tb.t[c + 1] = 0.82;
      tb.t[c + 2] = 0.5;
      tb.t[c + 3] = tr[o + 9];
      i++;
    }
    this.trN = n;
    tb.n = n;
    tb.flush();
  }
}

function rnd(spread: number): number {
  return (Math.random() - 0.5) * 2 * spread;
}

function merged(a: THREE.BufferGeometry, b: THREE.BufferGeometry, name: string) {
  const x = a.getAttribute(name);
  const y = b.getAttribute(name);
  const out = new Float32Array(x.array.length + y.array.length);
  out.set(x.array);
  out.set(y.array, x.array.length);
  return new THREE.BufferAttribute(out, x.itemSize);
}
