// Surface textures, made in code at start-up: no downloads, no licences to track. Each is a
// height field built from tileable noise; the normal map is taken from its slopes. They are
// detail only: the colour of a thing still comes from its vertices, a texture just breaks
// it up (grain, grit, cracks, stains) and tells the light how rough the surface is.
import * as THREE from 'three/webgpu';

function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** Smooth noise in 0..1 that repeats every `period` lattice cells. */
function noise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const x0 = ((xi % period) + period) % period;
  const y0 = ((yi % period) + period) % period;
  const x1 = (x0 + 1) % period;
  const y1 = (y0 + 1) % period;
  const a = hash(x0, y0, seed);
  const b = hash(x1, y0, seed);
  const c = hash(x0, y1, seed);
  const d = hash(x1, y1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Layered noise in 0..1, tileable over the unit square. `freq` cells across at the base. */
function fbm(u: number, v: number, freq: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(u * freq, v * freq, freq, seed + o * 17);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/** Sharp creases instead of soft blobs: rock strata, cracks. */
function ridged(u: number, v: number, freq: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(2 * noise(u * freq, v * freq, freq, seed + o * 31) - 1);
    sum += amp * n * n;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/** Distance (in cells) to the nearest of a tileable scatter of points, and that point's id. */
function cells(u: number, v: number, freq: number, seed: number): [number, number] {
  const x = u * freq;
  const y = v * freq;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let best = 9;
  let id = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = (((xi + dx) % freq) + freq) % freq;
      const cy = (((yi + dy) % freq) + freq) % freq;
      const px = xi + dx + hash(cx, cy, seed);
      const py = yi + dy + hash(cx, cy, seed + 1);
      const d = Math.hypot(px - x, py - y);
      if (d < best) {
        best = d;
        id = hash(cx, cy, seed + 2);
      }
    }
  }
  return [best, id];
}

type Surface = (u: number, v: number) => { h: number; tone: number; rough: number };

/**
 * Bake a surface into one RGBA texture: R, G = normal x, y (0.5 = flat), B = tone (0.5 =
 * leave the colour alone), A = roughness.
 */
function bake(size: number, bump: number, surface: Surface): THREE.DataTexture {
  const height = new Float32Array(size * size);
  const px = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = surface(x / size, y / size);
      const k = y * size + x;
      height[k] = s.h;
      px[4 * k + 2] = Math.max(0, Math.min(255, Math.round(s.tone * 255)));
      px[4 * k + 3] = Math.max(0, Math.min(255, Math.round(s.rough * 255)));
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = height[y * size + ((x + size - 1) % size)];
      const r = height[y * size + ((x + 1) % size)];
      const d = height[((y + size - 1) % size) * size + x];
      const t = height[((y + 1) % size) * size + x];
      const nx = (l - r) * bump;
      const ny = (d - t) * bump;
      const inv = 1 / Math.hypot(nx, ny, 1);
      const k = (y * size + x) * 4;
      px[k] = Math.round((nx * inv * 0.5 + 0.5) * 255);
      px[k + 1] = Math.round((ny * inv * 0.5 + 0.5) * 255);
    }
  }
  return finish(new THREE.DataTexture(px, size, size, THREE.RGBAFormat));
}

