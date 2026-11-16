// The order path's guard (security review, findings 4 and 5).
//
// `validCommand` is a shape check every sim runs on every order before it applies it: an
// order that is not an object of a known type, or whose lists are not lists of numbers,
// is skipped. Every machine skips it alike, so a bad order can no longer stop the clock of
// a shared game, nor make the machines differ.
//
// `authorize` is what the host asks of an order that came from another player's browser,
// before it goes into the game: is it his to give? It refuses the orders that only the
// game's own setup may give, orders for another army, and units, carriers and buildings
// that are not his army's, and it signs the order with the seat it came from. Orders the
// host gives himself, and those of the computer, never pass through it.
import {
  CMD_ASSIGN,
  CMD_ATTACK,
  CMD_ATTACK_MOVE,
  CMD_ATTACK_STRUCTURE,
  CMD_ASSIST,
  CMD_BOMBARD,
  CMD_BREACH,
  CMD_BUILD,
  CMD_CAMERA,
  CMD_CANCEL,
  CMD_DEMOLISH,
  CMD_DEST,
  CMD_ENTRENCH,
  CMD_FACTION,
  CMD_FELL,
  CMD_FIELDWORK,
  CMD_FORTIFY,
  CMD_FOUND,
  CMD_GARRISON,
  CMD_GATHER,
  CMD_HOLD,
  CMD_KEEP,
  CMD_LOAD,
  CMD_MISSION,
  CMD_MOVE,
  CMD_NIGHT,
  CMD_OCCUPY,
  CMD_ORDER,
  CMD_PARADROP,
  CMD_RALLY,
  CMD_REINFORCE,
  CMD_REPEAT,
  CMD_RESEARCH,
  CMD_SPAWN,
  CMD_STANCE,
  CMD_STOP,
  CMD_STYLE,
  CMD_TRAIN,
  CMD_UNLOAD,
  CMD_WEATHER,
  type Command,
} from './commands';
import type { World } from './world';

/** For each order type: the lists it must carry. */
const LISTS: Record<number, readonly string[]> = {
  [CMD_MOVE]: ['units'],
  [CMD_STOP]: ['units'],
  [CMD_SPAWN]: [],
  [CMD_ATTACK_MOVE]: ['units'],
  [CMD_GARRISON]: ['units'],
  [CMD_ATTACK_STRUCTURE]: ['units'],
  [CMD_LOAD]: ['units', 'carriers'],
  [CMD_UNLOAD]: ['units'],
  [CMD_BOMBARD]: ['units'],
  [CMD_HOLD]: ['units'],
  [CMD_GATHER]: ['units'],
  [CMD_BUILD]: ['units'],
  [CMD_ASSIST]: ['units'],
  [CMD_TRAIN]: [],
  [CMD_CANCEL]: [],
  [CMD_RALLY]: [],
  [CMD_RESEARCH]: [],
  [CMD_STANCE]: ['units'],
  [CMD_FOUND]: [],
  [CMD_ATTACK]: ['units'],
  [CMD_FORTIFY]: ['units', 'cells'],
  [CMD_DEMOLISH]: ['cells'],
  [CMD_BREACH]: ['units'],
  [CMD_OCCUPY]: ['units'],
  [CMD_FIELDWORK]: ['cells'],
  [CMD_REPEAT]: [],
  [CMD_CAMERA]: ['units'],
  [CMD_ORDER]: [],
  [CMD_KEEP]: [],
  [CMD_DEST]: [],
  [CMD_ASSIGN]: ['units'],
  [CMD_MISSION]: [],
  [CMD_REINFORCE]: [],
  [CMD_ENTRENCH]: ['units'],
  [CMD_PARADROP]: [],
  [CMD_STYLE]: [],
  [CMD_NIGHT]: [],
  [CMD_FACTION]: [],
  [CMD_FELL]: ['units'],
  [CMD_WEATHER]: [],
};

