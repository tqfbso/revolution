import { describe, expect, it } from 'vitest';
import {
  CMD_CANCEL,
  CMD_FOUND,
  CMD_KEEP,
  CMD_ORDER,
  CMD_REPEAT,
  CMD_TRAIN,
  type Command,
} from '../src/sim/commands';
import { B_BARRACKS, B_HQ, unitPrice } from '../src/sim/economy';
import { createGame, defaultMatch, type Match } from '../src/sim/match';
import { KIND_INFANTRY } from '../src/sim/units';
import {
  SPENT_NOBODY,
  SPENT_ON_UNITS,
  SPENT_STRIDE,
  SPENT_SUPPLIES,
  SPENT_UNITS,
  hashWorld,
  type World,
} from '../src/sim/world';

// Who spent what in a shared army: the books follow the orders, the same on every machine,
// and change nothing in the game.

function coop(duties: number[]): Match {
  return { ...defaultMatch(), seed: 5, players: duties.map((duty) => ({ army: 0, duty })) };
}

function order(game: ReturnType<typeof createGame>, seat: number, ...raw: Command[]): void {
  const signed = raw.map((c) => game.sign(c, seat));
  expect(signed.every((c) => c !== null)).toBe(true);
  game.tick(signed as Command[]);
}

/** Army 0's barracks, put up beside its headquarters if it has none yet. */
function barracks(game: ReturnType<typeof createGame>): number {
  const w = game.world;
  const find = (type: number): number => {
    for (let s = 0; s < w.map.structCount; s++) {
      if (w.sTeam[s] === 0 && w.sType[s] === type && w.sHp[s] > 0) return s;
    }
    return -1;
  };
  if (find(B_BARRACKS) < 0) {
    const hq = find(B_HQ);
    const x = w.map.sX[hq] + 10;
    const y = w.map.sY[hq];
    game.tick([{ type: CMD_FOUND, team: 0, building: B_BARRACKS, x, y }]);
  }
  const s = find(B_BARRACKS);
  if (s < 0) throw new Error('no barracks');
  return s;
}

const units = (w: World, row: number) => w.spent[row * SPENT_STRIDE + SPENT_UNITS];
const supplies = (w: World, row: number) => w.spent[row * SPENT_STRIDE + SPENT_SUPPLIES];

function rich(w: World): void {
  w.supplies[0] = 100000;
  w.fuel[0] = 100000;
  w.credits[0] = 100000;
}

describe('who spent what', () => {
  it('books a trained unit to the player who ordered it, and a refund back to him', () => {
    const game = createGame(coop([0, 0]));
    const w = game.world;
    game.tick([]);
    rich(w);
    const s = barracks(game);
    const p = unitPrice(w, 0, KIND_INFANTRY);
    order(game, 1, { type: CMD_TRAIN, structure: s, kind: KIND_INFANTRY });
    order(game, 0, { type: CMD_TRAIN, structure: s, kind: KIND_INFANTRY });
    order(game, 1, { type: CMD_TRAIN, structure: s, kind: KIND_INFANTRY });
    expect(units(w, 1)).toBe(2);
    expect(units(w, 0)).toBe(1);
    expect(supplies(w, 1)).toBe(2 * p.supplies);
    // Seat 0 takes the last one off the queue: it was seat 1's, so seat 1 gets it back.
    order(game, 0, { type: CMD_CANCEL, structure: s });
    expect(units(w, 1)).toBe(1);
    expect(units(w, 0)).toBe(1);
    expect(w.spent[1 * SPENT_STRIDE + SPENT_ON_UNITS]).toBe(p.supplies + p.fuel + p.credits);
  });

  it('books bulk orders to who ordered them as factories take them, repeats to who set it', () => {
    const game = createGame(coop([0, 0]));
    const w = game.world;
    game.tick([]);
    rich(w);
    const s = barracks(game);
    order(game, 0, { type: CMD_ORDER, team: 0, kind: KIND_INFANTRY, count: 3 });
    order(game, 1, { type: CMD_ORDER, team: 0, kind: KIND_INFANTRY, count: 1 });
    // Seat 1 changes his mind: the cut comes off his own.
    order(game, 1, { type: CMD_ORDER, team: 0, kind: KIND_INFANTRY, count: -1 });
    for (let t = 0; t < 400 && w.orders[KIND_INFANTRY] > 0; t++) game.tick([]);
    expect(w.orders[KIND_INFANTRY]).toBe(0);
    expect(units(w, 0)).toBe(3);
    expect(units(w, 1)).toBe(0);

    order(game, 1, { type: CMD_TRAIN, structure: s, kind: KIND_INFANTRY });
    order(game, 1, { type: CMD_REPEAT, structure: s, on: true });
    for (let t = 0; t < 2000 && units(w, 1) < 3; t++) game.tick([]);
    expect(units(w, 1)).toBeGreaterThanOrEqual(3);
    expect(units(w, 0)).toBe(3);
  });

  it("a standing order is its setter's; what nobody ordered is the army's", () => {
    const game = createGame(coop([0, 0]));
    const w = game.world;
    game.tick([]);
    rich(w);
    barracks(game);
    order(game, 1, { type: CMD_KEEP, team: 0, kind: KIND_INFANTRY, count: 60 });
    for (let t = 0; t < 600; t++) game.tick([]);
    expect(units(w, 1)).toBeGreaterThan(0);
    expect(units(w, 0)).toBe(0);
    // The computer's spending sits on its own army's row, never on a player's.
    expect(supplies(w, SPENT_NOBODY(1))).toBeGreaterThan(0);
  });

  it('changes nothing in the game: the hash is the same with the books wiped every tick', () => {
    const run = (wipe: boolean): number => {
      const game = createGame(coop([0, 1]));
      const w = game.world;
      game.tick([]);
      const s = barracks(game);
      order(game, 1, { type: CMD_TRAIN, structure: s, kind: KIND_INFANTRY });
      order(game, 0, { type: CMD_ORDER, team: 0, kind: KIND_INFANTRY, count: 2 });
      for (let t = 0; t < 600; t++) {
        if (wipe) w.spent.fill(0);
        game.tick([]);
      }
      return hashWorld(w);
    };
    expect(run(true)).toBe(run(false));
  });
});
