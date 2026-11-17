// A commander's attack on a defended town, many fights and seeds: army points lost and the
// seconds it took. The yardstick for any change to how the line goes in (decisions 109, 147).
// Run: npx esbuild tools/assaults.ts --bundle --platform=node --outfile=/tmp/assaults.cjs && node /tmp/assaults.cjs [seeds]
import { CMD_ASSIGN, CMD_FOUND, CMD_MISSION, CMD_SPAWN, type Command } from '../src/sim/commands';
import { fx } from '../src/sim/fixed';
import { generateMap, type Layout } from '../src/sim/map';
import { skirmishCommands } from '../src/sim/scenarios';
import { step } from '../src/sim/sim';
import { ST_SECURED, createStaff, staffThink } from '../src/sim/staff';
import {
  KIND_ATGM,
  KIND_DRONE,
  KIND_HELI,
  KIND_IFV,
  KIND_INFANTRY,
  KIND_TANK,
  POINTS,
} from '../src/sim/units';
import { M_ATTACK, STATE_ALIVE, TICK_RATE, createWorld } from '../src/sim/world';

const KIND = {
  inf: KIND_INFANTRY,
  atgm: KIND_ATGM,
  tank: KIND_TANK,
  ifv: KIND_IFV,
  drone: KIND_DRONE,
  heli: KIND_HELI,
};
type Mix = Partial<Record<keyof typeof KIND, number>>;

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

function assault(
  seed: number,
  layout: Layout,
  name: string,
  own: Mix,
  foe: Mix,
  from: number[],
  at?: number[],
) {
  const w = createWorld(seed, generateMap(seed, layout));
  step(
    w,
    skirmishCommands(w.map).filter((c) => c.type === CMD_FOUND),
  );
  const st = createStaff(0, seed);
  const t = w.map.townName.indexOf(name);
  if (t < 0) return null;
  const tx = at ? at[0] : w.map.townX[t] / fx(1);
  const ty = at ? at[1] : w.map.townY[t] / fx(1);
  const mark = w.count;
  step(
    w,
    Object.entries(own).map(([k, n], j) =>
      spawn(0, KIND[k as keyof typeof KIND], n, from[0] + 6 * j, from[1] + 6 * j),
    ),
  );
  const ids: number[] = [];
  for (let i = mark; i < w.count; i++) ids.push(i);
  step(
    w,
    Object.entries(foe).map(([k, n], j) =>
      spawn(1, KIND[k as keyof typeof KIND], n, tx - 4 + 5 * j, ty + 3 - 4 * j),
    ),
  );
  step(w, [
    { type: CMD_ASSIGN, units: ids, slot: 0 },
    { type: CMD_MISSION, team: 0, slot: 0, mission: M_ATTACK, x: fx(tx), y: fx(ty) },
  ]);
  const points = (team: number) => {
    let sum = 0;
    for (let i = 0; i < w.count; i++) {
      if (w.state[i] === STATE_ALIVE && w.team[i] === team) sum += POINTS[w.kind[i]];
    }
    return sum;
  };
  const before = points(0);
  let seconds = -1;
  for (let k = 0; k < 300 * TICK_RATE; k++) {
    const out: Command[] = [];
    staffThink(st, w, out);
    step(w, out);
    w.events.length = 0;
    if (process.env.TRACE && k % (10 * TICK_RATE) === 0) {
      const c = [0, 0, 0, 0, 0, 0];
      let foes = '';
      for (let i = 0; i < w.count; i++) {
        if (w.state[i] !== STATE_ALIVE) continue;
        if (w.team[i] === 1) {
          foes +=
            ' ' +
            w.kind[i] +
            (w.inside[i] >= 0 ? 'h' : '') +
            '@' +
            (w.posX[i] >> 10) +
            ',' +
            (w.posY[i] >> 10);
          continue;
        }
        const foot = w.kind[i] === KIND_INFANTRY ? 0 : w.kind[i] === KIND_ATGM ? 2 : 4;
        c[foot + (w.inside[i] >= 0 ? 1 : 0)]++;
      }
      console.log(
        k / TICK_RATE,
        'status',
        st.posts[0].status,
        'inf out/in',
        c[0],
        c[1],
        'atgm out/in',
        c[2],
        c[3],
        'other',
        c[4],
        '| foes',
        foes,
      );
    }
    if (st.posts[0].status === ST_SECURED) {
      seconds = k / TICK_RATE;
      break;
    }
  }
  return { seconds, lost: before - points(0), of: before, left: points(1) };
}

