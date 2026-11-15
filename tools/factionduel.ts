// Faction against faction, computer against computer: who holds more of the map after N
// minutes, and what it cost. Run:
//   npx esbuild tools/factionduel.ts --bundle --platform=node --outfile=/tmp/fd.cjs
//   node /tmp/fd.cjs <factionA> <factionB> [seed] [minutes] [level]     (MAP=city|ridge|euro|river)
import { aiThink, createAi, type AiLevel } from '../src/sim/ai';
import { CMD_FACTION, type Command } from '../src/sim/commands';
import { B_HQ } from '../src/sim/economy';
import { FACTIONS, factionByName } from '../src/sim/factions';
import { generateMap, type Layout } from '../src/sim/map';
import { skirmishCommands } from '../src/sim/scenarios';
import { step } from '../src/sim/sim';
import { POINTS } from '../src/sim/units';
import { EV_DEATH, NO_TEAM, STATE_ALIVE, createWorld } from '../src/sim/world';

const fa = factionByName(process.argv[2]);
const fb = factionByName(process.argv[3]);
const seed = Number(process.argv[4] ?? 1);
const minutes = Number(process.argv[5] ?? 25);
const level = (process.argv[6] ?? 'hard') as AiLevel;
const layout = (process.env.MAP ?? 'ridge') as Layout;
const w = createWorld(seed, generateMap(seed, layout));
const ais = [createAi(0, level, seed), createAi(1, level, seed)];
let cmds: Command[] = [
  { type: CMD_FACTION, team: 0, faction: fa },
  { type: CMD_FACTION, team: 1, faction: fb },
  ...skirmishCommands(w.map),
];
const lost = [0, 0];
let over = '';
for (let tick = 0; tick < minutes * 1200 && !over; tick++) {
  for (const ai of ais) aiThink(ai, w, cmds);
  step(w, cmds);
  cmds = [];
  for (let e = 0; e < w.events.length; e += 3) {
    if (w.events[e] === EV_DEATH) lost[w.team[w.events[e + 1]]] += POINTS[w.kind[w.events[e + 1]]];
  }
  w.events.length = 0;
  if (tick % 200 === 0 && tick > 10) {
    const hq = [0, 0];
    for (let s = 0; s < w.map.structCount; s++) {
      if (w.sTeam[s] !== NO_TEAM && w.sType[s] === B_HQ && w.sHp[s] > 0) hq[w.sTeam[s]]++;
    }
    if (hq[0] === 0 || hq[1] === 0)
      over = `HQ of ${hq[0] === 0 ? 'A' : 'B'} fell at ${(tick / 1200).toFixed(1)}m`;
  }
}
const towns = [0, 0];
for (let t = 0; t < w.map.townCount; t++) if (w.townOwner[t] < 2) towns[w.townOwner[t]]++;
const army = [0, 0];
for (let i = 0; i < w.count; i++) {
  if (w.state[i] === STATE_ALIVE && w.team[i] < 2) army[w.team[i]] += POINTS[w.kind[i]];
}
const score = (t: number): number => towns[t] * 100 + army[t] - lost[t] / 4;
const win = over ? (over.includes('of A') ? 'B' : 'A') : score(0) > score(1) ? 'A' : 'B';
console.log(
  `${layout} seed ${seed} A=${FACTIONS[fa].short} B=${FACTIONS[fb].short}: towns ${towns.join(':')} army ${army.join(':')} lost ${lost.join(':')} ${over} => ${win} (${win === 'A' ? FACTIONS[fa].short : FACTIONS[fb].short})`,
);
