import { describe, expect, it } from 'vitest';
import { CMD_DEST, CMD_FOUND, CMD_KEEP, CMD_ORDER } from '../src/sim/commands';
import { B_BARRACKS, B_DEPOT, B_HQ, B_WORKS, UNIT_PRICE } from '../src/sim/economy';
import { fx } from '../src/sim/fixed';
import { flatMap } from '../src/sim/map';
import { step } from '../src/sim/sim';
import { KIND_INFANTRY, KIND_TANK } from '../src/sim/units';
import {
  DEST_TOWN,
  KIND_SLOTS,
  STATE_ALIVE,
  createWorld,
  hashWorld,
  type World,
} from '../src/sim/world';

/** A flat world with a red headquarters, depots for room and `barracks` barracks. */
function base(barracks: number, pool = false): World {
  const w = createWorld(5, flatMap());
  const found = (building: number, x: number, y: number) =>
    ({ type: CMD_FOUND, team: 0, building, x, y }) as const;
  const cmds = [found(B_HQ, 60, 60), found(B_DEPOT, 50, 60), found(B_DEPOT, 50, 66)];
  for (let b = 0; b < barracks; b++) cmds.push(found(B_BARRACKS, 70 + 8 * b, 60));
  if (pool) cmds.push(found(B_WORKS, 60, 72));
  step(w, cmds);
  return w;
}

const count = (w: World, kind: number) => {
  let n = 0;
  for (let i = 0; i < w.count; i++) if (w.state[i] === STATE_ALIVE && w.kind[i] === kind) n++;
  return n;
};
const run = (w: World, ticks: number) => {
  for (let t = 0; t < ticks; t++) step(w, []);
};
const queued = (w: World) => {
  const out: number[] = [];
  for (let s = 0; s < w.map.structCount; s++)
    if (w.sType[s] === B_BARRACKS) out.push(w.sQueueLen[s]);
  return out;
};

