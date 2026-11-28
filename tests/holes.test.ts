import { describe, expect, it } from 'vitest';
import {
  CMD_BLOCK,
  CMD_FACTION,
  CMD_GARRISON,
  CMD_MOUSEHOLE,
  CMD_SPAWN,
  type Command,
} from '../src/sim/commands';
import { fx } from '../src/sim/fixed';
import {
  HOLE_TICKS,
  HOP_TICKS,
  blockOf,
  holeBetween,
  holeNet,
  holedInto,
  nextHop,
} from '../src/sim/holes';
import {
  MAP_CELLS,
  ROAD_STREET,
  S_BUILDING,
  addStructure,
  flatMap,
  generateMap,
  refreshPassability,
} from '../src/sim/map';
import { step } from '../src/sim/sim';
import { KIND_ENGINEER, KIND_INFANTRY } from '../src/sim/units';
import {
  EV_HOLE,
  JOB_HOLE,
  STATE_ALIVE,
  createWorld,
  hashWorld,
  type World,
} from '../src/sim/world';

/**
 * A terrace of four houses wall to wall along y = 100 (cells x 100 to 111), a fifth wall to
 * wall behind the last, one across a one-cell yard and one across a street: no neighbours.
 */
function terrace() {
  const m = flatMap();
  for (let k = 0; k < 4; k++) addStructure(m, S_BUILDING, 100 + 3 * k, 100, 3, 3, -1, 2);
  addStructure(m, S_BUILDING, 109, 103, 3, 3, -1, 2);
  addStructure(m, S_BUILDING, 104, 104, 3, 3, -1, 2);
  for (let x = 95; x < 120; x++) m.road[98 * MAP_CELLS + x] = ROAD_STREET;
  addStructure(m, S_BUILDING, 100, 96, 3, 2, -1, 2);
  refreshPassability(m);
  return m;
}

const spawnAt = (team: number, kind: number, x: number, y: number, count = 1): Command => ({
  type: CMD_SPAWN,
  count,
  team,
  kind,
  x: fx(x),
  y: fx(y),
  radius: fx(1),
  wander: false,
});
const run = (w: World, ticks: number, first: Command[] = []) => {
  step(w, first);
  for (let t = 1; t < ticks; t++) step(w, []);
};
const units = (w: World, team: number, kind: number) => {
  const ids: number[] = [];
  for (let i = 0; i < w.count; i++)
    if (w.state[i] === STATE_ALIVE && w.team[i] === team && w.kind[i] === kind) ids.push(i);
  return ids;
};
/** Squads of team 0 into house `s`, walking from beside it. */
function inHouse(w: World, s: number, kind = KIND_INFANTRY, n = 1): number[] {
  const before = new Set(units(w, 0, kind));
  const x = (w.map.sX[s] + 1.5) * 4;
  run(w, 2, [spawnAt(0, kind, x, 418, n)]);
  const ids = units(w, 0, kind).filter((i) => !before.has(i));
  run(w, 200, [{ type: CMD_GARRISON, units: ids, structure: s }]);
  for (const i of ids) expect(w.inside[i]).toBe(s);
  return ids;
}
/** Knock every hole of the terrace through (as the engineers would). */
function holeAll(w: World) {
  const net = holeNet(w.map);
  for (let p = 0; p < net.pairCount; p++) w.holes[p] = 1;
  w.holeCount = net.pairCount;
}

