import { describe, expect, it } from 'vitest';
import {
  CMD_ATTACK,
  CMD_FOUND,
  CMD_LOAD,
  CMD_MISSION,
  CMD_MOVE,
  CMD_ORDER,
  CMD_SPAWN,
  CMD_STOP,
  CMD_TRAIN,
  type Command,
} from '../src/sim/commands';
import { B_HQ } from '../src/sim/economy';
import { fx } from '../src/sim/fixed';
import { admit } from '../src/sim/guard';
import {
  createGame,
  defaultMatch,
  isVersus,
  seatsOf,
  validMatch,
  type Game,
  type Match,
} from '../src/sim/match';
import { spawnUnit, step } from '../src/sim/sim';
import { KIND_IFV, KIND_INFANTRY, KIND_TANK } from '../src/sim/units';
import { FLAG_MOVING, M_ATTACK, STATE_ALIVE, STATE_FREE, hashWorld } from '../src/sim/world';
import type { Frame } from '../src/worker/protocol';
import { matchFromParams, matchLabel, matchToParams } from '../src/client/setup';
import { legacy, playerOrders, toMatch, type LegacySetup } from './legacy';

// Decision 137: one description of a game, and every order signed with the army that gave
// it and checked against that army inside the sim.

const unitsOf = (g: Game, army: number, kind = -1): number[] => {
  const w = g.world;
  const out: number[] = [];
  for (let i = 0; i < w.count; i++) {
    if (w.state[i] === STATE_ALIVE && w.team[i] === army && (kind < 0 || w.kind[i] === kind))
      out.push(i);
  }
  return out;
};

/** A game with its first tick run: the armies are on the field. */
function begun(match: Match = defaultMatch()): Game {
  const g = createGame(match);
  g.tick([]);
  g.world.events.length = 0;
  return g;
}

const versus = (): Match => ({
  ...defaultMatch(),
  armies: [
    { faction: 1, controller: 'human' },
    { faction: 2, controller: 'human' },
  ],
  players: [
    { army: 0, duty: 0 },
    { army: 1, duty: 0 },
    { army: 0, duty: 2 },
  ],
});

describe('a game built from its Match is the game the worker always ran', () => {
  // The old loop is kept in tests/legacy.ts. Every order here is signed and checked on the
  // new side and not on the old: the hashes agree, so signing changes nothing that is legal.
  const cases: { name: string; setup: LegacySetup; seats: number[]; ticks: number }[] = [
    {
      name: 'alone against the computer, with factions',
      setup: { seed: 1, layout: 'city', ai: 'easy', factions: [1, 2, 0, 0] },
      seats: [0],
      ticks: 2400,
    },
    {
      name: 'three players together, at night',
      setup: { seed: 7, layout: 'ridge', ai: 'normal', humans: 3, night: true },
      seats: [0, 0, 0],
      ticks: 1600,
    },
    {
      name: 'a free-for-all of four in the snow',
      setup: { seed: 3, layout: 'four', ai: 'hard', armies: 4, weather: 3, factions: [1, 2, 3, 1] },
      seats: [0],
      ticks: 1600,
    },
    {
      name: 'versus, two against one',
      setup: { seed: 4, layout: 'city', ai: 'easy', versus: true, humans: 3 },
      seats: [0, 1, 0],
      ticks: 1600,
    },
    {
      name: 'the computer against itself',
      setup: { seed: 9, layout: 'euro', ai: 'hard', demo: true, weather: 1 },
      seats: [],
      ticks: 1600,
    },
    {
      name: 'the assault scenario',
      setup: { seed: 1, layout: 'river', ai: 'easy', scenario: 'assault', units: 1200 },
      seats: [0],
      ticks: 300,
    },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const old = legacy(c.setup);
      const game = createGame(toMatch(c.setup, c.seats));
      let given = 0;
      for (let t = 0; t < c.ticks; t++) {
        const orders = c.seats.flatMap((army, seat) => playerOrders(old.w, army, seat));
        // Through JSON, as over the network: nothing but plain data is in an order.
        const signed = (JSON.parse(JSON.stringify(orders)) as Command[]).map((o) =>
          game.sign(o, o.by ?? 0, game.world.tick),
        );
        expect(signed.every((o) => o !== null && o.army === c.seats[o.by ?? 0])).toBe(true);
        given += orders.length;
        old.tick(orders);
        game.tick(signed as Command[]);
        game.world.events.length = 0;
        if (t % 100 === 99) expect(hashWorld(game.world)).toBe(hashWorld(old.w));
      }
      expect(hashWorld(game.world)).toBe(hashWorld(old.w));
      if (c.seats.length > 0) expect(given).toBeGreaterThan(4);
      // Neither the computers nor the staffs ever gave an order that was not theirs to give.
      expect(game.world.refused).toBe(0);
    });
  }
});

