// Rings on the ground (the audit's readability layer): how far the selected guns, missile
// teams, air defence and scouts reach, and every ambush circle your army is waiting on.
// Thin flat lines over the ground, no glow: amber for what a weapon reaches, a broken red
// line inside it for what a gun cannot hit (too close), pale blue for how far a scout
// sees or a jammer jams, and the ambush orange of the card's own circle for a kill zone.
import * as THREE from 'three/webgpu';
import type { Snapshot } from '../worker/protocol';
import { kindIn } from './army';
import type { UnitView } from './units';
import {
  KIND_AD,
  KIND_ARTILLERY,
  KIND_ATGM,
  KIND_DRONE,
  KIND_EW,
  KIND_MORTAR,
  KIND_RECON,
} from '../sim/units';

/** Redrawn this often while something shows: the units carrying the rings move. */
const REDRAW = 0.25;
const LIFT = 0.45;
/** Units of one kind closer than this to one already ringed share its ring. */
const SHARE = 10;
/** No more rings than this at once: past it a big selection would be a tangle of lines. */
const MAX_RINGS = 36;
const FX = 1024;

/** The kinds whose reach is worth drawing, and what is drawn for them. */
const WEAPON = new Set([KIND_MORTAR, KIND_ARTILLERY, KIND_AD, KIND_ATGM]);
const SIGHT = new Set([KIND_RECON, KIND_DRONE]);
const JAM = new Set([KIND_EW]);

function lineMaterial(color: number, opacity: number): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ color, transparent: true, opacity });
  m.depthWrite = false;
  m.depthTest = false;
  m.side = THREE.DoubleSide;
  return m;
}

/** Width of a ring's band on the ground, in metres: a couple of pixels at battle zoom. */
const BAND = 0.7;

export class RingView {
  readonly group = new THREE.Group();
  private readonly layers = {
    reach: lineMaterial(0xffd27a, 0.8),
    near: lineMaterial(0xff6a55, 0.8),
    sight: lineMaterial(0xbfe0ff, 0.6),
    ambush: lineMaterial(0xffb347, 0.75),
  };
  private readonly lines = new Map<keyof RingView['layers'], THREE.Mesh>();
  private ambushes: Float32Array = new Float32Array(0);
  private since = REDRAW;
  /** How many rings are drawn, for the tests and the debug hook. */
  shown = 0;
  /** Every army's ambushes, not only yours (?control=all). */
  everyone = false;

  constructor(
    private readonly units: UnitView,
    private readonly heightAt: (x: number, z: number) => number,
  ) {}

  applySnapshot(s: Snapshot): void {
    this.ambushes = s.ambushes ?? this.ambushes;
  }

  update(dt: number): void {
    this.since += dt;
    if (this.since < REDRAW) return;
    this.since = 0;
    const pts: Record<keyof RingView['layers'], number[]> = {
      reach: [],
      near: [],
      sight: [],
      ambush: [],
    };
    this.shown = 0;
    this.selectionRings(pts);
    const a = this.ambushes;
    const me = this.units.playerTeam;
    for (let k = 0; k + 4 <= a.length; k += 4) {
      if (!this.everyone && a[k] !== me) continue;
      this.circle(pts.ambush, a[k + 1], a[k + 2], a[k + 3], false);
    }
    for (const key of Object.keys(this.layers) as (keyof RingView['layers'])[]) {
      this.put(key, pts[key]);
    }
  }

  private selectionRings(pts: Record<keyof RingView['layers'], number[]>): void {
    const u = this.units;
    if (u.selectedCount === 0) return;
    const pos = u.renderPos;
    const done: number[] = []; // kind, x, z of each ring drawn
    for (const id of u.selectedIds()) {
      if (this.shown >= MAX_RINGS) return;
      const kind = u.kindOf(id);
      if (!WEAPON.has(kind) && !SIGHT.has(kind) && !JAM.has(kind)) continue;
      const x = pos[3 * id];
      const z = pos[3 * id + 2];
      let near = false;
      for (let d = 0; d < done.length && !near; d += 3) {
        near = done[d] === kind && Math.hypot(done[d + 1] - x, done[d + 2] - z) < SHARE;
      }
      if (near) continue;
      done.push(kind, x, z);
      const k = kindIn(u.teamOf(id), kind);
      if (WEAPON.has(kind) && k.range > 0) {
        this.circle(pts.reach, x, z, k.range / FX, false);
        if (k.minRange > 0) this.circle(pts.near, x, z, k.minRange / FX, true);
      }
      if (SIGHT.has(kind)) this.circle(pts.sight, x, z, k.sight / FX, false);
      if (JAM.has(kind) && k.jam > 0) this.circle(pts.sight, x, z, k.jam / FX, true);
    }
  }

  /**
   * A circle over the ground as a thin flat band (two triangles a step); `broken` leaves
   * every other step out.
   */
  private circle(out: number[], cx: number, cz: number, r: number, broken: boolean): void {
    if (!(r > 1)) return;
    this.shown++;
    const n = Math.min(180, Math.max(36, Math.round(r * 1.2)));
    const ri = r - BAND / 2;
    const ro = r + BAND / 2;
    let pc = 1;
    let ps = 0;
    let py = this.heightAt(cx + r, cz) + LIFT;
    for (let i = 1; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      const y = this.heightAt(cx + c * r, cz + sn * r) + LIFT;
      if (!broken || i % 2 === 0) {
        const ax = cx + pc * ri, az = cz + ps * ri; // prettier-ignore
        const bx = cx + pc * ro, bz = cz + ps * ro; // prettier-ignore
        const cxi = cx + c * ri, czi = cz + sn * ri; // prettier-ignore
        const cxo = cx + c * ro, czo = cz + sn * ro; // prettier-ignore
        out.push(ax, py, az, bx, py, bz, cxo, y, czo, ax, py, az, cxo, y, czo, cxi, y, czi);
      }
      pc = c;
      ps = sn;
      py = y;
    }
  }

  private put(key: keyof RingView['layers'], pts: number[]): void {
    const old = this.lines.get(key);
    if (old) {
      this.group.remove(old);
      old.geometry.dispose();
      this.lines.delete(key);
    }
    if (pts.length === 0) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const lines = new THREE.Mesh(geometry, this.layers[key]);
    lines.frustumCulled = false;
    lines.renderOrder = 6;
    this.group.add(lines);
    this.lines.set(key, lines);
  }
}
