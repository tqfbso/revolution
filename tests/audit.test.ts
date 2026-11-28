// Bugs found by the code audit of 2026-11-28 (decision 165): each test fails on the code
// before the fix.
import { describe, expect, it } from 'vitest';
import { createAi, ceaseFire, follow } from '../src/sim/ai';
import { onRoof } from '../src/sim/ambush';
import {
  CMD_AIRSTRIKE,
  CMD_AMBUSH,
  CMD_ATTACK,
  CMD_ENTRENCH,
  CMD_FOUND,
  CMD_GARRISON,
  CMD_MOVE,
  CMD_ROOF,
  CMD_SPAWN,
  type Command,
} from '../src/sim/commands';
import { B_HQ } from '../src/sim/economy';
import { FACTION_RUSSIA } from '../src/sim/factions';
import { fx } from '../src/sim/fixed';
import { RATION_MAX } from '../src/sim/logistics';
import {
  MAP_CELLS,
  S_BUILDING,
  T_WATER,
  addStructure,
  addTown,
  cellOfPos,
  flatMap,
  layerOf,
  refreshPassability,
  CLASS_FOOT,
} from '../src/sim/map';
import { step } from '../src/sim/sim';
import {
  KINDS,
  KIND_AD,
  KIND_ARTILLERY,
  KIND_ENGINEER,
  KIND_HELI,
  KIND_INFANTRY,
  KIND_LIFT,
  KIND_MORTAR,
  KIND_TANK,
  KIND_TRUCK,
} from '../src/sim/units';
import {
  EV_AMBUSH,
  FLAG_BOMBARD,
  STANCE_AMBUSH,
  STATE_ALIVE,
  createWorld,
  type World,
} from '../src/sim/world';

const spawnAt = (team: number, kind: number, count: number, x: number, y: number): Command => ({
  type: CMD_SPAWN,
  count,
  team,
  kind,
  x: fx(x),
  y: fx(y),
  radius: fx(count > 1 ? 3 : 0),
  wander: false,
});
function run(w: World, ticks: number, each?: () => void): void {
  for (let t = 0; t < ticks; t++) {
    step(w, []);
    each?.();
    w.events.length = 0;
  }
}

describe('engineers at a building past the 1,024th (Kowloon)', () => {
  it('still work three to a building, like everywhere else', () => {
    const m = flatMap();
    // 1,030 sheds in the north-west first, so that the house is structure 1,030.
    for (let k = 0; k < 1030; k++) {
      addStructure(m, S_BUILDING, 10 + 2 * (k % 50), 10 + 2 * Math.floor(k / 50), 1, 1, 0, 1);
    }
    addTown(m, fx(508), fx(500), fx(30), 'Test');
    const s = m.structCount;
    addStructure(m, S_BUILDING, 126, 124, 2, 2, 0, 3);
    refreshPassability(m);
    expect(s).toBeGreaterThanOrEqual(1024);
    const w = createWorld(1, m);
    step(w, [spawnAt(0, KIND_ENGINEER, 6, 508, 486)]);
    step(w, [{ type: CMD_ENTRENCH, units: [0, 1, 2, 3, 4, 5], structure: s }]);
    let most = 0;
    let before = w.sFort[s];
    run(w, 600, () => {
      most = Math.max(most, w.sFort[s] - before);
      before = w.sFort[s];
    });
    expect(w.sFort[s]).toBeGreaterThan(0);
    // Six engineers, but no more than three at work on it in any one tick.
    expect(most).toBe(3);
  });
});

describe('guns sent at a house', () => {
  it('are called off it by ceaseFire, as a siege is', () => {
    const m = flatMap();
    addStructure(m, S_BUILDING, 126, 124, 2, 2, 0, 3);
    addStructure(m, S_BUILDING, 140, 124, 2, 2, 0, 3);
    refreshPassability(m);
    const w = createWorld(1, m);
    step(w, [spawnAt(0, KIND_ARTILLERY, 1, 400, 400), spawnAt(0, KIND_ARTILLERY, 1, 410, 400)]);
    // Gun 0 shells house 0 (as CMD_ATTACK_STRUCTURE sets it up); gun 1 a bare point.
    w.flags[0] = FLAG_BOMBARD;
    w.orderStruct[0] = 0;
    w.flags[1] = FLAG_BOMBARD;
    w.orderStruct[1] = -1;
    const out: Command[] = [];
    ceaseFire(w, out, [0, 1], 1);
    expect(out.map((c) => (c as { units: number[] }).units[0])).toEqual([0]);
    // The house still worth shelling is left alone.
    const keep: Command[] = [];
    ceaseFire(w, keep, [0], 0);
    expect(keep.length).toBe(0);
  });
});

