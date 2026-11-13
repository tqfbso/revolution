import { describe, expect, it } from 'vitest';
import { aiThink, createAi } from '../src/sim/ai';
import type { Command } from '../src/sim/commands';
import {
  CLASS_FOOT,
  CLASS_VEHICLE,
  MAP_CELLS,
  ROAD_STREET,
  S_BRIDGE,
  S_BUILDING,
  T_FORD,
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

describe('the city map', () => {
  const map = generateMap(1, 'city');
  const goal = map.startY[1] * N + map.startX[1] - 2;

  it('has no river and no bridges to fight over', () => {
    expect(map.type.includes(T_WATER)).toBe(false);
    expect(map.type.includes(T_FORD)).toBe(false);
    for (let s = 0; s < map.structCount; s++) expect(map.sKind[s]).not.toBe(S_BRIDGE);
  });

  it('is a city: nine towns, hundreds of buildings, streets through all of it', () => {
    expect(map.layout).toBe('city');
    expect(map.townCount).toBe(9);
    let buildings = 0;
    for (let s = 0; s < map.structCount; s++) if (map.sKind[s] === S_BUILDING) buildings++;
    expect(buildings).toBeGreaterThan(350);
    let paved = 0;
    for (let c = 0; c < N * N; c++) if (map.road[c] === ROAD_STREET) paved++;
    expect(paved).toBeGreaterThan(6000);
    expect(map.streets.length % 5).toBe(0);
    expect(map.streets.length).toBeGreaterThan(200);
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
    // Towns come in mirrored pairs (west first), then the shared ones on the diagonal.
    for (let t = 0; t < 6; t += 2) {
      expect(map.townX[t]).toBe(map.townY[t + 1]);
      expect(map.townY[t]).toBe(map.townX[t + 1]);
    }
    for (let t = 6; t < 9; t++) expect(map.townX[t]).toBe(map.townY[t]);
    expect(map.siteCount % 2).toBe(0);
  });

  it('lets vehicles and men reach the enemy base and every flag', () => {
    for (const cls of [CLASS_VEHICLE, CLASS_FOOT]) {
      const d = flood(map, cls, () => false);
      expect(d[goal]).toBeGreaterThan(0);
      for (let t = 0; t < map.townCount; t++) {
        const x = Math.trunc(map.townX[t] / 4096);
        const y = Math.trunc(map.townY[t] / 4096);
        let best = -1;
        for (let j = y - 3; j <= y + 3; j++) {
          for (let i = x - 3; i <= x + 3; i++) best = Math.max(best, d[j * N + i]);
        }
        expect(best).toBeGreaterThan(0);
      }
    }
  });

  it('has no single chokepoint: shut any one of three bands across the middle and a way remains', () => {
    // Bands along the diagonal between the armies, measured along it (x + y is constant
    // across the map, x - y runs along the front).
    const band = (lo: number, hi: number) =>
      flood(map, CLASS_VEHICLE, (x, y) => Math.abs(x + y - N) <= 2 && x - y >= lo && x - y <= hi)[
        goal
      ];
    expect(band(-256, -60)).toBeGreaterThan(0);
    expect(band(-60, 60)).toBeGreaterThan(0);
    expect(band(60, 256)).toBeGreaterThan(0);
    expect(map.lanes.length).toBeGreaterThanOrEqual(4);
  });

  it('is the same map every time, and not the ridge', () => {
    expect(generateMap(1, 'city').hash).toBe(map.hash);
    expect(generateMap(1, 'ridge').hash).not.toBe(map.hash);
  });

  it('plays: two AIs set up, grow, take towns and stay deterministic', () => {
    const run = () => {
      const w = createWorld(3, generateMap(3, 'city'));
      const ais = [createAi(0, 'normal', 3), createAi(1, 'normal', 3)];
      let cmds: Command[] = skirmishCommands(w.map);
      for (let t = 0; t < 2400; t++) {
        for (const ai of ais) aiThink(ai, w, cmds);
        step(w, cmds);
        cmds = [];
      }
      let alive = 0;
      for (let i = 0; i < w.count; i++) if (w.state[i] === STATE_ALIVE) alive++;
      return [hashWorld(w), alive];
    };
    const a = run();
    expect(run()).toEqual(a);
    expect(a[1]).toBeGreaterThan(40);
  }, 120_000);
});
