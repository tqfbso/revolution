import { describe, expect, it } from 'vitest';
import { CIV_DEAD, CIV_HOME } from '../src/sim/civilians';
import {
  CMD_ATTACK_STRUCTURE,
  CMD_FELL,
  CMD_MOVE,
  CMD_SPAWN,
  type Command,
} from '../src/sim/commands';
import { FELL_CELLS, nextTree } from '../src/sim/demolish';
import { fx } from '../src/sim/fixed';
import {
  CLASS_VEHICLE,
  MAP_CELLS,
  S_BUILDING,
  T_FOREST,
  T_OPEN,
  addStructure,
  addTown,
  flatMap,
  layerOf,
  refreshPassability,
} from '../src/sim/map';
import { step } from '../src/sim/sim';
import { KIND_ENGINEER, KIND_INFANTRY, KIND_TANK } from '../src/sim/units';
import {
  EV_FELL,
  JOB_NONE,
  STATE_ALIVE,
  createWorld,
  hashWorld,
  type World,
} from '../src/sim/world';

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

/** A belt of wood three cells deep right across an empty map, at cells y = 120..122. */
function withWood() {
  const m = flatMap();
  for (let y = 120; y <= 122; y++) {
    for (let x = 0; x < MAP_CELLS; x++) {
      m.type[y * MAP_CELLS + x] = T_FOREST;
      m.baseType[y * MAP_CELLS + x] = T_FOREST;
    }
  }
  refreshPassability(m);
  return m;
}

function felling(seed: number): { w: World; fell: number } {
  const w = createWorld(seed, withWood());
  step(w, [spawnAt(0, KIND_ENGINEER, 2, 502, 470)]);
  const ids = [0, 1];
  step(w, [{ type: CMD_FELL, units: ids, x: fx(502), y: fx(486) }]);
  let fell = 0;
  for (let t = 0; t < 1600; t++) {
    step(w, []);
    for (let e = 0; e < w.events.length; e += 3) if (w.events[e] === EV_FELL) fell++;
    w.events.length = 0;
  }
  return { w, fell };
}

describe('engineers fell trees (decision 118)', () => {
  it('a patch of wood becomes open ground: tanks get through', () => {
    const { w, fell } = felling(4);
    const m = w.map;
    const at = 121 * MAP_CELLS + 125;
    const veh = layerOf(0, CLASS_VEHICLE);
    // Everything within FELL_CELLS of the cell clicked, and nothing beyond it.
    expect(nextTree(w, at, fx(502), fx(486))).toBe(-1);
    expect(fell).toBe(w.felledCount);
    expect(fell).toBe(3 * (2 * FELL_CELLS + 1));
    for (let y = 120; y <= 122; y++) {
      expect(m.type[y * MAP_CELLS + 125]).toBe(T_OPEN);
      expect(m.cost[veh][y * MAP_CELLS + 125]).toBeGreaterThan(0);
      expect(m.type[y * MAP_CELLS + 125 + FELL_CELLS + 1]).toBe(T_FOREST);
      expect(m.cost[veh][y * MAP_CELLS + 125 + FELL_CELLS + 1]).toBe(0);
    }
    expect(w.job[0]).toBe(JOB_NONE);
    // A tank sent to the far side drives through the lane.
    step(w, [spawnAt(0, KIND_TANK, 1, 502, 460)]);
    const tank = w.count - 1;
    step(w, [{ type: CMD_MOVE, units: [tank], x: fx(502), y: fx(510) }]);
    for (let t = 0; t < 400; t++) step(w, []);
    expect(w.posY[tank]).toBeGreaterThan(fx(500));
  });

  it('is the same on two machines', () => {
    expect(hashWorld(felling(4).w)).toBe(hashWorld(felling(4).w));
  });

  it('only engineers do it, and only where there are trees', () => {
    const w = createWorld(4, withWood());
    step(w, [spawnAt(0, KIND_INFANTRY, 2, 502, 470), spawnAt(0, KIND_ENGINEER, 1, 300, 300)]);
    step(w, [
      { type: CMD_FELL, units: [0, 1], x: fx(502), y: fx(486) },
      { type: CMD_FELL, units: [2], x: fx(300), y: fx(320) },
    ]);
    for (let t = 0; t < 400; t++) step(w, []);
    expect(w.felledCount).toBe(0);
    expect(w.job[2]).toBe(JOB_NONE);
  });
});

describe('a house brought down on the people in it (decision 118)', () => {
  /** A house on cells (126..128, 124..126) of an empty map: three people live in it. */
  function withHouse() {
    const m = flatMap();
    addTown(m, fx(510), fx(502), fx(40), 'Test');
    addStructure(m, S_BUILDING, 126, 124, 3, 3, 0, 3);
    refreshPassability(m);
    return m;
  }
  const count = (w: World, state: number) => {
    let n = 0;
    for (let k = 0; k < w.civCount; k++) if (w.civState[k] === state) n++;
    return n;
  };

  it('engineers laying charges give no warning: some die under it, and the army pays', () => {
    let dead = 0;
    let seeds = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const w = createWorld(seed, withHouse());
      expect(count(w, CIV_HOME)).toBe(3);
      step(w, [spawnAt(0, KIND_ENGINEER, 2, 500, 520)]);
      const before = w.supplies[0];
      step(w, [{ type: CMD_ATTACK_STRUCTURE, units: [0, 1], structure: 0 }]);
      for (let t = 0; t < 1200 && w.sHp[0] > 0; t++) step(w, []);
      expect(w.sHp[0]).toBe(0);
      expect(count(w, CIV_HOME)).toBe(0);
      expect(w.civKilled[0]).toBe(count(w, CIV_DEAD));
      expect(w.civKilled[1]).toBe(0);
      if (w.civKilled[0] > 0) {
        expect(w.supplies[0]).toBeLessThan(before);
        seeds++;
      }
      dead += w.civKilled[0];
      expect(w.state[0]).toBe(STATE_ALIVE);
    }
    // Half of those at home at each of the two falls (floors, then walls): about nine of
    // eighteen over six houses.
    expect(dead).toBeGreaterThanOrEqual(5);
    expect(dead).toBeLessThanOrEqual(15);
    expect(seeds).toBeGreaterThanOrEqual(4);
  });
});
