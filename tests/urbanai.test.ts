// U5: the computer in a city (decision 110). Its sappers sandbag the houses its garrisons
// hold, and garrisons that have lost their houses lie up in the ruins.
import { describe, expect, it } from 'vitest';
import { aiThink, billet, billetStart, createAi, type Ai, type AiLevel } from '../src/sim/ai';
import { CMD_SPAWN, type Command } from '../src/sim/commands';
import { fx } from '../src/sim/fixed';
import {
  CELL_SHIFT,
  S_BUILDING,
  cellOfPos,
  generateMap,
  razeStructure,
  type Layout,
} from '../src/sim/map';
import { skirmishCommands } from '../src/sim/scenarios';
import { markTopology, step } from '../src/sim/sim';
import { fortified } from '../src/sim/urban';
import { KIND_INFANTRY } from '../src/sim/units';
import { STATE_ALIVE, createWorld, type World } from '../src/sim/world';

const MINUTE = 1200;

function match(seed: number, layout: Layout, level: AiLevel): { w: World; ai: Ai } {
  const w = createWorld(seed, generateMap(seed, layout));
  const ai = createAi(0, level, seed);
  step(w, skirmishCommands(w.map));
  return { w, ai };
}

function play(w: World, ai: Ai, ticks: number, until?: () => boolean): void {
  const end = w.tick + ticks;
  while (w.tick < end && !(until && w.tick % 20 === 0 && until())) {
    const cmds: Command[] = [];
    aiThink(ai, w, cmds);
    step(w, cmds);
    w.events.length = 0;
  }
}

const forts = (w: World) => {
  const list: number[] = [];
  for (let s = 0; s < w.map.structCount; s++) if (fortified(w, s)) list.push(s);
  return list;
};

describe('the computer in a city', () => {
  it('on hard, sandbags the houses its garrisons hold, a few to a town', () => {
    const { w, ai } = match(5, 'city', 'hard');
    play(w, ai, 20 * MINUTE, () => forts(w).length >= 4);
    const done = forts(w);
    expect(done.length).toBeGreaterThanOrEqual(4);
    const per = new Map<number, number>();
    for (const s of done) {
      const t = ai.houses.findIndex((h) => h.includes(s));
      expect(t).toBeGreaterThanOrEqual(0);
      expect(w.townOwner[t]).toBe(0);
      per.set(t, (per.get(t) ?? 0) + 1);
    }
    for (const n of per.values()) expect(n).toBeLessThanOrEqual(ai.tune.forts);
  }, 120000);

  it('on easy, never does', () => {
    const { w, ai } = match(5, 'city', 'easy');
    play(w, ai, 9 * MINUTE);
    expect(forts(w).length).toBe(0);
  }, 120000);

  it('a garrison whose houses are down lies up in the ruins, three squads to a ruin', () => {
    const w = createWorld(5, generateMap(5, 'city'));
    const ai = createAi(0, 'hard', 5);
    step(w, skirmishCommands(w.map));
    const map = w.map;
    // Two houses of the first town, knocked flat.
    const t = 0;
    const houses: number[] = [];
    for (let s = 0; s < map.structCount && houses.length < 2; s++) {
      if (map.sKind[s] !== S_BUILDING || map.sW[s] * map.sH[s] < 4) continue;
      const x = (map.sX[s] << CELL_SHIFT) - map.townX[t];
      const y = (map.sY[s] << CELL_SHIFT) - map.townY[t];
      if (Math.hypot(x, y) < map.townR[t]) houses.push(s);
    }
    expect(houses.length).toBe(2);
    for (const s of houses) {
      w.sHp[s] = 0;
      razeStructure(map, s);
    }
    markTopology();
    const from = w.count;
    step(w, [
      {
        type: CMD_SPAWN,
        count: 5,
        team: 0,
        kind: KIND_INFANTRY,
        x: map.townX[t],
        y: map.townY[t],
        radius: fx(6),
        wander: false,
      },
    ]);
    const units: number[] = [];
    for (let i = from; i < w.count; i++) units.push(i);
    for (let k = 0; k < 30 * 20; k++) {
      const out: Command[] = [];
      if (k % 20 === 0) {
        billetStart(w, [units]);
        billet(ai, w, out, units, houses, map.townX[t], map.townY[t], fx(20), -1);
      }
      step(w, out);
    }
    const inRuin = [0, 0];
    for (const i of units) {
      expect(w.state[i]).toBe(STATE_ALIVE);
      const k = houses.indexOf(map.structAt[cellOfPos(w.posX[i], w.posY[i])]);
      expect(k).toBeGreaterThanOrEqual(0);
      inRuin[k]++;
    }
    expect(Math.max(...inRuin)).toBe(3);
  }, 60000);
});
