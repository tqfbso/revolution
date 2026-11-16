// The screens before a battle (decision 127): the main menu, the new battle screen where
// the map, the armies, the time, the weather and the opponent are chosen, the settings and
// how to play. Plain DOM over a picture of the game: nothing of the battle is built until
// one is asked for, and a battle is asked for by loading the page again with its choices in
// the address, exactly as the links and the test flags always did.
import { FACTIONS, factionByName } from '../sim/factions';
import { MATCH_KEYS, matchFromParams, matchToParams } from './setup';
import { esc } from './wire';

declare const __BUILD__: string;

/** The version this build is, shown on the main menu. Bump it with each milestone. */
export const VERSION = '0.9';

/** What's new, newest first: one short entry per milestone, in plain words. */
const RELEASES: { version: string; notes: string[] }[] = [
  {
    version: '0.9',
    notes: [
      'Menus: a main menu, a New battle screen for the map, armies, time, weather and opponent, plus settings and how to play.',
      'A glass battle screen with a commander board: every commander and its orders in one list.',
      'Co-op with friends: two to four of you command one army against the computer, with one link for everyone.',
      'Versus: red against blue, with up to two players a side and no computer.',
      'Night battles, rain, fog and snow. At night gunfire and flares light the ground.',
      'Free-for-all: three or four armies on the four corners map, each fighting for itself.',
      'A European city map: a cathedral square, a station, a park and a motorway round it.',
      'Helicopters and paratroopers: trucks build a helipad for the helicopters, a barracks holds the paratroopers, and J drops them.',
      'Way points: Shift and right click queue the next place, and trucks build a list of buildings in order.',
      'See-through buildings (Y), close up, so you can see the street you are looking at.',
    ],
  },
];

/** What in the address asks for a battle: any of these and the menu is skipped. */
const BATTLE_KEYS = ['play', 'join', 'coop', ...MATCH_KEYS.filter((k) => k !== 'seed')];

export function wantsMenu(params: URLSearchParams): boolean {
  return !BATTLE_KEYS.some((k) => params.has(k));
}

/** The address without a battle in it: the test flags (renderer, fog, shadows…) stay. */
function carried(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const k of BATTLE_KEYS) next.delete(k);
  return next;
}

/** Leave the battle for the main menu. */
export function toMenu(params: URLSearchParams): void {
  const next = carried(params).toString();
  location.href = `${location.origin}${location.pathname}${next ? `?${next}` : ''}`;
}

/** The battle just fought, for the main menu's corner. */
export interface LastBattle {
  label: string;
  won: boolean;
  time: string;
}

export function saveLastBattle(last: LastBattle): void {
  try {
    localStorage.setItem('revolution.last', JSON.stringify(last));
  } catch {
    // not remembered
  }
}

type Mode = 'skirmish' | 'coop' | 'versus';
type Choice = readonly [value: string, label: string, note?: string];

interface Setup {
  map: string;
  armies: string;
  time: string;
  weather: string;
  ai: string;
  army: string;
  foe: string;
}

const DEFAULTS: Setup = {
  map: 'city',
  armies: '2',
  time: 'day',
  weather: 'clear',
  ai: 'easy',
  army: 'nato',
  foe: 'russia',
};

const MAPS: Choice[] = [
  ['city', 'City', 'A dense modern city of nine districts: street fighting from the first minute.'],
  [
    'euro',
    'European city',
    'An old city on a river: cathedral square, station, park and a motorway round it.',
  ],
  ['ridge', 'Ridge', 'Open country, woods and a ridge, with several ways round.'],
  ['river', 'River', 'The first battlefield: a river between the armies, crossed at its bridges.'],
  ['four', 'Four corners', 'An army in each corner and nine towns between them.'],
];
const ARMIES: Choice[] = [
  ['2', 'Two', 'You against one computer.'],
  [
    '3',
    'Three',
    'Free-for-all on the four corners map: every army for itself, the computers fight each other too.',
  ],
  [
    '4',
    'Four',
    'Free-for-all on the four corners map: every army for itself, the computers fight each other too.',
  ],
];
const TIMES: Choice[] = [
  ['day', 'Day'],
  [
    'night',
    'Night',
    'Troops see six tenths as far. Gunfire, burning wrecks and flares (I) light what is near them.',
  ],
];
const WEATHERS: Choice[] = [
  ['clear', 'Clear'],
  ['rain', 'Rain', 'Everyone sees 85% as far. No dust.'],
  ['fog', 'Fog', 'Everyone sees 55% as far, scouts and drones included.'],
  ['snow', 'Snow', 'Everyone sees 80% as far. No dust.'],
];
const OPPONENTS: Choice[] = [
  ['recruit', 'Recruit'],
  ['easy', 'Easy'],
  ['normal', 'Normal'],
  ['hard', 'Hard'],
  ['off', 'None', 'No computer: an empty battlefield to try things on.'],
];
const POWERS: Choice[] = [
  ['nato', 'Western alliance'],
  ['russia', 'Russia'],
  ['china', 'China'],
  ['none', 'No faction', 'The plain roster, the same for both.'],
];
const GRAPHICS: Choice[] = [
  ['low', 'Low'],
  ['normal', 'Normal'],
  ['high', 'High'],
];
const VOLUMES: Choice[] = [
  ['0', 'Off'],
  ['0.35', 'Quiet'],
  ['0.7', 'Normal'],
  ['1', 'Loud'],
];
const SPEEDS: Choice[] = [
  ['1', '1x'],
  ['0.75', '0.75x', 'The whole game a little slower.'],
];
const ON_OFF: Choice[] = [
  ['0', 'Off'],
  [
    '1',
    'On',
    'Fades the buildings between you and the street you look at. Y switches it in a battle.',
  ],
];

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // not remembered
  }
};

