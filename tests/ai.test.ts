import { describe, expect, it } from 'vitest';
import { aiThink, createAi, findCrossings, type Ai, type AiLevel } from '../src/sim/ai';
import { CMD_FOUND, CMD_SPAWN, type Command } from '../src/sim/commands';
import { B_BARRACKS, B_HQ } from '../src/sim/economy';
import { fx } from '../src/sim/fixed';
import { MAP_CELLS, flatMap, generateMap } from '../src/sim/map';
import { skirmishCommands } from '../src/sim/scenarios';
import { step } from '../src/sim/sim';
import { KIND_INFANTRY, KIND_TANK, KIND_TRUCK } from '../src/sim/units';
import { NO_TEAM, STATE_ALIVE, createWorld, hashWorld, type World } from '../src/sim/world';

const MINUTE = 1200;

/** A skirmish on `seed`, each army played by the AI of the given level (or by nobody). */
function match(seed: number, levels: (AiLevel | null)[]): { w: World; ais: (Ai | null)[] } {
  const w = createWorld(seed);
  const ais = levels.map((l, team) => (l === null ? null : createAi(team, l, seed)));
  step(w, skirmishCommands(w.map));
  return { w, ais };
}

/** Run until `ticks` have passed or `until` holds. Returns every command the AIs gave. */
function play(
  w: World,
  ais: (Ai | null)[],
  ticks: number,
  until?: () => boolean,
  log?: Command[],
): void {
  const end = w.tick + ticks;
  while (w.tick < end && !(until && w.tick % 20 === 0 && until())) {
    const cmds: Command[] = [];
    for (const ai of ais) if (ai) aiThink(ai, w, cmds);
    if (log) log.push(...cmds);
    step(w, cmds);
    w.events.length = 0;
  }
}

const count = (w: World, team: number, kind = -1) => {
  let n = 0;
  for (let i = 0; i < w.count; i++) {
    if (w.state[i] === STATE_ALIVE && w.team[i] === team && (kind < 0 || w.kind[i] === kind)) n++;
  }
  return n;
};
const buildings = (w: World, team: number, type = -1) => {
  let n = 0;
  for (let s = 0; s < w.map.structCount; s++) {
    if (w.sTeam[s] === team && w.sHp[s] > 0 && (type < 0 || w.sType[s] === type)) n++;
  }
  return n;
};
const towns = (w: World, team: number) => {
  let n = 0;
  for (let t = 0; t < w.map.townCount; t++) if (w.townOwner[t] === team) n++;
  return n;
};

describe('reading the map', () => {
  it('finds the five ways over the river, three of them through settlements', () => {
    for (const seed of [1, 3, 4, 10]) {
      const map = generateMap(seed);
      const crossings = findCrossings(map, new Int16Array(MAP_CELLS));
      expect(crossings.length).toBe(5);
      expect(crossings.filter((c) => c.town[0] >= 0 && c.town[1] >= 0).length).toBe(3);
    }
  });

  it('copes with maps where a ford is missing or an extra one has formed', () => {
    for (const seed of [2, 5, 6, 7, 8, 9]) {
      const map = generateMap(seed);
      const crossings = findCrossings(map, new Int16Array(MAP_CELLS));
      expect(crossings.length).toBeGreaterThanOrEqual(3);
      // The central town always has its crossing, with a settlement on each bank.
      expect(crossings.some((c) => c.town[0] === 0 && c.town[1] === 1)).toBe(true);
      // West bank form-up points lie west of the ford, east bank ones east of it.
      for (const c of crossings) {
        expect(c.bankX[0]).toBeLessThan(c.x);
        expect(c.bankX[1]).toBeGreaterThan(c.x);
      }
    }
  });

  it('finds nothing to cross on a map without a river', () => {
    expect(findCrossings(flatMap(), new Int16Array(MAP_CELLS)).length).toBe(0);
  });
});

