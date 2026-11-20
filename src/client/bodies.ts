// The dead (roadmap I1, decision 136). Presentation only: the sim knows a squad as one unit
// whose health falls; the client draws its men dropping out one by one, and each man who
// drops leaves a body that lies where he fell for the rest of the game.
//
// A body is one instance of a pose baked whole (Soldiers.deadPoses): eight ways to lie,
// each turned its own way, so a street fought over all game does not fill with copies.
// Bodies are kept in squares of ground, and the instance lists are only rewritten when the
// camera moves, a body is added, or one is in the air: a field of the dead seen from a
// still camera costs the GPU and nothing else. A man killed by a shell, a missile or a
// tank round is thrown before he lands; a man shot falls where he stood.
import * as THREE from 'three/webgpu';
import { MAP_SIZE } from '../sim/map';
import type { Batch } from './batch';
import type { Effects } from './effects';
import type { Fog } from './fog';
import { DEAD_POSES } from './soldiers';
import type { Terrain } from './terrain';

/** Squares of ground the bodies are kept in, for culling. */
const TILE = 64;
const TILES = MAP_SIZE / TILE;
/** Floats per body: x, y, z, sin, cos, pose, team, paint, seen. */
const STRIDE = 9;
/** Bodies a square keeps; past that the oldest there gives way to the newest. */
const TILE_CAP = 4096;
/** Beyond this the dead are not drawn at all: a body there is under a pixel. */
const FAR_DRAW = 640;
/** Bodies drawn whole and close up at most; the rest of a crowd uses the middle figure. */
const NEAR_CAP = 700;
/** World units a second squared (a unit is a few metres: men fly about two of them). */
const GRAVITY = 9;
/** How long a man shot takes to go down, in seconds. */
const TOPPLE = 0.42;
/** Poses for a man thrown by a blast: on his back or sprawled, the ones a blast leaves. */
const THROWN = [6, 4, 0, 1, 3, 6];

interface Flight {
  x: number;
  z: number;
  vx: number;
  vz: number;
  vy: number;
  t: number;
  /** Seconds in the air. */
  T: number;
  pose: number;
  sin: number;
  cos: number;
  /** How far the body turns over in the air, radians, ending flat in its pose. */
  spin: number;
  team: number;
  paint: number;
  seen: number;
}

export class Bodies {
  /** Bodies lying, and bodies in the air. */
  count = 0;
  flying = 0;
  /** Drawn last frame at each level. */
  readonly drawn = [0, 0, 0];
  private readonly tiles: Float32Array[] = [];
  private readonly used = new Int32Array(TILES * TILES);
  /** Where the next body goes in a full square: the oldest. */
  private readonly next = new Int32Array(TILES * TILES);
  private readonly flights: Flight[] = [];
  private dirty = true;
  private unseen = 0;
  private lastBuild = -1e9;
  private readonly camPos = new THREE.Vector3(1e9, 0, 0);
  private readonly camDir = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly f = new Float32Array(12);
  private readonly frustum = new THREE.Frustum();
  private readonly proj = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere();

  constructor(
    private readonly near: Batch[],
    private readonly mid: Batch[],
    private readonly far: Batch,
    private readonly terrain: Terrain,
    private readonly fog: Fog,
    private readonly effects: Effects,
    private readonly colours: readonly (readonly number[])[],
  ) {
    for (let k = 0; k < TILES * TILES; k++) this.tiles.push(new Float32Array(0));
  }

  /**
   * Another army's dead: its own eight poses at the near and the middle level, in its own
   * kit. Returns the `set` to pass to `add` for a man of that army.
   */
  addSet(near: Batch[], mid: Batch[]): number {
    const set = this.near.length / DEAD_POSES;
    this.near.push(...near);
    this.mid.push(...mid);
    return set;
  }

