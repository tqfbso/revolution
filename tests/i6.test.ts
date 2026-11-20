// I6 (decision 155): mortar teams, squads on roofs, ambushes.
import { describe, expect, it } from 'vitest';
import {
  CMD_AMBUSH,
  CMD_GARRISON,
  CMD_MOVE,
  CMD_ROOF,
  CMD_SPAWN,
  CMD_STANCE,
  type Command,
} from '../src/sim/commands';
import { fx } from '../src/sim/fixed';
import { S_BUILDING, addStructure, addTown, flatMap, refreshPassability } from '../src/sim/map';
import { onRoof } from '../src/sim/ambush';
import { concealed, step } from '../src/sim/sim';
import {
  KINDS,
  KIND_ATGM,
  KIND_INFANTRY,
  KIND_MORTAR,
  KIND_RECON,
  KIND_TANK,
  ROOF_RANGE_BONUS,
} from '../src/sim/units';
import { UNIT_PRICE } from '../src/sim/economy';
import { FACTIONS } from '../src/sim/factions';
import {
  EV_AMBUSH,
  EV_LAUNCH,
  EV_SHOT,
  STANCE_AMBUSH,
  STANCE_FREE,
  STANCE_HOLD_FIRE,
  STATE_ALIVE,
  createWorld,
  type World,
} from '../src/sim/world';

const spawnAt = (team: number, kind: number, x: number, y: number): Command => ({
  type: CMD_SPAWN,
  count: 1,
  team,
  kind,
  x: fx(x),
  y: fx(y),
  radius: fx(1),
  wander: false,
});
const put = (w: World, i: number, x: number, y: number) => {
  w.posX[i] = w.targetX[i] = fx(x);
  w.posY[i] = w.targetY[i] = fx(y);
};
/** A three by three house of `floors` storeys on cells (126..128, 124..126): x 504..516. */
function town(floors = 3): World {
  const m = flatMap();
  addTown(m, fx(510), fx(502), fx(30), 'Test');
  addStructure(m, S_BUILDING, 126, 124, 3, 3, 0, floors);
  refreshPassability(m);
  return createWorld(3, m);
}
function run(w: World, ticks: number, each?: (w: World) => void): void {
  for (let t = 0; t < ticks; t++) {
    w.events.length = 0;
    step(w, []);
    each?.(w);
  }
}
const events = (w: World, type: number): number[][] => {
  const out: number[][] = [];
  for (let e = 0; e < w.events.length; e += 3) {
    if (w.events[e] === type) out.push([w.events[e + 1], w.events[e + 2]]);
  }
  return out;
};

