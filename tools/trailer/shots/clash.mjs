// The big one: thousands of units meeting in the open.
export default {
  params: `scenario=clash&time=day&units=${process.env.N ?? 3000}&army=nato&foe=russia`, warm: +(process.env.WARM ?? 10), dur: +(process.env.DUR ?? 60),
  log: () => { const T = window.T; return [T.ids(0).length, T.ids(1).length, T.centroid(0), T.centroid(1)].flat().map(Math.round); },
  cams: {
    hud: (t) => ({ game: [505 + t * 2, 497, 150 - t * 3, 0.35] }),
    line: (t) => ({ pos: [505 - 10 + t * 1.5, 45, 497 + 90], target: [505 + t * 1.5, 0, 497], fov: 40, lod: 50 }),
    mid: (t) => ({ pos: [505 + 70, 85 - t, 497 + 150 - t * 2], target: [505, 0, 497], fov: 34, lod: 90 }),
  },
};