/** A row of choices, one of them taken. */
function seg(name: string, label: string, choices: Choice[], value: string): string {
  const taken = choices.find((c) => c[0] === value);
  let note = taken?.[2] ?? '';
  if ((name === 'army' || name === 'foe') && value !== 'none') {
    note = FACTIONS[factionByName(value)].line;
  }
  return (
    `<div class="opt"><span>${label}</span><div class="seg">` +
    choices
      .map(
        ([v, text]) =>
          `<button data-set="${name}" data-v="${v}"${v === value ? ' class="on"' : ''}>${text}</button>`,
      )
      .join('') +
    `</div>${note ? `<p>${note}</p>` : ''}</div>`
  );
}

export function openMenu(params: URLSearchParams): void {
  const root = document.createElement('div');
  root.className = 'screen home';
  document.body.append(root);

  const setup: Setup = { ...DEFAULTS };
  try {
    const saved = JSON.parse(read('revolution.setup') ?? '{}') as Partial<Setup>;
    for (const k of Object.keys(DEFAULTS) as (keyof Setup)[]) {
      if (typeof saved[k] === 'string') setup[k] = saved[k];
    }
  } catch {
    // the defaults, then
  }
  let view: 'home' | 'setup' | 'settings' | 'howto' | 'news' = 'home';
  let mode: Mode = 'skirmish';

  const start = (): void => {
    write('revolution.setup', JSON.stringify(setup));
    // The choices as a Match (decision 137), written into the address the battle loads
    // with: the same reading and writing as every link and test flag goes through.
    const asked = new URLSearchParams({
      ...setup,
      armies: mode === 'versus' ? '2' : setup.armies,
      seed: params.get('seed') ?? '1',
    });
    const next = matchToParams(matchFromParams(asked), carried(params));
    if (mode === 'skirmish') next.set('play', '1');
    else {
      next.set('coop', 'host');
      try {
        sessionStorage.setItem('revolution.coop.mode', mode === 'versus' ? 'versus' : 'coop');
      } catch {
        // the lobby asks again
      }
    }
    location.search = next.toString();
  };

  const home = (): string => {
    let last = '';
    try {
      const l = JSON.parse(read('revolution.last') ?? 'null') as LastBattle | null;
      if (l && typeof l.label === 'string') {
        last =
          `<div class="pill last"><span>Last battle</span><b>${esc(l.label)}</b>` +
          `<span style="color:${l.won ? 'var(--good)' : 'var(--bad)'}">${l.won ? 'Victory' : 'Defeat'} in ${esc(l.time)}</span></div>`;
      }
    } catch {
      // no last battle
    }
    return (
      `<h1>Revolution</h1><p class="sub">Present day. Three powers. One city at a time.</p>` +
      `<nav>` +
      `<button data-go="skirmish" autofocus>Skirmish</button>` +
      `<button data-go="coop">Co-op with friends</button>` +
      `<button data-go="versus">Versus</button>` +
      `<button data-go="settings">Settings</button>` +
      `<button data-go="howto">How to play</button>` +
      `<button data-go="news">What's new</button>` +
      `</nav><div class="corner">version ${VERSION} · build ${__BUILD__}</div>${last}`
    );
  };

  const battle = (): string => {
    const free = setup.armies !== '2' && mode !== 'versus';
    const title =
      mode === 'skirmish' ? 'New battle' : mode === 'coop' ? 'Co-op with friends' : 'Versus';
    let left = seg('map', 'Map', MAPS, free ? 'four' : setup.map);
    if (mode !== 'versus') left += seg('armies', 'Armies', ARMIES, setup.armies);
    left +=
      seg('time', 'Time', TIMES, setup.time) + seg('weather', 'Weather', WEATHERS, setup.weather);
    let right =
      seg('army', mode === 'versus' ? 'Red army' : 'Your army', POWERS, setup.army) +
      seg('foe', mode === 'versus' ? 'Blue army' : 'Enemy', POWERS, setup.foe);
    if (free && setup.foe !== 'none') {
      right += `<p class="small">The third and fourth armies take the powers that follow the enemy's.</p>`;
    }
    if (mode !== 'versus') right += seg('ai', 'Opponent', OPPONENTS, setup.ai);
    if (mode === 'coop') {
      right += `<p class="small">Two to four of you command one army against the computer. The next screen gives you one link to send to everyone.</p>`;
    } else if (mode === 'versus') {
      right += `<p class="small">Red against blue, no computer. Players on the same side share its army. The next screen gives you one link to send to everyone, and everyone picks a side there.</p>`;
    }
    return (
      `<div class="top"><h1>${title}</h1><span>Esc to go back</span></div>` +
      `<div class="cols2"><div class="col">${left}</div><div class="col">${right}</div></div>` +
      `<div class="bar"><button data-go="home">Back</button>` +
      `<button class="go" data-go="start">${mode === 'skirmish' ? 'Start the battle' : 'Open the lobby'}</button></div>`
    );
  };

  const settings = (): string => {
    const quality = read('revolution.quality');
    const volume = Number(read('revolution.volume') ?? 0.7);
    const nearest = VOLUMES.map((v) => v[0]).reduce((a, b) =>
      Math.abs(Number(b) - volume) < Math.abs(Number(a) - volume) ? b : a,
    );
    return (
      `<div class="top"><h1>Settings</h1><span>Esc to go back</span></div>` +
      `<div class="cols2"><div class="col">` +
      seg(
        'quality',
        'Graphics',
        GRAPHICS,
        quality === 'low' || quality === 'high' ? quality : 'normal',
      ) +
      `<p class="small">If the game stutters, try Low first. The game also lowers its own detail when the frame rate drops.</p>` +
      seg('volume', 'Sound', VOLUMES, nearest) +
      `</div><div class="col">` +
      seg('speed', 'Game speed', SPEEDS, read('revolution.speed') === '0.75' ? '0.75' : '1') +
      seg(
        'seeThrough',
        'See through buildings',
        ON_OFF,
        read('revolution.seeThrough') === '1' ? '1' : '0',
      ) +
      `</div></div><div class="bar"><button data-go="home">Back</button></div>`
    );
  };

  const howto = (): string => {
    const text = (document.getElementById('help')?.innerHTML ?? '')
      .split(/<br\s*\/?>/)
      .map((p) => p.trim())
      .filter((p) => p !== '')
      .map((p) => `<p>${p}</p>`)
      .join('');
    return (
      `<div class="top"><h1>How to play</h1><span>Esc to go back · F1 shows this during a battle</span></div>` +
      `<div class="text">${text}</div><div class="bar"><button data-go="home">Back</button></div>`
    );
  };

  const news = (): string => {
    const releases = RELEASES.map(
      (r) =>
        `<h2>Version ${r.version}</h2><ul>` +
        r.notes.map((n) => `<li>${n}</li>`).join('') +
        `</ul>`,
    ).join('');
    return (
      `<div class="top"><h1>What's new</h1><span>Esc to go back</span></div>` +
      `<div class="text">${releases}</div><div class="bar"><button data-go="home">Back</button></div>`
    );
  };

  const render = (): void => {
    root.className = `screen${view === 'home' ? ' home' : ''}`;
    root.innerHTML =
      view === 'home'
        ? home()
        : view === 'setup'
          ? battle()
          : view === 'settings'
            ? settings()
            : view === 'news'
              ? news()
              : howto();
    root.scrollTop = 0;
    root.querySelector<HTMLElement>('[autofocus]')?.focus();
  };

  root.addEventListener('click', (e) => {
    const button = (e.target as HTMLElement).closest('button');
    if (!button || button.disabled) return;
    const go = button.dataset.go;
    const set = button.dataset.set;
    const v = button.dataset.v ?? '';
    if (go === 'start') {
      start();
      return;
    }
    if (go === 'skirmish' || go === 'coop' || go === 'versus') {
      mode = go;
      view = 'setup';
    } else if (go === 'home' || go === 'settings' || go === 'howto' || go === 'news') view = go;
    else if (set === 'quality') {
      write('revolution.quality', v);
      // The address would overrule the choice.
      params.delete('quality');
    } else if (set === 'volume' || set === 'speed' || set === 'seeThrough') {
      write(`revolution.${set}`, v);
    } else if (set && set in setup) {
      setup[set as keyof Setup] = v;
      // Three or four armies fight on the four corners; another map is for two.
      if (set === 'map' && v !== 'four') setup.armies = '2';
    }
    const top = root.scrollTop;
    render();
    if (set) root.scrollTop = top;
  });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && view !== 'home') {
      view = 'home';
      render();
    } else if (
      e.code === 'Enter' &&
      view === 'setup' &&
      !(e.target as HTMLElement).closest('button')
    ) {
      start();
    }
  });
  render();
}
