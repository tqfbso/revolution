import { describe, expect, it } from 'vitest';
import { CMD_FACTION, CMD_SPAWN, CMD_TRAIN, type Command } from '../src/sim/commands';
import { B_COUNT, B_HQ, UNIT_PRICE, pricesOf, unitPrice } from '../src/sim/economy';
import {
  FACTIONS,
  FACTION_CHINA,
  FACTION_COUNT,
  FACTION_NATO,
  FACTION_NONE,
  FACTION_RUSSIA,
  factionByName,
  kindOf,
  missingOf,
} from '../src/sim/factions';
import { fx } from '../src/sim/fixed';
import { flatMap, generateMap } from '../src/sim/map';
import { skirmishCommands } from '../src/sim/scenarios';
import { step } from '../src/sim/sim';
import {
  KINDS,
  KIND_COUNT,
  KIND_EW,
  KIND_IFV,
  KIND_LIFT,
  KIND_PARA,
  KIND_STRIKE,
  KIND_TANK,
} from '../src/sim/units';
import { NO_TEAM, createWorld, hashWorld } from '../src/sim/world';

describe('factions (M10)', () => {
  it('no faction is the plain table', () => {
    expect(FACTIONS[FACTION_NONE].kinds).toBe(KINDS);
    expect(pricesOf(FACTION_NONE)).toBe(UNIT_PRICE);
    expect(FACTIONS).toHaveLength(FACTION_COUNT);
  });

  it('Russia and China each lack one kind, a different one; the alliance lacks none', () => {
    expect(missingOf(FACTION_NATO)).toEqual([]);
    // The alliance has a jammer again, a light one (decision 132); Russia's is the strongest.
    expect(FACTIONS[FACTION_NATO].kinds[KIND_EW].jam).toBeLessThan(KINDS[KIND_EW].jam);
    expect(FACTIONS[FACTION_RUSSIA].kinds[KIND_EW].jam).toBeGreaterThan(KINDS[KIND_EW].jam);
    expect(missingOf(FACTION_RUSSIA)).toEqual([KINDS[KIND_LIFT].name]);
    expect(missingOf(FACTION_CHINA)).toEqual([KINDS[KIND_PARA].name]);
    for (const f of [FACTION_RUSSIA, FACTION_CHINA]) {
      const missing = FACTIONS[f].roster.findIndex((has) => !has);
      expect(pricesOf(f)[missing].from).toBe(B_COUNT);
    }
  });

  it('the versions differ where the design says they do', () => {
    const [, nato, russia, china] = FACTIONS;
    expect(nato.kinds[KIND_TANK].hp).toBeGreaterThan(KINDS[KIND_TANK].hp);
    expect(russia.kinds[KIND_TANK].reload).toBeLessThan(KINDS[KIND_TANK].reload);
    expect(pricesOf(FACTION_RUSSIA)[KIND_TANK].supplies).toBeLessThan(
      UNIT_PRICE[KIND_TANK].supplies,
    );
    expect(pricesOf(FACTION_NATO)[KIND_TANK].supplies).toBeGreaterThan(
      UNIT_PRICE[KIND_TANK].supplies,
    );
    expect(pricesOf(FACTION_CHINA)[KIND_STRIKE].ticks).toBeLessThan(UNIT_PRICE[KIND_STRIKE].ticks);
    expect(china.kinds[KIND_IFV].carry).toBe(3);
    // A tweak never invents a weapon or takes one away, and nothing ends up at zero.
    for (let f = 1; f < FACTION_COUNT; f++) {
      for (let k = 0; k < KIND_COUNT; k++) {
        const mine = FACTIONS[f].kinds[k];
        expect(mine.range === 0).toBe(KINDS[k].range === 0);
        expect(mine.hp).toBeGreaterThan(0);
        expect(mine.speed === 0).toBe(KINDS[k].speed === 0);
        expect(mine.cls).toBe(KINDS[k].cls);
      }
    }
  });

  it('names from the URL', () => {
    expect(factionByName('nato')).toBe(FACTION_NATO);
    expect(factionByName('russia')).toBe(FACTION_RUSSIA);
    expect(factionByName('china')).toBe(FACTION_CHINA);
    expect(factionByName('none')).toBe(FACTION_NONE);
    expect(factionByName('atlantis')).toBe(FACTION_NONE);
    expect(factionByName(null)).toBe(FACTION_NONE);
  });

  it('CMD_FACTION gives an army its versions, and only that army', () => {
    const w = createWorld(3, flatMap());
    const spawn = (team: number): Command => ({
      type: CMD_SPAWN,
      count: 1,
      team,
      x: fx(200 + team * 400),
      y: fx(500),
      radius: fx(2),
      wander: false,
      kind: KIND_TANK,
    });
    step(w, [{ type: CMD_FACTION, team: 0, faction: FACTION_NATO }, spawn(0), spawn(1)]);
    expect(w.faction[0]).toBe(FACTION_NATO);
    expect(w.faction[1]).toBe(FACTION_NONE);
    const a = w.team[0] === 0 ? 0 : 1;
    expect(kindOf(w, a).name).toBe('Heavy tank');
    expect(kindOf(w, 1 - a)).toBe(KINDS[KIND_TANK]);
    expect(w.hp[a]).toBe(FACTIONS[FACTION_NATO].kinds[KIND_TANK].hp);
    expect(w.hp[1 - a]).toBe(KINDS[KIND_TANK].hp);
    // A faction that does not exist is refused.
    step(w, [{ type: CMD_FACTION, team: 1, faction: 9 }]);
    expect(w.faction[1]).toBe(FACTION_NONE);
  });

  it('a faction cannot train the kind it lacks', () => {
    const w = createWorld(1, generateMap(1, 'ridge'));
    step(w, [{ type: CMD_FACTION, team: 0, faction: FACTION_RUSSIA }, ...skirmishCommands(w.map)]);
    let hq = -1;
    for (let s = 0; s < w.map.structCount; s++) {
      if (w.sTeam[s] === 0 && w.sType[s] === B_HQ) hq = s;
    }
    expect(hq).toBeGreaterThanOrEqual(0);
    expect(unitPrice(w, 0, KIND_LIFT).from).toBe(B_COUNT);
    w.credits[0] = w.supplies[0] = w.fuel[0] = 100000;
    for (let s = 0; s < w.map.structCount; s++) {
      if (w.sTeam[s] !== NO_TEAM) step(w, [{ type: CMD_TRAIN, structure: s, kind: KIND_LIFT }]);
    }
    let queued = 0;
    for (let s = 0; s < w.map.structCount; s++) queued += w.sQueueLen[s];
    expect(queued).toBe(0);
  });

  it('a game with factions is still deterministic, and differs from one without', () => {
    const run = (fa: number, fb: number): number => {
      const w = createWorld(5, generateMap(5, 'ridge'));
      const first: Command[] = [];
      if (fa) first.push({ type: CMD_FACTION, team: 0, faction: fa });
      if (fb) first.push({ type: CMD_FACTION, team: 1, faction: fb });
      step(w, [...first, ...skirmishCommands(w.map)]);
      for (let t = 0; t < 200; t++) step(w, []);
      return hashWorld(w);
    };
    expect(run(FACTION_NATO, FACTION_RUSSIA)).toBe(run(FACTION_NATO, FACTION_RUSSIA));
    expect(run(FACTION_NATO, FACTION_RUSSIA)).not.toBe(run(0, 0));
  });
});