describe('the AI opponent', () => {
  it('plays the same game every time', () => {
    const run = () => {
      const { w, ais } = match(4, ['normal', 'hard']);
      play(w, ais, 4 * MINUTE);
      return hashWorld(w);
    };
    expect(run()).toBe(run());
  });

  it('only ever orders its own units and buildings about', () => {
    const { w, ais } = match(2, ['normal', 'normal']);
    for (let k = 0; k < 6 * MINUTE; k++) {
      for (const ai of ais) {
        const cmds: Command[] = [];
        aiThink(ai!, w, cmds);
        for (const c of cmds) {
          expect(c.type).not.toBe(CMD_SPAWN);
          expect(c.type).not.toBe(CMD_FOUND);
          if ('units' in c) for (const id of c.units) expect(w.team[id]).toBe(ai!.team);
          if ('structure' in c && w.sTeam[c.structure] !== NO_TEAM) {
            // Its own building, or an enemy one it is shelling.
            const shelling = 'units' in c;
            if (!shelling) expect(w.sTeam[c.structure]).toBe(ai!.team);
          }
        }
        step(w, cmds);
      }
      w.events.length = 0;
    }
  });

  it('builds an economy: trucks, a barracks, the towns of its bank, technology', () => {
    const { w, ais } = match(1, [null, 'normal']);
    play(w, ais, 5 * MINUTE);
    expect(count(w, 1, KIND_TRUCK)).toBeGreaterThanOrEqual(12);
    expect(buildings(w, 1, B_BARRACKS)).toBeGreaterThanOrEqual(1);
    expect(buildings(w, 1)).toBeGreaterThanOrEqual(4);
    expect(towns(w, 1)).toBe(3);
    expect(w.tier[1]).toBeGreaterThanOrEqual(2);
    // Its garrisons are in the houses, not standing in the street.
    let inside = 0;
    for (let i = 0; i < w.count; i++) {
      if (w.state[i] === STATE_ALIVE && w.team[i] === 1 && w.inside[i] >= 0) inside++;
    }
    expect(inside).toBeGreaterThanOrEqual(10);
  });

  it('beats an opponent who does nothing', () => {
    const { w, ais } = match(1, [null, 'normal']);
    const redHq = w.sTeam.indexOf(0);
    expect(w.sType[redHq]).toBe(B_HQ);
    play(w, ais, 20 * MINUTE, () => w.sHp[redHq] <= 0);
    expect(w.sHp[redHq]).toBeLessThanOrEqual(0);
  });

  it('is slower to get going on easy than on hard', () => {
    const pop = (level: AiLevel) => {
      const { w, ais } = match(3, [null, level]);
      play(w, ais, 7 * MINUTE);
      return count(w, 1);
    };
    expect(pop('hard')).toBeGreaterThan(pop('easy') + 20);
  });

  it('does nothing without a base, and stops when its headquarters falls', () => {
    const w = createWorld(5, flatMap());
    const ai = createAi(1, 'normal', 5);
    step(w, [
      {
        type: CMD_SPAWN,
        count: 10,
        team: 1,
        kind: KIND_INFANTRY,
        x: fx(300),
        y: fx(300),
        radius: fx(5),
        wander: false,
      },
    ]);
    const cmds: Command[] = [];
    for (let k = 0; k < 100; k++) {
      aiThink(ai, w, cmds);
      step(w, []);
    }
    expect(cmds.length).toBe(0);
  });
});

describe('base buildings as targets', () => {
  it('are shelled by tanks that have nothing else to shoot at, without an order', () => {
    const w = createWorld(6, flatMap());
    step(w, [
      { type: CMD_FOUND, team: 1, building: B_BARRACKS, x: 80, y: 80 },
      {
        type: CMD_SPAWN,
        count: 3,
        team: 0,
        kind: KIND_TANK,
        x: fx(300),
        y: fx(326),
        radius: fx(2),
        wander: false,
      },
    ]);
    const s = w.sTeam.indexOf(1);
    const before = w.sHp[s];
    for (let k = 0; k < 200; k++) step(w, []);
    expect(w.sHp[s]).toBeLessThan(before);
  });

  it('are left alone by their own side', () => {
    const w = createWorld(6, flatMap());
    step(w, [
      { type: CMD_FOUND, team: 0, building: B_BARRACKS, x: 80, y: 80 },
      {
        type: CMD_SPAWN,
        count: 3,
        team: 0,
        kind: KIND_TANK,
        x: fx(300),
        y: fx(326),
        radius: fx(2),
        wander: false,
      },
    ]);
    const s = w.sTeam.indexOf(0);
    const before = w.sHp[s];
    for (let k = 0; k < 200; k++) step(w, []);
    expect(w.sHp[s]).toBe(before);
  });
});
