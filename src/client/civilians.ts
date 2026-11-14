// The civilians of the map (decision 102), as the player sees them: people in everyday
// clothes, the size of the soldiers (decision 111), running out of the houses when the
// shooting starts. They are drawn
// only where the player has eyes. One that is hit falls and sinks into the ground over a
// few seconds: no blood, nothing to look at, only the count going up and the bill.
import * as THREE from 'three/webgpu';
import { attribute, mix } from 'three/tsl';
import { MAX_CIVILIANS } from '../sim/civilians';
import { EV_CIVILIAN, unpackX, unpackY } from '../sim/world';
import type { Snapshot } from '../worker/protocol';
import { ALERT_NOTE, type Alerts } from './alerts';
import { Batch } from './batch';
import type { Fog } from './fog';
import { CIVILIAN_KINDS, CIVILIAN_STRIDES, buildCivilian } from './civilianmodel';
import type { Terrain } from './terrain';

/** Coats, shirts and jackets: muted, and none of them an army's colour. */
const CLOTHES: [number, number, number][] = [
  [0.62, 0.58, 0.5],
  [0.3, 0.36, 0.46],
  [0.52, 0.3, 0.26],
  [0.36, 0.42, 0.34],
  [0.68, 0.66, 0.62],
  [0.24, 0.24, 0.27],
  [0.55, 0.47, 0.3],
  [0.42, 0.34, 0.44],
];
/** Seconds a fallen figure lies before it is gone. */
const FADE = 9;

/** Strides a second of a running figure. */
const PACE = 5.5;

interface Runner {
  x: number;
  z: number;
  tx: number;
  tz: number;
  sin: number;
  cos: number;
  seen: number;
}

interface Fallen {
  x: number;
  z: number;
  at: number;
  turn: number;
  tint: number;
}

export class Civilians {
  readonly group = new THREE.Group();
  /** People in the map's houses at the start, still at home, got away, and killed by each army. */
  total = 0;
  home = 0;
  escaped = 0;
  /** Out of their houses and running for the edge of the map. */
  fleeing = 0;
  killed: number[] = [];
  /** One batch per kind of figure and stride (see civilianmodel.ts). */
  private readonly figures: Batch[] = [];
  private readonly runners = new Map<number, Runner>();
  private readonly fallen: Fallen[] = [];
  private readonly frame = new Float32Array(12);
  private stamp = 0;

  constructor(
    private readonly terrain: Terrain,
    private readonly fog: Fog,
    private readonly alerts: () => Alerts | null,
    private readonly playerTeam: () => number,
  ) {
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
    const tint = attribute('aTint', 'vec4');
    material.colorNode = mix(
      attribute('color', 'vec3'),
      tint.xyz,
      attribute('teamMask', 'float'),
    ).mul(fog.cloud());
    for (let k = 0; k < CIVILIAN_KINDS * CIVILIAN_STRIDES; k++) {
      const b = new Batch(
        buildCivilian(Math.trunc(k / CIVILIAN_STRIDES), k % CIVILIAN_STRIDES),
        material,
        MAX_CIVILIANS + 64,
      );
      b.mesh.castShadow = true;
      this.figures.push(b);
      this.group.add(b.mesh);
    }
  }

  applySnapshot(s: Snapshot, now: number): void {
    const st = s.civStats;
    this.total = st[0];
    this.home = st[1];
    this.escaped = st[2];
    this.killed = Array.from(st.subarray(3));
    const d = s.civilians;
    this.fleeing = d.length / 3;
    const stamp = ++this.stamp;
    for (let k = 0; k < d.length; k += 3) {
      const id = d[k];
      let r = this.runners.get(id);
      if (!r) {
        r = { x: d[k + 1], z: d[k + 2], tx: 0, tz: 0, sin: 0, cos: 1, seen: 0 };
        this.runners.set(id, r);
      }
      r.tx = d[k + 1];
      r.tz = d[k + 2];
      r.seen = stamp;
    }
    for (const [id, r] of this.runners) if (r.seen !== stamp) this.runners.delete(id);
    const ev = s.events;
    const me = this.playerTeam();
    for (let e = 0; e < ev.length; e += 3) {
      if (ev[e] !== EV_CIVILIAN) continue;
      const x = unpackX(ev[e + 1]);
      const z = unpackY(ev[e + 1]);
      if (this.fog.sees(x, z) && this.fallen.length < 64) {
        this.fallen.push({ x, z, at: now, turn: (x * 7.3 + z * 3.1) % 6.28, tint: (x + z) | 0 });
      }
      if (ev[e + 2] === me)
        this.alerts()?.report(ALERT_NOTE, x, z, 'Civilians killed by our fire', now);
    }
  }

  update(now: number, dt: number): void {
    for (const b of this.figures) b.n = 0;
    const ease = Math.min(1, dt * 12);
    for (const [id, r] of this.runners) {
      const dx = r.tx - r.x;
      const dz = r.tz - r.z;
      const step = Math.hypot(dx, dz);
      if (step > 12) {
        r.x = r.tx;
        r.z = r.tz;
      } else {
        r.x += dx * ease;
        r.z += dz * ease;
        if (step > 0.02) {
          r.sin += (dx / step - r.sin) * ease;
          r.cos += (dz / step - r.cos) * ease;
        }
      }
      if (!this.fog.sees(r.x, r.z)) continue;
      const c = CLOTHES[id % CLOTHES.length];
      // Two strides, swapped as it runs, with a little bounce at each footfall. One in
      // seven is a head shorter: not everybody in a town is grown.
      const phase = now * PACE + id * 0.37;
      const stride = Math.floor(phase) & 1;
      const y = this.terrain.heightAt(r.x, r.z) + Math.abs(Math.sin(phase * Math.PI)) * 0.022;
      const size = id % 7 === 3 ? 0.76 : 0.94 + (id % 5) * 0.03;
      const b = this.figures[(id % CIVILIAN_KINDS) * CIVILIAN_STRIDES + stride];
      b.put(r.x, y, r.z, r.sin, r.cos, size, c[0], c[1], c[2], 0);
    }
    const f = this.frame;
    for (let k = this.fallen.length - 1; k >= 0; k--) {
      const d = this.fallen[k];
      const age = now - d.at;
      if (age > FADE) {
        this.fallen.splice(k, 1);
        continue;
      }
      // Down in the first third of a second, then slowly into the ground.
      const down = Math.min(1, age / 0.35);
      const tilt = (down * Math.PI) / 2;
      const sin = Math.sin(d.turn);
      const cos = Math.cos(d.turn);
      // The figure's up axis swings from the vertical down to the way it was facing.
      f[0] = cos;
      f[1] = 0;
      f[2] = -sin;
      f[3] = Math.sin(tilt) * sin;
      f[4] = Math.cos(tilt);
      f[5] = Math.sin(tilt) * cos;
      f[6] = Math.cos(tilt) * sin;
      f[7] = -Math.sin(tilt);
      f[8] = Math.cos(tilt) * cos;
      f[9] = d.x;
      f[10] = this.terrain.heightAt(d.x, d.z) + 0.04 * down - Math.max(0, age - 5) * 0.03;
      f[11] = d.z;
      const c = CLOTHES[d.tint % CLOTHES.length];
      const dim = 1 - 0.4 * Math.min(1, age / FADE);
      const b = this.figures[(d.tint % CIVILIAN_KINDS) * CIVILIAN_STRIDES];
      b.frame(f, c[0] * dim, c[1] * dim, c[2] * dim, 0);
    }
    for (const b of this.figures) b.flush();
  }
}
