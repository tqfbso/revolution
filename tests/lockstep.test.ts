import { describe, expect, it } from 'vitest';
import { AI_TUNING, aiThink, createAi, tuningFor } from '../src/sim/ai';
import { CMD_ATTACK_MOVE, CMD_MOVE, CMD_STOP, type Command } from '../src/sim/commands';
import { fx } from '../src/sim/fixed';
import { generateMap } from '../src/sim/map';
import { skirmishCommands } from '../src/sim/scenarios';
import { step } from '../src/sim/sim';
import { createStaff, staffThink } from '../src/sim/staff';
import { createWorld, hashWorld } from '../src/sim/world';
import type { Frame } from '../src/worker/protocol';
import { GameLog, PIECE_CHARS, expand } from '../src/client/replay';

// Co-op (decision 092): the guest's sim is sent nothing but the players' orders, tick by
// tick, and must arrive at the host's world. This plays the worker's loop on both sides.

function side(seed: number, humans = 1) {
  const w = createWorld(seed, generateMap(seed, 'city'));
  const ais = [createAi(1, 'normal', seed, humans)];
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

  it('three players: two guests fed the same frames both arrive at the host world', () => {
    const host = side(5, 3);
    const guests = [side(5, 3), side(5, 3)];
    const hashes: number[][] = [[], [], []];
    for (let t = 0; t < 600; t++) {
      const wire = JSON.stringify([host.w.tick, orders(t, host.w.count)] satisfies Frame);
      host.tick((JSON.parse(wire) as Frame)[1]);
      guests[0].tick((JSON.parse(wire) as Frame)[1]);
      guests[1].tick((JSON.parse(wire) as Frame)[1]);
      if (host.w.tick % 40 === 0) {
        hashes[0].push(hashWorld(host.w));
        hashes[1].push(hashWorld(guests[0].w));
        hashes[2].push(hashWorld(guests[1].w));
      }
    }
    expect(hashes[1]).toEqual(hashes[0]);
    expect(hashes[2]).toEqual(hashes[0]);
  });

  it('the computer is strengthened for three and four players, and only then', () => {
    for (const level of ['normal', 'hard'] as const) {
      expect(tuningFor(level, 1)).toBe(AI_TUNING[level]);
      expect(tuningFor(level, 2)).toBe(AI_TUNING[level]);
      const three = tuningFor(level, 3);
      const four = tuningFor(level, 4);
      expect(three.size).toBeGreaterThan(AI_TUNING[level].size);
      expect(three.trucks).toBeGreaterThan(AI_TUNING[level].trucks);
      expect(four.size).toBeGreaterThan(three.size);
      // Decision 096: more to fight, but no sooner and no more often.
      expect(four.size * 10).toBeLessThanOrEqual(AI_TUNING[level].size * 13);
      expect(four.firstAttack).toBe(AI_TUNING[level].firstAttack);
      expect(four.rest).toBe(AI_TUNING[level].rest);
      expect(tuningFor(level, 9)).toEqual(four);
    }
  });
});

describe('co-op rejoin (decision 100)', () => {
  it('the record, cut into pieces and put together again, is the game tick for tick', () => {
    const log = new GameLog();
    const all: Frame[] = [];
    for (let t = 0; t < 9000; t++) {
      const f: Frame = [t, orders(t, 400)];
      all.push(f);
      // As the worker reports them: a few ticks at a time.
      if (t % 3 === 2) log.add(all.slice(t - 2));
    }
    expect(log.through).toBe(9000);
    const back: Frame[] = [];
    let from = 0;
    let at = 0;
    let pieces = 0;
    for (;;) {
      const next = log.piece(from, at);
      if (!next) break;
      expect(JSON.stringify(next.piece.f).length).toBeLessThan(PIECE_CHARS + 2000);
      for (const f of expand(JSON.parse(JSON.stringify(next.piece)) as typeof next.piece))
        back.push(f);
      from = next.piece.to;
      at = next.at;
      pieces++;
    }
    expect(pieces).toBeGreaterThan(3);
    expect(back).toEqual(all);
  });

  it('a player who comes back late plays the record through and stands where the host stands', () => {
    const host = side(5, 3);
    const log = new GameLog();
    const run = (n: number) => {
      for (let k = 0; k < n; k++) {
        const f: Frame = [host.w.tick, orders(host.w.tick, host.w.count)];
        log.add([f]);
        host.tick(f[1]);
      }
    };
    run(900);
    // He opens the link now; the host plays on while the record travels.
    const late = side(5, 3);
    let from = 0;
    let at = 0;
    for (;;) {
      const next = log.piece(from, at);
      if (!next) break;
      const wire = JSON.parse(JSON.stringify(next.piece)) as typeof next.piece;
      for (const f of expand(wire)) {
        expect(f[0]).toBe(late.w.tick);
        late.tick(f[1]);
      }
      from = next.piece.to;
      at = next.at;
      if (host.w.tick < 1100) run(50);
    }
    expect(late.w.tick).toBe(host.w.tick);
    expect(hashWorld(late.w)).toBe(hashWorld(host.w));
  }, 120000);
});
