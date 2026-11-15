import { describe, expect, it } from 'vitest';
import { aiThink, createAi } from '../src/sim/ai';
import type { Command } from '../src/sim/commands';
import { B_HQ } from '../src/sim/economy';
import {
  CLASS_FOOT,
  CLASS_VEHICLE,
  MAP_CELLS,
  MAX_TEAMS,
  generateMap,
  type GameMap,
} from '../src/sim/map';
import { skirmishCommands } from '../src/sim/scenarios';
import { step } from '../src/sim/sim';
import { STATE_ALIVE, createWorld, hashWorld } from '../src/sim/world';

const N = MAP_CELLS;

/** Steps from the first headquarters for a movement class to every cell; -1 where no way. */
function flood(map: GameMap, cls: number): Int32Array {
  const pass = map.natural[cls];
  const from = map.startY[0] * N + map.startX[0] - 2;
  const d = new Int32Array(N * N).fill(-1);
  const q = [from];
  d[from] = 0;
  for (let h = 0; h < q.length; h++) {
    const c = q[h];
    for (const o of [c + 1, c - 1, c + N, c - N]) {
      if (o < 0 || o >= N * N || Math.abs((o % N) - (c % N)) > 1) continue;
      if (d[o] >= 0 || pass[o] === 0) continue;
      d[o] = d[c] + 1;
      q.push(o);
    }
  }
  return d;
}

describe('free-for-all on the four corners map (decision 124)', () => {
  const map = generateMap(1, 'four');

  it('has a base in each corner, nine flags, and the same to haul for everyone', () => {
    expect(MAX_TEAMS).toBe(4);
    const corners = new Set<number>();
    for (let t = 0; t < 4; t++) {
      expect(map.startX[t]).toBeGreaterThan(0);
      corners.add((map.startX[t] < N / 2 ? 0 : 1) + (map.startY[t] < N / 2 ? 0 : 2));
    }
    expect(corners.size).toBe(4);
    expect(map.townCount).toBe(9);
    // Sites within reach of each base: as many for one army as for another.
    const near = [0, 0, 0, 0];
    for (let k = 0; k < map.siteCount; k++) {
      for (let t = 0; t < 4; t++) {
        const dx = (map.siteX[k] >> 12) - map.startX[t];
        const dy = (map.siteY[k] >> 12) - map.startY[t];
        if (dx * dx + dy * dy < 60 * 60) near[t]++;
      }
    }
    expect(near[0]).toBeGreaterThanOrEqual(6);
    expect(new Set(near).size).toBe(1);
  });

  it('lets vehicles and men reach every base and every flag', () => {
    for (const cls of [CLASS_VEHICLE, CLASS_FOOT]) {
      const d = flood(map, cls);
      for (let t = 1; t < 4; t++) {
        expect(d[map.startY[t] * N + map.startX[t] - 2]).toBeGreaterThan(0);
      }
      for (let t = 0; t < map.townCount; t++) {
        const x = map.townX[t] >> 12;
        const y = map.townY[t] >> 12;
        let best = -1;
        for (let j = y - 3; j <= y + 3; j++) {
          for (let i = x - 3; i <= x + 3; i++) best = Math.max(best, d[j * N + i]);
        }
        expect(best).toBeGreaterThan(0);
      }
    }
  });

  it('sets up as many armies as asked for, and two on a map with two bases', () => {
    const hqs = (w: ReturnType<typeof createWorld>): number[] => {
      const n = [0, 0, 0, 0];
      for (let s = 0; s < w.map.structCount; s++) {
        if (w.sType[s] === B_HQ && w.sTeam[s] < 4) n[w.sTeam[s]]++;
      }
      return n;
    };
    for (const armies of [2, 3, 4]) {
      const w = createWorld(1, generateMap(1, 'four'));
      step(w, skirmishCommands(w.map, armies));
      expect(hqs(w)).toEqual([1, 1, armies > 2 ? 1 : 0, armies > 3 ? 1 : 0]);
    }
    const ridge = createWorld(1, generateMap(1, 'ridge'));
    step(ridge, skirmishCommands(ridge.map, 4));
    expect(hqs(ridge)).toEqual([1, 1, 0, 0]);
  });

  it('four computers each go for a different army, fight, and stay deterministic', () => {
    const run = (): { hash: number; enemies: number[]; alive: number[] } => {
      const w = createWorld(3, generateMap(3, 'four'));
      const ais = [0, 1, 2, 3].map((t) => createAi(t, 'hard', 3));
      let cmds: Command[] = skirmishCommands(w.map, 4);
      for (let tick = 0; tick < 2400; tick++) {
        for (const ai of ais) aiThink(ai, w, cmds);
        step(w, cmds);
        cmds = [];
        w.events.length = 0;
      }
      const alive = [0, 0, 0, 0];
      for (let i = 0; i < w.count; i++) if (w.state[i] === STATE_ALIVE) alive[w.team[i]]++;
      return { hash: hashWorld(w), enemies: ais.map((a) => a.enemy), alive };
    };
    const a = run();
    expect(a.enemies).toEqual([3, 0, 1, 2]);
    for (const n of a.alive) expect(n).toBeGreaterThan(30);
    expect(run().hash).toBe(a.hash);
  });
});
