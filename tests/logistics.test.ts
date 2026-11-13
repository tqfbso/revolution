import { describe, expect, it } from 'vitest';
import { CMD_FOUND, CMD_MOVE, CMD_SPAWN, type Command } from '../src/sim/commands';
import { B_DEPOT, B_HQ } from '../src/sim/economy';
import { fx } from '../src/sim/fixed';
import {
  RATION_MAX,
  SUPPLY_BASE,
  SUPPLY_LINK,
  SUPPLY_TRUCK,
  hungryPoints,
  supplied,
  upkeepPerMinute,
} from '../src/sim/logistics';
import { flatMap } from '../src/sim/map';
import { step } from '../src/sim/sim';
import { KINDS, KIND_INFANTRY, KIND_TANK, KIND_TRUCK } from '../src/sim/units';
import { EV_SHOT, createWorld, hashWorld, type World } from '../src/sim/world';

const spawn = (team: number, kind: number, count: number, x: number, y: number): Command => ({
  type: CMD_SPAWN,
  count,
  team,
  kind,
  x: fx(x),
  y: fx(y),
  radius: fx(count > 1 ? 4 : 0) + 1,
  wander: false,
});
/** Red headquarters with its middle at about (246, 246). */
const hq: Command = { type: CMD_FOUND, team: 0, building: B_HQ, x: 60, y: 60 };
const run = (w: World, ticks: number, cmds: Command[] = []) => {
  step(w, cmds);
  for (let t = 1; t < ticks; t++) step(w, []);
};
const ids = (w: World, kind: number, team = 0) => {
  const out: number[] = [];
  for (let i = 0; i < w.count; i++) if (w.kind[i] === kind && w.team[i] === team) out.push(i);
  return out;
};

