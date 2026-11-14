// Headless match: AI against AI (or against nobody), printing a line a minute.
// Run: npx esbuild tools/aimatch.ts --bundle --platform=node --outfile=/tmp/aimatch.cjs && node /tmp/aimatch.cjs [seed] [minutes] [levelA] [levelB]
import { aiReport, aiThink, createAi, type AiLevel } from '../src/sim/ai';
import type { Command } from '../src/sim/commands';
import { B_HQ } from '../src/sim/economy';
import { generateMap } from '../src/sim/map';
import { skirmishCommands } from '../src/sim/scenarios';
import { step } from '../src/sim/sim';
import { createWorld, hashWorld, NO_TEAM } from '../src/sim/world';

const seed = Number(process.argv[2] ?? 1);
const minutes = Number(process.argv[3] ?? 20);
const levels = [process.argv[4] ?? 'normal', process.argv[5] ?? 'normal'];
const layout =
  process.env.MAP === 'river' ? 'river' : process.env.MAP === 'ridge' ? 'ridge' : 'city';
const w = createWorld(seed, generateMap(seed, layout));
// HUMANS=3 gives team 1 (the side the computer plays in a skirmish) its co-op tuning.
const humans = Number(process.env.HUMANS ?? 1);
const ais = levels.map((l, t) =>
  l === 'off' ? null : createAi(t, l as AiLevel, seed, t === 1 ? humans : 1),
);
let cmds: Command[] = skirmishCommands(w.map);
let worst = 0;
let total = 0;
let stepTotal = 0;
let stepWorst = 0;
const lastPlan = ['', ''];
for (let tick = 0; tick < minutes * 1200; tick++) {
  const t0 = performance.now();
  for (const ai of ais) if (ai) aiThink(ai, w, cmds);
  const ms = performance.now() - t0;
  total += ms;
  if (ms > worst) worst = ms;
  const t1 = performance.now();
  step(w, cmds);
  const sm = performance.now() - t1;
  stepTotal += sm;
  if (sm > stepWorst) stepWorst = sm;
  if (sm > 40 && process.env.SPIKES)
    console.log(`  spike ${sm.toFixed(0)} ms at tick ${tick}, ${w.count} units`);
  cmds = [];
  w.events.length = 0;
  for (const ai of ais) {
    if (ai && ai.plan !== lastPlan[ai.team]) {
      lastPlan[ai.team] = ai.plan;
      if (process.env.PLANS) console.log(`  ${(tick / 1200).toFixed(1)}m t${ai.team}: ${ai.plan}`);
    }
  }
  if (tick % 1200 === 1199) {
    console.log(`min ${(tick + 1) / 1200}`);
    for (const ai of ais) if (ai) console.log('  ' + aiReport(ai, w));
  }
  const hqs = [0, 0];
  for (let s = 0; s < w.map.structCount; s++) {
    if (w.sTeam[s] !== NO_TEAM && w.sType[s] === B_HQ && w.sHp[s] > 0) hqs[w.sTeam[s]]++;
  }
  if (tick > 10 && (hqs[0] === 0 || hqs[1] === 0)) {
    console.log(`GAME OVER at ${(tick / 1200).toFixed(1)} min: team ${hqs[0] === 0 ? 1 : 0} wins`);
    break;
  }
}
const air = [0, 1].map((t) => {
  const n = [0, 0, 0, 0];
  for (let i = 0; i < w.count; i++) {
    if (w.state[i] === 1 && w.team[i] === t && w.kind[i] >= 12) n[w.kind[i] - 12]++;
  }
  return `t${t} helis ${n[0]}+${n[1]} of ${w.heliCap[t]}, paras ${n[2]} down ${w.paraReserve[t]} waiting`;
});
console.log(`air: ${air.join('; ')}`);
console.log(
  `civilians ${w.civCount}: killed ${Array.from(w.civKilled).join('/')} escaped ${w.civEscaped} home ${w.civState.filter((s) => s === 1).length}`,
);
console.log(
  `step: worst ${stepWorst.toFixed(1)} ms, mean ${(stepTotal / w.tick).toFixed(2)} ms/tick`,
);
console.log(
  `ai think: worst ${worst.toFixed(2)} ms, mean ${(total / w.tick).toFixed(4)} ms/tick; hash ${hashWorld(w).toString(16)}`,
);
