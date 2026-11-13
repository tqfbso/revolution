import { describe, expect, it } from 'vitest';
import { CMD_CAMERA, CMD_MOVE, CMD_SPAWN, type Command } from '../src/sim/commands';
import { fx } from '../src/sim/fixed';
import { flatMap } from '../src/sim/map';
import { step } from '../src/sim/sim';
import {
  CAMERA_COST,
  CAMERA_LIMIT,
  KINDS,
  KIND_DRONE,
  KIND_ENGINEER,
  KIND_EW,
  KIND_INFANTRY,
  KIND_TANK,
} from '../src/sim/units';
import {
  EV_CAMERA,
  EV_CAMERA_LOST,
  MAX_CAMERAS,
  STATE_ALIVE,
  createWorld,
  hashWorld,
  type World,
} from '../src/sim/world';

function spawnAt(team: number, kind: number, x: number, y: number): Command {
  return {
    type: CMD_SPAWN,
    count: 1,
    team,
    kind,
    x: fx(x),
    y: fx(y),
    radius: fx(1),
    wander: false,
  };
}
function run(w: World, ticks: number, first: Command[] = []): void {
  step(w, first);
  for (let t = 1; t < ticks; t++) step(w, []);
}
function cameras(w: World, team: number): number[] {
  const out: number[] = [];
  for (let c = 0; c < MAX_CAMERAS; c++) if (w.camTeam[c] === team) out.push(c);
  return out;
}
function sawEvent(w: World, type: number): boolean {
  for (let e = 0; e < w.events.length; e += 3) if (w.events[e] === type) return true;
  return false;
}
/** A world with one red engineer squad at (300, 300) that has left a camera there. */
function watched(): { w: World; sapper: number } {
  const w = createWorld(1, flatMap());
  run(w, 2, [spawnAt(0, KIND_ENGINEER, 300, 300)]);
  const sapper = w.count - 1;
  step(w, [{ type: CMD_CAMERA, units: [sapper] }]);
  return { w, sapper };
}

describe('surveillance cameras', () => {
  it('an engineer squad leaves one where it stands, for a few supplies', () => {
    const w = createWorld(1, flatMap());
    run(w, 2, [spawnAt(0, KIND_ENGINEER, 300, 300), spawnAt(0, KIND_INFANTRY, 320, 300)]);
    const before = w.supplies[0];
    step(w, [{ type: CMD_CAMERA, units: [w.count - 2, w.count - 1] }]);
    expect(sawEvent(w, EV_CAMERA)).toBe(true);
    const mine = cameras(w, 0);
    // The rifle squad has no camera to leave.
    expect(mine.length).toBe(1);
    expect(w.supplies[0]).toBe(before - CAMERA_COST);
    expect(Math.abs(w.camX[mine[0]] - fx(300))).toBeLessThan(fx(6));
  });

  it('not two on the same spot, not without supplies, and not past the limit', () => {
    const { w, sapper } = watched();
    step(w, [{ type: CMD_CAMERA, units: [sapper] }]);
    expect(cameras(w, 0).length).toBe(1);
    w.supplies[0] = CAMERA_COST - 1;
    w.posX[sapper] += fx(40);
    step(w, [{ type: CMD_CAMERA, units: [sapper] }]);
    expect(cameras(w, 0).length).toBe(1);
    w.supplies[0] = 10000;
    for (let k = 0; k < CAMERA_LIMIT + 4; k++) {
      w.posX[sapper] += fx(20);
      step(w, [{ type: CMD_CAMERA, units: [sapper] }]);
    }
    expect(cameras(w, 0).length).toBe(CAMERA_LIMIT);
  });

  it('reports enemy ground troops in its circle after the squad has gone', () => {
    const { w, sapper } = watched();
    run(w, 400, [{ type: CMD_MOVE, units: [sapper], x: fx(300), y: fx(100) }]);
    run(w, 20, [spawnAt(1, KIND_TANK, 300, 325), spawnAt(1, KIND_TANK, 300, 420)]);
    const near = w.count - 2;
    const far = w.count - 1;
    expect(w.spotted[near]).toBeGreaterThan(w.tick);
    expect(w.spotted[far]).toBeLessThanOrEqual(w.tick);
  });

  it('is not found or harmed by troops that walk right past it', () => {
    const { w, sapper } = watched();
    run(w, 400, [{ type: CMD_MOVE, units: [sapper], x: fx(300), y: fx(100) }]);
    run(w, 200, [spawnAt(1, KIND_INFANTRY, 301, 301)]);
    expect(cameras(w, 0).length).toBe(1);
    expect(w.camSeen[cameras(w, 0)[0]]).toBeLessThanOrEqual(w.tick);
  });

  it('goes blind and is given away inside an enemy jammer bubble', () => {
    const { w, sapper } = watched();
    run(w, 400, [{ type: CMD_MOVE, units: [sapper], x: fx(300), y: fx(100) }]);
    const jam = KINDS[KIND_EW].jam / 1024;
    run(w, 20, [spawnAt(1, KIND_EW, 300, 300 + jam - 8), spawnAt(1, KIND_TANK, 300, 322)]);
    const c = cameras(w, 0)[0];
    expect(w.camBlind[c]).toBe(1);
    expect(w.camSeen[c]).toBeGreaterThan(w.tick);
    // Blind: the tank beside it goes unreported. Jamming gives the jammer away.
    expect(w.spotted[w.count - 1]).toBeLessThanOrEqual(w.tick);
    expect(w.spotted[w.count - 2]).toBeGreaterThan(w.tick);
  });

  it('once given away, comes down when an enemy ground unit reaches it', () => {
    const { w, sapper } = watched();
    run(w, 400, [{ type: CMD_MOVE, units: [sapper], x: fx(300), y: fx(100) }]);
    const jam = KINDS[KIND_EW].jam / 1024;
    run(w, 20, [spawnAt(1, KIND_EW, 300, 300 + jam - 8), spawnAt(1, KIND_INFANTRY, 300, 330)]);
    const squad = w.count - 1;
    expect(cameras(w, 0).length).toBe(1);
    let lost = false;
    step(w, [{ type: CMD_MOVE, units: [squad], x: fx(300), y: fx(300) }]);
    for (let t = 0; t < 600 && !lost; t++) {
      step(w, []);
      lost = sawEvent(w, EV_CAMERA_LOST);
    }
    expect(lost).toBe(true);
    expect(cameras(w, 0).length).toBe(0);
    expect(w.state[squad]).toBe(STATE_ALIVE);
  });

  it('a jammer has a fix on the drones it jams', () => {
    const w = createWorld(1, flatMap());
    run(w, 20, [spawnAt(0, KIND_DRONE, 300, 300), spawnAt(1, KIND_EW, 300, 310)]);
    expect(w.spotted[w.count - 2]).toBeGreaterThan(w.tick);
  });

  it('is part of the state hash', () => {
    const a = watched().w;
    const b = createWorld(1, flatMap());
    run(b, 3, [spawnAt(0, KIND_ENGINEER, 300, 300)]);
    expect(hashWorld(a)).not.toBe(hashWorld(b));
  });
});
