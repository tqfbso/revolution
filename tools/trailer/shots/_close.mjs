export default { params: 'map=euro&time=day&army=nato&foe=russia', warm: 3, dur: 1, fps: 1,
  setup: () => { const T = window.T; [0,3,8,10,4,12,1,2,16].forEach((k, i) => T.spawn(1, k, 1, 600 - i * 9, 467, 1)); [0,3,1,1,2,16,10].forEach((k, i) => T.spawn(0, k, 1, 600 - i * 9, 474, 1)); },
  events: [{ at: 1, run: () => window.T.info() }],
  cam: () => ({ pos: [585, 16, 500], target: [565, 1, 469], fov: 50, lod: 30 }) };
