// The ground floor and fire (I5, decision 147).
//
// A building's health is one number, and what hits it from far off or from above (shells,
// rockets, a tank across the square) takes it off the top: the roof goes, then a storey at
// a time (see brokenLevel in the client). What hits it at arm's length takes the same
// health and the ground floor as well: a tank with its muzzle against the wall, a charge,
// a vehicle that blows up against it. The ground floor is a share of the building's health
// (GROUND_PCT). When that share is gone there is nothing left to hold the floors up and
// the building pancakes, whatever health it had left.
//
// A ground floor half gone is on fire. The fire takes a floor every FIRE_CLIMB_TICKS; when
// it has the whole house the garrison comes down and out by itself, and nobody goes in
// until it has burnt out. Fire does not hurt the structure: it clears a house, it does not
// level it.
import { fx } from './fixed';
import { GROUND_PCT, S_BUILDING, groundMax } from './map';
import { leaveHouse } from './sim';
import { EV_FIRE, STATE_ALIVE, TICK_RATE, type World } from './world';

/** Direct fire from this close to the wall goes in at the ground floor. */
export const POINT_BLANK = fx(8);
/** A ground floor below this percent of its own health is alight. */
export const FIRE_PCT = 50;
/** The fire takes another floor this often. */
export const FIRE_CLIMB_TICKS = 6 * TICK_RATE;
/** How long the whole house burns before the fire is out and it can be entered again. */
export const FIRE_BURN_TICKS = 40 * TICK_RATE;
/** `sFire` of a building whose fire has burnt out. Above zero: the tick it caught, plus one. */
export const FIRE_OUT = -1;
/** `sFell`: how a building came down. */
export const FELL_TOP = 1;
export const FELL_PANCAKE = 2;

/** What a charge laid against the ground floor takes off it, for `siege` off the structure. */
export function chargeGround(siege: number): number {
  return Math.ceil((siege * GROUND_PCT) / 100);
}

/** Floors of building `s` that are burning: 0 when there is no fire (or it is out). */
export function floorsAlight(w: World, s: number): number {
  const lit = w.sFire[s];
  if (lit <= 0) return 0;
  const n = 1 + Math.trunc((w.tick - (lit - 1)) / FIRE_CLIMB_TICKS);
  const floors = w.map.sFloors[s] > 0 ? w.map.sFloors[s] : 1;
  return n < floors ? n : floors;
}

/** The fire has the whole of building `s`: nobody stays in it and nobody goes in. */
export function ablaze(w: World, s: number): boolean {
  const lit = w.sFire[s];
  if (lit <= 0) return false;
  const floors = w.map.sFloors[s] > 0 ? w.map.sFloors[s] : 1;
  return w.tick - (lit - 1) >= floors * FIRE_CLIMB_TICKS;
}

/** The ground floor of `s` has just been hit: light it if it is far enough gone. */
export function kindle(w: World, s: number): void {
  if (w.sFire[s] !== 0 || w.sGround[s] * 100 >= groundMax(w.map, s) * FIRE_PCT) return;
  w.sFire[s] = w.tick + 1;
  w.events.push(EV_FIRE, s, 0);
}

/** Twice a second: fires that have a whole house empty it, and old fires go out. */
export function updateFires(w: World): void {
  const map = w.map;
  let flush = false;
  for (let s = 0; s < map.structCount; s++) {
    const lit = w.sFire[s];
    if (lit <= 0) continue;
    const floors = map.sFloors[s] > 0 ? map.sFloors[s] : 1;
    const age = w.tick - (lit - 1);
    if (w.sHp[s] <= 0 || age >= floors * FIRE_CLIMB_TICKS + FIRE_BURN_TICKS) {
      w.sFire[s] = FIRE_OUT;
      w.events.push(EV_FIRE, s, 1);
    } else if (w.sOcc[s] > 0 && age >= floors * FIRE_CLIMB_TICKS) flush = true;
  }
  if (!flush) return;
  for (let i = 0; i < w.count; i++) {
    const s = w.inside[i];
    if (s < 0 || w.state[i] !== STATE_ALIVE || map.sKind[s] !== S_BUILDING) continue;
    if (ablaze(w, s)) leaveHouse(w, i);
  }
}