describe('war production centre', () => {
  it('spreads a bulk order over every barracks and pays as each unit starts', () => {
    const w = base(3);
    w.supplies[0] = 10000;
    step(w, [{ type: CMD_ORDER, team: 0, kind: KIND_INFANTRY, count: 12 }]);
    run(w, 30);
    // All three barracks are at work, none holds more than a short queue.
    expect(queued(w).every((n) => n >= 1 && n <= 2)).toBe(true);
    const paid = 10000 - w.supplies[0];
    expect(paid).toBeGreaterThan(0);
    expect(paid % UNIT_PRICE[KIND_INFANTRY].supplies).toBe(0);
    expect(paid).toBeLessThan(12 * UNIT_PRICE[KIND_INFANTRY].supplies);
    run(w, 12 * UNIT_PRICE[KIND_INFANTRY].ticks);
    expect(count(w, KIND_INFANTRY)).toBe(12);
    expect(w.orders[KIND_INFANTRY]).toBe(0);
    expect(10000 - w.supplies[0]).toBe(12 * UNIT_PRICE[KIND_INFANTRY].supplies);
  });

  it('three barracks fill an order about three times as fast as one', () => {
    const time = (barracks: number) => {
      const w = base(barracks);
      w.supplies[0] = 10000;
      step(w, [{ type: CMD_ORDER, team: 0, kind: KIND_INFANTRY, count: 12 }]);
      let t = 0;
      while (count(w, KIND_INFANTRY) < 12 && t < 5000) {
        step(w, []);
        t++;
      }
      return t;
    };
    expect(time(3) * 2.5).toBeLessThan(time(1));
  });

  it('an order waits for money without being lost, and can be taken back', () => {
    const w = base(1);
    w.supplies[0] = 0;
    step(w, [{ type: CMD_ORDER, team: 0, kind: KIND_INFANTRY, count: 5 }]);
    run(w, 200);
    expect(count(w, KIND_INFANTRY)).toBe(0);
    expect(w.orders[KIND_INFANTRY]).toBe(5);
    step(w, [{ type: CMD_ORDER, team: 0, kind: KIND_INFANTRY, count: -3 }]);
    w.supplies[0] = 1000;
    run(w, 400);
    expect(count(w, KIND_INFANTRY)).toBe(2);
    expect(w.supplies[0]).toBe(1000 - 2 * UNIT_PRICE[KIND_INFANTRY].supplies);
  });

  it('cheap squads on order do not starve a tank of its money', () => {
    const w = base(2, true);
    w.tier[0] = 2;
    w.supplies[0] = 0;
    w.fuel[0] = 1000;
    step(w, [
      { type: CMD_ORDER, team: 0, kind: KIND_INFANTRY, count: 200 },
      { type: CMD_ORDER, team: 0, kind: KIND_TANK, count: 1 },
    ]);
    // A trickle of income: enough for a squad every two seconds, a tank after a while.
    for (let t = 0; t < 2400 && count(w, KIND_TANK) === 0; t++) {
      if (t % 2 === 0) w.supplies[0] += 1;
      step(w, []);
    }
    expect(count(w, KIND_TANK)).toBe(1);
  });

  it('keep N replaces losses by itself and stops when ended', () => {
    const w = base(2);
    w.supplies[0] = 10000;
    step(w, [{ type: CMD_KEEP, team: 0, kind: KIND_INFANTRY, count: 6 }]);
    run(w, 600);
    expect(count(w, KIND_INFANTRY)).toBe(6);
    // Two fall.
    let killed = 0;
    for (let i = 0; i < w.count && killed < 2; i++) {
      if (w.state[i] === STATE_ALIVE && w.kind[i] === KIND_INFANTRY) {
        w.hp[i] = 0;
        w.state[i] = 0;
        killed++;
      }
    }
    run(w, 400);
    expect(count(w, KIND_INFANTRY)).toBe(6);
    step(w, [{ type: CMD_KEEP, team: 0, kind: KIND_INFANTRY, count: 0 }]);
    expect(w.keep[KIND_INFANTRY]).toBe(0);
    expect(w.orders[KIND_INFANTRY]).toBe(0);
  });

  it('new units go to the town chosen for their kind', () => {
    const w = base(1);
    const map = w.map;
    const t = map.townCount++;
    map.townX[t] = fx(600);
    map.townY[t] = map.townX[t];
    map.townR[t] = 1;
    w.supplies[0] = 1000;
    step(w, [
      { type: CMD_DEST, team: 0, kind: KIND_INFANTRY, dest: DEST_TOWN + t },
      { type: CMD_ORDER, team: 0, kind: KIND_INFANTRY, count: 1 },
    ]);
    expect(w.dest[KIND_INFANTRY]).toBe(DEST_TOWN + t);
    run(w, UNIT_PRICE[KIND_INFANTRY].ticks + 30);
    let id = -1;
    for (let i = 0; i < w.count; i++) if (w.kind[i] === KIND_INFANTRY) id = i;
    expect(id).toBeGreaterThanOrEqual(0);
    expect(w.targetX[id]).toBe(map.townX[t]);
    expect(w.targetY[id]).toBe(map.townY[t]);
  });

  it('bad orders are ignored and the same orders give the same world', () => {
    const play = () => {
      const w = base(2);
      w.supplies[0] = 3000;
      step(w, [
        { type: CMD_ORDER, team: 9, kind: KIND_INFANTRY, count: 5 },
        { type: CMD_ORDER, team: 0, kind: 99, count: 5 },
        { type: CMD_DEST, team: 0, kind: KIND_INFANTRY, dest: 250 },
        { type: CMD_ORDER, team: 0, kind: KIND_INFANTRY, count: 30 },
      ]);
      run(w, 500);
      return w;
    };
    const a = play();
    expect(a.dest[KIND_INFANTRY]).toBe(0);
    expect(a.orders.slice(KIND_SLOTS).every((n) => n === 0)).toBe(true);
    expect(hashWorld(a)).toBe(hashWorld(play()));
  });
});
