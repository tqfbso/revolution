// I3 (decision 145): high-explosive direct fire bursts among men in the open, and every
// rifle squad has a machine gun that pins.
import { describe, expect, it } from 'vitest';
import { CMD_MOVE, CMD_SPAWN, type Command } from '../src/sim/commands';
import { fx } from '../src/sim/fixed';
import { T_RUBBLE, T_TRENCH, cellOfPos, flatMap } from '../src/sim/map';
import { step } from '../src/sim/sim';
import { KINDS, KIND_ATGM, KIND_HELI, KIND_INFANTRY, KIND_TANK, PIN_TICKS } from '../src/sim/units';
import { createWorld, type World } from '../src/sim/world';

const spawnAt = (team: number, kind: number, x: number, y: number): Command => ({
  type: CMD_SPAWN,
  count: 1,
  team,
  kind,
  x: fx(x),
  y: fx(y),
  radius: fx(1),
  wander: false,
});
const put = (w: World, i: number, x: number, y: number) => {
  w.posX[i] = w.targetX[i] = fx(x);
  w.posY[i] = w.targetY[i] = fx(y);
};
const FULL = KINDS[KIND_INFANTRY].hp;

/**
 * A shooter of army 0 at (500, 500) and three squads of army 1 holding their fire: the one
 * it aims at 20 away, one 2 behind that, one 8 behind. Runs until the first shot lands.
 */
function firstShot(shooter: number, prepare?: (w: World) => void): World {
  const w = createWorld(5, flatMap());
  step(w, [
    spawnAt(0, shooter, 500, 500),
    spawnAt(1, KIND_INFANTRY, 520, 500),
    spawnAt(1, KIND_INFANTRY, 522, 500),
    spawnAt(1, KIND_INFANTRY, 528, 500),
    spawnAt(0, KIND_INFANTRY, 520, 502),
  ]);
  put(w, 0, 500, 500);
  put(w, 1, 520, 500);
  put(w, 2, 522, 500);
  put(w, 3, 528, 500);
  // One of the shooter's own squads right beside the target, holding its fire too.
  put(w, 4, 520, 502);
  for (let i = 1; i <= 4; i++) w.stance[i] = 1;
  prepare?.(w);
  for (let t = 0; t < 200 && w.hp[1] === FULL; t++) step(w, []);
  return w;
}

describe('high explosive among men in the open', () => {
  it('a tank round hurts the squad beside its target, not one further off, not its own', () => {
    const w = firstShot(KIND_TANK);
    expect(w.hp[1]).toBe(FULL - KINDS[KIND_TANK].damage[KIND_INFANTRY]);
    const beside = FULL - w.hp[2];
    expect(beside).toBeGreaterThanOrEqual(15);
    expect(beside).toBeLessThan(KINDS[KIND_TANK].burstDamage);
    expect(w.hp[3]).toBe(FULL);
    expect(w.hp[4]).toBe(FULL);
  });

  it('helicopter rockets burst too; a rifle does not', () => {
    expect(FULL - firstShot(KIND_HELI).hp[2]).toBeGreaterThanOrEqual(10);
    // (A missile's burst is for the men standing round the vehicle it hits.)
    expect(KINDS[KIND_ATGM].burst).toBeGreaterThan(0);
    expect(firstShot(KIND_INFANTRY, (w) => put(w, 0, 510, 500)).hp[2]).toBe(FULL);
  });

  it('a ruin halves it and a trench quarters it', () => {
    const open = FULL - firstShot(KIND_TANK).hp[2];
    const under = (type: number) =>
      FULL -
      firstShot(KIND_TANK, (w) => {
        w.map.type[cellOfPos(fx(522), fx(500))] = type;
        // (The target itself stays in the open, a cell away.)
        put(w, 1, 517, 500);
        put(w, 2, 521, 500);
      }).hp[2];
    const plain =
      FULL - firstShot(KIND_TANK, (w) => (put(w, 1, 517, 500), put(w, 2, 521, 500))).hp[2];
    expect(open).toBeGreaterThan(0);
    expect(under(T_RUBBLE)).toBe(plain >> 1);
    expect(under(T_TRENCH)).toBe(plain >> 2);
  });
});

describe("the squad's machine gun", () => {
  /** Squad 0 of army 0 fires at squad 1 of army 1, which holds its fire, 10 away. */
  function duel(prepare?: (w: World) => void): World {
    const w = createWorld(5, flatMap());
    step(w, [spawnAt(0, KIND_INFANTRY, 500, 500), spawnAt(1, KIND_INFANTRY, 510, 500)]);
    put(w, 0, 500, 500);
    put(w, 1, 510, 500);
    w.stance[1] = 1;
    prepare?.(w);
    for (let t = 0; t < 200 && w.hp[1] === FULL; t++) step(w, []);
    return w;
  }

  it('pins men caught in the open: they move at half speed until it lets up', () => {
    const w = duel();
    expect(w.pinned[1]).toBe(w.tick - 1 + PIN_TICKS);
    const walk = (pinned: boolean) => {
      const v = duel();
      if (!pinned) v.pinned[1] = 0;
      v.stance[0] = 1;
      const from = v.posY[1];
      step(v, [{ type: CMD_MOVE, units: [1], x: fx(510), y: fx(560) }]);
      for (let t = 0; t < 20; t++) step(v, []);
      return v.posY[1] - from;
    };
    const free = walk(false);
    const held = walk(true);
    expect(free).toBeGreaterThan(fx(2));
    expect(held).toBeLessThan((free * 6) / 10);
    expect(held).toBeGreaterThan((free * 4) / 10);
  });

  it('does not pin men in a trench', () => {
    const w = duel((v) => (v.map.type[cellOfPos(fx(510), fx(500))] = T_TRENCH));
    expect(w.hp[1]).toBeLessThan(FULL);
    expect(w.pinned[1]).toBe(0);
  });

  it('does a third more from a rest', () => {
    const base = KINDS[KIND_INFANTRY].damage[KIND_INFANTRY];
    expect(FULL - duel().hp[1]).toBe(base);
    const rested = duel((v) => (v.map.type[cellOfPos(fx(500), fx(500))] = T_TRENCH));
    expect(FULL - rested.hp[1]).toBe(Math.trunc((base * 133) / 100));
  });
});
