import { describe, expect, it } from 'vitest';
import {
  AIR_GUIDED,
  AIR_STICK,
  AIR_STRIKE_COOLDOWN,
  AIR_STRIKE_PRICE,
  AIR_SWARM,
  STRIKE_COOLING,
  STRIKE_NO_HQ,
  STRIKE_NO_PLANES,
  STRIKE_READY,
  STRIKE_TIER_LOW,
  strikeOf,
  strikeStatus,
} from '../src/sim/air';
import {
  CMD_AIRSTRIKE,
  CMD_FOUND,
  CMD_GRANT,
  CMD_MOVE,
  CMD_SPAWN,
  type Command,
} from '../src/sim/commands';
import { admit } from '../src/sim/guard';
import { B_HQ } from '../src/sim/economy';
import { FACTION_CHINA, FACTION_NATO, FACTION_NONE, FACTION_RUSSIA } from '../src/sim/factions';
import { fx } from '../src/sim/fixed';
import { flatMap } from '../src/sim/map';
import { step } from '../src/sim/sim';
import { KIND_AD, KIND_EW, KIND_INFANTRY, KIND_PLANE, KIND_TANK } from '../src/sim/units';
import {
  EV_AIRSTRIKE,
  EV_BOMB,
  STATE_ALIVE,
  createWorld,
  hashWorld,
  type World,
} from '../src/sim/world';

const spawnAt = (
  team: number,
  kind: number,
  count: number,
  x: number,
  y: number,
  r = 3,
): Command => ({
  type: CMD_SPAWN,
  count,
  team,
  kind,
  x: fx(x),
  y: fx(y),
  radius: fx(r),
  wander: false,
});
const alive = (w: World, team: number, kind: number) => {
  const out: number[] = [];
  for (let i = 0; i < w.count; i++) {
    if (w.state[i] === STATE_ALIVE && w.team[i] === team && w.kind[i] === kind) out.push(i);
  }
  return out;
};
/** An empty map, team 0 at the top tier with a headquarters in the west. */
function base(faction: number, seed = 3) {
  const map = flatMap();
  map.startX[0] = 20;
  map.startY[0] = 128;
  map.startX[1] = 236;
  map.startY[1] = 128;
  const w = createWorld(seed, map);
  w.faction[0] = faction;
  w.tier[0] = 3;
  w.supplies[0] = w.fuel[0] = w.credits[0] = 20000;
  step(w, [{ type: CMD_FOUND, team: 0, building: B_HQ, x: 20, y: 128 }]);
  return w;
}
function run(w: World, ticks: number, each?: () => void): void {
  for (let t = 0; t < ticks; t++) {
    step(w, []);
    each?.();
    w.events.length = 0;
  }
}
const strike = (x: number, y: number): Command => ({
  type: CMD_AIRSTRIKE,
  team: 0,
  x: fx(x),
  y: fx(y),
});
/** Count the bombs let go in the next `ticks`. */
function bombs(w: World, ticks: number): number {
  let n = 0;
  run(w, ticks, () => {
    for (let e = 0; e < w.events.length; e += 3) if (w.events[e] === EV_BOMB) n++;
  });
  return n;
}

