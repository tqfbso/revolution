import { CMD_SPAWN, type Command } from './commands';
import { fx } from './fixed';
import type { GameMap } from './map';
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

/**
 * The assault: blue holds the east bank. Its infantry sits in the houses of the three east
 * bank settlements (and in the streets, where the houses are full) with tanks behind them.
 * Red, the player, starts west of the central town with `total` / 2 units and no orders.
 */
export function assaultCommands(map: GameMap, total: number): Command[] {
  if (map.townCount < 6) return battleCommands(total);
  const perSide = Math.floor(total / 2);
  const tanks = Math.floor(perSide / 2);
  const infantry = perSide - tanks;
  const cmds: Command[] = [];
  const add = (team: number, kind: number, count: number, x: number, y: number, r: number) => {
    if (count > 0)
      cmds.push({ type: CMD_SPAWN, count, team, kind, x, y, radius: fx(r), wander: false });
  };
  // Red: armour in front, infantry behind, both short of the west half of the central town.
  add(0, KIND_TANK, tanks, map.townX[0] - fx(75), map.townY[0], 40);
  add(0, KIND_INFANTRY, infantry, map.townX[0] - fx(115), map.townY[0], 40);
  // Blue: half the force at the central town, a quarter at each village.
  const share = [2, 1, 1];
  for (let k = 0; k < 3; k++) {
    const town = 2 * k + 1;
    const x = map.townX[town];
    const y = map.townY[town];
    const inf = Math.floor((infantry * share[k]) / 4);
    cmds.push({
      type: CMD_SPAWN,
      count: inf,
      team: 1,
      kind: KIND_INFANTRY,
      x,
      y,
      radius: map.townR[town] >> 1,
      wander: false,
      garrisonTown: town,
    });
    add(1, KIND_TANK, Math.floor((tanks * share[k]) / 4), x + fx(70), y, 30);
  }
  return cmds;
}