  /**
   * A man goes down at (x, z). With `power` 0 he falls where he stands; above 0 a blast
   * throws him along (dx, dz), harder the nearer it was. `seen` 0 keeps him hidden until
   * the player's troops see the spot (the enemy's dead in the fog).
   */
  add(
    x: number,
    z: number,
    heading: number,
    team: number,
    paint: number,
    dx: number,
    dz: number,
    power: number,
    seen: boolean,
    set = 0,
  ): void {
    const rnd = Math.random();
    const first = set * DEAD_POSES;
    if (power > 0) {
      const len = Math.hypot(dx, dz) || 1;
      const ux = dx / len;
      const uz = dz / len;
      const speed = 0.9 + power * (1.6 + rnd * 1.6);
      const vy = 1.8 + power * (1.6 + Math.random() * 1.4);
      const h = Math.atan2(ux, uz) + (Math.random() - 0.5) * 0.5;
      this.flights.push({
        x,
        z,
        vx: ux * speed,
        vz: uz * speed,
        vy,
        t: 0,
        T: (2 * vy) / GRAVITY,
        pose: first + THROWN[(rnd * THROWN.length) | 0],
        sin: Math.sin(h),
        cos: Math.cos(h),
        spin: (Math.random() < 0.5 ? -1 : 1) * (Math.PI * (1 + power * 0.9 + Math.random() * 0.6)),
        team,
        paint,
        seen: seen ? 1 : 0,
      });
      return;
    }
    const h = heading + (Math.random() - 0.5) * 2.4;
    this.flights.push({
      x,
      z,
      vx: 0,
      vz: 0,
      vy: 0,
      t: 0,
      T: TOPPLE * (0.8 + Math.random() * 0.5),
      pose: first + ((rnd * DEAD_POSES) | 0),
      sin: Math.sin(h),
      cos: Math.cos(h),
      spin: (Math.random() < 0.5 ? -1 : 1) * (1.1 + Math.random() * 0.4),
      team,
      paint,
      seen: seen ? 1 : 0,
    });
  }

  /** Put a body down for good. */
  private lay(fl: Flight, x: number, z: number): void {
    const tx = Math.min(TILES - 1, Math.max(0, Math.floor(x / TILE)));
    const tz = Math.min(TILES - 1, Math.max(0, Math.floor(z / TILE)));
    const k = tz * TILES + tx;
    let slot: number;
    if (this.used[k] < TILE_CAP) {
      if (this.tiles[k].length < (this.used[k] + 1) * STRIDE) {
        const grown = new Float32Array(Math.max(32, this.used[k] * 2) * STRIDE);
        grown.set(this.tiles[k]);
        this.tiles[k] = grown;
      }
      slot = this.used[k]++;
      this.count++;
    } else {
      slot = this.next[k];
      this.next[k] = (slot + 1) % TILE_CAP;
      if (this.tiles[k][slot * STRIDE + 8] === 0) this.unseen--;
    }
    const b = this.tiles[k];
    const o = slot * STRIDE;
    b[o] = x;
    b[o + 1] = this.terrain.heightAt(x, z);
    b[o + 2] = z;
    b[o + 3] = fl.sin;
    b[o + 4] = fl.cos;
    b[o + 5] = fl.pose;
    b[o + 6] = fl.team;
    b[o + 7] = fl.paint;
    b[o + 8] = fl.seen;
    if (fl.seen === 0) this.unseen++;
    this.dirty = true;
  }

  clear(): void {
    this.used.fill(0);
    this.next.fill(0);
    this.flights.length = 0;
    this.count = 0;
    this.unseen = 0;
    this.dirty = true;
  }

