// Night battles (decision 113): ground troops see 60% as far in the dark, except what is
// lit by its own muzzle flash, by a flare or by a burning vehicle.
import { describe, expect, it } from 'vitest';
import { CMD_BOMBARD, CMD_NIGHT, CMD_SPAWN, type Command } from '../src/sim/commands';
import { fx } from '../src/sim/fixed';
import { flatMap } from '../src/sim/map';
import { step } from '../src/sim/sim';
import { KIND_ARTILLERY, KIND_ATGM, KIND_INFANTRY, KIND_RECON, KIND_TANK } from '../src/sim/units';
import { EV_FLARE, NO_TARGET, createWorld, hashWorld, type World } from '../src/sim/world';

const spawnAt = (team: number, kind: number, x: number, y: number): Command => ({
  type: CMD_SPAWN,
  count: 1,
  team,
  kind,
  x: fx(x),
  y: fx(y),
  radius: fx(1),
  wander: false,
});
const put = (w: World, i: number, x: number, y: number) => {
  w.posX[i] = w.targetX[i] = fx(x);
  w.posY[i] = w.targetY[i] = fx(y);
};
const run = (w: World, ticks: number, cmds: Command[] = []) => {
  step(w, cmds);
  for (let t = 1; t < ticks; t++) step(w, []);
};
/** A missile team (sight 38, 22.8 at night) and a silent enemy tank 30 away. */
function pair(night: boolean): World {
  const w = createWorld(9, flatMap());
  step(w, [
    { type: CMD_NIGHT, on: night },
    spawnAt(0, KIND_ATGM, 500, 500),
    spawnAt(1, KIND_TANK, 530, 500),
  ]);
  put(w, 0, 500, 500);
  put(w, 1, 530, 500);
  w.stance[1] = 1;
  return w;
}

describe('night battles', () => {
  it('by day the team sees the tank at 30 and shoots; in the dark it does not see it', () => {
    const day = pair(false);
    run(day, 60);
    expect(day.attack[0]).toBe(1);
    const night = pair(true);
    run(night, 60);
    expect(night.attack[0]).toBe(NO_TARGET);
    expect(day.hp[1]).toBeLessThan(night.hp[1]);
  });

  it('close enough, the dark hides nothing', () => {
    const w = pair(true);
    put(w, 1, 520, 500);
    run(w, 60);
    expect(w.attack[0]).toBe(1);
  });

  it('a tank that fires gives itself away by its flash', () => {
    const w = pair(true);
    // A squad beside the tank, for it to shoot at: the missile team is out of its sight.
    step(w, [spawnAt(0, KIND_INFANTRY, 548, 500)]);
    put(w, 2, 548, 500);
    w.stance[1] = 0;
    run(w, 80);
    expect(w.lit[1]).toBe(1);
    expect(w.attack[0]).toBe(1);
  });

  it('a flare lights everyone under it, for both sides, and burns out', () => {
    const w = pair(true);
    step(w, [spawnAt(0, KIND_ARTILLERY, 440, 500)]);
    put(w, 2, 440, 500);
    let flares = 0;
    step(w, [{ type: CMD_BOMBARD, units: [2], x: fx(530), y: fx(500), flare: true }]);
    for (let t = 0; t < 400 && w.flareCount === 0; t++) {
      step(w, []);
      for (let e = 0; e < w.events.length; e += 3) if (w.events[e] === EV_FLARE) flares++;
      w.events.length = 0;
    }
    expect(flares).toBe(1);
    expect(w.flareCount).toBe(1);
    run(w, 40);
    expect(w.lit[1]).toBe(1);
    expect(w.attack[0]).toBe(1);
    // One shell a gun, and it did no harm where it burst.
    const shells = w.shellCount;
    run(w, 700);
    expect(w.flareCount).toBe(0);
    expect(w.shellCount).toBe(shells);
  });

  it('recon teams see as far as by day', () => {
    const w = createWorld(9, flatMap());
    step(w, [
      { type: CMD_NIGHT, on: true },
      spawnAt(0, KIND_RECON, 500, 500),
      spawnAt(1, KIND_TANK, 540, 500),
    ]);
    put(w, 0, 500, 500);
    put(w, 1, 540, 500);
    w.stance[1] = 1;
    run(w, 80);
    expect(w.spotted[1]).toBeGreaterThan(w.tick);
  });

  it('is deterministic, and a day battle hashes as it always did', () => {
    const a = pair(true);
    const b = pair(true);
    run(a, 200);
    run(b, 200);
    expect(hashWorld(a)).toBe(hashWorld(b));
    expect(hashWorld(a)).not.toBe(hashWorld(pair(false)));
  });
});
