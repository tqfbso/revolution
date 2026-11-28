// Kowloon: Russian gunships over Nathan Road, heading south.
export default {
  params: 'map=kowloon&time=day&army=nato&foe=russia',
  warm: 4,
  dur: 8,
  setup: () => {
    const T = window.T;
    for (let i = 0; i < 7; i++) T.spawn(1, 12, 1, 580 + ((i * 37) % 50) - 25, 120 - i * 14, 2);
  },
  events: [
    {
      at: 0.5,
      run: () => {
        const T = window.T;
        const ids = T.ids(1, [12]);
        T.move(ids, 580, 900);
        return ids.length;
      },
    },
  ],
  track: () => window.T.centroid(1, [12]) ?? [580, 100],
  log: () => (window.T.centroid(1, [12]) ?? []).map(Math.round),
  cams: {
    over: (t) => ({
      pos: [550 - 2 * t, 120, 238 + 120 - 6 * t],
      target: [580, 30, 238],
      fov: 28,
      lod: 60,
    }),
  },
};
