// Tanks against squads on open ground at equal army points and at other ratios: how many
// squads does it take to stop one tank, and what do they cost? Also a mixed force.
// Run: npx esbuild tools/pointduel.ts --bundle --platform=node --outfile=/tmp/pointduel.cjs && node /tmp/pointduel.cjs
import { CMD_SPAWN } from '../src/sim/commands';
import { UNIT_PRICE } from '../src/sim/economy';
import { fx } from '../src/sim/fixed';
import { flatMap } from '../src/sim/map';
import { step } from '../src/sim/sim';
import { KIND_ATGM, KIND_INFANTRY, KIND_TANK, KINDS } from '../src/sim/units';
import { STATE_ALIVE, createWorld } from '../src/sim/world';

type Side = [kind: number, count: number][];

function duel(a: Side, b: Side, gap = 120): string {
  const w = createWorld(11, flatMap());
  const cmds = [];
  for (const [team, side] of [
    [0, a],
    [1, b],
  ] as const) {
    for (const [kind, count] of side) {
      cmds.push({
        type: CMD_SPAWN as typeof CMD_SPAWN,
        count,
        team,
        kind,
        x: fx(400 + (team === 0 ? -gap / 2 : gap / 2)),
        y: fx(400),
        radius: fx(14),
        wander: false,
        advanceX: fx(team === 0 ? gap : -gap),
        advanceY: 0,
      });
    }
  }
  step(w, cmds);
  let t = 0;
  for (; t < 6000; t++) {
    step(w, []);
    w.events.length = 0;
    if (t % 20 !== 0) continue;
    const left = [0, 0];
    for (let i = 0; i < w.count; i++) if (w.state[i] === STATE_ALIVE) left[w.team[i]] += w.hp[i];
    if (left[0] === 0 || left[1] === 0) break;
  }
  const alive = [0, 0];
  for (let i = 0; i < w.count; i++) if (w.state[i] === STATE_ALIVE) alive[w.team[i]]++;
  return `A ${alive[0]} left, B ${alive[1]} left, ${(t / 20).toFixed(0)} s`;
}

const price = (s: Side) =>
  s.reduce(
    (n, [k, c]) =>
      n + c * (UNIT_PRICE[k].supplies + 2 * UNIT_PRICE[k].fuel + UNIT_PRICE[k].credits),
    0,
  );
const show = (a: Side, b: Side) =>
  console.log(
    `${a.map(([k, c]) => c + ' ' + KINDS[k].name).join(' + ')} (cost ${price(a)})  vs  ${b.map(([k, c]) => c + ' ' + KINDS[k].name).join(' + ')} (cost ${price(b)}): ${duel(a, b)}`,
  );

for (const n of [5, 8, 10, 12]) show([[KIND_TANK, 1]], [[KIND_INFANTRY, n]]);
for (const n of [3, 5, 8]) show([[KIND_TANK, 3]], [[KIND_INFANTRY, n * 3]]);
show(
  [
    [KIND_TANK, 4],
    [KIND_INFANTRY, 12],
  ],
  [[KIND_INFANTRY, 32]],
);
show(
  [
    [KIND_TANK, 4],
    [KIND_INFANTRY, 12],
  ],
  [
    [KIND_INFANTRY, 20],
    [KIND_ATGM, 6],
  ],
);
show([[KIND_TANK, 4]], [[KIND_ATGM, 5]]);
