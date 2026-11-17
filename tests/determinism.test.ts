import { describe, expect, it } from 'vitest';
import { play } from '../tools/golden';

/**
 * Golden hashes for the games people actually play: computers against each other on the
 * city map (two armies) and the four corners map (four), with factions, economy, commanders
 * and civilians all running. A change that moves one of these hashes changes the game; if
 * that is the point of the change, update the number in the same pull request and say so.
 * `tools/crossbrowser.mjs` plays the same games in Chromium, Firefox and WebKit.
 */
describe('golden games', () => {
  it('two armies on the city map play out exactly as pinned', () => {
    const { marks, alive, deaths } = play('city', 2, 8);
    // Hashes at the end of every minute: the first that differs says when the game changed.
    expect(marks).toEqual([
      'b4a23c54',
      '3c0f894c',
      'fd4dc565',
      '8857a8be',
      '5dc48e16',
      'd90d2ea0',
      '7bd479bb',
      'd881923a',
    ]);
    // A pinned game that never reaches the fighting would pin very little.
    expect(alive).toBeGreaterThan(200);
    expect(deaths).toBeGreaterThan(20);
  });

  it('four armies on the four corners map play out exactly as pinned', () => {
    const { marks, alive, deaths } = play('four', 4, 6);
    expect(marks).toEqual(['eebfd35f', '56d2e988', '7948d523', '911e7b24', '26b4177b', '1a2a54d8']);
    expect(alive).toBeGreaterThan(400);
    expect(deaths).toBeGreaterThan(100);
  });
});
