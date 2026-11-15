// Which faction each army is (M10, sim/factions.ts), for everything on screen that names a
// unit, prices it or draws how far it sees. Set once by main.ts before the views are made.
import { pricesOf, type UnitPrice } from '../sim/economy';
import { FACTIONS, type Faction } from '../sim/factions';
import type { UnitKind } from '../sim/units';

const factions = [0, 0, 0, 0];
let mine = 0;

/** `list[team]` is that army's faction; `team` is the player's own army. */
export function setArmies(list: readonly number[], team: number): void {
  for (let t = 0; t < factions.length; t++) factions[t] = list[t] ?? 0;
  mine = factions[team] ?? 0;
}

/** The faction of the army of `team`. */
export const factionOf = (team: number): number => factions[team] ?? 0;
/** The player's own faction. */
export const myFaction = (): Faction => FACTIONS[mine];
/** The player's version of every kind of unit. */
export const myKinds = (): readonly UnitKind[] => FACTIONS[mine].kinds;
/** What the player pays for each kind (a kind it does not field comes from no building). */
export const myPrices = (): readonly UnitPrice[] => pricesOf(mine);
/** What the army of `team` calls its `kind`. */
export const nameOf = (team: number, kind: number): string =>
  FACTIONS[factions[team] ?? 0].kinds[kind].name;
/** The numbers of a `kind` in the army of `team`. */
export const kindIn = (team: number, kind: number): UnitKind =>
  FACTIONS[factions[team] ?? 0].kinds[kind];
