// The game loop as the sim worker ran it before there was a Match (decision 139), kept word
// for word so that the tests can hold the new one against it, hash for hash: the same armies,
// the same computers and staffs thinking in the same order, the same opening orders.
import { aiThink, createAi, type Ai, type AiLevel } from '../src/sim/ai';
import {
  CMD_ASSIGN,
  CMD_ATTACK_MOVE,
  CMD_FACTION,
  CMD_HOLD,
  CMD_KEEP,
  CMD_MISSION,
  CMD_MOVE,
  CMD_NIGHT,
  CMD_ORDER,
  CMD_STOP,
  CMD_WEATHER,
  type Command,
} from '../src/sim/commands';
import { fx } from '../src/sim/fixed';
import { CELL_SHIFT, generateMap, type Layout } from '../src/sim/map';
import {
  assaultCommands,
  battleCommands,
  skirmishCommands,
  stressTestCommands,
} from '../src/sim/scenarios';
import type { Match } from '../src/sim/match';
import { step } from '../src/sim/sim';
import { createStaff, staffThink, type Staff } from '../src/sim/staff';
import { KIND_INFANTRY, KIND_TRUCK } from '../src/sim/units';
import { MAX_TEAMS, M_ATTACK, STATE_ALIVE, createWorld, type World } from '../src/sim/world';

/** What the worker's `init` message used to carry. */
export interface LegacySetup {
  seed: number;
  layout: Layout;
  units?: number;
  scenario?: 'skirmish' | 'assault' | 'clash' | 'roam';
  ai: AiLevel | 'off';
  demo?: boolean;
  humans?: number;
  versus?: boolean;
  night?: boolean;
  weather?: number;
  armies?: number;
  factions?: number[];
}

export interface Runner {
  w: World;
  tick(orders: Command[]): void;
}

export function legacy(msg: LegacySetup): Runner {
  const scenario = msg.scenario ?? 'skirmish';
  const units = msg.units ?? 3000;
  const world = createWorld(msg.seed, generateMap(msg.seed, msg.layout));
  let pending: Command[] =
    scenario === 'roam'
      ? stressTestCommands(units)
      : scenario === 'clash'
        ? battleCommands(units)
        : scenario === 'assault'
          ? assaultCommands(world.map, units)
          : skirmishCommands(world.map, msg.versus ? 2 : (msg.armies ?? 2));
  if (msg.night) pending.unshift({ type: CMD_NIGHT, on: true });
  if (msg.weather) pending.unshift({ type: CMD_WEATHER, weather: msg.weather });
  (msg.factions ?? []).forEach((faction, team) => {
    if (faction > 0) pending.unshift({ type: CMD_FACTION, team, faction });
  });
  const ais: Ai[] = [];
  const versus = msg.versus === true && scenario === 'skirmish';
  if (scenario === 'skirmish' && msg.ai !== 'off' && !versus) {
    ais.push(createAi(1, msg.ai, msg.seed, msg.humans ?? 1));
    for (let t = 2; t < Math.min(msg.armies ?? 2, MAX_TEAMS); t++) {
      if (world.map.startX[t] >= 0) ais.push(createAi(t, msg.ai, msg.seed, msg.humans ?? 1));
    }
    if (msg.demo) ais.push(createAi(0, msg.ai, msg.seed));
  }
  const staff: Staff | null = msg.demo ? null : createStaff(0, msg.seed);
  const rival: Staff | null = versus ? createStaff(1, msg.seed) : null;
  const tick = (orders: Command[]): void => {
    for (const c of orders) pending.push(c);
    for (const ai of ais) aiThink(ai, world, pending);
    if (staff) staffThink(staff, world, pending);
    if (rival) staffThink(rival, world, pending);
    step(world, pending);
    pending = [];
    world.events.length = 0;
  };
  return { w: world, tick };
}

/** The same game as a Match: `seats` is the army each player commands. */
export function toMatch(msg: LegacySetup, seats: number[]): Match {
  const scenario = msg.scenario ?? 'skirmish';
  const skirmish = scenario === 'skirmish';
  const versus = msg.versus === true && skirmish;
  const n = skirmish && !versus ? Math.min(Math.max(msg.armies ?? 2, 2), MAX_TEAMS) : 2;
  const armies: Match['armies'] = [];
  for (let t = 0; t < n; t++) {
    const faction = msg.factions?.[t] ?? 0;
    if (versus) armies.push({ faction, controller: 'human' });
    else if (t === 0 && !msg.demo) armies.push({ faction, controller: 'human' });
    else if (skirmish && msg.ai !== 'off')
      armies.push({ faction, controller: 'ai', level: msg.ai });
    else armies.push({ faction, controller: 'none' });
  }
  return {
    seed: msg.seed,
    map: msg.layout,
    scenario,
    units: msg.units ?? 3000,
    night: msg.night === true,
    weather: msg.weather ?? 0,
    armies,
    players: (seats.length > 0 ? seats : [0]).map((army) => ({ army, duty: 0 })),
  };
}

/**
 * Orders as the player in `seat`, commanding `army`, could give them on this tick: all of
 * them to his own troops and his own army, so the sim's ownership check lets every one pass.
 */
export function playerOrders(w: World, army: number, seat: number): Command[] {
  const t = w.tick;
  const out: Command[] = [];
  if (t < 40 || (t + 13 * seat) % 50 !== 0) return out;
  let s = (Math.imul(t, 2654435761) ^ (seat * 977 + army * 31)) >>> 0;
  const next = (n: number) => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    return s % n;
  };
  const mine: number[] = [];
  for (let i = 0; i < w.count; i++) {
    if (w.state[i] === STATE_ALIVE && w.team[i] === army && w.kind[i] !== KIND_TRUCK) mine.push(i);
  }
  if (mine.length === 0) return out;
  const some = (n: number): number[] => {
    const from = next(mine.length);
    const units: number[] = [];
    for (let k = 0; k < Math.min(n, mine.length); k++) units.push(mine[(from + k) % mine.length]);
    return units;
  };
  const foe = (army + 1) % 2;
  const fx0 = (w.map.startX[foe] >= 0 ? w.map.startX[foe] : 128) << CELL_SHIFT;
  const fy0 = (w.map.startY[foe] >= 0 ? w.map.startY[foe] : 128) << CELL_SHIFT;
  const step50 = ((t + 13 * seat) / 50) | 0;
  if (step50 === 2) out.push({ type: CMD_ORDER, team: army, kind: KIND_INFANTRY, count: 6 });
  else if (step50 === 3) {
    out.push({ type: CMD_ASSIGN, units: some(8), slot: seat % 4 });
    out.push({ type: CMD_MISSION, team: army, slot: seat % 4, mission: M_ATTACK, x: fx0, y: fy0 });
  } else if (step50 === 5) out.push({ type: CMD_KEEP, team: army, kind: KIND_INFANTRY, count: 14 });
  else {
    const kind = next(6);
    if (kind === 0) out.push({ type: CMD_STOP, units: some(4) });
    else if (kind === 1) out.push({ type: CMD_HOLD, units: some(4) });
    else
      out.push({
        type: kind < 4 ? CMD_MOVE : CMD_ATTACK_MOVE,
        units: some(6),
        x: fx(150 + next(700)),
        y: fx(150 + next(700)),
        queue: kind === 3 ? true : undefined,
      });
  }
  for (const c of out) c.by = seat;
  return out;
}
