// What happens to a frame after the scene is drawn (R1, decision 090): ambient occlusion
// from the depth buffer, glow on `high`, then the grade. The cost is per pixel and does
// not care how many units are on screen, which is why it suits a game of thousands.
import * as THREE from 'three/webgpu';
import {
  dot,
  float,
  fract,
  mix,
  pass,
  renderOutput,
  screenCoordinate,
  screenUV,
  sin,
  smoothstep,
  time,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { sharpen } from 'three/addons/tsl/display/SharpenNode.js';
import type { Look } from './look';

type V3 = THREE.Node<'vec3'>;

/**
 * The grade, on a picture that is already tone-mapped: a little more contrast in the
 * middle, shadows pulled cool and highlights warm (the look of the references: overcast
 * steel and warm earth), a vignette, and fine grain that hides banding in smoke and sky.
 */
function grade(c: V3): V3 {
  const luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // An S-curve round middle grey, mixed in at half strength.
  const curved = c.mul(c).mul(float(3).sub(c.mul(2)));
  let g: V3 = mix(c, curved, 0.2);
  g = mix(vec3(luma), g, 1.06);
  const cool = vec3(0.985, 1.0, 1.03);
  const warm = vec3(1.03, 1.005, 0.965);
  g = g.mul(mix(cool, warm, smoothstep(0.15, 0.75, luma)));
  const d = screenUV.sub(0.5).length();
  g = g.mul(float(1).sub(smoothstep(0.42, 0.86, d).mul(0.17)));
  const n = fract(
    sin(dot(screenCoordinate.xy.add(fract(time).mul(61.7)), vec2(12.9898, 78.233))).mul(43758.5453),
  );
  return g.add(n.sub(0.5).mul(0.014));
}

export interface Post {
  render(): void;
}

/** The post pipeline for a graphics level, or null on `low`, which draws straight to screen. */
export function makePost(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  look: Look,
  enabled: { ao: boolean },
): Post | null {
  if (!look.rich) return null;
  const high = look.quality === 'high';
  const scenePass = pass(scene, camera);
  const colour = scenePass.getTextureNode('output');
  let lit: V3 = colour.rgb;
  if (enabled.ao) {
    // Occlusion at half resolution: soldiers, vehicles and houses sit on the ground
    // instead of floating over it, and corners between walls go dark.
    const occlusion = ao(scenePass.getTextureNode('depth'), null as unknown as THREE.Node, camera);
    occlusion.resolutionScale = 0.5;
    occlusion.samples.value = high ? 16 : 8;
    occlusion.radius.value = 0.9;
    occlusion.thickness.value = 1.4;
    occlusion.distanceFallOff.value = 1;
    occlusion.scale.value = 1.25;
    lit = lit.mul(mix(float(1), occlusion.getTextureNode().r, 0.9));
  }
  // High detail: fire, flashes and sun glints bleed light into what is around them.
  if (high) lit = lit.add(bloom(vec4(lit, 1), 0.14, 0.3, 1.5).rgb);
  let out: V3 = renderOutput(vec4(lit, 1)).rgb;
  // Sharpen before the grain goes on, or it sharpens the grain.
  if (high) out = sharpen(vec4(out, 1), 0.16).rgb;
  out = grade(out);
  const pipeline = new THREE.RenderPipeline(renderer);
  pipeline.outputColorTransform = false;
  pipeline.outputNode = out;
  return { render: () => pipeline.render() };
}
