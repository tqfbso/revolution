// I6: rooftops and ambushes (the inspiration review, decision 155).
//
// A squad on a roof sees and reaches further and hits a vehicle on its top plate, but has
// only a parapet round it (the rules are in fire() and resolveShells() in sim.ts; the
// numbers, ROOF_*, in units.ts). An ambush holds its fire until an enemy vehicle enters
// the circle it was given, or the enemy finds one of its men, and then every unit waiting
// on that circle opens up at once.
import { CMD_AMBUSH, type AmbushCommand, type Command } from './commands';
import { clampInt } from './fixed';
import { CLASS_VEHICLE, STAGE_GUTTED } from './map';
import { stageOf, validUnits } from './sim';
import { AMBUSH_MAX, AMBUSH_MIN, AMBUSH_PERIOD, KINDS } from './units';
import {
  EV_AMBUSH,
  FLAG_HOLD,
  MAP_SIZE_FX,
  STANCE_AMBUSH,
  STANCE_FREE,
  STATE_ALIVE,
  type World,
} from './world';

const ARMED = KINDS.map((k) => k.damage.some((d) => d > 0));
const VEHICLE = KINDS.map((k) => k.cls === CLASS_VEHICLE);
const ON_FOOT = KINDS.map((k) => k.garrison);

/** Is unit `i` up on a roof: told to be, inside a building that still has one? */
export function onRoof(w: World, i: number): boolean {
  const s = w.inside[i];
  return w.roof[i] !== 0 && s >= 0 && stageOf(w, s) < STAGE_GUTTED;
}

/** Men on foot (or in a house) lying in wait: hard to see wherever they are. */
export function lurking(w: World, j: number): boolean {
  return w.stance[j] === STANCE_AMBUSH && ON_FOOT[w.kind[j]];
}

/** The Ambush order. Returns whether `cmd` was one. */
export function applyAmbushCommand(w: World, cmd: Command): boolean {
  if (cmd.type !== CMD_AMBUSH) return false;
  layAmbush(w, cmd);
  return true;
}

function layAmbush(w: World, cmd: AmbushCommand): void {
  const x = clampInt(cmd.x | 0, 0, MAP_SIZE_FX - 1);
  const y = clampInt(cmd.y | 0, 0, MAP_SIZE_FX - 1);
  const r = clampInt(cmd.radius | 0, AMBUSH_MIN, AMBUSH_MAX);
  for (const id of validUnits(w, cmd.units)) {
    const k = w.kind[id];
    // Guns that lob shells and anything in the air have no business lying in wait.
    if (!ARMED[k] || KINDS[k].indirect || !(VEHICLE[k] || ON_FOOT[k])) continue;
    // Where they stand, or in the house they are in: they hold there and fight from there.
    w.flags[id] = FLAG_HOLD;
    w.path[id] = -1;
    w.targetX[id] = w.posX[id];
    w.targetY[id] = w.posY[id];
    w.stance[id] = STANCE_AMBUSH;
    w.ambX[id] = x;
    w.ambY[id] = y;
    w.ambR[id] = r;
  }
}

/** Any order but the ambush itself (and a few that change nothing they do) calls it off. */
export function callOff(w: World, units: readonly number[]): void {
  for (let k = 0; k < units.length; k++) {
    const id = units[k];
    if (Number.isInteger(id) && id >= 0 && id < w.count && w.stance[id] === STANCE_AMBUSH) {
      w.stance[id] = STANCE_FREE;
    }
  }
}

/**
 * Every AMBUSH_PERIOD ticks each waiting unit (in turn) looks at its circle. An enemy
 * vehicle inside it that the army knows of, or that the unit itself is close enough to see,
 * springs the ambush; so does the enemy having spotted the unit.
 */
export function updateAmbush(w: World): void {
  const n = w.count;
  const tick = w.tick;
  for (let i = 0; i < n; i++) {
    if (w.stance[i] !== STANCE_AMBUSH || w.state[i] !== STATE_ALIVE) continue;
    if (((tick + i) & (AMBUSH_PERIOD - 1)) !== 0) continue;
    if (w.carrier[i] >= 0) {
      w.stance[i] = STANCE_FREE;
      continue;
    }
    // Found out: no point in waiting any longer.
    if (w.spotted[i] > tick) {
      spring(w, i, -1);
      continue;
    }
    const v = vehicleIn(w, i);
    if (v >= 0) spring(w, i, v);
  }
}

/** An enemy vehicle in the circle of `i` that it knows of, or -1. */
function vehicleIn(w: World, i: number): number {
  const cx = w.ambX[i];
  const cy = w.ambY[i];
  const r2 = w.ambR[i] * w.ambR[i];
  const sight = KINDS[w.kind[i]].sight;
  const s2 = sight * sight;
  const team = w.team[i];
  const tick = w.tick;
  for (let j = 0; j < w.count; j++) {
    if (w.state[j] !== STATE_ALIVE || !VEHICLE[w.kind[j]] || w.team[j] === team) continue;
    const dx = w.posX[j] - cx;
    const dy = w.posY[j] - cy;
    if (dx * dx + dy * dy > r2) continue;
    if (w.spotted[j] > tick) return j;
    const ex = w.posX[j] - w.posX[i];
    const ey = w.posY[j] - w.posY[i];
    if (ex * ex + ey * ey <= s2) return j;
  }
  return -1;
}

/** Everyone of the army waiting on the same circle as `i` opens fire, now. */
function spring(w: World, i: number, by: number): void {
  const team = w.team[i];
  const x = w.ambX[i];
  const y = w.ambY[i];
  const r = w.ambR[i];
  for (let k = 0; k < w.count; k++) {
    if (w.stance[k] !== STANCE_AMBUSH || w.team[k] !== team) continue;
    if (w.ambX[k] !== x || w.ambY[k] !== y || w.ambR[k] !== r) continue;
    w.stance[k] = STANCE_FREE;
    // They have been aiming all this time: the first round goes now, together.
    w.cooldown[k] = 0;
  }
  w.events.push(EV_AMBUSH, i, by);
}
