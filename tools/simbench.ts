// Sim cost of a real game: computers against each other, timing every tick.
//   npx rolldown tools/simbench.ts --platform node -o /tmp/simbench.mjs
//   node /tmp/simbench.mjs [armies 2|4] [seed] [minutes] [level]
// Prints mean and worst tick, the share of ticks over 5 ms, how many route fields were
// built, and the world hash at the end (the same build must always print the same hash).
import { aiThink, createAi, type AiLevel } from '../src/sim/ai';
import { CMD_FACTION, type Command } from '../src/sim/commands';
import { generateMap } from '../src/sim/map';
import { fieldStats } from '../src/sim/path';
import { skirmishCommands } from '../src/sim/scenarios';
import { step } from '../src/sim/sim';
import { STATE_ALIVE, createWorld, hashWorld } from '../src/sim/world';

const armies = Number(process.argv[2] ?? 2);
const seed = Number(process.argv[3] ?? 1);
const minutes = Number(process.argv[4] ?? 25);
const level = (process.argv[5] ?? 'hard') as AiLevel;
const layout = process.env.MAP ?? (armies > 2 ? 'four' : 'city');
const w = createWorld(seed, generateMap(seed, layout as Parameters<typeof generateMap>[1]));
const ais = Array.from({ length: armies }, (_, t) => createAi(t, level, seed));
let cmds: Command[] = [
  ...(armies > 2
    ? Array.from(
        { length: armies },
        (_, t) => ({ type: CMD_FACTION, team: t, faction: 1 + (t % 3) }) as Command,
      )
    : []),
  ...skirmishCommands(w.map, armies),
];
let total = 0;
let worst = 0;
let over5 = 0;
let peak = 0;
const ticks = minutes * 1200;
const wall = performance.now();
for (let tick = 0; tick < ticks; tick++) {
  for (const ai of ais) aiThink(ai, w, cmds);
  const t0 = performance.now();
  step(w, cmds);
  const ms = performance.now() - t0;
  total += ms;
  if (ms > worst) worst = ms;
  if (ms > 5) over5++;
  cmds = [];
  w.events.length = 0;
  if (tick % 200 === 0) {
    let alive = 0;
    for (let i = 0; i < w.count; i++) if (w.state[i] === STATE_ALIVE) alive++;
    if (alive > peak) peak = alive;
  }
}
console.log(
  `${layout} ${armies} armies seed ${seed} ${minutes} min ${level}: step mean ${(total / ticks).toFixed(2)} ms, worst ${worst.toFixed(1)} ms, over 5 ms ${((100 * over5) / ticks).toFixed(1)}%, fields ${fieldStats.builds}, peak ${peak} units, wall ${((performance.now() - wall) / 1000).toFixed(1)} s, hash ${hashWorld(w).toString(16)}`,
);
