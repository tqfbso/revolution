import { describe, expect, it } from 'vitest';
import { CMD_ATTACK_MOVE, CMD_MOVE, CMD_SPAWN, CMD_STOP, type Command } from '../src/sim/commands';
import { fx, isqrt } from '../src/sim/fixed';
import {
  CLASS_FOOT,
  CLASS_VEHICLE,
  MAP_CELLS,
  T_FORD,
  T_FOREST,
  cellOfPos,
  flatMap,
  generateMap,
} from '../src/sim/map';
import { battleCommands, stressTestCommands } from '../src/sim/scenarios';
import { KINDS, KIND_INFANTRY, KIND_TANK } from '../src/sim/units';
import { step } from '../src/sim/sim';
import {
  EV_DEATH,
  EV_SHOT,
  FLAG_MOVING,
  MAP_SIZE_FX,
  MAX_UNITS,
  STATE_ALIVE,
  STATE_FREE,
  STATE_WRECK,
  createWorld,
  hashWorld,
  type World,
} from '../src/sim/world';

/** A scripted game: opening spawn plus player orders at fixed ticks. */
function script(tick: number): Command[] {
  if (tick === 0) return [...stressTestCommands(1500), ...battleCommands(1500, 60)];
  if (tick === 200) {
    const units = Array.from({ length: 300 }, (_, i) => 1500 + i * 2);
    return [{ type: CMD_ATTACK_MOVE, units, x: fx(300), y: fx(300) }];
  }
  if (tick === 40) {
    const units = Array.from({ length: 500 }, (_, i) => i * 3);
    return [{ type: CMD_MOVE, units, x: fx(200), y: fx(800) }];
  }
  if (tick === 90) return [{ type: CMD_STOP, units: [0, 3, 6, 9, 99999, -1] }];
  if (tick === 120) {
    return [
      {
        type: CMD_SPAWN,
        count: 500,
        team: 1,
        x: fx(512),
        y: fx(512),
        radius: fx(30),
        wander: true,
      },
    ];
  }
  return [];
}

function run(seed: number, ticks: number): number[] {
  const w = createWorld(seed);
  const hashes: number[] = [];
  for (let t = 0; t < ticks; t++) {
    step(w, script(t));
    // Fold the tick's combat events into the comparison, then drop them.
    let h = hashWorld(w);
    for (const e of w.events) h = (Math.imul(h, 31) + e) >>> 0;
    w.events.length = 0;
    hashes.push(h);
  }
  return hashes;
}

function census(w: World): { alive: number[]; wrecks: number; free: number } {
  const alive = [0, 0, 0];
  let wrecks = 0;
  let free = 0;
  for (let i = 0; i < w.count; i++) {
    if (w.state[i] === STATE_ALIVE) alive[w.team[i]]++;
    else if (w.state[i] === STATE_WRECK) wrecks++;
    else free++;
  }
  return { alive, wrecks, free };
}

function spawnAt(team: number, kind: number, count: number, x: number, y: number): Command {
  return { type: CMD_SPAWN, count, team, kind, x: fx(x), y: fx(y), radius: fx(4), wander: false };
}

describe('determinism', () => {
  it('same seed + same commands => identical state hash on every tick', () => {
    const a = run(1234, 700);
    const b = run(1234, 700);
    expect(b).toEqual(a);
  });

  it('different seed => different state', () => {
    expect(run(1, 50).at(-1)).not.toBe(run(2, 50).at(-1));
  });

  it('matches the pinned hash (catches cross-platform or accidental behaviour changes)', () => {
    // If you change sim behaviour on purpose, update this value in the same PR.
    expect(run(1234, 700).at(-1)).toBe(GOLDEN);
  });
});

const GOLDEN = 1787654163;

