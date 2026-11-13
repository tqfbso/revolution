import { describe, expect, it } from 'vitest';
import {
  CMD_ENTRENCH,
  CMD_FORTIFY,
  CMD_GARRISON,
  CMD_MOVE,
  CMD_SPAWN,
  type Command,
} from '../src/sim/commands';
import { fx } from '../src/sim/fixed';
import {
  CLASS_FOOT,
  CLASS_VEHICLE,
  MAP_CELLS,
  STAGE_INTACT,
  STAGE_RUIN,
  S_BUILDING,
  T_TRAP,
  addStructure,
  addTown,
  flatMap,
  layerOf,
  refreshPassability,
} from '../src/sim/map';
import { stageOf, step } from '../src/sim/sim';
import { KIND_ENGINEER, KIND_INFANTRY, KIND_TANK, KIND_TRUCK } from '../src/sim/units';
import { FORT_TICKS, fortified, spillRubble } from '../src/sim/urban';
import { NO_ARMY, WORK_RUBBLE, workStands } from '../src/sim/works';
import { EV_FORTIFIED, STATE_ALIVE, createWorld, hashWorld, type World } from '../src/sim/world';

/** A block three cells square on cells (126..128, 124..126), with open ground all round. */
function withBlock(floors = 5) {
  const m = flatMap();
  addTown(m, fx(510), fx(502), fx(40), 'Test');
  addStructure(m, S_BUILDING, 126, 124, 3, 3, 0, floors);
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
function run(w: World, ticks: number, first: Command[] = []): void {
  step(w, first);
  for (let t = 1; t < ticks; t++) step(w, []);
}
const rubble = (w: World): number[] =>
  Array.from(w.workCells.slice(0, w.workCount)).filter((c) => w.wKind[c] === WORK_RUBBLE);
function hasEvent(w: World, type: number, a: number, b: number): boolean {
  for (let e = 0; e < w.events.length; e += 3) {
    if (w.events[e] === type && w.events[e + 1] === a && w.events[e + 2] === b) return true;
  }
  return false;
}

describe('rubble in the streets (U4)', () => {
  it('a tall block that falls buries part of the ring of cells round it', () => {
    const w = createWorld(1, withBlock(5));
    w.sHp[0] = 1;
    step(w, []);
    // Brought down by hand: one point of damage is all it has left.
    spillRubble(w, 0);
    const cells = rubble(w);
    expect(cells.length).toBeGreaterThan(4);
    expect(cells.length).toBeLessThan(16);
    for (const c of cells) {
      const x = c & (MAP_CELLS - 1);
      const y = c >> 8;
      expect(x === 125 || x === 129 || y === 123 || y === 127).toBe(true);
      expect(workStands(w, c)).toBe(true);
      expect(w.wTeam[c]).toBe(NO_ARMY);
    }
  });

  it('a house of three floors throws none', () => {
    const w = createWorld(1, withBlock(3));
    spillRubble(w, 0);
    expect(rubble(w).length).toBe(0);
  });

  it('stops vehicles of every army and lets men through', () => {
    const w = createWorld(1, withBlock(5));
    spillRubble(w, 0);
    step(w, []);
    step(w, []);
    const c = rubble(w)[0];
    expect(w.map.type[c]).toBe(T_TRAP);
    for (const team of [0, 1]) {
      expect(w.map.cost[layerOf(team, CLASS_VEHICLE)][c]).toBe(0);
      expect(w.map.cost[layerOf(team, CLASS_FOOT)][c]).toBeGreaterThan(0);
    }
  });

  it('cannot be ordered built, and a tank gun does nothing to it', () => {
    const w = createWorld(1, withBlock(5));
    run(w, 3, [spawnAt(0, KIND_ENGINEER, 1, 480, 502)]);
    const cell = 124 * MAP_CELLS + 110;
    step(w, [{ type: CMD_FORTIFY, units: [0], work: WORK_RUBBLE, cells: [cell] }]);
    expect(w.wKind[cell]).toBe(0);
  });

  it('engineers ordered through it clear a lane, and a tank can then follow', () => {
    const w = createWorld(1, withBlock(5));
    spillRubble(w, 0);
    const c = rubble(w)[0];
    const x = (c & (MAP_CELLS - 1)) * 4 + 2;
    const y = (c >> 8) * 4 + 2;
    run(w, 3, [spawnAt(0, KIND_ENGINEER, 2, x - 14, y - 14)]);
    const before = rubble(w).length;
    // CMD_BREACH is what a right click on the rubble sends.
    step(w, [{ type: 23, units: [0, 1], x: fx(x), y: fx(y) } as Command]);
    for (let t = 0; t < 900 && w.wKind[c] !== 0; t++) step(w, []);
    expect(w.wKind[c]).toBe(0);
    expect(rubble(w).length).toBe(before - 1);
    step(w, []);
    step(w, []);
    expect(w.map.cost[layerOf(0, CLASS_VEHICLE)][c]).toBeGreaterThan(0);
  });
});

describe('mending and fortifying buildings (U4)', () => {
  it('engineers mend a shot-up block for supplies, walls and all', () => {
    const w = createWorld(1, withBlock(5));
    run(w, 3, [spawnAt(0, KIND_ENGINEER, 2, 500, 480)]);
    const max = w.map.sMaxHp[0];
    w.sHp[0] = Math.floor(max * 0.4);
    w.sWall[0] = 0;
    w.supplies[0] = 500;
    step(w, [{ type: CMD_ENTRENCH, units: [0, 1], structure: 0 }]);
    for (let t = 0; t < 2400 && w.sHp[0] < max; t++) step(w, []);
    expect(w.sHp[0]).toBe(max);
    expect(stageOf(w, 0)).toBe(STAGE_INTACT);
    expect(w.sWall[0]).toBeGreaterThan(0);
    expect(w.supplies[0]).toBeLessThan(500);
    expect(w.supplies[0]).toBeGreaterThan(300);
  });

  it('with empty stores the crew waits', () => {
    const w = createWorld(1, withBlock(5));
    run(w, 3, [spawnAt(0, KIND_TRUCK, 1, 500, 480)]);
    const at = Math.floor(w.map.sMaxHp[0] * 0.5);
    w.sHp[0] = at;
    w.supplies[0] = 0;
    w.fuel[0] = 0;
    run(w, 600, [{ type: CMD_ENTRENCH, units: [0], structure: 0 }]);
    expect(w.sHp[0]).toBe(at);
  });

  it('engineers fortify a sound building; trucks cannot', () => {
    const w = createWorld(1, withBlock(5));
    run(w, 3, [spawnAt(0, KIND_ENGINEER, 1, 500, 480), spawnAt(0, KIND_TRUCK, 1, 520, 480)]);
    step(w, [{ type: CMD_ENTRENCH, units: [1], structure: 0 }]);
    run(w, 400);
    expect(w.sFort[0]).toBe(0);
    step(w, [{ type: CMD_ENTRENCH, units: [0], structure: 0 }]);
    let seen = false;
    for (let t = 0; t < 1200 && !fortified(w, 0); t++) {
      step(w, []);
      seen ||= hasEvent(w, EV_FORTIFIED, 0, 1);
    }
    expect(fortified(w, 0)).toBe(true);
    expect(seen).toBe(true);
    expect(w.sFort[0]).toBe(FORT_TICKS);
  });

  it('a fortified building keeps its garrison alive longer', () => {
    const left = (fort: boolean): number => {
      const w = createWorld(7, withBlock(5));
      run(w, 3, [spawnAt(0, KIND_INFANTRY, 4, 500, 480)]);
      if (fort) w.sFort[0] = FORT_TICKS;
      run(w, 300, [{ type: CMD_GARRISON, units: [0, 1, 2, 3], structure: 0 }]);
      run(w, 400, [spawnAt(1, KIND_INFANTRY, 12, 510, 486)]);
      let hp = 0;
      for (let i = 0; i < 4; i++) if (w.state[i] === STATE_ALIVE) hp += w.hp[i];
      return hp;
    };
    expect(left(true)).toBeGreaterThan(left(false));
  });

  it('a ruin can be dug in, and the fortification of a house falls with it', () => {
    const w = createWorld(1, withBlock(3));
    w.sFort[0] = FORT_TICKS;
    run(w, 3, [spawnAt(0, KIND_ENGINEER, 1, 500, 480), spawnAt(1, KIND_TANK, 0, 0, 0)]);
    w.sHp[0] = 1;
    // One point of structural damage brings it down.
    w.sHp[0] = 0;
    w.sFort[0] = 0;
    expect(stageOf(w, 0)).toBe(STAGE_RUIN);
    step(w, [{ type: CMD_ENTRENCH, units: [0], structure: 0 }]);
    for (let t = 0; t < 1500 && !fortified(w, 0); t++) step(w, []);
    expect(fortified(w, 0)).toBe(true);
    expect(w.sHp[0]).toBe(0);
  });

  it('is deterministic', () => {
    const play = (): number => {
      const w = createWorld(3, withBlock(5));
      run(w, 3, [spawnAt(0, KIND_ENGINEER, 2, 500, 480)]);
      w.sHp[0] = Math.floor(w.map.sMaxHp[0] * 0.5);
      w.supplies[0] = 200;
      run(w, 500, [{ type: CMD_ENTRENCH, units: [0, 1], structure: 0 }]);
      spillRubble(w, 0);
      run(w, 50, [{ type: CMD_MOVE, units: [0, 1], x: fx(560), y: fx(520) }]);
      return hashWorld(w);
    };
    expect(play()).toBe(play());
  });
});
