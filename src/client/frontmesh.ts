// The front line on the battlefield, for the zoomed-out view: a ribbon laid over the
// ground in the player's colour on a dark casing, teeth toward the enemy. Fades in as the
// camera pulls back past the height where single units stop mattering, so it never sits on
// top of a close fight. Flat colour, no glow: a map symbol, not a light.
import * as THREE from 'three/webgpu';
import type { FrontLine, FrontPath } from './front';
import { TEAM_RGB } from './minimap';

/** Camera distances over which the line fades in. */
const SHOW_FROM = 280;
const SHOW_FULL = 420;
/** Readability colours are written in sRGB; vertex colours are linear. */
function linear(rgb: readonly number[]): number[] {
  const c = new THREE.Color().setRGB(
    rgb[0] / 255,
    rgb[1] / 255,
    rgb[2] / 255,
    THREE.SRGBColorSpace,
  );
  return [c.r, c.g, c.b];
}
const CASING = linear([10, 14, 18]);

export class FrontOverlay {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.MeshBasicNodeMaterial;
  private version = -1;
  private builtScale = 0;

  constructor(
    private readonly front: FrontLine,
    private readonly heightAt: (x: number, z: number) => number,
    private readonly team: () => number,
  ) {
    this.material = new THREE.MeshBasicNodeMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 7;
    this.mesh.visible = false;
  }

  /** Each frame, with the camera's distance from the ground it looks at. */
  update(distance: number): void {
    const t = THREE.MathUtils.clamp((distance - SHOW_FROM) / (SHOW_FULL - SHOW_FROM), 0, 1);
    this.material.opacity = 0.85 * t * t * (3 - 2 * t);
    this.mesh.visible = t > 0 && this.front.paths.length > 0;
    if (!this.mesh.visible) return;
    // Thicker the further out, so it reads the same size on screen; rebuilt in steps.
    const scale = Math.round(THREE.MathUtils.clamp(distance / 260, 1, 3.5) * 4) / 4;
    if (this.version === this.front.version && scale === this.builtScale) return;
    this.version = this.front.version;
    this.builtScale = scale;
    this.build(scale);
  }

  private build(scale: number): void {
    const pos: number[] = [];
    const col: number[] = [];
    const lift = 1.5;
    const y = (x: number, z: number) => this.heightAt(x, z) + lift;
    const tri = (
      ax: number,
      az: number,
      bx: number,
      bz: number,
      cx: number,
      cz: number,
      rgb: readonly number[],
    ) => {
      pos.push(ax, y(ax, az), az, bx, y(bx, bz), bz, cx, y(cx, cz), cz);
      for (let k = 0; k < 3; k++) col.push(rgb[0], rgb[1], rgb[2]);
    };
    const ribbon = (p: FrontPath, half: number, rgb: readonly number[]) => {
      const n = p.pts.length >> 1;
      const side: number[] = [];
      for (let i = 0; i < n; i++) {
        const a = p.closed ? (i - 1 + n) % n : Math.max(0, i - 1);
        const b = p.closed ? (i + 1) % n : Math.min(n - 1, i + 1);
        let tx = p.pts[2 * b] - p.pts[2 * a];
        let tz = p.pts[2 * b + 1] - p.pts[2 * a + 1];
        const len = Math.hypot(tx, tz) || 1;
        tx /= len;
        tz /= len;
        side.push(-tz * half, tx * half);
      }
      const segs = p.closed ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        const j = (i + 1) % n;
        const ax = p.pts[2 * i];
        const az = p.pts[2 * i + 1];
        const bx = p.pts[2 * j];
        const bz = p.pts[2 * j + 1];
        const [sax, saz] = [side[2 * i], side[2 * i + 1]];
        const [sbx, sbz] = [side[2 * j], side[2 * j + 1]];
        tri(ax - sax, az - saz, ax + sax, az + saz, bx + sbx, bz + sbz, rgb);
        tri(ax - sax, az - saz, bx + sbx, bz + sbz, bx - sbx, bz - sbz, rgb);
      }
    };
    const mine = linear(TEAM_RGB[this.team()] ?? TEAM_RGB[0]);
    for (const p of this.front.paths) ribbon(p, 2.3 * scale, CASING);
    for (const p of this.front.paths) ribbon(p, 1.1 * scale, mine);
    // Teeth: a dark triangle and the enemy's colour inside it.
    for (const t of this.front.teeth) {
      const foe = linear(TEAM_RGB[t.foe] ?? TEAM_RGB[0]);
      for (const [half, tall, base, rgb] of [
        [5.4, 8.4, -1.4, CASING],
        [3.7, 6, 0, foe],
      ] as const) {
        const h = half * scale;
        const d = tall * scale;
        const b = base * scale;
        const ox = t.x + t.nx * b;
        const oz = t.z + t.nz * b;
        tri(
          ox - t.nz * h,
          oz + t.nx * h,
          ox + t.nz * h,
          oz - t.nx * h,
          t.x + t.nx * d,
          t.z + t.nz * d,
          rgb,
        );
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    this.mesh.geometry.dispose();
    this.mesh.geometry = geometry;
  }
}
