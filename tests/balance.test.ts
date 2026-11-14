import { describe, expect, it } from 'vitest';
import { CMD_HOLD, CMD_SPAWN, CMD_STANCE } from '../src/sim/commands';
import { UNIT_PRICE } from '../src/sim/economy';
import { fx } from '../src/sim/fixed';
import { flatMap } from '../src/sim/map';
import { step } from '../src/sim/sim';
import {
  KINDS,
  KIND_ATGM,
  KIND_DRONE,
  KIND_INFANTRY,
  KIND_STRIKE,
  KIND_TANK,
  POINTS,
} from '../src/sim/units';
import { STANCE_HOLD_FIRE, createWorld } from '../src/sim/world';

/** Tank health lost to one squad of rifles after `ticks`, with the tank `gap` metres away. */
function tankLoss(gap: number, ticks: number): number {
  const w = createWorld(3, flatMap());
  const at = (team: number, kind: number, x: number) => ({
    type: CMD_SPAWN as typeof CMD_SPAWN,
    count: 1,
    team,
    kind,
    x: fx(x),
    y: fx(200),
    radius: 0,
    wander: false,
  });
  step(w, [at(0, KIND_INFANTRY, 200), at(1, KIND_TANK, 200 + gap)]);
  const tank = w.kind.findIndex((k, i) => i < w.count && k === KIND_TANK);
  const squad = w.kind.findIndex((k, i) => i < w.count && k === KIND_INFANTRY);
  // Spawning scatters units a little: put the two exactly `gap` metres apart.
  w.posX[squad] = fx(200);
  w.posY[squad] = fx(200);
  w.posX[tank] = fx(200 + gap);
  w.posY[tank] = fx(200);
  // The squad holds its ground: left to itself it would rush a tank this near (decision 108).
  step(w, [
    { type: CMD_STANCE, units: [tank], stance: STANCE_HOLD_FIRE },
    { type: CMD_HOLD, units: [squad] },
  ]);
  const before = w.hp[tank];
  for (let t = 0; t < ticks; t++) step(w, []);
  return before - w.hp[tank];
}

describe('army mix', () => {
  it('makes soldiers and drones cheap and fast, armour dear and slow', () => {
    const t = (k: number) => UNIT_PRICE[k].ticks;
    expect(t(KIND_INFANTRY)).toBeLessThan(t(KIND_TANK) / 8);
    expect(t(KIND_DRONE)).toBeLessThan(t(KIND_TANK) / 8);
    expect(UNIT_PRICE[KIND_INFANTRY].supplies * 6).toBeLessThanOrEqual(
      UNIT_PRICE[KIND_TANK].supplies,
    );
    // Answers to armour and eyes are there from the first tier.
    expect(UNIT_PRICE[KIND_ATGM].tier).toBe(1);
    expect(UNIT_PRICE[KIND_DRONE].tier).toBe(1);
    expect(UNIT_PRICE[KIND_STRIKE].tier).toBe(2);
  });

  it('gives a tank the same limit weight as five squads', () => {
    expect(POINTS[KIND_TANK]).toBe(5 * POINTS[KIND_INFANTRY]);
    expect(KINDS[KIND_TANK].hp).toBeGreaterThan(KINDS[KIND_INFANTRY].hp);
  });

  it('lets rifle squads hurt a vehicle much more from point blank than from range', () => {
    const close = tankLoss(6, 120);
    const far = tankLoss(12, 120);
    expect(close).toBeGreaterThan(0);
    expect(close).toBeGreaterThanOrEqual(3 * far);
  });
});
