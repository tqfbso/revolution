import { describe, expect, it } from 'vitest';
import { planeEntry } from '../src/sim/air';
import {
  CMD_FOUND,
  CMD_LOAD,
  CMD_MOVE,
  CMD_PARADROP,
  CMD_SPAWN,
  CMD_TRAIN,
  type Command,
} from '../src/sim/commands';
import { B_BARRACKS, B_HELIPAD, B_HQ } from '../src/sim/economy';
import { fx } from '../src/sim/fixed';
import { flatMap } from '../src/sim/map';
import { step } from '../src/sim/sim';
import {
  HELIS_PER_PAD,
  KINDS,
  KIND_AD,
  KIND_EW,
  KIND_HELI,
  KIND_INFANTRY,
  KIND_LIFT,
  KIND_PARA,
  KIND_PLANE,
  KIND_TANK,
  PARA_PLANE_LOAD,
  PARA_SCATTER,
} from '../src/sim/units';
import {
  EV_PARADROP,
  EV_PLANE,
  STATE_ALIVE,
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
const alive = (w: World, team: number, kind: number) => {
  const out: number[] = [];
  for (let i = 0; i < w.count; i++) {
    if (w.state[i] === STATE_ALIVE && w.team[i] === team && w.kind[i] === kind) out.push(i);
  }
  return out;
};
/** An empty map with a rich tier-2 base for team 0 in the west. */
function base(seed = 3) {
  const map = flatMap();
  map.startX[0] = 20;
  map.startY[0] = 128;
  map.startX[1] = 236;
  map.startY[1] = 128;
  const w = createWorld(seed, map);
  w.tier[0] = 2;
  w.supplies[0] = w.fuel[0] = w.credits[0] = 20000;
  step(w, [
    { type: CMD_FOUND, team: 0, building: B_HQ, x: 20, y: 128 },
    { type: CMD_FOUND, team: 0, building: B_BARRACKS, x: 30, y: 120 },
    { type: CMD_FOUND, team: 0, building: B_HELIPAD, x: 30, y: 136 },
  ]);
  const find = (type: number) => {
    for (let s = 0; s < w.map.structCount; s++)
      if (w.sType[s] === type && w.sTeam[s] === 0) return s;
    return -1;
  };
  return { w, barracks: find(B_BARRACKS), pad: find(B_HELIPAD) };
}
function run(w: World, ticks: number, each?: () => void): void {
  for (let t = 0; t < ticks; t++) {
    step(w, []);
    each?.();
    w.events.length = 0;
  }
}

describe('helicopters (decision 105)', () => {
  it('a helipad holds three: the fourth waits for landing space', () => {
    const { w, pad } = base();
    const train: Command = { type: CMD_TRAIN, structure: pad, kind: KIND_HELI };
    step(w, [train, train, train, train]);
    run(w, 6000);
    expect(alive(w, 0, KIND_HELI).length).toBe(HELIS_PER_PAD);
    expect(w.sQueueLen[pad]).toBe(1);
    // One is lost: the one waiting is built.
    w.hp[alive(w, 0, KIND_HELI)[0]] = 1;
    step(w, [spawnAt(1, KIND_AD, 2, 150, 560)]);
    const victim = alive(w, 0, KIND_HELI)[0];
    step(w, [{ type: CMD_MOVE, units: [victim], x: fx(150), y: fx(545) }]);
    run(w, 3000);
    expect(w.sQueueLen[pad]).toBe(0);
    expect(alive(w, 0, KIND_HELI).length).toBe(HELIS_PER_PAD);
  });

  it('a jammer does nothing to a helicopter, air defence shoots it down', () => {
    const w = createWorld(5, flatMap());
    step(w, [spawnAt(0, KIND_HELI, 1, 400, 400), spawnAt(1, KIND_EW, 1, 410, 400)]);
    run(w, 400);
    const heli = alive(w, 0, KIND_HELI)[0];
    expect(heli).toBeDefined();
    expect(w.jammed[heli]).toBe(0);
    step(w, [spawnAt(1, KIND_AD, 2, 425, 400)]);
    run(w, 600);
    expect(alive(w, 0, KIND_HELI).length).toBe(0);
  });

  it('an attack helicopter beats a tank and loses to nothing a tank carries', () => {
    const w = createWorld(6, flatMap());
    step(w, [spawnAt(0, KIND_HELI, 1, 400, 400), spawnAt(1, KIND_TANK, 1, 420, 400)]);
    run(w, 900);
    expect(alive(w, 1, KIND_TANK).length).toBe(0);
    const heli = alive(w, 0, KIND_HELI)[0];
    expect(w.hp[heli]).toBe(KINDS[KIND_HELI].hp);
  });

  it('a transport helicopter lifts four squads, and few walk away when it is shot down', () => {
    const w = createWorld(8, flatMap());
    step(w, [spawnAt(0, KIND_LIFT, 1, 300, 300), spawnAt(0, KIND_INFANTRY, 4, 304, 300)]);
    const lift = alive(w, 0, KIND_LIFT)[0];
    const squads = alive(w, 0, KIND_INFANTRY);
    step(w, [{ type: CMD_LOAD, units: squads, carriers: [lift] }]);
    run(w, 400);
    expect(w.load[lift]).toBe(4);
    step(w, [
      { type: CMD_MOVE, units: [lift], x: fx(600), y: fx(300) },
      spawnAt(1, KIND_AD, 3, 450, 300),
    ]);
    run(w, 800);
    expect(alive(w, 0, KIND_LIFT).length).toBe(0);
    const left = alive(w, 0, KIND_INFANTRY);
    expect(left.length).toBeGreaterThan(0);
    for (const i of left) expect(w.hp[i]).toBeLessThanOrEqual(KINDS[KIND_INFANTRY].hp >> 2);
  });
});

describe('paratroops (decision 105)', () => {
  it('are trained into a reserve, not onto the map', () => {
    const { w, barracks } = base();
    const train: Command = { type: CMD_TRAIN, structure: barracks, kind: KIND_PARA };
    step(w, [train, train, train]);
    run(w, 1200);
    expect(w.paraReserve[0]).toBe(3);
    expect(alive(w, 0, KIND_PARA).length).toBe(0);
    // They count against the army limit while they wait.
    expect(w.pop[0]).toBeGreaterThanOrEqual(6);
  });

  it('a plane comes in over the home edge, drops them round the point and leaves', () => {
    const { w } = base();
    w.paraReserve[0] = PARA_PLANE_LOAD + 3;
    expect(planeEntry(w, 0)[0]).toBe(0);
    let seenPlane = false;
    let dropped = -1;
    step(w, [{ type: CMD_PARADROP, team: 0, x: fx(700), y: fx(400) }]);
    for (let e = 0; e < w.events.length; e += 3) if (w.events[e] === EV_PLANE) seenPlane = true;
    expect(seenPlane).toBe(true);
    expect(w.paraReserve[0]).toBe(3);
    expect(alive(w, 0, KIND_PLANE).length).toBe(1);
    run(w, 1500, () => {
      for (let e = 0; e < w.events.length; e += 3) {
        if (w.events[e] === EV_PARADROP) dropped = w.events[e + 2] >> 8;
      }
    });
    expect(dropped).toBe(PARA_PLANE_LOAD);
    const paras = alive(w, 0, KIND_PARA);
    expect(paras.length).toBe(PARA_PLANE_LOAD);
    for (const i of paras) {
      expect(w.carrier[i]).toBe(-1);
      expect(Math.abs(w.posX[i] - fx(700))).toBeLessThanOrEqual(PARA_SCATTER + fx(8));
      expect(Math.abs(w.posY[i] - fx(400))).toBeLessThanOrEqual(PARA_SCATTER + fx(8));
    }
    // The plane has gone home and its slot is free again.
    expect(alive(w, 0, KIND_PLANE).length).toBe(0);
  });

  it('air defence on the way shoots the plane down with everyone aboard', () => {
    const { w } = base();
    w.paraReserve[0] = PARA_PLANE_LOAD;
    step(w, [spawnAt(1, KIND_AD, 4, 400, 450)]);
    step(w, [{ type: CMD_PARADROP, team: 0, x: fx(800), y: fx(380) }]);
    let dropped = false;
    run(w, 1500, () => {
      for (let e = 0; e < w.events.length; e += 3) if (w.events[e] === EV_PARADROP) dropped = true;
    });
    expect(dropped).toBe(false);
    expect(alive(w, 0, KIND_PARA).length).toBe(0);
    expect(alive(w, 0, KIND_PLANE).length).toBe(0);
    expect(w.paraReserve[0]).toBe(0);
  });

  it('nobody can give the plane orders, and a drop with no reserve does nothing', () => {
    const { w } = base();
    step(w, [{ type: CMD_PARADROP, team: 0, x: fx(700), y: fx(400) }]);
    expect(alive(w, 0, KIND_PLANE).length).toBe(0);
    w.paraReserve[0] = 2;
    step(w, [{ type: CMD_PARADROP, team: 0, x: fx(700), y: fx(400) }]);
    const plane = alive(w, 0, KIND_PLANE)[0];
    run(w, 100);
    const before = w.targetX[plane];
    step(w, [{ type: CMD_MOVE, units: [plane], x: fx(100), y: fx(900) }]);
    expect(w.targetX[plane]).toBe(before);
  });

  it('is deterministic', () => {
    const play = () => {
      const { w } = base(11);
      w.paraReserve[0] = 6;
      step(w, [spawnAt(1, KIND_INFANTRY, 6, 690, 410), spawnAt(1, KIND_AD, 1, 900, 300)]);
      step(w, [{ type: CMD_PARADROP, team: 0, x: fx(700), y: fx(400) }]);
      run(w, 1400);
      return hashWorld(w);
    };
    expect(play()).toBe(play());
  });
});
