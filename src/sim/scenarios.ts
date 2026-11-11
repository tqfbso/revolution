import { CMD_SPAWN, type Command } from './commands';
import { fx } from './fixed';
import { MAP_SIZE, MAX_TEAMS } from './world';

/** Opening commands for the stress test: `total` roaming units split across three teams. */
export function stressTestCommands(total: number): Command[] {
  const half = MAP_SIZE / 2;
  const centres = [
    [half - 150, half + 110],
    [half + 150, half + 110],
    [half, half - 150],
  ];
  const per = Math.floor(total / MAX_TEAMS);
  const cmds: Command[] = [];
  for (let team = 0; team < MAX_TEAMS; team++) {
    cmds.push({
      type: CMD_SPAWN,
      count: team === 0 ? total - per * (MAX_TEAMS - 1) : per,
      team,
      x: fx(centres[team][0]),
      y: fx(centres[team][1]),
      radius: fx(90),
      wander: true,
    });
  }
  return cmds;
}
