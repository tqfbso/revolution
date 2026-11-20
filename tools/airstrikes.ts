// How much the air strikes (I7) do in real games: computers against each other with
// factions on the city map, counting each army's strikes and what they killed against
// everything that died. Run with the esbuild recipe:
//   npx esbuild tools/airstrikes.ts --bundle --platform=node --outfile=/tmp/as.cjs && node /tmp/as.cjs normal 30
import { aiThink, createAi, type AiLevel } from '../src/sim/ai';
import { CMD_FACTION, type Command } from '../src/sim/commands';
import { generateMap } from '../src/sim/map';
import { skirmishCommands } from '../src/sim/scenarios';
import { step } from '../src/sim/sim';
import { strikeStatus } from '../src/sim/air';
import { KIND_PLANE, POINTS } from '../src/sim/units';
import { EV_AIRSTRIKE, EV_DEATH, createWorld } from '../src/sim/world';

const level = (process.argv[2] ?? 'normal') as AiLevel;
const minutes = Number(process.argv[3] ?? 30);
const names = ['none', 'alliance', 'russia', 'china'];
for (const [fa, fb, seed] of [
  [1, 2, 7],
  [2, 3, 8],
  [3, 1, 9],
  [2, 1, 10],
  [3, 2, 11],
  [1, 3, 12],
]) {
  const w = createWorld(seed, generateMap(seed, 'city'));
  const ais = [createAi(1, level, seed), createAi(0, level, seed)];
  let cmds: Command[] = [
    { type: CMD_FACTION, team: 0, faction: fa } as Command,
    { type: CMD_FACTION, team: 1, faction: fb } as Command,
    ...skirmishCommands(w.map, 2),
  ];
  const strikes = [0, 0];
  const first = [-1, -1];
  const byAir = [0, 0];
  const lost = [0, 0];
  const why = [new Array(6).fill(0), new Array(6).fill(0)];
  for (let tick = 0; tick < minutes * 1200; tick++) {
    for (const ai of ais) aiThink(ai, w, cmds);
    step(w, cmds);
    cmds = [];
    if (tick % 200 === 0) for (let t = 0; t < 2; t++) why[t][strikeStatus(w, t)]++;
    const ev = w.events;
    for (let e = 0; e < ev.length; e += 3) {
      if (ev[e] === EV_AIRSTRIKE) {
        const t = ev[e + 2] >> 4;
        strikes[t]++;
        if (first[t] < 0) first[t] = Math.round(tick / 120) / 10;
      } else if (ev[e] === EV_DEATH) {
        const v = ev[e + 1];
        const by = ev[e + 2];
        const t = w.team[v];
        if (t > 1) continue;
        lost[t] += POINTS[w.kind[v]];
        if (by >= 0 && w.kind[by] === KIND_PLANE && w.team[by] !== t)
          byAir[1 - t] += POINTS[w.kind[v]];
      }
    }
    w.events.length = 0;
  }
  console.log(
    `${names[fa]} v ${names[fb]}: strikes ${strikes.join('/')} first min ${first.join('/')} ` +
      `points killed by air ${byAir.join('/')} of points lost ${lost[1]}/${lost[0]} tier ${w.tier[0]}/${w.tier[1]} status ${why[0].join(',')} | ${why[1].join(',')}`,
  );
}
