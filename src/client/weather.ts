// The weather of a battle as it looks (decision 125): the sky and the light, snow lying on
// what faces the sky, wet ground under rain, and the rain or the snow itself falling
// through the air round the camera. What the weather does to sight is in the sim
// (WEATHER_SIGHT_PCT); this file only draws.
//
// The weather is chosen when the game starts and never changes during one, so everything
// here is decided when the materials are built: a clear day costs nothing.
import * as THREE from 'three/webgpu';
import {
  attribute,
  float,
  mix,
  normalWorld,
  positionWorld,
  smoothstep,
  texture,
  uv,
  vec3,
} from 'three/tsl';
import { Batch } from './batch';
import {
  WEATHER_CLEAR,
  WEATHER_FOG,
  WEATHER_NAMES,
  WEATHER_RAIN,
  WEATHER_SNOW,
} from '../sim/units';

type V3 = THREE.Node<'vec3'>;
type F = THREE.Node<'float'>;

export { WEATHER_NAMES };

let now = WEATHER_CLEAR;
let noise: THREE.Texture | null = null;

/** Set once, before any material is built. `tex` is a tiling noise for the snow's edge. */
export function setWeather(kind: number, tex: THREE.Texture | null): void {
  now = kind;
  noise = tex;
}

export const weatherNow = (): number => now;

/** The weather called `name` in a URL or a menu, or clear. */
export function weatherByName(name: string | null | undefined): number {
  const k = WEATHER_NAMES.indexOf((name ?? '') as (typeof WEATHER_NAMES)[number]);
  return k < 0 ? WEATHER_CLEAR : k;
}

/**
 * The colour of a surface in this weather. Snow lies on whatever faces the sky, thinner
 * where `bare` (0..1) says the ground is trodden or driven on; rain darkens everything.
 */
export function weathered(c: V3, bare?: F): V3 {
  if (now === WEATHER_SNOW) {
    const up = smoothstep(0.42, 0.8, normalWorld.y);
    // Broken at the edges and in patches, so grass and roof tiles show through here and there.
    // Two sizes of patch from two channels, so the repeat of the noise does not show.
    const xz = positionWorld.xz;
    const n = noise
      ? texture(noise, xz.div(31))
          .r.mul(0.4)
          .add(texture(noise, xz.div(137).add(0.37)).g.mul(0.6))
      : float(0.5);
    const patchy = smoothstep(0.34, 0.62, n.add(0.1));
    let cover: F = up.mul(patchy.mul(0.5).add(0.5)).mul(0.84);
    if (bare) cover = cover.mul(float(1).sub(bare.mul(0.85)));
    return mix(c, vec3(0.8, 0.83, 0.88), cover);
  }
  if (now === WEATHER_RAIN) return c.mul(vec3(0.76, 0.79, 0.83));
  if (now === WEATHER_FOG) return c.mul(vec3(0.92, 0.93, 0.94));
  return c;
}

/** How rough a surface is in this weather: wet ground shines. */
export function weatheredRoughness(r: F): F {
  return now === WEATHER_RAIN ? r.sub(0.4).clamp(0.1, 1) : r;
}

/** The sky, the haze and the light of each weather, by day. */
export interface Sky {
  sky: number;
  fogNear: number;
  fogFar: number;
  hemiSky: number;
  hemiGround: number;
  hemi: number;
  sun: number;
  sunPower: number;
  /** How much of the sun's disc and glare is left in the reflections, 0..1. */
  shine: number;
  shadowRadius: number;
}

export function skyOf(kind: number): Sky | null {
  if (kind === WEATHER_RAIN) {
    return {
      sky: 0x7d858b,
      fogNear: 240,
      fogFar: 1350,
      hemiSky: 0xbfc8d0,
      hemiGround: 0x4a4a44,
      hemi: 1.6,
      sun: 0xdde3ea,
      sunPower: 1.8,
      shine: 0.12,
      shadowRadius: 4,
    };
  }
  if (kind === WEATHER_FOG) {
    return {
      sky: 0xaeb3b3,
      fogNear: 50,
      fogFar: 760,
      hemiSky: 0xd0d5d6,
      hemiGround: 0x595851,
      hemi: 1.9,
      sun: 0xf0e9dc,
      sunPower: 1.0,
      shine: 0.1,
      shadowRadius: 5,
    };
  }
  if (kind === WEATHER_SNOW) {
    return {
      sky: 0xb9c0c8,
      fogNear: 260,
      fogFar: 1500,
      hemiSky: 0xd9e2ee,
      hemiGround: 0x8f959c,
      hemi: 1.3,
      sun: 0xe9eef6,
      sunPower: 1.25,
      shine: 0.2,
      shadowRadius: 3.5,
    };
  }
  return null;
}

const BOX = 90;
const TALL = 60;

/**
 * Rain or snow falling round the camera: a fixed number of streaks or flakes in a box that
 * follows the view, each wrapped round to the other side when it leaves, so the box is
 * always full and nothing is ever created or destroyed. One draw call.
 */
