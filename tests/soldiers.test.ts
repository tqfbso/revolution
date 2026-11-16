import { describe, expect, it } from 'vitest';
import type { Batch } from '../src/client/batch';
import * as THREE from 'three/webgpu';
import { Soldiers, STRIDE_FRAMES, stillPose } from '../src/client/soldiers';

/** Stand-in batches that keep the frames they are given. */
function rig() {
  const frames: number[][] = [];
  const make = () => {
    const b = {
      n: 0,
      frame(f: Float32Array) {
        frames.push(Array.from(f));
        b.n++;
      },
    };
    return b as unknown as Batch;
  };
  return { soldiers: new Soldiers(make), frames };
}

describe('soldier rig', () => {
  it('keeps every piece square, finite and above the ground in any stance', () => {
    const { soldiers, frames } = rig();
    const steps = [0, 0.3, 0.7, 1];
    for (const lod of [0, 1])
      for (const kneel of steps)
        for (const prone of steps)
          for (const run of steps)
            for (const aim of [0, 1])
              for (let stride = 0; stride < 6.3; stride += 0.9) {
                frames.length = 0;
                soldiers.man(
                  lod,
                  10,
                  2,
                  -5,
                  0.6,
                  0.8,
                  kneel,
                  prone,
                  run,
                  aim,
                  stride,
                  0.02,
                  1,
                  1,
                  1,
                  0,
                );
                expect(frames.length).toBe(lod === 0 ? 11 : 8);
                for (const f of frames) {
                  for (const v of f) expect(Number.isFinite(v)).toBe(true);
                  const [xx, xy, xz, yx, yy, yz, zx, zy, zz] = f;
                  const len = Math.hypot(xx, xy, xz);
                  expect(Math.hypot(yx, yy, yz)).toBeCloseTo(len, 4);
                  expect(Math.hypot(zx, zy, zz)).toBeCloseTo(len, 4);
                  expect(xx * yx + xy * yy + xz * yz).toBeCloseTo(0, 4);
                  expect(xx * zx + xy * zy + xz * zz).toBeCloseTo(0, 4);
                  // No joint under the ground he stands on (y = 2 here).
                  expect(f[10]).toBeGreaterThan(2 - 0.03);
                }
              }
  });

  it('puts the muzzle ahead of a standing man who aims, at about shoulder height', () => {
    const { soldiers } = rig();
    soldiers.man(0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 1, 1, 0);
    const m = soldiers.muzzle;
    expect(m[2]).toBeGreaterThan(0.25);
    expect(m[1]).toBeGreaterThan(0.4);
    expect(m[1]).toBeLessThan(0.62);
  });

  it('lies lower than it kneels and kneels lower than it stands', () => {
    const { soldiers, frames } = rig();
    const top = (kneel: number, prone: number) => {
      frames.length = 0;
      soldiers.man(0, 0, 0, 0, 0, 1, kneel, prone, 0, 0, 0, 0, 1, 1, 1, 0);
      return frames[1][10]; // the neck
    };
    expect(top(0, 0)).toBeGreaterThan(top(1, 0) + 0.1);
    expect(top(1, 0)).toBeGreaterThan(top(0, 1) + 0.1);
  });

  it('picks the still pose nearest the blend of stances', () => {
    expect(stillPose(0, 0, 0, 0, 0)).toBe(0);
    expect(stillPose(0, 0, 0, 1, 0)).toBe(1);
    expect(stillPose(1, 0, 0, 0.2, 0)).toBe(2);
    expect(stillPose(0.9, 0, 0, 0.8, 0)).toBe(3);
    expect(stillPose(1, 0.8, 0, 0, 0)).toBe(4);
    expect(stillPose(0, 1, 0, 1, 0)).toBe(5);
    // On the run the stride picks the frame, round the whole cycle.
    const frames = new Set<number>();
    for (let s = 0; s < Math.PI * 4; s += 0.1) {
      const k = stillPose(0, 0, 1, 0, s);
      expect(k).toBeGreaterThanOrEqual(6);
      expect(k).toBeLessThan(6 + STRIDE_FRAMES);
      frames.add(k);
    }
    expect(frames.size).toBe(STRIDE_FRAMES);
    // Kneeling and lying men do not run, whatever their legs were doing.
    expect(stillPose(1, 0, 1, 0, 1)).toBe(2);
  });

  it('bakes still figures that stand where the posed man stands, muzzle and all', () => {
    const geometries: THREE.BufferGeometry[] = [];
    const puts: number[][] = [];
    const make = (g: THREE.BufferGeometry, capacity: number) => {
      geometries.push(g);
      const b = {
        n: 0,
        capacity,
        frame() {},
        put(...a: number[]) {
          puts.push(a);
          b.n++;
        },
      };
      return b as unknown as Batch;
    };
    const soldiers = new Soldiers(make);
    // The last 6 + STRIDE_FRAMES batches are the still poses, made after the pieces.
    const stills = geometries.slice(-(6 + STRIDE_FRAMES));
    const height = (g: THREE.BufferGeometry) => {
      g.computeBoundingBox();
      return g.boundingBox!.max.y - g.boundingBox!.min.y;
    };
    // A man standing is about 0.62 units tall; kneeling lower, lying lower still.
    expect(height(stills[0])).toBeGreaterThan(0.55);
    expect(height(stills[0])).toBeLessThan(0.75);
    expect(height(stills[2])).toBeLessThan(height(stills[0]) - 0.1);
    expect(height(stills[4])).toBeLessThan(height(stills[2]) - 0.1);
    // His muzzle is where the posed man's would be, turned and placed the same way.
    for (const pose of [1, 3, 5]) {
      const kneel = pose === 3 ? 1 : 0;
      const prone = pose === 5 ? 1 : 0;
      soldiers.man(1, 10, 2, -5, 0.6, 0.8, kneel, prone, 0, 1, 0, 0, 1, 1, 1, 0);
      const posed = Array.from(soldiers.muzzle);
      expect(soldiers.still(pose, 10, 2, -5, 0.6, 0.8, 1, 1, 1, 0)).toBe(true);
      const still = Array.from(soldiers.muzzle);
      for (let k = 0; k < 5; k++) expect(still[k]).toBeCloseTo(posed[k], 5);
    }
    expect(puts.length).toBe(3);
  });
});
