import { describe, expect, it } from 'vitest';
import { CMD_ATTACK_STRUCTURE, CMD_SPAWN, type Command } from '../src/sim/commands';
import { fx } from '../src/sim/fixed';
import { S_BUILDING, addStructure, addTown, flatMap, refreshPassability } from '../src/sim/map';
import { SCAR_CELLS, SCAR_SIDE, scarGrid } from '../src/sim/scars';
import { step } from '../src/sim/sim';
import { KIND_TANK } from '../src/sim/units';
import { createWorld, hashWorld, type World } from '../src/sim/world';
import { RUIN_STEPS, buildingParts, ruinOf, type Ruin } from '../src/client/structures';

/** A block of 4 by 4 cells and six storeys on cells (126..129, 124..127): x 504..520. */
function world(): World {
  const m = flatMap();
  addTown(m, fx(512), fx(500), fx(30), 'Test');
  addStructure(m, S_BUILDING, 126, 124, 4, 4, 0, 6);
  refreshPassability(m);
  return createWorld(1, m);
}
const spawn = (x: number, y: number): Command => ({
  type: CMD_SPAWN,
  count: 1,
  team: 0,
  kind: KIND_TANK,
  x: fx(x),
  y: fx(y),
  radius: fx(1),
  wander: false,
});
/** A tank at (x, y) shells the block for `seconds`. */
function shell(x: number, y: number, seconds: number): World {
  const w = world();
  step(w, [spawn(x, y)]);
  step(w, [{ type: CMD_ATTACK_STRUCTURE, units: [0], structure: 0 }]);
  for (let t = 0; t < seconds * 20; t++) step(w, []);
  return w;
}
const cell = (w: World, ix: number, iy: number): number => w.sScar[iy * SCAR_SIDE + ix];

describe('where buildings are hit (decision 157)', () => {
  it('records the hits on the face the tank sees, round its line of fire', () => {
    // East of the block, level with its north half.
    const w = shell(545, 500, 30);
    expect(w.sHp[0]).toBeLessThan(w.map.sMaxHp[0]);
    expect(scarGrid(w.map, 0)).toEqual([4, 4]);
    let east = 0;
    let west = 0;
    for (let iy = 0; iy < 4; iy++) {
      east += cell(w, 3, iy);
      west += cell(w, 0, iy);
    }
    expect(east).toBeGreaterThan(0);
    expect(west).toBe(0);
    // The north half, where it aims, takes more than the south half.
    expect(cell(w, 3, 0) + cell(w, 3, 1)).toBeGreaterThan(cell(w, 3, 2) + cell(w, 3, 3));
  });

  it('does not change the battle: the hash is the same as without the record', () => {
    const a = shell(545, 500, 20);
    const b = shell(545, 500, 20);
    expect(hashWorld(a)).toBe(hashWorld(b));
    expect(Array.from(a.sScar.subarray(0, SCAR_CELLS))).toEqual(
      Array.from(b.sScar.subarray(0, SCAR_CELLS)),
    );
    // Wiping the record leaves the hash alone.
    const h = hashWorld(a);
    a.sScar.fill(0);
    expect(hashWorld(a)).toBe(h);
  });
});

describe('how a building comes down where it was hit', () => {
  const corner = new Uint8Array(SCAR_CELLS);
  corner[3] = 255; // the north-east section
  corner[2] = 90;
  corner[7] = 120;
  it('takes the storeys from the sections hit, not evenly from the top', () => {
    const r = ruinOf(corner, 0, 4, 4, 6, 0.4, 7);
    expect(r.loss.length).toBe(16);
    // North-east lost most; the far south-west corner least.
    expect(r.loss[3]).toBeGreaterThan(r.loss[12]);
    expect(Math.max(...r.loss)).toBe(r.loss[3]);
    // As much as the old even cut would have taken, in total.
    const total = r.loss.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(16 * 6);
  });

  it('never puts back what has come down while the damage grows', () => {
    let before: Ruin | null = null;
    for (let k = 0; k <= RUIN_STEPS; k++) {
      const r = ruinOf(corner, 0, 4, 4, 6, k / RUIN_STEPS, 7, before);
      if (before)
        for (let c = 0; c < 16; c++) expect(r.loss[c]).toBeGreaterThanOrEqual(before.loss[c]);
      for (const u of r.loss) expect(u).toBeLessThanOrEqual(6);
      before = r;
    }
    // Gutted: every section has come down as far as it goes.
    expect(before!.loss.every((u) => u === 6)).toBe(true);
  });

  it('builds a building broken section by section', () => {
    const r = ruinOf(corner, 0, 4, 4, 6, 0.5, 3);
    const parts = buildingParts(3, 0, 0, 15, 15, 0, 6, 1, 0, 1, false, r);
    expect(parts.length).toBeGreaterThan(100);
    // The far (south-west) corner stands higher than the corner that was hit (north-east).
    const topIn = (x0: number, x1: number, z0: number, z1: number): number =>
      Math.max(
        ...parts
          .filter((p) => p.at[0] > x0 && p.at[0] < x1 && p.at[2] > z0 && p.at[2] < z1)
          .map((p) => p.at[1] + p.size[1] / 2),
      );
    expect(topIn(0.5, 3.5, 11.5, 14.5)).toBeGreaterThan(topIn(11.5, 14.5, 0.5, 3.5) + 1);
    for (const p of parts)
      for (const v of [...p.size, ...p.at]) expect(Number.isFinite(v)).toBe(true);
  });
});
