// A look at the whole map from above, and its towns and big buildings.
const map = process.env.MAP ?? 'city',
  time = process.env.TIME ?? 'day';
export default {
  params: `map=${map}&time=${time}`,
  warm: 1,
  dur: 4,
  fps: 1,
  events: [
    {
      at: 0.5,
      run: () => ({
        towns: window.T.towns(),
        n: window.__revolution.map.structCount,
        tall: (() => {
          const m = window.__revolution.map,
            o = [];
          for (let s = 0; s < m.structCount; s++)
            if (m.sFloors[s] >= 5)
              o.push([s, m.sX[s] * 4, m.sY[s] * 4, m.sW[s], m.sH[s], m.sFloors[s]]);
          return o.slice(0, 60);
        })(),
      }),
    },
  ],
  cam: (t) =>
    [
      { pos: [512, 900, 512.1 + 500], target: [512, 0, 512], fov: 50, lod: 800 },
      { pos: [512, 380, 900], target: [512, 0, 480], fov: 45, lod: 300 },
      { pos: [300, 120, 700], target: [512, 0, 470], fov: 40, lod: 200 },
      { pos: [760, 60, 300], target: [512, 5, 455], fov: 36, lod: 100 },
    ][Math.floor(t)],
};