describe('air strikes (I7)', () => {
  it('only the three big armies have one, each its own', () => {
    expect(strikeOf(base(FACTION_NATO), 0)).toBe(AIR_GUIDED);
    expect(strikeOf(base(FACTION_RUSSIA), 0)).toBe(AIR_STICK);
    expect(strikeOf(base(FACTION_CHINA), 0)).toBe(AIR_SWARM);
    const w = base(FACTION_NONE);
    expect(strikeStatus(w, 0)).toBe(STRIKE_NO_PLANES);
    step(w, [strike(600, 512)]);
    expect(alive(w, 0, KIND_PLANE).length).toBe(0);
  });

  it('needs the top tier and a headquarters, is paid for and then cools down', () => {
    const w = base(FACTION_NATO);
    w.tier[0] = 2;
    expect(strikeStatus(w, 0)).toBe(STRIKE_TIER_LOW);
    w.tier[0] = 3;
    expect(strikeStatus(w, 0)).toBe(STRIKE_READY);
    const credits = w.credits[0];
    let jets = 0;
    step(w, [strike(600, 512)]);
    for (let e = 0; e < w.events.length; e += 3) if (w.events[e] === EV_AIRSTRIKE) jets++;
    expect(jets).toBe(1);
    expect(w.credits[0]).toBe(credits - AIR_STRIKE_PRICE.credits);
    expect(strikeStatus(w, 0)).toBe(STRIKE_COOLING);
    step(w, [strike(600, 512)]);
    expect(alive(w, 0, KIND_PLANE).length).toBe(1);
    run(w, AIR_STRIKE_COOLDOWN);
    expect(strikeStatus(w, 0)).toBe(STRIKE_READY);
    for (let s = 0; s < w.map.structCount; s++)
      if (w.sType[s] === B_HQ && w.sTeam[s] === 0) w.sHp[s] = 0;
    expect(strikeStatus(w, 0)).toBe(STRIKE_NO_HQ);
  });

  it('the guided bomb kills the tank it is called on and nothing a street away', () => {
    const w = base(FACTION_NATO);
    step(w, [spawnAt(1, KIND_TANK, 1, 600, 512, 0), spawnAt(1, KIND_TANK, 1, 620, 512, 0)]);
    const [near, far] = alive(w, 1, KIND_TANK);
    step(w, [{ type: CMD_AIRSTRIKE, team: 0, x: w.posX[near], y: w.posY[near] }]);
    expect(bombs(w, 1200)).toBe(1);
    expect(w.state[near]).not.toBe(STATE_ALIVE);
    expect(w.state[far]).toBe(STATE_ALIVE);
    expect(w.hp[far]).toBeGreaterThan(0);
  });

  it('the guided bomb follows a tank that drives off', () => {
    const w = base(FACTION_NATO);
    step(w, [spawnAt(1, KIND_TANK, 1, 600, 512, 0)]);
    const [tank] = alive(w, 1, KIND_TANK);
    step(w, [{ type: CMD_AIRSTRIKE, team: 0, x: w.posX[tank], y: w.posY[tank] }]);
    step(w, [{ type: CMD_MOVE, units: [tank], x: fx(600), y: fx(700) }]);
    expect(bombs(w, 1200)).toBe(1);
    expect(w.state[tank]).not.toBe(STATE_ALIVE);
  });

  it('no player can grant himself the top tier', () => {
    const w = base(FACTION_NATO);
    const grant: Command = {
      type: CMD_GRANT,
      team: 0,
      tier: 3,
      supplies: 1e6,
      fuel: 1e6,
      credits: 1e6,
    };
    expect(admit(w, { ...grant, army: 0 } as Command)).toBeNull();
  });

  it('the stick of bombs lays six along the run and clears men in the open', () => {
    const w = base(FACTION_RUSSIA);
    // Ten squads strung out east to west, the way the jet comes in.
    for (let k = 0; k < 10; k++) step(w, [spawnAt(1, KIND_INFANTRY, 1, 585 + 3 * k, 512, 0)]);
    const tanks = [spawnAt(1, KIND_TANK, 1, 600, 530, 0)];
    step(w, tanks);
    step(w, [strike(600, 512)]);
    expect(bombs(w, 1200)).toBe(6);
    // They spread out a little before it comes: those still near the line are gone.
    expect(alive(w, 1, KIND_INFANTRY).length).toBeLessThanOrEqual(5);
    // Eighteen metres off the line, the tank is untouched.
    expect(alive(w, 1, KIND_TANK).length).toBe(1);
  });

  it('the drone swarm finds the tanks round the point, two to a tank', () => {
    const w = base(FACTION_CHINA);
    step(w, [
      spawnAt(1, KIND_TANK, 1, 590, 500, 0),
      spawnAt(1, KIND_TANK, 1, 615, 520, 0),
      spawnAt(1, KIND_TANK, 1, 600, 530, 0),
      spawnAt(1, KIND_TANK, 1, 585, 525, 0),
      spawnAt(1, KIND_INFANTRY, 3, 600, 512),
    ]);
    step(w, [strike(600, 512)]);
    expect(bombs(w, 1200)).toBe(8);
    expect(alive(w, 1, KIND_TANK).length).toBe(0);
    // Eight munitions went to the four tanks: the men were not what they were after.
    expect(alive(w, 1, KIND_INFANTRY).length).toBe(3);
  });

  it('a jammer by the tanks sends the swarm astray', () => {
    const w = base(FACTION_CHINA);
    step(w, [
      spawnAt(1, KIND_TANK, 1, 590, 500, 0),
      spawnAt(1, KIND_TANK, 1, 615, 520, 0),
      spawnAt(1, KIND_TANK, 1, 600, 530, 0),
      spawnAt(1, KIND_TANK, 1, 585, 525, 0),
      spawnAt(1, KIND_EW, 1, 600, 515, 0),
    ]);
    step(w, [strike(600, 512)]);
    expect(bombs(w, 1200)).toBe(8);
    expect(alive(w, 1, KIND_TANK).length).toBeGreaterThanOrEqual(3);
  });

  it('air defence on the way in shoots the jet down before it lets go', () => {
    const w = base(FACTION_NATO);
    step(w, [spawnAt(1, KIND_AD, 4, 400, 512)]);
    step(w, [spawnAt(1, KIND_TANK, 1, 800, 512, 0)]);
    step(w, [strike(800, 512)]);
    expect(bombs(w, 1500)).toBe(0);
    expect(alive(w, 1, KIND_TANK).length).toBe(1);
    expect(alive(w, 0, KIND_PLANE).length).toBe(0);
  });

  it('is deterministic', () => {
    const a = base(FACTION_RUSSIA, 9);
    const b = base(FACTION_RUSSIA, 9);
    for (const w of [a, b]) {
      step(w, [spawnAt(1, KIND_INFANTRY, 12, 600, 512, 12)]);
      step(w, [strike(600, 512)]);
      run(w, 800);
    }
    expect(hashWorld(a)).toBe(hashWorld(b));
  });
});
