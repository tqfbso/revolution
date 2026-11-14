import { describe, expect, it } from 'vitest';
import {
  CMD_ASSIGN,
  CMD_DEST,
  CMD_FOUND,
  CMD_MISSION,
  CMD_ORDER,
  CMD_REINFORCE,
  CMD_SPAWN,
  type Command,
} from '../src/sim/commands';
import { B_BARRACKS, B_DEPOT, B_HQ } from '../src/sim/economy';
import { fx } from '../src/sim/fixed';
import { flatMap, generateMap } from '../src/sim/map';
import { skirmishCommands } from '../src/sim/scenarios';
import { step } from '../src/sim/sim';
import {
  ST_ATTACK,
  ST_DEFEND,
  ST_FALLBACK,
  ST_GATHER,
  ST_HOLD,
  ST_MARCH,
  ST_PATROL,
  ST_REGROUP,
  ST_SCREEN,
  ST_SECURED,
  createStaff,
  staffThink,
  type Staff,
} from '../src/sim/staff';
import { KIND_DRONE, KIND_IFV, KIND_INFANTRY, KIND_STRIKE, KIND_TANK } from '../src/sim/units';
import {
  CF_AUTO,
  DEST_COMMANDER,
  KIND_SLOTS,
  MAX_COMMANDERS,
  M_ATTACK,
  M_DEFEND,
  M_HOLD,
  M_PATROL,
  M_SCREEN,
  STATE_ALIVE,
  TICK_RATE,
  createWorld,
  hashWorld,
  type World,
} from '../src/sim/world';

const spawn = (team: number, kind: number, count: number, x: number, y: number): Command => ({
  type: CMD_SPAWN,
  count,
  team,
  kind,
  x: fx(x),
  y: fx(y),
  radius: fx(6),
  wander: false,
});

/** The ridge map with both headquarters and nothing else: the player's staff, no computer. */
function field(): { w: World; st: Staff } {
  const w = createWorld(3, generateMap(3, 'ridge'));
  step(
    w,
    skirmishCommands(w.map).filter((c) => c.type === CMD_FOUND),
  );
  return { w, st: createStaff(0, 3) };
}

/** Units of `team` spawned by the next step: their ids. */
function add(w: World, cmds: Command[]): number[] {
  const from = w.count;
  step(w, cmds);
  const ids: number[] = [];
  for (let i = from; i < w.count; i++) ids.push(i);
  return ids;
}

function play(w: World, st: Staff, seconds: number, each?: () => void): void {
  for (let t = 0; t < seconds * TICK_RATE; t++) {
    const out: Command[] = [];
    staffThink(st, w, out);
    step(w, out);
    each?.();
  }
}

const alive = (w: World, ids: number[]) => ids.filter((i) => w.state[i] === STATE_ALIVE).length;
const town = (w: World, name: string) => w.map.townName.indexOf(name);
const mission = (slot: number, m: number, x: number, y: number): Command => ({
  type: CMD_MISSION,
  team: 0,
  slot,
  mission: m,
  x,
  y,
});

