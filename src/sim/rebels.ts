// The rebels' own rules (I8, decision 162). Their units are a faction like the others
// (factions.ts); what no table can say is here: the country is theirs.
//
// In a town where people still live (TOWN_FOLK or more of them at home):
//  - rebels on foot are as hard to see as men in a wood, until they open fire;
//  - every soldier and vehicle of another army is reported to the rebels, whoever holds
//    the flag: the people talk;
//  - a town the rebels hold sends them a band of volunteers every VOLUNTEER_TICKS, free,
//    and VOLUNTEER_FOLK of its people go with it.
// In any town, peopled or not, rebels on foot move TOWN_PACE_PCT faster: they know the yards.
//
// A town empties as it is fought over (civilians.ts): people flee, people die. So the
// army that shells a town to get the rebels out of it also takes it away from them.
import { CELL_SHIFT, MAP_CELLS, type GameMap } from './map';
import { FACTION_REBEL, pointsOf } from './factions';
import { CIV_HOME } from './civilians';
import { KINDS, KIND_INFANTRY } from './units';
import { CLASS_AIR, CLASS_FOOT } from './map';
import { EV_VOLUNTEERS, MAX_TEAMS, NO_TEAM, STATE_ALIVE, type World } from './world';

/** People at home in a town for it to hide, inform and send volunteers. */
export const TOWN_FOLK = 10;
/** Ticks between the bands of volunteers a held town sends. */
export const VOLUNTEER_TICKS = 90 * 20;
/** Civilians who leave their houses with each band. */
export const VOLUNTEER_FOLK = 3;
/** Percent of their speed that rebels on foot make in a town. */
export const TOWN_PACE_PCT = 125;
/** A civilian who took up arms: no longer in the house, not fled, not dead. */
export const CIV_JOINED = 5;
/** How often the towns are looked at, in ticks (the same second the flags are counted). */
const PERIOD = 20;
/** How long the people's word about a soldier lasts: until they are asked again. */
const WORD_TICKS = PERIOD + 2;

const IS_FOOT = KINDS.map((k) => k.cls === CLASS_FOOT);
const IS_AIR = KINDS.map((k) => k.cls === CLASS_AIR);

const cells = new WeakMap<GameMap, Uint8Array>();

/**
 * The town each cell belongs to, plus one: 0 is open country. A town is its flag's circle
 * and half as far again, the nearest flag winning where two overlap.
 */
export function townCells(map: GameMap): Uint8Array {
  let t = cells.get(map);
  if (t) return t;
  t = new Uint8Array(MAP_CELLS * MAP_CELLS);
  const half = 1 << (CELL_SHIFT - 1);
  for (let cy = 0; cy < MAP_CELLS; cy++) {
    for (let cx = 0; cx < MAP_CELLS; cx++) {
      const x = (cx << CELL_SHIFT) + half;
      const y = (cy << CELL_SHIFT) + half;
      let best = 0;
      let bestD = Infinity;
      for (let k = 0; k < map.townCount; k++) {
        const dx = (x - map.townX[k]) / 16;
        const dy = (y - map.townY[k]) / 16;
        const r = (map.townR[k] * 3) / 32;
        const d = dx * dx + dy * dy;
        if (d <= r * r && d < bestD) {
          bestD = d;
          best = k + 1;
        }
      }
      t[cy * MAP_CELLS + cx] = best;
    }
  }
  cells.set(map, t);
  return t;
}

const townAt = (w: World, x: number, y: number): number =>
  townCells(w.map)[(y >> CELL_SHIFT) * MAP_CELLS + (x >> CELL_SHIFT)] - 1;

/** Is the army of `team` the rebels? */
export const isRebel = (w: World, team: number): boolean => w.faction[team] === FACTION_REBEL;

/** Rebels on foot among the people of a town, who have not fired lately: hard to see. */
export function amongFolk(w: World, j: number): boolean {
  if (w.faction[w.team[j]] !== FACTION_REBEL || !IS_FOOT[w.kind[j]]) return false;
  if (w.reveal[j] > w.tick) return false;
  const t = townAt(w, w.posX[j], w.posY[j]);
  return t >= 0 && w.townFolk[t] >= TOWN_FOLK;
}

/** The speed of unit `i` of the rebels at `speed`: quicker on foot inside a town. */
export function townPace(w: World, i: number, speed: number): number {
  if (!IS_FOOT[w.kind[i]] || townAt(w, w.posX[i], w.posY[i]) < 0) return speed;
  return Math.trunc((speed * TOWN_PACE_PCT) / 100);
}

/**
 * Once a second, in a game with rebels in it: count who is still at home in each town,
 * pass on what the people have seen, and send out the volunteers.
 */
export function updateRebels(
  w: World,
  spawn: (kind: number, team: number, x: number, y: number) => number,
): void {
  let rebels = 0;
  for (let t = 0; t < MAX_TEAMS; t++) if (w.faction[t] === FACTION_REBEL) rebels |= 1 << t;
  if (rebels === 0) return;
  const map = w.map;
  const towns = map.townCount;
  const folk = w.townFolk;
  folk.fill(0);
  for (let k = 0; k < w.civCount; k++) {
    if (w.civState[k] !== CIV_HOME) continue;
    const t = townAt(w, w.civX[k], w.civY[k]);
    if (t >= 0 && folk[t] < 65535) folk[t]++;
  }
  // The word of the people: where the others' soldiers are.
  const until = w.tick + WORD_TICKS;
  for (let i = 0; i < w.count; i++) {
    if (w.state[i] !== STATE_ALIVE || w.carrier[i] >= 0) continue;
    const team = w.team[i];
    if ((rebels >> team) & 1 || IS_AIR[w.kind[i]] || w.spotted[i] >= until) continue;
    const t = townAt(w, w.posX[i], w.posY[i]);
    if (t < 0 || folk[t] < TOWN_FOLK) continue;
    w.spotted[i] = until;
  }
  // Volunteers. Each town in its own second, so that they do not all turn out at once.
  const beat = Math.trunc(w.tick / PERIOD);
  const every = VOLUNTEER_TICKS / PERIOD;
  for (let t = 0; t < towns; t++) {
    const owner = w.townOwner[t];
    if (owner === NO_TEAM || ((rebels >> owner) & 1) === 0) continue;
    if ((beat + t * 7) % every !== 0 || beat === 0) continue;
    if (folk[t] < TOWN_FOLK) continue;
    const points = pointsOf(w, owner, KIND_INFANTRY);
    if (w.pop[owner] + points > w.popCap[owner]) continue;
    const id = spawn(KIND_INFANTRY, owner, map.townX[t], map.townY[t]);
    if (id < 0) continue;
    w.pop[owner] += points;
    let left = VOLUNTEER_FOLK;
    for (let k = 0; k < w.civCount && left > 0; k++) {
      if (w.civState[k] !== CIV_HOME || townAt(w, w.civX[k], w.civY[k]) !== t) continue;
      w.civState[k] = CIV_JOINED;
      left--;
    }
    w.events.push(EV_VOLUNTEERS, t, owner);
  }
}