describe('the mortar team', () => {
  it('is a cheap kind of infantry every army has, built at the barracks', () => {
    expect(KINDS[KIND_MORTAR].indirect).toBe(true);
    expect(KINDS[KIND_MORTAR].garrison).toBe(true);
    for (const f of FACTIONS) expect(f.roster[KIND_MORTAR]).toBe(true);
    const p = UNIT_PRICE[KIND_MORTAR];
    expect(p.from).toBe(UNIT_PRICE[KIND_INFANTRY].from);
    expect(p.tier).toBe(1);
    expect(p.supplies + p.credits).toBeLessThan(UNIT_PRICE[KIND_ATGM].supplies * 2);
  });

  it('bombs men a friend has spotted, out of its own sight, and pins those in the open', () => {
    const w = createWorld(5, flatMap());
    step(w, [
      spawnAt(0, KIND_MORTAR, 500, 500),
      spawnAt(0, KIND_RECON, 535, 500),
      spawnAt(1, KIND_INFANTRY, 555, 500),
    ]);
    put(w, 0, 500, 500);
    put(w, 1, 535, 500);
    put(w, 2, 555, 500);
    step(w, [{ type: CMD_STANCE, units: [1, 2], stance: STANCE_HOLD_FIRE }]);
    let launched = 0;
    let pinned = false;
    run(w, 20 * 40, (w) => {
      launched += events(w, EV_LAUNCH).filter(([a]) => a === 0).length;
      if (w.pinned[2] > w.tick) pinned = true;
    });
    // 55 away is beyond the mortar's own eyes (30): it fired on the recon team's word.
    expect(launched).toBeGreaterThan(3);
    expect(w.hp[2]).toBeLessThan(KINDS[KIND_INFANTRY].hp);
    expect(pinned).toBe(true);
  });

  it('does nothing to a tank but scratch it', () => {
    const w = createWorld(5, flatMap());
    step(w, [
      spawnAt(0, KIND_MORTAR, 500, 500),
      spawnAt(0, KIND_RECON, 535, 500),
      spawnAt(1, KIND_TANK, 555, 500),
    ]);
    put(w, 0, 500, 500);
    put(w, 1, 535, 500);
    put(w, 2, 555, 500);
    step(w, [{ type: CMD_STANCE, units: [1, 2], stance: STANCE_HOLD_FIRE }]);
    run(w, 20 * 60);
    expect(w.state[2]).toBe(STATE_ALIVE);
    expect(w.hp[2]).toBeGreaterThan(KINDS[KIND_TANK].hp * 0.8);
  });

  it('fires from a roof but not from inside a house', () => {
    const fired = (roof: boolean) => {
      const w = town();
      step(w, [
        spawnAt(0, KIND_MORTAR, 520, 502),
        spawnAt(0, KIND_RECON, 535, 540),
        spawnAt(1, KIND_INFANTRY, 545, 550),
      ]);
      put(w, 1, 535, 540);
      put(w, 2, 545, 550);
      step(w, [
        { type: CMD_STANCE, units: [1, 2], stance: STANCE_HOLD_FIRE },
        roof
          ? { type: CMD_ROOF, units: [0], structure: 0 }
          : { type: CMD_GARRISON, units: [0], structure: 0 },
      ]);
      let n = 0;
      run(w, 20 * 40, (w) => (n += events(w, EV_LAUNCH).length));
      expect(w.inside[0]).toBe(0);
      expect(onRoof(w, 0)).toBe(roof);
      return n;
    };
    expect(fired(false)).toBe(0);
    expect(fired(true)).toBeGreaterThan(2);
  });
});

describe('the roof', () => {
  /** A squad (or missile team) of army 0 in the house, a tank of army 1 out in the street. */
  function duel(kind: number, roof: boolean, gap = 4) {
    const w = town(3);
    step(w, [spawnAt(0, kind, 510, 520), spawnAt(1, KIND_TANK, 516 + gap, 502)]);
    put(w, 1, 516 + gap, 502);
    step(w, [
      { type: CMD_STANCE, units: [1], stance: STANCE_HOLD_FIRE },
      roof
        ? { type: CMD_ROOF, units: [0], structure: 0 }
        : { type: CMD_GARRISON, units: [0], structure: 0 },
    ]);
    run(w, 20 * 20);
    expect(w.inside[0]).toBe(0);
    return KINDS[KIND_TANK].hp - w.hp[1];
  }

  it('puts the men on the roof, and a move order brings them down and out', () => {
    const w = town(3);
    step(w, [spawnAt(0, KIND_INFANTRY, 510, 520)]);
    step(w, [{ type: CMD_ROOF, units: [0], structure: 0 }]);
    run(w, 20 * 10);
    expect(onRoof(w, 0)).toBe(true);
    expect(concealed(w, 0)).toBe(false);
    step(w, [{ type: CMD_ROOF, units: [0], structure: 0, off: true }]);
    expect(onRoof(w, 0)).toBe(false);
    expect(w.inside[0]).toBe(0);
    step(w, [{ type: CMD_ROOF, units: [0], structure: 0 }]);
    expect(onRoof(w, 0)).toBe(true);
    step(w, [{ type: CMD_MOVE, units: [0], x: fx(560), y: fx(560) }]);
    expect(w.inside[0]).toBe(-1);
    expect(w.roof[0]).toBe(0);
  });

  it('hits a tank on its top plate: rockets and missiles do more from up there', () => {
    expect(duel(KIND_INFANTRY, true)).toBeGreaterThan(duel(KIND_INFANTRY, false) * 1.5);
    expect(duel(KIND_ATGM, true)).toBeGreaterThan(duel(KIND_ATGM, false));
  });

  it('reaches further than a window', () => {
    // 15 + 6 from the roof against 15 + 3 from a window: the squad sits at (506, 498), the
    // tank 20.4 from it.
    expect(duel(KIND_INFANTRY, false, 10)).toBe(0);
    expect(duel(KIND_INFANTRY, true, 10)).toBeGreaterThan(0);
    expect(ROOF_RANGE_BONUS).toBeGreaterThan(fx(3));
  });

  it('leaves the men exposed: they take far more than behind walls', () => {
    const taken = (roof: boolean) => {
      const w = town(3);
      // Close enough (12.6) to make out men behind a window.
      step(w, [spawnAt(0, KIND_INFANTRY, 510, 520), spawnAt(1, KIND_INFANTRY, 518, 500)]);
      put(w, 1, 518, 500);
      step(w, [
        { type: CMD_STANCE, units: [0], stance: STANCE_HOLD_FIRE },
        roof
          ? { type: CMD_ROOF, units: [0], structure: 0 }
          : { type: CMD_GARRISON, units: [0], structure: 0 },
      ]);
      // Wait for them to get in, then give the enemy squad 20 seconds at them.
      run(w, 20 * 5);
      const before = w.hp[0];
      run(w, 20 * 20);
      return before - w.hp[0];
    };
    expect(taken(true)).toBeGreaterThan(taken(false) * 2);
  });
});

