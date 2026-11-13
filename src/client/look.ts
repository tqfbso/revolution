// What the whole renderer shares: the quality level and the textures made at start-up.
import * as THREE from 'three/webgpu';
import { makeSurfaces } from './surfaces';
import { makeTextures, type Textures } from './textures';

/**
 * `low` is close to the look before the realism pass and costs about as little: no surface
 * detail, no cloud shadows, no reflections. `normal` has all of it. `high` adds glow around
 * fire and a sharper shadow map.
 */
export type Quality = 'low' | 'normal' | 'high';

export interface Look {
  quality: Quality;
  /** Surface detail, cloud shadows, reflections: everything but `low`. */
  rich: boolean;
  shadows: boolean;
  tex: Textures;
  /** The city's materials, one a layer (surfaces.ts). */
  surf: THREE.DataArrayTexture;
}

export function readQuality(params: URLSearchParams): Quality {
  let q = params.get('quality');
  if (q === null) {
    try {
      q = localStorage.getItem('revolution.quality');
    } catch {
      // storage may be blocked; the default is fine
    }
  }
  return q === 'low' || q === 'high' ? q : 'normal';
}

export function makeLook(quality: Quality, shadows: boolean): Look {
  const tex = makeTextures(quality === 'low' ? 256 : 512);
  return { quality, rich: quality !== 'low', shadows, tex, surf: makeSurfaces(tex.wall) };
}

/** A tiny sky (gradient, haze at the horizon, a soft sun) for the reflections to read. */
export function skyScene(sunDir: THREE.Vector3): THREE.Scene {
  const size = 256;
  const px = new Uint8Array(size * size * 4);
  const zenith = [0.32, 0.47, 0.68];
  const horizon = [0.78, 0.8, 0.78];
  const ground = [0.2, 0.19, 0.15];
  // Equirectangular: x is the compass direction, y runs from straight up to straight down.
  const sunU = Math.atan2(sunDir.z, sunDir.x) / (2 * Math.PI) + 0.5;
  const sunV = Math.acos(sunDir.y) / Math.PI;
  for (let y = 0; y < size; y++) {
    const v = y / (size - 1);
    const up = Math.cos(v * Math.PI);
    for (let x = 0; x < size; x++) {
      const u = x / size;
      let c: number[];
      if (up >= 0) {
        const t = Math.pow(1 - up, 2.2);
        c = zenith.map((z, k) => z + (horizon[k] - z) * t);
      } else {
        const t = Math.min(1, -up * 6);
        c = horizon.map((h, k) => h + (ground[k] - h) * t);
      }
      let du = Math.abs(u - sunU);
      if (du > 0.5) du = 1 - du;
      const d = Math.hypot(du * 2 * Math.sin(v * Math.PI), v - sunV);
      const glow = Math.exp(-d * d * 160) * 1.0 + Math.exp(-d * d * 14) * 0.22;
      const k = (y * size + x) * 4;
      px[k] = Math.min(255, (c[0] + glow) * 255);
      px[k + 1] = Math.min(255, (c[1] + glow * 0.92) * 255);
      px[k + 2] = Math.min(255, (c[2] + glow * 0.75) * 255);
      px[k + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(px, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  const scene = new THREE.Scene();
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(50, 32, 16),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide }),
  );
  scene.add(dome);
  return scene;
}
