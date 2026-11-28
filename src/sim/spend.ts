// Who spent what in a shared army. The money is the army's: any player may spend it on
// anything (Fabio's rule, nothing locked). This only keeps the books, so the team panel
// and the end screen can say who put it where. Every machine keeps the same books because
// they follow from the orders, which is also why they are not in the hash.
//
// The payer is the player whose command spent it. Spending that happens later than the
// command is booked to whoever set it going: a factory on repeat to whoever turned repeat
// on, a bulk order to whoever ordered those units, a standing order to whoever set it.
// What nobody in particular paid for (the computer, a commander's reinforcements) goes on
// the army's own row.
import {
  SPENT_BUILDINGS,
  SPENT_CREDITS,
  SPENT_FUEL,
  SPENT_NOBODY,
  SPENT_ON_BUILDINGS,
  SPENT_ON_OTHER,
  SPENT_ON_UNITS,
  SPENT_STRIDE,
  SPENT_SUPPLIES,
  SPENT_UNITS,
  STAT_SEATS,
  type World,
} from './world';

export const ON_UNITS = SPENT_ON_UNITS;
export const ON_BUILDINGS = SPENT_ON_BUILDINGS;
export const ON_OTHER = SPENT_ON_OTHER;

export interface Bill {
  supplies: number;
  fuel: number;
  credits: number;
}

/** The row `seat` spends on for army `team`: his own, or the army's if he is not in it. */
export function spendRow(w: World, team: number, seat: number): number {
  return seat >= 0 && seat < STAT_SEATS && w.seatArmy[seat] === team ? seat : SPENT_NOBODY(team);
}

/**
 * Book `bill` (times `sign`: -1 is a refund) to `seat` of army `team`, under `on`
 * (ON_UNITS, ON_BUILDINGS or ON_OTHER).
 */
export function book(w: World, team: number, seat: number, bill: Bill, on: number, sign = 1): void {
  if (team < 0 || team >= w.supplies.length) return;
  const o = spendRow(w, team, seat) * SPENT_STRIDE;
  const r = w.spent;
  r[o + SPENT_SUPPLIES] += sign * bill.supplies;
  r[o + SPENT_FUEL] += sign * bill.fuel;
  r[o + SPENT_CREDITS] += sign * bill.credits;
  r[o + on] += sign * (bill.supplies + bill.fuel + bill.credits);
  if (on === ON_UNITS) r[o + SPENT_UNITS] += sign;
  else if (on === ON_BUILDINGS) r[o + SPENT_BUILDINGS] += sign;
}
