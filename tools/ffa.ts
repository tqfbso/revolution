// Three or four computers on the four corners map, each for itself: who is left standing.
//   npx esbuild tools/ffa.ts --bundle --platform=node --outfile=/tmp/ffa.cjs
//   node /tmp/ffa.cjs <armies> [seed] [minutes] [level]
import { aiThink, createAi, type AiLevel } from '../src/sim/ai';
import { CMD_FACTION, type Command } from '../src/sim/commands';
import { B_HQ } from '../src/sim/economy';
import { generateMap } from '../src/sim/map';
import { skirmishCommands } from '../src/sim/scenarios';
import { step } from '../src/sim/sim';
import { POINTS } from '../src/sim/units';
import { EV_DEATH, NO_TEAM, STATE_ALIVE, createWorld, hashWorld } from '../src/sim/world';

const armies = Number(process.argv[2] ?? 4);
const seed = Number(process.argv[3] ?? 1);
const minutes = Number(process.argv[4] ?? 30);
const level = (process.argv[5] ?? 'hard') as AiLevel;
const w = createWorld(seed, generateMap(seed, 'four'));
const ais = Array.from({ length: armies }, (_, t) => createAi(t, level, seed));
let cmds: Command[] = [
  ...Array.from(
    { length: armies },
    (_, t) => ({ type: CMD_FACTION, team: t, faction: 1 + (t % 3) }) as Command,
  ),
  ...skirmishCommands(w.map, armies),
];
const lost = new Array<number>(armies).fill(0);
const fell = new Array<string>(armies).fill('');
const start = Date.now();
for (let tick = 0; tick < minutes * 1200; tick++) {
  for (const ai of ais) aiThink(ai, w, cmds);
  step(w, cmds);
  cmds = [];
  for (let e = 0; e < w.events.length; e += 3) {
    if (w.events[e] === EV_DEATH) lost[w.team[w.events[e + 1]]] += POINTS[w.kind[w.events[e + 1]]];
  }
  w.events.length = 0;
  if (tick % 200 === 0 && tick > 10) {
    const hq = new Array<number>(armies).fill(0);
    for (let s = 0; s < w.map.structCount; s++) {
      if (w.sTeam[s] !== NO_TEAM && w.sType[s] === B_HQ && w.sHp[s] > 0) hq[w.sTeam[s]]++;
    }
    for (let t = 0; t < armies; t++) {
      if (hq[t] === 0 && !fell[t]) fell[t] = `${(tick / 1200).toFixed(1)}m`;
    }
    if (fell.filter((f) => !f).length <= 1) break;
  }
  if (tick % 6000 === 0) {
    console.log(
      `  ${tick / 1200}m enemies ${ais.map((a) => a.enemy).join(',')} pop ${Array.from(w.pop.slice(0, armies)).join(',')}`,
    );
  }
}
const towns = new Array<number>(armies).fill(0);
for (let t = 0; t < w.map.townCount; t++) if (w.townOwner[t] < armies) towns[w.townOwner[t]]++;
const army = new Array<number>(armies).fill(0);
for (let i = 0; i < w.count; i++) {
  if (w.state[i] === STATE_ALIVE && w.team[i] < armies) army[w.team[i]] += POINTS[w.kind[i]];
}
console.log(
  `four seed ${seed} x${armies}: towns ${towns.join(':')} army ${army.join(':')} lost ${lost.join(':')} fell ${fell.map((f) => f || '-').join(' ')} tick ${w.tick} hash ${hashWorld(w)} ${((Date.now() - start) / 1000).toFixed(0)}s`,
);
