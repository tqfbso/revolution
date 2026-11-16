import { describe, expect, it } from 'vitest';
import type { Batch } from '../src/client/batch';
import { DEAD_POSES, Soldiers } from '../src/client/soldiers';
import { brokenLevel, lostFloors } from '../src/client/structures';
import { DAMAGED_PCT, GUTTED_PCT } from '../src/sim/map';

function soldiers(): Soldiers {
  const make = () => ({ n: 0, frame() {}, put() {} }) as unknown as Batch;
  return new Soldiers(make);
}

describe('the dead (I1)', () => {
  it('bakes every pose lying on the ground, near and middle', () => {
    const s = soldiers();
    for (const lod of [0, 1]) {
      const poses = s.deadPoses(lod);
      expect(poses.length).toBe(DEAD_POSES);
      expect(DEAD_POSES).toBeGreaterThanOrEqual(6);
      const shapes = new Set<string>();
      for (const g of poses) {
        g.computeBoundingBox();
        const b = g.boundingBox!;
        // Down on the ground, no higher than a man is wide, and as long as a man is tall.
        expect(b.min.y).toBeGreaterThan(-0.02);
        expect(b.min.y).toBeLessThan(0.02);
        expect(b.max.y).toBeLessThan(0.3);
        expect(Math.max(b.max.x - b.min.x, b.max.z - b.min.z)).toBeGreaterThan(0.4);
        shapes.add(
          [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z].map((v) => v.toFixed(2)).join(),
        );
        expect(g.getAttribute('position').count).toBeGreaterThan(50);
      }
      // No two poses alike.
      expect(shapes.size).toBe(DEAD_POSES);
    }
  });
});

describe('buildings burning down from the top (I1)', () => {
  const at = (pct: number) => Math.round((pct * 255) / 100);
  it('starts below the damaged line and never goes past the floors there are', () => {
    for (const floors of [1, 2, 3, 6, 9]) {
      expect(brokenLevel(at(DAMAGED_PCT) + 1, floors)).toBe(0);
      let last = 0;
      for (let hp = at(DAMAGED_PCT); hp >= at(GUTTED_PCT); hp--) {
        const l = brokenLevel(hp, floors);
        expect(l).toBeGreaterThanOrEqual(last);
        expect(l).toBeLessThanOrEqual(floors);
        expect(lostFloors(l, floors)).toBeLessThan(floors);
        last = l;
      }
      // Every step is reached before the sim guts it.
      expect(last).toBe(floors);
    }
  });
});
