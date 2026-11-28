const map = process.env.MAP ?? 'city';
export default { params: `map=${map}&time=day`, warm: 0.5, dur: 1, fps: 1,
  cam: () => ({ pos: [512, 1500, 512.5], target: [512, 0, 512], fov: 37.7, lod: 200 }) };
