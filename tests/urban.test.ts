import { describe, expect, it } from 'vitest';
import { CMD_ATTACK_STRUCTURE, CMD_GARRISON, CMD_SPAWN, type Command } from '../src/sim/commands';
import { fx } from '../src/sim/fixed';
import {
  BUILD_BLOCK,
  BUILD_HALL,
  BUILD_HOUSE,
  FACE_EAST,
  FACE_NORTH,
  FACE_WEST,
  STAGE_DAMAGED,
  STAGE_GUTTED,
  STAGE_INTACT,
  STAGE_RUIN,
  S_BUILDING,
  T_RUBBLE,
  addStructure,
  addTown,
  buildClass,
  cellOfPos,
  flatMap,
  refreshPassability,
  wallMax,
} from '../src/sim/map';
import { faceToward, stageOf, step } from '../src/sim/sim';
import { FORT_TICKS } from '../src/sim/urban';
import { KINDS, KIND_ARTILLERY, KIND_ENGINEER, KIND_INFANTRY, KIND_TANK } from '../src/sim/units';
import {
  EV_COLLAPSE,
  EV_GUTTED,
  EV_STORMED,
  EV_STRAY,
  EV_WALL,
  STATE_ALIVE,
  createWorld,
  type World,
} from '../src/sim/world';

const FULL = KINDS[KIND_INFANTRY].hp;

/** A two by two house of three floors on cells (126..127, 124..125): 504..512 by 496..504. */
function withHouse(w = 2, h = 2, floors = 3) {
  const m = flatMap();
  addTown(m, fx(508), fx(500), fx(30), 'Test');
  addStructure(m, S_BUILDING, 126, 124, w, h, 0, floors);
  refreshPassability(m);
  return m;
}
function spawnAt(team: number, kind: number, count: number, x: number, y: number): Command {
  return { type: CMD_SPAWN, count, team, kind, x: fx(x), y: fx(y), radius: fx(4), wander: false };
}
function events(w: World, type: number): number[][] {
  const out: number[][] = [];
  for (let e = 0; e < w.events.length; e += 3) {
    if (w.events[e] === type) out.push([w.events[e + 1], w.events[e + 2]]);
  }
  return out;
}

