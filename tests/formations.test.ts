import { describe, expect, it } from 'vitest';
import { CMD_ATTACK, CMD_ATTACK_MOVE, CMD_SPAWN, type Command } from '../src/sim/commands';
import { fx } from '../src/sim/fixed';
import { flatMap } from '../src/sim/map';
import { EFFECTIVE, step } from '../src/sim/sim';
import { KINDS, KIND_COUNT, KIND_INFANTRY, KIND_IFV, KIND_ATGM, KIND_TANK } from '../src/sim/units';
import { STATE_ALIVE, createWorld, type World } from '../src/sim/world';

function spawnAt(
  team: number,
  kind: number,
  count: number,
  x: number,
  y: number,
  radius = 1,
): Command {
  return {
    type: CMD_SPAWN,
    count,
    team,
    kind,
    x: fx(x),
    y: fx(y),
    radius: fx(radius),
    wander: false,
  };
}
/** Spawning scatters units: put unit `i` exactly at (x, y). */
const put = (w: World, i: number, x: number, y: number) => {
  w.posX[i] = w.targetX[i] = fx(x);
  w.posY[i] = w.targetY[i] = fx(y);
};
const run = (w: World, ticks: number) => {
  for (let t = 0; t < ticks; t++) step(w, []);
};
const eff = (a: number, b: number) => EFFECTIVE[a * KIND_COUNT + b] === 1;

describe('infantry does not walk at armour (decision 108)', () => {
  it('knows what it can hurt: squads against squads, missiles and tanks against tanks', () => {
    expect(eff(KIND_INFANTRY, KIND_TANK)).toBe(false);
    expect(eff(KIND_INFANTRY, KIND_IFV)).toBe(false);
    expect(eff(KIND_INFANTRY, KIND_INFANTRY)).toBe(true);
    expect(eff(KIND_INFANTRY, KIND_ATGM)).toBe(true);
    expect(eff(KIND_ATGM, KIND_TANK)).toBe(true);
    expect(eff(KIND_TANK, KIND_TANK)).toBe(true);
    expect(eff(KIND_TANK, KIND_INFANTRY)).toBe(true);
    expect(eff(KIND_IFV, KIND_IFV)).toBe(true);
  });

  it('an idle squad that sees a tank out of its range stays where it is', () => {
    const w = createWorld(9, flatMap());
    step(w, [spawnAt(0, KIND_INFANTRY, 1, 500, 500), spawnAt(1, KIND_TANK, 1, 530, 500)]);
    w.stance[1] = 1; // The tank holds its fire: only the squad's choice is being tested.
    const x = w.posX[0];
    run(w, 300);
    expect(w.attack[0]).toBe(1);
    expect(w.posX[0]).toBe(x);
  });

  it('a missile team does go after the tank, and a squad after another squad', () => {
    const w = createWorld(9, flatMap());
    step(w, [
      spawnAt(0, KIND_ATGM, 1, 500, 500),
      spawnAt(1, KIND_TANK, 1, 536, 500),
      spawnAt(0, KIND_INFANTRY, 1, 500, 700),
      spawnAt(1, KIND_INFANTRY, 1, 530, 700),
    ]);
    put(w, 0, 500, 500);
    put(w, 1, 537, 500);
    put(w, 2, 500, 700);
    put(w, 3, 530, 700);
    w.stance[1] = w.stance[3] = 1;
    const a = w.posX[0];
    const b = w.posX[2];
    run(w, 100);
    expect(w.posX[0]).toBeGreaterThan(a + fx(2));
    expect(w.posX[2]).toBeGreaterThan(b + fx(2));
  });

  it('with a tank near and a squad further off, a squad shoots the squad', () => {
    const w = createWorld(9, flatMap());
    step(w, [
      spawnAt(0, KIND_INFANTRY, 1, 500, 500),
      spawnAt(1, KIND_TANK, 1, 508, 500),
      spawnAt(1, KIND_INFANTRY, 1, 500, 514),
    ]);
    put(w, 0, 500, 500);
    put(w, 1, 509, 500);
    put(w, 2, 500, 513);
    w.stance[1] = w.stance[2] = 1;
    run(w, 40);
    expect(w.attack[0]).toBe(2);
    // The tank's own choice is unchanged: the nearest thing it can kill.
    expect(KINDS[KIND_TANK].damage[KIND_INFANTRY]).toBeGreaterThan(0);
  });

  it('still shoots a tank that is all there is in range', () => {
    const w = createWorld(9, flatMap());
    step(w, [spawnAt(0, KIND_INFANTRY, 1, 500, 500), spawnAt(1, KIND_TANK, 1, 510, 500)]);
    put(w, 0, 500, 500);
    put(w, 1, 511, 500);
    w.stance[1] = 1;
    const hp = w.hp[1];
    run(w, 200);
    expect(w.hp[1]).toBeLessThan(hp);
  });

  it('marches on under attack-move instead of stopping for a tank it cannot hurt', () => {
    const w = createWorld(9, flatMap());
    step(w, [spawnAt(0, KIND_INFANTRY, 1, 500, 500), spawnAt(1, KIND_TANK, 1, 540, 530)]);
    w.stance[1] = 1;
    step(w, [{ type: CMD_ATTACK_MOVE, units: [0], x: fx(620), y: fx(500) }]);
    run(w, 900);
    expect(w.state[0]).toBe(STATE_ALIVE);
    expect(w.posX[0]).toBeGreaterThan(fx(610));
    expect(Math.abs(w.posY[0] - fx(500))).toBeLessThan(fx(6));
  });

  it('goes for the tank when told to', () => {
    const w = createWorld(9, flatMap());
    step(w, [spawnAt(0, KIND_INFANTRY, 1, 500, 500), spawnAt(1, KIND_TANK, 1, 530, 500)]);
    w.stance[1] = 1;
    step(w, [{ type: CMD_ATTACK, units: [0], target: 1 }]);
    run(w, 200);
    expect(w.posX[0]).toBeGreaterThan(fx(510));
  });
});