export class Precipitation {
  readonly group = new THREE.Group();
  private readonly batch: Batch | null = null;
  private readonly seeds: Float32Array;
  private readonly count: number;
  private readonly snow: boolean;
  private time = 0;
  private readonly at = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();

  constructor(kind: number, quality: 'low' | 'normal' | 'high') {
    this.snow = kind === WEATHER_SNOW;
    // Rain is a hint, not a curtain (decision 133): a whole game behind 2,600 bright fast
    // streaks made the player dizzy. A fifth as many, and the wet ground carries the mood.
    const wanted = kind === WEATHER_RAIN ? 520 : this.snow ? 2000 : 0;
    this.count = Math.round(wanted * (quality === 'low' ? 0.4 : quality === 'high' ? 1.4 : 1));
    this.seeds = new Float32Array(this.count * 4);
    for (let i = 0; i < this.count * 4; i++) this.seeds[i] = Math.random();
    if (this.count === 0) return;
    // A streak leans with the wind; a flake is a small soft dot. Both face the camera
    // about the vertical only, which is right for a view from above and to the side.
    const g = this.snow
      ? new THREE.PlaneGeometry(0.24, 0.24).rotateX(-0.7)
      : new THREE.PlaneGeometry(0.028, 1.1).rotateZ(-0.12);
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, side: THREE.DoubleSide });
    const tint = attribute('aTint', 'vec4');
    m.colorNode = tint.xyz;
    const d = uv().sub(0.5);
    m.opacityNode = this.snow
      ? tint.w.mul(smoothstep(0.5, 0.15, d.length()))
      : tint.w.mul(smoothstep(0.5, 0.1, d.x.abs())).mul(smoothstep(0.5, 0.2, d.y.abs()));
    m.depthWrite = false;
    m.fog = false;
    this.batch = new Batch(g, m, this.count);
    this.batch.mesh.renderOrder = 3;
    this.group.add(this.batch.mesh);
  }

  /** `distance` is how far the camera is from what it looks at. */
  update(dt: number, camera: THREE.Camera, distance: number, night: boolean): void {
    const b = this.batch;
    if (!b) return;
    this.time += dt;
    b.n = 0;
    // The box sits between the camera and the ground it looks at, nearer the camera when
    // it is far out: from high up the rain is a veil in front of the lens, not on the ground.
    camera.getWorldDirection(this.fwd);
    const ahead = Math.min(distance * 0.55, 46);
    this.at.copy(camera.position).addScaledVector(this.fwd, ahead);
    const cx = this.at.x;
    const cy = this.at.y;
    const cz = this.at.z;
    const yaw = Math.atan2(this.fwd.x, this.fwd.z);
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    // Slower than real rain: at 34 a streak crossed the screen in a few frames, which reads
    // as flicker. At 19 the eye can follow it.
    const fall = this.snow ? 3.2 : 19;
    const windX = this.snow ? 1.6 : 2.4;
    const windZ = this.snow ? 0.7 : 0.8;
    const t = this.time;
    const bright = night ? 0.45 : 1;
    // Rain is nearly the grey of its sky, so a streak is a faint change, not a white line.
    const r = (this.snow ? 0.95 : 0.62) * bright;
    const g = (this.snow ? 0.96 : 0.66) * bright;
    const bl = (this.snow ? 0.98 : 0.71) * bright;
    const alpha = this.snow ? 0.8 : 0.13;
    // Nothing close to the lens: near streaks are the large fast ones. Snow keeps its 8 m.
    const clear = this.snow ? 64 : 484;
    const full = this.snow ? 400 : 1600;
    const s = this.seeds;
    const px = camera.position.x;
    const py = camera.position.y;
    const pz = camera.position.z;
    for (let i = 0; i < this.count; i++) {
      const o = i * 4;
      // Where it would be had it fallen since the start, wrapped into the box round `at`.
      let x = s[o] * BOX + windX * t;
      let y = s[o + 1] * TALL - fall * (0.8 + 0.4 * s[o + 3]) * t;
      let z = s[o + 2] * BOX + windZ * t;
      if (this.snow) {
        x += Math.sin(t * 0.9 + s[o + 3] * 40) * 0.6;
        z += Math.cos(t * 0.7 + s[o + 3] * 31) * 0.6;
      }
      x = cx + ((((x - cx) % BOX) + BOX) % BOX) - BOX / 2;
      y = cy + ((((y - cy) % TALL) + TALL) % TALL) - TALL / 2;
      z = cz + ((((z - cz) % BOX) + BOX) % BOX) - BOX / 2;
      // Right in front of the lens a streak would be a white bar across the screen.
      const dx = x - px;
      const dy = y - py;
      const dz = z - pz;
      const near = dx * dx + dy * dy + dz * dz;
      if (near < clear) continue;
      const a = near < full ? (alpha * (near - clear)) / (full - clear) : alpha;
      b.put(x, y, z, sin, cos, 1, r, g, bl, a);
    }
    b.flush();
  }
}