describe('buildings that die slowly (U1)', () => {
  it('come in three classes, by what they are built of', () => {
    expect(buildClass(2, 2, 3)).toBe(BUILD_HOUSE);
    expect(buildClass(2, 3, 5)).toBe(BUILD_BLOCK);
    expect(buildClass(3, 3, 2)).toBe(BUILD_HALL);
    // Decisions 095 and 104 brought these down from 450, 900 and 1300, twice at Fabio's
    // asking: the city is meant to come apart in a battle.
    expect(withHouse(2, 2, 3).sMaxHp[0]).toBe(90 * 4);
    expect(withHouse(2, 2, 4).sMaxHp[0]).toBe(180 * 4);
    expect(withHouse(3, 3, 2).sMaxHp[0]).toBe(280 * 9);
  });

  it('a shot meets the face it comes from', () => {
    const m = withHouse();
    expect(faceToward(m, 0, fx(540), fx(500))).toBe(FACE_EAST);
    expect(faceToward(m, 0, fx(480), fx(503))).toBe(FACE_WEST);
    expect(faceToward(m, 0, fx(509), fx(470))).toBe(FACE_NORTH);
  });

  it('a lone tank breaches the wall in seconds and guts a small house in under half a minute', () => {
    const w = createWorld(1, withHouse());
    step(w, [spawnAt(1, KIND_TANK, 1, 535, 500)]);
    step(w, [{ type: CMD_ATTACK_STRUCTURE, units: [0], structure: 0 }]);
    w.events.length = 0;
    let breached = -1;
    let gutted = -1;
    for (let t = 0; t < 6000 && gutted < 0; t++) {
      step(w, []);
      if (breached < 0 && events(w, EV_WALL).length > 0) {
        breached = t;
        expect(events(w, EV_WALL)[0]).toEqual([0, FACE_EAST]);
      }
      if (events(w, EV_GUTTED).length > 0) gutted = t;
    }
    // The east wall is open within half a minute; the other three stand.
    expect(breached).toBeGreaterThan(0);
    expect(breached).toBeLessThan(600);
    expect(w.sWall[FACE_EAST]).toBe(0);
    expect(w.sWall[FACE_WEST]).toBe(wallMax(w.map, 0, FACE_WEST));
    // Under half a minute to gut it (four minutes before decision 095), and it is not a ruin.
    expect(gutted).toBeGreaterThan(200);
    expect(gutted).toBeLessThan(700);
    expect(stageOf(w, 0)).toBe(STAGE_GUTTED);
    expect(events(w, EV_COLLAPSE).length).toBe(0);
  });

  it('rifle squads ordered onto a building go and wear it down, slowly', () => {
    const w = createWorld(1, withHouse());
    step(w, [spawnAt(1, KIND_INFANTRY, 1, 580, 500)]);
    step(w, [{ type: CMD_ATTACK_STRUCTURE, units: [0], structure: 0 }]);
    const from = w.posX[0];
    for (let t = 0; t < 1200; t++) step(w, []);
    expect(from - w.posX[0]).toBeGreaterThan(fx(30));
    // Grenades and rockets: it tells after a minute, and a tank does thirty times as much.
    const done = w.map.sMaxHp[0] - w.sHp[0];
    expect(done).toBeGreaterThan(0);
    expect(done).toBeLessThan(w.map.sMaxHp[0] / 5);
  });

  it('an engineer charge goes into the structure, not into a wall', () => {
    const w = createWorld(1, withHouse());
    step(w, [spawnAt(1, KIND_ENGINEER, 1, 516, 500)]);
    step(w, [{ type: CMD_ATTACK_STRUCTURE, units: [0], structure: 0 }]);
    for (let t = 0; t < 400; t++) step(w, []);
    expect(w.sHp[0]).toBeLessThan(w.map.sMaxHp[0] - 80);
    expect(w.sWall[FACE_EAST]).toBe(wallMax(w.map, 0, FACE_EAST));
  });

  it('protects its garrison less with every state, and not at all through a breached wall', () => {
    // The squad's loss to one tank in a fixed time, with the house in a given condition.
    const loss = (prepare: (w: World) => void) => {
      const w = createWorld(1, withHouse());
      step(w, [spawnAt(0, KIND_INFANTRY, 1, 500, 500)]);
      step(w, [{ type: CMD_GARRISON, units: [0], structure: 0 }]);
      for (let t = 0; t < 200; t++) step(w, []);
      expect(w.inside[0]).toBe(0);
      prepare(w);
      // Close enough to see the men in the house.
      step(w, [spawnAt(1, KIND_TANK, 1, 522, 500)]);
      w.hp[1] = 30000;
      for (let t = 0; t < 130; t++) step(w, []);
      return FULL - w.hp[0];
    };
    const intact = loss(() => {});
    const damaged = loss((w) => (w.sHp[0] = Math.trunc(w.map.sMaxHp[0] * 0.6)));
    const breached = loss((w) => (w.sWall[FACE_EAST] = 0));
    const farSide = loss((w) => (w.sWall[FACE_WEST] = 0));
    expect(intact).toBeGreaterThan(0);
    expect(damaged).toBeGreaterThan(intact);
    expect(breached).toBeGreaterThan(intact);
    // A hole in the wall behind them does nothing for a tank in front.
    expect(farSide).toBe(intact);
  });

  it('loses a quarter of the garrison when gutted and a quarter when it falls', () => {
    const w = createWorld(1, withHouse());
    step(w, [spawnAt(0, KIND_INFANTRY, 1, 500, 500)]);
    step(w, [{ type: CMD_GARRISON, units: [0], structure: 0 }]);
    for (let t = 0; t < 200; t++) step(w, []);
    step(w, [spawnAt(1, KIND_ENGINEER, 1, 516, 500)]);
    w.hp[1] = 30000;
    w.stance[1] = 1;
    const max = w.map.sMaxHp[0];
    expect(stageOf(w, 0)).toBe(STAGE_INTACT);
    w.sHp[0] = Math.trunc(max * 0.5);
    expect(stageOf(w, 0)).toBe(STAGE_DAMAGED);
    // One charge short of gutted.
    w.sHp[0] = Math.trunc(max * 0.35) + 40;
    step(w, [{ type: CMD_ATTACK_STRUCTURE, units: [1], structure: 0 }]);
    w.events.length = 0;
    for (let t = 0; t < 400 && stageOf(w, 0) < STAGE_GUTTED; t++) step(w, []);
    expect(stageOf(w, 0)).toBe(STAGE_GUTTED);
    expect(events(w, EV_GUTTED).length).toBe(1);
    // Still inside, a quarter down: the shell is a position.
    expect(w.inside[0]).toBe(0);
    const gutted = FULL - (FULL >> 2);
    expect(w.hp[0]).toBe(gutted);
    w.sHp[0] = 40;
    for (let t = 0; t < 400 && stageOf(w, 0) < STAGE_RUIN; t++) step(w, []);
    expect(stageOf(w, 0)).toBe(STAGE_RUIN);
    expect(w.state[0]).toBe(STATE_ALIVE);
    expect(w.inside[0]).toBe(-1);
    expect(w.hp[0]).toBe(gutted - (gutted >> 2));
    // What is left is rubble, and rubble cannot be destroyed.
    const cell = cellOfPos(fx(506), fx(498));
    expect(w.map.type[cell]).toBe(T_RUBBLE);
    for (let t = 0; t < 600; t++) step(w, []);
    expect(w.map.type[cell]).toBe(T_RUBBLE);
    expect(w.sHp[0]).toBe(0);
  });
});

