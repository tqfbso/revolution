import { describe, expect, it } from 'vitest';
import { CMD_DUTY, CMD_GIVE, CMD_MOVE, CMD_STOP, type Command } from '../src/sim/commands';
import { fx } from '../src/sim/fixed';
import { cleanName, createGame, defaultMatch, validMatch, type Match } from '../src/sim/match';
import { spawnUnit } from '../src/sim/sim';
import { DUTY_KINDS, KIND_INFANTRY, KIND_TANK, KIND_TRUCK } from '../src/sim/units';
import { NO_SEAT, STATE_ALIVE, hashWorld, type World } from '../src/sim/world';
import { parseMsg } from '../src/client/wire';

// A shared army (decision 146): every unit is one player's or nobody's in particular, the
// same on every machine, and it locks nothing.

/** Co-op against the computer: `duties` by seat, everyone on army 0. */
function coop(duties: number[]): Match {
  return { ...defaultMatch(), seed: 5, players: duties.map((duty) => ({ army: 0, duty })) };
}

const mine = (w: World, team: number): number[] => {
  const out: number[] = [];
  for (let i = 0; i < w.count; i++)
    if (w.state[i] === STATE_ALIVE && w.team[i] === team) out.push(i);
  return out;
};

/** Run one tick with these orders from `seat`, signed as the worker signs them. */
function order(game: ReturnType<typeof createGame>, seat: number, ...raw: Command[]): void {
  const signed = raw.map((c) => game.sign(c, seat));
  expect(signed.every((c) => c !== null)).toBe(true);
  game.tick(signed as Command[]);
}

