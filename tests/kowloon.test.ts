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
  T_WATER,
  generateMap,
  mapInfo,
  type GameMap,
} from '../src/sim/map';
import { STYLE_HOTEL, STYLE_MALL, STYLE_MOSQUE, STYLE_OFFICE } from '../src/sim/kowloon';
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

describe('Kowloon', () => {
  const map = generateMap(1, 'kowloon');
  const goal = map.startY[1] * N + map.startX[1] - 2;

  it('is on the menu', () => {
    expect(mapInfo('kowloon')?.armies).toBe(2);
  });

  it('is a dense harbour city of towers on the real streets, with room left for bases', () => {
    expect(map.layout).toBe('kowloon');
    expect(map.townCount).toBe(15);
    let buildings = 0;
    let towers = 0;
    const styles = new Map<number, number>();
    for (let s = 0; s < map.structCount; s++) {
      expect(map.sKind[s]).not.toBe(S_BRIDGE);
      if (map.sKind[s] !== S_BUILDING) continue;
      buildings++;
      if (map.sFloors[s] >= 10) towers++;
      styles.set(map.sStyle[s], (styles.get(map.sStyle[s]) ?? 0) + 1);
    }
    const city = generateMap(1, 'city');
    expect(buildings).toBeGreaterThan(city.structCount + 150);
    expect(towers).toBeGreaterThan(100);
    expect(map.structCount).toBeLessThanOrEqual(MAX_STRUCTS);
    // Offices, malls and hotels as well as the tenements, and the one mosque.
    expect(styles.get(STYLE_OFFICE) ?? 0).toBeGreaterThan(30);
    expect(styles.get(STYLE_MALL) ?? 0).toBeGreaterThan(20);
    expect(styles.get(STYLE_HOTEL) ?? 0).toBeGreaterThan(20);
    expect(styles.get(STYLE_MOSQUE)).toBe(1);
    let paved = 0;
    let water = 0;
    for (let c = 0; c < N * N; c++) {
      if (map.road[c] === ROAD_STREET) paved++;
      if (map.type[c] === T_WATER) water++;
    }
    expect(paved).toBeGreaterThan(5000);
    // North up, as on the map: Victoria Harbour along the south, the typhoon shelter west.
    expect(water).toBeGreaterThan(15000);
    expect(map.type[245 * N + 128]).toBe(T_WATER);
    expect(map.type[100 * N + 5]).toBe(T_WATER);
    expect(map.type[20 * N + 128]).not.toBe(T_WATER);
    expect(map.townName[14]).toBe('Kowloon Park');
  });

  it('puts no flag and no resource site on a building', () => {
    const free = (wx: number, wy: number, r: number) => {
      const x = wx >> 12;
      const y = wy >> 12;
      for (let j = y - r; j <= y + r; j++)
        for (let i = x - r; i <= x + r; i++)
          if (map.sKind[map.structAt[j * N + i]] === S_BUILDING && map.structAt[j * N + i] >= 0)
            return false;
      return true;
    };
    for (let t = 0; t < map.townCount; t++) expect(free(map.townX[t], map.townY[t], 1)).toBe(true);
    for (let k = 0; k < map.siteCount; k++) expect(free(map.siteX[k], map.siteY[k], 1)).toBe(true);
  });

  it('has many ways across and no chokepoint', () => {
    for (const cls of [CLASS_VEHICLE, CLASS_FOOT]) {
      expect(flood(map, cls, () => false)[goal]).toBeGreaterThan(0);
    }
    // Count the separate places a vehicle can cross the middle of the map, north to south.
    let ways = 0;
    let open = false;
    for (let y = 2; y < N - 2; y++) {
      const on = map.natural[CLASS_VEHICLE][y * N + 128] !== 0;
      if (on && !open) ways++;
      open = on;
    }
    expect(ways).toBeGreaterThanOrEqual(8);
    // Shut Kowloon Park and the waterfront at once: the streets between still carry a column.
    const d = flood(
      map,
      CLASS_VEHICLE,
      (x, y) => (x >= 96 && x <= 140 && y >= 40 && y <= 112) || y >= 196,
    );
    expect(d[goal]).toBeGreaterThan(0);
    // Shut everything north of Austin Road too: Nathan Road's side streets are enough.
    const e = flood(
      map,
      CLASS_VEHICLE,
      (x, y) => x >= 100 && x <= 150 && ((y >= 40 && y <= 112) || y >= 196 || y <= 36),
    );
    expect(e[goal]).toBeGreaterThan(0);
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

  it('is the same map every time, and not the European city', () => {
    expect(generateMap(1, 'kowloon').hash).toBe(map.hash);
    expect(generateMap(1, 'euro').hash).not.toBe(map.hash);
  });

  it('plays: two AIs set up, grow, take quarters and stay deterministic', () => {
    const run = () => {
      const w = createWorld(3, generateMap(3, 'kowloon'));
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
