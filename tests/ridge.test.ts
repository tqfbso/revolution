import { describe, expect, it } from 'vitest';
import { aiThink, createAi } from '../src/sim/ai';
import type { Command } from '../src/sim/commands';
import {
  CLASS_FOOT,
  CLASS_VEHICLE,
  MAP_CELLS,
  SITE_FUEL,
  S_BRIDGE,
  T_FORD,
  T_WATER,
  generateMap,
  type GameMap,
} from '../src/sim/map';
import { skirmishCommands } from '../src/sim/scenarios';
import { step } from '../src/sim/sim';
import { STATE_ALIVE, createWorld, hashWorld } from '../src/sim/world';

const N = MAP_CELLS;
const A = (x: number, y: number) => (x + y) * 4 - 1024;

/**
 * Steps from the west headquarters to the east one for a movement class, never stepping
 * on a cell of the diagonal between the armies for which `shut` holds. -1: no way.
 */
function way(map: GameMap, cls: number, shut: (a: number) => boolean): number {
  const pass = map.natural[cls];
  const from = map.startY[0] * N + map.startX[0] - 2;
  const goal = map.startY[1] * N + map.startX[1] - 2;
  const d = new Int32Array(N * N).fill(-1);
  const q = [from];
  d[from] = 0;
  for (let h = 0; h < q.length; h++) {
    const c = q[h];
    if (c === goal) return d[c];
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
      if (d[o] >= 0 || pass[o] === 0) continue;
      if (Math.abs(nx - ny) <= 1 && shut(A(nx, ny))) continue;
      d[o] = d[c] + 1;
      q.push(o);
    }
  }
  return -1;
}

describe('the ridge map', () => {
  const map = generateMap(1, 'ridge');

  it('has no river, no fords and no bridges', () => {
    expect(map.type.includes(T_WATER)).toBe(false);
    expect(map.type.includes(T_FORD)).toBe(false);
    for (let s = 0; s < map.structCount; s++) expect(map.sKind[s]).not.toBe(S_BRIDGE);
  });

  it('is the mirror image of itself, so neither army has the better ground', () => {
    const V = N + 1;
    for (let y = 0; y < V; y += 3) {
      for (let x = 0; x < y; x += 3) {
        // The town on the ridge is levelled plot by plot and is not mirrored.
        if (Math.abs(x - 130) < 16 && Math.abs(y - 130) < 16) continue;
        expect(map.heights[y * V + x]).toBe(map.heights[x * V + y]);
      }
    }
    expect([map.startX[1], map.startY[1]]).toEqual([map.startY[0], map.startX[0]]);
    // Towns come in mirrored pairs, then the one in the middle.
    expect(map.townCount).toBe(7);
    for (let t = 0; t < 6; t += 2) {
      expect(map.townX[t]).toBe(map.townY[t + 1]);
      expect(map.townY[t]).toBe(map.townX[t + 1]);
    }
    const fuel = [0, 0];
    for (let k = 0; k < map.siteCount; k++) {
      if (map.siteKind[k] !== SITE_FUEL || map.siteX[k] === map.siteY[k]) continue;
      fuel[map.siteX[k] < map.siteY[k] ? 0 : 1]++;
    }
    expect(fuel[0]).toBe(fuel[1]);
    expect(map.siteCount).toBe(22);
  });

  it('offers vehicles four separate ways across, and men the whole forest', () => {
    const open = way(map, CLASS_VEHICLE, () => false);
    expect(open).toBeGreaterThan(0);
    // Each way alone still connects the two bases.
    const only = (lo: number, hi: number) => way(map, CLASS_VEHICLE, (a) => a < lo || a > hi);
    expect(only(-440, -380)).toBeGreaterThan(open); // the forest track
    expect(only(-217, -193)).toBeGreaterThan(0); // the ravine floor
    expect(only(-20, 60)).toBeGreaterThan(0); // the road over the ridge, by its ramps
    expect(only(260, 1024)).toBeGreaterThan(0); // the farmland
    // The forest beyond the tracks stops vehicles and lets infantry through.
    expect(only(-700, -600)).toBe(-1);
    expect(way(map, CLASS_FOOT, (a) => a < -700 || a > -600)).toBeGreaterThan(0);
    expect(map.lanes.length).toBe(4);
  });

  it('is the same map every time, and a different one from the river', () => {
    expect(generateMap(1, 'ridge').hash).toBe(map.hash);
    expect(generateMap(1).hash).not.toBe(map.hash);
    expect(generateMap(1).lanes.length).toBe(0);
  });

  it('plays: two AIs set up, grow and stay deterministic', () => {
    const run = () => {
      const w = createWorld(3, generateMap(3, 'ridge'));
      const ais = [createAi(0, 'normal', 3), createAi(1, 'normal', 3)];
      let cmds: Command[] = skirmishCommands(w.map);
      for (let t = 0; t < 2400; t++) {
        for (const ai of ais) aiThink(ai, w, cmds);
        step(w, cmds);
        cmds = [];
        w.events.length = 0;
      }
      return w;
    };
    const w = run();
    const alive = [0, 0];
    for (let i = 0; i < w.count; i++) if (w.state[i] === STATE_ALIVE) alive[w.team[i]]++;
    expect(alive[0]).toBeGreaterThan(30);
    expect(alive[1]).toBeGreaterThan(30);
    expect(hashWorld(run())).toBe(hashWorld(w));
  });
});
