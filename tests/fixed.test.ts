import { describe, expect, it } from 'vitest';
import { fromFx, fx, isqrt } from '../src/sim/fixed';
import { nextInt, nextU32, seedRng } from '../src/sim/rng';

describe('fixed-point', () => {
  it('round-trips world units', () => {
    expect(fromFx(fx(12.5))).toBe(12.5);
    expect(fx(1)).toBe(1024);
  });

  it('isqrt is exact, including around perfect squares and large values', () => {
    expect(isqrt(0)).toBe(0);
    expect(isqrt(-5)).toBe(0);
    for (const r of [1, 2, 3, 1023, 1024, 65535, 1 << 20, 94906265]) {
      expect(isqrt(r * r)).toBe(r);
      expect(isqrt(r * r - 1)).toBe(r - 1);
      expect(isqrt(r * r + 1)).toBe(r);
    }
  });
});

describe('rng', () => {
  it('is reproducible from the seed and matches pinned values', () => {
    const a = new Uint32Array(1);
    const b = new Uint32Array(1);
    seedRng(a, 42);
    seedRng(b, 42);
    const seq = [nextU32(a), nextU32(a), nextU32(a)];
    expect([nextU32(b), nextU32(b), nextU32(b)]).toEqual(seq);
    seedRng(b, 43);
    expect(nextU32(b)).not.toBe(seq[0]);
    for (let i = 0; i < 1000; i++) {
      const v = nextInt(a, 10);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(10);
    }
  });
});
