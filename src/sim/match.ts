// One description of a game (decision 140): the map, the seed, the night and the weather,
// every army with its faction and who plays it, and every player with the army he commands.
// The address of the page is read into one, the menu and the lobby edit one, the host sends
// it to the guests, and `createGame` builds the world, the computers and the staffs from it.
// Nothing else says what is being played.
import { aiThink, createAi, type Ai, type AiLevel } from './ai';
import { CMD_FACTION, CMD_NIGHT, CMD_WEATHER, type Command } from './commands';
import { FACTIONS } from './factions';
import { authorize } from './guard';
import { generateMap, mapInfo, type Layout } from './map';
import { assaultCommands, battleCommands, skirmishCommands, stressTestCommands } from './scenarios';
import { step } from './sim';
import { createStaff, staffThink, type Staff } from './staff';
import { MAX_TEAMS, MAX_UNITS, createWorld, type World } from './world';

/** assault: storm a held town. clash: two armies meet head on. roam: stress test. */
/** skirmish: build a base and beat whoever else is on the map, from an even start. */
export type Scenario = 'skirmish' | 'assault' | 'clash' | 'roam';

export const SCENARIOS: readonly Scenario[] = ['skirmish', 'assault', 'clash', 'roam'];
export const AI_LEVELS: readonly AiLevel[] = ['recruit', 'easy', 'normal', 'hard'];
/** The most players in one game, the host included. */
export const MAX_PLAYERS = 4;
/** The roles a player can pick (DUTIES in client/net.ts). */
export const DUTY_COUNT = 5;
/** The weathers there are (units.ts WEATHER_*): clear, rain, fog, snow. */
const WEATHERS = 4;

/**
 * Who runs an army. `human`: its players, and a staff for the commanders they appoint.
 * `ai`: the computer, at `level`. `none`: nobody (it stands where the scenario put it).
 */
export type Controller = 'human' | 'ai' | 'none';

export interface ArmySetup {
  /** Its faction (factions.ts), 0 for the plain roster. */
  faction: number;
  controller: Controller;
  /** For a computer: how good it is. */
  level?: AiLevel;
}

export interface PlayerSetup {
  /** The army he commands (an index into `armies`). */
  army: number;
  /** The role he said he would look after (advice to his team, not a lock). */
  duty: number;
}

export interface Match {
  seed: number;
  map: Layout;
  scenario: Scenario;
  /** How many units the measuring scenarios (assault, clash, roam) put on the field. */
  units: number;
  night: boolean;
  /** WEATHER_* (units.ts). */
  weather: number;
  /** Two to four armies. The skirmish gives each a base; army 0 is red, 1 blue. */
  armies: ArmySetup[];
  /** The players by seat: seat 0 is the host, or the only player of a game alone. */
  players: PlayerSetup[];
}

/** A game alone against one computer, in the city, by day: what the other choices start from. */
export function defaultMatch(): Match {
  return {
    seed: 1,
    map: 'city',
    scenario: 'skirmish',
    units: 3000,
    night: false,
    weather: 0,
    armies: [
      { faction: 0, controller: 'human' },
      { faction: 0, controller: 'ai', level: 'easy' },
    ],
    players: [{ army: 0, duty: 0 }],
  };
}

const isInt = (v: unknown, lo: number, hi: number): v is number =>
  Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

/**
 * Whether `v` is a match this game can play: checked wherever one arrives from outside (the
 * host's message to a guest), so nothing else has to doubt a Match it is handed.
 */
export function validMatch(v: unknown): v is Match {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  if (!isInt(m.seed, -(2 ** 31), 2 ** 31 - 1)) return false;
  if (!mapInfo(m.map) || !SCENARIOS.includes(m.scenario as Scenario)) return false;
  if (!isInt(m.units, 0, MAX_UNITS) || typeof m.night !== 'boolean') return false;
  if (!isInt(m.weather, 0, WEATHERS - 1)) return false;
  const { armies, players } = m;
  if (!Array.isArray(armies) || armies.length < 2 || armies.length > MAX_TEAMS) return false;
  for (const a of armies as unknown[]) {
    if (typeof a !== 'object' || a === null) return false;
    const army = a as Record<string, unknown>;
    if (!isInt(army.faction, 0, FACTIONS.length - 1)) return false;
    if (army.controller === 'ai') {
      if (!AI_LEVELS.includes(army.level as AiLevel)) return false;
    } else if (army.controller !== 'human' && army.controller !== 'none') return false;
  }
  if (!Array.isArray(players) || players.length < 1 || players.length > MAX_PLAYERS) return false;
  for (const p of players as unknown[]) {
    if (typeof p !== 'object' || p === null) return false;
    const player = p as Record<string, unknown>;
    if (!isInt(player.army, 0, armies.length - 1) || !isInt(player.duty, 0, DUTY_COUNT - 1)) {
      return false;
    }
  }
  return true;
}