describe('the army mix after the armour rule', () => {
  it('25 points of squads and missile teams still beat 5 tanks that attack them', () => {
    const w = createWorld(11, flatMap());
    // Defenders: 15 rifle squads and 10 missile teams (25 points). Attackers: 5 tanks (25).
    step(w, [
      spawnAt(0, KIND_INFANTRY, 15, 500, 500, 14),
      spawnAt(0, KIND_ATGM, 10, 494, 500, 10),
      spawnAt(1, KIND_TANK, 5, 580, 500, 8),
    ]);
    const tanks: number[] = [];
    for (let i = 0; i < w.count; i++) if (w.team[i] === 1) tanks.push(i);
    step(w, [{ type: CMD_ATTACK_MOVE, units: tanks, x: fx(500), y: fx(500) }]);
    run(w, 2400);
    let left = 0;
    let own = 0;
    for (let i = 0; i < w.count; i++) {
      if (w.state[i] !== STATE_ALIVE) continue;
      if (w.team[i] === 1) left++;
      else own++;
    }
    expect(left).toBe(0);
    expect(own).toBeGreaterThan(10);
  });
});

describe('rockets point blank', () => {
  it('a squad rushes a vehicle that has come close, and stays put for one that has not', () => {
    const w = createWorld(9, flatMap());
    step(w, [
      spawnAt(0, KIND_INFANTRY, 1, 500, 500),
      spawnAt(1, KIND_TANK, 1, 512, 500),
      spawnAt(0, KIND_INFANTRY, 1, 500, 700),
      spawnAt(1, KIND_TANK, 1, 524, 700),
    ]);
    put(w, 0, 500, 500);
    put(w, 1, 513, 500);
    put(w, 2, 500, 700);
    put(w, 3, 524, 700);
    w.stance[1] = w.stance[3] = 1;
    run(w, 100);
    expect(w.posX[0]).toBeGreaterThan(fx(505));
    expect(w.posX[2]).toBe(fx(500));
  });
});
