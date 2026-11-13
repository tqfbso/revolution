// The city's materials, baked on the graphics card at start-up (R5, decision 091).
//
// Each surface is a small shader: plaster, brick, concrete panels, clay tiles, corrugated
// sheet, roofing felt, sacking, broken masonry. It is drawn once into a square, read back,
// its slopes turned into a normal map, and stored as one layer of an array texture. A wall
// picks its layer with a number per vertex, so the whole city is still one material and
// one draw call per square of ground. Nothing is downloaded (decision 060 stands).
//
// Until the bake has run (and for good, if the graphics card refuses it) every layer holds
// the plain plaster that textures.ts makes on the processor, so the game never waits on it.
import * as THREE from 'three/webgpu';
import { cos, float, floor, fract, min, mix, smoothstep, texture, uv, vec2, vec3 } from 'three/tsl';

export const SURF_PLASTER = 0;
export const SURF_BRICK = 1;
export const SURF_PANEL = 2;
export const SURF_TILE = 3;
export const SURF_SHEET = 4;
export const SURF_FELT = 5;
export const SURF_SACK = 6;
export const SURF_RUBBLE = 7;
export const SURF_COUNT = 8;

/** World units that one repeat of each surface covers. */
export const SURF_SCALE = [7, 2.2, 5.2, 1.6, 3, 5, 1.5, 4];
/** How strongly each surface's height field bends the light. */
const BUMP = [2, 6, 2.5, 8, 6, 2.5, 8, 7];

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;

