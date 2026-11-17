// Decision 147: men on foot keep out of the open under enemy armour and gunships. Into the
// nearest house, from house to house, apart from each other where there is no house; and a
// retreat under those guns does not run across the open either. Normal and Hard only.
import { describe, expect, it } from 'vitest';
import { createAi, fallBack, perceive, takeCover, type AiLevel } from '../src/sim/ai';
import { CMD_GARRISON, CMD_MOVE, CMD_SPAWN, type Command } from '../src/sim/commands';
import { fx } from '../src/sim/fixed';
import { CELL_SHIFT, MAP_CELLS, S_BUILDING, generateMap } from '../src/sim/map';
import { step } from '../src/sim/sim';
import { KIND_ATGM, KIND_HELI, KIND_INFANTRY, KIND_TANK } from '../src/sim/units';
import { TICK_RATE, createWorld, type World } from '../src/sim/world';

const spawn = (
  team: number,
  kind: number,
  count: number,
  x: number,
  y: number,
  r = 3,
): Command => ({
  type: CMD_SPAWN,
  count,
  team,
  kind,
  x: fx(x),
  y: fx(y),
  radius: fx(r),
  wander: false,
});

function add(w: World, cmd: Command): number[] {
  const from = w.count;
  step(w, [cmd]);
  const ids: number[] = [];
  for (let i = from; i < w.count; i++) ids.push(i);
  return ids;
}

/** Squads and missile teams in a street of the city, an enemy `gun` just up the road. */
function street(level: AiLevel, gun: number) {
  const w = createWorld(3, generateMap(3, 'city'));
  const map = w.map;
  const t = map.townName.indexOf('West End');
  // A street cell of the town with houses on both sides of it.
  let x = 0;
  let y = 0;
  const cx = map.townX[t] >> CELL_SHIFT;
  const cy = map.townY[t] >> CELL_SHIFT;
  search: for (let r = 0; r < 12; r++) {
    for (let gy = cy - r; gy <= cy + r; gy++) {
      for (let gx = cx - r; gx <= cx + r; gx++) {
        if (map.structAt[gy * MAP_CELLS + gx] >= 0) continue;
        const near = new Set<number>();
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const s = map.structAt[(gy + dy) * MAP_CELLS + gx + dx];
            if (s >= 0 && map.sKind[s] === S_BUILDING) near.add(s);
          }
        }
        if (near.size < 3) continue;
        x = gx * 4 + 2;
        y = gy * 4 + 2;
        break search;
      }
    }
  }
  expect(x).toBeGreaterThan(0);
  const squads = add(w, spawn(0, KIND_INFANTRY, 6, x, y));
  const teams = add(w, spawn(0, KIND_ATGM, 2, x, y));
  const foe = add(w, spawn(1, gun, 1, x + 14, y));
  const ai = createAi(0, level, 3);
  perceive(ai, w);
  return { w, ai, squads, teams, foe, x: fx(x), y: fx(y) };
}

const ordered = (out: Command[], type: number) =>
  out.flatMap((c) => (c.type === type && 'units' in c ? c.units : []));