/** Players against players and no computer (decision 114): each side sees only its own. */
export function isVersus(m: Match): boolean {
  const played = new Set(m.players.map((p) => p.army));
  return played.size > 1 && !m.armies.some((a) => a.controller === 'ai');
}

/** The seats that command `army`. */
export function seatsOf(m: Match, army: number): number[] {
  const out: number[] = [];
  m.players.forEach((p, seat) => {
    if (p.army === army) out.push(seat);
  });
  return out;
}

/** The orders the game itself gives on the first tick: the setting, then the armies' start. */
export function openingCommands(m: Match, w: World): Command[] {
  const cmds: Command[] =
    m.scenario === 'roam'
      ? stressTestCommands(m.units)
      : m.scenario === 'clash'
        ? battleCommands(m.units)
        : m.scenario === 'assault'
          ? assaultCommands(w.map, m.units)
          : skirmishCommands(w.map, m.armies.length);
  if (m.night) cmds.unshift({ type: CMD_NIGHT, on: true });
  if (m.weather > 0) cmds.unshift({ type: CMD_WEATHER, weather: m.weather });
  m.armies.forEach((army, team) => {
    if (army.faction > 0) cmds.unshift({ type: CMD_FACTION, team, faction: army.faction });
  });
  return cmds;
}

/** A game being played: the world, and for each army the computer or the staff that runs it. */
export interface Game {
  readonly match: Match;
  readonly world: World;
  /** By army: its computer, or null. */
  readonly ais: (Ai | null)[];
  /** By army: the staff of its players' commanders, or null. */
  readonly staffs: (Staff | null)[];
  /**
   * An order from the player in `seat`, who was looking at the picture of tick `seen`: the
   * order signed with his seat and his army, as it may go in on a tick, or null if it is not
   * his to give (src/sim/guard.ts).
   */
  sign(raw: unknown, seat: number, seen?: number): Command | null;
  /** One tick: the players' orders, then the computers', then the staffs'; the world moves. */
  tick(orders: readonly Command[]): void;
}

/** Sign what a computer or a staff has just handed in: it plays by the players' rules. */
function signFrom(out: Command[], from: number, army: number): void {
  for (let k = from; k < out.length; k++) out[k].army = army;
}

export function createGame(match: Match): Game {
  const world = createWorld(match.seed, generateMap(match.seed, match.map));
  let pending = openingCommands(match, world);
  const n = match.armies.length;
  const ais: (Ai | null)[] = new Array<Ai | null>(n).fill(null);
  const staffs: (Staff | null)[] = new Array<Staff | null>(n).fill(null);
  const skirmish = match.scenario === 'skirmish';
  for (let t = 0; t < n; t++) {
    const army = match.armies[t];
    if (army.controller === 'ai' && skirmish && world.map.startX[t] >= 0) {
      // The computer is strengthened for the number of players it faces (decision 100).
      const facing = match.players.filter((p) => p.army !== t).length;
      ais[t] = createAi(t, army.level ?? 'easy', match.seed, Math.max(1, facing));
    } else if (army.controller === 'human') {
      staffs[t] = createStaff(t, match.seed);
    }
  }
  // The order they think in is part of the game: the computers of armies 1 and up, then
  // army 0's, then the staffs. It is the order the worker always ran them in.
  const thinkers: number[] = [];
  for (let t = 1; t < n; t++) if (ais[t]) thinkers.push(t);
  if (ais[0]) thinkers.push(0);
  const tick = (orders: readonly Command[]): void => {
    for (const c of orders) pending.push(c);
    for (const t of thinkers) {
      const from = pending.length;
      aiThink(ais[t] as Ai, world, pending);
      signFrom(pending, from, t);
    }
    for (let t = 0; t < n; t++) {
      const staff = staffs[t];
      if (!staff) continue;
      const from = pending.length;
      staffThink(staff, world, pending);
      signFrom(pending, from, t);
    }
    step(world, pending);
    pending = [];
  };
  const sign = (raw: unknown, seat: number, seen?: number): Command | null => {
    const player = match.players[seat];
    return player ? authorize(world, raw, player.army, seat, seen) : null;
  };
  return { match, world, ais, staffs, sign, tick };
}
