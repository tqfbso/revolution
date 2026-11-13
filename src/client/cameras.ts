// Surveillance cameras on the field: the small things engineers leave behind.
//
// Yours always show, each with a thin ring for what it watches (red while an enemy jammer
// blinds it). The enemy's show only while one of your jammers has found them, marked so
// you can send someone to pull them down. Cameras also lift your fog and feed the
// "contact" alert, like a recon drone that never moves.
import * as THREE from 'three/webgpu';
import { attribute, mix } from 'three/tsl';
import { CAMERA_SIGHT } from '../sim/units';
import { EV_CAMERA_LOST } from '../sim/world';
import { CAMERA_BLIND, CAMERA_KNOWN, type Snapshot } from '../worker/protocol';
import { ALERT_ARMY, type Alerts } from './alerts';
import { Batch } from './batch';
import type { Fog } from './fog';
import { box, merge } from './models';
import type { Terrain } from './terrain';
import { TEAM_RGB } from './units';

const SIGHT = CAMERA_SIGHT / 1024;
const MAX_SHOWN = 64;

/** A mast on three legs with a sensor head and a small panel: knee high to a tank. */
function buildCamera(): THREE.BufferGeometry {
  const steel = 0x2b2e2c;
  const parts = [
    box(0.04, 0.6, 0.04, { at: [0, 0.3, 0], color: steel }),
    box(0.16, 0.11, 0.2, { at: [0, 0.64, 0.02], color: 0x3c4030 }),
    box(0.09, 0.07, 0.05, { at: [0, 0.64, 0.14], color: 0x101112 }),
    box(0.22, 0.02, 0.16, { at: [0, 0.46, -0.1], rot: [0.6, 0, 0], color: 0x1c2430 }),
    box(0.06, 0.05, 0.06, { at: [0, 0.72, 0], team: 1 }),
  ];
  for (const [x, z] of [
    [0, 0.2],
    [-0.18, -0.12],
    [0.18, -0.12],
  ]) {
    parts.push(
      box(0.03, 0.3, 0.03, { at: [x * 0.5, 0.13, z * 0.5], rot: [z * 2, 0, -x * 2], color: steel }),
    );
  }
  return merge(parts);
}

export class Cameras {
  readonly group = new THREE.Group();
  /** How far the view is from the ground: rings fade in as it pulls back. */
  zoom = 100;
  private readonly model: Batch;
  private readonly rings: Batch;
  private data: Float32Array = new Float32Array(0);
  /** Where each slot's camera last stood, for the alert when one is lost. */
  private readonly last = new Float32Array(MAX_SHOWN * 2);

  constructor(
    private readonly terrain: Terrain,
    private readonly fog: Fog,
    private readonly alerts: () => Alerts | null,
    private readonly playerTeam: () => number,
  ) {
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.8, metalness: 0.2 });
    const tint = attribute('aTint', 'vec4');
    material.colorNode = mix(
      attribute('color', 'vec3'),
      tint.xyz,
      attribute('teamMask', 'float'),
    ).mul(fog.cloud());
    this.model = new Batch(buildCamera(), material, MAX_SHOWN);
    const ringMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true });
    ringMaterial.colorNode = tint.xyz;
    ringMaterial.opacityNode = tint.w;
    ringMaterial.depthWrite = false;
    ringMaterial.depthTest = false;
    ringMaterial.fog = false;
    this.rings = new Batch(
      new THREE.RingGeometry(0.988, 1, 96).rotateX(-Math.PI / 2),
      ringMaterial,
      MAX_SHOWN,
    );
    this.rings.mesh.renderOrder = 3;
    this.group.add(this.model.mesh, this.rings.mesh);
  }

  /** Number of the player's cameras standing. */
  get count(): number {
    let n = 0;
    const me = this.playerTeam();
    for (let k = 0; k < this.data.length; k += 4) if ((this.data[k + 3] & 15) === me) n++;
    return n;
  }

  applySnapshot(s: Snapshot, now: number): void {
    const me = this.playerTeam();
    const d = (this.data = s.cameras);
    const eyes: number[] = [];
    const posts: number[] = [];
    for (let k = 0; k < d.length; k += 4) {
      const slot = d[k];
      this.last[2 * slot] = d[k + 1];
      this.last[2 * slot + 1] = d[k + 2];
      if ((d[k + 3] & 15) !== me || (d[k + 3] & CAMERA_BLIND) !== 0) continue;
      eyes.push(d[k + 1], d[k + 2], SIGHT);
      posts.push(Math.floor(d[k + 1] / 4), Math.floor(d[k + 2] / 4), Math.round(SIGHT / 4));
    }
    this.fog.cameras = posts;
    const alerts = this.alerts();
    if (!alerts) return;
    alerts.watchers = eyes;
    const ev = s.events;
    for (let e = 0; e < ev.length; e += 3) {
      if (ev[e] !== EV_CAMERA_LOST || ev[e + 2] !== me) continue;
      const slot = ev[e + 1];
      alerts.report(ALERT_ARMY, this.last[2 * slot], this.last[2 * slot + 1], 'Camera lost', now);
    }
  }

  update(): void {
    const me = this.playerTeam();
    const d = this.data;
    this.model.n = 0;
    this.rings.n = 0;
    // Rings are for planning: faint close in, clear from further out.
    const fade = Math.min(1, Math.max(0.35, this.zoom / 120));
    for (let k = 0; k < d.length; k += 4) {
      const team = d[k + 3] & 15;
      const mine = team === me;
      const known = (d[k + 3] & CAMERA_KNOWN) !== 0;
      const blind = (d[k + 3] & CAMERA_BLIND) !== 0;
      if (!mine && !known) continue;
      const x = d[k + 1];
      const z = d[k + 2];
      const y = this.terrain.heightAt(x, z);
      const c = TEAM_RGB[team] ?? TEAM_RGB[0];
      this.model.put(x, y, z, Math.sin(d[k] * 2.4), Math.cos(d[k] * 2.4), 1, c[0], c[1], c[2], 0);
      if (mine) {
        if (blind) this.rings.put(x, y + 0.4, z, 0, SIGHT, 1, 1, 0.2, 0.15, 0.7 * fade);
        else this.rings.put(x, y + 0.4, z, 0, SIGHT, 1, 0.55, 0.85, 0.95, 0.38 * fade);
      } else this.rings.put(x, y + 0.4, z, 0, 2.2, 1, 1, 0.25, 0.15, 0.9);
    }
    this.model.flush();
    this.rings.flush();
  }
}
