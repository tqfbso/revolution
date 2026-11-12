import { describe, expect, it } from 'vitest';
import {
  CMD_BUILD,
  CMD_CANCEL,
  CMD_FOUND,
  CMD_GATHER,
  CMD_MOVE,
  CMD_REPEAT,
  CMD_RESEARCH,
  CMD_SPAWN,
  CMD_STANCE,
  CMD_TRAIN,
  type Command,
} from '../src/sim/commands';
import {
  BUILDINGS,
  B_BARRACKS,
  B_DEPOT,
  B_HQ,
  B_WORKS,
  TIER_PRICE,
  UNIT_PRICE,
  WELL_RATE,
  WELL_TANK,
} from '../src/sim/economy';
import { fx } from '../src/sim/fixed';
import {
  CLASS_VEHICLE,
  MAP_CELLS,
  SITE_FUEL,
  SITE_SUPPLIES,
  T_OPEN,
  canPlace,
  flatMap,
  generateMap,
  type GameMap,
} from '../src/sim/map';
import { skirmishCommands } from '../src/sim/scenarios';
import { step } from '../src/sim/sim';
import { KIND_INFANTRY, KIND_TANK, KIND_TRUCK, POINTS } from '../src/sim/units';
import {
  EV_SHOT,
  JOB_NONE,
  STANCE_HOLD_FIRE,
  STATE_ALIVE,
  createWorld,
  hashWorld,
  type World,
} from '../src/sim/world';

const cell = (c: number) => fx(c * 4 + 2);

function addSite(map: GameMap, kind: number, stock: number, cx: number, cy: number): number {
  const k = map.siteCount++;
  map.siteX[k] = cell(cx);
  map.siteY[k] = cell(cy);
  map.siteKind[k] = kind;
  map.siteStock[k] = stock;
  return k;
}

/** A flat world with a red headquarters at cell (60, 60), a stockpile and a well near it. */
function base(trucks = 2): World {
  const map = flatMap();
  addSite(map, SITE_SUPPLIES, 200, 72, 60);
  addSite(map, SITE_FUEL, 100, 60, 72);
  const w = createWorld(5, map);
  step(w, [
    { type: CMD_FOUND, team: 0, building: B_HQ, x: 60, y: 60 },
    {
      type: CMD_SPAWN,
      count: trucks,
      team: 0,
      kind: KIND_TRUCK,
      x: cell(66),
      y: cell(66),
      radius: 1,
      wander: false,
    },
  ]);
  return w;
}

const run = (w: World, ticks: number, first: Command[] = []) => {
  step(w, first);
  for (let t = 1; t < ticks; t++) step(w, []);
};
const unitsOf = (w: World, kind: number, team = -1) =>
  Array.from({ length: w.count }, (_, i) => i).filter(
    (i) => w.state[i] === STATE_ALIVE && w.kind[i] === kind && (team < 0 || w.team[i] === team),
  );
const hq = (w: World) => w.sTeam.indexOf(0);

describe('resource sites', () => {
  it('gives both banks the same sites on open ground trucks can reach', () => {
    for (const seed of [1, 7, 42]) {
      const map = generateMap(seed);
      expect(map.siteCount).toBe(26);
      expect(map.startX[0]).toBeGreaterThan(0);
      expect(map.startX[1]).toBeGreaterThan(map.startX[0]);
      for (let k = 0; k < map.siteCount; k++) {
        const c = (map.siteY[k] >> 12) * MAP_CELLS + (map.siteX[k] >> 12);
        expect(map.type[c]).toBe(T_OPEN);
        expect(map.cost[CLASS_VEHICLE][c]).toBeGreaterThan(0);
        expect(map.siteKind[k]).toBe(map.siteKind[(k + 13) % 26]);
      }
      expect(canPlace(map, map.startX[0], map.startY[0], 3, 3)).toBe(true);
    }
  });
});