describe('sub-commanders: the game state', () => {
  it('keeps a roll of who answers to whom, and an establishment that follows it up', () => {
    const { w } = field();
    const ids = add(w, [spawn(0, KIND_INFANTRY, 6, 300, 760), spawn(0, KIND_TANK, 2, 300, 770)]);
    step(w, [{ type: CMD_ASSIGN, units: ids, slot: 2 }]);
    expect(ids.every((i) => w.cmdr[i] === 2)).toBe(true);
    const est = (slot: number, kind: number) => w.cEst[slot * KIND_SLOTS + kind];
    expect(est(2, KIND_INFANTRY)).toBe(6);
    expect(est(2, KIND_TANK)).toBe(2);
    // Taken back by the player: off the roll, and no longer to be replaced.
    step(w, [{ type: CMD_ASSIGN, units: ids.slice(0, 2), slot: -1 }]);
    expect(w.cmdr[ids[0]]).toBe(-1);
    expect(est(2, KIND_INFANTRY)).toBe(4);
    // Moved to another commander.
    step(w, [{ type: CMD_ASSIGN, units: [ids[7]], slot: 0 }]);
    expect(est(2, KIND_TANK)).toBe(1);
    expect(est(0, KIND_TANK)).toBe(1);
    // Disbanded: everyone is the player's again.
    step(w, [mission(2, -1, 0, 0)]);
    expect(ids.filter((i) => w.cmdr[i] === 2).length).toBe(0);
    expect(est(2, KIND_INFANTRY)).toBe(0);
    // Nonsense is ignored.
    step(w, [
      { type: CMD_ASSIGN, units: [99999, -4], slot: 1 },
      { type: CMD_ASSIGN, units: ids, slot: MAX_COMMANDERS },
      mission(MAX_COMMANDERS, M_ATTACK, 0, 0),
      mission(0, 99, 0, 0),
    ]);
    expect(w.cMission[0]).toBe(0);
    expect(w.cmdr[ids[3]]).toBe(-1);
  });

  it('sends new units to a commander, and replaces the losses of one who asks', () => {
    const w = createWorld(5, flatMap());
    const found = (building: number, x: number, y: number) =>
      ({ type: CMD_FOUND, team: 0, building, x, y }) as const;
    step(w, [found(B_HQ, 60, 60), found(B_DEPOT, 50, 60), found(B_BARRACKS, 70, 60)]);
    w.supplies[0] = 10000;
    const ids = add(w, [spawn(0, KIND_INFANTRY, 4, 300, 300)]);
    step(w, [
      { type: CMD_ASSIGN, units: ids, slot: 1 },
      { type: CMD_REINFORCE, team: 0, slot: 1, on: true },
    ]);
    expect(w.cFlags[1] & CF_AUTO).toBe(CF_AUTO);
    for (let t = 0; t < 200; t++) step(w, []);
    // At strength: nothing is ordered.
    expect(w.count).toBe(4);
    w.hp[ids[0]] = 0;
    w.hp[ids[1]] = 0;
    for (let t = 0; t < 60 * TICK_RATE; t++) step(w, []);
    const roll = [];
    for (let i = 0; i < w.count; i++)
      if (w.state[i] === STATE_ALIVE && w.cmdr[i] === 1) roll.push(i);
    expect(roll.length).toBe(4);
    // And no more than that: the two it lost, not a stream.
    let living = 0;
    for (let i = 0; i < w.count; i++) if (w.state[i] === STATE_ALIVE) living++;
    expect(living).toBe(4);
    // The production centre's "send to": the next squads join commander 3.
    step(w, [
      { type: CMD_DEST, team: 0, kind: KIND_INFANTRY, dest: DEST_COMMANDER + 3 },
      { type: CMD_ORDER, team: 0, kind: KIND_INFANTRY, count: 2 },
    ]);
    for (let t = 0; t < 60 * TICK_RATE; t++) step(w, []);
    let joined = 0;
    for (let i = 0; i < w.count; i++) if (w.state[i] === STATE_ALIVE && w.cmdr[i] === 3) joined++;
    expect(joined).toBe(2);
    expect(w.cEst[3 * KIND_SLOTS + KIND_INFANTRY]).toBe(2);
  });
});

