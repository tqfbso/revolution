// The address of the page as a Match and back (decision 138). A battle is still asked for
// by loading the page with its choices in the address, as the links and the test flags
// always did; this is the one place that reads those choices and the one that writes them.
import type { AiLevel } from '../sim/ai';
import { FACTIONS, factionByName } from '../sim/factions';
import type { Layout } from '../sim/map';
import { AI_LEVELS, isVersus, type ArmySetup, type Match, type Scenario } from '../sim/match';
import { WEATHER_NAMES } from '../sim/units';
import { MAX_TEAMS, MAX_UNITS } from '../sim/world';

export const MAP_LABEL: Record<string, string> = {
  city: 'City',
  euro: 'European city',
  ridge: 'Ridge',
  river: 'River',
  four: 'Four corners',
};

/** The keys of an address that describe the battle itself. */
export const MATCH_KEYS = [
  'seed',
  'map',
  'scenario',
  'units',
  'demo',
  'ai',
  'armies',
  'time',
  'weather',
  'army',
  'foe',
  'foe2',
  'foe3',
] as const;

/** `?ai=` as one of the opponents there are: anything else is the default, easy. */
function aiLevel(level: string | null): AiLevel | 'off' {
  return level === 'off' || AI_LEVELS.includes(level as AiLevel) ? (level as AiLevel) : 'easy';
}

/** The faction the third and fourth armies take when none is named: the next in turn. */
const nextFaction = (before: number, second: number): number => (second > 0 ? (before % 3) + 1 : 0);

/**
 * The game an address asks for, played alone: `?map=`, `?armies=`, `?ai=`, `?army=` (red's
 * faction), `?foe=` (blue's), `?foe2=` and `?foe3=` (the third and fourth armies'),
 * `?time=night`, `?weather=`, `?seed=`, and for the measuring games `?scenario=`,
 * `?units=` and `?demo=1` (the computer plays red as well).
 */
export function matchFromParams(params: URLSearchParams): Match {
  const wanted = params.get('scenario');
  const scenario: Scenario =
    wanted === 'roam' || wanted === 'clash' || wanted === 'assault' ? wanted : 'skirmish';
  const skirmish = scenario === 'skirmish';
  // `?armies=3|4`: a free-for-all (decision 124), every army for itself, on the map with
  // four corners.
  const n = skirmish ? Math.min(Math.max(Number(params.get('armies') ?? 2) | 0, 2), MAX_TEAMS) : 2;
  // The skirmish is fought in the city unless another map is asked for; the other
  // scenarios are laid out for the river.
  const asked = n > 2 ? 'four' : params.get('map');
  const map: Layout =
    !skirmish || asked === 'river'
      ? 'river'
      : asked === 'four' || asked === 'ridge' || asked === 'euro'
        ? asked
        : 'city';
  // Only the skirmish has factions and weather: the measuring scenarios keep the plain
  // table and the clear day their numbers were taken on (`none` gives the table here too).
  const pick = (key: string, fallback: string): number =>
    skirmish ? factionByName(params.get(key) ?? fallback) : 0;
  const factions = [pick('army', 'nato'), pick('foe', 'russia')];
  for (let t = 2; t < n; t++) {
    const named = params.get(`foe${t}`);
    factions.push(named === null ? nextFaction(factions[t - 1], factions[1]) : pick(`foe${t}`, ''));
  }
  const level = aiLevel(params.get('ai'));
  const computer = (faction: number): ArmySetup =>
    skirmish && level !== 'off'
      ? { faction, controller: 'ai', level }
      : { faction, controller: 'none' };
  const weather = WEATHER_NAMES.indexOf((params.get('weather') ?? '') as 'rain');
  return {
    seed: Number(params.get('seed') ?? 1) | 0,
    map,
    scenario,
    units: Math.min(Math.max(Number(params.get('units') ?? 3000) | 0, 0), MAX_UNITS),
    night: params.get('time') === 'night',
    weather: skirmish && weather > 0 ? weather : 0,
    armies: factions.map((faction, t) =>
      t > 0 || params.get('demo') === '1' ? computer(faction) : { faction, controller: 'human' },
    ),
    players: [{ army: 0, duty: 0 }],
  };
}

/** Write `m` into an address, so that `matchFromParams` reads the same game out of it. */
export function matchToParams(m: Match, into = new URLSearchParams()): URLSearchParams {
  for (const k of MATCH_KEYS) into.delete(k);
  const skirmish = m.scenario === 'skirmish';
  if (m.seed !== 1) into.set('seed', String(m.seed));
  if (!skirmish) {
    into.set('scenario', m.scenario);
    into.set('units', String(m.units));
  } else {
    into.set('map', m.map);
    if (m.armies.length > 2) into.set('armies', String(m.armies.length));
    into.set('army', FACTIONS[m.armies[0].faction].short);
    into.set('foe', FACTIONS[m.armies[1].faction].short);
    for (let t = 2; t < m.armies.length; t++) {
      const usual = nextFaction(m.armies[t - 1].faction, m.armies[1].faction);
      if (m.armies[t].faction !== usual) into.set(`foe${t}`, FACTIONS[m.armies[t].faction].short);
    }
    if (m.weather > 0) into.set('weather', WEATHER_NAMES[m.weather]);
    const computer = m.armies.find((a, t) => t > 0 && a.controller === 'ai');
    // A game between players has no opponent to name.
    if (computer) into.set('ai', computer.level ?? 'easy');
    else if (m.armies[1].controller === 'none') into.set('ai', 'off');
  }
  if (m.night) into.set('time', 'night');
  if (m.armies[0].controller !== 'human') into.set('demo', '1');
  return into;
}

/** The opponent as the end screen and the lobby name it. */
export function opponentOf(m: Match): AiLevel | 'off' {
  return m.armies.find((a) => a.controller === 'ai')?.level ?? 'off';
}

/** The battlefield in a few words: the map, the time of day and the weather. */
export function fieldLabel(m: Match): string {
  return (
    `${MAP_LABEL[m.map]} · ${m.night ? 'night' : 'day'}` +
    `${m.weather > 0 ? ` · ${WEATHER_NAMES[m.weather]}` : ''}`
  );
}

/** The whole game in a few words, for the end screen and the last-battle corner. */
export function matchLabel(m: Match): string {
  const shared = m.players.length > 1;
  return (
    `${fieldLabel(m)} · ` +
    `${isVersus(m) ? 'versus' : `${shared ? 'co-op, ' : ''}${opponentOf(m)} AI`}`
  );
}
