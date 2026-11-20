// Headless match that counts what a battle costs the city: buildings by stage and
// civilians dead, every five minutes. For tuning destruction and civilian numbers.
// Run: npx esbuild tools/toll.ts --bundle --platform=node --outfile=/tmp/toll.cjs && node /tmp/toll.cjs [seed] [minutes] [levelA] [levelB]
import { aiThink, createAi, type AiLevel } from '../src/sim/ai';
import { CIV_DEAD, CIV_FLEEING, CIV_GONE, CIV_HOME } from '../src/sim/civilians';
import { FELL_PANCAKE } from '../src/sim/collapse';
import type { Command } from '../src/sim/commands';
import { S_BUILDING, generateMap, type Layout } from '../src/sim/map';
import { skirmishCommands } from '../src/sim/scenarios';
import { stageOf, step } from '../src/sim/sim';
import { onRoof } from '../src/sim/ambush';
import { KIND_MORTAR } from '../src/sim/units';
import { EV_AMBUSH, EV_LAUNCH, STANCE_AMBUSH, STATE_ALIVE, createWorld } from '../src/sim/world';

const seed = Number(process.argv[2] ?? 1);
const minutes = Number(process.argv[3] ?? 30);
const levels = [process.argv[4] ?? 'hard', process.argv[5] ?? 'hard'];
const layout = (process.env.MAP ?? 'city') as Layout;
const w = createWorld(seed, generateMap(seed, layout));
const ais = levels.map((l, t) => createAi(t, l as AiLevel, seed, 1));
let cmds: Command[] = skirmishCommands(w.map);
let stepTotal = 0;
let stepWorst = 0;
let houses = 0;
// I6: mortar bombs fired and ambushes sprung so far.
let bombs = 0;
let sprung = 0;
for (let s = 0; s < w.map.structCount; s++) if (w.map.sKind[s] === S_BUILDING) houses++;
console.log(`${layout} seed ${seed}: ${houses} buildings, ${w.civCount} civilians`);
for (let tick = 0; tick < minutes * 1200; tick++) {
  for (const ai of ais) aiThink(ai, w, cmds);
  const t1 = performance.now();
  step(w, cmds);
  const sm = performance.now() - t1;
  stepTotal += sm;
  if (sm > stepWorst) stepWorst = sm;
  cmds = [];
  for (let e = 0; e < w.events.length; e += 3) {
    if (w.events[e] === EV_AMBUSH) sprung++;
    else if (w.events[e] === EV_LAUNCH && w.kind[w.events[e + 1]] === KIND_MORTAR) bombs++;
  }
  w.events.length = 0;
  if (tick % 6000 === 5999) {
    const stages = [0, 0, 0, 0, 0];
    let flat = 0;
    let burnt = 0;
    for (let s = 0; s < w.map.structCount; s++) {
      if (w.map.sKind[s] !== S_BUILDING) continue;
      stages[stageOf(w, s)]++;
      if (w.sFell[s] === FELL_PANCAKE) flat++;
      if (w.sFire[s] !== 0) burnt++;
    }
    const civ = [0, 0, 0, 0, 0];
    for (let k = 0; k < w.civCount; k++) civ[w.civState[k]]++;
    let units = 0;
    let mortars = 0;
    let roofs = 0;
    let waiting = 0;
    for (let i = 0; i < w.count; i++) {
      if (w.state[i] !== STATE_ALIVE) continue;
      units++;
      if (w.kind[i] === KIND_MORTAR) mortars++;
      if (onRoof(w, i)) roofs++;
      if (w.stance[i] === STANCE_AMBUSH) waiting++;
    }
    console.log(
      `min ${(tick + 1) / 1200}: stages ${stages.join('/')} (pancaked ${flat}, caught fire ${burnt})  civ home ${civ[CIV_HOME]} run ${civ[CIV_FLEEING]} out ${civ[CIV_GONE]} dead ${civ[CIV_DEAD]} (by ${w.civKilled[0]}, ${w.civKilled[1]})  units ${units}  step ${(stepTotal / (tick + 1)).toFixed(2)} ms worst ${stepWorst.toFixed(0)}  I6: mortars ${mortars} bombs ${bombs} on roofs ${roofs} waiting ${waiting} sprung ${sprung}`,
    );
  }
}
