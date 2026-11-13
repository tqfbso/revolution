import { describe, expect, it } from 'vitest';
import {
  ALERT_ARMY,
  ALERT_BASE,
  ALERT_CONTACT,
  AlertBook,
  contactText,
} from '../src/client/alerts';
import { KIND_COUNT, KIND_INFANTRY, KIND_TANK } from '../src/sim/units';

describe('battle alerts', () => {
  it('raises one alert per kind and area, and again only after a while', () => {
    const book = new AlertBook();
    expect(book.raise(ALERT_BASE, 100, 100, 'Base under attack', 0)).not.toBeNull();
    // The same fight a second later, a few metres on: no second banner.
    expect(book.raise(ALERT_BASE, 110, 95, 'Base under attack', 1)).toBeNull();
    expect(book.raise(ALERT_BASE, 110, 95, 'Base under attack', 30)).toBeNull();
    expect(book.raise(ALERT_BASE, 110, 95, 'Base under attack', 51)).not.toBeNull();
    expect(book.list.length).toBe(2);
  });

  it('tells kinds and areas apart, but never fires two of a kind in quick succession', () => {
    const book = new AlertBook();
    expect(book.raise(ALERT_ARMY, 100, 100, 'a', 0)).not.toBeNull();
    // Another kind in the same place is its own alert.
    expect(book.raise(ALERT_BASE, 100, 100, 'b', 1)).not.toBeNull();
    // The same kind far away: held back for a few seconds, then raised.
    expect(book.raise(ALERT_ARMY, 900, 900, 'c', 2)).toBeNull();
    expect(book.raise(ALERT_ARMY, 900, 900, 'c', 12)).not.toBeNull();
  });

  it('keeps quiet about a fight the player is watching, for a while after too', () => {
    const book = new AlertBook();
    book.quiet(ALERT_ARMY, 300, 300, 100);
    expect(book.open(ALERT_ARMY, 300, 300, 105)).toBe(false);
    expect(book.open(ALERT_ARMY, 300, 300, 116)).toBe(true);
  });

  it('remembers only the latest alerts', () => {
    const book = new AlertBook();
    for (let k = 0; k < 30; k++) book.raise(ALERT_CONTACT, 100, 100, `n${k}`, k * 100);
    expect(book.list.length).toBe(12);
    expect(book.list[11].text).toBe('n29');
  });

  it('reports a group of enemies as one line', () => {
    const counts = new Array<number>(KIND_COUNT).fill(0);
    counts[KIND_INFANTRY] = 40;
    expect(contactText(counts)).toBe('Contact: 40 enemy units');
    counts[KIND_TANK] = 3;
    expect(contactText(counts)).toBe('Contact: 43 enemy units, 3 main battle tanks');
    const one = new Array<number>(KIND_COUNT).fill(0);
    one[KIND_TANK] = 1;
    expect(contactText(one)).toBe('Contact: enemy main battle tank');
  });
});