describe('movement', () => {
  it('units ordered to move arrive in formation around the target and stop', () => {
    const w = createWorld(7, flatMap());
    step(w, [
      {
        type: CMD_SPAWN,
        count: 100,
        team: 0,
        x: fx(300),
        y: fx(300),
        radius: fx(20),
        wander: false,
      },
    ]);
    const units = Array.from({ length: 100 }, (_, i) => i);
    step(w, [{ type: CMD_MOVE, units, x: fx(600), y: fx(500) }]);
    for (let t = 0; t < 2000; t++) step(w, []);
    for (const i of units) {
      expect(w.flags[i] & FLAG_MOVING).toBe(0);
      const dx = w.posX[i] - fx(600);
      const dy = w.posY[i] - fx(500);
      expect(isqrt(dx * dx + dy * dy)).toBeLessThan(fx(25));
    }
  });

  it('stacked units are pushed apart', () => {
    const w = createWorld(7, flatMap());
    step(w, [
      { type: CMD_SPAWN, count: 48, team: 0, x: fx(500), y: fx(500), radius: 1, wander: false },
    ]);
    for (let t = 0; t < 400; t++) step(w, []);
    let tooClose = 0;
    for (let i = 0; i < w.count; i++) {
      for (let j = i + 1; j < w.count; j++) {
        const dx = w.posX[i] - w.posX[j];
        const dy = w.posY[i] - w.posY[j];
        if (isqrt(dx * dx + dy * dy) < fx(1.2)) tooClose++;
      }
    }
    expect(tooClose).toBe(0);
  });

  it('never exceeds capacity or leaves the map', () => {
    const w = createWorld(3, flatMap());
    step(w, [
      {
        type: CMD_SPAWN,
        count: MAX_UNITS + 500,
        team: 2,
        x: 0,
        y: 0,
        radius: fx(50),
        wander: true,
      },
    ]);
    expect(w.count).toBe(MAX_UNITS);
    for (let t = 0; t < 50; t++) step(w, []);
    for (let i = 0; i < w.count; i++) {
      expect(w.posX[i]).toBeGreaterThanOrEqual(0);
      expect(w.posX[i]).toBeLessThan(MAP_SIZE_FX);
      expect(w.posY[i]).toBeGreaterThanOrEqual(0);
      expect(w.posY[i]).toBeLessThan(MAP_SIZE_FX);
    }
  });
});

describe('combat', () => {
  it('a battle produces shots, deaths and wrecks, and the books balance', () => {
    const w = createWorld(5, flatMap());
    step(w, battleCommands(600, 40));
    const total = w.count;
    let shots = 0;
    let deaths = 0;
    const lastHp = Int16Array.from(w.hp);
    for (let t = 0; t < 1500; t++) {
      step(w, []);
      for (let e = 0; e < w.events.length; e += 3) {
        const [type, a, b] = [w.events[e], w.events[e + 1], w.events[e + 2]];
        if (type === EV_SHOT) {
          shots++;
          expect(w.team[a]).not.toBe(w.team[b]);
        } else if (type === EV_DEATH) {
          deaths++;
          expect(w.state[a]).toBe(STATE_WRECK);
        }
      }
      w.events.length = 0;
      for (let i = 0; i < total; i++) {
        expect(w.hp[i]).toBeLessThanOrEqual(lastHp[i]); // nothing heals
        lastHp[i] = w.hp[i];
      }
    }
    const c = census(w);
    expect(shots).toBeGreaterThan(1000);
    expect(deaths).toBeGreaterThan(200);
    expect(c.alive[0] + c.alive[1] + c.wrecks + c.free).toBe(total);
    expect(c.wrecks + c.free).toBe(deaths);
  });

  it('idle units engage an enemy that comes into view, and one side is wiped out', () => {
    const w = createWorld(9, flatMap());
    step(w, [spawnAt(0, KIND_TANK, 12, 500, 500), spawnAt(1, KIND_TANK, 4, 535, 500)]);
    for (let t = 0; t < 1500; t++) step(w, []);
    const c = census(w);
    expect(c.alive[1]).toBe(0);
    expect(c.alive[0]).toBeGreaterThan(6);
  });

  it('tanks outrange infantry: the first shot comes from the tank', () => {
    const w = createWorld(9, flatMap());
    step(w, [spawnAt(0, KIND_TANK, 1, 500, 500), spawnAt(1, KIND_INFANTRY, 1, 522, 500)]);
    let first = -1;
    for (let t = 0; t < 600 && first < 0; t++) {
      step(w, []);
      if (w.events.length > 0) first = w.events[1];
    }
    expect(w.kind[first]).toBe(KIND_TANK);
    expect(KINDS[KIND_TANK].range).toBeGreaterThan(KINDS[KIND_INFANTRY].range);
  });

  it('units under a plain move order do not stop to fight; same team never fights', () => {
    const w = createWorld(9, flatMap());
    step(w, [spawnAt(0, KIND_TANK, 6, 300, 300), spawnAt(0, KIND_TANK, 6, 320, 300)]);
    step(w, [{ type: CMD_MOVE, units: [0, 1, 2], x: fx(700), y: fx(700) }]);
    for (let t = 0; t < 400; t++) step(w, []);
    expect(w.events.length).toBe(0);
    expect(w.posX[0]).toBeGreaterThan(fx(380));
  });

  it('wrecks are cleared and their slots reused; dead units ignore orders', () => {
    const w = createWorld(9, flatMap());
    step(w, [spawnAt(0, KIND_TANK, 10, 500, 500), spawnAt(1, KIND_INFANTRY, 2, 520, 500)]);
    for (let t = 0; t < 1200; t++) step(w, []);
    expect(w.state[10]).toBe(STATE_FREE);
    expect(w.state[11]).toBe(STATE_FREE);
    const before = w.posX[10];
    step(w, [{ type: CMD_MOVE, units: [10], x: fx(100), y: fx(100) }]);
    step(w, []);
    expect(w.posX[10]).toBe(before);
    step(w, [spawnAt(2, KIND_TANK, 3, 100, 100)]);
    expect(w.count).toBe(13);
    expect(w.state[10]).toBe(STATE_ALIVE);
    expect(w.team[10]).toBe(2);
    expect(w.hp[10]).toBe(KINDS[KIND_TANK].hp);
  });
});

