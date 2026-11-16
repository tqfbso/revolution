import { describe, expect, it } from 'vitest';
import { generateMap } from '../src/sim/map';
import {
  FIELD_DONE,
  UNREACHABLE,
  buildField,
  flowDirection,
  growField,
  newField,
  seedField,
} from '../src/sim/path';

describe('route fields searched in steps', () => {
  it('give the same costs and the same way at every settled cell as one full search', () => {
    const map = generateMap(5, 'city');
    for (const layer of [0, 1]) {
      for (const [goalAt, ...asks] of [
        [40000, 40500, 30000, 7000],
        [12345, 12400, 60000],
        [65000, 100, 33000, 33100],
      ]) {
        const goal = map.snap[layer][goalAt];
        const full = newField();
        buildField(map, layer, full, [goal], 1, UNREACHABLE - 1);
        const part = newField();
        seedField(map, layer, part, [goal], 1);
        let settled = -1;
        const steps: number[] = [];
        for (const ask of asks) {
          const cell = map.snap[layer][ask];
          if (part[cell] > settled) {
            settled = growField(map, layer, part, settled, cell, UNREACHABLE - 1);
          }
          steps.push(settled);
          expect(part[cell]).toBe(full[cell]);
          for (let c = 0; c < full.length; c++) {
            if (full[c] > settled) continue;
            if (part[c] !== full[c]) expect(part[c]).toBe(full[c]);
            const a = flowDirection(map, layer, part, c);
            const b = flowDirection(map, layer, full, c);
            if (a !== b) expect([c, a]).toEqual([c, b]);
          }
        }
        // The first search stopped short of the whole map.
        if (goalAt === 40000) expect(steps[0]).toBeLessThan(FIELD_DONE);
      }
    }
  });
});
