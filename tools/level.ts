// How long one attacker takes to gut and to level the average city house, by how it goes
// about it: a tank from across the street, a tank with its muzzle on the wall, an engineer
// squad with charges. For keeping destruction where it is while its rules change (I5).
// Run: npx esbuild tools/level.ts --bundle --platform=node --outfile=/tmp/level.cjs && node /tmp/level.cjs
import { CMD_ATTACK_STRUCTURE, CMD_SPAWN, type Command } from '../src/sim/commands';
import { fx } from '../src/sim/fixed';
import {
  BUILD_BLOCK,
  BUILD_HALL,
  BUILD_HOUSE,
  STAGE_GUTTED,
  S_BUILDING,
  addStructure,
  addTown,
  flatMap,
  refreshPassability,
} from '../src/sim/map';
import { stageOf, step } from '../src/sim/sim';
import { KIND_ENGINEER, KIND_TANK } from '../src/sim/units';
import { EV_COLLAPSE, createWorld } from '../src/sim/world';

/** A house of `w` by `h` cells and `floors` storeys; the attacker `gap` units from its east wall. */
function run(kind: number, gap: number, w: number, h: number, floors: number) {
  const m = flatMap();
  addTown(m, fx(508), fx(500), fx(30), 'Test');
  addStructure(m, S_BUILDING, 126, 124, w, h, 0, floors);
  refreshPassability(m);
  const world = createWorld(1, m);
  const x = (126 + w) * 4 + gap;
  let cmds: Command[] = [
    {
      type: CMD_SPAWN,
      count: 1,
      team: 0,
      kind,
      x: fx(x),
      y: fx(124 * 4 + h * 2),
      radius: fx(1),
      wander: false,
    },
  ];
  let gutted = -1;
  let fire = -1;
  for (let t = 0; t < 20 * 60 * 20; t++) {
    step(world, cmds);
    cmds = t === 0 ? [{ type: CMD_ATTACK_STRUCTURE, units: [0], structure: 0 }] : [];
    if (gutted < 0 && stageOf(world, 0) >= STAGE_GUTTED) gutted = t;
    const lit = (world as unknown as { sFire?: Int32Array }).sFire;
    if (fire < 0 && lit && lit[0] !== 0) fire = t;
    for (let e = 0; e < world.events.length; e += 3) {
      if (world.events[e] === EV_COLLAPSE) {
        return {
          gutted: gutted / 20,
          level: t / 20,
          fire: fire / 20,
          pancake: world.events[e + 2],
        };
      }
    }
    world.events.length = 0;
  }
  return { gutted: gutted / 20, level: -1, fire: fire / 20, pancake: 0 };
}

const houses: [string, number, number, number, number][] = [
  ['average house (3x3, 2 floors... class house)', 3, 3, 3, BUILD_HOUSE],
  ['small house (2x2, 2 floors)', 2, 2, 2, BUILD_HOUSE],
  ['block (3x3, 5 floors)', 3, 3, 5, BUILD_BLOCK],
  ['hall (4x4, 2 floors)', 4, 4, 2, BUILD_HALL],
];
for (const [name, w, h, floors] of houses) {
  console.log(name);
  for (const [who, kind, gap] of [
    ['tank at 20', KIND_TANK, 20],
    ['tank at 4 (point-blank)', KIND_TANK, 4],
    ['engineers', KIND_ENGINEER, 4],
  ] as [string, number, number][]) {
    const r = run(kind, gap, w, h, floors);
    console.log(
      `  ${who.padEnd(24)} gutted ${r.gutted.toFixed(0).padStart(4)} s  down ${r.level.toFixed(0).padStart(4)} s  fire ${r.fire < 0 ? '   -' : r.fire.toFixed(0).padStart(4)} s  ${r.pancake ? 'pancake' : 'from the top'}`,
    );
  }
}
