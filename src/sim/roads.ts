// Road speed (decision 165; Fabio, 2026-11-28: "yes"). A vehicle on a road or a paved
// square goes faster than across fields, yards and parks: wheels gain the most, tracks
// less. Men on foot and anything in the air are not helped.
//
// Which vehicles roll on wheels is a matter of each army's real kit, not of the kind:
// a carrier is tracked in the Western alliance and Russia (Bradley, BMP), wheeled in China
// (the ZBL-09 family); the artillery is a tracked gun except China's truck gun and the
// rebels' rocket truck; air defence is tracked except Russia's Pantsir, on a lorry. Trucks,
// jammer vans and every rebel pickup are wheeled.
import { FACTIONS } from './factions';
import { KIND_AD, KIND_ARTILLERY, KIND_COUNT, KIND_EW, KIND_IFV, KIND_TRUCK } from './units';
import { CLASS_VEHICLE } from './map';
import type { World } from './world';

/** Percent faster on a road: wheels and tracks. */
export const ROAD_WHEELED_PCT = 30;
export const ROAD_TRACKED_PCT = 15;

/** Wheeled kinds in the plain table (No faction); everything else on the ground is tracked. */
const WHEELED_BASE: readonly number[] = [KIND_EW, KIND_TRUCK];

/** Per faction (by `short`): kinds that are wheeled there though the plain table tracks them. */
const WHEELED_IN: Readonly<Record<string, readonly number[]>> = {
  russia: [KIND_AD],
  china: [KIND_IFV, KIND_ARTILLERY],
  rebels: [KIND_IFV, KIND_ARTILLERY, KIND_AD],
};

/** Is `kind` on wheels in faction `f`? (Only meaningful for ground vehicles.) */
export function wheeled(f: number, kind: number): boolean {
  return WHEELED_BASE.includes(kind) || (WHEELED_IN[FACTIONS[f].short] ?? []).includes(kind);
}

/** Percent faster on a road, per faction and kind: 0 for men on foot and aircraft. */
export const ROAD_PCT: readonly (readonly number[])[] = FACTIONS.map((fac, f) =>
  Array.from({ length: KIND_COUNT }, (_, k) =>
    fac.kinds[k].cls !== CLASS_VEHICLE ? 0 : wheeled(f, k) ? ROAD_WHEELED_PCT : ROAD_TRACKED_PCT,
  ),
);

/** `speed` for unit `i` where it is now: faster if it is a vehicle on a road. */
export function roadPace(w: World, i: number, cell: number, speed: number): number {
  if (w.map.road[cell] === 0) return speed;
  const pct = ROAD_PCT[w.faction[w.team[i]]][w.kind[i]];
  return pct === 0 ? speed : speed + Math.trunc((speed * pct) / 100);
}
