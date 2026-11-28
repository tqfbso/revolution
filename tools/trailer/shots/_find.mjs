const [x, z, r = 120] = (process.env.AT ?? '600,416').split(',').map(Number);
const map = process.env.MAP ?? 'euro';
export default {
  params: `map=${map}&time=${process.env.TIME ?? 'day'}&${process.env.P ?? ''}`,
  warm: 0.5,
  dur: 1,
  fps: 1,
  cam: () => ({ pos: [x, r * 2.4, z + 0.3], target: [x, 0, z], fov: 45, lod: 60 }),
};
