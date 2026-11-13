// Logistics: supply range and upkeep. Income is generous; what limits an army is keeping
// it fed and keeping it close enough to where the food comes from (decision 079).
//
// Supply comes from three things. A finished depot or headquarters and a town the army
// holds each cover a circle. A logistics truck covers a small circle of its own, but only
// while it stands within reach of one of the first two: a truck is the last link of a
// line, not a line by itself. Cut the depot or retake the town and the trucks beyond it
// carry nothing.
//
// Every ground unit has rations for two minutes. Inside supply they refill fast and the
// unit mends; outside they run down, and at nothing the unit fires at half its rate and
// its vehicles crawl.
import { BUILDINGS } from './economy';
import { FP_SHIFT, fx } from './fixed';
import { CLASS_AIR, MAP_SIZE, MAX_TEAMS } from './map';
import { KINDS, KIND_TRUCK, POINTS } from './units';
import { NO_TEAM, STATE_ALIVE, TICK_RATE, type World } from './world';

/** The supply map is in squares of 16 world units. */
export const SUPPLY_SHIFT = FP_SHIFT + 4;
export const SUPPLY_DIM = MAP_SIZE >> 4;
export const SUPPLY_CELLS = SUPPLY_DIM * SUPPLY_DIM;

/** Reach of a finished depot or headquarters, and of a held town beyond its own radius. */
export const SUPPLY_BASE = fx(150);
export const SUPPLY_TOWN = fx(70);
/** Reach of a truck, and how far from a depot or town it can stand and still be supplied. */
export const SUPPLY_TRUCK = fx(52);
export const SUPPLY_LINK = fx(260);

/** Seconds of rations a unit carries, and what it gets back per second inside supply. */
export const RATION_MAX = 120;
export const RATION_GAIN = 4;
/** Out of rations: reload times this, and vehicles at this many 256ths of their speed. */
export const HUNGRY_RELOAD = 2;
export const HUNGRY_SPEED = 154;
/** A unit in supply and out of the fight gets back its health over about this many seconds. */
const MEND_SECONDS = 150;

/** Army points that cost nothing to keep, and supplies per point above that per minute. */
export const UPKEEP_FREE = 60;
export const UPKEEP_PER_MINUTE = 4;
/** Upkeep is charged this often. */
export const UPKEEP_TICKS = 3 * TICK_RATE;

/** Units that neither eat nor go hungry: aircraft (they are their own logistics) and trucks. */
export const NEEDS_SUPPLY = KINDS.map((k, i) => k.cls !== CLASS_AIR && i !== KIND_TRUCK);

/** What an army of `pop` points costs per minute. */
export function upkeepPerMinute(pop: number): number {
  return pop > UPKEEP_FREE ? (pop - UPKEEP_FREE) * UPKEEP_PER_MINUTE : 0;
}

/** Mark the squares of `out` (one team's SUPPLY_CELLS) within `r` of (x, y). */
export function stampSupply(out: Uint8Array, base: number, x: number, y: number, r: number): void {
  const half = 1 << (SUPPLY_SHIFT - 1);
  const x0 = Math.max(0, (x - r) >> SUPPLY_SHIFT);
  const x1 = Math.min(SUPPLY_DIM - 1, (x + r) >> SUPPLY_SHIFT);
  const y0 = Math.max(0, (y - r) >> SUPPLY_SHIFT);
  const y1 = Math.min(SUPPLY_DIM - 1, (y + r) >> SUPPLY_SHIFT);
  for (let cy = y0; cy <= y1; cy++) {
    const dy = (cy << SUPPLY_SHIFT) + half - y;
    for (let cx = x0; cx <= x1; cx++) {
      const dx = (cx << SUPPLY_SHIFT) + half - x;
      if (dx * dx + dy * dy <= r * r) out[base + cy * SUPPLY_DIM + cx] = 1;
    }
  }
}

/** Fixed points of supply of every team: x, y, reach, team, four numbers each. */
const sources: number[] = [];
const fed = new Uint8Array(MAX_TEAMS);
/** Value of the supply map for an army that is not on the supply system at all. */
const OFF_SYSTEM = 2;

/**
 * Work out who is supplied where. The result (`w.supplyMap`) follows from the rest of the
 * world, so it is not hashed; it is refreshed once a second and before it is first read.
 */
