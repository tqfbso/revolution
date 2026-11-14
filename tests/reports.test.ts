import { describe, expect, it } from 'vitest';
import { CommanderReports, QUIET, type Command } from '../src/client/reports';
import { SAY_NORMAL, SAY_ROUTINE, SAY_URGENT, Speaker, type Mouth } from '../src/client/voice';
import {
  ST_ARRIVED,
  ST_ATTACK,
  ST_FALLBACK,
  ST_GATHER,
  ST_HOLD,
  ST_IDLE,
  ST_MARCH,
  ST_MOVE,
  ST_REGROUP,
  ST_SECURED,
} from '../src/sim/staff';
import { M_ATTACK, M_HOLD, M_MOVE, M_NONE } from '../src/sim/world';

const idle: Command = {
  slot: 0,
  name: 'Alpha',
  mission: M_NONE,
  x: 0,
  z: 0,
  status: ST_IDLE,
  power: 100,
  best: 100,
  count: 20,
  cx: 100,
  cz: 100,
  auto: false,
  need: false,
  fighting: false,
};

/** A commander followed through a game: each `next` is one snapshot. */
function follow(slot = 0, name = 'Alpha') {
  const reports = new CommanderReports({
    name: (x, z) => `P${x}-${z}`,
    there: (c) => Math.hypot(c.cx - c.x, c.cz - c.z) < 60,
  });
  let was: Command = { ...idle, slot, name };
  return {
    reports,
    next(change: Partial<Command>, now: number): string[] {
      const c = { ...was, ...change };
      const out = reports.step(c, was, now).map((r) => r.text);
      was = c;
      return out;
    },
  };
}

describe('commander reports', () => {
  it('says the same things through every attack: order, forming up, going in, taken', () => {
    const a = follow();
    expect(a.next({ mission: M_ATTACK, x: 500, z: 500, status: ST_MARCH }, 0)).toEqual([
      'Alpha attacking P500-500',
    ]);
    expect(a.next({ cx: 300, cz: 300 }, 20)).toEqual([]);
    expect(a.next({ status: ST_GATHER, cx: 420, cz: 420 }, 60)).toEqual([
      'Alpha forming up outside P500-500',
    ]);
    expect(a.next({ status: ST_ATTACK, fighting: true }, 80)).toEqual([
      'Alpha going in at P500-500',
    ]);
    expect(a.next({ status: ST_SECURED, fighting: false, cx: 500, cz: 500 }, 140)).toEqual([
      'Alpha has taken P500-500',
    ]);
    // Counter-attacked there, and it holds: said once, not every time the fight flickers.
    expect(a.next({ status: ST_ATTACK, fighting: true }, 200)).toEqual([
      'Alpha under attack at P500-500',
    ]);
    expect(a.next({ status: ST_SECURED }, 205)).toEqual(['Alpha has held P500-500']);
    expect(a.next({ status: ST_ATTACK }, 210)).toEqual([]);
  });

  it('reports in position on every mission that goes somewhere, not only a move', () => {
    const a = follow();
    expect(a.next({ mission: M_HOLD, x: 400, z: 100, status: ST_HOLD }, 0)).toEqual([
      'Alpha moving to hold P400-100',
    ]);
    expect(a.next({ cx: 250 }, 10)).toEqual([]);
    expect(a.next({ cx: 380 }, 20)).toEqual(['Alpha in position at P400-100, holding']);
    expect(a.next({ cx: 390 }, 21)).toEqual([]);
    // A move says so when the staff says it has arrived.
    expect(a.next({ mission: M_MOVE, x: 900, z: 100, status: ST_MOVE }, 30)).toEqual([
      'Alpha moving to P900-100',
    ]);
    expect(a.next({ status: ST_ARRIVED, cx: 900 }, 60)).toEqual(['Alpha in position at P900-100']);
    // Told to hold where it already stands: one line, not two.
    expect(a.next({ mission: M_HOLD, status: ST_HOLD }, 90)).toEqual([
      'Alpha in position at P900-100, holding',
    ]);
  });

  it('reports contact, losses, falling back, regrouping and coming back', () => {
    const a = follow();
    a.next({ mission: M_ATTACK, x: 500, z: 500, status: ST_MARCH }, 0);
    expect(a.next({ fighting: true, cx: 200, cz: 200 }, 30)).toEqual([
      'Alpha in contact at P200-200',
    ]);
    // In and out of the same fight: not again for a minute.
    a.next({ fighting: false }, 35);
    expect(a.next({ fighting: true }, 40)).toEqual([]);
    expect(a.next({ power: 58 }, 50)).toEqual(['Alpha taking heavy losses']);
    expect(a.next({ power: 55 }, 51)).toEqual([]);
    // Falling back says it all: no second line about its losses in the same breath.
    expect(a.next({ power: 28, status: ST_FALLBACK, need: true }, 60)).toEqual([
      'Alpha falling back from P500-500',
    ]);
    expect(a.next({ status: ST_REGROUP, fighting: false }, 80)).toEqual([
      'Alpha regrouping, needs reinforcements',
    ]);
    expect(a.next({ power: 90, count: 30, need: false }, 120)).toEqual([
      'Alpha is back up to strength',
    ]);
    expect(a.next({ status: ST_MARCH }, 130)).toEqual(['Alpha resuming the attack on P500-500']);
  });

  it('tells a command that died from one the player took apart', () => {
    const a = follow();
    a.next({ mission: M_HOLD, x: 100, z: 100, status: ST_HOLD }, 0);
    a.next({ fighting: true }, 10);
    expect(a.next({ count: 0, power: 0 }, 11)).toEqual(['Alpha has no troops left']);
    const b = follow(1, 'Bravo');
    b.next({ mission: M_HOLD, x: 100, z: 100, status: ST_HOLD }, 0);
    expect(b.next({ count: 0, power: 0 }, 11)).toEqual([]);
    // Troops taken out of a quiet command are not losses either.
    const c = follow(2, 'Charlie');
    c.next({ mission: M_HOLD, x: 100, z: 100, status: ST_HOLD }, 0);
    expect(c.next({ power: 40, count: 8 }, 20)).toEqual([]);
  });

  it('keeps a commander off the air for a moment after a line, unless it is urgent', () => {
    const a = follow();
    a.next({ mission: M_ATTACK, x: 500, z: 500, status: ST_MARCH }, 0);
    expect(a.next({ status: ST_GATHER }, QUIET - 1)).toEqual([]);
    expect(a.next({ status: ST_SECURED }, QUIET - 0.5)).toEqual(['Alpha has taken P500-500']);
  });

  it('marks levels: taken and falling back are urgent, an acknowledged order is routine', () => {
    const a = follow();
    const c = { ...idle, mission: M_ATTACK, x: 5, z: 5, status: ST_MARCH };
    const [order] = a.reports.step(c, idle, 0);
    expect(order.level).toBe(SAY_ROUTINE);
    const [back] = a.reports.step({ ...c, status: ST_FALLBACK }, c, 50);
    expect(back.level).toBe(SAY_URGENT);
    expect(back.bad).toBe(true);
  });
});

