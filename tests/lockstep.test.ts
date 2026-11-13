import { describe, expect, it } from 'vitest';
import { aiThink, createAi } from '../src/sim/ai';
import { CMD_ATTACK_MOVE, CMD_MOVE, CMD_STOP, type Command } from '../src/sim/commands';
import { fx } from '../src/sim/fixed';
import { generateMap } from '../src/sim/map';
import { skirmishCommands } from '../src/sim/scenarios';
import { step } from '../src/sim/sim';
import { createStaff, staffThink } from '../src/sim/staff';
import { createWorld, hashWorld } from '../src/sim/world';
import type { Frame } from '../src/worker/protocol';

// Co-op (decision 092): the guest's sim is sent nothing but the players' orders, tick by
// tick, and must arrive at the host's world. This plays the worker's loop on both sides.

function side(seed: number) {
  const w = createWorld(seed, generateMap(seed, 'city'));
  const ais = [createAi(1, 'normal', seed)];
  const staff = createStaff(0, seed);
  let pending: Command[] = skirmishCommands(w.map);
  const tick = (orders: Command[]): void => {
    for (const c of orders) pending.push(c);
    for (const ai of ais) aiThink(ai, w, pending);
    staffThink(staff, w, pending);
    step(w, pending);
    pending = [];
    w.events.length = 0;
  };
  return { w, tick };
}

/** Orders as two players would give them: some each tick, from either of them. */
function orders(tick: number, count: number): Command[] {
  let s = (tick * 2654435761) >>> 0;
  const next = (n: number) => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    return s % n;
  };
  const out: Command[] = [];
  if (tick % 7 !== 0) return out;
  for (let k = 0; k < 2; k++) {
    const units: number[] = [];
    const from = next(Math.max(1, count - 8));
    for (let i = 0; i < 6; i++) units.push(from + i);
    const kind = next(5);
    if (kind === 0) out.push({ type: CMD_STOP, units });
    else
      out.push({
        type: kind < 3 ? CMD_MOVE : CMD_ATTACK_MOVE,
        units,
        x: fx(200 + next(600)),
        y: fx(200 + next(600)),
      });
  }
  return out;
}

describe('co-op lockstep', () => {
  it('a guest fed only the frames arrives at the host world, hash for hash', () => {
    const host = side(3);
    const guest = side(3);
    const wire: string[] = [];
    const hostHashes: number[] = [];
    for (let t = 0; t < 900; t++) {
      const cmds = orders(t, host.w.count);
      // What goes over the network is text: nothing but plain data may be in a frame.
      wire.push(JSON.stringify([host.w.tick, cmds] satisfies Frame));
      host.tick(cmds);
      if (host.w.tick % 40 === 0) hostHashes.push(hashWorld(host.w));
    }
    const guestHashes: number[] = [];
    for (const text of wire) {
      const [t, cmds] = JSON.parse(text) as Frame;
      expect(t).toBe(guest.w.tick);
      guest.tick(cmds);
      if (guest.w.tick % 40 === 0) guestHashes.push(hashWorld(guest.w));
    }
    expect(guestHashes).toEqual(hostHashes);
    expect(hostHashes.length).toBe(22);
  });

  it('one order more or less on one side is caught by the hashes', () => {
    const a = side(3);
    const b = side(3);
    for (let t = 0; t < 120; t++) {
      const cmds = orders(t, a.w.count);
      a.tick(cmds);
      b.tick(t === 60 ? [] : cmds);
    }
    expect(orders(63, a.w.count).length).toBeGreaterThan(0);
    for (let t = 120; t < 400; t++) {
      a.tick([]);
      b.tick(t === 130 ? orders(63, b.w.count) : []);
    }
    expect(hashWorld(a.w)).not.toBe(hashWorld(b.w));
  });
});