describe('sub-commanders: the staff', () => {
  it('attack: marches as one body, takes the town, and holds it with infantry in the houses', () => {
    const { w, st } = field();
    const t = town(w, 'Westgate');
    const ids = add(w, [
      spawn(0, KIND_INFANTRY, 12, 250, 770),
      spawn(0, KIND_IFV, 3, 262, 780),
      spawn(1, KIND_INFANTRY, 3, 358, 682),
    ]).slice(0, 15);
    step(w, [
      { type: CMD_ASSIGN, units: ids, slot: 0 },
      mission(0, M_ATTACK, w.map.townX[t], w.map.townY[t]),
    ]);
    const seen = new Set<number>();
    play(w, st, 240, () => seen.add(st.posts[0].status));
    expect(seen.has(ST_MARCH) || seen.has(ST_ATTACK)).toBe(true);
    expect(w.townOwner[t]).toBe(0);
    expect(st.posts[0].status).toBe(ST_SECURED);
    expect(ids.filter((i) => w.inside[i] >= 0).length).toBeGreaterThanOrEqual(6);
    expect(alive(w, ids)).toBeGreaterThanOrEqual(10);
  }, 60000);

  it('attack: waits short of the objective for its stragglers, then goes in as one body', () => {
    const { w, st } = field();
    const t = town(w, 'Westgate');
    // Most of the body is fast and close; a third of it is on foot, a long walk behind.
    const ids = add(w, [spawn(0, KIND_IFV, 13, 300, 740), spawn(0, KIND_INFANTRY, 7, 215, 815)]);
    step(w, [
      { type: CMD_ASSIGN, units: ids, slot: 0 },
      mission(0, M_ATTACK, w.map.townX[t], w.map.townY[t]),
    ]);
    let gathered = false;
    let up = -1;
    play(w, st, 300, () => {
      const p = st.posts[0];
      if (p.status === ST_GATHER) gathered = true;
      if (up < 0 && (p.status === ST_ATTACK || p.status === ST_SECURED)) {
        up = ids.filter(
          (i) => Math.hypot(w.posX[i] - p.cx, w.posY[i] - p.cy) < fx(70) || w.carrier[i] >= 0,
        ).length;
      }
    });
    expect(gathered).toBe(true);
    expect(up).toBeGreaterThanOrEqual(17);
  }, 60000);

  it('attack: breaks off against far too much, falls back and waits to be reinforced', () => {
    const { w, st } = field();
    const t = town(w, 'Ridgetop');
    const ids = add(w, [
      spawn(0, KIND_INFANTRY, 8, 420, 620),
      spawn(1, KIND_TANK, 14, 522, 522),
      spawn(1, KIND_INFANTRY, 20, 515, 530),
    ]).slice(0, 8);
    step(w, [
      { type: CMD_ASSIGN, units: ids, slot: 4 },
      mission(4, M_ATTACK, w.map.townX[t], w.map.townY[t]),
    ]);
    const seen = new Set<number>();
    play(w, st, 200, () => seen.add(st.posts[4].status));
    expect(seen.has(ST_FALLBACK)).toBe(true);
    expect(st.posts[4].status).toBe(ST_REGROUP);
    expect(st.posts[4].need).toBe(true);
    // What is left of it got away: it is nowhere near the town.
    const p = st.posts[4];
    expect(alive(w, ids)).toBeGreaterThan(0);
    expect(Math.hypot(p.cx - w.map.townX[t], p.cy - w.map.townY[t])).toBeGreaterThan(fx(60));
  }, 60000);

  it('hold: goes there, digs into the houses and stays put under attack', () => {
    const { w, st } = field();
    const t = town(w, 'Westgate');
    const ids = add(w, [spawn(0, KIND_INFANTRY, 10, 330, 700)]);
    step(w, [
      { type: CMD_ASSIGN, units: ids, slot: 1 },
      mission(1, M_HOLD, w.map.townX[t], w.map.townY[t]),
    ]);
    play(w, st, 60);
    expect(st.posts[1].status).toBe(ST_HOLD);
    expect(ids.filter((i) => w.inside[i] >= 0).length).toBeGreaterThanOrEqual(8);
    add(w, [spawn(1, KIND_TANK, 10, 420, 640)]);
    const foes: number[] = [];
    for (let i = 0; i < w.count; i++) if (w.team[i] === 1) foes.push(i);
    step(w, [{ type: 1, units: foes, x: w.map.townX[t], y: w.map.townY[t] } as Command]);
    const seen = new Set<number>();
    play(w, st, 60, () => seen.add(st.posts[1].status));
    expect(seen.has(ST_FALLBACK)).toBe(false);
  }, 60000);

  it('defend: goes out to meet a raid, gives ground to an army and comes back after', () => {
    const { w, st } = field();
    const t = town(w, 'Westgate');
    const x = w.map.townX[t];
    const y = w.map.townY[t];
    const ids = add(w, [spawn(0, KIND_IFV, 6, 350, 690), spawn(0, KIND_INFANTRY, 6, 356, 684)]);
    step(w, [{ type: CMD_ASSIGN, units: ids, slot: 0 }, mission(0, M_DEFEND, x, y)]);
    play(w, st, 20);
    expect(st.posts[0].status).toBe(ST_DEFEND);
    // A raid at the edge of the town: the vehicles go for it.
    const raid = add(w, [spawn(1, KIND_INFANTRY, 3, 400, 668)]);
    play(w, st, 60);
    expect(alive(w, raid)).toBe(0);
    // An army: too much. It falls back, then returns when the army has gone.
    const army = add(w, [spawn(1, KIND_TANK, 16, 392, 672)]);
    const seen = new Set<number>();
    play(w, st, 8, () => seen.add(st.posts[0].status));
    expect(seen.has(ST_FALLBACK)).toBe(true);
    expect(alive(w, ids)).toBeGreaterThan(0);
    // The army goes somewhere else (here: is lifted to the far corner of the map).
    for (const i of army) {
      w.posX[i] = fx(980);
      w.posY[i] = fx(980);
    }
    const after = new Set<number>();
    play(w, st, 150, () => after.add(st.posts[0].status));
    expect(after.has(ST_REGROUP)).toBe(true);
    expect(st.posts[0].status).toBe(ST_DEFEND);
  }, 60000);

  it('patrol: walks between where it stood and the point it was given, again and again', () => {
    const { w, st } = field();
    const ids = add(w, [spawn(0, KIND_IFV, 4, 300, 760)]);
    step(w, [{ type: CMD_ASSIGN, units: ids, slot: 0 }, mission(0, M_PATROL, fx(420), fx(760))]);
    let turns = 0;
    let last = 0;
    play(w, st, 240, () => {
      if (st.posts[0].f.wp !== last) turns++;
      last = st.posts[0].f.wp;
    });
    expect(st.posts[0].status).toBe(ST_PATROL);
    expect(turns).toBeGreaterThanOrEqual(2);
  }, 60000);

  it('screen: strings its troops out across the way from home', () => {
    const { w, st } = field();
    const ids = add(w, [spawn(0, KIND_INFANTRY, 9, 400, 640)]);
    step(w, [{ type: CMD_ASSIGN, units: ids, slot: 0 }, mission(0, M_SCREEN, fx(420), fx(620))]);
    play(w, st, 90);
    expect(st.posts[0].status).toBe(ST_SCREEN);
    let lo = Infinity;
    let hi = -Infinity;
    for (const i of ids) {
      // Along the line at right angles to home (228, 792) -> (420, 620).
      const along = (w.posX[i] - fx(420)) * 172 + (w.posY[i] - fx(620)) * 192;
      lo = Math.min(lo, along);
      hi = Math.max(hi, along);
    }
    expect((hi - lo) / 258 / fx(1)).toBeGreaterThan(100);
  }, 60000);

  // Fabio, 2026-11-14: drones given to a commander "keep moving weirdly, kind of back
  // and forth". A body of nothing but drones was sent to the place by one rule and told
  // to keep behind its own centre by another, for ever.
  it('a commander of nothing but drones flies to the place and stays there', () => {
    for (const kind of [KIND_STRIKE, KIND_DRONE]) {
      for (const m of [M_ATTACK, M_HOLD, M_DEFEND]) {
        const { w, st } = field();
        const ids = add(w, [spawn(0, kind, 6, 300, 1024)]);
        step(w, [{ type: CMD_ASSIGN, units: ids, slot: 0 }, mission(0, m, fx(550), fx(1024))]);
        const i = ids[0];
        let flown = 0;
        let x = w.posX[i];
        let y = w.posY[i];
        play(w, st, 90, () => {
          flown += Math.hypot(w.posX[i] - x, w.posY[i] - y);
          x = w.posX[i];
          y = w.posY[i];
        });
        expect(alive(w, ids)).toBe(6);
        for (const j of ids) {
          expect(Math.hypot(w.posX[j] - fx(550), w.posY[j] - fx(1024)) / fx(1)).toBeLessThan(40);
        }
        // 250 from where it started: it flew the distance about once, not seven times.
        expect(flown / fx(1)).toBeLessThan(300);
      }
    }
  }, 60000);

  it('is deterministic: the same game twice gives the same world', () => {
    const once = () => {
      const { w, st } = field();
      const t = town(w, 'Westgate');
      const ids = add(w, [
        spawn(0, KIND_INFANTRY, 12, 250, 770),
        spawn(0, KIND_TANK, 3, 262, 780),
        spawn(1, KIND_INFANTRY, 8, 358, 682),
      ]).slice(0, 15);
      step(w, [
        { type: CMD_ASSIGN, units: ids.slice(0, 10), slot: 0 },
        { type: CMD_ASSIGN, units: ids.slice(10), slot: 5 },
        mission(0, M_ATTACK, w.map.townX[t], w.map.townY[t]),
        mission(5, M_PATROL, fx(300), fx(700)),
      ]);
      play(w, st, 120);
      return hashWorld(w);
    };
    expect(once()).toBe(once());
  }, 60000);
});
