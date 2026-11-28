// A Russian column on a street (euro map, z = 467, heading east).
const W = process.env.WX ?? 'fog';
export default {
  params: `map=euro&time=day&weather=${W}&army=nato&foe=russia`,
  warm: 5,
  dur: 7,
  setup: () => {
    const T = window.T;
    const Z = 467;
    const order = [0, 0, 3, 0, 3, 3, 8, 0, 3, 3, 0, 3, 10, 10, 3, 0, 3, 3, 0, 0];
    order.forEach((k, i) => T.spawn(1, k, 1, 600 - i * 10, Z + (i % 2 ? 1.6 : -1.6), 1));
  },
  events: [
    {
      at: 0.5,
      run: () => {
        const T = window.T;
        const ids = T.ids(1, null, [500, 467, 140]);
        T.move(ids, 900, 467);
        return ids.length;
      },
    },
  ],
  track: () => {
    const T = window.T;
    const ids = T.ids(1, [0, 3, 8, 10], [600, 467, 400]);
    let x = -1e9,
      z = 0;
    for (const i of ids) {
      const p = T.pos(i);
      if (p[0] > x) {
        x = p[0];
        z = p[1];
      }
    }
    return [x, z];
  },
  log: () =>
    window.T.ids(1, [0, 3, 8, 10], [600, 467, 400])
      .slice(0, 6)
      .map((i) => window.T.pos(i).map(Math.round).join(','))
      .join(' '),
  cams: {
    axis: (t, s) => ({
      pos: [s.track[0] + 44 - t, 15 - t * 0.3, 469.5],
      target: [s.track[0] - 16, 1, 467],
      fov: 26,
      lod: 30,
    }),
  },
};
