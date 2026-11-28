import { describe, expect, it } from 'vitest';
import { CMD_FACTION, CMD_MOVE, CMD_SPAWN, type Command } from '../src/sim/commands';
import { FACTION_CHINA, FACTION_NATO, FACTION_REBEL, FACTION_RUSSIA } from '../src/sim/factions';
import { fx } from '../src/sim/fixed';
import { MAP_CELLS, ROAD_STREET, flatMap, refreshPassability } from '../src/sim/map';
import { ROAD_PCT, ROAD_TRACKED_PCT, ROAD_WHEELED_PCT, wheeled } from '../src/sim/roads';
import { step } from '../src/sim/sim';
import {
  KIND_AD,
  KIND_ARTILLERY,
  KIND_HELI,
  KIND_IFV,
  KIND_INFANTRY,
  KIND_TANK,
  KIND_TRUCK,
} from '../src/sim/units';
import { STATE_ALIVE, createWorld, type World } from '../src/sim/world';

/** An empty map with a straight road along y = 400 (cells 99 and 100). */
function roadMap() {
  const m = flatMap();
  for (let x = 0; x < MAP_CELLS; x++) {
    m.road[99 * MAP_CELLS + x] = ROAD_STREET;
    m.road[100 * MAP_CELLS + x] = ROAD_STREET;
  }
  refreshPassability(m);
  return m;
}

const run = (w: World, ticks: number, first: Command[] = []) => {
  step(w, first);
  for (let t = 1; t < ticks; t++) step(w, []);
};

/** How far a lone unit of `kind` drives east in three seconds, from (300, y). */
function drive(faction: number, kind: number, y: number): number {
  const w = createWorld(1, roadMap());
  run(w, 2, [
    { type: CMD_FACTION, team: 0, faction },
    {
      type: CMD_SPAWN,
      count: 1,
      team: 0,
      kind,
      x: fx(300),
      y: fx(y),
      radius: fx(0.5),
      wander: false,
    },
  ]);
  let id = -1;
  for (let i = 0; i < w.count; i++) if (w.state[i] === STATE_ALIVE && w.kind[i] === kind) id = i;
  // Pointed the right way first, so the hull's turn does not cost the first second.
  run(w, 40, [{ type: CMD_MOVE, units: [id], x: fx(320), y: w.posY[id] }]);
  const from = w.posX[id];
  run(w, 60, [{ type: CMD_MOVE, units: [id], x: fx(900), y: w.posY[id] }]);
  return (w.posX[id] - from) / w.speed[id];
}

describe('road speed (decision 165)', () => {
  it('wheels gain 30% on a road, tracks 15%, men on foot nothing', () => {
    const gain = (f: number, k: number) => drive(f, k, 401) / drive(f, k, 600);
    expect(gain(FACTION_NATO, KIND_TRUCK)).toBeCloseTo(1.3, 1);
    expect(gain(FACTION_NATO, KIND_TANK)).toBeCloseTo(1.15, 1);
    expect(gain(FACTION_CHINA, KIND_IFV)).toBeCloseTo(1.3, 1);
    expect(gain(FACTION_REBEL, KIND_IFV)).toBeCloseTo(1.3, 1);
    expect(gain(FACTION_NATO, KIND_INFANTRY)).toBeCloseTo(1, 2);
  });

  it('knows which armies drive what on wheels', () => {
    expect(wheeled(FACTION_NATO, KIND_IFV)).toBe(false); // a tracked carrier
    expect(wheeled(FACTION_RUSSIA, KIND_IFV)).toBe(false);
    expect(wheeled(FACTION_CHINA, KIND_IFV)).toBe(true);
    expect(wheeled(FACTION_CHINA, KIND_ARTILLERY)).toBe(true); // the truck gun
    expect(wheeled(FACTION_RUSSIA, KIND_AD)).toBe(true); // on a lorry
    expect(wheeled(FACTION_REBEL, KIND_TANK)).toBe(false); // captured, still a tank
    expect(ROAD_PCT[FACTION_REBEL][KIND_ARTILLERY]).toBe(ROAD_WHEELED_PCT);
    expect(ROAD_PCT[FACTION_NATO][KIND_TANK]).toBe(ROAD_TRACKED_PCT);
    expect(ROAD_PCT[FACTION_NATO][KIND_HELI]).toBe(0);
    expect(ROAD_PCT[FACTION_NATO][KIND_INFANTRY]).toBe(0);
  });
});