describe('the computer keeps its mortars behind the line', () => {
  it('as it does its guns, and does not pull one off its roof or its target', () => {
    const w = createWorld(1, flatMap());
    step(w, [
      spawnAt(0, KIND_INFANTRY, 1, 500, 500),
      spawnAt(0, KIND_MORTAR, 1, 560, 500),
      spawnAt(0, KIND_MORTAR, 1, 530, 500),
    ]);
    const ai = createAi(0);
    ai.stageX = fx(300);
    ai.stageY = fx(500);
    // Mortar 2 is shelling something: it stays where it is.
    w.flags[2] = FLAG_BOMBARD;
    w.orderStruct[2] = -1;
    const out: Command[] = [];
    follow(ai, w, out, [0, 1, 2], fx(500), fx(500));
    const moves = out.filter((c) => c.type === CMD_MOVE) as { units: number[]; x: number }[];
    expect(moves.length).toBe(1);
    expect(moves[0].units).toEqual([1]);
    // Behind the line (toward the staging area), not into the middle of it.
    expect(moves[0].x).toBeLessThan(fx(500));
  });
});

/** A sturdy block of six floors at (600, 512) with team 1's squads in it. */
function strikeOnBlock(roof: boolean): { w: World; squads: number[] } {
  const map = flatMap();
  map.startX[0] = 20;
  map.startY[0] = 128;
  map.startX[1] = 236;
  map.startY[1] = 128;
  addTown(map, fx(604), fx(516), fx(30), 'Test');
  addStructure(map, S_BUILDING, 150, 128, 2, 2, 0, 6);
  refreshPassability(map);
  const s = map.structCount - 1;
  const w = createWorld(3, map);
  w.faction[0] = FACTION_RUSSIA;
  w.tier[0] = 3;
  w.supplies[0] = w.fuel[0] = w.credits[0] = 20000;
  step(w, [{ type: CMD_FOUND, team: 0, building: B_HQ, x: 20, y: 128 }]);
  const squads: number[] = [];
  for (let k = 0; k < 2; k++) {
    squads.push(w.count);
    step(w, [spawnAt(1, KIND_INFANTRY, 1, 598 + 4 * k, 500)]);
  }
  step(w, [{ type: CMD_GARRISON, units: squads, structure: s }]);
  run(w, 200);
  if (roof) {
    step(w, [{ type: CMD_ROOF, units: squads, structure: s }]);
    run(w, 40);
  }
  for (const i of squads) {
    expect(w.inside[i]).toBe(s);
    expect(onRoof(w, i)).toBe(roof);
  }
  return { w, squads };
}

describe('squads on a roof under an air strike', () => {
  it('take the bombs as men on a roof take shells, not with a ceiling over them', () => {
    const lost = (roof: boolean): number => {
      const { w, squads } = strikeOnBlock(roof);
      const full = KINDS[KIND_INFANTRY].hp * squads.length;
      step(w, [{ type: CMD_AIRSTRIKE, team: 0, x: fx(616), y: fx(516) }]);
      run(w, 1200);
      let hp = 0;
      for (const i of squads) if (w.state[i] === STATE_ALIVE) hp += w.hp[i];
      return full - hp;
    };
    const under = lost(false);
    const up = lost(true);
    expect(up).toBeGreaterThan(under);
  });
});