describe('trucks', () => {
  it('haul a stockpile home until it is empty, losing nothing on the way', () => {
    const w = base();
    const trucks = unitsOf(w, KIND_TRUCK);
    const before = w.supplies[0];
    run(w, 2400, [{ type: CMD_GATHER, units: trucks, site: 0 }]);
    expect(w.siteStock[0]).toBe(0);
    expect(w.supplies[0]).toBe(before + 200);
    expect(trucks.every((i) => w.job[i] === JOB_NONE && w.cargo[i] === 0)).toBe(true);
  });

  it('take from a well only what it has pumped', () => {
    const w = base(6);
    const before = w.fuel[0];
    run(w, 2000, [{ type: CMD_GATHER, units: unitsOf(w, KIND_TRUCK), site: 1 }]);
    const gained = w.fuel[0] - before;
    // 100 in the tank plus what it pumps in 100 seconds, whatever the number of trucks.
    expect(gained).toBeGreaterThan(250);
    expect(gained).toBeLessThanOrEqual(100 + WELL_RATE * 100);
    expect(w.siteStock[1]).toBeLessThanOrEqual(WELL_TANK);
  });

  it('drop the job when given another order', () => {
    const w = base();
    const trucks = unitsOf(w, KIND_TRUCK);
    run(w, 40, [{ type: CMD_GATHER, units: trucks, site: 0 }]);
    run(w, 400, [{ type: CMD_MOVE, units: trucks, x: cell(30), y: cell(30) }]);
    expect(w.siteStock[0]).toBe(200);
    expect(trucks.every((i) => w.job[i] === JOB_NONE)).toBe(true);
  });
});

describe('construction', () => {
  it('is paid for at once, takes work, and then stands in the way', () => {
    const w = base();
    const trucks = unitsOf(w, KIND_TRUCK);
    const b = BUILDINGS[B_BARRACKS];
    const before = w.supplies[0];
    step(w, [{ type: CMD_BUILD, units: trucks, building: B_BARRACKS, x: 70, y: 66 }]);
    const s = w.map.structCount - 1;
    expect(w.sType[s]).toBe(B_BARRACKS);
    expect(w.supplies[0]).toBe(before - b.supplies);
    expect(w.sHp[s]).toBe(b.hp / 10);
    step(w, []);
    expect(w.map.cost[CLASS_VEHICLE][66 * MAP_CELLS + 70]).toBe(0);
    // Two trucks halve the time, after the drive there.
    for (let t = 0; t < b.ticks / 2 + 200; t++) step(w, []);
    expect(w.sBuild[s]).toBe(b.ticks);
    expect(w.sHp[s]).toBe(b.hp);
    expect(trucks.every((i) => w.job[i] === JOB_NONE)).toBe(true);
  });

  it('is refused without the money, the technology or the ground', () => {
    const w = base();
    const trucks = unitsOf(w, KIND_TRUCK);
    const count = w.map.structCount;
    // Touching the headquarters; a tier-two building; then nothing left to pay with.
    step(w, [{ type: CMD_BUILD, units: trucks, building: B_DEPOT, x: 63, y: 60 }]);
    step(w, [{ type: CMD_BUILD, units: trucks, building: B_HQ, x: 80, y: 80 }]);
    w.supplies[0] = 100;
    step(w, [{ type: CMD_BUILD, units: trucks, building: B_DEPOT, x: 80, y: 80 }]);
    expect(w.map.structCount).toBe(count);
    expect(w.supplies[0]).toBe(100);
  });

  it('never leaves a unit inside the walls', () => {
    const w = base();
    const trucks = unitsOf(w, KIND_TRUCK);
    const cx = w.posX[trucks[0]] >> 12;
    const cy = w.posY[trucks[0]] >> 12;
    step(w, [{ type: CMD_BUILD, units: [trucks[1]], building: B_DEPOT, x: cx - 1, y: cy - 1 }]);
    step(w, []);
    expect(w.sType[w.map.structCount - 1]).toBe(B_DEPOT);
    for (const i of trucks) {
      expect(w.map.cost[CLASS_VEHICLE][(w.posY[i] >> 12) * MAP_CELLS + (w.posX[i] >> 12)]).toBe(1);
    }
  });
});