describe('the ambush', () => {
  /**
   * Two rifle squads of army 0 by a road, lying in wait on a circle round (545, 500). Army
   * 1 sends `kind` past them from the east.
   */
  function lay(kind: number) {
    const w = createWorld(5, flatMap());
    step(w, [
      spawnAt(0, KIND_INFANTRY, 545, 510),
      spawnAt(0, KIND_INFANTRY, 548, 512),
      spawnAt(1, kind, 620, 500),
    ]);
    put(w, 0, 545, 510);
    put(w, 1, 548, 512);
    put(w, 2, 620, 500);
    step(w, [
      { type: CMD_AMBUSH, units: [0, 1], x: fx(545), y: fx(500), radius: fx(12) },
      { type: CMD_STANCE, units: [2], stance: STANCE_HOLD_FIRE },
    ]);
    return w;
  }

  it('holds fire and keeps the men hidden while nothing is in the circle', () => {
    const w = lay(KIND_INFANTRY);
    expect(w.stance[0]).toBe(STANCE_AMBUSH);
    expect(concealed(w, 0)).toBe(true);
    // Enemy infantry walks right past (not a vehicle): not a shot.
    step(w, [{ type: CMD_MOVE, units: [2], x: fx(470), y: fx(500) }]);
    let shots = 0;
    run(w, 20 * 30, (w) => (shots += events(w, EV_SHOT).filter(([a]) => a < 2).length));
    expect(shots).toBe(0);
    expect(w.stance[0]).toBe(STANCE_AMBUSH);
  });

  it('springs when a vehicle enters the circle: everyone fires together', () => {
    const w = lay(KIND_TANK);
    step(w, [{ type: CMD_MOVE, units: [2], x: fx(470), y: fx(500) }]);
    let sprung = -1;
    let at = -1;
    let firstShot = -1;
    run(w, 20 * 40, (w) => {
      const e = events(w, EV_AMBUSH);
      if (e.length > 0 && sprung < 0) {
        sprung = e[0][1];
        at = w.tick;
        const dx = w.posX[2] - fx(545);
        const dy = w.posY[2] - fx(500);
        expect(dx * dx + dy * dy).toBeLessThanOrEqual(fx(12) * fx(12));
      }
      if (firstShot < 0 && events(w, EV_SHOT).some(([a]) => a < 2)) firstShot = w.tick;
    });
    expect(sprung).toBe(2);
    expect(w.stance[0]).toBe(STANCE_FREE);
    expect(w.stance[1]).toBe(STANCE_FREE);
    expect(firstShot).toBeGreaterThanOrEqual(at);
    expect(w.hp[2]).toBeLessThan(KINDS[KIND_TANK].hp);
  });

  it('is called off by any other order', () => {
    const w = lay(KIND_INFANTRY);
    step(w, [{ type: CMD_MOVE, units: [0], x: fx(530), y: fx(530) }]);
    expect(w.stance[0]).toBe(STANCE_FREE);
    expect(w.stance[1]).toBe(STANCE_AMBUSH);
  });
});
