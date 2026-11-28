import { dolly } from './_lib.mjs';
export default {
  params: 'map=euro&time=night',
  warm: 3,
  dur: 6,
  cam: dolly(
    6,
    { pos: [772, 60, 290], target: [575, 0, 420], fov: 32, lod: 120 },
    { pos: [742, 54, 316], target: [560, 0, 432], fov: 32, lod: 120 },
  ),
};