describe('whose a unit is', () => {
  it('new units go to the player whose role covers them, the rest to nobody', () => {
    // Seat 0 everything, seat 1 armour, seat 2 infantry.
    const game = createGame(coop([0, 1, 2]));
    const w = game.world;
    game.tick([]);
    const tank = spawnUnit(w, KIND_TANK, 0, fx(300), fx(300));
    const squad = spawnUnit(w, KIND_INFANTRY, 0, fx(300), fx(310));
    const truck = spawnUnit(w, KIND_TRUCK, 0, fx(300), fx(320));
    const foe = spawnUnit(w, KIND_TANK, 1, fx(700), fx(700));
    expect(w.owner[tank]).toBe(1);
    expect(w.owner[squad]).toBe(2);
    expect(w.owner[truck]).toBe(NO_SEAT);
    expect(w.owner[foe]).toBe(NO_SEAT);
    // The army the game starts with was shared out the same way.
    for (const id of mine(w, 0)) {
      const want = [1, 2].find((s) => DUTY_KINDS[s].includes(w.kind[id])) ?? NO_SEAT;
      expect(w.owner[id]).toBe(want);
    }
  });

  it('players with the same role take turns', () => {
    const game = createGame(coop([1, 1]));
    const w = game.world;
    game.tick([]);
    const got = [0, 0];
    for (let k = 0; k < 6; k++)
      got[w.owner[spawnUnit(w, KIND_TANK, 0, fx(300), fx(300 + 8 * k))]]++;
    expect(got).toEqual([3, 3]);
  });

  it("a unit that is nobody's becomes his who first orders it, and stays his", () => {
    const game = createGame(coop([0, 0]));
    const w = game.world;
    game.tick([]);
    const ids = mine(w, 0).slice(0, 4);
    expect(ids.every((id) => w.owner[id] === NO_SEAT)).toBe(true);
    order(game, 1, { type: CMD_MOVE, units: ids, x: fx(400), y: fx(400) });
    expect(ids.every((id) => w.owner[id] === 1)).toBe(true);
    // Nothing is locked: the other player's order is obeyed, and the unit is still seat 1's.
    order(game, 0, { type: CMD_STOP, units: ids });
    expect(ids.every((id) => w.owner[id] === 1 && w.seat[id] === 0)).toBe(true);
  });

  it('is handed over, taken and given back to nobody by an order', () => {
    const game = createGame(coop([0, 0]));
    const w = game.world;
    game.tick([]);
    const ids = mine(w, 0).slice(0, 5);
    order(game, 0, { type: CMD_GIVE, units: ids, to: 1 });
    expect(ids.every((id) => w.owner[id] === 1)).toBe(true);
    order(game, 0, { type: CMD_GIVE, units: ids.slice(0, 2), to: 0 });
    expect(ids.map((id) => w.owner[id])).toEqual([0, 0, 1, 1, 1]);
    order(game, 1, { type: CMD_GIVE, units: ids, to: -1 });
    expect(ids.every((id) => w.owner[id] === NO_SEAT)).toBe(true);
    // Not to a seat nobody sits in, and a hand-over interrupts nothing the unit is doing.
    order(game, 0, { type: CMD_GIVE, units: ids, to: 3 });
    order(game, 0, { type: CMD_GIVE, units: ids, to: 9 });
    expect(ids.every((id) => w.owner[id] === NO_SEAT)).toBe(true);
  });

  it("an enemy's units cannot be handed over, nor ours to the other side", () => {
    // Versus: seat 0 red, seat 1 blue.
    const match: Match = {
      ...defaultMatch(),
      armies: [
        { faction: 0, controller: 'human' },
        { faction: 0, controller: 'human' },
      ],
      players: [
        { army: 0, duty: 0 },
        { army: 1, duty: 0 },
      ],
    };
    const game = createGame(match);
    const w = game.world;
    game.tick([]);
    const red = mine(w, 0).slice(0, 3);
    const blue = mine(w, 1).slice(0, 3);
    expect(game.sign({ type: CMD_GIVE, units: blue, to: 0 }, 0)).toBeNull();
    order(game, 0, { type: CMD_GIVE, units: red, to: 1 });
    expect(red.every((id) => w.owner[id] === NO_SEAT)).toBe(true);
  });

  it('a role changed in the game decides who gets the next units', () => {
    const game = createGame(coop([0, 0]));
    const w = game.world;
    game.tick([]);
    expect(w.owner[spawnUnit(w, KIND_TANK, 0, fx(300), fx(300))]).toBe(NO_SEAT);
    order(game, 1, { type: CMD_DUTY, duty: 1 });
    expect(Array.from(w.duty.slice(0, 2))).toEqual([0, 1]);
    expect(w.owner[spawnUnit(w, KIND_TANK, 0, fx(300), fx(310))]).toBe(1);
    // A role there is not is no role.
    order(game, 1, { type: CMD_DUTY, duty: 77 });
    expect(w.duty[1]).toBe(1);
  });

  it('changes nothing in the battle: the same game hash for hash, whoever owns what', () => {
    const plain = createGame(coop([0, 0]));
    const busy = createGame(coop([1, 2]));
    for (let t = 0; t < 300; t++) {
      plain.tick([]);
      const w = busy.world;
      const orders: Command[] = [];
      if (t % 20 === 5) {
        const ids = mine(w, 0);
        orders.push({
          type: CMD_GIVE,
          units: ids.slice(0, 6),
          to: t % 40 === 5 ? 0 : 1,
          by: 0,
          army: 0,
        });
        orders.push({ type: CMD_DUTY, duty: ((t / 20) % 5) | 0, by: 1, army: 0 });
      }
      busy.tick(orders);
      expect(hashWorld(busy.world)).toBe(hashWorld(plain.world));
    }
  });
});

describe('names', () => {
  it('are cleaned to letters, digits and a few marks, and kept short', () => {
    expect(cleanName('  Sofia  ')).toBe('Sofia');
    expect(cleanName('<b>Tom</b>')).toBe('bTomb');
    expect(cleanName("José O'Neil-Smith the Third")).toBe("José O'Neil-");
    expect(cleanName(7)).toBe('');
    expect(cleanName('<>&"')).toBe('');
  });

  it('a match or a message with a name that is not clean is refused', () => {
    const ok = coop([0, 0]);
    ok.players[1].name = 'Sofia';
    expect(validMatch(ok)).toBe(true);
    ok.players[1].name = '<img src=x>';
    expect(validMatch(ok)).toBe(false);
    expect(parseMsg({ t: 'hello', build: 'abc', duty: 0, name: 'Tom' })).not.toBeNull();
    expect(parseMsg({ t: 'hello', build: 'abc', duty: 0, name: '<i>Tom' })).toBeNull();
    expect(parseMsg({ t: 'duty', duty: 1, name: 'x'.repeat(40) })).toBeNull();
    expect(parseMsg({ t: 'mark', x: 1, z: 2, from: 1, k: 2 })).not.toBeNull();
  });
});
