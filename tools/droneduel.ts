// Strike drones against a tank group on open ground: how long from the first drone coming
// into the tanks' sight until the first hit, the first tank lost and the last one, with and
// without an escort (air defence, a jammer).
// Run: npx esbuild tools/droneduel.ts --bundle --platform=node --outfile=/tmp/droneduel.cjs && node /tmp/droneduel.cjs
import { CMD_ATTACK_MOVE, CMD_SPAWN, type Command } from '../src/sim/commands';
import { fx } from '../src/sim/fixed';
import { flatMap } from '../src/sim/map';
import { step } from '../src/sim/sim';
import { KIND_AD, KIND_EW, KIND_STRIKE, KIND_TANK, KINDS } from '../src/sim/units';
import { STATE_ALIVE, createWorld } from '../src/sim/world';

type Side = [kind: number, count: number][];

function duel(drones: number, defenders: Side, gap = 150): string {
  const w = createWorld(11, flatMap());
  const cmds: Command[] = [];
  const spawn = (team: number, kind: number, count: number, x: number) =>
    cmds.push({
      type: CMD_SPAWN,
      count,
      team,
      kind,
      x: fx(x),
      y: fx(400),
      radius: fx(kind === KIND_STRIKE ? 14 : 9),
      wander: false,
      advanceX: 0,
      advanceY: 0,
    });
  spawn(0, KIND_STRIKE, drones, 400 - gap);
  for (const [kind, count] of defenders) spawn(1, kind, count, 400);
  step(w, cmds);
  const ids: number[] = [];
  const tanks: number[] = [];
  for (let i = 0; i < w.count; i++) {
    if (w.kind[i] === KIND_STRIKE) ids.push(i);
    if (w.kind[i] === KIND_TANK) tanks.push(i);
  }
  step(w, [{ type: CMD_ATTACK_MOVE, units: ids, x: fx(400), y: fx(400) }]);
  const sight = KINDS[KIND_TANK].sight + fx(9);
  let seen = -1;
  let firstHit = -1;
  let firstLoss = -1;
  let lastLoss = -1;
  let t = 0;
  for (; t < 2400; t++) {
    step(w, []);
    w.events.length = 0;
    let droneLeft = 0;
    let tankLeft = 0;
    for (const i of ids) {
      if (w.state[i] !== STATE_ALIVE) continue;
      droneLeft++;
      const dx = w.posX[i] - fx(400);
      const dy = w.posY[i] - fx(400);
      if (seen < 0 && dx * dx + dy * dy <= sight * sight) seen = t;
    }
    for (const i of tanks) {
      if (w.state[i] !== STATE_ALIVE) continue;
      tankLeft++;
      if (firstHit < 0 && w.hp[i] < KINDS[KIND_TANK].hp) firstHit = t;
    }
    if (firstLoss < 0 && tankLeft < tanks.length) firstLoss = t;
    if (tankLeft === 0) {
      lastLoss = t;
      break;
    }
    if (droneLeft === 0) break;
  }
  const s = (v: number) => (v < 0 ? '  never' : ((v - seen) / 20).toFixed(1).padStart(5) + ' s');
  let tankLeft = 0;
  let droneLeft = 0;
  for (const i of tanks) if (w.state[i] === STATE_ALIVE) tankLeft++;
  for (const i of ids) if (w.state[i] === STATE_ALIVE) droneLeft++;
  return `first hit ${s(firstHit)}, first tank lost ${s(firstLoss)}, all lost ${s(lastLoss)}; tanks left ${tankLeft}/${tanks.length}, drones left ${droneLeft}`;
}

const name = (s: Side) => s.map(([k, c]) => `${c} ${KINDS[k].name}`).join(' + ');
for (const tanks of [1, 4]) {
  for (const drones of [2, 4, 8, 16, 32]) {
    const d: Side = [[KIND_TANK, tanks]];
    console.log(`${String(drones).padStart(2)} drones vs ${name(d)}: ${duel(drones, d)}`);
  }
}
for (const escort of [
  [[KIND_AD, 1]],
  [[KIND_AD, 2]],
  [[KIND_EW, 1]],
  [
    [KIND_AD, 1],
    [KIND_EW, 1],
  ],
] as Side[]) {
  for (const drones of [8, 16, 32]) {
    const d: Side = [[KIND_TANK, 4], ...escort];
    console.log(`${String(drones).padStart(2)} drones vs ${name(d)}: ${duel(drones, d)}`);
  }
}
