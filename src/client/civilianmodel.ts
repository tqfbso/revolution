// The civilian figures (decision 111): people, not blocks. They are built the way the
// soldiers are (soldiers.ts): skins over rings, in metres at true proportions, then brought
// to the map at the soldiers' own scale, so a civilian beside a rifle squad is the same
// size of person. No helmet, no kit, no weapon: a jacket, a long coat or a hooded top with
// a rucksack, caught in mid-stride. Each comes in two strides, which the renderer swaps to
// make them run.
import * as THREE from 'three/webgpu';
import { box, merge } from './models';
import { loft, setWear, type Ring } from './shape';

/** Map units per metre: the soldiers' scale (soldiers.ts), where 1.8 m stands 0.62 tall. */
export const CIVILIAN_SCALE = 0.62 / 1.8;
/** The kinds of figure, and the two strides of each. */
export const CIVILIAN_KINDS = 3;
export const CIVILIAN_STRIDES = 2;

const THIGH = 0.42;
const SHIN = 0.46;
const UPPER = 0.28;
const HIP_X = 0.085;
const SHOULDER_X = 0.185;

interface Look {
  skin: number;
  hair: number;
  legs: number;
  shoes: number;
  /** Long hair, a long coat, a hood and a rucksack. */
  long: boolean;
  coat: boolean;
  hood: boolean;
  /** Narrower in the shoulder, a little shorter. */
  slight: boolean;
}

const LOOKS: Look[] = [
  {
    skin: 0xb89a82,
    hair: 0x2a231e,
    legs: 0x2c3038,
    shoes: 0x1d1c1b,
    long: false,
    coat: false,
    hood: false,
    slight: false,
  },
  {
    skin: 0xc7a58c,
    hair: 0x5a3d28,
    legs: 0x3d3a40,
    shoes: 0x2a2320,
    long: true,
    coat: true,
    hood: false,
    slight: true,
  },
  {
    skin: 0x8a6649,
    hair: 0x17140f,
    legs: 0x55524a,
    shoes: 0xd8d6cf,
    long: false,
    coat: false,
    hood: true,
    slight: false,
  },
];

/**
 * One limb segment hanging from a joint at `at`, swung by `a` about the x axis (positive
 * swings its far end back). Returns the skin and where the far end is, for the next joint.
 */
function swing(
  rings: Ring[],
  len: number,
  at: [number, number, number],
  a: number,
  o: { seg: number; color?: number; team?: number },
): [THREE.BufferGeometry, [number, number, number]] {
  const g = loft(rings, { ...o, cloth: true, rot: [a, 0, 0], at });
  return [g, [at[0], at[1] - Math.cos(a) * len, at[2] - Math.sin(a) * len]];
}

/**
 * Figure `kind` (0 to CIVILIAN_KINDS - 1) in stride 0 (left leg leading) or 1 (right leg
 * leading), feet on the ground at the origin, facing +Z, at map scale. The clothes above
 * the waist take the instance's colour (the team mask); everything else is its own.
 */
