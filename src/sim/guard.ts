// The order path's guard (security review, findings 4 and 5; decision 140).
//
// `validCommand` is a shape check every sim runs on every order before it applies it: an
// order that is not an object of a known type, or whose lists are not lists of numbers,
// is skipped. Every machine skips it alike, so a bad order can no longer stop the clock of
// a shared game, nor make the machines differ.
//
// `admit` is the ownership check, and every sim runs it too, on every order that says which
// army gave it: is it that army's to give? It refuses the orders that only the game's own
// setup may give, orders for another army, and units, carriers and buildings that are not
// that army's, or that came into the world after the player last looked. Because it runs
// inside the sim, on every machine alike, "whose unit is this" has one answer.
//
// `authorize` is the door an order from a player comes in by, at the sim that takes it in
// (his own, or the host's in a shared game): it signs the order with the seat and the army
// it came from (never the sender's own word for it) and turns it away there and then if
// `admit` would refuse it.
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
  CMD_GIVE,
  CMD_DUTY,
  CMD_HOLD,
  CMD_KEEP,
  CMD_LOAD,
  CMD_MARCH,
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
  CMD_SHAPE,
  CMD_SPAWN,
  CMD_STANCE,
  CMD_STOP,
  CMD_STYLE,
  CMD_TRAIN,
  CMD_UNLOAD,
  CMD_WEATHER,
  type Command,
} from './commands';
import { MAX_TEAMS, type World } from './world';

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
  [CMD_GIVE]: ['units'],
  [CMD_DUTY]: [],
  [CMD_SHAPE]: ['units'],
  [CMD_MARCH]: [],
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
  'to',
  'duty',
  'shape',
  'by',
  'army',
  'seen',
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
  CMD_MARCH,
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
 * The order `c` as its army may give it, or null if it may not. An order that names no
 * army is the game's own and passes as it is. Of a signed one only the units (and carriers)
 * of its army are kept, and of those only the ones the player can have meant; an order left
 * with none is refused. Never changes `c`: the same order may be on its way to another sim.
 */
export function admit(w: World, c: Command): Command | null {
  const army = c.army;
  if (army === undefined) return c;
  const o = c as unknown as Record<string, unknown>;
  const refuse = (): null => {
    w.refused++;
    return null;
  };
  if (!Number.isInteger(army) || army < 0 || army >= MAX_TEAMS) return refuse();
  const type = c.type;
  if (SETUP.has(type)) return refuse();
  if (ARMY.has(type) && o.team !== army) return refuse();
  if (OWN_BUILDING.has(type)) {
    const s = o.structure as number;
    if (!Number.isInteger(s) || s < 0 || s >= w.map.structCount || w.sTeam[s] !== army) {
      return refuse();
    }
  }
  if ('cells' in o) {
    const cells = o.cells as number[];
    if (cells.length > MAX_CELLS || !cells.every(Number.isInteger)) return refuse();
  }
  const seen = Number.isInteger(c.seen) ? (c.seen as number) : -1;
  const his = (id: number): boolean =>
    Number.isInteger(id) &&
    id >= 0 &&
    id < w.count &&
    w.team[id] === army &&
    (seen < 0 || w.born[id] < seen);
  let out: Record<string, unknown> | null = null;
  for (const name of ['units', 'carriers'] as const) {
    if (!(name in o)) continue;
    const ids = o[name] as number[];
    let ok = 0;
    for (let k = 0; k < ids.length; k++) if (his(ids[k])) ok++;
    if (ok === 0) return refuse();
    if (ok === ids.length) continue;
    out ??= { ...o };
    out[name] = ids.filter(his);
  }
  if (out === null) return c;
  w.refused++;
  return out as unknown as Command;
}

/**
 * The order `raw` came from the player in `seat`, who commands `army`, looking at the
 * picture of tick `seen` (his own word, and only ever used to leave units out). Returns the
 * order signed, as it may go into the game, or null if it may not.
 */
export function authorize(
  w: World,
  raw: unknown,
  army: number,
  seat: number,
  seen?: number,
): Command | null {
  if (!validCommand(raw)) return null;
  const o = raw as unknown as Record<string, unknown>;
  for (const name of NUMBERS) if (!finite(o[name])) return null;
  // Who gave it is not his to say: it is the seat, and the army, the order came from.
  const signed = { ...o, by: seat, army } as Record<string, unknown>;
  const at = seen ?? o.seen;
  if (Number.isInteger(at) && (at as number) >= 0) signed.seen = at;
  else delete signed.seen;
  const refused = w.refused;
  const out = admit(w, signed as unknown as Command);
  // Turned away at the door: it never went into the game, so it is not counted in it.
  w.refused = refused;
  return out;
}
