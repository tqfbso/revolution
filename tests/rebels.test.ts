import { describe, expect, it } from 'vitest';
import { CIV_HOME } from '../src/sim/civilians';
import {
  CMD_FACTION,
  CMD_FORTIFY,
  CMD_FOUND,
  CMD_MOVE,
  CMD_SPAWN,
  type Command,
} from '../src/sim/commands';
import { B_COUNT, B_HQ, pricesOf, UNIT_PRICE } from '../src/sim/economy';
import {
  FACTIONS,
  FACTION_REBEL,
  FACTION_RUSSIA,
  factionByName,
  missingOf,
  pointsOf,
} from '../src/sim/factions';
import { fx } from '../src/sim/fixed';
import { S_BUILDING, addStructure, addTown, flatMap, refreshPassability } from '../src/sim/map';
import {
  CIV_JOINED,
  TOWN_FOLK,
  VOLUNTEER_FOLK,
  VOLUNTEER_TICKS,
  amongFolk,
  townCells,
} from '../src/sim/rebels';
import { strikeOf } from '../src/sim/air';
import { concealed, step } from '../src/sim/sim';
import {
  KINDS,
  KIND_AD,
  KIND_ARTILLERY,
  KIND_ENGINEER,
  KIND_HELI,
  KIND_IFV,
  KIND_INFANTRY,
  KIND_LIFT,
  KIND_PARA,
  KIND_RECON,
  KIND_TANK,
  POINTS,
} from '../src/sim/units';
import { WORKS, WORK_BOMB, canOrder, workStands } from '../src/sim/works';
import {
  EV_IMPACT,
  EV_VOLUNTEERS,
  STATE_ALIVE,
  createWorld,
  hashWorld,
  type World,
} from '../src/sim/world';

/** A town of three houses round (510, 502) on an empty map: some thirty people live in it. */
function town() {
  const m = flatMap();
  addTown(m, fx(510), fx(502), fx(40), 'Test');
  addStructure(m, S_BUILDING, 126, 124, 3, 3, 0, 3);
  addStructure(m, S_BUILDING, 131, 124, 3, 3, 0, 3);
  addStructure(m, S_BUILDING, 126, 129, 3, 3, 0, 3);
  refreshPassability(m);
  return m;
}
const spawnAt = (team: number, kind: number, x: number, y: number, count = 1): Command => ({
  type: CMD_SPAWN,
  count,
  team,
  kind,
  x: fx(x),
  y: fx(y),
  radius: fx(1),
  wander: false,
});
const army = (team: number, faction: number): Command => ({ type: CMD_FACTION, team, faction });
const run = (w: World, ticks: number, first: Command[] = []) => {
  step(w, first);
  for (let t = 1; t < ticks; t++) step(w, []);
};
const count = (w: World, state: number) => {
  let n = 0;
  for (let k = 0; k < w.civCount; k++) if (w.civState[k] === state) n++;
  return n;
};
const units = (w: World, team: number, kind: number) => {
  const ids: number[] = [];
  for (let i = 0; i < w.count; i++)
    if (w.state[i] === STATE_ALIVE && w.team[i] === team && w.kind[i] === kind) ids.push(i);
  return ids;
};

