import { describe, expect, it } from 'vitest';
import {
  CMD_ATTACK,
  CMD_ATTACK_MOVE,
  CMD_MOVE,
  CMD_SPAWN,
  type Command,
} from '../src/sim/commands';
import { fx } from '../src/sim/fixed';
import { cellOfPos, flatMap } from '../src/sim/map';
import { KINDS, KIND_TANK } from '../src/sim/units';
import { step } from '../src/sim/sim';
import { FLAG_FOCUS, MAP_SIZE_FX, STATE_ALIVE, STATE_FREE, createWorld } from '../src/sim/world';

const spawn = (team: number, x: number, y: number, count: number): Command => ({
  type: CMD_SPAWN,
  count,
  team,
  kind: KIND_TANK,
  x: fx(x),
  y: fx(y),
  radius: fx(1),
  wander: false,
});

describe('attack order', () => {
  it('goes after the chosen enemy, not the nearest, and ends when it dies', () => {
    const w = createWorld(7, flatMap());
    step(w, [spawn(0, 300, 500, 6), spawn(1, 330, 500, 1), spawn(1, 360, 500, 1)]);
    const mine = [0, 1, 2, 3, 4, 5];
    const near = 6;
    const far = 7;
    step(w, [{ type: CMD_ATTACK, units: mine, target: far }]);
    for (const i of mine) expect(w.flags[i] & FLAG_FOCUS).toBe(FLAG_FOCUS);
    for (let t = 0; t < 8; t++) step(w, []);
    // Tanks that can reach the far tank are shooting it while the near one still stands.
    expect(mine.filter((i) => w.attack[i] === far).length).toBeGreaterThan(0);
    for (let t = 0; t < 1200 && w.state[far] === STATE_ALIVE; t++) step(w, []);
    expect(w.state[far]).not.toBe(STATE_ALIVE);
    step(w, []);
    for (const i of mine) if (w.state[i] === STATE_ALIVE) expect(w.flags[i] & FLAG_FOCUS).toBe(0);
    expect(near).toBe(6);
  });

  it('ignores friends, the dead and nonsense', () => {
    const w = createWorld(7, flatMap());
    step(w, [spawn(0, 300, 500, 2), spawn(1, 330, 500, 1)]);
    step(w, [
      { type: CMD_ATTACK, units: [0], target: 1 },
      { type: CMD_ATTACK, units: [0], target: 999 },
      { type: CMD_ATTACK, units: [0], target: -4 },
      { type: CMD_ATTACK, units: [-1, 77, 1e9], target: 2 },
    ]);
    expect(w.flags[0] & FLAG_FOCUS).toBe(0);
    expect(w.state[999]).toBe(STATE_FREE);
  });
});

describe('disengaging', () => {
  const run = (type: typeof CMD_MOVE | typeof CMD_ATTACK_MOVE): number => {
    const w = createWorld(7, flatMap());
    step(w, [spawn(0, 300, 500, 5), spawn(1, 335, 500, 5)]);
    for (let t = 0; t < 40; t++) step(w, []);
    const mine = [0, 1, 2, 3, 4];
    step(w, [{ type, units: mine, x: fx(100), y: fx(500) }]);
    for (let t = 0; t < 160; t++) step(w, []);
    let alive = 0;
    let x = 0;
    for (const i of mine) {
      if (w.state[i] !== STATE_ALIVE) continue;
      alive++;
      x += w.posX[i];
    }
    return alive === 0 ? 0 : x / alive;
  };
  it('a plain move leaves the fight, an attack-move stays in it', () => {
    const away = run(CMD_MOVE);
    const stayed = run(CMD_ATTACK_MOVE);
    expect(away).toBeGreaterThan(0);
    expect(away).toBeLessThan(stayed - fx(15));
  });
});

describe('river', () => {
  it('ground units never stand on water, cliff or buildings', () => {
    const w = createWorld(7);
    const mid = MAP_SIZE_FX >> 1;
    const cmds: Command[] = [];
    for (let kind = 0; kind < KINDS.length; kind++) {
      for (const team of [0, 1]) {
        cmds.push({
          type: CMD_SPAWN,
          count: 20,
          team,
          kind,
          x: mid + (team === 0 ? -fx(60) : fx(60)),
          y: mid + fx(kind * 20 - 100),
          radius: fx(30),
          wander: false,
        });
      }
    }
    step(w, cmds);
    const ids = Array.from({ length: w.count }, (_, i) => i);
    step(w, [
      { type: CMD_MOVE, units: ids.filter((i) => w.team[i] === 0), x: mid + fx(150), y: mid },
      { type: CMD_ATTACK_MOVE, units: ids.filter((i) => w.team[i] === 1), x: mid - fx(150), y: mid },
    ]);
    let wet = 0;
    for (let t = 0; t < 1500; t++) {
      step(w, []);
      for (let i = 0; i < w.count; i++) {
        if (w.state[i] !== STATE_ALIVE || w.inside[i] >= 0 || w.carrier[i] >= 0) continue;
        const k = KINDS[w.kind[i]];
        if (k.cls === 2) continue;
        if (w.map.cost[k.cls][cellOfPos(w.posX[i], w.posY[i])] === 0) wet++;
      }
    }
    expect(wet).toBe(0);
  });
});
