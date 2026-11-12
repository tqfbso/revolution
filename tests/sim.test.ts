import { describe, expect, it } from 'vitest';
import {
  CMD_ATTACK_MOVE,
  CMD_ATTACK_STRUCTURE,
  CMD_BOMBARD,
  CMD_GARRISON,
  CMD_HOLD,
  CMD_LOAD,
  CMD_MOVE,
  CMD_SPAWN,
  CMD_STOP,
  CMD_UNLOAD,
  type Command,
} from '../src/sim/commands';
import { fx, isqrt } from '../src/sim/fixed';
import {
  CLASS_FOOT,
  CLASS_VEHICLE,
  MAP_CELLS,
  S_BRIDGE,
  S_BUILDING,
  T_BRIDGE,
  T_BUILDING,
  T_FORD,
  T_FOREST,
  T_RUBBLE,
  addStructure,
  addTown,
  cellOfPos,
  flatMap,
  generateMap,
  refreshPassability,
} from '../src/sim/map';
import { assaultCommands, battleCommands, stressTestCommands } from '../src/sim/scenarios';
import {
  COUNTER_BATTERY_TICKS,
  KINDS,
  KIND_AD,
  KIND_ARTILLERY,
  KIND_ATGM,
  KIND_DRONE,
  KIND_EW,
  KIND_IFV,
  KIND_INFANTRY,
  KIND_RECON,
  KIND_STRIKE,
  KIND_TANK,
} from '../src/sim/units';
import { step } from '../src/sim/sim';
import {
  EV_CAPTURE,
  EV_COLLAPSE,
  EV_DEATH,
  EV_IMPACT,
  EV_LAUNCH,
  EV_REPAIR,
  EV_SHOT,
  EV_SIEGE,
  EV_SMOKE,
  FLAG_HOLD,
  FLAG_MOVING,
  MAP_SIZE_FX,
  MAX_UNITS,
  STATE_ALIVE,
  STATE_FREE,
  STATE_WRECK,
  createWorld,
  unpackX,
  unpackY,
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
  if (tick === 60) {
    const units = Array.from({ length: 400 }, (_, i) => 1500 + i * 3);
    return [
      { type: CMD_GARRISON, units, structure: 2 },
      { type: CMD_GARRISON, units: units.slice(200), structure: 14 },
      { type: CMD_GARRISON, units: [1, 2, -5], structure: 9999 },
    ];
  }
  if (tick === 150) {
    const units = Array.from({ length: 300 }, (_, i) => 1501 + i * 4);
    return [
      { type: CMD_ATTACK_STRUCTURE, units, structure: 2 },
      { type: CMD_ATTACK_STRUCTURE, units: units.slice(0, 80), structure: 16 },
    ];
  }
  if (tick === 100) {
    // A mechanised company next to the battle: carriers, squads and missile teams.
    const at = (kind: number, count: number, team: number): Command => ({
      type: CMD_SPAWN,
      count,
      team,
      kind,
      x: fx(team === 0 ? 420 : 600),
      y: fx(430),
      radius: fx(25),
      wander: false,
    });
    return [
      at(KIND_IFV, 40, 0),
      at(KIND_INFANTRY, 60, 0),
      at(KIND_ATGM, 30, 0),
      at(KIND_IFV, 40, 1),
      at(KIND_ATGM, 30, 1),
      at(KIND_ARTILLERY, 20, 0),
      at(KIND_ARTILLERY, 20, 1),
      ...[KIND_RECON, KIND_DRONE, KIND_STRIKE, KIND_AD, KIND_EW].flatMap((k) => [
        at(k, 12, 0),
        at(k, 12, 1),
      ]),
    ];
  }
  if (tick === 130 || tick === 330 || tick === 360) {
    const units = Array.from({ length: 800 }, (_, i) => 2800 + i);
    if (tick === 130) {
      return [
        { type: CMD_LOAD, units, carriers: units },
        { type: CMD_BOMBARD, units: units.slice(300, 360), x: fx(520), y: fx(500) },
        { type: CMD_BOMBARD, units: units.slice(360, 420), x: fx(500), y: fx(470), smoke: true },
        { type: CMD_HOLD, units: units.slice(700, 800) },
      ];
    }
    if (tick === 330) return [{ type: CMD_ATTACK_MOVE, units, x: fx(600), y: fx(430) }];
    return [{ type: CMD_UNLOAD, units: units.slice(0, 400) }];
  }
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
  }, 30_000);

  it('different seed => different state', () => {
    expect(run(1, 50).at(-1)).not.toBe(run(2, 50).at(-1));
  });

  it('matches the pinned hash (catches cross-platform or accidental behaviour changes)', () => {
    // If you change sim behaviour on purpose, update this value in the same PR.
    expect(run(1234, 700).at(-1)).toBe(GOLDEN);
  });
});

