// Helicopters that came down (visual only, nothing in the sim or its hash changes). The sim
// lets a dead helicopter's slot go after a while and a shot-down aircraft was never drawn,
// so the client keeps its own record: when one dies it falls the last few metres, hits the
// ground and lies there, scorched and broken, for the rest of the game. A wreck smoulders
// for under a minute and then goes cold. Wrecks are few (a helicopter costs a lot and
// helipads limit them), so the whole list is rewritten when something changes: a fall, a
// new wreck, a spot coming out of the fog. Enemy wrecks show once the spot is explored, the
// same rule the tank wrecks follow.
import * as THREE from 'three/webgpu';
import type { Batch } from './batch';
import type { Effects } from './effects';
import type { Fog } from './fog';
import type { Terrain } from './terrain';

/** Wrecks kept; past that the oldest gives way to the newest. */
const CAP = 512;
/** Floats per wreck: x, z, sin, cos, kind (0 gunship, 1 lift), variant, team, paint, born, ground y. */
const STRIDE = 10;
/** World units a second squared: the same as the thrown men. */
const GRAVITY = 9;
/** How long one smoulders, in seconds, and how close the camera must be to bother with smoke. */
const SMOULDER = 50;
const SMOKE_NEAR = 220;
/** The recount for the fog, in seconds. */
const RECHECK = 0.5;
export const WRECK_VARIANTS = 3;

interface Falling {
  x: number;
  z: number;
  /** Height above the ground it falls from, and seconds in the air. */
  h: number;
  t: number;
  T: number;
  /** Yaw rate, radians a second. */
  spin: number;
  heading: number;
  kind: number;
  variant: number;
  team: number;
  paint: number;
  seen: boolean;
}

export class Wrecks {
  count = 0;
  private readonly data = new Float32Array(CAP * STRIDE);
  private next = 0;
  private readonly falling: Falling[] = [];
  private dirty = true;
  private lastBuild = -1e9;
  private time = 0;

  /**
   * `batches[kind][variant]` hold the drawn shapes (models.ts buildHelicopterWrecks);
   * `landed` is told where one hits the ground and whether the player saw it.
   */
  constructor(
    private readonly batches: Batch[][],
    private readonly terrain: Terrain,
    private readonly fog: Fog,
    private readonly effects: Effects,
    private readonly colours: readonly (readonly number[])[],
    private readonly landed: (x: number, z: number, seen: boolean) => void,
  ) {}

  /** A helicopter was shot down at (x, z), `height` above the ground. */
  add(
    x: number,
    z: number,
    height: number,
    heading: number,
    kind: number,
    team: number,
    paint: number,
    seen: boolean,
  ): void {
    this.falling.push({
      x,
      z,
      h: Math.max(0.5, height),
      t: 0,
      T: Math.sqrt((2 * Math.max(0.5, height)) / GRAVITY) + 0.25,
      spin: (Math.random() < 0.5 ? -1 : 1) * (2.2 + Math.random() * 2.2),
      heading,
      kind,
      variant: (Math.random() * WRECK_VARIANTS) | 0,
      team,
      paint,
      seen,
    });
  }

  clear(): void {
    this.count = 0;
    this.next = 0;
    this.falling.length = 0;
    this.dirty = true;
  }

  private lay(f: Falling): void {
    const o = this.next * STRIDE;
    const d = this.data;
    d[o] = f.x;
    d[o + 1] = f.z;
    d[o + 2] = Math.sin(f.heading);
    d[o + 3] = Math.cos(f.heading);
    d[o + 4] = f.kind;
    d[o + 5] = f.variant;
    d[o + 6] = f.team;
    d[o + 7] = f.paint;
    d[o + 8] = this.time;
    d[o + 9] = this.terrain.heightAt(f.x, f.z);
    this.next = (this.next + 1) % CAP;
    if (this.count < CAP) this.count++;
    this.dirty = true;
  }

  update(seconds: number, dt: number, camera: THREE.Camera): void {
    this.time = seconds;
    const falling = this.falling;
    for (let k = falling.length - 1; k >= 0; k--) {
      const f = falling[k];
      f.t += dt;
      f.heading += f.spin * dt;
      // A burning helicopter trails smoke on the way down.
      if (f.seen && Math.random() < dt * 14) {
        const y = this.terrain.heightAt(f.x, f.z) + Math.max(0, f.h - 0.5 * GRAVITY * f.t * f.t);
        this.effects.wreckSmoke(f.x, y - 0.5, f.z, 1);
      }
      if (f.t >= f.T) {
        this.landed(f.x, f.z, f.seen);
        this.lay(f);
        falling[k] = falling[falling.length - 1];
        falling.pop();
      }
    }
    if (this.count === 0 && falling.length === 0) {
      if (this.dirty) {
        this.dirty = false;
        for (const row of this.batches) for (const b of row) b.n = b.mesh.count = 0;
      }
      return;
    }
    const cam = camera.position;
    const d = this.data;
    // Smoke from the ones still hot; checked each frame, a handful at most.
    for (let i = 0; i < this.count; i++) {
      const o = i * STRIDE;
      const age = seconds - d[o + 8];
      if (age >= SMOULDER || Math.random() >= dt * 3) continue;
      const x = d[o];
      const z = d[o + 1];
      if (Math.abs(x - cam.x) > SMOKE_NEAR || Math.abs(z - cam.z) > SMOKE_NEAR) continue;
      if (this.fog.sees(x, z))
        this.effects.wreckSmoke(x, d[o + 9] + 0.3, z, Math.max(0, 1 - age / 12));
    }
    if (!this.dirty && falling.length === 0 && seconds - this.lastBuild < RECHECK) return;
    this.dirty = false;
    this.lastBuild = seconds;
    for (const row of this.batches) for (const b of row) b.n = 0;
    const fog = this.fog;
    for (let i = 0; i < this.count; i++) {
      const o = i * STRIDE;
      const x = d[o];
      const z = d[o + 1];
      if (!fog.hasExplored(x, z)) continue;
      const t = this.colours[d[o + 6]] ?? this.colours[0];
      this.batches[d[o + 4]][d[o + 5]].put(
        x,
        d[o + 9],
        z,
        d[o + 2],
        d[o + 3],
        1,
        t[0],
        t[1],
        t[2],
        d[o + 7],
      );
    }
    for (const f of falling) {
      const y = this.terrain.heightAt(f.x, f.z) + Math.max(0, f.h - 0.5 * GRAVITY * f.t * f.t);
      const t = this.colours[f.team] ?? this.colours[0];
      this.batches[f.kind][f.variant].put(
        f.x,
        y,
        f.z,
        Math.sin(f.heading),
        Math.cos(f.heading),
        1,
        t[0],
        t[1],
        t[2],
        f.paint,
      );
    }
    for (const row of this.batches) for (const b of row) b.flush();
  }
}
