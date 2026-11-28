// Night, euro map, the street at z = 467: a Russian column drives into a rebel ambush under a flare.
const Z = 467,
  AX = 690;
export default {
  params: 'map=euro&time=night&army=rebels&foe=russia',
  warm: +(process.env.WARM ?? 4),
  dur: +(process.env.DUR ?? 40),
  args: [Z, AX],
  setup: ([Z, AX]) => {
    const T = window.T;
    const order = [3, 0, 3, 3, 10, 3, 8, 10, 3, 10, 3, 0, 3, 10, 3, 3];
    order.forEach((k, i) => T.spawn(1, k, 1, 590 - i * 10, Z + (i % 2 ? 1.6 : -1.6), 1));
    const bs = T.structs(AX, Z, 55)
      .filter((b) => b.kind === 0 && Math.abs(b.z - Z) < 40)
      .slice(0, 6);
    window.BS = bs;
    bs.forEach((b) => {
      T.spawn(0, 1, 4, b.x, b.z, 3);
      T.spawn(0, 2, 3, b.x, b.z, 3);
    });
    T.spawn(0, 3, 6, AX + 4, Z - 60, 8);
    T.spawn(0, 2, 6, AX + 30, Z + 14, 6);
    T.spawn(0, 16, 3, AX - 10, Z + 70, 6);
    const cells = [];
    for (let x = AX - 14; x <= AX + 14; x += 7)
      cells.push(Math.floor(Z / 4) * 256 + Math.floor(x / 4));
    T.send({ type: 25, team: 0, work: 8, cells });
  },
  events: [
    {
      at: 0.6,
      run: ([Z, AX]) => {
        const T = window.T;
        const out = [];
        for (const b of window.BS) {
          const ids = T.ids(0, [1, 2], [b.x, b.z, 16]);
          T.roof(ids, b.s);
          out.push(ids.length);
        }
        T.ambush(T.ids(0, [1, 2]), AX, Z, 34);
        T.move(T.ids(1, null, [520, Z, 120]), 900, Z);
        return [window.BS.map((b) => [b.s, Math.round(b.x), Math.round(b.z), b.floors]), out];
      },
    },
    {
      at: 17,
      run: ([Z, AX]) => {
        const T = window.T;
        T.amove(T.ids(0, [3]), AX - 20, Z);
        return 'technicals';
      },
    },
    {
      at: +(process.env.FLARE ?? 9),
      run: ([Z, AX]) => {
        const T = window.T;
        const m = T.ids(0, [16]);
        T.bombard(m, AX - 8, Z, { flare: true });
        return m.length;
      },
    },
  ],
  log: () => {
    const T = window.T,
      u = T.g.units;
    let hx = 0;
    for (const i of T.ids(1, [0, 3, 8, 10], [640, 467, 200])) hx = Math.max(hx, T.pos(i)[0]);
    return [Math.round(hx), T.ids(0).length, T.ids(1).length, u.flares.length];
  },
  cams: {
    side: (t) => ({
      pos: [AX - 62 + t * 0.9, 30, Z + 50],
      target: [AX - 40 + t * 0.3, 2, Z],
      fov: 34,
      lod: 30,
    }),
    axis: (t) => ({
      pos: [AX + 40 - t * 0.6, 24, Z + 4],
      target: [AX - 40, 2, Z],
      fov: 30,
      lod: 30,
    }),
  },
};
