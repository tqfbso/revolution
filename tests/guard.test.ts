import { describe, expect, it } from 'vitest';
import {
  CMD_MOVE,
  CMD_ORDER,
  CMD_SPAWN,
  CMD_STOP,
  CMD_TRAIN,
  type Command,
} from '../src/sim/commands';
import { B_HQ } from '../src/sim/economy';
import { fx } from '../src/sim/fixed';
import { generateMap } from '../src/sim/map';
import { skirmishCommands } from '../src/sim/scenarios';
import { step } from '../src/sim/sim';
import { authorize, validCommand } from '../src/sim/guard';
import { defaultMatch, type Match } from '../src/sim/match';
import { STATE_ALIVE, createWorld, hashWorld } from '../src/sim/world';
import { PIECE_TICKS, expand } from '../src/client/replay';
import { esc, parseMsg } from '../src/client/wire';

// The security review (2026-11-15): a bad order must not stop the clock, an order from
// another player's browser must be his to give, and nothing a peer sends reaches the page
// as HTML.

function skirmish(seed = 3) {
  const w = createWorld(seed, generateMap(seed, 'city'));
  step(w, skirmishCommands(w.map));
  return w;
}

const unitsOf = (w: ReturnType<typeof skirmish>, team: number): number[] => {
  const out: number[] = [];
  for (let i = 0; i < w.count; i++)
    if (w.state[i] === STATE_ALIVE && w.team[i] === team) out.push(i);
  return out;
};

describe('a malformed order', () => {
  it('is skipped, and the clock runs on', () => {
    const w = skirmish();
    const bad = [
      null,
      7,
      'x',
      [],
      { type: CMD_MOVE, units: 5, x: 0, y: 0 },
      { type: CMD_STOP, units: [1, 'a'] },
      { type: 999 },
      { type: CMD_MOVE, units: [1], x: 'far', y: 0 },
    ] as unknown as Command[];
    const t = w.tick;
    for (let k = 0; k < 5; k++) step(w, bad);
    expect(w.tick).toBe(t + 5);
  });

  it('changes nothing: the world is the same as with no orders at all', () => {
    const a = skirmish();
    const b = skirmish();
    for (let k = 0; k < 40; k++) {
      step(a, []);
      step(b, [null, { type: CMD_STOP, units: 3 }] as unknown as Command[]);
    }
    expect(hashWorld(a)).toBe(hashWorld(b));
  });

  it('every legal shape passes', () => {
    expect(validCommand({ type: CMD_MOVE, units: [1, 2], x: 5, y: 6, queue: true, by: 1 })).toBe(
      true,
    );
    expect(
      validCommand({ type: CMD_SPAWN, count: 3, team: 1, x: 0, y: 0, radius: 9, wander: false }),
    ).toBe(true);
  });
});

