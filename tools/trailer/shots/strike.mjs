// Russia's air strike: a stick of bombs on armour in the city centre square.
const X = 510,
  Z = 455;
export default {
  params: 'map=city&time=day&army=russia&foe=nato',
  warm: +(process.env.WARM ?? 8),
  dur: +(process.env.DUR ?? 30),
  args: [X, Z],
  setup: ([x, z]) => {
    const T = window.T;
    T.grant(0);
    T.spawn(1, 0, 6, x, z, 16);
    T.spawn(1, 3, 3, x + 10, z + 8, 8);
    T.spawn(1, 1, 12, x - 6, z - 4, 16);
  },
  events: [
    {
      at: 6,
      run: ([x, z]) => {
        window.T.strike(0, x, z);
        return 'called';
      },
    },
  ],
  log: () => {
    const T = window.T;
    const p = T.ids(0, [15]);
    return [p.length, p[0] !== undefined && T.pos(p[0]).map(Math.round), T.ids(1).length];
  },
  cams: {
    wide: (t) => ({ pos: [X - 40 + t, 34, Z + 78], target: [X + 4, 3, Z + 6], fov: 34, lod: 30 }),
    low: (t) => ({ pos: [X + 52, 16, Z + 40 - t], target: [X, 4, Z + 4], fov: 36, lod: 30 }),
  },
};