describe('collateral damage (decision 095)', () => {
  /** A squad of army 0 that will not die, in the open just east of the house. */
  function bystander(w: World): void {
    step(w, [spawnAt(0, KIND_INFANTRY, 1, 516, 500)]);
    w.posX[0] = fx(516);
    w.posY[0] = fx(500);
    w.stance[0] = 1;
  }

  it('a tank firing at men in front of a house opens its wall and wears it down', () => {
    const w = createWorld(1, withHouse());
    bystander(w);
    step(w, [spawnAt(1, KIND_TANK, 1, 535, 500)]);
    w.events.length = 0;
    let hits = 0;
    for (let t = 0; t < 900; t++) {
      w.hp[0] = 30000;
      w.posX[0] = fx(516);
      w.posY[0] = fx(500);
      step(w, []);
      hits += events(w, EV_STRAY).length;
      w.events.length = 0;
    }
    // Nobody ordered it: the rounds that go past the squad land on the house behind it.
    expect(hits).toBeGreaterThan(7);
    expect(w.sWall[FACE_EAST]).toBe(0);
    expect(w.sWall[FACE_WEST]).toBe(wallMax(w.map, 0, FACE_WEST));
    expect(stageOf(w, 0)).toBeGreaterThanOrEqual(STAGE_DAMAGED);
    expect(w.sHp[0]).toBeGreaterThan(0);
  });

  it('rifle fire shoots up the house behind its target and guts it, but cannot level it', () => {
    const w = createWorld(1, withHouse());
    bystander(w);
    step(w, [spawnAt(1, KIND_INFANTRY, 6, 526, 500)]);
    let shotUp = -1;
    for (let t = 0; t < 4800; t++) {
      w.hp[0] = 30000;
      w.posX[0] = fx(516);
      w.posY[0] = fx(500);
      step(w, []);
      if (shotUp < 0 && stageOf(w, 0) === STAGE_DAMAGED) shotUp = t;
    }
    // Six squads leave their mark on a small house within seconds.
    expect(shotUp).toBeGreaterThan(0);
    expect(shotUp).toBeLessThan(300);
    expect(w.sWall[FACE_EAST]).toBe(0);
    // Four minutes of it and the house is a shell, but it stands: bullets do not level it.
    expect(stageOf(w, 0)).toBe(STAGE_GUTTED);
    expect(w.sHp[0] * 100).toBeGreaterThanOrEqual(w.map.sMaxHp[0] * 10);
  });

  it('a fight in the open, away from any house, harms none', () => {
    const w = createWorld(1, withHouse());
    step(w, [spawnAt(0, KIND_INFANTRY, 4, 560, 560), spawnAt(1, KIND_TANK, 2, 580, 560)]);
    for (let t = 0; t < 600; t++) step(w, []);
    expect(w.sHp[0]).toBe(w.map.sMaxHp[0]);
    for (let f = 0; f < 4; f++) expect(w.sWall[f]).toBe(wallMax(w.map, 0, f));
  });

  it('a shell that lands in the street hurts the houses beside it, less with distance', () => {
    const burst = (x: number) => {
      const w = createWorld(1, withHouse());
      step(w, [spawnAt(1, KIND_ARTILLERY, 1, 700, 500)]);
      w.shX[0] = fx(x);
      w.shY[0] = fx(500);
      w.shTick[0] = w.tick + 1;
      w.shOwner[0] = 0;
      w.shKind[0] = KIND_ARTILLERY;
      w.shSmoke[0] = 0;
      w.shellCount = 1;
      for (let t = 0; t < 3; t++) step(w, []);
      return w.map.sMaxHp[0] - w.sHp[0];
    };
    const siege = KINDS[KIND_ARTILLERY].siege;
    expect(burst(508)).toBe(siege);
    const near = burst(513);
    const far = burst(516);
    expect(near).toBeLessThan(siege);
    expect(near).toBeGreaterThan(far);
    expect(far).toBeGreaterThan(siege / 2);
    expect(burst(520)).toBe(0);
  });

  it('a fortified house loses a quarter less to it', () => {
    const run = (fort: boolean) => {
      const w = createWorld(1, withHouse());
      if (fort) w.sFort[0] = FORT_TICKS;
      bystander(w);
      step(w, [spawnAt(1, KIND_TANK, 1, 535, 500)]);
      for (let t = 0; t < 400; t++) {
        w.hp[0] = 30000;
        w.posX[0] = fx(516);
        w.posY[0] = fx(500);
        step(w, []);
      }
      return w.map.sMaxHp[0] - w.sHp[0];
    };
    const plain = run(false);
    const braced = run(true);
    expect(plain).toBeGreaterThan(0);
    expect(braced).toBeLessThan(plain);
    expect(braced).toBeGreaterThan(plain / 2);
  });
});