/** Fields that, when present, must be numbers; and those that must be true or false. */
const NUMBERS = [
  'x',
  'y',
  'team',
  'structure',
  'target',
  'site',
  'building',
  'kind',
  'count',
  'radius',
  'advanceX',
  'advanceY',
  'garrisonTown',
  'stance',
  'work',
  'slot',
  'mission',
  'style',
  'dest',
  'faction',
  'weather',
  'by',
] as const;
const FLAGS = ['queue', 'smoke', 'flare', 'on', 'wander'] as const;

/** No list in an order is longer: there are never more units than this. */
export const MAX_LIST = 16384;

function numberList(v: unknown, max: number): boolean {
  if (!Array.isArray(v) || v.length > max) return false;
  for (let k = 0; k < v.length; k++) if (typeof v[k] !== 'number') return false;
  return true;
}

/**
 * Whether `c` has the shape of an order the sim can apply without throwing. Every order a
 * player, the computer or a scenario legally gives passes unchanged.
 */
export function validCommand(c: unknown): c is Command {
  if (typeof c !== 'object' || c === null || Array.isArray(c)) return false;
  const o = c as Record<string, unknown>;
  const lists = typeof o.type === 'number' ? LISTS[o.type] : undefined;
  if (!lists) return false;
  for (const name of lists) if (!numberList(o[name], MAX_LIST)) return false;
  for (const name of NUMBERS) {
    const v = o[name];
    if (v !== undefined && typeof v !== 'number') return false;
  }
  for (const name of FLAGS) {
    const v = o[name];
    if (v !== undefined && typeof v !== 'boolean') return false;
  }
  return true;
}

/** Orders only the game's own setup gives: never accepted from another player. */
const SETUP = new Set([CMD_SPAWN, CMD_FOUND, CMD_FIELDWORK, CMD_NIGHT, CMD_WEATHER, CMD_FACTION]);
/** Orders to a whole army, which name it. */
const ARMY = new Set([
  CMD_ORDER,
  CMD_KEEP,
  CMD_DEST,
  CMD_MISSION,
  CMD_STYLE,
  CMD_REINFORCE,
  CMD_PARADROP,
  CMD_DEMOLISH,
]);
/** Orders to one of the army's own buildings. */
const OWN_BUILDING = new Set([CMD_TRAIN, CMD_CANCEL, CMD_RALLY, CMD_RESEARCH, CMD_REPEAT]);
/** The most cells a player can mark in one order. */
const MAX_CELLS = 4096;

const finite = (v: unknown): boolean => v === undefined || Number.isFinite(v);

/**
 * Host: the order `raw` came from the player in `seat`, who commands army `team`. Returns
 * the order as it may go into the game, or null if it may not. Only units (and carriers) of
 * his army are kept; an order left with none is refused.
 */
export function authorize(w: World, raw: unknown, team: number, seat: number): Command | null {
  if (!validCommand(raw)) return null;
  const o = raw as unknown as Record<string, unknown>;
  for (const name of NUMBERS) if (!finite(o[name])) return null;
  const type = raw.type;
  if (SETUP.has(type)) return null;
  if (ARMY.has(type) && o.team !== team) return null;
  if (OWN_BUILDING.has(type)) {
    const s = o.structure as number;
    if (!Number.isInteger(s) || s < 0 || s >= w.map.structCount || w.sTeam[s] !== team) {
      return null;
    }
  }
  const out = { ...o } as Record<string, unknown>;
  for (const name of ['units', 'carriers'] as const) {
    if (!(name in o)) continue;
    const ids = (o[name] as number[]).filter(
      (id) => Number.isInteger(id) && id >= 0 && id < w.count && w.team[id] === team,
    );
    if (ids.length === 0) return null;
    out[name] = ids;
  }
  if ('cells' in o) {
    const cells = o.cells as number[];
    if (cells.length > MAX_CELLS || !cells.every(Number.isInteger)) return null;
  }
  // Who gave it is not his to say: it is the seat the order came from.
  out.by = seat;
  return out as unknown as Command;
}
