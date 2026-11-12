import { describe, expect, it } from 'vitest';
import {
  CMD_BREACH,
  CMD_DEMOLISH,
  CMD_FIELDWORK,
  CMD_FORTIFY,
  CMD_MOVE,
  CMD_OCCUPY,
  CMD_SPAWN,
  type Command,
} from '../src/sim/commands';
import { fx } from '../src/sim/fixed';
import {
  CLASS_FOOT,
  CLASS_VEHICLE,
  MAP_CELLS,
  T_OPEN,
  T_TRENCH,
  T_WALL,
  cellOfPos,
  flatMap,
  layerOf,
  lineOfSight,
} from '../src/sim/map';
import { step } from '../src/sim/sim';
import {
  EYE_HEIGHT,
  KINDS,
  KIND_ARTILLERY,
  KIND_ENGINEER,
  KIND_INFANTRY,
  KIND_TANK,
  KIND_TRUCK,
} from '../src/sim/units';
import {
  WORKS,
  WORK_GATE,
  WORK_SANDBAG,
  WORK_TRAP,
  WORK_TRENCH,
  WORK_WALL,
  WORK_WIRE,
  canFortify,
  workStands,
} from '../src/sim/works';
import {
  FLAG_BREACH,
  FLAG_HOLD,
  FLAG_MOVING,
  JOB_NONE,
  STATE_ALIVE,
  createWorld,
  hashWorld,
  type World,
} from '../src/sim/world';

const at = (cx: number, cy: number) => cy * MAP_CELLS + cx;
const mid = (c: number) => fx(c * 4 + 2);

const spawn = (team: number, kind: number, cx: number, cy: number, count = 1): Command => ({
  type: CMD_SPAWN,
  count,
  team,
  kind,
  x: mid(cx),
  y: mid(cy),
  radius: 1,
  wander: false,
});

/** Spawning scatters; put the units of a fresh world exactly on cell centres. */
function place(w: World, id: number, cx: number, cy: number): void {
  w.posX[id] = mid(cx);
  w.posY[id] = mid(cy);
}

const works = (team: number, work: number, cells: number[]): Command => ({
  type: CMD_FIELDWORK,
  team,
  work,
  cells,
});

/** A closed ring of `work` around cell (cx, cy), `r` cells out. */
function ring(cx: number, cy: number, r: number): number[] {
  const cells: number[] = [];
  for (let d = -r; d <= r; d++) {
    cells.push(at(cx + d, cy - r), at(cx + d, cy + r));
    if (d > -r && d < r) cells.push(at(cx - r, cy + d), at(cx + r, cy + d));
  }
  return cells;
}

function run(w: World, ticks: number, commands: Command[] = []): void {
  step(w, commands);
  for (let t = 1; t < ticks; t++) step(w, []);
}

const cellOf = (w: World, id: number) => cellOfPos(w.posX[id], w.posY[id]);

