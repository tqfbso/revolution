// A night battle on the city centre square (the menu backdrop recipe), with flares.
const M = process.env.MAP ?? 'city'; const X = 510, Z = M === 'euro' ? 505 : 455;
export default {
  params: `map=${M}&time=night&army=nato&foe=russia`, warm: +(process.env.WARM ?? 30), dur: +(process.env.DUR ?? 60), args: [X, Z],
  setup: ([x, z]) => { const T = window.T;
    for (const team of [0, 1]) { const s = team ? 1 : -1; const sp = (k, n, off, side, r, adv) => T.spawn(team, k, n, x + s * off, z + side, r, -s * adv, 0);
      sp(0, 7, 82, 0, 22, 60); sp(3, 6, 94, 20, 22, 66); sp(1, 28, 66, -25, 35, 50); sp(1, 20, 72, 40, 30, 55); sp(2, 6, 77, 10, 25, 44); sp(12, 3, 126, -30, 30, 110); sp(4, 3, 143, 0, 20, 16); sp(16, 3, 120, 30, 10, 10); } },
  events: [20, 34, 48, 62, 76].map((at, k) => ({ at, run: new Function(`const T = window.T; const m = T.ids(${k % 2}, [16, 4]); T.bombard(m.slice(0, 2), ${X + (k % 3 - 1) * 25}, ${Z + (k % 2 ? 12 : -12)}, { flare: true }); return m.length;`) })),
  log: () => { const T = window.T, u = T.g.units; return [T.ids(0).length, T.ids(1).length, u.flares.length, u.flares[0] && [Math.round(u.flares[0].x), Math.round(u.flares[0].z)]]; },
  cams: {
    menu: (t) => { const yaw = (24 + t * 1.2) * Math.PI / 180; return { pos: [X + Math.sin(yaw) * 75, 28, Z + Math.cos(yaw) * 75], target: [X, 4, Z], fov: 34, lod: 30 }; },
    low: (t) => { const yaw = (-38 + t * 1.5) * Math.PI / 180; return { pos: [X + Math.sin(yaw) * 52, 17, Z + Math.cos(yaw) * 52], target: [X, 4, Z], fov: 36, lod: 30 }; },
  },
};
