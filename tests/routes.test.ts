import { describe, expect, it } from 'vitest';
import { CMD_ATTACK_MOVE, CMD_MOVE, CMD_SPAWN, CMD_STOP, type Command } from '../src/sim/commands';
import { fx } from '../src/sim/fixed';
import { flatMap } from '../src/sim/map';
import { step } from '../src/sim/sim';
import { KIND_INFANTRY, KIND_TANK } from '../src/sim/units';
import {
  FLAG_AMOVE,
  FLAG_MOVING,
  ROUTE_MAX,
  createWorld,
  hashWorld,
  type World,
} from '../src/sim/world';

const spawnAt = (team: number, kind: number, count: number, x: number, y: number): Command => ({
  type: CMD_SPAWN,
  count,
  team,
  kind,
  x: fx(x),
  y: fx(y),
  radius: fx(3),
  wander: false,
});

function squad(count = 6, kind = KIND_TANK): { w: World; ids: number[] } {
  const w = createWorld(5, flatMap());
  step(w, [spawnAt(0, kind, count, 200, 200)]);
  const ids: number[] = [];
  for (let i = 0; i < w.count; i++) ids.push(i);
  return { w, ids };
}

const centre = (w: World, ids: number[]): [number, number] => {
  let x = 0;
  let y = 0;
  for (const i of ids) {
    x += w.posX[i];
    y += w.posY[i];
  }
  return [x / ids.length, y / ids.length];
};
const near = (w: World, ids: number[], x: number, y: number, r = 14) => {
  const [cx, cy] = centre(w, ids);
  return Math.hypot(cx - fx(x), cy - fx(y)) < fx(r);
};
const way = (ids: number[], x: number, y: number, type = CMD_MOVE): Command =>
  ({ type, units: ids, x: fx(x), y: fx(y), queue: true }) as Command;

describe('way points (decision 130)', () => {
  it('units go through the queued places in the order they were given', () => {
    const { w, ids } = squad();
    step(w, [{ type: CMD_MOVE, units: ids, x: fx(260), y: fx(200) }]);
    step(w, [way(ids, 260, 260)]);
    step(w, [way(ids, 200, 260)]);
    expect(w.routes.length).toBe(1);
    expect(w.routes[0].pts.length).toBe(6);
    const passed: number[] = [];
    const corners = [
      [260, 200],
      [260, 260],
      [200, 260],
    ];
    for (let t = 0; t < 3000 && passed.length < 3; t++) {
      step(w, []);
      const next = corners[passed.length];
      if (near(w, ids, next[0], next[1])) passed.push(w.tick);
    }
    expect(passed.length).toBe(3);
    // It ends on the last place, standing, and the route is gone.
    for (let t = 0; t < 200; t++) step(w, []);
    expect(near(w, ids, 200, 260)).toBe(true);
    expect(ids.every((i) => (w.flags[i] & FLAG_MOVING) === 0)).toBe(true);
    expect(w.routes.length).toBe(0);
    expect(ids.every((i) => w.routeOf[i] === 0)).toBe(true);
  });

  it('a way point given to troops that stand still is just a move', () => {
    const { w, ids } = squad();
    step(w, [way(ids, 240, 200)]);
    expect(w.routes.length).toBe(0);
    expect(ids.every((i) => (w.flags[i] & FLAG_MOVING) !== 0)).toBe(true);
  });

  it('any other order drops the rest of the route', () => {
    const { w, ids } = squad();
    step(w, [{ type: CMD_MOVE, units: ids, x: fx(260), y: fx(200) }]);
    step(w, [way(ids, 260, 260)]);
    step(w, [{ type: CMD_MOVE, units: ids, x: fx(180), y: fx(180) }]);
    for (let t = 0; t < 1200; t++) step(w, []);
    expect(w.routes.length).toBe(0);
    expect(near(w, ids, 180, 180)).toBe(true);
    // Stop does the same.
    step(w, [{ type: CMD_MOVE, units: ids, x: fx(260), y: fx(200) }]);
    step(w, [way(ids, 260, 260)]);
    step(w, [{ type: CMD_STOP, units: ids }]);
    for (let t = 0; t < 600; t++) step(w, []);
    expect(w.routes.length).toBe(0);
    expect(near(w, ids, 260, 260, 30)).toBe(false);
  });

  it('part of a body given its own way point leaves the route of the rest', () => {
    const { w, ids } = squad(8);
    const a = ids.slice(0, 4);
    const b = ids.slice(4);
    step(w, [{ type: CMD_MOVE, units: ids, x: fx(260), y: fx(200) }]);
    step(w, [way(ids, 260, 260)]);
    step(w, [way(a, 300, 200)]);
    expect(w.routes.length).toBe(2);
    for (let t = 0; t < 2500; t++) step(w, []);
    expect(near(w, a, 300, 200)).toBe(true);
    expect(near(w, b, 260, 260)).toBe(true);
    expect(w.routes.length).toBe(0);
  });

  it('a queued attack-move is an attack-move when its turn comes', () => {
    const { w, ids } = squad(4, KIND_INFANTRY);
    step(w, [{ type: CMD_MOVE, units: ids, x: fx(220), y: fx(200) }]);
    step(w, [way(ids, 300, 200, CMD_ATTACK_MOVE)]);
    expect(ids.every((i) => (w.flags[i] & FLAG_AMOVE) === 0)).toBe(true);
    let seen = false;
    for (let t = 0; t < 1500 && !seen; t++) {
      step(w, []);
      seen = ids.every((i) => (w.flags[i] & FLAG_AMOVE) !== 0);
    }
    expect(seen).toBe(true);
  });

  it('holds no more than ROUTE_MAX places, the dead drop out, and two worlds agree', () => {
    const run = () => {
      const { w, ids } = squad();
      step(w, [{ type: CMD_MOVE, units: ids, x: fx(260), y: fx(200) }]);
      for (let k = 0; k < ROUTE_MAX + 4; k++) step(w, [way(ids, 260 + 2 * k, 260)]);
      expect(w.routes[0].pts.length).toBe(3 * ROUTE_MAX);
      for (let t = 0; t < 400; t++) step(w, []);
      return hashWorld(w);
    };
    expect(run()).toBe(run());
  });
});
