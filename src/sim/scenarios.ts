import { CMD_FOUND, CMD_SPAWN, type Command } from './commands';
import { B_HQ } from './economy';
import { fx } from './fixed';
import { CELL_SHIFT, type GameMap } from './map';
import {
  KIND_AD,
  KIND_ARTILLERY,
  KIND_ATGM,
  KIND_DRONE,
  KIND_EW,
  KIND_IFV,
  KIND_INFANTRY,
  KIND_RECON,
  KIND_STRIKE,
  KIND_TANK,
  KIND_TRUCK,
} from './units';
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
  // A battlegroup: 35% tanks, 15% carriers, 10% missile teams, 4% guns, the rest rifle squads.
  const tanks = Math.floor((perSide * 35) / 100);
  const ifvs = Math.floor((perSide * 15) / 100);
  const atgms = Math.floor(perSide / 10);
  const guns = Math.floor(perSide / 25);
  // The sensor fight: 2% recon teams, 2% recon drones, 4% strike drones, 2% air defence,
  // 1% jammers.
  const recon = Math.floor(perSide / 50);
  const strike = Math.floor(perSide / 25);
  const jammers = Math.max(1, Math.floor(perSide / 100));
  const infantry = perSide - tanks - ifvs - atgms - guns - 3 * recon - strike - jammers;
  const cmds: Command[] = [];
  const add = (team: number, kind: number, count: number, x: number, y: number, r: number) => {
    if (count > 0)
      cmds.push({ type: CMD_SPAWN, count, team, kind, x, y, radius: fx(r), wander: false });
  };
  // Red: armour in front, carriers and infantry behind, missile teams at the back, all
  // short of the west half of the central town.
  add(0, KIND_TANK, tanks, map.townX[0] - fx(75), map.townY[0], 40);
  add(0, KIND_IFV, ifvs, map.townX[0] - fx(100), map.townY[0], 40);
  add(0, KIND_INFANTRY, infantry, map.townX[0] - fx(120), map.townY[0], 40);
  add(0, KIND_ATGM, atgms, map.townX[0] - fx(135), map.townY[0], 40);
  add(0, KIND_ARTILLERY, guns, map.townX[0] - fx(170), map.townY[0], 25);
  add(0, KIND_RECON, recon, map.townX[0] - fx(60), map.townY[0], 30);
  add(0, KIND_AD, recon, map.townX[0] - fx(95), map.townY[0], 35);
  add(0, KIND_EW, jammers, map.townX[0] - fx(105), map.townY[0], 15);
  add(0, KIND_DRONE, recon, map.townX[0] - fx(125), map.townY[0], 20);
  add(0, KIND_STRIKE, strike, map.townX[0] - fx(150), map.townY[0], 20);
  // Blue: half the force at the central town, a quarter at each village. Missile teams
  // get the first pick of the houses, riflemen the rest; armour waits behind.
  const share = [2, 1, 1];
  for (let k = 0; k < 3; k++) {
    const town = 2 * k + 1;
    const x = map.townX[town];
    const y = map.townY[town];
    for (const [kind, count] of [
      [KIND_RECON, recon],
      [KIND_ATGM, atgms],
      [KIND_INFANTRY, infantry],
    ]) {
      cmds.push({
        type: CMD_SPAWN,
        count: Math.floor((count * share[k]) / 4),
        team: 1,
        kind,
        x,
        y,
        radius: map.townR[town] >> 1,
        wander: false,
        garrisonTown: town,
      });
    }
    add(1, KIND_TANK, Math.floor((tanks * share[k]) / 4), x + fx(70), y, 30);
    add(1, KIND_IFV, Math.floor((ifvs * share[k]) / 4), x + fx(85), y, 30);
    add(1, KIND_ARTILLERY, Math.floor((guns * share[k]) / 4), x + fx(120), y, 20);
    // The town sits under a jammer and air defence; blue's own drones wait behind it.
    add(1, KIND_EW, Math.max(1, Math.floor((jammers * share[k]) / 4)), x + fx(25), y, 8);
    add(1, KIND_AD, Math.floor((recon * share[k]) / 4), x + fx(40), y, 25);
    add(1, KIND_DRONE, Math.floor((recon * share[k]) / 4), x + fx(10), y, 20);
    add(1, KIND_STRIKE, Math.floor((strike * share[k]) / 4), x + fx(60), y, 20);
  }
  return cmds;
}

/**
 * The skirmish: an even start. Each army has a headquarters, six trucks and a patrol (twelve
 * rifle squads, four carriers, two recon teams), and nobody holds a town. Red is the
 * player; blue is played by the AI (see src/sim/ai.ts), which builds its own fortress.
 */
export function skirmishCommands(map: GameMap): Command[] {
  if (map.startX[0] < 0 || map.startX[1] < 0) return assaultCommands(map, 600);
  const cmds: Command[] = [];
  for (let team = 0; team < 2; team++) {
    cmds.push({ type: CMD_FOUND, team, building: B_HQ, x: map.startX[team], y: map.startY[team] });
  }
  for (let team = 0; team < 2; team++) {
    // The patrol stands on the side of the base that faces the river.
    const dir = team === 0 ? 1 : -1;
    const hx = (map.startX[team] << CELL_SHIFT) + fx(6);
    const hy = (map.startY[team] << CELL_SHIFT) + fx(6);
    const add = (kind: number, count: number, dx: number, dy: number) =>
      cmds.push({
        type: CMD_SPAWN,
        count,
        team,
        kind,
        x: hx + dir * fx(dx),
        y: hy + fx(dy),
        radius: fx(1),
        wander: false,
      });
    add(KIND_TRUCK, 6, 0, 24);
    add(KIND_INFANTRY, 12, 34, 0);
    add(KIND_IFV, 4, 34, 22);
    add(KIND_RECON, 2, 34, -22);
  }
  return cmds;
}