describe('terrain and pathfinding', () => {
  const map = generateMap(1);
  const cellAt = (x: number, y: number) => cellOfPos(fx(x), fx(y));
  /** Count living units standing on ground their class cannot enter. */
  const trespassers = (w: World) => {
    let bad = 0;
    for (let i = 0; i < w.count; i++) {
      if (w.state[i] !== STATE_ALIVE) continue;
      if (w.map.cost[KINDS[w.kind[i]].cls][cellOfPos(w.posX[i], w.posY[i])] === 0) bad++;
    }
    return bad;
  };

  it('the same seed gives the same map, and it has fords and forests', () => {
    expect(generateMap(1).hash).toBe(map.hash);
    expect(generateMap(2).hash).not.toBe(map.hash);
    expect(map.type.includes(T_FORD)).toBe(true);
    expect(map.type.includes(T_FOREST)).toBe(true);
  });

  it('both banks of the river are passable ground, and vehicles cannot enter forest', () => {
    for (const cls of [CLASS_VEHICLE, CLASS_FOOT]) {
      expect(map.cost[cls][cellAt(402, 512)]).toBeGreaterThan(0);
      expect(map.cost[cls][cellAt(622, 512)]).toBeGreaterThan(0);
    }
    for (let c = 0; c < MAP_CELLS * MAP_CELLS; c++) {
      if (map.type[c] === T_FOREST) expect(map.cost[CLASS_VEHICLE][c]).toBe(0);
    }
  });

  it('a mixed group ordered across the river gets there without touching water', () => {
    const w = createWorld(1, map);
    step(w, [spawnAt(0, KIND_TANK, 40, 380, 512), spawnAt(0, KIND_INFANTRY, 40, 370, 512)]);
    const units = Array.from({ length: 80 }, (_, i) => i);
    step(w, [{ type: CMD_MOVE, units, x: fx(640), y: fx(512) }]);
    for (let t = 0; t < 4500; t++) {
      step(w, []);
      if (t % 50 === 0) expect(trespassers(w)).toBe(0);
    }
    for (const i of units) {
      expect(w.flags[i] & FLAG_MOVING).toBe(0);
      expect(w.posX[i]).toBeGreaterThan(fx(600));
    }
  });

  it('nobody ends up on impassable ground during a battle across the river', () => {
    const w = createWorld(1, map);
    step(w, battleCommands(2000));
    for (let t = 0; t < 1500; t++) {
      step(w, []);
      if (t % 100 === 0) expect(trespassers(w)).toBe(0);
    }
    w.events.length = 0;
    const c = census(w);
    // The armies found each other across the river and fought.
    expect(c.wrecks + c.free).toBeGreaterThan(100);
  });
});