/** Layers of plain plaster, to be replaced by the bake. */
export function makeSurfaces(wall: THREE.DataTexture): THREE.DataArrayTexture {
  const src = wall.image.data as Uint8Array;
  const size = wall.image.width;
  const data = new Uint8Array(src.length * SURF_COUNT);
  for (let l = 0; l < SURF_COUNT; l++) data.set(src, l * src.length);
  const t = new THREE.DataArrayTexture(data, size, size, SURF_COUNT);
  t.format = THREE.RGBAFormat;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

/** The shaders: each gives (height, tone, roughness), all 0..1, tone 0.5 = leave alone. */
function surfaces(noise: THREE.Texture): V3[] {
  const p = uv();
  const n = (sx: number, sy = sx, ox = 0, oy = 0) =>
    texture(noise, p.mul(vec2(sx, sy)).add(vec2(ox, oy)));
  const ridge = (v: F): F => float(1).sub(v.mul(2).sub(1).abs());
  // A number per cell of a grid, the same on both edges of the square so it tiles.
  const perCell = (ix: F, iy: F, nx: number, ny: number, k: number): F =>
    texture(
      noise,
      vec2(ix.mod(nx), iy.mod(ny))
        .add(0.5)
        .mul(vec2(37 / 256, 91 / 256))
        .add(k * 0.173),
    ).x;
  /** A staggered bond of `nx` by `ny` units: where in its unit a pixel is, and which unit. */
  const bond = (nx: number, ny: number): { cell: V2; ix: F; iy: F } => {
    const y = p.y.mul(ny);
    const iy = floor(y);
    const x = p.x.mul(nx).add(iy.mod(2).mul(0.5));
    return { cell: vec2(fract(x), fract(y)), ix: floor(x), iy };
  };
  const edge = (c: F): F => min(c, float(1).sub(c));

  const fine = n(16).w;
  const blotch = n(2).x;
  const streak = n(6, 1).y;

  // 0 Plaster: rain streaks down it, patches where the render has gone, hairline cracks.
  const gone = smoothstep(0.6, 0.64, n(3, 3, 0.31, 0.17).z);
  const crack = smoothstep(0.965, 0.985, ridge(n(4, 4, 0.11, 0.53).y));
  const plaster = vec3(
    float(0.6).add(fine.mul(0.2)).sub(gone.mul(0.3)).sub(crack.mul(0.3)),
    float(0.5)
      .add(streak.sub(0.5).mul(0.5))
      .add(blotch.sub(0.5).mul(0.3))
      .sub(gone.mul(0.14))
      .sub(crack.mul(0.3)),
    float(0.9).add(gone.mul(0.06)),
  );

  // 1 Brick: running bond, the mortar set back, no two bricks fired quite alike.
  const b = bond(8, 16);
  const face = smoothstep(0.05, 0.13, min(edge(b.cell.x).mul(2), edge(b.cell.y)));
  const fired = perCell(b.ix, b.iy, 8, 16, 1);
  const brick = vec3(
    face.mul(0.55).add(fine.mul(0.18)).add(0.1),
    mix(float(0.66), fired.mul(0.3).add(0.36), face)
      .add(streak.sub(0.5).mul(0.22))
      .add(blotch.sub(0.5).mul(0.2)),
    mix(float(0.96), float(0.84), face),
  );

  // 2 Precast concrete panels: joints, tie holes, a dirty streak under every joint.
  const pc = fract(p.mul(2));
  const joint = float(1).sub(smoothstep(0.012, 0.03, min(edge(pc.x), edge(pc.y))));
  const hole = float(1).sub(
    smoothstep(
      0.018,
      0.03,
      fract(pc.mul(vec2(2, 2)).add(0.5))
        .sub(0.5)
        .length(),
    ),
  );
  const run = n(14, 1, 0.4, 0)
    .z.mul(float(1).sub(pc.y))
    .mul(smoothstep(0.35, 0.6, n(14, 1).y));
  const panel = vec3(
    float(0.6).add(fine.mul(0.12)).sub(joint.mul(0.5)).sub(hole.mul(0.3)),
    float(0.52)
      .add(blotch.sub(0.5).mul(0.24))
      .sub(run.mul(0.34))
      .sub(joint.mul(0.3))
      .sub(hole.mul(0.2))
      .add(
        perCell(floor(p.x.mul(2)), floor(p.y.mul(2)), 2, 2, 2)
          .sub(0.5)
          .mul(0.12),
      ),
    float(0.88).sub(run.mul(0.1)),
  );

  // 3 Clay tiles: courses lapped one over the next, each tile a shallow barrel.
  const t = bond(10, 12);
  const barrel = cos(t.cell.x.sub(0.5).mul(Math.PI)).mul(0.5);
  const lap = float(1).sub(smoothstep(0.0, 0.2, t.cell.y));
  const moss = smoothstep(0.58, 0.7, n(3, 3, 0.7, 0.2).x).mul(fine);
  const tile = vec3(
    float(1).sub(t.cell.y).mul(0.6).add(barrel.mul(0.4)),
    float(0.42)
      .add(perCell(t.ix, t.iy, 10, 12, 3).mul(0.26))
      .sub(lap.mul(0.24))
      .sub(moss.mul(0.3))
      .add(streak.sub(0.5).mul(0.16)),
    float(0.82).add(moss.mul(0.12)),
  );

  // 4 Corrugated sheet: ribs, a lap between sheets, rust running down from each lap.
  const rib = cos(p.x.mul(48 * Math.PI))
    .mul(0.5)
    .add(0.5);
  const seam = float(1).sub(smoothstep(0.004, 0.014, edge(fract(p.y.mul(3)))));
  const rust = smoothstep(0.5, 0.75, n(24, 2, 0.2, 0.6).z).mul(n(5).x.mul(0.7).add(0.3));
  const sheet = vec3(
    rib.mul(0.8).sub(seam.mul(0.2)).add(0.1),
    float(0.5)
      .add(rib.mul(0.1))
      .sub(rust.mul(0.26))
      .sub(seam.mul(0.25))
      .add(blotch.sub(0.5).mul(0.14)),
    float(0.5).add(rust.mul(0.42)),
  );

  // 5 Roofing felt: strips with tarred seams, grit, lighter patches of repair.
  const strip = float(1).sub(smoothstep(0.006, 0.02, edge(fract(p.y.mul(5)))));
  const patch = smoothstep(0.66, 0.68, n(2, 2, 0.45, 0.8).y);
  const felt = vec3(
    float(0.5).add(fine.mul(0.3)).add(strip.mul(0.25)).add(patch.mul(0.12)),
    float(0.48)
      .add(fine.sub(0.5).mul(0.3))
      .sub(strip.mul(0.22))
      .add(patch.mul(0.14))
      .add(blotch.sub(0.5).mul(0.3)),
    float(0.94).sub(strip.mul(0.45)),
  );

  // 6 Sacking: sandbags laid like bricks, each a tight pillow.
  const s = bond(3, 5);
  const pillow = smoothstep(0, 0.22, edge(s.cell.x)).mul(smoothstep(0, 0.4, edge(s.cell.y)));
  const sack = vec3(
    pillow.mul(0.85).add(fine.mul(0.15)),
    float(0.3)
      .add(pillow.mul(0.26))
      .add(perCell(s.ix, s.iy, 3, 5, 4).mul(0.16))
      .add(fine.sub(0.5).mul(0.12)),
    float(0.96),
  );

  // 7 Broken masonry: lumps of every size, dust in the hollows.
  const lumps = ridge(n(5).x)
    .mul(0.55)
    .add(ridge(n(13, 13, 0.3, 0.7).y).mul(0.3))
    .add(fine.mul(0.15));
  const rubble = vec3(lumps, float(0.3).add(lumps.mul(0.42)), float(0.95));

  return [plaster, brick, panel, tile, sheet, felt, sack, rubble];
}

/**
 * Bake every surface into `target` (made by makeSurfaces). Returns false, leaving the
 * plaster in place, if the graphics card will not do it.
 */
export async function bakeSurfaces(
  renderer: THREE.WebGPURenderer,
  noise: THREE.Texture,
  target: THREE.DataArrayTexture,
): Promise<boolean> {
  const size = target.image.width;
  const out = target.image.data as Uint8Array;
  const rt = new THREE.RenderTarget(size, size, { depthBuffer: false });
  const material = new THREE.MeshBasicNodeMaterial();
  material.toneMapped = false;
  const quad = new THREE.QuadMesh(material);
  const before = renderer.getRenderTarget();
  const layers: Uint8Array[] = [];
  let flipped = false;
  try {
    const list = [...surfaces(noise), vec3(uv().y)];
    for (let l = 0; l <= SURF_COUNT; l++) {
      material.colorNode = list[l].clamp(0, 1);
      material.needsUpdate = true;
      renderer.setRenderTarget(rt);
      quad.render(renderer);
      renderer.setRenderTarget(before);
      const px = (await renderer.readRenderTargetPixelsAsync(rt, 0, 0, size, size)) as Uint8Array;
      if (px.length < size * size * 4) return false;
      // The last pass is a ramp up the square: it tells which way up this card reads back.
      if (l === SURF_COUNT) flipped = px[0] > px[(size - 1) * size * 4];
      else layers.push(px);
    }
  } catch (e) {
    console.warn('surface bake failed; the city keeps plain plaster', e);
    renderer.setRenderTarget(before);
    return false;
  } finally {
    rt.dispose();
    material.dispose();
  }
  // A card that hands back nothing but one value has not really drawn: keep the plaster.
  const probe = layers[SURF_BRICK];
  let lo = 255;
  let hi = 0;
  for (let k = 0; k < probe.length; k += 4 * 97) {
    lo = Math.min(lo, probe[k]);
    hi = Math.max(hi, probe[k]);
  }
  if (hi - lo < 24) return false;
  for (let l = 0; l < SURF_COUNT; l++) {
    const px = layers[l];
    if (flipped) {
      const row = size * 4;
      for (let y = 0; y < size >> 1; y++) {
        const a = y * row;
        const b = (size - 1 - y) * row;
        const keep = px.slice(a, a + row);
        px.copyWithin(a, b, b + row);
        px.set(keep, b);
      }
    }
    const o = l * size * size * 4;
    const bump = BUMP[l] / 255;
    for (let y = 0; y < size; y++) {
      const up = ((y + size - 1) % size) * size;
      const dn = ((y + 1) % size) * size;
      for (let x = 0; x < size; x++) {
        const k = (y * size + x) * 4;
        const nx =
          (px[(y * size + ((x + size - 1) % size)) * 4] - px[(y * size + ((x + 1) % size)) * 4]) *
          bump;
        const ny = (px[(up + x) * 4] - px[(dn + x) * 4]) * bump;
        const inv = 1 / Math.hypot(nx, ny, 1);
        out[o + k] = Math.round((nx * inv * 0.5 + 0.5) * 255);
        out[o + k + 1] = Math.round((ny * inv * 0.5 + 0.5) * 255);
        out[o + k + 2] = px[k + 1];
        out[o + k + 3] = px[k + 2];
      }
    }
  }
  target.needsUpdate = true;
  return true;
}