describe('who runs each army', () => {
  it('a computer for every army that is the computer’s, a staff for every army of players', () => {
    const solo = createGame(defaultMatch());
    expect(solo.ais.map((a) => a?.team ?? -1)).toEqual([-1, 1]);
    expect(solo.staffs.map((s) => s?.team ?? -1)).toEqual([0, -1]);
    const v = createGame(versus());
    expect(v.ais).toEqual([null, null]);
    expect(v.staffs.map((s) => s?.team ?? -1)).toEqual([0, 1]);
    expect(isVersus(versus())).toBe(true);
    expect(isVersus(defaultMatch())).toBe(false);
    expect(seatsOf(versus(), 0)).toEqual([0, 2]);
  });

  it('the computer is strengthened for the players it faces', () => {
    const three = createGame({
      ...defaultMatch(),
      armies: [
        { faction: 0, controller: 'human' },
        { faction: 0, controller: 'ai', level: 'normal' },
      ],
      players: [0, 1, 2].map(() => ({ army: 0, duty: 0 })),
    });
    const one = createGame({
      ...defaultMatch(),
      armies: [
        { faction: 0, controller: 'human' },
        { faction: 0, controller: 'ai', level: 'normal' },
      ],
    });
    expect(three.ais[1]?.tune.size).toBeGreaterThan(one.ais[1]?.tune.size ?? 0);
  });
});

