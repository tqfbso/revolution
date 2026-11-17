import { describe, expect, it } from 'vitest';
import {
  CMD_ASSIGN,
  CMD_FACTION,
  CMD_MARCH,
  CMD_MOVE,
  CMD_SHAPE,
  CMD_SPAWN,
  type Command,
} from '../src/sim/commands';
import { fx } from '../src/sim/fixed';
import {
  BERTH_SLOT,
  BERTH_TRAIL,
  DOCTRINE,
  SHAPE_AUTO,
  SHAPE_BLOCK,
  SHAPE_CONVOY,
  SHAPE_COUNT,
  SHAPE_ECHELON,
  SHAPE_LINE,
  SHAPE_VEE,
  SHAPE_WEDGE,
  SHAPES,
  builtUp,
  shapeFor,
} from '../src/sim/formations';
import { admit } from '../src/sim/guard';
import { flatMap, generateMap } from '../src/sim/map';
import { step } from '../src/sim/sim';
import { KIND_INFANTRY, KIND_TANK, KIND_TRUCK } from '../src/sim/units';
import {
  CF_SHAPE_MASK,
  CF_SHAPE_SHIFT,
  FLAG_MOVING,
  STATE_ALIVE,
  createWorld,
  hashWorld,
  type World,
} from '../src/sim/world';

const NATO = 1;
const RUSSIA = 2;
const CHINA = 3;

const spawn = (team: number, kind: number, count: number, x: number, y: number): Command => ({
  type: CMD_SPAWN,
  count,
  team,
  kind,
  x: fx(x),
  y: fx(y),
  radius: fx(8),
  wander: false,
});
const run = (w: World, ticks: number) => {
  for (let t = 0; t < ticks; t++) step(w, []);
};
const all = (w: World) => Array.from({ length: w.count }, (_, i) => i);
const ofKind = (w: World, kind: number) => all(w).filter((i) => w.kind[i] === kind);
const moving = (w: World) => all(w).filter((i) => (w.flags[i] & FLAG_MOVING) !== 0).length;
const m = (v: number) => v / 1024;

/** Five tanks, twelve squads and two trucks of `faction` at (300, 500) on open ground. */
function body(faction: number): World {
  const w = createWorld(3, flatMap());
  step(w, [
    { type: CMD_FACTION, team: 0, faction },
    spawn(0, KIND_TANK, 5, 300, 500),
    spawn(0, KIND_INFANTRY, 12, 300, 500),
    spawn(0, KIND_TRUCK, 2, 300, 500),
  ]);
  return w;
}
/** East across the open, and the picture after 25 seconds of march. */
function march(w: World, shape = SHAPE_AUTO): World {
  const units = all(w);
  const cmds: Command[] = [{ type: CMD_MOVE, units, x: fx(700), y: fx(500) }];
  if (shape !== SHAPE_AUTO) cmds.unshift({ type: CMD_SHAPE, units, shape });
  step(w, cmds);
  run(w, 500);
  return w;
}
/** How far the tanks are spread along the way (x) and across it (y), in metres. */
function spread(w: World): { along: number; across: number } {
  const tanks = ofKind(w, KIND_TANK);
  const xs = tanks.map((i) => m(w.posX[i]));
  const ys = tanks.map((i) => m(w.posY[i]));
  return {
    along: Math.max(...xs) - Math.min(...xs),
    across: Math.max(...ys) - Math.min(...ys),
  };
}

