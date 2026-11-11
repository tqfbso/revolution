// Equal-cost duels on open ground: for each pair of unit types, both sides get the same
// budget, attack-move into each other, and the table shows what share of its budget the
// row type has left when one side is gone (negative: the column type won, with that much).
// Run: npx esbuild tools/matchups.ts --bundle --platform=node --outfile=/tmp/matchups.cjs && node /tmp/matchups.cjs
import { CMD_SPAWN } from '../src/sim/commands';
import { UNIT_PRICE } from '../src/sim/economy';
import { fx } from '../src/sim/fixed';
import { flatMap } from '../src/sim/map';
import { step } from '../src/sim/sim';
import { KINDS } from '../src/sim/units';
import { STATE_ALIVE, createWorld } from '../src/sim/world';

/** What a unit costs in one number: fuel and credits are scarcer than supplies. */
export const cost = (k: number) =>
  UNIT_PRICE[k].supplies + 2 * UNIT_PRICE[k].fuel + UNIT_PRICE[k].credits;

const BUDGET = 6000;
const kinds = [0, 1, 2, 3, 4, 7];

function duel(a: number, b: number, gap: number): number {
  const w = createWorld(11, flatMap());
  const na = Math.max(1, Math.round(BUDGET / cost(a)));
  const nb = Math.max(1, Math.round(BUDGET / cost(b)));
  const spawn = (team: number, kind: number, count: number, x: number, adv: number) => ({
    type: CMD_SPAWN as typeof CMD_SPAWN,
    count,
    team,
    kind,
    x: fx(x),
    y: fx(400),
    radius: fx(14),
    wander: false,
    advanceX: fx(adv),
    advanceY: 0,
  });
  step(w, [spawn(0, a, na, 400 - gap / 2, gap), spawn(1, b, nb, 400 + gap / 2, -gap)]);
  let left = [0, 0];
  for (let t = 0; t < 3600; t++) {
    step(w, []);
    w.events.length = 0;
    if (t % 20 !== 0) continue;
    left = [0, 0];
    for (let i = 0; i < w.count; i++) {
      if (w.state[i] === STATE_ALIVE)
        left[w.team[i]] += (cost(w.kind[i]) * w.hp[i]) / KINDS[w.kind[i]].hp;
    }
    if (left[0] === 0 || left[1] === 0) break;
  }
  return Math.round((left[0] / (na * cost(a)) - left[1] / (nb * cost(b))) * 100);
}

const name = (k: number) => KINDS[k].name.slice(0, 9).padEnd(10);
console.log('cost      ' + kinds.map((k) => String(cost(k)).padEnd(10)).join(''));
console.log('          ' + kinds.map(name).join(''));
for (const a of kinds) {
  console.log(
    name(a) + kinds.map((b) => (a === b ? '.' : String(duel(a, b, 120))).padEnd(10)).join(''),
  );
}
