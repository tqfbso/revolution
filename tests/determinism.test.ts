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
      '59b28bc3',
      'a159a508',
      '55810ea4',
      'ea1e3f1d',
      '24485ec5',
      'f32ed4e0',
      'a9e8471f',
      'f605bf57',
    ]);
    // A pinned game that never reaches the fighting would pin very little.
    expect(alive).toBeGreaterThan(200);
    expect(deaths).toBeGreaterThan(20);
  });

  it('four armies on the four corners map play out exactly as pinned', () => {
    const { marks, alive, deaths } = play('four', 4, 6);
    expect(marks).toEqual(['9609e966', '2ee62c91', 'a673f625', '417867aa', 'f4cc5f7c', 'efa4bce9']);
    expect(alive).toBeGreaterThan(400);
    expect(deaths).toBeGreaterThan(100);
  });
});
