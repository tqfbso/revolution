import { describe, expect, it } from 'vitest';
import { CMD_ATTACK_STRUCTURE, CMD_GARRISON, CMD_SPAWN, type Command } from '../src/sim/commands';
import { fx } from '../src/sim/fixed';
import {
  BUILD_BLOCK,
  BUILD_HALL,
  BUILD_HOUSE,
  FACE_EAST,
  FACE_NORTH,
  FACE_WEST,
  STAGE_DAMAGED,
  STAGE_GUTTED,
  STAGE_INTACT,
  STAGE_RUIN,
  S_BUILDING,
  T_RUBBLE,
  addStructure,
  addTown,
  buildClass,
  cellOfPos,
  flatMap,
  refreshPassability,
  wallMax,
} from '../src/sim/map';
import { faceToward, stageOf, step } from '../src/sim/sim';
import { KINDS, KIND_ENGINEER, KIND_INFANTRY, KIND_TANK } from '../src/sim/units';
import {
  EV_COLLAPSE,
  EV_GUTTED,
  EV_WALL,
  STATE_ALIVE,
  createWorld,
  type World,
} from '../src/sim/world';

const FULL = KINDS[KIND_INFANTRY].hp;

/** A two by two house of three floors on cells (126..127, 124..125): 504..512 by 496..504. */
function withHouse(w = 2, h = 2, floors = 3) {
  const m = flatMap();
  addTown(m, fx(508), fx(500), fx(30), 'Test');
  addStructure(m, S_BUILDING, 126, 124, w, h, 0, floors);
  refreshPassability(m);
  return m;
}
function spawnAt(team: number, kind: number, count: number, x: number, y: number): Command {
  return { type: CMD_SPAWN, count, team, kind, x: fx(x), y: fx(y), radius: fx(4), wander: false };
}
function events(w: World, type: number): number[][] {
  const out: number[][] = [];
  for (let e = 0; e < w.events.length; e += 3) {
    if (w.events[e] === type) out.push([w.events[e + 1], w.events[e + 2]]);
  }
  return out;
}

