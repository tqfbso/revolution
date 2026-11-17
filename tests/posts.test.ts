import { describe, expect, it } from 'vitest';
import {
  CMD_ASSIGN,
  CMD_ATTACK_MOVE,
  CMD_FOUND,
  CMD_MISSION,
  CMD_SPAWN,
  type Command,
} from '../src/sim/commands';
import { fx } from '../src/sim/fixed';
import { CELL_SHIFT, MAP_CELLS, generateMap } from '../src/sim/map';
import { skirmishCommands } from '../src/sim/scenarios';
import { step } from '../src/sim/sim';
import { ST_DEFEND, createStaff, staffThink, type Staff } from '../src/sim/staff';
import { KIND_IFV, KIND_INFANTRY, KIND_TANK } from '../src/sim/units';
import {
  M_DEFEND,
  M_HOLD,
  STATE_ALIVE,
  TICK_RATE,
  createWorld,
  type World,
} from '../src/sim/world';

// Vehicles of a commander that holds or defends a place (Fabio, 2026-11-17: "armour
// usually gathers together in the middle of the grid taking too long to respond to small
// firefights and moving as a big group").

const spawn = (team: number, kind: number, count: number, x: number, y: number): Command => ({
  type: CMD_SPAWN,
  count,
  team,
  kind,
  x,
  y,
  radius: fx(8),
  wander: false,
});

/** The city, both headquarters, and a body of six tanks, four carriers and eight squads. */
function city(mission: number): {
  w: World;
  st: Staff;
  x: number;
  y: number;
  armour: number[];
} {
  const w = createWorld(1, generateMap(1, 'city'));
  step(
    w,
    skirmishCommands(w.map).filter((c) => c.type === CMD_FOUND),
  );
  const st = createStaff(0, 1);
  const t = w.map.townName.indexOf('City Centre');
  const x = w.map.townX[t];
  const y = w.map.townY[t];
  const ids = add(w, [
    spawn(0, KIND_TANK, 6, x - fx(20), y + fx(10)),
    spawn(0, KIND_IFV, 4, x - fx(20), y + fx(10)),
    spawn(0, KIND_INFANTRY, 8, x - fx(10), y),
  ]);
  step(w, [
    { type: CMD_ASSIGN, units: ids, slot: 0 },
    { type: CMD_MISSION, team: 0, slot: 0, mission, x, y },
  ]);
  return { w, st, x, y, armour: ids.filter((i) => w.kind[i] !== KIND_INFANTRY) };
}

function add(w: World, cmds: Command[]): number[] {
  const from = w.count;
  step(w, cmds);
  const ids: number[] = [];
  for (let i = from; i < w.count; i++) ids.push(i);
  return ids;
}

function play(w: World, st: Staff, seconds: number, each?: () => void): void {
  for (let t = 0; t < seconds * TICK_RATE; t++) {
    const out: Command[] = [];
    staffThink(st, w, out);
    step(w, out);
    each?.();
  }
}

const far = (w: World, i: number, x: number, y: number) =>
  Math.hypot(w.posX[i] - x, w.posY[i] - y) / fx(1);

/** How far a vehicle is from the post it was given. */
function offPost(w: World, st: Staff, i: number): number {
  const c = st.posts[0].spots[st.posts[0].spot.get(i)!];
  const half = 1 << (CELL_SHIFT - 1);
  return far(
    w,
    i,
    ((c % MAP_CELLS) << CELL_SHIFT) + half,
    (Math.trunc(c / MAP_CELLS) << CELL_SHIFT) + half,
  );
}

describe('a commander that holds a place posts its vehicles round it', () => {
  it('each at a post of its own: not in the square, all round, beside a wall', () => {
    const { w, st, x, y, armour } = city(M_HOLD);
    play(w, st, 45);
    const p = st.posts[0];
    expect(p.spots.length).toBe(armour.length);
    expect(new Set(p.spots).size).toBe(armour.length);
    expect(new Set(armour.map((i) => p.spot.get(i))).size).toBe(armour.length);
    // Everyone has arrived, and nobody stands in the middle.
    for (const i of armour) {
      expect(offPost(w, st, i)).toBeLessThan(12);
      expect(far(w, i, x, y)).toBeGreaterThan(20);
    }
    // No two of them side by side.
    for (const a of armour) {
      for (const b of armour) {
        if (a < b) expect(far(w, a, w.posX[b], w.posY[b])).toBeGreaterThan(8);
      }
    }
    // They look every way: someone in each quarter round the place.
    const quarters = new Set(armour.map((i) => (w.posX[i] > x ? 1 : 0) + (w.posY[i] > y ? 2 : 0)));
    expect(quarters.size).toBe(4);
    // Most posts are against a house, not out in a crossing.
    const cost = w.map.cost[0];
    const walled = p.spots.filter(
      (c) =>
        cost[c - 1] === 0 ||
        cost[c + 1] === 0 ||
        cost[c - MAP_CELLS] === 0 ||
        cost[c + MAP_CELLS] === 0,
    );
    expect(walled.length * 4).toBeGreaterThanOrEqual(p.spots.length * 3);
    // And they stay: a minute on, the same posts.
    const before = armour.map((i) => p.spot.get(i));
    play(w, st, 60);
    expect(armour.map((i) => p.spot.get(i))).toEqual(before);
    for (const i of armour) expect(offPost(w, st, i)).toBeLessThan(12);
  }, 60000);

  it('a patrol is met by the nearest few, who go back to their posts after', () => {
    const { w, st, x, y, armour } = city(M_DEFEND);
    play(w, st, 45);
    const foes = add(w, [
      spawn(1, KIND_IFV, 1, x + fx(100), y - fx(2)),
      spawn(1, KIND_INFANTRY, 2, x + fx(100), y - fx(2)),
    ]);
    step(w, [{ type: CMD_ATTACK_MOVE, units: foes, x: x + fx(68), y: y - fx(2) }]);
    const left = new Set<number>();
    play(w, st, 40, () => {
      for (const i of armour) if (offPost(w, st, i) > 14) left.add(i);
    });
    expect(foes.filter((i) => w.state[i] === STATE_ALIVE).length).toBe(0);
    // Some went, most stayed where they were.
    expect(left.size).toBeGreaterThanOrEqual(1);
    expect(left.size).toBeLessThanOrEqual(4);
    play(w, st, 40);
    expect(st.posts[0].status).toBe(ST_DEFEND);
    for (const i of armour) {
      if (w.state[i] === STATE_ALIVE) expect(offPost(w, st, i)).toBeLessThan(12);
    }
  }, 60000);

  it('an attack is met by the whole body', () => {
    const { w, st, x, y, armour } = city(M_DEFEND);
    play(w, st, 45);
    const foes = add(w, [
      spawn(1, KIND_TANK, 5, x + fx(100), y - fx(2)),
      spawn(1, KIND_IFV, 3, x + fx(100), y - fx(2)),
    ]);
    step(w, [{ type: CMD_ATTACK_MOVE, units: foes, x: x + fx(66), y: y - fx(2) }]);
    const left = new Set<number>();
    play(w, st, 40, () => {
      for (const i of armour) if (offPost(w, st, i) > 14) left.add(i);
    });
    expect(left.size).toBeGreaterThan(armour.length / 2);
  }, 60000);
});
