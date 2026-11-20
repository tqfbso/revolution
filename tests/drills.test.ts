import { describe, expect, it } from 'vitest';
import type * as THREE from 'three/webgpu';
import type { Batch } from '../src/client/batch';
import { CREW, WEAPON_LAUNCHER, WEAPON_MORTAR, serve } from '../src/client/drills';
import { buildLauncher, buildMortar } from '../src/client/models';
import { ARM_MG, ARM_TUBE, DEAD_POSES, Soldiers } from '../src/client/soldiers';

/** Stand-in batches that keep the frames they are given. */
function rig(faction: number) {
  const frames: number[][] = [];
  const shapes: THREE.BufferGeometry[] = [];
  const make = (g: THREE.BufferGeometry) => {
    shapes.push(g);
    const b = {
      n: 0,
      frame(f: Float32Array) {
        frames.push(Array.from(f));
        b.n++;
      },
    };
    return b as unknown as Batch;
  };
  return { soldiers: new Soldiers(make, faction), frames, shapes };
}

const size = (g: THREE.BufferGeometry) => {
  g.computeBoundingBox();
  const b = g.boundingBox!;
  return [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z, b.min.y];
};

function square(frames: number[][], ground: number): void {
  for (const f of frames) {
    for (const v of f) expect(Number.isFinite(v)).toBe(true);
    const [xx, xy, xz, yx, yy, yz, zx, zy, zz] = f;
    const len = Math.hypot(xx, xy, xz);
    expect(Math.hypot(yx, yy, yz)).toBeCloseTo(len, 4);
    expect(Math.hypot(zx, zy, zz)).toBeCloseTo(len, 4);
    expect(xx * yx + xy * yy + xz * yz).toBeCloseTo(0, 4);
    expect(f[10]).toBeGreaterThan(ground - 0.01);
  }
}

describe('each army on foot (models phase 2)', () => {
  it('dresses every army in its own kit: helmet, pack and rifle differ', () => {
    const kits = [1, 2, 3].map((f) => rig(f).shapes);
    // In the order the rig makes them: torso, head, ..., rifle is the seventh.
    for (const piece of [0, 1, 6]) {
      const a = kits.map((k) =>
        size(k[piece])
          .map((v) => v.toFixed(3))
          .join(),
      );
      expect(new Set(a).size, `piece ${piece}`).toBe(3);
    }
    for (const k of kits) expect(k.length).toBe(kits[0].length);
  });

  it('draws the machine gunner and the man with the rocket as whole men', () => {
    for (const faction of [0, 1, 2, 3]) {
      const { soldiers, frames } = rig(faction);
      for (const [arm, pieces] of [
        [ARM_MG, 11],
        [ARM_TUBE, 12],
      ]) {
        for (const run of [0, 1]) {
          frames.length = 0;
          soldiers.man(0, 0, 0, 0, 0, 1, 1 - run, 0, run, 0, 1.2, 0, 1, 1, 1, 0, 0, arm, 0.5);
          expect(frames.length).toBe(pieces);
          square(frames, 0);
        }
      }
      expect(soldiers.deadPoses(0).length).toBe(DEAD_POSES);
      expect(soldiers.deadPoses(1).length).toBe(DEAD_POSES);
    }
  });

  it('keeps a crew whole through its drill, from the shot to the next one', () => {
    const { soldiers, frames } = rig(1);
    for (const weapon of [WEAPON_LAUNCHER, WEAPON_MORTAR])
      for (let m = 0; m < CREW[weapon].length; m++)
        for (const lod of [0, 1])
          for (let since = 0; since < 9; since += 0.07) {
            frames.length = 0;
            const serving = serve(soldiers, weapon, m, since, 7);
            expect(serving).toBe(!(weapon === WEAPON_LAUNCHER && m === 1));
            soldiers.man(lod, 3, 1, 4, 0.6, 0.8, 1, 0, 0, 0, 0, 0, 1, 1, 1, 0);
            expect(frames.length).toBe(lod === 0 ? 11 : 8);
            square(frames, 1);
          }
    // The drill is for one man only: the next is back on his rifle.
    serve(soldiers, WEAPON_MORTAR, 1, 0, 7);
    frames.length = 0;
    soldiers.man(0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 1, 1, 1, 0);
    const served = frames.map((f) => f.join());
    frames.length = 0;
    soldiers.man(0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 1, 1, 1, 0);
    expect(frames.map((f) => f.join())).not.toEqual(served);
  });

  it('builds team weapons no taller than the men who serve them, one outline an army', () => {
    const man = 0.62;
    for (const build of [
      (f: number) => buildMortar(f).tube,
      (f: number) => buildLauncher(f).launcher,
    ]) {
      const sizes = [1, 2, 3].map((f) => size(build(f)));
      for (const [w, h, d, floor] of sizes) {
        expect(h).toBeLessThan(man * 0.75);
        expect(h).toBeGreaterThan(man * 0.4);
        expect(Math.max(w, d)).toBeLessThan(man * 1.1);
        expect(Math.abs(floor)).toBeLessThan(0.02);
      }
      expect(new Set(sizes.map((s) => s.map((v) => v.toFixed(3)).join())).size).toBe(3);
    }
  });
});