const GOLDEN = 2782696136;

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
      if (w.state[i] !== STATE_ALIVE || w.inside[i] >= 0) continue;
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
      expect(map.cost[cls][cellAt(340, 512)]).toBeGreaterThan(0);
      expect(map.cost[cls][cellAt(690, 512)]).toBeGreaterThan(0);
    }
    for (let c = 0; c < MAP_CELLS * MAP_CELLS; c++) {
      if (map.type[c] === T_FOREST) expect(map.cost[CLASS_VEHICLE][c]).toBe(0);
    }
  });

  it('a mixed group ordered across the river gets there without touching water', () => {
    const w = createWorld(1);
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

  it('infantry in forest is concealed: it gets the first shot at a tank driving past', () => {
    // A world that is all forest for x < 500 and open ground beyond.
    const woods = flatMap();
    for (let c = 0; c < MAP_CELLS * MAP_CELLS; c++) {
      if (c % MAP_CELLS < 125) woods.type[c] = T_FOREST;
    }
    refreshPassability(woods);
    const w = createWorld(4, woods);
    step(w, [spawnAt(0, KIND_INFANTRY, 1, 490, 500), spawnAt(1, KIND_TANK, 1, 520, 500)]);
    // Spawning scatters units, so place the two exactly.
    w.posX[0] = fx(490);
    w.posX[1] = fx(508);
    w.posY[0] = w.posY[1] = fx(500);
    // 18 apart: well inside the tank's sight and range, but the squad is hidden.
    for (let t = 0; t < 40; t++) step(w, []);
    expect(w.attack[1]).toBe(-1);
    expect(w.attack[0]).toBe(1);
    // The squad closes to its own range (15) before the tank can spot it (13).
    for (let t = 0; t < 400 && w.events.length === 0; t++) step(w, []);
    const first = w.events.indexOf(EV_SHOT);
    expect(w.events[first + 1]).toBe(0);
  });

  it('nobody ends up on impassable ground during a battle across the river', () => {
    const w = createWorld(1);
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

describe('cities', () => {
  /** Flat ground with one 2x2 building at cells (126..127, 124..125): x 504..512, y 496..504. */
  const withHouse = () => {
    const m = flatMap();
    addTown(m, fx(508), fx(500), fx(30), 'Test');
    addStructure(m, S_BUILDING, 126, 124, 2, 2, 0, 3);
    refreshPassability(m);
    return m;
  };
  const place = (w: World, id: number, x: number, y: number) => {
    w.posX[id] = fx(x);
    w.posY[id] = fx(y);
  };
  const hasEvent = (w: World, type: number) => {
    for (let e = 0; e < w.events.length; e += 3) if (w.events[e] === type) return true;
    return false;
  };
  const shotsBy = (w: World) => {
    const n = new Map<number, number>();
    for (let e = 0; e < w.events.length; e += 3) {
      if (w.events[e] === EV_SHOT) n.set(w.events[e + 1], (n.get(w.events[e + 1]) ?? 0) + 1);
    }
    return n;
  };

  it('the generated map has towns on both banks and bridges that carry traffic', () => {
    const m = generateMap(1);
    expect(m.townCount).toBe(6);
    const kinds = Array.from(m.sKind.slice(0, m.structCount));
    expect(kinds.filter((k) => k === S_BRIDGE).length).toBeGreaterThanOrEqual(2);
    expect(kinds.filter((k) => k === S_BUILDING).length).toBeGreaterThan(20);
    for (let c = 0; c < MAP_CELLS * MAP_CELLS; c++) {
      if (m.type[c] === T_BUILDING) expect(m.cost[CLASS_FOOT][c]).toBe(0);
      if (m.type[c] === T_BRIDGE) expect(m.cost[CLASS_VEHICLE][c]).toBe(1);
    }
  });

  it('a building blocks movement, sight and fire', () => {
    const w = createWorld(1, withHouse());
    step(w, [spawnAt(0, KIND_TANK, 1, 495, 500), spawnAt(1, KIND_TANK, 1, 521, 500)]);
    place(w, 0, 495, 500);
    place(w, 1, 521, 500);
    for (let t = 0; t < 30; t++) step(w, []);
    // 26 apart with a house in between: neither sees the other.
    expect(w.attack[0]).toBe(-1);
    expect(w.attack[1]).toBe(-1);
    expect(w.events.length).toBe(0);
    // Step sideways past the corner and the fight is on.
    place(w, 0, 495, 512);
    place(w, 1, 521, 512);
    for (let t = 0; t < 80; t++) step(w, []);
    expect(hasEvent(w, EV_SHOT)).toBe(true);
    // Ordered straight through the house, a tank goes around it.
    const w2 = createWorld(1, withHouse());
    step(w2, [spawnAt(0, KIND_TANK, 1, 495, 500)]);
    step(w2, [{ type: CMD_MOVE, units: [0], x: fx(525), y: fx(500) }]);
    for (let t = 0; t < 400; t++) {
      step(w2, []);
      expect(w2.map.type[cellOfPos(w2.posX[0], w2.posY[0])]).not.toBe(T_BUILDING);
    }
    expect(w2.posX[0]).toBeGreaterThan(fx(520));
  });

  it('infantry occupies a building, ambushes from it and shrugs off rifle fire', () => {
    const w = createWorld(1, withHouse());
    step(w, [spawnAt(0, KIND_INFANTRY, 2, 495, 500)]);
    step(w, [{ type: CMD_GARRISON, units: [0, 1], structure: 0 }]);
    for (let t = 0; t < 200; t++) step(w, []);
    expect(w.inside[0]).toBe(0);
    expect(w.inside[1]).toBe(0);
    expect(w.sOcc[0]).toBe(2);
    // Enemy squads walk up: the garrison shoots first, because it cannot be seen.
    step(w, [spawnAt(1, KIND_INFANTRY, 2, 540, 500)]);
    step(w, [{ type: CMD_ATTACK_MOVE, units: [2, 3], x: fx(500), y: fx(500) }]);
    w.events.length = 0;
    for (let t = 0; t < 600 && w.events.length === 0; t++) step(w, []);
    expect(w.events[0]).toBe(EV_SHOT);
    expect(w.inside[w.events[1]]).toBe(0);
    // Equal numbers, equal weapons: the side behind walls wins without losing a squad.
    for (let t = 0; t < 2500; t++) step(w, []);
    expect(w.state[2]).not.toBe(STATE_ALIVE);
    expect(w.state[3]).not.toBe(STATE_ALIVE);
    expect(w.state[0]).toBe(STATE_ALIVE);
    expect(w.state[1]).toBe(STATE_ALIVE);
    // A move order brings the garrison out onto walkable ground.
    step(w, [{ type: CMD_MOVE, units: [0, 1], x: fx(480), y: fx(500) }]);
    expect(w.inside[0]).toBe(-1);
    expect(w.sOcc[0]).toBe(0);
    expect(w.map.cost[CLASS_FOOT][cellOfPos(w.posX[0], w.posY[0])]).toBeGreaterThan(0);
  });

  it('tanks bring the house down on its garrison; the ruin stays and still gives cover', () => {
    const w = createWorld(1, withHouse());
    step(w, [spawnAt(0, KIND_INFANTRY, 2, 495, 500)]);
    step(w, [{ type: CMD_GARRISON, units: [0, 1], structure: 0 }]);
    for (let t = 0; t < 200; t++) step(w, []);
    step(w, [spawnAt(1, KIND_TANK, 4, 540, 500)]);
    step(w, [{ type: CMD_ATTACK_STRUCTURE, units: [2, 3, 4, 5], structure: 0 }]);
    w.events.length = 0;
    let fell = -1;
    for (let t = 0; t < 1500 && fell < 0; t++) {
      step(w, []);
      if (hasEvent(w, EV_COLLAPSE)) fell = t;
    }
    expect(fell).toBeGreaterThan(0);
    expect(hasEvent(w, EV_SIEGE)).toBe(true);
    expect(w.sHp[0]).toBe(0);
    expect(w.map.type[cellOfPos(fx(506), fx(498))]).toBe(T_RUBBLE);
    expect(w.map.cost[CLASS_FOOT][cellOfPos(fx(506), fx(498))]).toBe(2);
    expect(w.map.cost[CLASS_VEHICLE][cellOfPos(fx(506), fx(498))]).toBe(0);
    // Survivors are out in the rubble, hurt.
    for (const i of [0, 1]) {
      expect(w.inside[i]).toBe(-1);
      if (w.state[i] === STATE_ALIVE)
        expect(w.hp[i]).toBeLessThanOrEqual(KINDS[KIND_INFANTRY].hp / 2);
    }
    // Nobody can go back in, and the ruin never clears.
    step(w, [{ type: CMD_GARRISON, units: [0, 1], structure: 0 }]);
    for (let t = 0; t < 3000; t++) step(w, []);
    expect(w.sOcc[0]).toBe(0);
    expect(w.map.type[cellOfPos(fx(506), fx(498))]).toBe(T_RUBBLE);
  });

  it('high ground shoots further', () => {
    const hill = flatMap();
    // Everything west of x = 500 is a plateau 9 units up.
    for (let v = 0; v < hill.heights.length; v++) {
      if (v % (MAP_CELLS + 1) <= 125) hill.heights[v] = fx(10);
    }
    const w = createWorld(1, hill);
    step(w, [spawnAt(0, KIND_TANK, 1, 499, 500), spawnAt(1, KIND_TANK, 1, 528, 500)]);
    // At the lip of the plateau: from further back its own edge would hide the ground below.
    place(w, 0, 499, 500);
    place(w, 1, 528, 500);
    w.speed[0] = w.speed[1] = 0;
    w.cooldown[0] = w.cooldown[1] = 0;
    // 29 apart: beyond a tank's 26, but within reach from 9 units up (and not from below).
    for (let t = 0; t < 100; t++) step(w, []);
    const shots = shotsBy(w);
    expect(shots.get(0) ?? 0).toBeGreaterThan(0);
    expect(shots.get(1) ?? 0).toBe(0);
  });

  it('a town goes to the army alone in it and then pays income; a garrison blocks capture', () => {
    const w = createWorld(1, withHouse());
    step(w, [spawnAt(1, KIND_INFANTRY, 1, 495, 500)]);
    step(w, [{ type: CMD_GARRISON, units: [0], structure: 0 }]);
    for (let t = 0; t < 1400; t++) step(w, []);
    expect(w.townOwner[0]).toBe(1);
    expect(w.credits[1]).toBeGreaterThan(0);
    expect(w.credits[0]).toBe(0);
    // Red tanks roll in. The squad in the house keeps the town contested.
    step(w, [spawnAt(0, KIND_TANK, 6, 530, 500)]);
    for (let t = 0; t < 300; t++) step(w, []);
    expect(w.townOwner[0]).toBe(1);
    // Once the house and its squad are gone the town changes hands.
    const tanks = [1, 2, 3, 4, 5, 6];
    step(w, [{ type: CMD_ATTACK_STRUCTURE, units: tanks, structure: 0 }]);
    for (let t = 0; t < 3000 && w.townOwner[0] !== 0; t++) step(w, []);
    expect(w.townOwner[0]).toBe(0);
    expect(hasEvent(w, EV_CAPTURE)).toBe(true);
  });

  it('a bridge can be cut, drowning what is on it, and rebuilt by idle infantry', () => {
    const w = createWorld(1);
    const m = w.map;
    let b = 0;
    while (m.sKind[b] !== S_BRIDGE) b++;
    const y = fx(m.sY[b] * 4 + 4);
    const west = fx(m.sX[b] * 4 - 10);
    const mid = fx((m.sX[b] + m.sW[b] / 2) * 4);
    const veh = m.cost[CLASS_VEHICLE];
    expect(veh[cellOfPos(mid, y)]).toBe(1);
    step(w, [
      {
        type: CMD_SPAWN,
        count: 4,
        team: 0,
        kind: KIND_TANK,
        x: west - fx(14),
        y,
        radius: fx(3),
        wander: false,
      },
      { type: CMD_SPAWN, count: 1, team: 1, kind: KIND_TANK, x: mid, y, radius: 1, wander: false },
    ]);
    w.speed[4] = 0; // parked on the span
    w.cooldown[4] = 30000; // and not shooting back
    step(w, [{ type: CMD_ATTACK_STRUCTURE, units: [0, 1, 2, 3], structure: b }]);
    w.hp[4] = 30000;
    for (let t = 0; t < 4000 && w.sHp[b] > 0; t++) {
      w.attack[0] = w.attack[1] = w.attack[2] = w.attack[3] = -1;
      step(w, []);
    }
    expect(w.sHp[b]).toBe(0);
    expect(w.state[4]).not.toBe(STATE_ALIVE);
    expect(veh[cellOfPos(mid, y)]).toBe(0);
    // Two squads stand by the stump with nothing else to do: the bridge comes back.
    step(w, [
      {
        type: CMD_SPAWN,
        count: 2,
        team: 0,
        kind: KIND_INFANTRY,
        x: west,
        y,
        radius: fx(2),
        wander: false,
      },
    ]);
    for (let t = 0; t < 1500 && w.sHp[b] <= 0; t++) step(w, []);
    expect(w.sHp[b]).toBe(m.sMaxHp[b]);
    expect(m.cost[CLASS_VEHICLE][cellOfPos(mid, y)]).toBe(1);
    expect(hasEvent(w, EV_REPAIR)).toBe(true);
  });

  it('the assault scenario starts with blue dug in on the east bank', () => {
    const w = createWorld(1);
    step(w, assaultCommands(w.map, 1200));
    let inside = 0;
    for (let i = 0; i < w.count; i++) if (w.inside[i] >= 0) inside++;
    expect(inside).toBeGreaterThan(60);
    for (let t = 0; t < 200; t++) step(w, []);
    expect(w.townOwner[1]).toBe(1);
    expect(w.townOwner[0]).toBe(0);
  });
});

describe('combined arms', () => {
  const flat = () => createWorld(1, flatMap());
  const lone = (w: World, team: number, kind: number, x: number, y: number) => {
    const id = w.count;
    step(w, [
      { type: CMD_SPAWN, count: 1, team, kind, x: fx(x), y: fx(y), radius: 1, wander: false },
    ]);
    w.posX[id] = fx(x);
    w.posY[id] = fx(y);
    return id;
  };
  /** Health a blue tank facing west (toward x = 0) loses to one red hit from (x, y). */
  const hitFrom = (kind: number, x: number, y: number) => {
    const w = flat();
    const tank = lone(w, 1, KIND_TANK, 500, 500);
    const shooter = lone(w, 0, kind, x, y);
    w.cooldown[shooter] = 0;
    w.cooldown[tank] = 9999;
    for (let t = 0; t < 8 && w.hp[tank] === KINDS[KIND_TANK].hp; t++) step(w, []);
    return KINDS[KIND_TANK].hp - w.hp[tank];
  };

  it('armour is thickest in front: the same hit does more from the side and most from behind', () => {
    const front = hitFrom(KIND_TANK, 480, 500);
    const side = hitFrom(KIND_TANK, 500, 480);
    const rear = hitFrom(KIND_TANK, 520, 500);
    expect(front).toBe(42);
    expect(side).toBe(69);
    expect(rear).toBe(108);
    // A missile into the engine deck is a kill; into the front plate it is not.
    expect(hitFrom(KIND_ATGM, 530, 500)).toBeGreaterThanOrEqual(KINDS[KIND_TANK].hp);
    expect(hitFrom(KIND_ATGM, 470, 500)).toBeLessThan(KINDS[KIND_TANK].hp / 2);
  });

  it('a standing tank turns its hull toward what it is fighting', () => {
    const w = flat();
    const tank = lone(w, 1, KIND_TANK, 500, 500);
    lone(w, 0, KIND_INFANTRY, 500, 520);
    expect(w.faceX[tank]).toBe(-1024);
    for (let t = 0; t < 100; t++) step(w, []);
    expect(w.faceY[tank]).toBeGreaterThan(1000);
  });

  it('a missile team outranges a tank and kills it, but cannot touch infantry', () => {
    const w = flat();
    const tank = lone(w, 1, KIND_TANK, 532, 500);
    const team = lone(w, 0, KIND_ATGM, 500, 500);
    step(w, [{ type: CMD_STOP, units: [tank] }]);
    w.flags[tank] = 0;
    // Hold the tank in place: it would close the range otherwise.
    for (let t = 0; t < 600 && w.state[tank] === STATE_ALIVE; t++) {
      step(w, []);
      w.posX[tank] = fx(532);
      w.velX[tank] = 0;
    }
    expect(w.state[tank]).toBe(STATE_WRECK);
    expect(w.hp[team]).toBe(KINDS[KIND_ATGM].hp);
    const squad = lone(w, 1, KIND_INFANTRY, 510, 500);
    for (let t = 0; t < 400 && w.state[team] === STATE_ALIVE; t++) step(w, []);
    expect(w.state[team]).not.toBe(STATE_ALIVE);
    expect(w.hp[squad]).toBe(KINDS[KIND_INFANTRY].hp);
  });

  it('squads mount a carrier, ride with it out of harm, and dismount on order', () => {
    const w = flat();
    const ifv = lone(w, 0, KIND_IFV, 300, 500);
    const a = lone(w, 0, KIND_INFANTRY, 306, 500);
    const b = lone(w, 0, KIND_ATGM, 300, 506);
    const c = lone(w, 0, KIND_INFANTRY, 294, 500);
    step(w, [{ type: CMD_LOAD, units: [a, b, c, ifv], carriers: [ifv, a] }]);
    for (let t = 0; t < 100; t++) step(w, []);
    // Two seats: the third squad stays on the ground.
    expect(w.load[ifv]).toBe(2);
    expect([a, b, c].filter((id) => w.carrier[id] === ifv).length).toBe(2);
    step(w, [{ type: CMD_MOVE, units: [ifv, a, b], x: fx(400), y: fx(500) }]);
    for (let t = 0; t < 300; t++) step(w, []);
    const riders = [a, b, c].filter((id) => w.carrier[id] === ifv);
    for (const id of riders) expect(w.posX[id]).toBe(w.posX[ifv]);
    expect(w.posX[ifv]).toBeGreaterThan(fx(395));
    step(w, [{ type: CMD_UNLOAD, units: [ifv] }]);
    expect(w.load[ifv]).toBe(0);
    for (const id of riders) {
      expect(w.carrier[id]).toBe(-1);
      expect(Math.abs(w.posX[id] - w.posX[ifv])).toBeLessThan(fx(5));
    }
  });

  it('a carrier that meets the enemy on an attack-move dismounts; one killed loaded spills half', () => {
    const w = flat();
    const ifv = lone(w, 0, KIND_IFV, 300, 500);
    const a = lone(w, 0, KIND_INFANTRY, 303, 500);
    step(w, [{ type: CMD_LOAD, units: [a], carriers: [ifv] }]);
    for (let t = 0; t < 60; t++) step(w, []);
    expect(w.carrier[a]).toBe(ifv);
    const enemy = lone(w, 1, KIND_INFANTRY, 380, 500);
    w.hp[enemy] = 30000;
    step(w, [{ type: CMD_ATTACK_MOVE, units: [ifv], x: fx(380), y: fx(500) }]);
    for (let t = 0; t < 400 && w.carrier[a] >= 0; t++) step(w, []);
    expect(w.carrier[a]).toBe(-1);
    expect(w.state[a]).toBe(STATE_ALIVE);

    const w2 = flat();
    const ifv2 = lone(w2, 0, KIND_IFV, 300, 500);
    const b = lone(w2, 0, KIND_INFANTRY, 303, 500);
    step(w2, [{ type: CMD_LOAD, units: [b], carriers: [ifv2] }]);
    for (let t = 0; t < 60; t++) step(w2, []);
    lone(w2, 1, KIND_TANK, 315, 500);
    step(w2, [{ type: CMD_MOVE, units: [ifv2], x: fx(100), y: fx(500) }]);
    w2.hp[ifv2] = 1;
    for (let t = 0; t < 200 && w2.state[ifv2] === STATE_ALIVE; t++) step(w2, []);
    expect(w2.state[ifv2]).toBe(STATE_WRECK);
    expect(w2.carrier[b]).toBe(-1);
    expect(w2.hp[b]).toBeLessThanOrEqual(KINDS[KIND_INFANTRY].hp / 2);
  });

  const count = (w: World, type: number) => {
    let n = 0;
    for (let e = 0; e < w.events.length; e += 3) if (w.events[e] === type) n++;
    return n;
  };

  it('a gun shells only what the army has spotted, and the shell takes time to arrive', () => {
    const w = flat();
    const gun = lone(w, 0, KIND_ARTILLERY, 400, 500);
    const target = lone(w, 1, KIND_ATGM, 480, 500);
    for (let t = 0; t < 200; t++) step(w, []);
    // Eighty units off and nobody looking: the gun has no idea it is there.
    expect(count(w, EV_LAUNCH)).toBe(0);
    lone(w, 0, KIND_INFANTRY, 450, 500);
    w.events.length = 0;
    let launched = -1;
    let landed = -1;
    for (let t = 0; t < 400 && landed < 0; t++) {
      step(w, []);
      if (launched < 0 && count(w, EV_LAUNCH) > 0) launched = t;
      if (count(w, EV_IMPACT) > 0) landed = t;
    }
    expect(launched).toBeGreaterThanOrEqual(0);
    expect(landed - launched).toBeGreaterThan(40);
    expect(w.attack[gun]).toBe(target);
    for (let t = 0; t < 1200 && w.state[target] === STATE_ALIVE; t++) step(w, []);
    expect(w.state[target]).not.toBe(STATE_ALIVE);
  });

  it('firing gives the gun away: the enemy battery answers without ever seeing it', () => {
    const w = flat();
    const red = lone(w, 0, KIND_ARTILLERY, 400, 500);
    const blue = lone(w, 1, KIND_ARTILLERY, 500, 500);
    for (let t = 0; t < 200; t++) step(w, []);
    expect(count(w, EV_LAUNCH)).toBe(0);
    w.cooldown[red] = 0;
    step(w, [{ type: CMD_BOMBARD, units: [red], x: fx(460), y: fx(560) }]);
    step(w, []);
    expect(w.spotted[red]).toBeGreaterThan(w.tick + COUNTER_BATTERY_TICKS - 5);
    for (let t = 0; t < 200; t++) step(w, []);
    expect(w.attack[blue]).toBe(red);
    const shots = new Set<number>();
    for (let e = 0; e < w.events.length; e += 3) {
      if (w.events[e] === EV_LAUNCH) shots.add(w.events[e + 1]);
    }
    expect(shots.has(blue)).toBe(true);
    // A gun that has moved on is no longer where the enemy thinks it is.
    step(w, [{ type: CMD_STOP, units: [red] }]);
    for (let t = 0; t < COUNTER_BATTERY_TICKS + 40; t++) step(w, []);
    expect(w.attack[blue]).toBe(-1);
  });

  it('guns hold fire when friends are next to the target, and cannot hit what is too close', () => {
    const w = flat();
    lone(w, 0, KIND_ARTILLERY, 400, 500);
    const enemy = lone(w, 1, KIND_ATGM, 470, 500);
    const friend = lone(w, 0, KIND_INFANTRY, 465, 500);
    w.hp[enemy] = 30000;
    w.hp[friend] = 30000;
    for (let t = 0; t < 300; t++) step(w, []);
    expect(count(w, EV_LAUNCH)).toBe(0);
    const w2 = flat();
    const gun = lone(w2, 0, KIND_ARTILLERY, 400, 500);
    lone(w2, 1, KIND_INFANTRY, 415, 500);
    for (let t = 0; t < 300 && w2.state[gun] === STATE_ALIVE; t++) step(w2, []);
    expect(count(w2, EV_LAUNCH)).toBe(0);
    expect(w2.state[gun]).toBe(STATE_WRECK);
  });

  it('guns ordered onto a building bring it down from out of sight', () => {
    const m = flatMap();
    addTown(m, fx(508), fx(500), fx(30), 'Test');
    const house = addStructure(m, S_BUILDING, 126, 124, 2, 2, 0, 3);
    refreshPassability(m);
    const w = createWorld(1, m);
    const guns: number[] = [];
    for (let k = 0; k < 6; k++) guns.push(lone(w, 0, KIND_ARTILLERY, 410, 480 + 8 * k));
    const squad = lone(w, 1, KIND_INFANTRY, 500, 500);
    step(w, [{ type: CMD_GARRISON, units: [squad], structure: house }]);
    for (let t = 0; t < 60; t++) step(w, []);
    expect(w.inside[squad]).toBe(house);
    step(w, [{ type: CMD_ATTACK_STRUCTURE, units: guns, structure: house }]);
    for (let t = 0; t < 4000 && w.sHp[house] > 0; t++) step(w, []);
    expect(w.sHp[house]).toBe(0);
    expect(w.map.type[cellOfPos(fx(506), fx(498))]).toBe(T_RUBBLE);
    // The order ends with the house; the guns never moved (it was in range all along).
    for (const g of guns) expect(w.posX[g]).toBeLessThan(fx(415));
    for (let t = 0; t < 40; t++) step(w, []);
    expect(w.flags[guns[0]]).toBe(0);
  });

  it('a hidden missile team is safe from a tank until a recon team finds it for the tank', () => {
    const setup = (withRecon: boolean) => {
      const m = flatMap();
      m.type[cellOfPos(fx(522), fx(502))] = T_FOREST;
      refreshPassability(m);
      const w = createWorld(1, m);
      const tank = lone(w, 0, KIND_TANK, 500, 502);
      const team = lone(w, 1, KIND_ATGM, 522, 502);
      if (withRecon) lone(w, 0, KIND_RECON, 502, 510);
      for (let t = 0; t < 200; t++) {
        w.cooldown[team] = 9999;
        step(w, []);
      }
      return { w, tank, team };
    };
    const blind = setup(false);
    expect(blind.w.attack[blind.tank]).toBe(-1);
    expect(blind.w.hp[blind.team]).toBe(KINDS[KIND_ATGM].hp);
    const seen = setup(true);
    expect(seen.w.state[seen.team]).not.toBe(STATE_ALIVE);
  });

  it('a recon team is unarmed, sees far, and is itself only noticed from close by', () => {
    const w = flat();
    const recon = lone(w, 0, KIND_RECON, 500, 500);
    const squad = lone(w, 1, KIND_INFANTRY, 560, 500);
    step(w, [{ type: CMD_STOP, units: [squad] }]);
    for (let t = 0; t < 40; t++) step(w, []);
    // Sixty units away, on open ground: the team has the squad, the squad has nothing.
    expect(w.spotted[squad]).toBeGreaterThan(w.tick);
    expect(w.spotted[recon]).toBeLessThanOrEqual(w.tick);
    expect(w.attack[recon]).toBe(-1);
    w.posX[squad] = fx(520);
    for (let t = 0; t < 60; t++) step(w, []);
    expect(w.attack[squad]).toBe(-1);
    w.posX[squad] = fx(510);
    for (let t = 0; t < 300 && w.state[recon] === STATE_ALIVE; t++) step(w, []);
    expect(w.state[recon]).not.toBe(STATE_ALIVE);
  });

  it('a drone sees over a town for the guns; under a jammer it is blind and the jammer is found', () => {
    const setup = (jammer: boolean) => {
      const m = flatMap();
      addTown(m, fx(508), fx(500), fx(30), 'Test');
      // A wall of houses between the gun line and the target.
      for (let k = 0; k < 8; k++) addStructure(m, S_BUILDING, 120, 116 + 2 * k, 2, 2, 0, 3);
      refreshPassability(m);
      const w = createWorld(1, m);
      const gun = lone(w, 0, KIND_ARTILLERY, 420, 500);
      lone(w, 0, KIND_RECON, 470, 500);
      const drone = lone(w, 0, KIND_DRONE, 470, 496);
      const target = lone(w, 1, KIND_ATGM, 510, 500);
      const ew = jammer ? lone(w, 1, KIND_EW, 505, 515) : -1;
      for (let t = 0; t < 60; t++) step(w, []);
      return { w, gun, drone, target, ew };
    };
    const clear = setup(false);
    expect(clear.w.jammed[clear.drone]).toBe(0);
    expect(clear.w.spotted[clear.target]).toBeGreaterThan(clear.w.tick);
    expect(clear.w.attack[clear.gun]).toBe(clear.target);
    const jam = setup(true);
    expect(jam.w.jammed[jam.drone]).toBe(1);
    expect(jam.w.spotted[jam.target]).toBeLessThanOrEqual(jam.w.tick);
    // The jammer shows itself by jamming, and the gun turns on it.
    expect(jam.w.spotted[jam.ew]).toBeGreaterThan(jam.w.tick);
    expect(jam.w.attack[jam.gun]).toBe(jam.ew);
  });

  it('strike drones kill a tank that cannot shoot back, and die doing it', () => {
    const w = flat();
    const tank = lone(w, 1, KIND_TANK, 500, 500);
    const a = lone(w, 0, KIND_STRIKE, 472, 500);
    const b = lone(w, 0, KIND_STRIKE, 472, 506);
    for (let t = 0; t < 200 && w.state[tank] === STATE_ALIVE; t++) step(w, []);
    expect(w.state[tank]).toBe(STATE_WRECK);
    expect(w.attack[tank]).toBe(-1);
    step(w, []);
    expect(w.state[a]).toBe(STATE_FREE);
    expect(w.state[b]).toBe(STATE_FREE);
  });

  const swarm = (defender: number) => {
    const w = flat();
    const tank = lone(w, 1, KIND_TANK, 600, 500);
    if (defender >= 0) lone(w, 1, defender, 596, 506);
    lone(w, 0, KIND_RECON, 540, 500);
    const drones: number[] = [];
    for (let k = 0; k < 3; k++) drones.push(lone(w, 0, KIND_STRIKE, 500, 494 + 6 * k));
    step(w, [{ type: CMD_ATTACK_MOVE, units: drones, x: fx(600), y: fx(500) }]);
    for (let t = 0; t < 400; t++) step(w, []);
    return { w, tank, lost: drones.filter((d) => w.state[d] !== STATE_ALIVE).length };
  };

  it('air defence shoots a small swarm down; a jammer drops it out of the sky', () => {
    const open = swarm(-1);
    expect(open.w.state[open.tank]).toBe(STATE_WRECK);
    const guarded = swarm(KIND_AD);
    expect(guarded.lost).toBe(3);
    expect(guarded.w.hp[guarded.tank]).toBe(KINDS[KIND_TANK].hp);
    const jammed = swarm(KIND_EW);
    expect(jammed.lost).toBe(3);
    expect(jammed.w.hp[jammed.tank]).toBe(KINDS[KIND_TANK].hp);
  });

  it('drones cross water and forest in a straight line and do not hold or contest ground', () => {
    const w = createWorld(1);
    const drone = lone(w, 0, KIND_DRONE, 300, 512);
    step(w, [{ type: CMD_MOVE, units: [drone], x: w.map.townX[1], y: w.map.townY[1] }]);
    const y0 = w.posY[drone];
    for (let t = 0; t < 2000 && (w.flags[drone] & FLAG_MOVING) !== 0; t++) step(w, []);
    expect(Math.abs(w.posX[drone] - w.map.townX[1])).toBeLessThan(fx(2));
    expect(Math.abs(w.posY[drone] - y0)).toBeLessThan(fx(40));
    for (let t = 0; t < 200; t++) step(w, []);
    expect(w.townOwner[1]).not.toBe(0);
  });
});

describe('smoke and hold position', () => {
  const flat = () => createWorld(1, flatMap());
  const lone = (w: World, team: number, kind: number, x: number, y: number) => {
    const id = w.count;
    step(w, [
      { type: CMD_SPAWN, count: 1, team, kind, x: fx(x), y: fx(y), radius: 1, wander: false },
    ]);
    w.posX[id] = fx(x);
    w.posY[id] = fx(y);
    return id;
  };

  it('a smoke shell blinds both sides until it blows away, and is one shell per gun', () => {
    const w = flat();
    const gun = lone(w, 0, KIND_ARTILLERY, 400, 500);
    step(w, [{ type: CMD_BOMBARD, units: [gun], x: fx(500), y: fx(500), smoke: true }]);
    let at = -1;
    for (let t = 0; t < 400 && at < 0; t++) {
      step(w, []);
      for (let e = 0; e < w.events.length; e += 3) {
        if (w.events[e] === EV_SMOKE) at = w.events[e + 1];
        expect(w.events[e]).not.toBe(EV_IMPACT);
      }
    }
    expect(at).toBeGreaterThanOrEqual(0);
    expect(w.smokeCount).toBeGreaterThan(8);
    expect(w.flags[gun]).toBe(0);
    const x = Math.round(unpackX(at));
    const y = Math.round(unpackY(at));
    // Two tanks well within range of each other, the smoke between them.
    const red = lone(w, 0, KIND_TANK, x - 12, y);
    const blue = lone(w, 1, KIND_TANK, x + 12, y);
    for (let t = 0; t < 100; t++) step(w, []);
    expect(w.attack[red]).toBe(-1);
    expect(w.attack[blue]).toBe(-1);
    expect(w.hp[red]).toBe(KINDS[KIND_TANK].hp);
    expect(w.shellCount).toBe(0);
    for (let t = 0; t < 700; t++) step(w, []);
    expect(w.smokeCount).toBe(0);
    expect(w.hp[red] < KINDS[KIND_TANK].hp || w.hp[blue] < KINDS[KIND_TANK].hp).toBe(true);
  });

  it('smoke hides what stands in it from a drone overhead', () => {
    const w = flat();
    const gun = lone(w, 0, KIND_ARTILLERY, 400, 500);
    step(w, [{ type: CMD_BOMBARD, units: [gun], x: fx(500), y: fx(500), smoke: true }]);
    let at = -1;
    for (let t = 0; t < 400 && at < 0; t++) {
      step(w, []);
      for (let e = 0; e < w.events.length; e += 3) {
        if (w.events[e] === EV_SMOKE) at = w.events[e + 1];
      }
    }
    const x = Math.round(unpackX(at));
    const y = Math.round(unpackY(at));
    const hidden = lone(w, 0, KIND_TANK, x, y);
    lone(w, 1, KIND_STRIKE, x + 20, y);
    for (let t = 0; t < 60; t++) step(w, []);
    expect(w.hp[hidden]).toBe(KINDS[KIND_TANK].hp);
  });

  it('a unit told to hold does not leave its spot to chase, and still shoots what comes', () => {
    const run = (hold: boolean) => {
      const w = flat();
      const red = lone(w, 0, KIND_TANK, 400, 500);
      const blue = lone(w, 1, KIND_TANK, 429, 500);
      if (hold) step(w, [{ type: CMD_HOLD, units: [red, blue] }]);
      for (let t = 0; t < 100; t++) step(w, []);
      return { w, red, blue };
    };
    const held = run(true);
    expect(held.w.flags[held.red] & FLAG_HOLD).toBe(FLAG_HOLD);
    expect(held.w.posX[held.red]).toBe(fx(400));
    expect(held.w.posX[held.blue]).toBe(fx(429));
    expect(held.w.hp[held.blue]).toBe(KINDS[KIND_TANK].hp);
    const free = run(false);
    expect(free.w.posX[free.red]).not.toBe(fx(400));
    // An enemy that walks into range is shot from the spot.
    const w = held.w;
    step(w, [{ type: CMD_MOVE, units: [held.blue], x: fx(410), y: fx(500) }]);
    for (let t = 0; t < 200; t++) step(w, []);
    expect(w.posX[held.red]).toBe(fx(400));
    expect(w.state[held.blue] !== 1 || w.hp[held.blue] < KINDS[KIND_TANK].hp).toBe(true);
  });
});