describe('supply', () => {
  it('a depot covers a circle; beyond it rations run down over two minutes', () => {
    const w = createWorld(3, flatMap());
    run(w, 40, [hq, spawn(0, KIND_INFANTRY, 1, 300, 246), spawn(0, KIND_INFANTRY, 1, 700, 700)]);
    expect(supplied(w, 0, fx(246 + 100), fx(246))).toBe(true);
    expect(supplied(w, 0, fx(246) + SUPPLY_BASE + fx(40), fx(246))).toBe(false);
    const [near, far] = ids(w, KIND_INFANTRY);
    run(w, 60 * 20);
    expect(w.ration[near]).toBe(RATION_MAX);
    expect(w.ration[far]).toBeGreaterThan(RATION_MAX - 70);
    expect(w.ration[far]).toBeLessThan(RATION_MAX - 50);
    expect(hungryPoints(w, 0)).toBe(0);
    run(w, 70 * 20);
    expect(w.ration[far]).toBe(0);
    expect(hungryPoints(w, 0)).toBe(1);
    // Back under the depot they fill up again in half a minute.
    run(w, 1, [{ type: CMD_MOVE, units: [far], x: fx(300), y: fx(300) }]);
    for (let t = 0; t < 6000 && w.ration[far] < RATION_MAX; t++) step(w, []);
    expect(w.ration[far]).toBe(RATION_MAX);
  });

  it('a truck is the last link: it feeds troops only within reach of a depot', () => {
    const w = createWorld(3, flatMap());
    const linked = 246 + (SUPPLY_LINK >> 10) - 20;
    run(w, 40, [
      hq,
      spawn(0, KIND_TRUCK, 1, linked, 246),
      spawn(0, KIND_TRUCK, 1, 800, 800),
      spawn(0, KIND_INFANTRY, 1, linked + 20, 246),
      spawn(0, KIND_INFANTRY, 1, 810, 800),
    ]);
    expect(supplied(w, 0, fx(linked + 20), fx(246))).toBe(true);
    expect(supplied(w, 0, fx(linked) + SUPPLY_TRUCK + fx(40), fx(246))).toBe(false);
    expect(supplied(w, 0, fx(810), fx(800))).toBe(false);
    // The depot falls: the truck beyond it carries nothing.
    for (let s = 0; s < w.map.structCount; s++) if (w.sTeam[s] === 0) w.sHp[s] = 0;
    step(w, [{ type: CMD_FOUND, team: 0, building: B_DEPOT, x: 230, y: 230 }]);
    run(w, 40);
    expect(supplied(w, 0, fx(linked + 20), fx(246))).toBe(false);
    expect(supplied(w, 0, fx(930), fx(930))).toBe(true);
  });

  it('a held town is a source of supply', () => {
    const map = flatMap();
    const t = map.townCount++;
    map.townX[t] = fx(600);
    map.townY[t] = fx(600);
    map.townR[t] = fx(30);
    const w = createWorld(3, map);
    run(w, 40, [hq]);
    expect(supplied(w, 0, fx(600), fx(600))).toBe(false);
    w.townOwner[t] = 0;
    run(w, 40);
    expect(supplied(w, 0, fx(600), fx(600))).toBe(true);
    expect(supplied(w, 0, fx(690), fx(600))).toBe(true);
    expect(supplied(w, 0, fx(760), fx(600))).toBe(false);
  });

  it('out of rations a unit fires at half its rate and a vehicle crawls', () => {
    const shots = (fed: boolean) => {
      const w = createWorld(3, flatMap());
      // Blue has no depot at all, so it is not on the supply system: a steady target.
      run(w, 2, [hq, spawn(0, KIND_INFANTRY, 1, 700, 700), spawn(1, KIND_TANK, 1, 708, 700)]);
      const [me] = ids(w, KIND_INFANTRY);
      const [it] = ids(w, KIND_TANK, 1);
      let n = 0;
      for (let t = 0; t < 600; t++) {
        w.ration[me] = fed ? RATION_MAX : 0;
        w.hp[it] = KINDS[KIND_TANK].hp;
        w.hp[me] = KINDS[KIND_INFANTRY].hp;
        step(w, []);
        for (let e = 0; e < w.events.length; e += 3) {
          if (w.events[e] === EV_SHOT && w.events[e + 1] === me) n++;
        }
        w.events.length = 0;
      }
      return n;
    };
    const full = shots(true);
    const half = shots(false);
    expect(full).toBeGreaterThan(15);
    expect(half * 2).toBeLessThanOrEqual(full + 2);
    expect(half * 2).toBeGreaterThanOrEqual(full - 2);

    const drive = (fed: boolean) => {
      const w = createWorld(3, flatMap());
      run(w, 2, [hq, spawn(0, KIND_TANK, 1, 600, 700)]);
      const [tank] = ids(w, KIND_TANK);
      step(w, [{ type: CMD_MOVE, units: [tank], x: fx(900), y: fx(700) }]);
      for (let t = 0; t < 200; t++) {
        w.ration[tank] = fed ? RATION_MAX : 0;
        step(w, []);
      }
      return w.posX[tank] - fx(600);
    };
    expect(drive(false) * 10).toBeLessThan(drive(true) * 7);
    expect(drive(false)).toBeGreaterThan(0);
  });

  it('troops in supply and out of the fight mend; hungry ones do not', () => {
    const w = createWorld(3, flatMap());
    run(w, 40, [hq, spawn(0, KIND_INFANTRY, 1, 300, 246), spawn(0, KIND_INFANTRY, 1, 700, 700)]);
    const [near, far] = ids(w, KIND_INFANTRY);
    w.hp[near] = 40;
    w.hp[far] = 40;
    run(w, 60 * 20);
    expect(w.hp[near]).toBeGreaterThan(70);
    expect(w.hp[far]).toBe(40);
    run(w, 200 * 20);
    expect(w.hp[near]).toBe(KINDS[KIND_INFANTRY].hp);
  });

  it('an army without a depot or a town is off the system: no hunger, no mending', () => {
    const w = createWorld(3, flatMap());
    run(w, 2, [spawn(0, KIND_INFANTRY, 5, 500, 500)]);
    for (const i of ids(w, KIND_INFANTRY)) w.hp[i] = 50;
    run(w, 200 * 20);
    for (const i of ids(w, KIND_INFANTRY)) {
      expect(w.ration[i]).toBe(RATION_MAX);
      expect(w.hp[i]).toBe(50);
    }
  });
});

describe('upkeep', () => {
  it('the first points are free, then every point costs supplies each minute', () => {
    expect(upkeepPerMinute(60)).toBe(0);
    expect(upkeepPerMinute(160)).toBe(400);
    const cost = (squads: number) => {
      const w = createWorld(3, flatMap());
      run(w, 2, [hq, { type: CMD_FOUND, team: 0, building: B_DEPOT, x: 50, y: 60 }]);
      if (squads > 0) step(w, [spawn(0, KIND_INFANTRY, squads, 300, 300)]);
      w.supplies[0] = 5000;
      run(w, 60 * 20 + 25);
      return 5000 - w.supplies[0];
    };
    expect(cost(40)).toBe(0);
    const big = cost(160);
    expect(big).toBeGreaterThanOrEqual(380);
    expect(big).toBeLessThanOrEqual(420);
  });

  it('an army that cannot pay is not punished further, and the world stays in step', () => {
    const play = () => {
      const w = createWorld(3, flatMap());
      run(w, 2, [hq, spawn(0, KIND_INFANTRY, 200, 300, 300)]);
      w.supplies[0] = 5;
      run(w, 400);
      return w;
    };
    const a = play();
    expect(a.supplies[0]).toBe(0);
    expect(hashWorld(a)).toBe(hashWorld(play()));
  });
});
