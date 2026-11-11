import { CMD_SPAWN, type Command } from './commands';
import { fx } from './fixed';
import { KIND_INFANTRY, KIND_TANK } from './units';
import { MAP_SIZE, MAX_TEAMS } from './world';

/** Opening commands for the roaming test: `total` wandering units split across three teams. */
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

/**
 * Two armies of `total` units in all (half tanks, half infantry squads) start on opposite
 * sides of the map centre and attack-move through each other.
 */
export function battleCommands(total: number, gap = 110): Command[] {
  const half = MAP_SIZE / 2;
  const perSide = Math.floor(total / 2);
  const tanks = Math.floor(perSide / 2);
  const cmds: Command[] = [];
  for (let team = 0; team < 2; team++) {
    const dir = team === 0 ? -1 : 1;
    const advanceX = fx(-dir * 2 * gap);
    // Tanks lead, infantry follows behind them.
    cmds.push({
      type: CMD_SPAWN,
      count: tanks,
      team,
      kind: KIND_TANK,
      x: fx(half + dir * gap),
      y: fx(half),
      radius: fx(55),
      wander: false,
      advanceX,
      advanceY: 0,
    });
    cmds.push({
      type: CMD_SPAWN,
      count: perSide - tanks,
      team,
      kind: KIND_INFANTRY,
      x: fx(half + dir * (gap + 30)),
      y: fx(half),
      radius: fx(55),
      wander: false,
      advanceX,
      advanceY: 0,
    });
  }
  return cmds;
}