describe('cover from armour and gunships', () => {
  it('squads under a tank gun go into the houses beside them; missile teams stay to hunt it', () => {
    const { w, ai, squads, teams, foe, x, y } = street('hard', KIND_TANK);
    expect(ai.seen.length).toBe(1);
    const out: Command[] = [];
    const held = takeCover(ai, w, out, [...squads, ...teams], x + fx(60), y);
    const going = ordered(out, CMD_GARRISON);
    expect(going.length).toBeGreaterThanOrEqual(3);
    for (const i of going) expect(squads).toContain(i);
    for (const i of going) expect(held.has(i)).toBe(true);
    for (const i of teams) expect(held.has(i)).toBe(false);
    // They do go in, and stay in while the tank is there.
    step(w, out);
    for (let k = 0; k < 8 * TICK_RATE; k++) step(w, []);
    const inside = squads.filter((i) => w.inside[i] >= 0);
    expect(inside.length).toBeGreaterThanOrEqual(3);
    perceive(ai, w);
    const again: Command[] = [];
    const still = takeCover(ai, w, again, squads, x + fx(60), y);
    for (const i of inside) {
      // (While the tank is still within reach of them and has not shot the house to bits.)
      const d = Math.hypot(w.posX[i] - w.posX[foe[0]], w.posY[i] - w.posY[foe[0]]);
      const s = w.inside[i];
      if (d < fx(34) && w.sHp[s] * 3 >= w.map.sMaxHp[s]) expect(still.has(i)).toBe(true);
    }
    expect(ordered(again, CMD_GARRISON).filter((i) => inside.includes(i))).toEqual([]);
  });

  it('after a while in a house they bound to the next one nearer the objective', () => {
    const { w, ai, squads, foe, x, y } = street('hard', KIND_TANK);
    const out: Command[] = [];
    takeCover(ai, w, out, squads, x + fx(60), y);
    step(w, out);
    for (let k = 0; k < 25 * TICK_RATE; k++) step(w, []);
    const inside = squads.filter((i) => w.inside[i] >= 0);
    expect(inside.length).toBeGreaterThan(0);
    const before = new Map(inside.map((i) => [i, w.inside[i]]));
    perceive(ai, w);
    const next: Command[] = [];
    takeCover(ai, w, next, squads, x + fx(60), y);
    const moves = next.filter((c) => c.type === CMD_GARRISON);
    for (const c of moves) {
      if (c.type !== CMD_GARRISON) continue;
      expect(w.map.sKind[c.structure]).toBe(S_BUILDING);
      for (const i of c.units) expect(c.structure).not.toBe(before.get(i));
    }
    // Whoever found no house ahead goes on in the open for a while: nobody sits for good.
    const bound = new Set(ordered(next, CMD_GARRISON));
    let asked = 0;
    for (const i of inside) {
      // (Only those the tank still threatens: it has not stood still either.)
      if (Math.hypot(w.posX[i] - w.posX[foe[0]], w.posY[i] - w.posY[foe[0]]) >= fx(34)) continue;
      asked++;
      expect(bound.has(i) || ai.dash[i] > w.tick).toBe(true);
    }
    expect(asked).toBeGreaterThan(0);
  });

  it('a gunship sends the missile teams indoors too, and nobody leaves while it is there', () => {
    const { w, ai, squads, teams, x, y } = street('hard', KIND_HELI);
    const out: Command[] = [];
    const all = [...squads, ...teams];
    takeCover(ai, w, out, all, x + fx(60), y);
    const going = ordered(out, CMD_GARRISON);
    expect(teams.some((i) => going.includes(i))).toBe(true);
    step(w, out);
    for (let k = 0; k < 40 * TICK_RATE; k++) {
      // (The gunship is held where it is: left alone it would fly off after them.)
      step(w, []);
    }
    perceive(ai, w);
    if (ai.seen.length === 0) return;
    const inside = all.filter((i) => w.inside[i] >= 0 && w.state[i] === 1);
    const back: Command[] = [];
    fallBack(ai, w, back, all, x - fx(200), y);
    const sent = ordered(back, CMD_MOVE);
    for (const i of inside) {
      const d = Math.hypot(w.posX[i] - w.posX[ai.seen[0]], w.posY[i] - w.posY[ai.seen[0]]);
      if (d < fx(40)) expect(sent).not.toContain(i);
    }
  });

  it('Easy and Recruit do not know the drill', () => {
    for (const level of ['easy', 'recruit'] as const) {
      const { w, ai, squads, teams, x, y } = street(level, KIND_TANK);
      const out: Command[] = [];
      const held = takeCover(ai, w, out, [...squads, ...teams], x + fx(60), y);
      expect(out).toEqual([]);
      expect(held.size).toBe(0);
    }
  });

  it('with no house in reach, squads standing in a bunch step apart', () => {
    const w = createWorld(3, generateMap(3, 'ridge'));
    // Open country between the base and the first town.
    const squads = add(w, spawn(0, KIND_INFANTRY, 8, 215, 800, 2));
    add(w, spawn(1, KIND_TANK, 1, 240, 800));
    const ai = createAi(0, 'hard', 3);
    const gap = () => {
      let least = Infinity;
      for (const a of squads) {
        for (const b of squads) {
          if (a < b)
            least = Math.min(least, Math.hypot(w.posX[a] - w.posX[b], w.posY[a] - w.posY[b]));
        }
      }
      return least / fx(1);
    };
    const before = gap();
    expect(before).toBeLessThan(3.5);
    let stepped = 0;
    for (let k = 0; k < 6 * TICK_RATE; k++) {
      const out: Command[] = [];
      if (k % 20 === 0) {
        perceive(ai, w);
        takeCover(ai, w, out, squads, fx(300), fx(800));
        expect(ordered(out, CMD_GARRISON)).toEqual([]);
        stepped += ordered(out, CMD_MOVE).length;
      }
      // (Frozen in place otherwise: this is about the step aside, not the fight.)
      step(w, out);
    }
    expect(stepped).toBeGreaterThan(0);
    const alive = squads.filter((i) => w.state[i] === 1);
    expect(alive.length).toBeGreaterThan(0);
    expect(gap()).toBeGreaterThan(before);
  });
});
