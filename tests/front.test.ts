import { describe, expect, it } from 'vitest';
import { FrontLine, type FrontSources } from '../src/client/front';

/** Two armies facing each other across the middle of the map. */
function sources(
  red: [number, number][],
  blue: [number, number][],
  sees: (x: number, z: number) => boolean = () => true,
  towns: [number, number, number][] = [],
): FrontSources {
  return {
    me: 0,
    units(add) {
      for (const [x, z] of red) add(x, z, 0, 1);
      for (const [x, z] of blue) if (sees(x, z)) add(x, z, 1, 1);
    },
    places(add) {
      for (const [x, z, team] of towns) add(x, z, team, 0.25, 70);
    },
    sees,
  };
}

const line = (x0: number, x1: number, z: number, step = 12): [number, number][] => {
  const out: [number, number][] = [];
  for (let x = x0; x <= x1; x += step) out.push([x, z], [x, z + 10]);
  return out;
};

function settle(front: FrontLine, src: FrontSources, from = 0, seconds = 10): number {
  let t = from;
  for (; t < from + seconds; t += 0.25) front.update(src, t);
  return t;
}

describe('front line', () => {
  it('runs between two armies, teeth toward the enemy', () => {
    const front = new FrontLine();
    settle(front, sources(line(200, 800, 400), line(200, 800, 600)));
    expect(front.paths.length).toBeGreaterThan(0);
    const zs: number[] = [];
    for (const p of front.paths) for (let i = 1; i < p.pts.length; i += 2) zs.push(p.pts[i]);
    const mid = zs.reduce((a, b) => a + b, 0) / zs.length;
    expect(mid).toBeGreaterThan(460);
    expect(mid).toBeLessThan(560);
    expect(front.teeth.length).toBeGreaterThan(5);
    // The enemy is south (larger z): every tooth points that way.
    for (const t of front.teeth) expect(t.nz).toBeGreaterThan(0.5);
    for (const t of front.teeth) expect(t.foe).toBe(1);
  });

  it('shows nothing where nobody meets', () => {
    const front = new FrontLine();
    settle(front, sources(line(100, 300, 100), []));
    expect(front.paths.length).toBe(0);
  });

  it('does not reveal enemies out of sight', () => {
    const front = new FrontLine();
    // Blue is there, but the player sees only the north half of the map.
    settle(
      front,
      sources(line(200, 800, 400), line(200, 800, 600), (_x, z) => z < 500),
    );
    expect(front.paths.length).toBe(0);
  });

  it('remembers a sighting for a while, and forgets it once the place is seen empty', () => {
    const front = new FrontLine();
    const red = line(200, 800, 400);
    const blue = line(200, 800, 600);
    let t = settle(front, sources(red, blue));
    // Out of sight now: still drawn from memory.
    t = settle(
      front,
      sources(red, blue, () => false),
      t,
      5,
    );
    expect(front.paths.length).toBeGreaterThan(0);
    // Looked at again and found empty: gone.
    settle(
      front,
      sources(red, [], () => true),
      t,
      6,
    );
    expect(front.paths.length).toBe(0);
  });

  it('faces each of several enemies with their own teeth', () => {
    const front = new FrontLine();
    const src: FrontSources = {
      me: 0,
      units(add) {
        for (const [x, z] of line(300, 700, 500)) add(x, z, 0, 1);
        for (const [x, z] of line(300, 480, 700)) add(x, z, 1, 1);
        for (const [x, z] of line(540, 700, 700)) add(x, z, 2, 1);
      },
      places() {},
      sees: () => true,
    };
    settle(front, src);
    const foes = new Set(front.teeth.map((t) => t.foe));
    expect(foes.has(1)).toBe(true);
    expect(foes.has(2)).toBe(true);
  });

  it('is cheap', () => {
    const front = new FrontLine();
    const src = sources(line(0, 1020, 300, 4), line(0, 1020, 700, 4), undefined, [
      [200, 200, 0],
      [800, 800, 1],
    ]);
    settle(front, src, 0, 2);
    const t0 = performance.now();
    for (let k = 0; k < 40; k++) front.update(src, 10 + k * 0.25);
    expect((performance.now() - t0) / 40).toBeLessThan(4);
  });
});

describe('front line between held towns', () => {
  it('runs between two armies’ towns a few hundred metres apart', () => {
    const front = new FrontLine();
    const src: FrontSources = {
      me: 0,
      units() {},
      places(add) {
        add(300, 500, 0, 0.25, 160);
        add(620, 500, 1, 0.25, 160);
      },
      sees: () => false,
    };
    settle(front, src);
    expect(front.paths.length).toBeGreaterThan(0);
    for (const t of front.teeth) expect(t.nx).toBeGreaterThan(0.5);
  });
});

describe('front line far apart', () => {
  it('draws nothing between towns across the map with nobody between', () => {
    const front = new FrontLine();
    const src: FrontSources = {
      me: 0,
      units() {},
      places(add) {
        add(100, 900, 0, 0.25, 160);
        add(700, 200, 1, 0.25, 160);
      },
      sees: () => false,
    };
    settle(front, src);
    expect(front.paths.length).toBe(0);
  });
});
