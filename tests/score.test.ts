import { describe, expect, it } from 'vitest';
import { CMD_SPAWN, CMD_STOP, type Command } from '../src/sim/commands';
import { fx } from '../src/sim/fixed';
import { flatMap } from '../src/sim/map';
import { step } from '../src/sim/sim';
import { KIND_INFANTRY, KIND_TANK, POINTS } from '../src/sim/units';
import {
  NO_SEAT,
  STAT_KILLS,
  STAT_KILL_POINTS,
  STAT_LOST,
  STAT_SEAT0,
  STAT_STRIDE,
  createWorld,
  hashWorld,
} from '../src/sim/world';

const spawnAt = (team: number, kind: number, count: number, x: number, y: number): Command => ({
  type: CMD_SPAWN,
  count,
  team,
  kind,
  x: fx(x),
  y: fx(y),
  radius: fx(6),
  wander: false,
});

/** Three red tanks against two blue rifle squads on open ground, fought to the end. */
function fight(by?: number) {
  const w = createWorld(7, flatMap());
  step(w, [spawnAt(0, KIND_TANK, 3, 500, 500), spawnAt(1, KIND_INFANTRY, 2, 530, 500)]);
  const tanks: number[] = [];
  for (let i = 0; i < w.count; i++) if (w.team[i] === 0) tanks.push(i);
  step(w, by === undefined ? [] : [{ type: CMD_STOP, units: tanks, by }]);
  for (let t = 0; t < 1200; t++) step(w, []);
  return w;
}

describe('the score (decision 103)', () => {
  it('counts what each army destroyed and lost', () => {
    const w = fight();
    expect(w.stats[STAT_STRIDE * 0 + STAT_KILLS]).toBe(2);
    expect(w.stats[STAT_STRIDE * 0 + STAT_KILL_POINTS]).toBe(2 * POINTS[KIND_INFANTRY]);
    expect(w.stats[STAT_STRIDE * 1 + STAT_LOST]).toBe(2);
    expect(w.stats[STAT_STRIDE * 1 + STAT_KILLS]).toBe(w.stats[STAT_STRIDE * 0 + STAT_LOST]);
  });

  it('gives a kill to the player who last ordered the unit, and to nobody otherwise', () => {
    const none = fight();
    for (let s = 0; s < 4; s++)
      expect(none.stats[STAT_SEAT0 + STAT_STRIDE * s + STAT_KILLS]).toBe(0);
    const w = fight(2);
    expect(w.stats[STAT_SEAT0 + STAT_STRIDE * 2 + STAT_KILLS]).toBe(2);
    expect(w.stats[STAT_SEAT0 + STAT_STRIDE * 0 + STAT_KILLS]).toBe(0);
    // A unit made later in a dead one's place starts with no name on it.
    step(w, [spawnAt(1, KIND_INFANTRY, 1, 700, 700)]);
    for (let i = 0; i < w.count; i++) if (w.team[i] === 1) expect(w.seat[i]).toBe(NO_SEAT);
  });

  it('is not part of the world hash: a name on an order changes nothing in the game', () => {
    const a = createWorld(7, flatMap());
    const b = createWorld(7, flatMap());
    step(a, [spawnAt(0, KIND_TANK, 1, 500, 500)]);
    step(b, [spawnAt(0, KIND_TANK, 1, 500, 500)]);
    step(a, [{ type: CMD_STOP, units: [0] }]);
    step(b, [{ type: CMD_STOP, units: [0], by: 3 }]);
    expect(hashWorld(a)).toBe(hashWorld(b));
  });
});