describe('the rebels (I8)', () => {
  const rebel = FACTIONS[FACTION_REBEL];

  it('are a fifth army with no aircraft and no air strike', () => {
    expect(factionByName('rebels')).toBe(FACTION_REBEL);
    expect(missingOf(FACTION_REBEL)).toEqual(
      [KIND_HELI, KIND_LIFT, KIND_PARA].map((k) => KINDS[k].name),
    );
    for (const k of [KIND_HELI, KIND_LIFT, KIND_PARA])
      expect(pricesOf(FACTION_REBEL)[k].from).toBe(B_COUNT);
    const w = createWorld(1, flatMap());
    step(w, [army(0, FACTION_REBEL), army(1, FACTION_RUSSIA)]);
    expect(strikeOf(w, 0)).toBe(0);
    expect(strikeOf(w, 1)).toBeGreaterThan(0);
  });

  it('raise fighters faster and cheaper than anyone, each a little worse', () => {
    const mine = pricesOf(FACTION_REBEL)[KIND_INFANTRY];
    for (let f = 0; f < FACTION_REBEL; f++) {
      expect(mine.ticks).toBeLessThan(pricesOf(f)[KIND_INFANTRY].ticks);
      expect(mine.supplies).toBeLessThanOrEqual(pricesOf(f)[KIND_INFANTRY].supplies);
      expect(rebel.kinds[KIND_INFANTRY].hp).toBeLessThan(FACTIONS[f].kinds[KIND_INFANTRY].hp);
    }
    // Shoulder-launched missiles: their only answer to a gunship besides the gun trucks.
    expect(rebel.kinds[KIND_INFANTRY].damage[KIND_HELI]).toBeGreaterThan(
      KINDS[KIND_INFANTRY].damage[KIND_HELI],
    );
    expect(rebel.kinds[KIND_INFANTRY].damage[KIND_INFANTRY]).toBe(
      KINDS[KIND_INFANTRY].damage[KIND_INFANTRY],
    );
  });

  it('ride in pickups: fast, frail, cheap, and light on the army limit', () => {
    const technical = rebel.kinds[KIND_IFV];
    expect(technical.name).toBe('Technical');
    for (let f = 0; f < FACTION_REBEL; f++) {
      expect(technical.speed).toBeGreaterThan(FACTIONS[f].kinds[KIND_IFV].speed);
      expect(technical.hp).toBeLessThan(FACTIONS[f].kinds[KIND_IFV].hp);
    }
    const w = createWorld(1, flatMap());
    step(w, [army(0, FACTION_REBEL)]);
    for (const k of [KIND_IFV, KIND_ARTILLERY, KIND_AD]) {
      expect(pointsOf(w, 0, k)).toBeLessThan(POINTS[k]);
      expect(pointsOf(w, 1, k)).toBe(POINTS[k]);
    }
    // Their few tanks are captured ones: dearer and slower to come by than anyone's.
    expect(pointsOf(w, 0, KIND_TANK)).toBe(POINTS[KIND_TANK]);
    expect(pricesOf(FACTION_REBEL)[KIND_TANK].ticks).toBeGreaterThan(UNIT_PRICE[KIND_TANK].ticks);
  });

  it('are hidden among the people of a town until they shoot', () => {
    const w = createWorld(1, town());
    run(w, 70, [
      army(0, FACTION_REBEL),
      army(1, FACTION_RUSSIA),
      spawnAt(0, KIND_INFANTRY, 540, 530),
      spawnAt(1, KIND_INFANTRY, 546, 530),
      spawnAt(0, KIND_INFANTRY, 800, 800),
    ]);
    expect(w.townFolk[0]).toBeGreaterThanOrEqual(TOWN_FOLK);
    const [inTown, outside] = units(w, 0, KIND_INFANTRY);
    const [other] = units(w, 1, KIND_INFANTRY);
    expect(townCells(w.map)[0]).toBe(0);
    // The fight has started by now (they stand six metres apart): no longer hidden.
    expect(w.reveal[inTown]).toBeGreaterThan(w.tick);
    expect(concealed(w, inTown)).toBe(false);
    w.reveal[inTown] = 0;
    expect(amongFolk(w, inTown)).toBe(true);
    expect(concealed(w, inTown)).toBe(true);
    // Not out in the country, and not anyone else's men.
    expect(concealed(w, outside)).toBe(false);
    expect(concealed(w, other)).toBe(false);
  });

  it('lose that cover when the people have gone', () => {
    const w = createWorld(1, town());
    run(w, 25, [army(0, FACTION_REBEL), spawnAt(0, KIND_INFANTRY, 516, 512)]);
    const [id] = units(w, 0, KIND_INFANTRY);
    expect(concealed(w, id)).toBe(true);
    for (let k = 0; k < w.civCount; k++) w.civState[k] = CIV_JOINED;
    run(w, 21);
    expect(w.townFolk[0]).toBe(0);
    expect(concealed(w, id)).toBe(false);
  });

  it('are told where the others are in any town where people live', () => {
    const cmds = [spawnAt(1, KIND_INFANTRY, 516, 512), spawnAt(1, KIND_INFANTRY, 800, 800)];
    const w = createWorld(1, town());
    run(w, 45, [army(0, FACTION_REBEL), army(1, FACTION_RUSSIA), ...cmds]);
    const [seen, unseen] = units(w, 1, KIND_INFANTRY);
    expect(w.spotted[seen]).toBeGreaterThan(w.tick);
    expect(w.spotted[unseen]).toBeLessThanOrEqual(w.tick);
    // Nobody tells a regular army anything.
    const plain = createWorld(1, town());
    run(plain, 45, [army(1, FACTION_RUSSIA), ...cmds]);
    expect(plain.spotted[units(plain, 1, KIND_INFANTRY)[0]]).toBeLessThanOrEqual(plain.tick);
    expect(plain.townFolk[0]).toBe(0);
  });

  it('get a band of volunteers from a town they hold, and its people go with it', () => {
    const w = createWorld(1, town());
    step(w, [army(0, FACTION_REBEL), { type: CMD_FOUND, team: 0, building: B_HQ, x: 60, y: 60 }]);
    expect(w.popCap[0]).toBeGreaterThan(0);
    const home = count(w, CIV_HOME);
    const got: number[] = [];
    const play = (ticks: number) => {
      for (let t = 0; t < ticks; t++) {
        step(w, []);
        for (let e = 0; e < w.events.length; e += 3)
          if (w.events[e] === EV_VOLUNTEERS) got.push(w.events[e + 1], w.events[e + 2]);
        w.events.length = 0;
      }
    };
    // Nobody's town sends nobody.
    play(VOLUNTEER_TICKS + 20);
    expect(got).toEqual([]);
    w.townOwner[0] = 0;
    play(VOLUNTEER_TICKS + 20);
    expect(got).toEqual([0, 0]);
    expect(units(w, 0, KIND_INFANTRY)).toHaveLength(1);
    expect(count(w, CIV_JOINED)).toBe(VOLUNTEER_FOLK);
    expect(count(w, CIV_HOME)).toBe(home - VOLUNTEER_FOLK);
    expect(w.pop[0]).toBe(1);
  });

  it('a regular army holding the same town gets no volunteers', () => {
    const w = createWorld(1, town());
    step(w, [
      army(0, FACTION_REBEL),
      army(1, FACTION_RUSSIA),
      { type: CMD_FOUND, team: 1, building: B_HQ, x: 60, y: 60 },
    ]);
    w.townOwner[0] = 1;
    let got = 0;
    for (let t = 0; t < VOLUNTEER_TICKS + 20; t++) {
      step(w, []);
      for (let e = 0; e < w.events.length; e += 3) if (w.events[e] === EV_VOLUNTEERS) got++;
      w.events.length = 0;
    }
    expect(got).toBe(0);
    expect(w.count).toBe(0);
  });

  it('are quicker on foot in a town, and only there', () => {
    const walk = (faction: number, x: number, y: number) => {
      const w = createWorld(1, town());
      run(w, 2, [army(0, faction), spawnAt(0, KIND_INFANTRY, x, y)]);
      const [id] = units(w, 0, KIND_INFANTRY);
      const from = w.posX[id];
      run(w, 60, [{ type: CMD_MOVE, units: [id], x: fx(x + 30), y: fx(y) }]);
      return (w.posX[id] - from) / w.speed[id];
    };
    expect(walk(FACTION_REBEL, 485, 518) / walk(FACTION_RUSSIA, 485, 518)).toBeGreaterThan(1.2);
    expect(walk(FACTION_REBEL, 800, 800) / walk(FACTION_RUSSIA, 800, 800)).toBeCloseTo(1, 2);
  });

  it('a game with rebels in it plays the same twice', () => {
    const play = () => {
      const w = createWorld(3, town());
      w.townOwner[0] = 0;
      run(w, VOLUNTEER_TICKS + 200, [
        army(0, FACTION_REBEL),
        army(1, FACTION_RUSSIA),
        spawnAt(0, KIND_INFANTRY, 516, 512, 4),
        spawnAt(0, KIND_ARTILLERY, 470, 500, 2),
        spawnAt(1, KIND_INFANTRY, 560, 512, 4),
        spawnAt(1, KIND_TANK, 570, 520, 2),
      ]);
      return hashWorld(w);
    };
    expect(play()).toBe(play());
  });
});

