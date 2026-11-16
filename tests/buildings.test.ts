import { describe, expect, it } from 'vitest';
import {
  build,
  buildEach,
  buildingParts,
  farParts,
  rubbleParts,
  type Part,
} from '../src/client/structures';
import { BUILD_BLOCK, BUILD_HALL, BUILD_HOUSE, STAGE_DAMAGED, STAGE_GUTTED } from '../src/sim/map';

/** `build` writes parts straight into one geometry; it must match merging them one by one. */
function same(parts: Part[]): void {
  const a = build(parts);
  const b = buildEach(parts);
  expect(Object.keys(a.attributes).sort()).toEqual(Object.keys(b.attributes).sort());
  for (const name of Object.keys(b.attributes)) {
    const x = a.getAttribute(name).array;
    const y = b.getAttribute(name).array;
    expect(x.length, name).toBe(y.length);
    let worst = 0;
    for (let i = 0; i < y.length; i++) worst = Math.max(worst, Math.abs(x[i] - y[i]));
    expect(worst, name).toBeLessThan(1e-4);
  }
  expect(Array.from(a.index!.array)).toEqual(Array.from(b.index!.array));
}

describe('building geometry', () => {
  it('is the same written straight as merged part by part', () => {
    for (let id = 0; id < 12; id++) {
      const cls = [BUILD_HOUSE, BUILD_BLOCK, BUILD_HALL][id % 3];
      for (const stage of [0, STAGE_DAMAGED, STAGE_GUTTED]) {
        const parts = buildingParts(
          id,
          10,
          20,
          11,
          9,
          1.5,
          1 + (id % 5),
          stage,
          id & 15,
          cls,
          id % 4 === 0,
        );
        same(parts);
        same(farParts(parts));
      }
      same(rubbleParts(id, 10, 20, 11, 9, 1.5, 1 + (id % 5)));
    }
  });

  it('handles turned parts, tapered boxes, roofs and signs', () => {
    same([
      { size: [2, 3, 4], at: [1, 2, 3], color: 0x887766, rot: [0.3, 1.1, -0.4], shade: 0.8 },
      { size: [0.05, 1, 2], at: [0, 1, 0], color: 0x223344, gloss: 1, rot: [0, 0.7, 0] },
      { size: [1, 0.04, 2], at: [0, 1, 0], color: 0x223344, surf: 2 },
      { size: [6, 2, 8], at: [0, 5, 0], color: 0x553322, hip: 1 },
      { size: [6, 2, 8], at: [0, 5, 0], color: 0x553322, hip: 0, ridge: 'x' },
      { size: [6, 2, 8], at: [0, 5, 0], color: 0x553322, taper: [1, 0.5] },
      { size: [3, 1, 0.1], at: [0, 3, 2], color: 0xffffff, sign: 3, rot: [0, Math.PI, 0] },
    ]);
  });
});