  /**
   * Draw the dead. `lodNear` and `lodFar` are the unit view's distances: close up a body is
   * the near figure, out to `lodFar` the middle one, then a dark shape to `FAR_DRAW`.
   */
  update(seconds: number, dt: number, camera: THREE.Camera, lodNear: number, lodFar: number) {
    // Bodies in the air: on until they land.
    const flights = this.flights;
    for (let k = flights.length - 1; k >= 0; k--) {
      const fl = flights[k];
      fl.t += dt;
      if (fl.t >= fl.T) {
        const x = fl.x + fl.vx * fl.T;
        const z = fl.z + fl.vz * fl.T;
        if (fl.vy > 0 && fl.seen) {
          // Where a thrown man comes down the dust goes up.
          this.effects.thin = 0;
          this.effects.squadHit(x, this.terrain.heightAt(x, z) - 0.2, z);
          this.terrain.stamp(x, z, 0.9, 25, 160);
        }
        this.lay(fl, x, z);
        flights[k] = flights[flights.length - 1];
        flights.pop();
      }
    }
    this.flying = flights.length;

    const cam = camera.position;
    camera.getWorldDirection(this.dir);
    const moved = cam.distanceToSquared(this.camPos) > 0.04 || this.dir.dot(this.camDir) < 0.99999;
    const reveal = this.unseen > 0 && seconds - this.lastBuild > 0.5;
    if (!moved && !this.dirty && !reveal && flights.length === 0) return;
    this.camPos.copy(cam);
    this.camDir.copy(this.dir);
    this.dirty = false;
    this.lastBuild = seconds;

    for (const b of this.near) b.n = 0;
    for (const b of this.mid) b.n = 0;
    this.far.n = 0;
    this.proj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.proj);
    const planes = this.frustum.planes;
    const near2 = lodNear * lodNear;
    const mid2 = lodFar * lodFar;
    const far2 = FAR_DRAW * FAR_DRAW;
    const fog = this.fog;
    const colours = this.colours;
    let nearN = 0;
    const drawn = this.drawn;
    drawn[0] = drawn[1] = drawn[2] = 0;
    const sphere = this.sphere;
    for (let k = 0; k < TILES * TILES; k++) {
      const n = this.used[k];
      if (n === 0) continue;
      const cx = ((k % TILES) + 0.5) * TILE;
      const cz = (Math.floor(k / TILES) + 0.5) * TILE;
      sphere.center.set(cx, this.terrain.heightAt(cx, cz), cz);
      sphere.radius = TILE * 0.75 + 12;
      if (!this.frustum.intersectsSphere(sphere)) continue;
      const reach = sphere.center.distanceTo(cam) - sphere.radius;
      if (reach > FAR_DRAW) continue;
      const b = this.tiles[k];
      for (let i = 0; i < n; i++) {
        const o = i * STRIDE;
        const x = b[o];
        const y = b[o + 1];
        const z = b[o + 2];
        if (b[o + 8] === 0) {
          if (!fog.sees(x, z)) continue;
          b[o + 8] = 1;
          this.unseen--;
        }
        let out = false;
        for (let p = 0; p < 6; p++) {
          const pl = planes[p];
          if (pl.normal.x * x + pl.normal.y * y + pl.normal.z * z + pl.constant < -1.5) {
            out = true;
            break;
          }
        }
        if (out) continue;
        const ddx = x - cam.x;
        const ddy = y - cam.y;
        const ddz = z - cam.z;
        const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
        if (d2 > far2) continue;
        const c = colours[b[o + 6]] ?? colours[0];
        const pose = b[o + 5];
        if (d2 < near2 && nearN < NEAR_CAP) {
          nearN++;
          drawn[0]++;
          this.near[pose].put(x, y, z, b[o + 3], b[o + 4], 1, c[0], c[1], c[2], b[o + 7]);
        } else if (d2 < mid2) {
          drawn[1]++;
          this.mid[pose].put(x, y, z, b[o + 3], b[o + 4], 1, c[0], c[1], c[2], b[o + 7]);
        } else {
          drawn[2]++;
          this.far.put(x, y, z, b[o + 3], b[o + 4], 1, c[0], c[1], c[2], b[o + 7]);
        }
      }
    }

    // And the men still in the air, turning over as they go, flat in their pose on landing.
    const f = this.f;
    for (const fl of flights) {
      if (fl.seen === 0 && !fog.sees(fl.x, fl.z)) continue;
      fl.seen = 1;
      const u = Math.min(1, fl.t / fl.T);
      const x = fl.x + fl.vx * fl.t;
      const z = fl.z + fl.vz * fl.t;
      const a = fl.spin * (1 - u) * (fl.vy > 0 ? 1 : 1 - u);
      const sa = Math.sin(a);
      const ca = Math.cos(a);
      const lift = fl.vy * fl.t - 0.5 * GRAVITY * fl.t * fl.t;
      // A body tips about one end, not its middle: the end that stays down stays on the ground.
      const y = this.terrain.heightAt(x, z) + Math.max(0, lift) + Math.abs(sa) * 0.3;
      const s = fl.sin;
      const co = fl.cos;
      f[0] = co;
      f[1] = 0;
      f[2] = -s;
      f[3] = sa * s;
      f[4] = ca;
      f[5] = sa * co;
      f[6] = ca * s;
      f[7] = -sa;
      f[8] = ca * co;
      f[9] = x;
      f[10] = y;
      f[11] = z;
      const c = colours[fl.team] ?? colours[0];
      const dx = x - cam.x;
      const dz = z - cam.z;
      const d2 = dx * dx + (y - cam.y) * (y - cam.y) + dz * dz;
      (d2 < near2 ? this.near : this.mid)[fl.pose].frame(f, c[0], c[1], c[2], fl.paint);
    }
    for (const b of this.near) {
      b.flush();
      b.mesh.visible = b.n > 0;
    }
    for (const b of this.mid) {
      b.flush();
      b.mesh.visible = b.n > 0;
    }
    this.far.flush();
  }
}
