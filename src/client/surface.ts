// Surface detail for things built from plain coloured boxes, which have no texture
// coordinates: the textures are laid on from position instead. Buildings and field works
// use where they stand in the world; vehicles and men use the model's own space, so the
// pattern travels with them.
import * as THREE from 'three/webgpu';
import {
  cameraViewMatrix,
  float,
  int,
  mix,
  normalWorld,
  positionGeometry,
  positionWorld,
  smoothstep,
  step,
  texture,
  uniformArray,
  vec2,
  vec3,
} from 'three/tsl';
import type { Look } from './look';
import { SURF_SCALE } from './surfaces';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

export interface Detail {
  /** Multiply the colour by this: stains, streaks, patches. */
  tone: F;
  roughness: F;
  /** For `material.normalNode`: the surface normal with the texture's relief. */
  normal: V3;
}

/**
 * Masonry and concrete, laid on in world space: across a wall along its length and up its
 * height (so rain streaks run down), flat over roofs and decks. `scale` is world units per
 * repeat of the texture.
 */
export function masonry(look: Look, scale: number): Detail {
  const n = normalWorld;
  const p = positionWorld;
  const flat = smoothstep(0.5, 0.7, n.y.abs());
  // Along the wall: x for walls that face north or south, z for the others.
  const along = p.x.mul(n.z.abs()).add(p.z.mul(n.x.abs()));
  const uv = mix(vec2(along, p.y), p.xz, flat).div(scale);
  const t = texture(look.tex.wall, uv);
  const tilt = t.xy.mul(2).sub(1).mul(0.7);
  // The texture's u runs along the wall, its v up it; on a roof they are east and south.
  const side = vec3(n.z.abs(), 0, n.x.abs())
    .mul(tilt.x)
    .add(vec3(0, tilt.y, 0));
  const top = vec3(tilt.x, 0, tilt.y);
  const bent = n.add(mix(side, top, flat)).normalize();
  return {
    tone: t.b.mul(0.9).add(0.55),
    roughness: t.a,
    normal: cameraViewMatrix.transformDirection(bent),
  };
}

/**
 * The city's walls and roofs: `surf` picks the material (surfaces.ts). Walls and slopes are
 * mapped along their length and up their rise, so brick courses lie level and tiles run in
 * rows under the ridge whichever way a roof faces; flat roofs are mapped from above.
 */
export function cityFace(look: Look, surf: F): Detail {
  const n = normalWorld;
  const p = positionWorld;
  const flat = step(0.97, n.y.abs());
  const along = p.x.mul(n.z.abs()).add(p.z.mul(n.x.abs()));
  // How far up the slope, not how high: a roof's courses keep their spacing.
  const lean = n.xz.length().max(0.2);
  const layer = int(surf.add(0.5));
  const scale = uniformArray(SURF_SCALE).element(layer) as unknown as F;
  const uv = mix(vec2(along, p.y.div(lean)), p.xz, flat).div(scale);
  const t = texture(look.surf, uv).depth(layer);
  const tilt = t.xy.mul(2).sub(1).mul(0.8);
  const side = vec3(n.z.abs(), 0, n.x.abs())
    .mul(tilt.x)
    .add(vec3(0, tilt.y, 0));
  const bent = n.add(mix(side, vec3(tilt.x, 0, tilt.y), flat)).normalize();
  // A slow drift of tone across the town, so the repeat never shows from above.
  const drift = texture(look.tex.noise, p.xz.mul(0.013).add(p.y.mul(0.021))).y;
  return {
    tone: t.b.mul(0.9).add(0.55).mul(drift.mul(0.3).add(0.85)),
    roughness: t.a,
    normal: cameraViewMatrix.transformDirection(bent),
  };
}

export interface Paint {
  colour: V3;
  roughness: F;
  metalness: F;
}

/**
 * Service paint as it looks after a season in the field. `base` is the vertex colour with
 * the team marking already on it, `marking` how much of this vertex is marking, `seed` a
 * number per vehicle so that no two wear the same pattern, `burn` 0..1 turns it into a
 * burnt-out wreck.
 */
