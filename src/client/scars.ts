import * as THREE from 'three/webgpu';
import { attribute, float, positionWorld, smoothstep, texture, uv } from 'three/tsl';
import { Batch } from './batch';
import type { Fog } from './fog';
import type { Look } from './look';
import type { Terrain } from './terrain';

const MAX_SCARS = 4000;

/**
 * What the fighting leaves on the ground for the rest of the game: shell craters and the
 * scorched patches under burnt-out vehicles. Flat discs with soft edges, one draw call.
 * When the pool is full the oldest scar is reused.
 */
export class Scars {
  readonly mesh: THREE.InstancedMesh;
  private readonly batch: Batch;
  private next = 0;
  private filled = 0;

  constructor(
    fog: Fog,
    private readonly terrain: Terrain,
    look: Look,
  ) {
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true });
    const tint = attribute('aTint', 'vec4');
    material.colorNode = tint.xyz.mul(fog.shade());
    // Dark in the middle, fading out to nothing at the rim.
    const d = uv().sub(0.5).length().mul(2);
    if (look.rich) {
      // A torn edge and streaks of thrown earth, different for every scar.
      const grain = texture(look.tex.noise, positionWorld.xz.div(9));
      const ragged = d.add(grain.z.sub(0.5).mul(0.7));
      material.opacityNode = tint.w.mul(float(1).sub(smoothstep(0.3, 0.95, ragged)));
      material.colorNode = tint.xyz.mul(grain.w.mul(0.9).add(0.55)).mul(fog.shade());
    } else material.opacityNode = tint.w.mul(float(1).sub(smoothstep(0.35, 1, d)));
    material.depthWrite = false;
    material.polygonOffset = true;
    material.polygonOffsetFactor = -2;
    material.polygonOffsetUnits = -2;
    this.batch = new Batch(
      new THREE.CircleGeometry(1, 18).rotateX(-Math.PI / 2),
      material,
      MAX_SCARS,
    );
    this.mesh = this.batch.mesh;
    this.mesh.renderOrder = 0;
  }

  /** A crater (churned earth) or, with `scorch`, a burn mark. */
  add(x: number, z: number, radius: number, scorch: boolean): void {
    const b = this.batch;
    b.n = this.next % MAX_SCARS;
    const y = this.terrain.heightAt(x, z) + 0.05;
    if (scorch) b.put(x, y, z, 0, radius, 1, 0.02, 0.02, 0.02, 0.75);
    else b.put(x, y, z, 0, radius, 1, 0.13, 0.1, 0.07, 0.85);
    this.next++;
    if (this.filled < MAX_SCARS) this.filled++;
    b.n = this.filled;
    b.flush();
  }

  clear(): void {
    this.next = this.filled = 0;
    this.batch.n = 0;
    this.batch.flush();
  }
}