describe('an order is signed with its army, and the sim holds it to that', () => {
  it('signs with the seat and the army of that seat, whatever the order says of itself', () => {
    const g = begun(versus());
    const blue = unitsOf(g, 1).slice(0, 3);
    const out = g.sign({ type: CMD_STOP, units: blue, by: 0, army: 0 }, 1, 5);
    expect(out).toEqual({ type: CMD_STOP, units: blue, by: 1, army: 1, seen: 5 });
    expect(g.sign({ type: CMD_STOP, units: blue }, 7)).toBeNull();
  });

  it('inside the sim: an order signed for red does not move a blue unit', () => {
    const g = begun(versus());
    const w = g.world;
    const red = unitsOf(g, 0, KIND_INFANTRY).slice(0, 2);
    const blue = unitsOf(g, 1, KIND_INFANTRY).slice(0, 2);
    const to = { x: w.posX[red[0]] + fx(60), y: w.posY[red[0]] };
    // Straight into step, past every door: the check is in the sim itself.
    step(w, [{ type: CMD_MOVE, units: [...red, ...blue], ...to, army: 0 }]);
    for (const id of red) expect(w.flags[id] & FLAG_MOVING).not.toBe(0);
    for (const id of blue) expect(w.flags[id] & FLAG_MOVING).toBe(0);
    expect(w.refused).toBe(1);
    // The same order unsigned is the game's own, and is not checked.
    step(w, [{ type: CMD_MOVE, units: blue, x: w.posX[blue[0]] - fx(60), y: w.posY[blue[0]] }]);
    for (const id of blue) expect(w.flags[id] & FLAG_MOVING).not.toBe(0);
  });

  it('refuses a signed order that is the game’s own, another army’s, or for its buildings', () => {
    const g = begun(versus());
    const w = g.world;
    let theirs = -1;
    for (let s = 0; s < w.map.structCount; s++) {
      if (w.sType[s] === B_HQ && w.sTeam[s] === 1) theirs = s;
    }
    const bad: Command[] = [
      { type: CMD_SPAWN, count: 50, team: 0, x: 0, y: 0, radius: fx(9), wander: false },
      { type: CMD_FOUND, team: 0, building: B_HQ, x: 100, y: 100 },
      { type: CMD_ORDER, team: 1, kind: KIND_TANK, count: 5 },
      { type: CMD_MISSION, team: 1, slot: 0, mission: M_ATTACK, x: 0, y: 0 },
      { type: CMD_TRAIN, structure: theirs, kind: KIND_INFANTRY },
      { type: CMD_STOP, units: unitsOf(g, 1) },
      { type: CMD_LOAD, units: unitsOf(g, 0, KIND_INFANTRY), carriers: unitsOf(g, 1, KIND_IFV) },
    ];
    for (const c of bad) expect(admit(w, { ...c, army: 0 })).toBeNull();
    for (const c of bad) expect(admit(w, { ...c, army: 9 })).toBeNull();
    const calm = createGame(versus());
    calm.tick([]);
    for (let k = 0; k < 30; k++) {
      step(
        w,
        bad.map((c) => ({ ...c, army: 0 })),
      );
      step(calm.world, []);
    }
    expect(hashWorld(w)).toBe(hashWorld(calm.world));
    // An enemy may be named as a target: that is what an attack is.
    const red = unitsOf(g, 0, KIND_INFANTRY).slice(0, 2);
    const target = unitsOf(g, 1)[0];
    expect(admit(w, { type: CMD_ATTACK, units: red, target, army: 0 })).not.toBeNull();
  });

  it('does not change the order it was given', () => {
    const g = begun(versus());
    const mixed = [...unitsOf(g, 0).slice(0, 2), ...unitsOf(g, 1).slice(0, 2)];
    const order: Command = { type: CMD_STOP, units: mixed.slice(), army: 0 };
    const out = admit(g.world, order);
    expect(order.units).toEqual(mixed);
    expect(out).not.toBe(order);
    expect((out as { units: number[] }).units).toEqual(mixed.slice(0, 2));
  });

  it('leaves out a unit that took a dead one’s number after the player last looked', () => {
    const g = begun(versus());
    const w = g.world;
    const [dead, other] = unitsOf(g, 0, KIND_INFANTRY);
    const seen = w.tick;
    // The squad dies and its number is given to a new one, as it is in a long battle.
    w.state[dead] = STATE_FREE;
    for (let k = 0; k < 3; k++) step(w, []);
    const fresh = spawnUnit(w, KIND_TANK, 0, w.posX[other], w.posY[other]);
    expect(fresh).toBe(dead);
    expect(w.born[fresh]).toBe(w.tick);
    step(w, []);
    const order: Command = { type: CMD_STOP, units: [dead, other], army: 0, seen };
    expect((admit(w, order) as { units: number[] }).units).toEqual([other]);
    // Given on a picture that shows the new one, it is meant.
    expect((admit(w, { ...order, seen: w.tick }) as { units: number[] }).units).toEqual([
      dead,
      other,
    ]);
  });

  it('host and guest, both checking, stay in step when a player tries the other side’s units', () => {
    const host = begun(versus());
    const guest = begun(versus());
    for (let t = 0; t < 400; t++) {
      const orders: Command[] = [];
      if (t % 9 === 0) {
        // Seat 1 (blue) orders a mix of both armies; only the blue part is his.
        const mixed = [...unitsOf(host, 0).slice(0, 4), ...unitsOf(host, 1).slice(0, 4)];
        const raw = { type: CMD_MOVE, units: mixed, x: fx(300 + t), y: fx(500) };
        const signed = host.sign(raw, 1, host.world.tick);
        if (signed) orders.push(signed);
        // And one the host never signed slips into a frame all the same: every sim drops it.
        orders.push({ type: CMD_STOP, units: unitsOf(host, 0).slice(0, 3), army: 1, by: 1 });
      }
      const frame = JSON.parse(JSON.stringify([host.world.tick, orders])) as Frame;
      host.tick(orders);
      guest.tick(frame[1]);
      host.world.events.length = guest.world.events.length = 0;
      if (t % 40 === 0) expect(hashWorld(guest.world)).toBe(hashWorld(host.world));
    }
    expect(host.world.refused).toBeGreaterThan(0);
    expect(guest.world.refused).toBe(host.world.refused);
  });
});