function finish(t: THREE.DataTexture): THREE.DataTexture {
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

export interface Textures {
  /** Four unrelated noise channels, coarse to fine: clouds, stains, camouflage, grime. */
  noise: THREE.DataTexture;
  grass: THREE.DataTexture;
  dirt: THREE.DataTexture;
  rock: THREE.DataTexture;
  paved: THREE.DataTexture;
  /** Plaster and concrete: streaks, patches, hairline cracks. */
  wall: THREE.DataTexture;
  /** Painted steel: chips, scratches, grime. */
  metal: THREE.DataTexture;
  /** Ripples for the river. */
  water: THREE.DataTexture;
}

/** `size` is the edge of the detail textures in pixels: 512 normally, 256 on low quality. */
export function makeTextures(size: number): Textures {
  const n = 256;
  const px = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = x / n;
      const v = y / n;
      const k = (y * n + x) * 4;
      px[k] = Math.round(fbm(u, v, 3, 5, 11) * 255);
      px[k + 1] = Math.round(fbm(u, v, 6, 5, 23) * 255);
      px[k + 2] = Math.round(fbm(u, v, 12, 4, 37) * 255);
      px[k + 3] = Math.round(fbm(u, v, 32, 3, 51) * 255);
    }
  }
  const noiseTex = finish(new THREE.DataTexture(px, n, n, THREE.RGBAFormat));

  // Rough pasture: tufts and clumps, bare patches between them.
  const grass = bake(size, 5, (u, v) => {
    const clump = fbm(u, v, 10, 4, 101);
    const blades = fbm(u * 1.0, v * 3.0, 48, 2, 131);
    const fine = noise(u * 160, v * 160, 160, 151);
    const h = clump * 0.6 + blades * 0.3 + fine * 0.1;
    const bare = Math.max(0, 0.36 - clump) * 2.2;
    return { h, tone: 0.5 + (h - 0.5) * 0.9 - bare * 0.25, rough: 0.94 - bare * 0.1 };
  });
  // Churned earth: clods, wandering ruts that hold water, scattered stones.
  const dirt = bake(size, 6, (u, v) => {
    const clods = fbm(u, v, 14, 5, 211);
    const warp = fbm(u, v, 3, 3, 223);
    const ruts = ridged(u + warp * 0.25, v * 0.35, 9, 2, 229);
    const [d, id] = cells(u, v, 22, 241);
    const stone = id > 0.72 ? Math.max(0, 1 - d * 3.2) : 0;
    const h = clods * 0.7 - ruts * 0.18 + stone * 0.5;
    const wet = Math.max(0, 0.42 - clods) * 2.4 + Math.max(0, ruts - 0.6) * 0.8;
    return {
      h,
      tone: 0.5 + (clods - 0.5) * 0.7 + stone * 0.3 - wet * 0.25,
      rough: 0.92 - wet * 0.5 - stone * 0.15,
    };
  });
  // Weathered rock: strata, cracks, lichen blotches.
  const rock = bake(size, 7, (u, v) => {
    const strata = ridged(u, v, 5, 5, 311);
    const crack = ridged(u, v, 11, 3, 331);
    const blotch = fbm(u, v, 7, 3, 347);
    const h = strata * 0.7 + (crack > 0.82 ? -0.3 : 0) + fbm(u, v, 40, 2, 353) * 0.15;
    return {
      h,
      tone: 0.5 + (strata - 0.5) * 0.7 - (crack > 0.82 ? 0.3 : 0) + (blotch - 0.5) * 0.3,
      rough: 0.88,
    };
  });
  // Old asphalt: aggregate grain, cracks, patched repairs, oil.
  const paved = bake(size, 3, (u, v) => {
    const grain = noise(u * 180, v * 180, 180, 401);
    const [d, id] = cells(u, v, 5, 419);
    const [d2] = cells(u, v, 5, 431);
    const crack = Math.abs(d - d2 * 0.9) < 0.012 ? 1 : 0;
    const edge = ridged(u, v, 6, 3, 443) > 0.9 ? 1 : 0;
    const patch = id > 0.8 ? -0.12 : 0;
    const stain = fbm(u, v, 5, 4, 457);
    const h = grain * 0.25 - (crack + edge) * 0.6;
    return {
      h,
      tone: 0.5 + (grain - 0.5) * 0.22 + patch + (stain - 0.5) * 0.4 - (crack + edge) * 0.3,
      rough: 0.86 - Math.max(0, 0.4 - stain) * 0.9,
    };
  });
  // Rendered masonry: rain streaks run down it (v is up), patches where plaster has gone.
  const wall = bake(size, 3, (u, v) => {
    const streak = fbm(u, v * 0.12, 26, 3, 503);
    const blotch = fbm(u, v, 5, 4, 521);
    const fine = noise(u * 140, v * 140, 140, 541);
    const gone = blotch > 0.66 ? 1 : 0;
    const crack = ridged(u, v, 7, 3, 557) > 0.93 ? 1 : 0;
    const h = fine * 0.2 - gone * 0.35 - crack * 0.5;
    return {
      h,
      tone:
        0.5 +
        (streak - 0.5) * 0.5 +
        (blotch - 0.5) * 0.3 +
        (fine - 0.5) * 0.1 -
        gone * 0.14 -
        crack * 0.3,
      rough: 0.9 + gone * 0.06,
    };
  });
  // Service paint on steel: dulled, scratched to primer, chipped to bare metal at the wear.
  const metal = bake(size, 2.5, (u, v) => {
    const grime = fbm(u, v, 6, 5, 601);
    const scratch = ridged(u * 4, v * 0.5, 24, 2, 617) > 0.955 ? 1 : 0;
    const [d, id] = cells(u, v, 30, 631);
    const chip = id > 0.86 && d < 0.2 + id * 0.12 ? 1 : 0;
    const fine = noise(u * 120, v * 120, 120, 641);
    const h = fine * 0.12 - chip * 0.5 - scratch * 0.25;
    return {
      h,
      tone: 0.5 + (grime - 0.5) * 0.6 + (fine - 0.5) * 0.08 + scratch * 0.22 - chip * 0.2,
      rough: 0.72 + (grime - 0.5) * 0.4 - chip * 0.3 - scratch * 0.2,
    };
  });
  const water = bake(Math.min(size, 256), 2.2, (u, v) => {
    const h = fbm(u, v, 6, 4, 701) * 0.7 + fbm(u * 1, v * 2, 14, 2, 719) * 0.3;
    return { h, tone: h, rough: 0.1 };
  });
  return { noise: noiseTex, grass, dirt, rock, paved, wall, metal, water };
}
