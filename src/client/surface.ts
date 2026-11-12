// Surface detail for things built from plain coloured boxes, which have no texture
// coordinates: the textures are laid on from position instead. Buildings and field works
// use where they stand in the world; vehicles and men use the model's own space, so the
// pattern travels with them.
import * as THREE from 'three/webgpu';
import {
  cameraViewMatrix,
  float,
  mix,
  normalWorld,
  positionGeometry,
  positionWorld,
  smoothstep,
  texture,
  vec2,
  vec3,
} from 'three/tsl';
import type { Look } from './look';

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
export function fieldPaint(look: Look, base: V3, marking: F, seed: F, burn: F): Paint {
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
  // A wreck: soot where it burned hottest, rust and ash elsewhere.
  const ash = mix(
    vec3(0.016, 0.015, 0.014),
    vec3(0.085, 0.045, 0.028),
    smoothstep(0.42, 0.6, fine.y),
  );
  const wreck = mix(ash, vec3(0.1, 0.1, 0.098), smoothstep(0.6, 0.7, fine.z).mul(0.5));
  return {
    colour: mix(c, wreck, burn),
    roughness: mix(wear.w.add(mud.mul(0.3)).min(1), float(0.95), burn),
    metalness: mix(float(0.12), float(0.55), float(1).sub(isPaint).mul(float(1).sub(marking)))
      .mul(float(1).sub(mud))
      .mul(float(1).sub(burn)),
  };
}
