import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import {
  CIVILIAN_KINDS,
  CIVILIAN_SCALE,
  CIVILIAN_STRIDES,
  buildCivilian,
} from '../src/client/civilianmodel';

/** A soldier stands 0.62 map units tall, helmet and all (soldiers.ts). */
const SOLDIER = 0.62;

describe('the civilian figures', () => {
  it('are the soldiers scale, and no taller than a soldier', () => {
    expect(CIVILIAN_SCALE).toBeCloseTo(SOLDIER / 1.8, 6);
    for (let k = 0; k < CIVILIAN_KINDS; k++) {
      for (let s = 0; s < CIVILIAN_STRIDES; s++) {
        const g = buildCivilian(k, s);
        g.computeBoundingBox();
        const b = g.boundingBox as THREE.Box3;
        // Feet on the ground, a head between 1.55 and 1.8 m up, and nobody a block wide.
        expect(Math.abs(b.min.y)).toBeLessThan(0.02);
        expect(b.max.y).toBeGreaterThan(1.55 * CIVILIAN_SCALE);
        expect(b.max.y).toBeLessThanOrEqual(SOLDIER);
        expect(b.max.x - b.min.x).toBeLessThan(0.6 * CIVILIAN_SCALE);
      }
    }
  });

  it('take the clothes colour above the waist only, and have every attribute the batch needs', () => {
    const g = buildCivilian(0, 0);
    const pos = g.getAttribute('position');
    const mask = g.getAttribute('teamMask');
    expect(g.getAttribute('color')).toBeDefined();
    expect(g.getAttribute('normal')).toBeDefined();
    let low = 0;
    let high = 0;
    for (let i = 0; i < pos.count; i++) {
      expect(Number.isFinite(pos.getX(i) + pos.getY(i) + pos.getZ(i))).toBe(true);
      if (mask.getX(i) < 0.5) continue;
      if (pos.getY(i) < 0.2) low++;
      else high++;
    }
    expect(high).toBeGreaterThan(50);
    expect(low).toBe(0);
  });

  it('the two strides of a figure mirror each other', () => {
    const a = buildCivilian(2, 0);
    const b = buildCivilian(2, 1);
    a.computeBoundingBox();
    b.computeBoundingBox();
    const ba = a.boundingBox as THREE.Box3;
    const bb = b.boundingBox as THREE.Box3;
    expect(ba.max.y).toBeCloseTo(bb.max.y, 5);
    expect(ba.min.x).toBeCloseTo(-bb.max.x, 5);
    expect(a.getAttribute('position').count).toBe(b.getAttribute('position').count);
  });

  it('cost little to draw: under 700 points a figure', () => {
    for (let k = 0; k < CIVILIAN_KINDS; k++) {
      expect(buildCivilian(k, 0).getAttribute('position').count).toBeLessThan(700);
    }
  });
});
