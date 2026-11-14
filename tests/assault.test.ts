// A commander's attack as it stands: the whole body goes in together, each unit halting at
// the range of its own weapon. Decision 109 measured a staged attack against this (missile
// teams set an overwatch, the squads wait for it, tanks trail the squads in a town) and the
// staged attack lost more in every one of 17 fights, so it was not built. These are five of
// those fights, pinned with room to spare: a change to the attack has to do at least as well.
import { describe, expect, it } from 'vitest';
import { CMD_ASSIGN, CMD_FOUND, CMD_MISSION, CMD_SPAWN, type Command } from '../src/sim/commands';
import { fx } from '../src/sim/fixed';
import { generateMap, type Layout } from '../src/sim/map';
import { skirmishCommands } from '../src/sim/scenarios';
import { step } from '../src/sim/sim';
import { ST_SECURED, createStaff, staffThink } from '../src/sim/staff';
import {
  KIND_ATGM,
  KIND_DRONE,
  KIND_IFV,
  KIND_INFANTRY,
  KIND_TANK,
  POINTS,
} from '../src/sim/units';
import { M_ATTACK, STATE_ALIVE, TICK_RATE, createWorld } from '../src/sim/world';

const KIND = {
  inf: KIND_INFANTRY,
  atgm: KIND_ATGM,
  tank: KIND_TANK,
  ifv: KIND_IFV,
  drone: KIND_DRONE,
};
type Mix = Partial<Record<keyof typeof KIND, number>>;

const spawn = (team: number, kind: number, count: number, x: number, y: number): Command => ({
  type: CMD_SPAWN,
  count,
  team,
  kind,
  x: fx(x),
  y: fx(y),
  radius: fx(6),
  wander: false,
});

/** One commander with `own`, sent from `from` at a town held by `foe`. Army points lost. */
function assault(
  layout: Layout,
  name: string,
  own: Mix,
  foe: Mix,
  from: [number, number],
): { seconds: number; lost: number; left: number } {
  const w = createWorld(3, generateMap(3, layout));
  step(
    w,
    skirmishCommands(w.map).filter((c) => c.type === CMD_FOUND),
  );
  const st = createStaff(0, 3);
  const t = w.map.townName.indexOf(name);
  const tx = w.map.townX[t] / fx(1);
  const ty = w.map.townY[t] / fx(1);
  const mark = w.count;
  step(
    w,
    Object.entries(own).map(([k, n], j) =>
      spawn(0, KIND[k as keyof typeof KIND], n, from[0] + 6 * j, from[1] + 6 * j),
    ),
  );
  const ids: number[] = [];
  for (let i = mark; i < w.count; i++) ids.push(i);
  step(
    w,
    Object.entries(foe).map(([k, n], j) =>
      spawn(1, KIND[k as keyof typeof KIND], n, tx - 4 + 5 * j, ty + 3 - 4 * j),
    ),
  );
  step(w, [
    { type: CMD_ASSIGN, units: ids, slot: 0 },
    {
      type: CMD_MISSION,
      team: 0,
      slot: 0,
      mission: M_ATTACK,
      x: w.map.townX[t],
      y: w.map.townY[t],
    },
  ]);
  const points = (team: number) => {
    let sum = 0;
    for (let i = 0; i < w.count; i++) {
      if (w.state[i] === STATE_ALIVE && w.team[i] === team) sum += POINTS[w.kind[i]];
    }
    return sum;
  };
  const before = points(0);
  let seconds = -1;
  for (let k = 0; k < 300 * TICK_RATE; k++) {
    const out: Command[] = [];
    staffThink(st, w, out);
    step(w, out);
    if (st.posts[0].status === ST_SECURED) {
      seconds = k / TICK_RATE;
      break;
    }
  }
  return { seconds, lost: before - points(0), left: points(1) };
}

describe("a commander's attack on armour in a town", () => {
  const near: [number, number] = [250, 770];
  const far: [number, number] = [150, 860];

  it('squads and missile teams take a town on a hill from two tanks', () => {
    const r = assault(
      'ridge',
      'Westgate',
      { inf: 12, atgm: 5, drone: 1 },
      { tank: 2, inf: 3 },
      near,
    );
    expect(r.seconds).toBeGreaterThan(0);
    expect(r.left).toBe(0);
    expect(r.lost).toBeLessThanOrEqual(6);
  }, 60000);

  it('does not wait when there is no armour: eight squads cost it next to nothing', () => {
    const r = assault(
      'ridge',
      'Westgate',
      { inf: 12, atgm: 4, drone: 1, tank: 2 },
      { inf: 8 },
      near,
    );
    expect(r.seconds).toBeGreaterThan(0);
    expect(r.seconds).toBeLessThan(80);
    expect(r.lost).toBeLessThanOrEqual(2);
  }, 60000);

  it('marches in from far off and beats three tanks with missile teams alone', () => {
    const r = assault(
      'ridge',
      'Westgate',
      { inf: 10, atgm: 6, drone: 1 },
      { tank: 3, inf: 2 },
      far,
    );
    expect(r.seconds).toBeGreaterThan(0);
    expect(r.left).toBe(0);
    expect(r.lost).toBeLessThanOrEqual(5);
  }, 60000);

  it('takes a quarter of the city from tanks and fighting vehicles', () => {
    const r = assault(
      'city',
      'Millbrook',
      { inf: 16, atgm: 6, drone: 1, tank: 2 },
      { tank: 2, ifv: 2, inf: 6 },
      [130, 640],
    );
    expect(r.seconds).toBeGreaterThan(0);
    expect(r.left).toBe(0);
    expect(r.lost).toBeLessThanOrEqual(7);
  }, 60000);

  it('breaks a heavy defence of five tanks in the city without losing half its strength', () => {
    const r = assault(
      'city',
      'West End',
      { inf: 20, atgm: 8, drone: 1, tank: 2 },
      { tank: 5, inf: 6, atgm: 2 },
      [150, 880],
    );
    expect(r.seconds).toBeGreaterThan(0);
    expect(r.left).toBe(0);
    expect(r.lost).toBeLessThanOrEqual(14);
  }, 60000);
});
