import { describe, expect, it } from 'vitest';
import { stressTestCommands } from '../src/sim/scenarios';
import { step } from '../src/sim/sim';
import { TICK_MS, createWorld } from '../src/sim/world';

function measure(units: number): number {
  const w = createWorld(1);
  step(w, stressTestCommands(units));
  for (let t = 0; t < 200; t++) step(w, []);
  const ticks = 200;
  const t0 = performance.now();
  for (let t = 0; t < ticks; t++) step(w, []);
  return (performance.now() - t0) / ticks;
}

describe('sim performance budget', () => {
  it('3000 units tick in a small fraction of the 50 ms tick budget', () => {
    const ms3k = measure(3000);
    const ms10k = measure(10000);
    console.log(`sim tick: ${ms3k.toFixed(3)} ms @ 3000 units, ${ms10k.toFixed(3)} ms @ 10000`);
    // Very loose bound so slow CI machines do not flake; real numbers are ~100x lower.
    expect(ms3k).toBeLessThan(TICK_MS / 2);
  });
});