describe('an ambush', () => {
  it('is not sprung by a vehicle behind a house that no one can see', () => {
    const m = flatMap();
    // A tall block between the ambush and the street where the tank stops.
    addStructure(m, S_BUILDING, 126, 120, 3, 10, 0, 6);
    refreshPassability(m);
    const w = createWorld(1, m);
    step(w, [spawnAt(0, KIND_INFANTRY, 1, 494, 500)]);
    // The circle reaches past the block; the tank is in it, on the far side.
    step(w, [{ type: CMD_AMBUSH, units: [0], x: fx(508), y: fx(500), radius: fx(20) }]);
    step(w, [spawnAt(1, KIND_TANK, 1, 522, 500)]);
    w.stance[1] = 1; // the tank holds its fire and sees nothing to shoot at
    let sprung = false;
    for (let t = 0; t < 200; t++) {
      // Nobody of team 0 has spotted it.
      w.spotted[1] = 0;
      step(w, []);
      for (let e = 0; e < w.events.length; e += 3) if (w.events[e] === EV_AMBUSH) sprung = true;
      w.events.length = 0;
    }
    expect(sprung).toBe(false);
    expect(w.stance[0]).toBe(STANCE_AMBUSH);
  });
});

describe('logistics', () => {
  /** A world with team 0's headquarters (so supply) round (80, 512). */
  function supplied(): World {
    const map = flatMap();
    map.startX[0] = 20;
    map.startY[0] = 128;
    map.startX[1] = 236;
    map.startY[1] = 128;
    const w = createWorld(3, map);
    w.supplies[0] = w.fuel[0] = w.credits[0] = 20000;
    step(w, [{ type: CMD_FOUND, team: 0, building: B_HQ, x: 20, y: 128 }]);
    return w;
  }

  it('helicopters and trucks mend in supply, out of the fight', () => {
    const w = supplied();
    const ids = [KIND_TRUCK, KIND_HELI, KIND_LIFT].map((kind) => {
      const id = w.count;
      step(w, [spawnAt(0, kind, 1, 100, 520)]);
      w.hp[id] = KINDS[kind].hp >> 1;
      return id;
    });
    run(w, 60 * 20);
    for (const id of ids) expect(w.hp[id]).toBeGreaterThan(KINDS[w.kind[id]].hp >> 1);
  });

  it('a soft vehicle out of rations crawls, as armour does', () => {
    const w = createWorld(1, flatMap());
    step(w, [spawnAt(0, KIND_AD, 1, 300, 500), spawnAt(0, KIND_AD, 1, 300, 520)]);
    w.ration[0] = RATION_MAX;
    w.ration[1] = 0;
    step(w, [{ type: CMD_MOVE, units: [0, 1], x: fx(700), y: fx(510) }]);
    run(w, 100, () => {
      w.ration[0] = RATION_MAX;
      w.ration[1] = 0;
    });
    expect(w.posX[1] - fx(300)).toBeLessThan(((w.posX[0] - fx(300)) * 3) / 4);
  });
});

describe('a transport helicopter shot down over water', () => {
  it('leaves its survivors on the nearest dry ground', () => {
    const m = flatMap();
    // A lake 40 m across, 500..540 both ways.
    for (let y = 125; y < 135; y++) {
      for (let x = 125; x < 135; x++) m.type[y * MAP_CELLS + x] = T_WATER;
    }
    refreshPassability(m);
    const w = createWorld(1, m);
    step(w, [spawnAt(0, KIND_LIFT, 1, 520, 520), spawnAt(0, KIND_INFANTRY, 1, 300, 300)]);
    expect(w.count).toBe(2);
    // The squad is aboard, over the middle of the lake.
    w.posX[1] = w.posX[0];
    w.posY[1] = w.posY[0];
    w.carrier[1] = 0;
    w.load[0] = 1;
    w.hp[0] = 1;
    // Something hits it hard: the sim's own damage path brings it down.
    step(w, [spawnAt(1, KIND_AD, 3, 520, 556)]);
    step(w, [{ type: CMD_ATTACK, units: [2, 3, 4], target: 0 }]);
    for (let t = 0; t < 400 && w.state[0] === STATE_ALIVE; t++) step(w, []);
    expect(w.state[0]).not.toBe(STATE_ALIVE);
    expect(w.carrier[1]).toBe(-1);
    expect(w.state[1]).toBe(STATE_ALIVE);
    const layer = layerOf(0, CLASS_FOOT);
    expect(w.map.cost[layer][cellOfPos(w.posX[1], w.posY[1])]).toBeGreaterThan(0);
  });
});
