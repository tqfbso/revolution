import { describe, expect, it } from 'vitest';
import { CMD_SPAWN, CMD_WEATHER, type Command } from '../src/sim/commands';
import { fx } from '../src/sim/fixed';
import { flatMap } from '../src/sim/map';
import { step } from '../src/sim/sim';
import {
  KINDS,
  KIND_TANK,
  WEATHER_CLEAR,
  WEATHER_FOG,
  WEATHER_RAIN,
  WEATHER_SIGHT_PCT,
  WEATHER_SNOW,
} from '../src/sim/units';
import { NO_TARGET, createWorld, hashWorld } from '../src/sim/world';

/** Two tanks `gap` apart (a fraction of a tank's sight) for five seconds: did they see each other? */
function meet(weather: number, gap: number): { saw: boolean; hash: number } {
  const w = createWorld(7, flatMap());
  const sight = KINDS[KIND_TANK].sight;
  const tank = (team: number, x: number): Command => ({
    type: CMD_SPAWN,
    count: 1,
    team,
    x,
    y: fx(500),
    radius: fx(0.2),
    wander: false,
    kind: KIND_TANK,
  });
  const first: Command[] = [tank(0, fx(400)), tank(1, fx(600))];
  if (weather !== WEATHER_CLEAR) first.unshift({ type: CMD_WEATHER, weather });
  step(w, first);
  // Spawning scatters them: put them exactly `gap` of a tank's sight apart.
  const a = w.team[0] === 0 ? 0 : 1;
  w.posX[a] = fx(400);
  w.posX[1 - a] = fx(400) + Math.round(sight * gap);
  w.posY[0] = w.posY[1] = fx(500);
  let saw = false;
  for (let t = 0; t < 100; t++) {
    step(w, []);
    if (w.attack[0] !== NO_TARGET || w.attack[1] !== NO_TARGET) saw = true;
  }
  return { saw, hash: hashWorld(w) };
}

describe('weather (decision 125)', () => {
  it('shortens sight: least in rain, most in fog', () => {
    expect(WEATHER_SIGHT_PCT[WEATHER_CLEAR]).toBe(100);
    expect(WEATHER_SIGHT_PCT[WEATHER_FOG]).toBeLessThan(WEATHER_SIGHT_PCT[WEATHER_SNOW]);
    expect(WEATHER_SIGHT_PCT[WEATHER_SNOW]).toBeLessThan(WEATHER_SIGHT_PCT[WEATHER_RAIN]);
    // At nine tenths of a tank's sight: seen on a clear day, not in any weather.
    expect(meet(WEATHER_CLEAR, 0.9).saw).toBe(true);
    for (const k of [WEATHER_RAIN, WEATHER_FOG, WEATHER_SNOW]) expect(meet(k, 0.9).saw).toBe(false);
    // At seven tenths: seen in rain and snow, still not in fog.
    expect(meet(WEATHER_RAIN, 0.7).saw).toBe(true);
    expect(meet(WEATHER_SNOW, 0.7).saw).toBe(true);
    expect(meet(WEATHER_FOG, 0.7).saw).toBe(false);
    expect(meet(WEATHER_FOG, 0.45).saw).toBe(true);
  });

  it('is part of the state, and a weather that does not exist is refused', () => {
    expect(meet(WEATHER_RAIN, 0.3).hash).not.toBe(meet(WEATHER_CLEAR, 0.3).hash);
    const w = createWorld(1, flatMap());
    step(w, [{ type: CMD_WEATHER, weather: 9 }]);
    expect(w.weather).toBe(WEATHER_CLEAR);
    step(w, [{ type: CMD_WEATHER, weather: WEATHER_SNOW }]);
    expect(w.weather).toBe(WEATHER_SNOW);
  });
});