describe('storming a held building (U2)', () => {
  /** `men` squads of army 0 sent into a 3 by 3 house that `held` squads of army 1 hold. */
  function storm(men: number, held: number, prepare?: (w: World) => void) {
    const w = createWorld(7, withHouse(3, 3, 3));
    step(w, [spawnAt(1, KIND_INFANTRY, held, 508, 510)]);
    const garrison = Array.from({ length: held }, (_, k) => k);
    step(w, [{ type: CMD_GARRISON, units: garrison, structure: 0 }]);
    for (let t = 0; t < 200; t++) step(w, []);
    expect(garrison.every((i) => w.inside[i] === 0)).toBe(true);
    prepare?.(w);
    // From the west, close by: the fight at the wall is what is measured, not the approach.
    step(w, [spawnAt(0, KIND_INFANTRY, men, 492, 502)]);
    const ids = Array.from({ length: men }, (_, k) => held + k);
    step(w, [{ type: CMD_GARRISON, units: ids, structure: 0 }]);
    let taken = -1;
    for (let t = 0; t < 2400 && taken < 0; t++) {
      step(w, []);
      if (events(w, EV_STORMED).length > 0) taken = t;
      w.events.length = 0;
    }
    const left = (list: number[]) => list.filter((i) => w.state[i] === STATE_ALIVE).length;
    return { w, taken, attackers: left(ids), defenders: left(garrison), ids };
  }

  it('takes the house standing, at a price, when the attackers are many', () => {
    const r = storm(14, 4);
    expect(r.taken).toBeGreaterThan(0);
    expect(r.defenders).toBe(0);
    expect(r.w.sHp[0]).toBeGreaterThan(0);
    expect(r.w.sOccTeam[0]).toBe(0);
    expect(r.ids.filter((i) => r.w.inside[i] === 0).length).toBeGreaterThan(0);
    expect(r.attackers).toBeLessThan(14);
  });

  it('fails against a garrison its own size behind whole walls', () => {
    const r = storm(5, 5);
    expect(r.taken).toBe(-1);
    expect(r.attackers).toBe(0);
    expect(r.defenders).toBeGreaterThanOrEqual(3);
  });

  it('is far cheaper through a breached wall', () => {
    const whole = storm(10, 4);
    const breached = storm(10, 4, (w) => {
      w.sWall[4 * 0 + FACE_WEST] = 0;
    });
    expect(breached.taken).toBeGreaterThan(0);
    expect(breached.attackers).toBeGreaterThan(whole.attackers);
  });
});