export function fieldPaint(
  look: Look,
  base: V3,
  marking: F,
  seed: F,
  burn: F,
  boxP?: V3,
  boxH?: THREE.Node<'vec4'>,
): Paint {
  const p = positionGeometry;
  const shift = vec2(seed.mul(0.37), seed.mul(0.61));
  // Wrap the pattern round the hull: over the top by x and z, down the sides by height.
  const uv = p.xz.add(vec2(p.y.mul(0.83), p.y.mul(0.57)));
  const blots = texture(look.tex.noise, uv.mul(0.11).add(shift));
  const fine = texture(look.tex.noise, uv.mul(0.9).add(shift));
  const wear = texture(look.tex.metal, uv.mul(0.55).add(shift));
  // Paint, as against rubber, steel and glass, which are much darker.
  const isPaint = smoothstep(0.034, 0.05, base.y).mul(float(1).sub(marking));
  // Three-tone disruptive pattern: the base coat, dark green blotches, a little black-brown.
  const dark = smoothstep(0.5, 0.54, blots.x);
  const black = smoothstep(0.57, 0.6, blots.y).mul(float(1).sub(dark));
  let c: V3 = mix(base, base.mul(vec3(0.5, 0.58, 0.5)), dark.mul(isPaint).mul(0.85));
  c = mix(c, vec3(0.03, 0.027, 0.022), black.mul(isPaint).mul(0.75));
  c = c.mul(wear.z.mul(0.45).add(0.78));
  // Mud thrown up over the running gear, dust settled on what faces the sky.
  const mud = float(1)
    .sub(smoothstep(0.08, 0.62, p.y))
    .mul(fine.z.mul(0.9).add(0.3))
    .clamp(0, 1);
  c = mix(c, vec3(0.09, 0.075, 0.057), mud.mul(0.65));
  const dust = normalWorld.y.max(0).mul(fine.y).mul(0.22);
  c = mix(c, vec3(0.16, 0.148, 0.12), dust.mul(isPaint));
  // Wear from the shape of the model (shape.ts): how far this pixel is from the nearest
  // edge of the box it belongs to, in wear widths, and how deep in a crease it sits.
  let chipped: F = float(0);
  let cloth: F = float(0);
  if (boxP && boxH) {
    const d = boxH.xyz.sub(boxP.abs());
    // The smallest of the three is the face we are on; the next is the way to its edge.
    const toEdge = d.x.min(d.y).max(d.x.max(d.y).min(d.z));
    cloth = step(1.5, boxH.w);
    const crease = boxH.w.fract().div(0.9);
    const grain = texture(look.tex.noise, uv.mul(2.3).add(shift));
    // Chips are ragged: the band is eaten into by noise, wide here and absent there.
    const band = float(1).sub(smoothstep(0.0, 1.0, toEdge));
    chipped = smoothstep(0.5, 0.62, band.mul(0.6).add(grain.x.mul(0.75))).mul(step(0.02, band));
    const hard = chipped.mul(float(1).sub(cloth));
    // Paint chips to primer and bare steel; dark steel and rubber polish paler at the rim.
    c = mix(c, mix(c.mul(1.9).add(0.012), vec3(0.2, 0.19, 0.175), isPaint), hard.mul(0.8));
    // Cloth and webbing fray and fade along seams and corners.
    c = mix(c, c.mul(1.35).add(0.02), band.mul(cloth).mul(0.55));
    // Creases hold dirt and no light.
    c = mix(c, c.mul(0.5).add(vec3(0.012, 0.01, 0.008)), crease.mul(0.6));
    chipped = hard;
  }
  // A wreck: soot where it burned hottest, rust and ash elsewhere.
  const ash = mix(
    vec3(0.016, 0.015, 0.014),
    vec3(0.085, 0.045, 0.028),
    smoothstep(0.42, 0.6, fine.y),
  );
  const wreck = mix(ash, vec3(0.1, 0.1, 0.098), smoothstep(0.6, 0.7, fine.z).mul(0.5));
  return {
    colour: mix(c, wreck, burn),
    roughness: mix(
      mix(wear.w.add(mud.mul(0.3)).min(1), float(0.42), chipped.mul(0.8)).max(cloth.mul(0.9)),
      float(0.95),
      burn,
    ),
    metalness: mix(float(0.12), float(0.55), float(1).sub(isPaint).mul(float(1).sub(marking)))
      .max(chipped.mul(0.7))
      .mul(float(1).sub(mud))
      .mul(float(1).sub(cloth))
      .mul(float(1).sub(burn)),
  };
}
