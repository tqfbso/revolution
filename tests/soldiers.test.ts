import { describe, expect, it } from 'vitest';
import type { Batch } from '../src/client/batch';
import { Soldiers } from '../src/client/soldiers';

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
                expect(frames.length).toBe(lod === 0 ? 11 : 6);
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
});
