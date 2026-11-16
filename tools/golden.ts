// The golden games (tests/determinism.test.ts, tools/crossbrowser.mjs): computers against
// each other with factions, economy, commanders and civilians, the world hash taken at the
// end of every minute. The computers think in the worker's order: armies 1..n, then army 0.
import { aiThink, createAi } from '../src/sim/ai';
import { CMD_FACTION, type Command } from '../src/sim/commands';
import { generateMap } from '../src/sim/map';
import { skirmishCommands } from '../src/sim/scenarios';
import { step } from '../src/sim/sim';
import { EV_DEATH, STATE_ALIVE, createWorld, hashWorld } from '../src/sim/world';

export function play(layout: Parameters<typeof generateMap>[1], armies: number, minutes: number) {
  const seed = 7;
  const w = createWorld(seed, generateMap(seed, layout));
  const ais = Array.from({ length: armies - 1 }, (_, t) => createAi(t + 1, 'hard', seed));
  ais.push(createAi(0, 'hard', seed));
  let cmds: Command[] = [
    ...Array.from(
      { length: armies },
      (_, t) => ({ type: CMD_FACTION, team: t, faction: 1 + (t % 3) }) as Command,
    ),
    ...skirmishCommands(w.map, armies),
  ];
  const marks: string[] = [];
  let deaths = 0;
  for (let tick = 0; tick < minutes * 1200; tick++) {
    for (const ai of ais) aiThink(ai, w, cmds);
    step(w, cmds);
    cmds = [];
    for (let e = 0; e < w.events.length; e += 3) if (w.events[e] === EV_DEATH) deaths++;
    w.events.length = 0;
    if (tick % 1200 === 1199) marks.push(hashWorld(w).toString(16));
  }
  let alive = 0;
  for (let i = 0; i < w.count; i++) if (w.state[i] === STATE_ALIVE) alive++;
  return { marks, alive, deaths };
}

/** What tools/crossbrowser.mjs compares between JS engines: shorter than the tests' games. */
export function crossCheck(): string[] {
  return [...play('city', 2, 4).marks, ...play('four', 4, 3).marks];
}
