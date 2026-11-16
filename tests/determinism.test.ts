import { describe, expect, it } from 'vitest';
import { aiThink, createAi } from '../src/sim/ai';
import { CMD_FACTION, type Command } from '../src/sim/commands';
import { generateMap } from '../src/sim/map';
import { skirmishCommands } from '../src/sim/scenarios';
import { step } from '../src/sim/sim';
import { EV_DEATH, STATE_ALIVE, createWorld, hashWorld } from '../src/sim/world';

/**
 * Golden hashes for the games people actually play: computers against each other on the
 * city map (two armies) and the four corners map (four), with factions, economy, commanders
 * and civilians all running. A change that moves one of these hashes changes the game; if
 * that is the point of the change, update the number in the same pull request and say so.
 *
 * The computers think in the worker's order: armies 1..n first, then army 0.
 */
function play(layout: Parameters<typeof generateMap>[1], armies: number, minutes: number) {
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

describe('golden games', () => {
  it('two armies on the city map play out exactly as pinned', () => {
    const { marks, alive, deaths } = play('city', 2, 8);
    // Hashes at the end of every minute: the first that differs says when the game changed.
    expect(marks).toEqual([
      '5033252b',
      '594dee11',
      'b894b321',
      'd451590e',
      '9b86d03f',
      'aa809142',
      '87546c65',
      '31a48521',
    ]);
    // A pinned game that never reaches the fighting would pin very little.
    expect(alive).toBeGreaterThan(200);
    expect(deaths).toBeGreaterThan(20);
  });

  it('four armies on the four corners map play out exactly as pinned', () => {
    const { marks, alive, deaths } = play('four', 4, 6);
    expect(marks).toEqual(['5767430e', '390b5d3c', '3b59e625', '9cfc33d8', '1c4e06da', '3ccabaac']);
    expect(alive).toBeGreaterThan(400);
    expect(deaths).toBeGreaterThan(100);
  });
});