describe('production', () => {
  it('queues, charges, refunds and delivers', () => {
    const w = base();
    const s = hq(w);
    const p = UNIT_PRICE[KIND_TRUCK];
    const before = w.supplies[0];
    step(w, [
      { type: CMD_TRAIN, structure: s, kind: KIND_TRUCK },
      { type: CMD_TRAIN, structure: s, kind: KIND_TRUCK },
      { type: CMD_TRAIN, structure: s, kind: KIND_TANK }, // wrong building
    ]);
    expect(w.sQueueLen[s]).toBe(2);
    expect(w.supplies[0]).toBe(before - 2 * p.supplies);
    step(w, [{ type: CMD_CANCEL, structure: s }]);
    expect(w.supplies[0]).toBe(before - p.supplies);
    run(w, p.ticks + 5);
    expect(unitsOf(w, KIND_TRUCK).length).toBe(3);
    expect(w.sQueueLen[s]).toBe(0);
  });

  it('stops at the limit the buildings set', () => {
    const w = base();
    const s = hq(w);
    step(w, [
      {
        type: CMD_SPAWN,
        count: 58,
        team: 0,
        kind: KIND_INFANTRY,
        x: cell(40),
        y: cell(40),
        radius: fx(10),
        wander: false,
      },
    ]);
    run(w, 600, [{ type: CMD_TRAIN, structure: s, kind: KIND_TRUCK }]);
    expect(w.popCap[0]).toBe(BUILDINGS[B_HQ].cap);
    expect(w.pop[0]).toBe(60);
    expect(w.sQueueLen[s]).toBe(1);
  });

  it('counts army points: a tank takes five slots, a squad one', () => {
    expect(POINTS[KIND_TANK]).toBe(5);
    expect(POINTS[KIND_INFANTRY]).toBe(1);
    const w = base();
    w.tier[0] = 2;
    step(w, [
      { type: CMD_FOUND, team: 0, building: B_WORKS, x: 70, y: 50 },
      {
        type: CMD_SPAWN,
        count: 55,
        team: 0,
        kind: KIND_INFANTRY,
        x: cell(40),
        y: cell(40),
        radius: fx(10),
        wander: false,
      },
    ]);
    const works = w.map.structCount - 1;
    w.supplies[0] = 2000;
    w.fuel[0] = 500;
    // 2 trucks + 55 squads = 57 of 60 points: a tank (5) must wait, though slots remain.
    run(w, 40, [{ type: CMD_TRAIN, structure: works, kind: KIND_TANK }]);
    expect(w.pop[0]).toBe(57);
    run(w, UNIT_PRICE[KIND_TANK].ticks + 40);
    expect(unitsOf(w, KIND_TANK).length).toBe(0);
    expect(w.sQueueLen[works]).toBe(1);
  });

  it('repeats the last unit while the building is on repeat', () => {
    const w = base();
    const s = hq(w);
    step(w, [{ type: CMD_FOUND, team: 0, building: B_BARRACKS, x: 70, y: 50 }]);
    const barracks = w.map.structCount - 1;
    w.supplies[0] = 1000;
    const t = UNIT_PRICE[KIND_INFANTRY].ticks;
    step(w, [
      { type: CMD_TRAIN, structure: barracks, kind: KIND_INFANTRY },
      { type: CMD_REPEAT, structure: barracks, on: true },
    ]);
    run(w, t * 4 + 10);
    expect(unitsOf(w, KIND_INFANTRY).length).toBeGreaterThanOrEqual(4);
    step(w, [{ type: CMD_REPEAT, structure: barracks, on: false }]);
    const n = unitsOf(w, KIND_INFANTRY).length;
    run(w, t * 3);
    expect(unitsOf(w, KIND_INFANTRY).length).toBeLessThanOrEqual(n + 1);
    expect(s).toBeGreaterThanOrEqual(0);
  });

  it('opens up with the technology tier', () => {
    const w = base();
    const s = hq(w);
    step(w, [{ type: CMD_FOUND, team: 0, building: B_WORKS, x: 70, y: 50 }]);
    const works = w.map.structCount - 1;
    w.supplies[0] = 2000;
    w.fuel[0] = 500;
    w.credits[0] = 300;
    step(w, [{ type: CMD_TRAIN, structure: works, kind: KIND_TANK }]);
    expect(w.sQueueLen[works]).toBe(0);
    step(w, [
      { type: CMD_RESEARCH, structure: s },
      { type: CMD_RESEARCH, structure: s },
    ]);
    expect(w.sQueueLen[s]).toBe(1);
    expect(w.credits[0]).toBe(0);
    run(w, TIER_PRICE[1]!.ticks + 2);
    expect(w.tier[0]).toBe(2);
    run(w, UNIT_PRICE[KIND_TANK].ticks + 5, [
      { type: CMD_TRAIN, structure: works, kind: KIND_TANK },
    ]);
    expect(unitsOf(w, KIND_TANK).length).toBe(1);
  });
});

