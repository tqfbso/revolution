import { describe, expect, it } from 'vitest';
import {
  CIVILIANS,
  CIVILIAN_CREDITS,
  CIVILIAN_SUPPLIES,
  CIV_DEAD,
  CIV_FLEEING,
  CIV_GONE,
  CIV_HOME,
  SUPPLY_FLOOR,
  civiliansShelled,
} from '../src/sim/civilians';
import { CMD_SPAWN, type Command } from '../src/sim/commands';
import { fx } from '../src/sim/fixed';
import {
  MAP_CELLS,
  S_BUILDING,
  addStructure,
  addTown,
  flatMap,
  generateMap,
  refreshPassability,
} from '../src/sim/map';
import { step } from '../src/sim/sim';
import { KIND_INFANTRY } from '../src/sim/units';
import { EV_CIVILIAN, TICK_RATE, createWorld, hashWorld, type World } from '../src/sim/world';

/** A house on cells (126..128, 124..126) of an empty map: three people live in it. */
function withHouse() {
  const m = flatMap();
  addTown(m, fx(510), fx(502), fx(40), 'Test');
  addStructure(m, S_BUILDING, 126, 124, 3, 3, 0, 3);
  refreshPassability(m);
  return m;
}
const spawnAt = (team: number, kind: number, count: number, x: number, y: number): Command => ({
  type: CMD_SPAWN,
  count,
  team,
  kind,
  x: fx(x),
  y: fx(y),
  radius: fx(3),
  wander: false,
});
const states = (w: World, state: number) => {
  let n = 0;
  for (let k = 0; k < w.civCount; k++) if (w.civState[k] === state) n++;
  return n;
};

describe('civilians (decision 102)', () => {
  it('about 400 live in the houses of the city, the same ones every time', () => {
    const a = createWorld(1, generateMap(1, 'city'));
    const b = createWorld(1, generateMap(1, 'city'));
    expect(a.civCount).toBe(CIVILIANS);
    expect(states(a, CIV_HOME)).toBe(CIVILIANS);
    for (let k = 0; k < a.civCount; k++) {
      expect(a.map.sKind[a.civHome[k]]).toBe(S_BUILDING);
      expect(a.civHome[k]).toBe(b.civHome[k]);
    }
    expect(createWorld(1, flatMap()).civCount).toBe(0);
    expect(TICK_RATE).toBe(20);
  });

  it('stay indoors while it is quiet, and nobody is charged for anything', () => {
    const w = createWorld(1, withHouse());
    const before = w.supplies[0];
    for (let t = 0; t < 600; t++) step(w, []);
    expect(states(w, CIV_HOME)).toBe(w.civCount);
    expect(w.supplies[0]).toBe(before);
    expect(w.civKilled[0] + w.civKilled[1]).toBe(0);
  });

  it('run for the edge of the map when shooting starts by the house, and are gone', () => {
    const w = createWorld(1, withHouse());
    expect(w.civCount).toBe(3);
    // A firefight in the street south of the house.
    step(w, [spawnAt(0, KIND_INFANTRY, 4, 500, 530), spawnAt(1, KIND_INFANTRY, 4, 520, 530)]);
    let ran = false;
    for (let t = 0; t < 100 && !ran; t++) {
      step(w, []);
      ran = states(w, CIV_FLEEING) > 0;
    }
    expect(ran).toBe(true);
    for (let k = 0; k < w.civCount; k++) {
      if (w.civState[k] !== CIV_FLEEING) continue;
      // Out of the walls, on ground a person can stand on.
      const c = (w.civY[k] >> 12) * MAP_CELLS + (w.civX[k] >> 12);
      expect(w.map.structAt[c]).toBe(-1);
    }
    for (let t = 0; t < 250 * TICK_RATE && states(w, CIV_FLEEING) > 0; t++) step(w, []);
    expect(states(w, CIV_FLEEING)).toBe(0);
    expect(w.civEscaped + w.civKilled[0] + w.civKilled[1]).toBe(3);
    expect(states(w, CIV_GONE)).toBe(w.civEscaped);
    expect(w.civEscaped).toBeGreaterThan(0);
  });

  it('a shell on a house with people in it kills some, and the army that fired pays', () => {
    let dead = 0;
    let fled = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const w = createWorld(seed, withHouse());
      step(w, []);
      w.events.length = 0;
      const supplies = w.supplies[1];
      w.credits[1] = 500;
      civiliansShelled(w, fx(510), fx(502), fx(8), 1);
      const killed = w.civKilled[1];
      expect(w.civKilled[0]).toBe(0);
      expect(states(w, CIV_DEAD)).toBe(killed);
      expect(states(w, CIV_HOME)).toBe(0);
      expect(w.supplies[1]).toBe(supplies - killed * CIVILIAN_SUPPLIES);
      expect(w.credits[1]).toBe(500 - killed * CIVILIAN_CREDITS);
      expect(w.events.filter((v, e) => e % 3 === 0 && v === EV_CIVILIAN).length).toBe(killed);
      dead += killed;
      fled += states(w, CIV_FLEEING);
    }
    // Half and half, near enough, over eight houses of three.
    expect(dead).toBeGreaterThan(5);
    expect(fled).toBeGreaterThan(5);
  });

  it('a shell among people in the open kills those close to it, and debt has a floor', () => {
    const w = createWorld(1, withHouse());
    step(w, [spawnAt(0, KIND_INFANTRY, 3, 500, 530), spawnAt(1, KIND_INFANTRY, 3, 520, 530)]);
    for (let t = 0; t < 100 && states(w, CIV_FLEEING) < 3; t++) step(w, []);
    const k = Array.from({ length: w.civCount }, (_, i) => i).find(
      (i) => w.civState[i] === CIV_FLEEING,
    )!;
    w.supplies[0] = SUPPLY_FLOOR + 30;
    // Right on top of one of them; the next step puts the runners on the sim's list first.
    step(w, []);
    civiliansShelled(w, w.civX[k], w.civY[k], fx(8), 0);
    expect(w.civState[k]).toBe(CIV_DEAD);
    expect(w.supplies[0]).toBe(SUPPLY_FLOOR);
  });

  it('two worlds given the same battle agree about every civilian', () => {
    const run = () => {
      const w = createWorld(7, generateMap(7, 'city'));
      step(w, [spawnAt(0, KIND_INFANTRY, 30, 500, 500), spawnAt(1, KIND_INFANTRY, 30, 530, 520)]);
      for (let t = 0; t < 900; t++) step(w, []);
      return w;
    };
    const a = run();
    const b = run();
    expect(states(a, CIV_FLEEING) + states(a, CIV_GONE) + states(a, CIV_DEAD)).toBeGreaterThan(0);
    expect(hashWorld(a)).toBe(hashWorld(b));
    expect(Array.from(a.civKilled)).toEqual(Array.from(b.civKilled));
  });
});
