import { describe, expect, it } from 'vitest';
import {
  FIRE_BURN_TICKS,
  FIRE_CLIMB_TICKS,
  FIRE_OUT,
  FIRE_PCT,
  ablaze,
  floorsAlight,
} from '../src/sim/collapse';
import { CMD_ATTACK_STRUCTURE, CMD_GARRISON, CMD_SPAWN, type Command } from '../src/sim/commands';
import { fx } from '../src/sim/fixed';
import {
  GROUND_PCT,
  S_BUILDING,
  addStructure,
  addTown,
  flatMap,
  groundMax,
  refreshPassability,
} from '../src/sim/map';
import { step } from '../src/sim/sim';
import { KINDS, KIND_ENGINEER, KIND_INFANTRY, KIND_TANK } from '../src/sim/units';
import { EV_COLLAPSE, EV_FIRE, STATE_ALIVE, createWorld, type World } from '../src/sim/world';

/** A three by three house of `floors` storeys on cells (126..128, 124..126): x 504..516. */
function world(floors = 2): World {
  const m = flatMap();
  addTown(m, fx(510), fx(502), fx(30), 'Test');
  addStructure(m, S_BUILDING, 126, 124, 3, 3, 0, floors);
  refreshPassability(m);
  return createWorld(1, m);
}
function spawnAt(team: number, kind: number, count: number, x: number, y: number): Command {
  return { type: CMD_SPAWN, count, team, kind, x: fx(x), y: fx(y), radius: fx(1), wander: false };
}
/** One attacker `gap` from the east wall brings the house down: when, how, and when it lit. */
function level(kind: number, gap: number, floors = 2) {
  const w = world(floors);
  step(w, [spawnAt(0, kind, 1, 516 + gap, 502)]);
  step(w, [{ type: CMD_ATTACK_STRUCTURE, units: [0], structure: 0 }]);
  let lit = -1;
  let ground = w.sGround[0];
  for (let t = 0; t < 20 * 60 * 10; t++) {
    step(w, []);
    for (let e = 0; e < w.events.length; e += 3) {
      if (w.events[e] === EV_FIRE && w.events[e + 2] === 0 && lit < 0) lit = t;
      if (w.events[e] === EV_COLLAPSE) return { at: t, pancake: w.events[e + 2], lit, ground, w };
    }
    ground = w.sGround[0];
    w.events.length = 0;
  }
  throw new Error('the house never came down');
}

describe('the ground floor and fire (I5)', () => {
  it('fire from across the street takes a building from the top, as it always did', () => {
    const far = level(KIND_TANK, 20);
    expect(far.pancake).toBe(0);
    expect(far.lit).toBe(-1);
    // The ground floor was never touched.
    expect(far.ground).toBe(groundMax(far.w.map, 0));
    // Half of 60 a shot, every three seconds, on 75 a cell: the pace decision 120 left.
    const shots = Math.ceil(far.w.map.sMaxHp[0] / 30);
    expect(far.at).toBeLessThanOrEqual(shots * KINDS[KIND_TANK].reload + 120);
    expect(far.at).toBeGreaterThan((shots - 1) * KINDS[KIND_TANK].reload);
  });

  it('a tank with its muzzle on the wall takes the ground floor out, and the rest pancakes', () => {
    const far = level(KIND_TANK, 20);
    const near = level(KIND_TANK, 4);
    expect(near.pancake).toBe(1);
    // The ground floor is three quarters of the building: so is the time.
    expect(near.at).toBeLessThan(far.at);
    expect(near.at * 100).toBeGreaterThan(far.at * (GROUND_PCT - 8));
    expect(near.at * 100).toBeLessThan(far.at * (GROUND_PCT + 8));
    // It was alight from the ground floor half gone.
    expect(near.lit).toBeGreaterThan(0);
    expect(near.lit).toBeLessThan(near.at);
    expect(near.w.sFell[0]).toBe(2);
  });

  it('charges bring a building down as fast as before, and flat', () => {
    const e = level(KIND_ENGINEER, 4);
    expect(e.pancake).toBe(1);
    const charges = Math.ceil(e.w.map.sMaxHp[0] / KINDS[KIND_ENGINEER].siege);
    expect(e.at).toBeLessThanOrEqual(charges * KINDS[KIND_ENGINEER].reload + 60);
    expect(e.at).toBeGreaterThan((charges - 2) * KINDS[KIND_ENGINEER].reload);
  });

  it('the fire climbs a floor at a time, turns the garrison out, and burns out', () => {
    const floors = 4;
    const w = world(floors);
    step(w, [spawnAt(1, KIND_INFANTRY, 2, 520, 502)]);
    step(w, [{ type: CMD_GARRISON, units: [0, 1], structure: 0 }]);
    for (let t = 0; t < 200; t++) step(w, []);
    expect(w.inside[0]).toBe(0);
    // The ground floor is shot to under half and catches.
    w.sGround[0] = Math.floor((groundMax(w.map, 0) * (FIRE_PCT - 5)) / 100);
    w.sFire[0] = w.tick + 1;
    const hp = [w.hp[0], w.hp[1]];
    for (let f = 1; f <= floors; f++) {
      expect(floorsAlight(w, 0)).toBe(f);
      expect(ablaze(w, 0)).toBe(false);
      expect(w.inside[0]).toBe(0);
      for (let t = 0; t < FIRE_CLIMB_TICKS; t++) step(w, []);
    }
    for (let t = 0; t < 20; t++) step(w, []);
    expect(ablaze(w, 0)).toBe(true);
    // Out in the street, alive and unhurt, and the building still stands.
    expect([w.inside[0], w.inside[1]]).toEqual([-1, -1]);
    expect([w.state[0], w.state[1]]).toEqual([STATE_ALIVE, STATE_ALIVE]);
    expect([w.hp[0], w.hp[1]]).toEqual(hp);
    expect(w.sHp[0]).toBe(w.map.sMaxHp[0]);
    expect(w.sOcc[0]).toBe(0);
    // Nobody goes back in while it burns.
    step(w, [{ type: CMD_GARRISON, units: [0, 1], structure: 0 }]);
    for (let t = 0; t < 200; t++) step(w, []);
    expect(w.inside[0]).toBe(-1);
    for (let t = 0; t < FIRE_BURN_TICKS; t++) step(w, []);
    expect(w.sFire[0]).toBe(FIRE_OUT);
    expect(floorsAlight(w, 0)).toBe(0);
    step(w, [{ type: CMD_GARRISON, units: [0, 1], structure: 0 }]);
    for (let t = 0; t < 200; t++) step(w, []);
    expect(w.inside[0]).toBe(0);
  });
});
