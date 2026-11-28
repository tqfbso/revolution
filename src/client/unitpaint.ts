// The one material every unit, body and wreck is drawn with: service paint in the army's
// coat, the team colour on its markings, field wear, and the burn that makes a wreck of it.
import * as THREE from 'three/webgpu';
import { attribute, mix, step, vec3 } from 'three/tsl';
import { COATS } from './kit';
import type { Look } from './look';
import { fieldPaint } from './surface';

/** Paint patterns to go round, and the room left under 1 for the burn (see the material). */
export const SEEDS = 16;
export const BURN_SCALE = 0.97;
/** Keeps the packed value clear of a whole number, where rounding would flip the seed. */
export const BURN_BASE = 0.01;

/**
 * Per instance `aTint`: xyz is the team colour; the whole part of w is a number per unit
 * (0 to SEEDS - 1) plus SEEDS times its faction, and its fraction is "burn", where 1 turns
 * the model into a scorched wreck. `cloud` is the cloud shadow over the field, if any.
 */
export function unitMaterial(
  look: Look,
  cloud?: THREE.Node<'float'>,
): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.82, metalness: 0.08 });
  const tint = attribute('aTint', 'vec4');
  const marking = attribute('teamMask', 'float');
  const army = tint.w.floor().div(SEEDS).floor();
  const coat = mix(
    mix(mix(vec3(1, 1, 1), vec3(...COATS[2]), step(1.5, army)), vec3(...COATS[3]), step(2.5, army)),
    vec3(...COATS[4]),
    step(3.5, army),
  );
  const painted = mix(attribute('color', 'vec3').mul(coat), tint.xyz, marking);
  const burn = tint.w.fract().sub(BURN_BASE).div(BURN_SCALE).clamp(0, 1);
  if (look.rich) {
    const paint = fieldPaint(
      look,
      painted,
      marking,
      tint.w.floor().mod(SEEDS),
      burn,
      attribute('aBoxP', 'vec3'),
      attribute('aBoxH', 'vec4'),
    );
    material.colorNode = cloud ? paint.colour.mul(cloud) : paint.colour;
    material.roughnessNode = paint.roughness;
    material.metalnessNode = paint.metalness;
  } else material.colorNode = mix(painted, vec3(0.022, 0.02, 0.019), burn);
  return material;
}