describe('field works', () => {
  it('a wall stops both kinds of ground unit and is walked around', () => {
    const w = createWorld(3, flatMap());
    // A wall 21 cells long across the way from x = 100 to x = 140.
    const wall: number[] = [];
    for (let y = 90; y <= 110; y++) wall.push(at(120, y));
    run(w, 2, [
      works(1, WORK_WALL, wall),
      spawn(0, KIND_TANK, 100, 100),
      spawn(0, KIND_INFANTRY, 100, 101),
    ]);
    for (const c of wall) {
      expect(w.map.type[c]).toBe(T_WALL);
      expect(w.map.cost[layerOf(0, CLASS_VEHICLE)][c]).toBe(0);
      expect(w.map.cost[layerOf(0, CLASS_FOOT)][c]).toBe(0);
    }
    step(w, [{ type: CMD_MOVE, units: [0, 1], x: mid(140), y: mid(100) }]);
    let crossed = false;
    for (let t = 0; t < 4000; t++) {
      step(w, []);
      for (const id of [0, 1]) if (w.map.type[cellOf(w, id)] === T_WALL) crossed = true;
    }
    expect(crossed).toBe(false);
    // Both got there, round the end of it, and the wall still stands.
    for (const id of [0, 1]) expect(w.posX[id]).toBeGreaterThan(mid(134));
    expect(w.workCount).toBe(wall.length);
  });

  it('into a sealed ring: the tank shoots its way in, the squad waits and then follows', () => {
    const w = createWorld(3, flatMap());
    run(w, 2, [
      works(1, WORK_WALL, ring(140, 100, 3)),
      spawn(0, KIND_TANK, 100, 100),
      spawn(0, KIND_INFANTRY, 100, 102),
    ]);
    step(w, [{ type: CMD_MOVE, units: [0, 1], x: mid(140), y: mid(100) }]);
    let breaching = false;
    for (let t = 0; t < 3000; t++) {
      step(w, []);
      if ((w.flags[0] & FLAG_BREACH) !== 0) breaching = true;
    }
    expect(breaching).toBe(true);
    expect(w.workCount).toBeLessThan(ring(140, 100, 3).length);
    for (const id of [0, 1]) {
      expect(Math.abs(w.posX[id] - mid(140))).toBeLessThan(fx(6));
      expect(Math.abs(w.posY[id] - mid(100))).toBeLessThan(fx(6));
      expect(w.flags[id] & (FLAG_MOVING | FLAG_BREACH)).toBe(0);
    }
  });

  it('a squad alone cannot get through a wall: it goes up to it and waits', () => {
    const w = createWorld(3, flatMap());
    const cells = ring(140, 100, 3);
    run(w, 2, [works(1, WORK_WALL, cells), spawn(0, KIND_INFANTRY, 120, 100)]);
    run(w, 1500, [{ type: CMD_MOVE, units: [0], x: mid(140), y: mid(100) }]);
    expect(w.workCount).toBe(cells.length);
    expect(w.posX[0]).toBeGreaterThan(mid(134));
    expect(w.posX[0]).toBeLessThan(mid(137));
  });

  it('a gate lets its owner through and nobody else', () => {
    const w = createWorld(3, flatMap());
    const cells = ring(140, 100, 3).filter((c) => c !== at(137, 100));
    run(w, 2, [
      works(1, WORK_WALL, cells),
      works(1, WORK_GATE, [at(137, 100)]),
      spawn(1, KIND_INFANTRY, 120, 100),
      spawn(0, KIND_INFANTRY, 120, 120),
    ]);
    place(w, 0, 120, 100);
    expect(w.map.cost[layerOf(1, CLASS_FOOT)][at(137, 100)]).toBe(1);
    expect(w.map.cost[layerOf(0, CLASS_FOOT)][at(137, 100)]).toBe(0);
    // Hold fire, so the two squads do not turn this into a firefight.
    w.stance[0] = w.stance[1] = 1;
    run(w, 2500, [
      { type: CMD_MOVE, units: [0], x: mid(140), y: mid(100) },
      { type: CMD_MOVE, units: [1], x: mid(140), y: mid(100) },
    ]);
    expect(Math.abs(w.posX[0] - mid(140))).toBeLessThan(fx(3));
    // The other squad came up from the south and stands outside the south wall.
    expect(w.posY[1]).toBeGreaterThan(mid(103) + fx(2));
    expect(w.posY[1]).toBeLessThan(mid(106));
    expect(w.workCount).toBe(cells.length + 1);
  });

  it('wire stops infantry; a tank drives over it and leaves a gap', () => {
    const w = createWorld(3, flatMap());
    const cells = ring(140, 100, 3);
    run(w, 2, [
      works(1, WORK_WIRE, cells),
      spawn(0, KIND_INFANTRY, 125, 100),
      spawn(0, KIND_TANK, 100, 100),
    ]);
    expect(w.map.cost[layerOf(0, CLASS_FOOT)][cells[0]]).toBe(0);
    expect(w.map.cost[layerOf(0, CLASS_VEHICLE)][cells[0]]).toBe(1);
    run(w, 600, [{ type: CMD_MOVE, units: [0], x: mid(140), y: mid(100) }]);
    expect(w.posX[0]).toBeLessThan(mid(137));
    expect(w.workCount).toBe(cells.length);
    run(w, 1500, [{ type: CMD_MOVE, units: [1], x: mid(140), y: mid(100) }]);
    expect(w.workCount).toBeLessThan(cells.length);
    // The squad was waiting at the wire and goes through the gap the tank made.
    expect(Math.abs(w.posX[0] - mid(140))).toBeLessThan(fx(6));
  });

  it('obstacles stop vehicles, not men; engineers blow them up', () => {
    const w = createWorld(3, flatMap());
    const cells = ring(140, 100, 3);
    run(w, 2, [
      works(1, WORK_TRAP, cells),
      spawn(0, KIND_INFANTRY, 125, 100),
      spawn(0, KIND_TRUCK, 110, 100),
      spawn(0, KIND_ENGINEER, 125, 102),
    ]);
    run(w, 600, [{ type: CMD_MOVE, units: [0, 1], x: mid(140), y: mid(100) }]);
    expect(Math.abs(w.posX[0] - mid(140))).toBeLessThan(fx(6));
    expect(w.posX[1]).toBeLessThan(mid(137));
    expect(w.workCount).toBe(cells.length);
    run(w, 900, [{ type: CMD_BREACH, units: [2], x: mid(137), y: mid(100) }]);
    expect(w.wKind[at(137, 100)]).toBe(0);
    expect(w.flags[2] & FLAG_BREACH).toBe(0);
    // The truck was waiting at the obstacle and drives in through the gap.
    expect(Math.abs(w.posX[1] - mid(140))).toBeLessThan(fx(6));
  });

  it('guns ordered at a work shell it', () => {
    const w = createWorld(3, flatMap());
    const wire: number[] = [];
    for (let y = 98; y <= 102; y++) for (let x = 139; x <= 141; x++) wire.push(at(x, y));
    run(w, 2, [works(1, WORK_WIRE, wire), spawn(0, KIND_ARTILLERY, 120, 100, 4)]);
    run(w, 1200, [{ type: CMD_BREACH, units: [0, 1, 2, 3], x: mid(140), y: mid(100) }]);
    expect(w.workCount).toBeLessThan(wire.length - 3);
  });

  it('a wall blocks sight at ground level but not from above it', () => {
    const w = createWorld(3, flatMap());
    const wall: number[] = [];
    for (let y = 95; y <= 105; y++) wall.push(at(120, y));
    run(w, 2, [works(1, WORK_WALL, wall)]);
    const m = w.map;
    const eye = fx(1) + EYE_HEIGHT;
    expect(lineOfSight(m, mid(110), mid(100), eye, mid(130), mid(100), eye, -1, -1)).toBe(false);
    expect(lineOfSight(m, mid(110), mid(90), eye, mid(130), mid(90), eye, -1, -1)).toBe(true);
    const high = fx(1) + fx(8);
    expect(lineOfSight(m, mid(110), mid(100), high, mid(130), mid(100), high, -1, -1)).toBe(true);
    // Two enemies either side of the wall do not see each other.
    run(w, 100, [spawn(0, KIND_INFANTRY, 117, 100), spawn(1, KIND_INFANTRY, 123, 100)]);
    expect(w.attack[0]).toBe(-1);
    expect(w.attack[1]).toBe(-1);
  });

  it('a squad in a trench or behind sandbags outlasts the same squad in the open', () => {
    const survive = (work: number): number => {
      const w = createWorld(3, flatMap());
      run(w, 2, [
        ...(work ? [works(0, work, [at(100, 100)])] : []),
        spawn(0, KIND_INFANTRY, 100, 100),
        spawn(1, KIND_INFANTRY, 102, 100),
      ]);
      place(w, 0, 100, 100);
      place(w, 1, 102, 100);
      step(w, [{ type: CMD_OCCUPY, units: [0], x: mid(100), y: mid(100) }]);
      let t = 0;
      while (t < 4000 && w.state[0] === STATE_ALIVE && w.state[1] === STATE_ALIVE) {
        step(w, []);
        t++;
      }
      return w.state[0] === STATE_ALIVE ? w.hp[0] : -w.hp[1];
    };
    const open = survive(0);
    expect(survive(WORK_TRENCH)).toBeGreaterThan(40);
    expect(survive(WORK_SANDBAG)).toBeGreaterThan(40);
    expect(open).toBeLessThan(40);
  });

  it('infantry ordered into a trench line spreads along it, two squads a cell, and holds', () => {
    const w = createWorld(3, flatMap());
    const line = [at(100, 100), at(101, 100), at(102, 100), at(103, 100)];
    run(w, 2, [works(0, WORK_TRENCH, line), spawn(0, KIND_INFANTRY, 100, 110, 6)]);
    for (const c of line) expect(w.map.type[c]).toBe(T_TRENCH);
    const squads = [0, 1, 2, 3, 4, 5];
    run(w, 900, [{ type: CMD_OCCUPY, units: squads, x: mid(101), y: mid(100) }]);
    const used = new Map<number, number>();
    for (const id of squads) {
      const c = cellOf(w, id);
      expect(w.map.type[c]).toBe(T_TRENCH);
      expect(w.flags[id] & FLAG_HOLD).toBe(FLAG_HOLD);
      used.set(c, (used.get(c) ?? 0) + 1);
    }
    expect(used.size).toBe(3);
    for (const n of used.values()) expect(n).toBe(2);
  });

  it('trucks and engineers build what is ordered, in turn, and the army pays for it', () => {
    const w = createWorld(3, flatMap());
    run(w, 2, [
      spawn(0, KIND_TRUCK, 100, 100, 2),
      spawn(0, KIND_ENGINEER, 100, 102),
      spawn(0, KIND_TANK, 90, 90),
    ]);
    w.supplies[0] = 1000;
    const line: number[] = [];
    for (let x = 110; x < 122; x++) line.push(at(x, 100));
    step(w, [{ type: CMD_FORTIFY, units: [0, 1, 2, 3], work: WORK_WALL, cells: line }]);
    expect(w.supplies[0]).toBe(1000 - 12 * WORKS[WORK_WALL].supplies);
    expect(w.workCount).toBe(12);
    // Planned is not built: nothing stands yet, and the tank was not sent.
    expect(w.map.type[line[0]]).toBe(T_OPEN);
    expect(w.flags[3] & FLAG_MOVING).toBe(0);
    for (let t = 0; t < 2400; t++) step(w, []);
    for (const c of line) {
      expect(workStands(w, c)).toBe(true);
      expect(w.map.type[c]).toBe(T_WALL);
      expect(w.wHp[c]).toBe(WORKS[WORK_WALL].hp);
    }
    for (const id of [0, 1, 2]) {
      expect(w.job[id]).toBe(JOB_NONE);
      expect(w.map.cost[layerOf(0, KINDS[w.kind[id]].cls)][cellOf(w, id)]).not.toBe(0);
    }
  });

  it('refuses what cannot be paid for or built on, and gives the money back for a cancelled plan', () => {
    const w = createWorld(3, flatMap());
    run(w, 2, [spawn(0, KIND_TRUCK, 100, 100)]);
    w.supplies[0] = 70;
    const cells = [at(110, 100), at(111, 100), at(112, 100), at(0, 0), -5, 1e9];
    step(w, [{ type: CMD_FORTIFY, units: [0], work: WORK_WALL, cells }]);
    expect(w.workCount).toBe(2);
    expect(w.supplies[0]).toBe(10);
    expect(canFortify(w.map, WORK_WALL, at(0, 0))).toBe(false);
    step(w, [
      { type: CMD_DEMOLISH, team: 1, cells },
      { type: CMD_FORTIFY, units: [0], work: 99, cells: [at(113, 100)] },
      { type: CMD_FORTIFY, units: [77, -1], work: WORK_WIRE, cells: [at(113, 100)] },
    ]);
    expect(w.workCount).toBe(2);
    step(w, [{ type: CMD_DEMOLISH, team: 0, cells }]);
    expect(w.workCount).toBe(0);
    expect(w.supplies[0]).toBe(70);
    // A finished work is taken down without a refund, and the ground is as it was.
    run(w, 2, [
      works(0, WORK_WALL, [at(110, 100)]),
      { type: CMD_DEMOLISH, team: 0, cells: [at(110, 100)] },
    ]);
    expect(w.map.type[at(110, 100)]).toBe(T_OPEN);
    expect(w.map.cost[layerOf(0, CLASS_VEHICLE)][at(110, 100)]).toBe(1);
    expect(w.supplies[0]).toBe(70);
  });

  it('is deterministic', () => {
    const play = (): number[] => {
      const w = createWorld(11, flatMap());
      const hashes: number[] = [];
      run(w, 2, [
        works(
          1,
          WORK_WALL,
          ring(140, 100, 4).filter((c) => c !== at(136, 100)),
        ),
        works(1, WORK_GATE, [at(136, 100)]),
        works(1, WORK_WIRE, ring(140, 100, 6)),
        works(1, WORK_TRENCH, [at(139, 100), at(139, 101)]),
        spawn(1, KIND_INFANTRY, 140, 100, 4),
        spawn(0, KIND_TANK, 100, 100, 6),
        spawn(0, KIND_ENGINEER, 100, 104, 4),
        spawn(0, KIND_INFANTRY, 100, 96, 8),
        spawn(0, KIND_ARTILLERY, 90, 100, 2),
      ]);
      const mine = Array.from({ length: 20 }, (_, k) => k + 4);
      step(w, [
        { type: CMD_OCCUPY, units: [0, 1, 2, 3], x: mid(139), y: mid(100) },
        { type: CMD_MOVE, units: mine, x: mid(140), y: mid(100) },
      ]);
      for (let t = 0; t < 1500; t++) {
        step(w, []);
        if (t % 50 === 0) hashes.push(hashWorld(w));
      }
      return hashes;
    };
    expect(play()).toEqual(play());
  });
});