/** A voice that takes `long` seconds over each line. */
function mouth(long = 2) {
  const said: string[] = [];
  let until = -1e9;
  let clock = 0;
  const m: Mouth = {
    busy: () => clock < until,
    say: (text) => {
      said.push(text);
      until = clock + long;
    },
    reset: () => {
      until = -1e9;
    },
  };
  return { m, said, at: (t: number) => (clock = t) };
}

describe('the spoken lines', () => {
  it('says a line that arrives while another is being said, instead of dropping it', () => {
    const v = mouth();
    const s = new Speaker(v.m);
    s.push('Base under attack', SAY_URGENT, 0);
    s.push('Alpha has taken Northgate', SAY_URGENT, 0.5);
    expect(v.said).toEqual(['Base under attack']);
    v.at(2.1);
    s.update(2.1);
    expect(v.said).toEqual(['Base under attack', 'Alpha has taken Northgate']);
  });

  it('lets the urgent line go first and drops what has gone stale', () => {
    const v = mouth(3);
    const s = new Speaker(v.m);
    s.push('one', SAY_NORMAL, 0);
    s.push('Bravo attacking Kirov', SAY_ROUTINE, 0.1);
    s.push('normal', SAY_NORMAL, 0.2);
    s.push('Alpha falling back', SAY_URGENT, 0.3);
    v.at(3.1);
    s.update(3.1);
    v.at(6.2);
    s.update(6.2);
    // The acknowledged order waited more than six seconds: no longer worth saying.
    v.at(9.3);
    s.update(9.3);
    v.at(12.4);
    s.update(12.4);
    expect(v.said).toEqual(['one', 'Alpha falling back', 'normal']);
  });

  it('does not let a big fight pile lines up, and never repeats what is waiting', () => {
    const v = mouth(100);
    const s = new Speaker(v.m);
    s.push('first', SAY_NORMAL, 0);
    expect(s.push('a', SAY_ROUTINE, 0)).toBe(true);
    expect(s.push('a', SAY_ROUTINE, 0)).toBe(false);
    expect(s.push('b', SAY_ROUTINE, 0)).toBe(true);
    expect(s.push('c', SAY_ROUTINE, 0)).toBe(false);
    for (const t of ['d', 'e']) expect(s.push(t, SAY_NORMAL, 0)).toBe(true);
    expect(s.push('f', SAY_NORMAL, 0)).toBe(false);
    // An urgent line always gets in, at the cost of the least urgent one waiting.
    for (const t of ['u1', 'u2', 'u3']) expect(s.push(t, SAY_URGENT, 0)).toBe(true);
    expect(s.waiting).toBe(6);
  });

  it('frees a voice that has hung', () => {
    const v = mouth(1e6);
    const s = new Speaker(v.m);
    s.push('one', SAY_URGENT, 0);
    s.push('two', SAY_URGENT, 1);
    v.at(13);
    s.update(13);
    expect(v.said).toEqual(['one', 'two']);
  });
});