describe('buildings that die slowly (U1)', () => {
  it('come in three classes, each far tougher than the old 220 a cell', () => {
    expect(buildClass(2, 2, 3)).toBe(BUILD_HOUSE);
    expect(buildClass(2, 3, 5)).toBe(BUILD_BLOCK);
    expect(buildClass(3, 3, 2)).toBe(BUILD_HALL);
    expect(withHouse(2, 2, 3).sMaxHp[0]).toBe(450 * 4);
    expect(withHouse(2, 2, 4).sMaxHp[0]).toBe(900 * 4);
    expect(withHouse(3, 3, 2).sMaxHp[0]).toBe(1300 * 9);
  });

  it('a shot meets the face it comes from', () => {
    const m = withHouse();
    expect(faceToward(m, 0, fx(540), fx(500))).toBe(FACE_EAST);
    expect(faceToward(m, 0, fx(480), fx(503))).toBe(FACE_WEST);
    expect(faceToward(m, 0, fx(509), fx(470))).toBe(FACE_NORTH);
  });

  it('a lone tank breaches the wall in seconds but needs minutes to gut the house', () => {
    const w = createWorld(1, withHouse());
    step(w, [spawnAt(1, KIND_TANK, 1, 535, 500)]);
    step(w, [{ type: CMD_ATTACK_STRUCTURE, units: [0], structure: 0 }]);
    w.events.length = 0;
    let breached = -1;
    let gutted = -1;
    for (let t = 0; t < 6000 && gutted < 0; t++) {
      step(w, []);
      if (breached < 0 && events(w, EV_WALL).length > 0) {
        breached = t;
        expect(events(w, EV_WALL)[0]).toEqual([0, FACE_EAST]);
      }
      if (events(w, EV_GUTTED).length > 0) gutted = t;
    }
    // The east wall is open within half a minute; the other three stand.
    expect(breached).toBeGreaterThan(0);
    expect(breached).toBeLessThan(600);
    expect(w.sWall[FACE_EAST]).toBe(0);
    expect(w.sWall[FACE_WEST]).toBe(wallMax(w.map, 0, FACE_WEST));
    // About four minutes to gut it, and it is still not a ruin.
    expect(gutted).toBeGreaterThan(3 * 1200);
    expect(gutted).toBeLessThan(5 * 1200);
    expect(stageOf(w, 0)).toBe(STAGE_GUTTED);
    expect(events(w, EV_COLLAPSE).length).toBe(0);
  });

  it('an engineer charge goes into the structure, not into a wall', () => {
    const w = createWorld(1, withHouse());
    step(w, [spawnAt(1, KIND_ENGINEER, 1, 516, 500)]);
    step(w, [{ type: CMD_ATTACK_STRUCTURE, units: [0], structure: 0 }]);
    for (let t = 0; t < 400; t++) step(w, []);
    expect(w.sHp[0]).toBeLessThan(w.map.sMaxHp[0] - 80);
    expect(w.sWall[FACE_EAST]).toBe(wallMax(w.map, 0, FACE_EAST));
  });

  it('protects its garrison less with every state, and not at all through a breached wall', () => {
    // The squad's loss to one tank in a fixed time, with the house in a given condition.
    const loss = (prepare: (w: World) => void) => {
      const w = createWorld(1, withHouse());
      step(w, [spawnAt(0, KIND_INFANTRY, 1, 500, 500)]);
      step(w, [{ type: CMD_GARRISON, units: [0], structure: 0 }]);
      for (let t = 0; t < 200; t++) step(w, []);
      expect(w.inside[0]).toBe(0);
      prepare(w);
      // Close enough to see the men in the house.
      step(w, [spawnAt(1, KIND_TANK, 1, 522, 500)]);
      w.hp[1] = 30000;
      for (let t = 0; t < 130; t++) step(w, []);
      return FULL - w.hp[0];
    };
    const intact = loss(() => {});
    const damaged = loss((w) => (w.sHp[0] = Math.trunc(w.map.sMaxHp[0] * 0.6)));
    const breached = loss((w) => (w.sWall[FACE_EAST] = 0));
    const farSide = loss((w) => (w.sWall[FACE_WEST] = 0));
    expect(intact).toBeGreaterThan(0);
    expect(damaged).toBeGreaterThan(intact);
    expect(breached).toBeGreaterThan(intact);
    // A hole in the wall behind them does nothing for a tank in front.
    expect(farSide).toBe(intact);
  });

  it('loses a quarter of the garrison when gutted and a quarter when it falls', () => {
    const w = createWorld(1, withHouse());
    step(w, [spawnAt(0, KIND_INFANTRY, 1, 500, 500)]);
    step(w, [{ type: CMD_GARRISON, units: [0], structure: 0 }]);
    for (let t = 0; t < 200; t++) step(w, []);
    step(w, [spawnAt(1, KIND_ENGINEER, 1, 516, 500)]);
    w.hp[1] = 30000;
    w.stance[1] = 1;
    const max = w.map.sMaxHp[0];
    expect(stageOf(w, 0)).toBe(STAGE_INTACT);
    w.sHp[0] = Math.trunc(max * 0.5);
    expect(stageOf(w, 0)).toBe(STAGE_DAMAGED);
    // One charge short of gutted.
    w.sHp[0] = Math.trunc(max * 0.35) + 40;
    step(w, [{ type: CMD_ATTACK_STRUCTURE, units: [1], structure: 0 }]);
    w.events.length = 0;
    for (let t = 0; t < 400 && stageOf(w, 0) < STAGE_GUTTED; t++) step(w, []);
    expect(stageOf(w, 0)).toBe(STAGE_GUTTED);
    expect(events(w, EV_GUTTED).length).toBe(1);
    // Still inside, a quarter down: the shell is a position.
    expect(w.inside[0]).toBe(0);
    const gutted = FULL - (FULL >> 2);
    expect(w.hp[0]).toBe(gutted);
    w.sHp[0] = 40;
    for (let t = 0; t < 400 && stageOf(w, 0) < STAGE_RUIN; t++) step(w, []);
    expect(stageOf(w, 0)).toBe(STAGE_RUIN);
    expect(w.state[0]).toBe(STATE_ALIVE);
    expect(w.inside[0]).toBe(-1);
    expect(w.hp[0]).toBe(gutted - (gutted >> 2));
    // What is left is rubble, and rubble cannot be destroyed.
    const cell = cellOfPos(fx(506), fx(498));
    expect(w.map.type[cell]).toBe(T_RUBBLE);
    for (let t = 0; t < 600; t++) step(w, []);
    expect(w.map.type[cell]).toBe(T_RUBBLE);
    expect(w.sHp[0]).toBe(0);
  });
});