describe('the roadside bomb (I8)', () => {
  const cell = (x: number, y: number) => (y >> 2) * 256 + (x >> 2);
  const lay = (w: World, team: number, cells: number[]): Command => ({
    type: CMD_FORTIFY,
    units: units(w, team, KIND_ENGINEER),
    work: WORK_BOMB,
    cells,
  });
  const setup = (faction: number) => {
    const w = createWorld(1, flatMap());
    w.supplies[0] = 500;
    run(w, 2, [army(0, faction), army(1, FACTION_RUSSIA), spawnAt(0, KIND_ENGINEER, 400, 402)]);
    return w;
  };

  it('is laid by rebel sappers and by nobody else', () => {
    const w = setup(FACTION_REBEL);
    run(w, 200, [lay(w, 0, [cell(406, 402)])]);
    expect(w.wKind[cell(406, 402)]).toBe(WORK_BOMB);
    expect(workStands(w, cell(406, 402))).toBe(true);
    expect(w.supplies[0]).toBe(500 - WORKS[WORK_BOMB].supplies);
    // It is nothing to drive round: the ground is as open as it was.
    expect(canOrder(w, 1, WORK_BOMB)).toBe(false);
    const other = setup(FACTION_RUSSIA);
    run(other, 200, [lay(other, 0, [cell(406, 402)])]);
    expect(other.wKind[cell(406, 402)]).toBe(0);
  });

  it('goes off under the first enemy vehicle, not under men on foot or its own side', () => {
    const w = setup(FACTION_REBEL);
    // Three in a row across the way, so that whoever comes along it meets one.
    const row = [cell(406, 398), cell(406, 402), cell(406, 406)];
    const standing = () => row.filter((c) => workStands(w, c)).length;
    run(w, 600, [lay(w, 0, row)]);
    expect(standing()).toBe(3);
    // The sappers go home; their own technical and the enemy's riflemen cross it.
    const across = (ids: number[], to: number): Command => ({
      type: CMD_MOVE,
      units: ids,
      x: fx(to),
      y: fx(402),
    });
    run(w, 3, [
      across(units(w, 0, KIND_ENGINEER), 300),
      spawnAt(0, KIND_IFV, 380, 402),
      spawnAt(1, KIND_RECON, 430, 402),
    ]);
    run(w, 400, [across(units(w, 0, KIND_IFV), 440), across(units(w, 1, KIND_RECON), 370)]);
    expect(w.posX[units(w, 0, KIND_IFV)[0]]).toBeGreaterThan(fx(420));
    expect(w.posX[units(w, 1, KIND_RECON)[0]]).toBeLessThan(fx(395));
    expect(standing()).toBe(3);
    // Then a tank.
    run(w, 3, [spawnAt(1, KIND_TANK, 440, 402)]);
    const [tank] = units(w, 1, KIND_TANK);
    const full = w.hp[tank];
    w.events.length = 0;
    step(w, [across([tank], 370)]);
    let bang = -1;
    for (let t = 0; t < 400 && bang < 0; t++) {
      step(w, []);
      for (let e = 0; e < w.events.length; e += 3)
        if (w.events[e] === EV_IMPACT) bang = w.posX[tank];
      w.events.length = 0;
    }
    // It went off as the tank came onto its cell, and not before.
    expect(bang).toBeGreaterThan(fx(403));
    expect(bang).toBeLessThan(fx(409));
    expect(standing()).toBe(2);
    // The tank is crippled, not dead.
    expect(w.state[tank]).toBe(STATE_ALIVE);
    expect(w.hp[tank]).toBeLessThan(full * 0.65);
    expect(w.hp[tank]).toBeGreaterThan(full * 0.2);
  });
});