export function buildCivilian(kind: number, stride: number): THREE.BufferGeometry {
  const look = LOOKS[kind % LOOKS.length];
  const side = stride === 0 ? 1 : -1;
  const w = look.slight ? 0.9 : 1;
  setWear(0.018);
  const parts: THREE.BufferGeometry[] = [];
  // Running: the leading thigh well forward, the trailing knee bent and the heel up.
  const lead = { thigh: -0.55, shin: -0.28 };
  const trail = { thigh: 0.34, shin: 1.08 };
  const hipY = Math.cos(lead.thigh) * THIGH + Math.cos(lead.shin) * SHIN + 0.03;
  const leg = (x: number, p: { thigh: number; shin: number }) => {
    const [thigh, knee] = swing(
      [
        { y: 0.03, rx: 0.078 * w, rz: 0.088 },
        { y: -0.12, rx: 0.08 * w, rz: 0.09 },
        { y: -0.3, rx: 0.064 * w, rz: 0.07 },
        { y: -THIGH, rx: 0.054, rz: 0.06 },
      ],
      THIGH,
      [x, hipY, 0],
      p.thigh,
      { seg: 7, color: look.legs },
    );
    const [shin] = swing(
      [
        { y: 0.02, rx: 0.054, rz: 0.06 },
        { y: -0.12, rx: 0.054, rz: 0.064, z: -0.01 },
        { y: -0.3, rx: 0.04, rz: 0.044 },
        { y: -0.37, rx: 0.042, rz: 0.05, color: look.shoes },
        { y: -0.43, rx: 0.046, rz: 0.085, z: 0.04, color: look.shoes },
        { y: -SHIN, rx: 0.046, rz: 0.1, z: 0.05, color: look.shoes },
      ],
      SHIN,
      knee,
      p.shin,
      { seg: 7, color: look.legs },
    );
    parts.push(thigh, shin);
  };
  leg(-HIP_X * side, lead);
  leg(HIP_X * side, trail);

  // The body leans into the run. Its rings start at the hips; a long coat starts lower.
  const lean = 0.16;
  const body: Ring[] = [
    { y: 0.0, rx: 0.15 * w, rz: 0.1 },
    { y: 0.1, rx: 0.16 * w, rz: 0.11 },
    { y: 0.22, rx: 0.142 * w, rz: 0.098 },
    { y: 0.36, rx: 0.165 * w, rz: 0.112 },
    { y: 0.46, rx: 0.19 * w, rz: 0.11 },
    { y: 0.525, rx: 0.15 * w, rz: 0.088 },
    { y: 0.57, rx: 0.052, rz: 0.055 },
  ];
  if (look.coat) {
    // The skirts of the coat, flaring to the knee and open to the stride.
    body.unshift({ y: -0.36, rx: 0.2 * w, rz: 0.17 }, { y: -0.18, rx: 0.175 * w, rz: 0.135 });
  }
  const at: [number, number, number] = [0, hipY, 0];
  parts.push(loft(body, { seg: 9, square: 2.4, team: 1, cloth: true, rot: [lean, 0, 0], at }));
  // Where a point `up` the leaning spine and `out` in front of it is.
  const spine = (up: number, out = 0): [number, number, number] => [
    0,
    hipY + Math.cos(lean) * up - Math.sin(lean) * out,
    Math.sin(lean) * up + Math.cos(lean) * out,
  ];
  // Head: a neck, a face and the hair over it.
  const neck = spine(0.56);
  parts.push(
    loft(
      [
        { y: 0, rx: 0.05, rz: 0.053 },
        { y: 0.06, rx: 0.049, rz: 0.056 },
        { y: 0.09, rx: 0.068, rz: 0.08, z: 0.008 },
        { y: 0.16, rx: 0.078, rz: 0.092, z: 0.006 },
        { y: 0.225, rx: 0.066, rz: 0.08 },
        { y: 0.25, rx: 0.03, rz: 0.04 },
      ],
      { seg: 8, color: look.skin, rot: [lean * 0.5, 0, 0], at: neck },
    ),
    loft(
      [
        { y: look.long ? 0.02 : 0.12, rx: look.long ? 0.07 : 0.08, rz: 0.06, z: -0.045 },
        { y: 0.15, rx: 0.084, rz: 0.075, z: -0.03 },
        { y: 0.215, rx: 0.08, rz: 0.094, z: -0.004 },
        { y: 0.262, rx: 0.04, rz: 0.05, z: -0.004 },
      ],
      { seg: 8, color: look.hair, rot: [lean * 0.5, 0, 0], at: neck },
    ),
  );
  if (look.hood) {
    const back = spine(0.5, -0.1);
    parts.push(
      loft(
        [
          { y: -0.06, rx: 0.07, rz: 0.03 },
          { y: 0.02, rx: 0.1, rz: 0.055 },
          { y: 0.09, rx: 0.07, rz: 0.035 },
        ],
        { seg: 6, team: 1, cloth: true, rot: [lean, 0, 0], at: back },
      ),
      // A rucksack, in its own colour.
      loft(
        [
          { y: -0.2, rx: 0.12, rz: 0.06 },
          { y: -0.14, rx: 0.14, rz: 0.085 },
          { y: 0.1, rx: 0.135, rz: 0.08 },
          { y: 0.17, rx: 0.1, rz: 0.05 },
        ],
        {
          seg: 7,
          square: 3,
          color: 0x394150,
          cloth: true,
          rot: [lean, 0, 0],
          at: spine(0.3, -0.175),
        },
      ),
    );
  }
  if (look.coat) {
    // A bag on a strap, at the hip on the trailing side.
    parts.push(
      box(0.07, 0.17, 0.22, {
        at: [(SHOULDER_X + 0.03) * side, hipY - 0.02, -0.02],
        color: 0x4a3526,
        cloth: true,
      }),
    );
  }
  // Arms swing against the legs, bent at the elbow.
  const arm = (x: number, upper: number, fore: number) => {
    const sh = spine(0.47);
    const [u, elbow] = swing(
      [
        { y: 0.04, rx: 0.03, rz: 0.034 },
        { y: 0.005, rx: 0.056 * w, rz: 0.062 },
        { y: -0.12, rx: 0.048 * w, rz: 0.054 },
        { y: -UPPER, rx: 0.04, rz: 0.044 },
      ],
      UPPER,
      [x, sh[1], sh[2]],
      upper,
      { seg: 6, team: 1 },
    );
    const [f] = swing(
      [
        { y: 0.01, rx: 0.04, rz: 0.044 },
        { y: -0.1, rx: 0.04, rz: 0.043 },
        { y: -0.21, rx: 0.032, rz: 0.034 },
        { y: -0.225, rx: 0.034, rz: 0.04, color: look.skin, team: 0 },
        { y: -0.3, rx: 0.03, rz: 0.042, color: look.skin, team: 0 },
      ],
      0.3,
      elbow,
      fore,
      { seg: 6, team: 1 },
    );
    parts.push(u, f);
  };
  // The arm on the leading leg's side is back, the other forward with the fist up.
  arm(-SHOULDER_X * w * side, 0.55, -0.35);
  arm(SHOULDER_X * w * side, -0.6, -1.75);
  setWear(0.045);
  const g = merge(parts);
  const s = CIVILIAN_SCALE * (look.slight ? 0.95 : 1);
  g.scale(s, s, s);
  return g;
}
