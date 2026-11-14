import { describe, expect, it } from 'vitest';
import {
  CMD_ASSIGN,
  CMD_ATTACK_MOVE,
  CMD_MISSION,
  CMD_MOVE,
  type Command,
} from '../src/sim/commands';
import { fx } from '../src/sim/fixed';
import { generateMap } from '../src/sim/map';
import { skirmishCommands } from '../src/sim/scenarios';
import { step } from '../src/sim/sim';
import { createStaff, staffThink } from '../src/sim/staff';
import { KIND_INFANTRY } from '../src/sim/units';
import { B_HQ } from '../src/sim/economy';
import { M_MOVE, STATE_ALIVE, createWorld, hashWorld } from '../src/sim/world';
import type { Frame } from '../src/worker/protocol';

// Versus (decision 114): red against blue, no computer. Every sim runs the commanders of
// both armies, as the worker does, and is sent nothing but the players' orders.

function side(seed: number) {
  const w = createWorld(seed, generateMap(seed, 'city'));
  const staffs = [createStaff(0, seed), createStaff(1, seed)];
  let pending: Command[] = skirmishCommands(w.map);
  const tick = (orders: Command[]): void => {
    for (const c of orders) pending.push(c);
    for (const st of staffs) staffThink(st, w, pending);
    step(w, pending);
    pending = [];
    w.events.length = 0;
  };
  return { w, tick };
}

const of = (w: ReturnType<typeof side>['w'], team: number, kind = -1): number[] => {
  const out: number[] = [];
  for (let i = 0; i < w.count; i++) {
    if (w.state[i] === STATE_ALIVE && w.team[i] === team && (kind < 0 || w.kind[i] === kind))
      out.push(i);
  }
  return out;
};

describe('versus', () => {
  it('both armies start alike: the same troops and stores, a headquarters each', () => {
    const { w, tick } = side(4);
    tick([]);
    expect(of(w, 0).length).toBe(of(w, 1).length);
    expect(of(w, 0).length).toBeGreaterThan(10);
    expect(w.supplies[0]).toBe(w.supplies[1]);
    expect(w.fuel[0]).toBe(w.fuel[1]);
    expect(w.credits[0]).toBe(w.credits[1]);
    const hq = [0, 0];
    for (let s = 0; s < w.map.structCount; s++) {
      if (w.sType[s] === B_HQ && w.sTeam[s] < 2) hq[w.sTeam[s]]++;
    }
    expect(hq).toEqual([1, 1]);
  });

  it("blue's commanders work like red's: a Move mission marches its squads there", () => {
    const { w, tick } = side(4);
    tick([]);
    const squads = of(w, 1, KIND_INFANTRY).slice(0, 6);
    const x = w.posX[squads[0]] - fx(90);
    const y = w.posY[squads[0]];
    tick([
      { type: CMD_ASSIGN, units: squads, slot: 0 },
      { type: CMD_MISSION, team: 1, slot: 0, mission: M_MOVE, x, y },
    ]);
    for (let t = 0; t < 900; t++) tick([]);
    for (const i of squads) {
      expect(Math.hypot(w.posX[i] - x, w.posY[i] - y)).toBeLessThan(fx(30));
    }
    // Red's commander 0 was given nothing and has nobody.
    expect(of(w, 0).every((i) => w.cmdr[i] < 0)).toBe(true);
  });

  it('a guest fed only the frames arrives at the host world, orders from both sides', () => {
    const host = side(6);
    const guest = side(6);
    host.tick([]);
    guest.tick([]);
    const red = of(host.w, 0);
    const blue = of(host.w, 1);
    const hashes: number[][] = [[], []];
    for (let t = 0; t < 700; t++) {
      const cmds: Command[] = [];
      if (t % 60 === 5) {
        cmds.push({ type: CMD_ATTACK_MOVE, units: red.slice(0, 8), x: fx(512), y: fx(512) });
        cmds.push({ type: CMD_MOVE, units: blue.slice(0, 8), x: fx(500), y: fx(520) });
      }
      if (t === 20) {
        cmds.push({ type: CMD_ASSIGN, units: blue.slice(8, 14), slot: 1 });
        cmds.push({ type: CMD_MISSION, team: 1, slot: 1, mission: M_MOVE, x: fx(600), y: fx(600) });
      }
      const wire = JSON.stringify([host.w.tick, cmds] satisfies Frame);
      host.tick((JSON.parse(wire) as Frame)[1]);
      guest.tick((JSON.parse(wire) as Frame)[1]);
      if (host.w.tick % 50 === 0) {
        hashes[0].push(hashWorld(host.w));
        hashes[1].push(hashWorld(guest.w));
      }
    }
    expect(hashes[1]).toEqual(hashes[0]);
    expect(hashes[0].length).toBe(14);
  });
});