describe('mouseholes (decision 166)', () => {
  it('knows which houses are neighbours, and what a block is', () => {
    const m = terrace();
    const net = holeNet(m);
    // Four party walls; the house across the yard and the one across the street are alone.
    expect(net.pairCount).toBe(4);
    expect(blockOf(m, 0)).toEqual([0, 1, 2, 3, 4]);
    expect(net.block[5]).toBe(-1);
    expect(net.block[6]).toBe(-1);
    // The real maps have whole terraces and blocks of flats.
    const city = holeNet(generateMap(7, 'city'));
    expect(city.pairCount).toBeGreaterThan(60);
  });

  it('engineers knock the whole block through, a hole at a time', () => {
    const w = createWorld(1, terrace());
    const crew = inHouse(w, 0, KIND_ENGINEER);
    run(w, 2, [{ type: CMD_MOUSEHOLE, units: crew, structure: 0 }]);
    expect(w.job[crew[0]]).toBe(JOB_HOLE);
    let opened = 0;
    for (let t = 0; t < 4 * (HOLE_TICKS + HOP_TICKS) + 40; t++) {
      step(w, []);
      for (let e = 0; e < w.events.length; e += 3) if (w.events[e] === EV_HOLE) opened++;
      w.events.length = 0;
      // They never come out into the street to do it.
      expect(w.inside[crew[0]]).toBeGreaterThanOrEqual(0);
    }
    expect(opened).toBe(4);
    expect(w.holeCount).toBe(4);
    expect(holeBetween(w, 2, 3)).toBe(true);
    expect(w.job[crew[0]]).not.toBe(JOB_HOLE);
  });

  it('a squad goes from house to house inside, never into the street', () => {
    const w = createWorld(1, terrace());
    holeAll(w);
    const [id] = inHouse(w, 0);
    run(w, 1, [{ type: CMD_GARRISON, units: [id], structure: 4 }]);
    let t = 0;
    while (w.inside[id] !== 4 && t < 400) {
      expect(w.inside[id]).toBeGreaterThanOrEqual(0);
      step(w, []);
      t++;
    }
    expect(w.inside[id]).toBe(4);
    // Four houses on, three seconds each.
    expect(t).toBeLessThanOrEqual(4 * HOP_TICKS + 2);
  });

  it('without holes it goes by the street, and an enemy house cuts the way', () => {
    const w = createWorld(1, terrace());
    const [id] = inHouse(w, 0);
    run(w, 1, [{ type: CMD_GARRISON, units: [id], structure: 2 }]);
    expect(w.inside[id]).toBe(-1);
    holeAll(w);
    run(w, 300, [{ type: CMD_GARRISON, units: [id], structure: 0 }]);
    expect(w.inside[id]).toBe(0);
    // The enemy in house 1: no way through it to 2.
    w.sOcc[1] = 1;
    w.sOccTeam[1] = 1;
    expect(nextHop(w, 0, 2, 0)).toBe(-1);
    w.sOcc[1] = 0;
    expect(nextHop(w, 0, 2, 0)).toBe(1);
  });

  it("an assault through a mousehole takes away the defender's edge", () => {
    const w = createWorld(1, terrace());
    inHouse(w, 0);
    w.sOcc[1] = 1;
    w.sOccTeam[1] = 1;
    expect(holedInto(w, 1, 0)).toBe(false);
    holeAll(w);
    expect(holedInto(w, 1, 0)).toBe(true);
    expect(holedInto(w, 1, 1)).toBe(false);
  });

  it('Garrison block spreads the squads over the block, nearest houses first', () => {
    const w = createWorld(1, terrace());
    holeAll(w);
    run(w, 2, [spawnAt(0, KIND_INFANTRY, 406, 418, 15)]);
    const ids = units(w, 0, KIND_INFANTRY);
    run(w, 600, [{ type: CMD_BLOCK, units: ids, structure: 1 }]);
    const where = ids.map((i) => w.inside[i]);
    // Three to a house: all five.
    for (const s of [0, 1, 2, 3, 4]) expect(where.filter((h) => h === s).length).toBe(3);
  });

  it('plays the same twice, and a game without holes hashes as before', () => {
    const play = (holes: boolean) => {
      const w = createWorld(3, terrace());
      run(w, 2, [
        { type: CMD_FACTION, team: 0, faction: 4 },
        spawnAt(0, KIND_ENGINEER, 406, 418, 2),
        spawnAt(0, KIND_INFANTRY, 410, 418, 4),
      ]);
      const crew = units(w, 0, KIND_ENGINEER);
      const foot = units(w, 0, KIND_INFANTRY);
      run(w, 600, [
        holes
          ? { type: CMD_MOUSEHOLE, units: crew, structure: 0 }
          : { type: CMD_GARRISON, units: crew, structure: 0 },
        { type: CMD_BLOCK, units: foot, structure: 2 },
      ]);
      return hashWorld(w);
    };
    expect(play(true)).toBe(play(true));
    expect(play(true)).not.toBe(play(false));
  });
});

describe('the computer and mouseholes (decision 166)', () => {
  it('knocks through the blocks of the towns it holds, and its squads use the holes', async () => {
    const { aiThink, createAi } = await import('../src/sim/ai');
    const { skirmishCommands } = await import('../src/sim/scenarios');
    // The European city: old terraces wall to wall.
    const w = createWorld(7, generateMap(7, 'euro'));
    const ais = [createAi(1, 'hard', 7), createAi(0, 'hard', 7)];
    let cmds: Command[] = [
      { type: CMD_FACTION, team: 0, faction: 4 },
      { type: CMD_FACTION, team: 1, faction: 2 },
      ...skirmishCommands(w.map, 2),
    ];
    let hops = 0;
    for (let t = 0; t < 12 * 1200; t++) {
      for (const ai of ais) aiThink(ai, w, cmds);
      step(w, cmds);
      cmds = [];
      w.events.length = 0;
      for (let i = 0; i < w.count; i++) if (w.hopTo[i] >= 0 && w.hopAt[i] === w.tick) hops++;
    }
    expect(w.holeCount).toBeGreaterThan(5);
    expect(hops).toBeGreaterThan(0);
  }, 60_000);
});