export function refreshSupply(w: World): void {
  const map = w.map;
  const out = w.supplyMap;
  out.fill(0);
  sources.length = 0;
  for (let s = 0; s < map.structCount; s++) {
    const team = w.sTeam[s];
    if (team === NO_TEAM || w.sHp[s] <= 0) continue;
    const b = BUILDINGS[w.sType[s]];
    if (!b.dropOff || w.sBuild[s] < b.ticks) continue;
    sources.push(
      ((2 * map.sX[s] + map.sW[s]) << (FP_SHIFT + 2)) >> 1,
      ((2 * map.sY[s] + map.sH[s]) << (FP_SHIFT + 2)) >> 1,
      SUPPLY_BASE,
      team,
    );
  }
  for (let t = 0; t < map.townCount; t++) {
    const team = w.townOwner[t];
    if (team === NO_TEAM) continue;
    sources.push(map.townX[t], map.townY[t], map.townR[t] + SUPPLY_TOWN, team);
  }
  fed.fill(0);
  for (let k = 0; k < sources.length; k += 4) {
    fed[sources[k + 3]] = 1;
    stampSupply(out, sources[k + 3] * SUPPLY_CELLS, sources[k], sources[k + 1], sources[k + 2]);
  }
  // An army with no depot and no town at all is not on the supply system (the set-piece
  // battles and the stress test have no bases): it neither goes hungry nor mends.
  for (let t = 0; t < MAX_TEAMS; t++) {
    if (fed[t] === 0) out.fill(OFF_SYSTEM, t * SUPPLY_CELLS, (t + 1) * SUPPLY_CELLS);
  }
  // Trucks: the last link. Only one that can reach a depot or a town carries anything.
  for (let i = 0; i < w.count; i++) {
    if (w.kind[i] !== KIND_TRUCK || w.state[i] !== STATE_ALIVE || w.carrier[i] >= 0) continue;
    const team = w.team[i];
    const x = w.posX[i];
    const y = w.posY[i];
    for (let k = 0; k < sources.length; k += 4) {
      if (sources[k + 3] !== team) continue;
      const dx = sources[k] - x;
      const dy = sources[k + 1] - y;
      if (dx * dx + dy * dy > SUPPLY_LINK * SUPPLY_LINK) continue;
      stampSupply(out, team * SUPPLY_CELLS, x, y, SUPPLY_TRUCK);
      break;
    }
  }
  w.supplyTick = w.tick;
}

/** Is (x, y) inside `team`'s supply? */
export function supplied(w: World, team: number, x: number, y: number): boolean {
  return (
    w.supplyMap[team * SUPPLY_CELLS + (y >> SUPPLY_SHIFT) * SUPPLY_DIM + (x >> SUPPLY_SHIFT)] !== 0
  );
}

/**
 * One tick of logistics: the supply map once a second, each unit's rations once a second
 * (a twentieth of the army per tick), and upkeep every few seconds.
 */
export function updateLogistics(w: World): void {
  const tick = w.tick;
  if (tick % TICK_RATE === 0 || w.supplyTick < 0) refreshSupply(w);
  const n = w.count;
  for (let i = tick % TICK_RATE; i < n; i += TICK_RATE) {
    if (w.state[i] !== STATE_ALIVE || w.carrier[i] >= 0) continue;
    const kindId = w.kind[i];
    if (!NEEDS_SUPPLY[kindId]) continue;
    const here =
      w.supplyMap[
        w.team[i] * SUPPLY_CELLS +
          (w.posY[i] >> SUPPLY_SHIFT) * SUPPLY_DIM +
          (w.posX[i] >> SUPPLY_SHIFT)
      ];
    if (here === OFF_SYSTEM) continue;
    if (here !== 0) {
      const r = w.ration[i] + RATION_GAIN;
      w.ration[i] = r > RATION_MAX ? RATION_MAX : r;
      // Mending needs quiet: nothing to shoot at, and the rations full.
      const max = KINDS[kindId].hp;
      if (r >= RATION_MAX && w.hp[i] < max && w.attack[i] < 0) {
        const hp = w.hp[i] + Math.max(1, Math.trunc(max / MEND_SECONDS));
        w.hp[i] = hp > max ? max : hp;
      }
    } else if (w.ration[i] > 0) w.ration[i]--;
  }
  if (tick % UPKEEP_TICKS !== 0 || tick === 0) return;
  for (let t = 0; t < MAX_TEAMS; t++) {
    const due = Math.trunc((upkeepPerMinute(w.pop[t]) * UPKEEP_TICKS) / (60 * TICK_RATE));
    w.supplies[t] = w.supplies[t] > due ? w.supplies[t] - due : 0;
  }
}

/** Army points of `team` that are out of rations right now (for the AI and for tests). */
export function hungryPoints(w: World, team: number): number {
  let n = 0;
  for (let i = 0; i < w.count; i++) {
    if (w.state[i] === STATE_ALIVE && w.team[i] === team && w.ration[i] === 0) {
      if (NEEDS_SUPPLY[w.kind[i]]) n += POINTS[w.kind[i]];
    }
  }
  return n;
}
