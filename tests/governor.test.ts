import { describe, expect, it } from 'vitest';
import { Governor, ratioFor } from '../src/client/governor';

/** Run the governor for `seconds` against a machine described by `ms(levers)`. */
function run(
  g: Governor,
  seconds: number,
  ms: (g: Governor) => number,
  cpu: (g: Governor) => number,
) {
  for (let s = 0; s < seconds; s++) g.second(ms(g), cpu(g));
}

describe('frame governor', () => {
  it('leaves a fast machine alone', () => {
    const g = new Governor('normal');
    run(
      g,
      60,
      () => 16.7,
      () => 6,
    );
    expect(g.levers.scale).toBe(1);
    expect(g.levers.shadowEvery).toBe(2);
    expect(g.limit).toBe('none');
  });

  it('lowers resolution when the card is out of fill rate, and finds a level that holds', () => {
    const g = new Governor('normal');
    // Frame time in step with the pixels drawn: 26 ms at full resolution.
    const ms = (x: Governor) => Math.max(16.7, 26 * x.levers.scale * x.levers.scale);
    run(g, 40, ms, () => 5);
    expect(g.limit).toBe('pixels');
    expect(g.levers.scale).toBeLessThan(0.9);
    expect(ms(g)).toBeLessThan(19.5);
    expect(g.levers.lod).toBe(1);
  });

  it('puts the resolution back when lowering it did nothing, and cuts the scene instead', () => {
    const g = new Governor('high');
    // Geometry bound: only the shadow pass and the detail range matter.
    const ms = (x: Governor) => 14 + 9 / x.levers.shadowEvery + (x.levers.post ? 2 : 0);
    run(g, 30, ms, () => 5);
    expect(g.levers.scale).toBe(1);
    expect(g.levers.shadowEvery).toBeGreaterThan(1);
    expect(g.limit).toBe('scene');
  });

  it('never touches the resolution when the processor is the limit', () => {
    const g = new Governor('normal');
    const ms = (x: Governor) => 10 + 14 * x.levers.lod;
    run(g, 30, ms, ms);
    expect(g.limit).toBe('cpu');
    expect(g.levers.scale).toBe(1);
    expect(g.levers.lod).toBeLessThan(1);
  });

  it('gives detail back after a smooth stretch, and learns when that backfires', () => {
    const g = new Governor('normal');
    let load = 26;
    const ms = (x: Governor) => Math.max(16.7, load * x.levers.scale * x.levers.scale);
    run(g, 30, ms, () => 5);
    expect(g.levers.scale).toBeLessThan(1);
    load = 15;
    run(g, 60, ms, () => 5);
    expect(g.levers.scale).toBe(1);
    expect(g.limit).toBe('none');
    // A load that sits on the edge: detail comes back, breaks it, goes again. The swings
    // must get rarer, not go on every ten seconds for ever.
    load = 21.5;
    let moves = 0;
    let lastScale = g.levers.scale;
    for (let s = 0; s < 600; s++) {
      g.second(ms(g), 5);
      if (g.levers.scale !== lastScale) moves++;
      lastScale = g.levers.scale;
    }
    expect(moves).toBeLessThan(30);
  });

  it('holds each graphics level to its pixel budget', () => {
    // A 16-inch laptop at 1728 x 1117 points and two device pixels a point.
    expect(ratioFor('high', 1728, 1117, 2)).toBe(2);
    expect(ratioFor('normal', 1728, 1117, 2)).toBeCloseTo(1.64, 1);
    expect(ratioFor('low', 1728, 1117, 2)).toBeCloseTo(1.04, 1);
    // A plain 1080p screen is inside every budget.
    expect(ratioFor('normal', 1920, 1080, 1)).toBe(1);
  });
});