describe('an order from another player', () => {
  it('may not be a setup order', () => {
    const w = skirmish();
    const spawn = {
      type: CMD_SPAWN,
      count: 400,
      team: 0,
      x: fx(500),
      y: fx(500),
      radius: fx(40),
      wander: false,
    };
    expect(authorize(w, spawn, 0, 1)).toBeNull();
  });

  it('may not order another army about', () => {
    const w = skirmish();
    expect(authorize(w, { type: CMD_ORDER, team: 1, kind: 1, count: 5 }, 0, 1)).toBeNull();
    expect(authorize(w, { type: CMD_ORDER, team: 0, kind: 1, count: 5 }, 0, 1)).not.toBeNull();
    const blue = unitsOf(w, 1);
    expect(authorize(w, { type: CMD_STOP, units: blue }, 0, 1)).toBeNull();
  });

  it('keeps only his own units, and is signed with his seat and his army', () => {
    const w = skirmish();
    const red = unitsOf(w, 0).slice(0, 3);
    const blue = unitsOf(w, 1).slice(0, 3);
    // What he says of himself (seat 3, army 1) counts for nothing.
    const said = { type: CMD_STOP, units: [...red, ...blue, -1, 1e9], by: 3, army: 1 };
    expect(authorize(w, said, 0, 2)).toEqual({ type: CMD_STOP, units: red, by: 2, army: 0 });
  });

  it('may not train in an enemy building', () => {
    const w = skirmish();
    let mine = -1;
    let theirs = -1;
    for (let s = 0; s < w.map.structCount; s++) {
      if (w.sType[s] !== B_HQ || w.sHp[s] <= 0) continue;
      if (w.sTeam[s] === 0) mine = s;
      if (w.sTeam[s] === 1) theirs = s;
    }
    expect(mine).toBeGreaterThanOrEqual(0);
    expect(theirs).toBeGreaterThanOrEqual(0);
    expect(authorize(w, { type: CMD_TRAIN, structure: theirs, kind: 10 }, 0, 1)).toBeNull();
    expect(authorize(w, { type: CMD_TRAIN, structure: mine, kind: 10 }, 0, 1)).not.toBeNull();
  });

  it('may not carry numbers that are not numbers', () => {
    const w = skirmish();
    const red = unitsOf(w, 0).slice(0, 2);
    expect(authorize(w, { type: CMD_MOVE, units: red, x: Infinity, y: 0 }, 0, 1)).toBeNull();
    expect(authorize(w, null, 0, 1)).toBeNull();
  });
});

/** A game for two against the computer, as a host sends it. */
function twoPlayers(): Match {
  return {
    ...defaultMatch(),
    weather: 1,
    players: [
      { army: 0, duty: 0 },
      { army: 0, duty: 3 },
    ],
  };
}

describe('the wire', () => {
  it('drops what this game never sends', () => {
    expect(parseMsg(null)).toBeNull();
    expect(parseMsg({ t: 'nope' })).toBeNull();
    expect(parseMsg({ t: 'bad', build: '<img src=x onerror=alert(1)>' })).toBeNull();
    expect(parseMsg({ t: 'back', seat: '<b>1</b>', duty: 0 })).toBeNull();
    expect(parseMsg({ t: 'gone', seat: 9 })).toBeNull();
    expect(parseMsg({ t: 'r', from: 0, to: 1e12, f: [] })).toBeNull();
    expect(parseMsg({ t: 'f', f: [[1, [null]]] })).toBeNull();
    expect(
      parseMsg({
        t: 'cfg',
        match: { ...twoPlayers(), map: '<img>' },
        you: 1,
      }),
    ).toBeNull();
    // A seat nobody sits in, and a player on an army that is not there.
    expect(parseMsg({ t: 'cfg', match: twoPlayers(), you: 2 })).toBeNull();
    const stray = twoPlayers();
    stray.players[1].army = 3;
    expect(parseMsg({ t: 'cfg', match: stray, you: 1 })).toBeNull();
  });

  it('lets through what it does send', () => {
    expect(parseMsg({ t: 'hello', build: 'a1b2c3d', duty: 2 })).not.toBeNull();
    expect(
      parseMsg({
        t: 'f',
        f: [
          [5, [{ type: CMD_STOP, units: [1] }]],
          [6, []],
        ],
      }),
    ).not.toBeNull();
    expect(parseMsg({ t: 'cfg', match: twoPlayers(), you: 1, resume: true })).not.toBeNull();
  });

  it('rebuilds positions, so nothing else rides along', () => {
    expect(parseMsg({ t: 'cam', x: 1, z: 2, from: 1, extra: '<script>' })).toEqual({
      t: 'cam',
      x: 1,
      z: 2,
      from: 1,
    });
  });

  it('escapes text for HTML', () => {
    expect(esc(`<img src="x" onerror='y'>&`)).toBe(
      '&lt;img src=&quot;x&quot; onerror=&#39;y&#39;&gt;&amp;',
    );
  });

  it('never expands a piece past its size', () => {
    expect(expand({ from: 0, to: 1e12, f: [] })).toHaveLength(PIECE_TICKS);
  });
});
