import { describe, expect, it } from 'vitest';
import { farParts, type Part } from '../src/client/structures';

describe('far facades (decision 126)', () => {
  const wall: Part = { size: [12, 9, 0.3], at: [6, 4.5, 0], color: 0x999999 };
  const window = (x: number, y: number): Part => ({
    size: [0.9, 1.2, 0.05],
    at: [x, y, 0.16],
    color: 0x1b2126,
    gloss: 1,
  });
  const chimney: Part = { size: [0.5, 1.2, 0.5], at: [3, 9.6, 0], color: 0x554444 };

  it('keeps the walls, paints each row of windows as one band, drops the small things', () => {
    const parts = [wall, chimney];
    for (const y of [1.5, 4.5, 7.5])
      for (const x of [1.5, 4, 6.5, 9, 10.5]) parts.push(window(x, y));
    const far = farParts(parts);
    expect(far).toContain(wall);
    expect(far).not.toContain(chimney);
    const bands = far.filter((p) => p !== wall);
    expect(bands).toHaveLength(3);
    for (const b of bands) {
      // From the left edge of the first window to the right edge of the last.
      expect(b.size[0]).toBeCloseTo(10.5 + 0.45 - (1.5 - 0.45));
      expect(b.size[1]).toBeCloseTo(1.2);
      expect(b.at[0]).toBeCloseTo(6);
    }
    expect(far.length).toBeLessThan(parts.length / 3);
  });

  it('does not join the windows of two houses across a gap', () => {
    const far = farParts([window(1, 2), window(2.5, 2), window(14, 2), window(15.5, 2)]);
    expect(far).toHaveLength(2);
  });
});