describe('the skirmish', () => {
  it('gives both armies the same start: a headquarters, six trucks and a patrol', () => {
    const w = createWorld(1);
    step(w, skirmishCommands(w.map));
    for (let team = 0; team < 2; team++) {
      expect(w.sTeam.filter((t) => t === team).length).toBe(1);
      expect(unitsOf(w, KIND_TRUCK, team).length).toBe(6);
      expect(w.popCap[team]).toBe(60);
      expect(w.pop[team]).toBe(28);
    }
    // A truck sent to the nearest stockpile comes back with a load.
    const before = w.supplies[0];
    run(w, 900, [{ type: CMD_GATHER, units: unitsOf(w, KIND_TRUCK), site: 0 }]);
    expect(w.supplies[0]).toBeGreaterThan(before);
  });
});

describe('hold fire', () => {
  it('keeps the guns silent until the stance is lifted', () => {
    const w = createWorld(3, flatMap());
    step(w, [
      {
        type: CMD_SPAWN,
        count: 4,
        team: 0,
        kind: KIND_TANK,
        x: cell(60),
        y: cell(60),
        radius: 1,
        wander: false,
      },
      {
        type: CMD_SPAWN,
        count: 4,
        team: 1,
        kind: KIND_TRUCK,
        x: cell(64),
        y: cell(60),
        radius: 1,
        wander: false,
      },
    ]);
    const tanks = unitsOf(w, KIND_TANK);
    run(w, 100, [{ type: CMD_STANCE, units: tanks, stance: STANCE_HOLD_FIRE }]);
    expect(w.events.includes(EV_SHOT)).toBe(false);
    expect(unitsOf(w, KIND_TRUCK).length).toBe(4);
    run(w, 200, [{ type: CMD_STANCE, units: tanks, stance: 0 }]);
    expect(unitsOf(w, KIND_TRUCK).length).toBe(0);
  });
});

describe('determinism', () => {
  it('holds with an economy running', () => {
    const play = () => {
      const w = base(4);
      const trucks = unitsOf(w, KIND_TRUCK);
      const s = hq(w);
      const hashes: number[] = [];
      for (let t = 0; t < 1200; t++) {
        const cmds: Command[] = [];
        if (t === 1) cmds.push({ type: CMD_GATHER, units: trucks.slice(0, 2), site: 0 });
        if (t === 2) cmds.push({ type: CMD_GATHER, units: [trucks[2]], site: 1 });
        if (t === 3)
          cmds.push({ type: CMD_BUILD, units: [trucks[3]], building: B_BARRACKS, x: 50, y: 66 });
        if (t === 5) cmds.push({ type: CMD_TRAIN, structure: s, kind: KIND_TRUCK });
        if (t === 900) {
          cmds.push({ type: CMD_TRAIN, structure: w.map.structCount - 1, kind: KIND_INFANTRY });
        }
        step(w, cmds);
        if (t % 50 === 0) hashes.push(hashWorld(w));
      }
      expect(unitsOf(w, KIND_INFANTRY).length).toBe(1);
      return hashes;
    };
    expect(play()).toEqual(play());
  });
});
