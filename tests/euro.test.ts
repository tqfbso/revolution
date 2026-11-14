import { describe, expect, it } from 'vitest';
import { aiThink, createAi } from '../src/sim/ai';
import { CIVILIANS } from '../src/sim/civilians';
import type { Command } from '../src/sim/commands';
import {
  CLASS_FOOT,
  CLASS_VEHICLE,
  MAP_CELLS,
  MAX_STRUCTS,
  ROAD_STREET,
  S_BRIDGE,
  S_BUILDING,
  T_CLIFF,
  T_WATER,
  generateMap,
  type GameMap,
} from '../src/sim/map';
import { skirmishCommands } from '../src/sim/scenarios';
import { step } from '../src/sim/sim';
import { STATE_ALIVE, createWorld, hashWorld } from '../src/sim/world';

const N = MAP_CELLS;

/** Steps from the west headquarters for a movement class to every cell; -1 where there is no way. */
function flood(map: GameMap, cls: number, shut: (x: number, y: number) => boolean): Int32Array {
  const pass = map.natural[cls];
  const from = map.startY[0] * N + map.startX[0] - 2;
  const d = new Int32Array(N * N).fill(-1);
  const q = [from];
  d[from] = 0;
  for (let h = 0; h < q.length; h++) {
    const c = q[h];
    const x = c % N;
    const y = Math.trunc(c / N);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
      const o = ny * N + nx;
      if (d[o] >= 0 || pass[o] === 0 || shut(nx, ny)) continue;
      d[o] = d[c] + 1;
      q.push(o);
    }
  }
  return d;
}

describe('the European city', () => {
  const map = generateMap(1, 'euro');
  const goal = map.startY[1] * N + map.startX[1] - 2;
  const bridges: number[] = [];
  for (let s = 0; s < map.structCount; s++) if (map.sKind[s] === S_BRIDGE) bridges.push(s);
  const onBridge = (x: number, y: number) => {
    const s = map.structAt[y * N + x];
    return s >= 0 && map.sKind[s] === S_BRIDGE;
  };

  it('is one dense city on a river: more houses than the city map, room left for bases', () => {
    expect(map.layout).toBe('euro');
    expect(map.townCount).toBe(13);
    let buildings = 0;
    for (let s = 0; s < map.structCount; s++) if (map.sKind[s] === S_BUILDING) buildings++;
    const city = generateMap(1, 'city');
    expect(buildings).toBeGreaterThan(city.structCount + 150);
    expect(map.structCount).toBeLessThanOrEqual(MAX_STRUCTS - 250);
    let paved = 0;
    let water = 0;
    for (let c = 0; c < N * N; c++) {
      if (map.road[c] === ROAD_STREET) paved++;
      if (map.type[c] === T_WATER) water++;
    }
    expect(paved).toBeGreaterThan(9000);
    expect(water).toBeGreaterThan(1200);
    expect(map.streets.length % 5).toBe(0);
  });

  it('is the mirror image of itself, so neither army has the better ground', () => {
    expect([map.startX[1], map.startY[1]]).toEqual([map.startY[0], map.startX[0]]);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < y; x++) {
        expect(map.road[y * N + x]).toBe(map.road[x * N + y]);
        expect(map.type[y * N + x]).toBe(map.type[x * N + y]);
        expect(map.structAt[y * N + x] >= 0).toBe(map.structAt[x * N + y] >= 0);
      }
    }
    for (let t = 0; t < 12; t += 2) {
      expect(map.townX[t]).toBe(map.townY[t + 1]);
      expect(map.townY[t]).toBe(map.townX[t + 1]);
    }
    expect(map.townX[12]).toBe(map.townY[12]);
    for (let k = 0; k < map.siteCount; k += 2) {
      expect(map.siteX[k]).toBe(map.siteY[k + 1]);
      expect(map.siteStock[k]).toBe(map.siteStock[k + 1]);
    }
  });

  it('has four bridges, and three crossings that no gun can cut', () => {
    expect(bridges.length).toBe(4);
    // The river parts the map: with every crossing shut there is no way over.
    const sealed = flood(map, CLASS_FOOT, (x, y) => Math.abs(x - y) <= 12);
    expect(sealed[goal]).toBe(-1);
    for (const cls of [CLASS_VEHICLE, CLASS_FOOT]) {
      expect(flood(map, cls, () => false)[goal]).toBeGreaterThan(0);
      // Every bridge down: the culverts still carry vehicles and men across.
      expect(flood(map, cls, onBridge)[goal]).toBeGreaterThan(0);
      // And any one of the three culverts alone will do.
      for (const open of [32, 128, 224]) {
        const d = flood(
          map,
          cls,
          (x, y) => onBridge(x, y) || (Math.abs(x - y) <= 4 && Math.abs(x - open) > 12),
        );
        expect(d[goal]).toBeGreaterThan(0);
      }
    }
    expect(map.lanes.length).toBe(7);
  });

  it('lets vehicles and men reach every flag and every resource site', () => {
    for (const cls of [CLASS_VEHICLE, CLASS_FOOT]) {
      const d = flood(map, cls, () => false);
      const near = (wx: number, wy: number) => {
        const x = wx >> 12;
        const y = wy >> 12;
        let best = -1;
        for (let j = y - 3; j <= y + 3; j++) {
          for (let i = x - 3; i <= x + 3; i++) best = Math.max(best, d[j * N + i]);
        }
        return best;
      };
      for (let t = 0; t < map.townCount; t++)
        expect(near(map.townX[t], map.townY[t])).toBeGreaterThan(0);
      for (let k = 0; k < map.siteCount; k++)
        expect(near(map.siteX[k], map.siteY[k])).toBeGreaterThan(0);
    }
  });

  it('has a motorway nobody crosses except by its underpasses', () => {
    expect(map.decks.length).toBe(10);
    let cliff = 0;
    for (let y = 120; y < 196; y++) if (map.type[y * N + 104] === T_CLIFF) cliff++;
    expect(cliff).toBeGreaterThan(50);
    for (const y of [140, 152, 176, 188])
      expect(map.natural[CLASS_VEHICLE][y * N + 104]).not.toBe(0);
    for (const y of [128, 164]) expect(map.natural[CLASS_FOOT][y * N + 104]).toBe(0);
  });

  it('is the same map every time, and not the city', () => {
    expect(generateMap(1, 'euro').hash).toBe(map.hash);
    expect(generateMap(1, 'city').hash).not.toBe(map.hash);
  });

  it('plays: two AIs set up, grow, take quarters and stay deterministic', () => {
    const run = () => {
      const w = createWorld(3, generateMap(3, 'euro'));
      const ais = [createAi(0, 'normal', 3), createAi(1, 'normal', 3)];
      let cmds: Command[] = skirmishCommands(w.map);
      for (let t = 0; t < 2400; t++) {
        for (const ai of ais) aiThink(ai, w, cmds);
        step(w, cmds);
        cmds = [];
      }
      let alive = 0;
      for (let i = 0; i < w.count; i++) if (w.state[i] === STATE_ALIVE) alive++;
      return [hashWorld(w), alive, w.civCount];
    };
    const a = run();
    expect(run()).toEqual(a);
    expect(a[1]).toBeGreaterThan(40);
    expect(a[2]).toBe(CIVILIANS);
  }, 120_000);
});