describe('a Match from an address, and back', () => {
  const from = (q: string) => matchFromParams(new URLSearchParams(q));

  it('reads the game the flags have always asked for', () => {
    expect(from('')).toEqual({
      ...defaultMatch(),
      armies: [
        { faction: 1, controller: 'human' },
        { faction: 2, controller: 'ai', level: 'easy' },
      ],
    });
    const ffa = from('armies=4&map=euro&ai=hard&army=china&foe=nato&time=night&weather=fog&seed=7');
    expect(ffa.map).toBe('four');
    expect(ffa.seed).toBe(7);
    expect(ffa.night).toBe(true);
    expect(ffa.weather).toBe(2);
    // The third and fourth armies take the powers that follow the second's.
    expect(ffa.armies.map((a) => a.faction)).toEqual([3, 1, 2, 3]);
    expect(ffa.armies.map((a) => a.controller)).toEqual(['human', 'ai', 'ai', 'ai']);
    expect(ffa.armies[3].level).toBe('hard');
    // Unless they are named.
    expect(from('armies=4&foe2=russia&foe3=none').armies.map((a) => a.faction)).toEqual([
      1, 2, 2, 0,
    ]);
    expect(from('ai=off').armies[1]).toEqual({ faction: 2, controller: 'none' });
    expect(from('demo=1&ai=normal').armies[0]).toEqual({
      faction: 1,
      controller: 'ai',
      level: 'normal',
    });
    // The measuring scenarios: the river, the plain table, clear weather, no computer.
    const assault = from('scenario=assault&units=500&map=city&weather=rain&army=china');
    expect(assault).toMatchObject({ map: 'river', scenario: 'assault', units: 500, weather: 0 });
    expect(assault.armies).toEqual([
      { faction: 0, controller: 'human' },
      { faction: 0, controller: 'none' },
    ]);
    expect(from('map=nowhere&ai=godlike&armies=99&weather=<b>&seed=x')).toEqual(
      from('armies=4&seed=0'),
    );
  });

  it('writes an address that reads back as the same game', () => {
    for (const q of [
      '',
      'map=ridge&ai=hard&time=night&weather=snow&army=russia&foe=china&seed=12',
      'armies=3&ai=normal&army=none&foe=none',
      'armies=4&foe2=nato&foe3=nato',
      'ai=off&map=euro',
      'demo=1&ai=hard&map=river',
      'scenario=clash&units=800&time=night',
      'scenario=roam&units=1500&seed=3',
    ]) {
      const m = from(q);
      expect(validMatch(m)).toBe(true);
      expect(matchFromParams(matchToParams(m)), q).toEqual(m);
    }
    // What is not about the battle stays in the address.
    const kept = matchToParams(from('map=ridge'), new URLSearchParams('renderer=webgl&map=city'));
    expect(kept.get('renderer')).toBe('webgl');
    expect(kept.get('map')).toBe('ridge');
  });

  it('names the game for the end screen', () => {
    expect(matchLabel(from('map=euro&time=night&weather=rain&ai=hard'))).toBe(
      'European city · night · rain · hard AI',
    );
    expect(matchLabel(versus())).toBe('City · day · versus');
    const together = { ...defaultMatch(), players: [0, 1].map(() => ({ army: 0, duty: 0 })) };
    expect(matchLabel(together)).toBe('City · day · co-op, easy AI');
  });
});

describe('a Match from outside', () => {
  it('is taken only if it is a game this build can play', () => {
    expect(validMatch(defaultMatch())).toBe(true);
    expect(validMatch(versus())).toBe(true);
    const broken: unknown[] = [
      null,
      'city',
      { ...defaultMatch(), map: '<img>' },
      { ...defaultMatch(), seed: 1.5 },
      { ...defaultMatch(), units: 1e9 },
      { ...defaultMatch(), weather: 9 },
      { ...defaultMatch(), night: 'yes' },
      { ...defaultMatch(), armies: [] },
      { ...defaultMatch(), armies: [{ faction: 0, controller: 'ai' }, null] },
      { ...defaultMatch(), armies: new Array(5).fill({ faction: 0, controller: 'none' }) },
      { ...defaultMatch(), armies: [{ faction: 99, controller: 'human' }, { faction: 0 }] },
      { ...defaultMatch(), players: [] },
      { ...defaultMatch(), players: [{ army: 2, duty: 0 }] },
      { ...defaultMatch(), players: [{ army: 0, duty: 77 }] },
      { ...defaultMatch(), players: new Array(5).fill({ army: 0, duty: 0 }) },
    ];
    for (const m of broken) expect(validMatch(m), JSON.stringify(m)).toBe(false);
  });
});