describe('how a body moves (I4, decision 148)', () => {
  it('names every shape, and gives every faction one for open ground', () => {
    expect(SHAPES.length).toBe(SHAPE_COUNT);
    expect(DOCTRINE).toEqual([SHAPE_BLOCK, SHAPE_WEDGE, SHAPE_LINE, SHAPE_VEE]);
  });

  it('without a faction a move is the block it always was: no march, no leads', () => {
    const w = march(body(0));
    for (const i of all(w)) {
      expect(w.march[i]).toBe(0);
      expect(w.lead[i]).toBe(-1);
    }
  });

  it('the alliance crosses open ground in a wedge, armour at the point', () => {
    const w = march(body(NATO));
    const tanks = ofKind(w, KIND_TANK);
    const guide = tanks.find((i) => w.lead[i] < 0) as number;
    expect(guide).toBeGreaterThanOrEqual(0);
    // The guide is the point: every other tank is behind it, a pair on each side.
    const others = tanks.filter((i) => i !== guide);
    for (const i of others) expect(w.posX[i]).toBeLessThan(w.posX[guide] - fx(2));
    expect(others.filter((i) => w.posY[i] < w.posY[guide]).length).toBe(2);
    // The squads follow behind the armour, the trucks behind the squads.
    const rear = Math.min(...tanks.map((i) => w.posX[i]));
    const men = ofKind(w, KIND_INFANTRY).map((i) => w.posX[i]);
    expect(Math.max(...men)).toBeLessThan(rear);
    expect(Math.max(...ofKind(w, KIND_TRUCK).map((i) => w.posX[i]))).toBeLessThan(Math.min(...men));
  });

  it('everyone is on his place in the shape while it moves', () => {
    const w = march(body(NATO));
    expect(moving(w)).toBe(w.count);
    for (const i of all(w)) {
      const lead = w.lead[i];
      if (lead < 0) continue;
      expect(w.berth[i]).toBe(BERTH_SLOT);
      const dx = m(w.posX[lead] + w.offA[i] - w.posX[i]);
      const dy = m(w.posY[lead] + w.offB[i] - w.posY[i]);
      expect(Math.hypot(dx, dy)).toBeLessThan(1.5);
    }
  });

  it('Russia advances in line, China in a vee', () => {
    const line = spread(march(body(RUSSIA)));
    expect(line.along).toBeLessThan(2);
    expect(line.across).toBeGreaterThan(20);
    const w = march(body(CHINA));
    const tanks = ofKind(w, KIND_TANK).sort((a, b) => w.posY[a] - w.posY[b]);
    // The two on the outside lead; the one in the middle is furthest back.
    expect(w.posX[tanks[2]]).toBeLessThan(w.posX[tanks[1]] - fx(2));
    expect(w.posX[tanks[1]]).toBeLessThan(w.posX[tanks[0]] - fx(2));
    expect(w.posX[tanks[2]]).toBeLessThan(w.posX[tanks[3]] - fx(2));
    expect(w.posX[tanks[3]]).toBeLessThan(w.posX[tanks[4]] - fx(2));
  });

  it('any shape can be forced: an echelon, a line, a convoy in a field', () => {
    const echelon = march(body(NATO), SHAPE_ECHELON);
    const tanks = ofKind(echelon, KIND_TANK).sort((a, b) => echelon.posY[a] - echelon.posY[b]);
    for (let k = 1; k < tanks.length; k++) {
      expect(echelon.posX[tanks[k]]).toBeLessThan(echelon.posX[tanks[k - 1]] - fx(2));
    }
    expect(spread(march(body(NATO), SHAPE_LINE)).along).toBeLessThan(2);
    expect(spread(march(body(CHINA), SHAPE_WEDGE)).along).toBeGreaterThan(6);
    // No faction, and still a convoy when it is told to be one.
    const convoy = march(body(0), SHAPE_CONVOY);
    const s = spread(convoy);
    expect(s.across).toBeLessThan(3);
    expect(s.along).toBeGreaterThan(30);
  });

  it('a convoy is a file: each vehicle a gap behind the one ahead, squads on both sides', () => {
    const w = march(body(0), SHAPE_CONVOY);
    const file = all(w).filter((i) => w.berth[i] === BERTH_TRAIL && w.lead[i] >= 0);
    // Five tanks and two trucks: six of them follow another.
    expect(file.length).toBe(6);
    for (const i of file) {
      const d = Math.hypot(m(w.posX[w.lead[i]] - w.posX[i]), m(w.posY[w.lead[i]] - w.posY[i]));
      expect(d).toBeGreaterThan(8);
      expect(d).toBeLessThan(11);
    }
    // With trucks to look after, a tank closes the file.
    const last = all(w).find(
      (i) =>
        w.lead[i] >= 0 &&
        !all(w).some((j) => w.lead[j] === i && w.berth[j] === BERTH_TRAIL) &&
        w.berth[i] === BERTH_TRAIL,
    ) as number;
    expect(w.kind[last]).toBe(KIND_TANK);
    const head = all(w).find((i) => w.lead[i] < 0) as number;
    expect(w.kind[head]).toBe(KIND_TANK);
    const men = ofKind(w, KIND_INFANTRY);
    const left = men.filter((i) => w.posY[i] < w.posY[head] - fx(2)).length;
    const right = men.filter((i) => w.posY[i] > w.posY[head] + fx(2)).length;
    expect(left).toBe(6);
    expect(right).toBe(6);
    // The first pair is out in front of the lead vehicle.
    expect(Math.max(...men.map((i) => w.posX[i]))).toBeGreaterThan(w.posX[head] + fx(3));
  });

  it('they all get where they were sent, and stand there in the shape', () => {
    const w = march(body(RUSSIA));
    run(w, 3000);
    expect(moving(w)).toBe(0);
    const tanks = ofKind(w, KIND_TANK);
    for (const i of tanks) expect(Math.abs(m(w.posX[i]) - m(w.posX[tanks[0]]))).toBeLessThan(2);
    for (const i of all(w)) expect(Math.abs(m(w.posX[i]) - 700)).toBeLessThan(30);
  });

  it('a body that loses its guide goes on without it', () => {
    const w = march(body(NATO));
    const guide = all(w).find((i) => w.lead[i] < 0) as number;
    w.state[guide] = 0;
    run(w, 3500);
    for (const i of all(w)) {
      if (i === guide) continue;
      expect(w.flags[i] & FLAG_MOVING).toBe(0);
      expect(Math.abs(m(w.posX[i]) - 700)).toBeLessThan(30);
    }
  });

  it('nobody follows a lead that was sent somewhere else', () => {
    const w = march(body(NATO));
    const guide = all(w).find((i) => w.lead[i] < 0) as number;
    step(w, [{ type: CMD_MOVE, units: [guide], x: fx(300), y: fx(200) }]);
    run(w, 3500);
    expect(Math.abs(m(w.posX[guide]) - 300)).toBeLessThan(5);
    for (const i of all(w)) {
      if (i !== guide) expect(Math.abs(m(w.posX[i]) - 700)).toBeLessThan(30);
    }
  });

  it('into a town it is a convoy by itself; out in the fields the doctrine', () => {
    const map = generateMap(3, 'city');
    const w = createWorld(3, map);
    const hx = map.startX[0] * 4 + 30;
    const hy = map.startY[0] * 4 + 30;
    step(w, [
      { type: CMD_FACTION, team: 0, faction: NATO },
      spawn(0, KIND_TANK, 4, hx, hy),
      spawn(0, KIND_INFANTRY, 8, hx, hy),
    ]);
    expect(builtUp(map, map.townX[4], map.townY[4])).toBe(true);
    expect(shapeFor(w, all(w), map.townX[4], map.townY[4])).toBe(SHAPE_CONVOY);
    step(w, [{ type: CMD_MOVE, units: all(w), x: map.townX[4], y: map.townY[4] }]);
    expect(ofKind(w, KIND_TANK).filter((i) => w.berth[i] === BERTH_TRAIL).length).toBe(3);
    run(w, 6000);
    expect(moving(w)).toBe(0);
    for (const i of all(w)) {
      const d = Math.hypot(m(w.posX[i] - map.townX[4]), m(w.posY[i] - map.townY[4]));
      expect(d).toBeLessThan(40);
    }
    const open = createWorld(3, flatMap());
    step(open, [{ type: CMD_FACTION, team: 0, faction: NATO }, spawn(0, KIND_TANK, 3, 300, 500)]);
    expect(builtUp(open.map, fx(700), fx(500))).toBe(false);
    expect(shapeFor(open, all(open), fx(700), fx(500))).toBe(SHAPE_WEDGE);
  });

  it('a commander keeps the shape he is given, whatever his troops were told', () => {
    const w = body(NATO);
    const units = all(w);
    step(w, [
      { type: CMD_SHAPE, units, shape: SHAPE_LINE },
      { type: CMD_ASSIGN, units, slot: 2 },
      { type: CMD_MARCH, team: 0, slot: 2, shape: SHAPE_VEE },
    ]);
    expect((w.cFlags[2] >> CF_SHAPE_SHIFT) & CF_SHAPE_MASK).toBe(SHAPE_VEE);
    expect(shapeFor(w, units, fx(700), fx(500))).toBe(SHAPE_VEE);
    // Back to Auto, the commander lets the ground decide: not what the troops were told.
    step(w, [{ type: CMD_MARCH, team: 0, slot: 2, shape: SHAPE_AUTO }]);
    expect(shapeFor(w, units, fx(700), fx(500))).toBe(SHAPE_WEDGE);
    // A shape that does not exist changes nothing.
    step(w, [
      { type: CMD_MARCH, team: 0, slot: 2, shape: 9 },
      { type: CMD_SHAPE, units, shape: -1 },
    ]);
    expect((w.cFlags[2] >> CF_SHAPE_SHIFT) & CF_SHAPE_MASK).toBe(SHAPE_AUTO);
    expect(w.shape[units[0]]).toBe(SHAPE_LINE);
  });

  it('an army cannot tell another how to move', () => {
    const w = body(NATO);
    step(w, [spawn(1, KIND_TANK, 2, 900, 500)]);
    const theirs = all(w).filter((i) => w.team[i] === 1);
    expect(admit(w, { type: CMD_SHAPE, units: theirs, shape: SHAPE_LINE, army: 0 })).toBeNull();
    expect(admit(w, { type: CMD_MARCH, team: 1, slot: 0, shape: SHAPE_LINE, army: 0 })).toBeNull();
    expect(
      admit(w, { type: CMD_MARCH, team: 0, slot: 0, shape: SHAPE_LINE, army: 0 }),
    ).not.toBeNull();
  });

  it('plays the same twice, and the shape is part of the state', () => {
    const a = march(body(NATO));
    const b = march(body(NATO));
    expect(hashWorld(a)).toBe(hashWorld(b));
    expect(hashWorld(march(body(NATO), SHAPE_LINE))).not.toBe(hashWorld(a));
    expect(all(a).every((i) => a.state[i] === STATE_ALIVE)).toBe(true);
  });
});
