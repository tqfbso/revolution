import { describe, expect, it } from 'vitest';
import { FACTIONS } from '../src/sim/factions';
import { MAPS, MAX_TEAMS, generateMap, mapInfo } from '../src/sim/map';
import { validMatch, defaultMatch } from '../src/sim/match';
import {
  KINDS,
  KIND_COUNT,
  KIND_ENGINEER,
  KIND_INFANTRY,
  KIND_PARA,
  KIND_MORTAR,
  KIND_RECON,
  KIND_TANK,
  PROFILE_COUNT,
  PROFILE_FOOT,
  PROFILE_TANK,
} from '../src/sim/units';
import { FREE_MAP, matchFromParams } from '../src/client/setup';

// Architecture review F3 and F4: a unit says what it is as a target instead of owning a
// column of the damage table, and the maps are a list instead of names in the code.

describe('damage by target profile', () => {
  it('every kind names a profile, and takes what its profile takes', () => {
    expect(KINDS.length).toBe(KIND_COUNT);
    for (const f of FACTIONS) {
      for (const shooter of f.kinds) {
        expect(shooter.damage.length).toBe(KIND_COUNT);
        for (let a = 0; a < KIND_COUNT; a++) {
          expect(KINDS[a].profile).toBeGreaterThanOrEqual(0);
          expect(KINDS[a].profile).toBeLessThan(PROFILE_COUNT);
          for (let b = a + 1; b < KIND_COUNT; b++) {
            if (KINDS[a].profile !== KINDS[b].profile) continue;
            expect(shooter.damage[a], `${shooter.name} at ${KINDS[a].name}`).toBe(
              shooter.damage[b],
            );
          }
        }
      }
    }
  });

  it('men on foot are one target, a tank another', () => {
    for (const k of [KIND_INFANTRY, KIND_RECON, KIND_ENGINEER, KIND_PARA, KIND_MORTAR]) {
      expect(KINDS[k].profile).toBe(PROFILE_FOOT);
    }
    expect(KINDS[KIND_TANK].profile).toBe(PROFILE_TANK);
    // The numbers the game has always had (decision 058's toughness aside, damage is as written).
    expect(KINDS[KIND_TANK].damage).toEqual([
      60, 75, 75, 80, 90, 75, 0, 0, 90, 90, 90, 75, 0, 0, 75, 0, 75,
    ]);
    expect(KINDS[KIND_INFANTRY].damage).toEqual([
      3, 9, 9, 5, 10, 9, 1, 1, 10, 10, 10, 9, 2, 2, 9, 0, 9,
    ]);
  });
});

describe('the maps are a list', () => {
  it('each has a name, a line for the menu and a base for every army it says it takes', () => {
    expect(new Set(MAPS.map((m) => m.id)).size).toBe(MAPS.length);
    for (const m of MAPS) {
      expect(m.name.length).toBeGreaterThan(0);
      expect(m.blurb.length).toBeGreaterThan(0);
      expect(mapInfo(m.id)).toBe(m);
      expect(validMatch({ ...defaultMatch(), map: m.id })).toBe(true);
      const map = generateMap(1, m.id);
      let bases = 0;
      for (let t = 0; t < MAX_TEAMS; t++) if (map.startX[t] >= 0) bases++;
      // The river is the measuring ground: it has no bases, the scenarios place the armies.
      if (m.id !== 'river') expect(bases, m.id).toBe(m.armies);
    }
    expect(mapInfo('nowhere')).toBeUndefined();
  });

  it('an address may name any of them, and a free-for-all is fought where four have a base', () => {
    for (const m of MAPS) {
      expect(matchFromParams(new URLSearchParams(`map=${m.id}`)).map).toBe(m.id);
    }
    expect(mapInfo(FREE_MAP)?.armies).toBe(MAX_TEAMS);
    expect(matchFromParams(new URLSearchParams('armies=3&map=ridge')).map).toBe(FREE_MAP);
  });
});
