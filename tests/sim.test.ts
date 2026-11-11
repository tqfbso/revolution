import { describe, expect, it } from 'vitest';
import { CMD_MOVE, CMD_SPAWN, CMD_STOP, type Command } from '../src/sim/commands';
import { fx, isqrt } from '../src/sim/fixed';
import { stressTestCommands } from '../src/sim/scenarios';
import { step } from '../src/sim/sim';
import { FLAG_MOVING, MAP_SIZE_FX, MAX_UNITS, createWorld, hashWorld } from '../src/sim/world';

/** A scripted game: opening spawn plus player orders at fixed ticks. */
function script(tick: number): Command[] {
  if (tick === 0) return stressTestCommands(3000);
  if (tick === 40) {
    const units = Array.from({ length: 500 }, (_, i) => i * 3);
    return [{ type: CMD_MOVE, units, x: fx(200), y: fx(800) }];
  }
  if (tick === 90) return [{ type: CMD_STOP, units: [0, 3, 6, 9, 99999, -1] }];
  if (tick === 120) {
    return [
      {
        type: CMD_SPAWN,
        count: 500,
        team: 1,
        x: fx(512),
        y: fx(512),
        radius: fx(30),
        wander: true,
      },
    ];
  }
  return [];
}

function run(seed: number, ticks: number): number[] {
  const w = createWorld(seed);
  const hashes: number[] = [];
  for (let t = 0; t < ticks; t++) {
    step(w, script(t));
    hashes.push(hashWorld(w));
  }
  return hashes;
}

describe('determinism', () => {
  it('same seed + same commands => identical state hash on every tick', () => {
    const a = run(1234, 700);
    const b = run(1234, 700);
    expect(b).toEqual(a);
  });

  it('different seed => different state', () => {
    expect(run(1, 50).at(-1)).not.toBe(run(2, 50).at(-1));
  });

  it('matches the pinned hash (catches cross-platform or accidental behaviour changes)', () => {
    // If you change sim behaviour on purpose, update this value in the same PR.
    expect(run(1234, 700).at(-1)).toBe(GOLDEN);
  });
});

const GOLDEN = 282912497;

describe('movement', () => {
  it('units ordered to move arrive in formation around the target and stop', () => {
    const w = createWorld(7);
    step(w, [
      {
        type: CMD_SPAWN,
        count: 100,
        team: 0,
        x: fx(300),
        y: fx(300),
        radius: fx(20),
        wander: false,
      },
    ]);
    const units = Array.from({ length: 100 }, (_, i) => i);
    step(w, [{ type: CMD_MOVE, units, x: fx(600), y: fx(500) }]);
    for (let t = 0; t < 2000; t++) step(w, []);
    for (const i of units) {
      expect(w.flags[i] & FLAG_MOVING).toBe(0);
      const dx = w.posX[i] - fx(600);
      const dy = w.posY[i] - fx(500);
      expect(isqrt(dx * dx + dy * dy)).toBeLessThan(fx(25));
    }
  });

  it('stacked units are pushed apart', () => {
    const w = createWorld(7);
    step(w, [
      { type: CMD_SPAWN, count: 48, team: 0, x: fx(500), y: fx(500), radius: 1, wander: false },
    ]);
    for (let t = 0; t < 400; t++) step(w, []);
    let tooClose = 0;
    for (let i = 0; i < w.count; i++) {
      for (let j = i + 1; j < w.count; j++) {
        const dx = w.posX[i] - w.posX[j];
        const dy = w.posY[i] - w.posY[j];
        if (isqrt(dx * dx + dy * dy) < fx(1.2)) tooClose++;
      }
    }
    expect(tooClose).toBe(0);
  });

  it('never exceeds capacity or leaves the map', () => {
    const w = createWorld(3);
    step(w, [
      {
        type: CMD_SPAWN,
        count: MAX_UNITS + 500,
        team: 2,
        x: 0,
        y: 0,
        radius: fx(50),
        wander: true,
      },
    ]);
    expect(w.count).toBe(MAX_UNITS);
    for (let t = 0; t < 50; t++) step(w, []);
    for (let i = 0; i < w.count; i++) {
      expect(w.posX[i]).toBeGreaterThanOrEqual(0);
      expect(w.posX[i]).toBeLessThan(MAP_SIZE_FX);
      expect(w.posY[i]).toBeGreaterThanOrEqual(0);
      expect(w.posY[i]).toBeLessThan(MAP_SIZE_FX);
    }
  });
});