const near = [250, 770];
const far = [150, 860];
const FIGHTS: [string, Layout, string, Mix, Mix, number[], number[]?][] = [
  ['hill 2 tanks', 'ridge', 'Westgate', { inf: 12, atgm: 5, drone: 1 }, { tank: 2, inf: 3 }, near],
  [
    'hill, own tanks',
    'ridge',
    'Westgate',
    { inf: 12, atgm: 5, drone: 1, tank: 2 },
    { tank: 2, inf: 3 },
    near,
  ],
  ['hill 3 ifv', 'ridge', 'Westgate', { inf: 12, atgm: 4, drone: 1 }, { ifv: 3, inf: 4 }, near],
  [
    'hill no armour',
    'ridge',
    'Westgate',
    { inf: 12, atgm: 4, drone: 1, tank: 2 },
    { inf: 8 },
    near,
  ],
  [
    'hill far 3 tanks',
    'ridge',
    'Westgate',
    { inf: 10, atgm: 6, drone: 1 },
    { tank: 3, inf: 2 },
    far,
  ],
  ['hill 2 helis', 'ridge', 'Westgate', { inf: 14, atgm: 4, drone: 1 }, { heli: 2, inf: 4 }, near],
  [
    'open 3 tanks',
    'ridge',
    'Westgate',
    { inf: 11, atgm: 4, drone: 1 },
    { tank: 3 },
    far,
    [215, 800],
  ],
  [
    'open 3 tanks, mixed',
    'ridge',
    'Westgate',
    { inf: 14, atgm: 6, drone: 1 },
    { tank: 3, inf: 5 },
    far,
    [215, 800],
  ],
  [
    'open 2 helis',
    'ridge',
    'Westgate',
    { inf: 14, atgm: 4, drone: 1 },
    { heli: 2, inf: 3 },
    far,
    [215, 800],
  ],
  [
    'city 3 tanks',
    'city',
    'Millbrook',
    { inf: 16, atgm: 6, drone: 1, tank: 2 },
    { tank: 3, inf: 6 },
    [130, 640],
  ],
  [
    'city 2 tanks 2 ifv',
    'city',
    'Millbrook',
    { inf: 16, atgm: 6, drone: 1, tank: 2 },
    { tank: 2, ifv: 2, inf: 6 },
    [130, 640],
  ],
  [
    'city 5 tanks',
    'city',
    'West End',
    { inf: 20, atgm: 8, drone: 1, tank: 2 },
    { tank: 5, inf: 6, atgm: 2 },
    [150, 880],
  ],
  [
    'city 5 tanks, foot only',
    'city',
    'West End',
    { inf: 24, atgm: 10, drone: 1 },
    { tank: 5, inf: 6, atgm: 2 },
    [150, 880],
  ],
  [
    'city 2 helis 2 tanks',
    'city',
    'West End',
    { inf: 20, atgm: 8, drone: 1 },
    { heli: 2, tank: 2, inf: 6 },
    [150, 880],
  ],
];

const seeds = (process.argv[2] ?? '3').split(',').map(Number);
let total = 0;
let beaten = 0;
for (const [label, layout, town, own, foe, from, at] of FIGHTS) {
  if (process.env.ONLY && !label.includes(process.env.ONLY)) continue;
  const cells: string[] = [];
  for (const seed of seeds) {
    const r = assault(seed, layout, town, own, foe, from, at);
    if (r === null) {
      cells.push('no town');
      continue;
    }
    total += r.lost;
    if (r.seconds < 0) beaten++;
    cells.push(
      `${r.lost}/${r.of} ${r.seconds < 0 ? 'FAIL' : r.seconds.toFixed(0) + 's'} L${r.left}`,
    );
  }
  console.log(label.padEnd(26), cells.join(' | '));
}
console.log(`total lost ${total}, not secured ${beaten}`);
