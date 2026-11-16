// The way the selected troops have been told to go: a line over the ground from where
// they are, through the place they are making for, to every way point queued behind it
// (Shift + right click), with a small mark on each. Trucks with a list of buildings to put
// up show it the same way. Nothing is drawn for troops that are not selected.
import * as THREE from 'three/webgpu';
import type { Snapshot } from '../worker/protocol';
import type { UnitView } from './units';

/** The line is redrawn this often while it shows: the troops at its start are moving. */
const REDRAW = 0.2;
/** Metres between two points of the line, so that it follows the ground. */
const STEP = 5;
const LIFT = 0.5;
const MARK = 1.4;

export class RouteView {
  readonly group = new THREE.Group();
  private readonly material = new THREE.LineBasicNodeMaterial({
    color: 0x7dff8a,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    depthTest: false,
  });
  private lines: THREE.LineSegments | null = null;
  private routes: Float32Array = new Float32Array(0);
  private since = REDRAW;
  /** How many way points are shown, for the tests and the debug hook. */
  shown = 0;

  constructor(
    private readonly units: UnitView,
    private readonly heightAt: (x: number, z: number) => number,
  ) {}

  applySnapshot(s: Snapshot): void {
    this.routes = s.routes;
  }

  update(dt: number): void {
    this.since += dt;
    if (this.since < REDRAW) return;
    this.since = 0;
    const pts = this.build();
    if (this.lines) {
      this.group.remove(this.lines);
      this.lines.geometry.dispose();
      this.lines = null;
    }
    if (pts.length === 0) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.lines = new THREE.LineSegments(geometry, this.material);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 6;
    this.group.add(this.lines);
  }

  /**
   * Every route that has someone selected on it, flat (x, z, x, z, ...) from where the
   * selected troops are, for the minimap.
   */
  polylines(): number[][] {
    const r = this.routes;
    const u = this.units;
    const out: number[][] = [];
    if (u.selectedCount === 0) return out;
    for (let at = 0; at + 2 <= r.length;) {
      const members = r[at];
      const count = r[at + 1];
      const ids = at + 2;
      const first = ids + members;
      at = first + 2 * count;
      let sx = 0;
      let sz = 0;
      let n = 0;
      for (let k = 0; k < members; k++) {
        const id = r[ids + k];
        if (!u.selected[id] || !u.isAlive(id)) continue;
        sx += u.renderPos[3 * id];
        sz += u.renderPos[3 * id + 2];
        n++;
      }
      if (n === 0 || count === 0) continue;
      const line = [sx / n, sz / n];
      for (let k = 0; k < 2 * count; k++) line.push(r[first + k]);
      out.push(line);
    }
    return out;
  }

  /** Line segments (pairs of points) for every route that has someone selected on it. */
  private build(): number[] {
    const r = this.routes;
    const u = this.units;
    const out: number[] = [];
    this.shown = 0;
    if (u.selectedCount === 0) return out;
    const y = (x: number, z: number) => this.heightAt(x, z) + LIFT;
    for (let at = 0; at + 2 <= r.length;) {
      const members = r[at];
      const count = r[at + 1];
      const ids = at + 2;
      const first = ids + members;
      at = first + 2 * count;
      // From the middle of those of its troops that are selected.
      let sx = 0;
      let sz = 0;
      let n = 0;
      for (let k = 0; k < members; k++) {
        const id = r[ids + k];
        if (!u.selected[id] || !u.isAlive(id)) continue;
        sx += u.renderPos[3 * id];
        sz += u.renderPos[3 * id + 2];
        n++;
      }
      if (n === 0 || count === 0) continue;
      let px = sx / n;
      let pz = sz / n;
      for (let k = 0; k < count; k++) {
        const x = r[first + 2 * k];
        const z = r[first + 2 * k + 1];
        const len = Math.hypot(x - px, z - pz);
        const steps = Math.max(1, Math.ceil(len / STEP));
        for (let s = 0; s < steps; s++) {
          const ax = px + ((x - px) * s) / steps;
          const az = pz + ((z - pz) * s) / steps;
          const bx = px + ((x - px) * (s + 1)) / steps;
          const bz = pz + ((z - pz) * (s + 1)) / steps;
          out.push(ax, y(ax, az), az, bx, y(bx, bz), bz);
        }
        // A diamond on the way point.
        const h = y(x, z);
        out.push(x - MARK, h, z, x, h, z - MARK, x, h, z - MARK, x + MARK, h, z);
        out.push(x + MARK, h, z, x, h, z + MARK, x, h, z + MARK, x - MARK, h, z);
        this.shown++;
        px = x;
        pz = z;
      }
    }
    return out;
  }
}
