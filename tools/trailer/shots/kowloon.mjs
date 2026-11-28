// Kowloon by day: two armies meet on Nathan Road.
const X = 580, Z = +(process.env.Z ?? 340);
export default {
  params: 'map=kowloon&time=day&army=nato&foe=russia', warm: +(process.env.WARM ?? 10), dur: +(process.env.DUR ?? 60), args: [X, Z],
  setup: ([x, z]) => { const T = window.T;
    for (const team of [0, 1]) { const s = team ? -1 : 1; const sp = (k, n, off, side, r, adv) => T.spawn(team, k, n, x + side, z + s * off, r, 0, -s * adv);
      sp(0, 8, 95, 0, 12, 70); sp(3, 6, 110, 4, 12, 76); sp(1, 30, 80, -8, 22, 60); sp(1, 20, 90, 10, 20, 62); sp(2, 6, 100, 0, 16, 50); sp(12, 3, 150, -20, 20, 120); sp(16, 3, 130, 0, 8, 20); } },
  log: () => { const T = window.T; return [T.ids(0).length, T.ids(1).length, T.centroid(0, [0, 3]), T.centroid(1, [0, 3])].flat().map(Math.round); },
  cams: {
    axis: (t) => ({ pos: [X + 26 - t, 62 - t, Z + 130 - t * 2], target: [X, 4, Z], fov: 30, lod: 40 }),
    side: (t) => ({ pos: [X - 85, 48, Z + 30 - t * 2], target: [X, 6, Z - t], fov: 34, lod: 40 }),
  },
};
