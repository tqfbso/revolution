// Kowloon: an eighteen-storey tower (structure 24) shot down by tanks and guns.
export default {
  params: 'map=kowloon&time=day&army=russia&foe=nato',
  warm: +(process.env.WARM ?? 5),
  dur: +(process.env.DUR ?? 240),
  setup: () => {
    const T = window.T;
    const b = T.struct(24);
    window.B = b;
    T.spawn(0, 0, 8, b.x - 6, b.z + b.d / 2 + 30, 9);
    T.spawn(0, 4, 8, b.x + 150, b.z - 30, 8);
  },
  events: [
    {
      at: 3,
      run: () => {
        const T = window.T,
          b = window.B;
        const tanks = T.ids(0, [0], [b.x - 6, b.z + b.d / 2 + 30, 40]);
        const guns = T.ids(0, [4], [b.x + 150, b.z - 30, 30]);
        T.hitStruct(tanks, 24);
        T.bombard(guns, b.x - b.w / 2 + 3, b.z + b.d / 2 - 3);
        return { b, tanks: tanks.length, guns: guns.length };
      },
    },
  ],
  log: () => [window.__revolution.structures.hp[24]],
  track: () => window.B,
  cams: {
    wide: (t, s) => {
      const b = s.track;
      return {
        pos: [b.x - 92 + t * 1.2, 66, b.z + 104],
        target: [b.x, 30 - t * 0.6, b.z],
        fov: 34,
        lod: 60,
      };
    },
  },
};
