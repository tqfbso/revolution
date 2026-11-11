import * as THREE from 'three/webgpu';
import { MAP_CELLS, MAP_SIZE, T_CLIFF, T_FORD, T_FOREST, T_WATER, type GameMap } from '../sim/map';
import type { Fog } from './fog';
import type { UnitView } from './units';

const N = MAP_CELLS;
const TERRAIN_RGB: Record<number, [number, number, number]> = {
  [T_FOREST]: [44, 62, 38],
  [T_WATER]: [44, 70, 80],
  [T_CLIFF]: [112, 106, 96],
  [T_FORD]: [96, 112, 104],
};
const OPEN_RGB: [number, number, number] = [104, 116, 74];
// Readability layer: brighter than the paint on the models, on purpose.
const TEAM_RGB = [
  [235, 70, 55],
  [70, 140, 255],
  [240, 190, 60],
];

/**
 * The whole battlefield at a glance: terrain, fog of war, units as dots, and the outline of
 * what the camera sees. Left click or drag moves the camera; right click orders the
 * selection there. Drawn one pixel per terrain cell and scaled up by CSS.
 */
export class Minimap {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly base = new Uint8ClampedArray(N * N * 3);
  private readonly image: ImageData;
  private readonly ray = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private lastDraw = 0;

  constructor(
    canvas: HTMLCanvasElement,
    map: GameMap,
    private readonly fog: Fog,
    private readonly units: UnitView,
    private readonly camera: THREE.PerspectiveCamera,
    lookAt: (x: number, z: number) => void,
    order: (x: number, z: number, attack: boolean) => void,
  ) {
    canvas.width = canvas.height = N;
    this.ctx = canvas.getContext('2d')!;
    this.image = this.ctx.createImageData(N, N);
    for (let c = 0; c < N * N; c++) {
      const rgb = TERRAIN_RGB[map.type[c]] ?? OPEN_RGB;
      // Lighter on high ground, so mesas read on the minimap too.
      const lift = Math.min(1.25, Math.max(0.85, 0.95 + map.heights[c + ((c / N) | 0)] / 40000));
      for (let k = 0; k < 3; k++) this.base[3 * c + k] = rgb[k] * lift;
    }

    const toWorld = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return {
        x: THREE.MathUtils.clamp((e.clientX - r.left) / r.width, 0, 1) * MAP_SIZE,
        z: THREE.MathUtils.clamp((e.clientY - r.top) / r.height, 0, 1) * MAP_SIZE,
      };
    };
    let dragging = false;
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => {
      const p = toWorld(e);
      if (e.button === 0) {
        dragging = true;
        canvas.setPointerCapture(e.pointerId);
        lookAt(p.x, p.z);
      } else if (e.button === 2) {
        order(p.x, p.z, !e.altKey);
      }
      e.stopPropagation();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const p = toWorld(e);
      lookAt(p.x, p.z);
    });
    canvas.addEventListener('pointerup', () => (dragging = false));
  }

  /** Redraw at most ten times a second. */
  update(now: number): void {
    if (now - this.lastDraw < 100) return;
    this.lastDraw = now;
    const px = this.image.data;
    const base = this.base;
    const { visible, explored } = this.fog;
    for (let c = 0; c < N * N; c++) {
      const shade = visible[c] ? 256 : explored[c] ? 150 : 80;
      px[4 * c] = (base[3 * c] * shade) >> 8;
      px[4 * c + 1] = (base[3 * c + 1] * shade) >> 8;
      px[4 * c + 2] = (base[3 * c + 2] * shade) >> 8;
      px[4 * c + 3] = 255;
    }
    const u = this.units;
    const pos = u.renderPos;
    for (let i = 0; i < u.count; i++) {
      if (!u.isAlive(i)) continue;
      const cx = Math.min(N - 2, Math.max(0, pos[3 * i] >> 2));
      const cy = Math.min(N - 2, Math.max(0, pos[3 * i + 2] >> 2));
      const c = cy * N + cx;
      const team = u.teamOf(i);
      if (team !== u.playerTeam && !visible[c]) continue;
      const rgb = u.selected[i] ? [255, 255, 255] : (TEAM_RGB[team] ?? TEAM_RGB[0]);
      // Two by two pixels, so a single unit is still findable.
      for (const o of [c, c + 1, c + N, c + N + 1]) {
        px[4 * o] = rgb[0];
        px[4 * o + 1] = rgb[1];
        px[4 * o + 2] = rgb[2];
      }
    }
    this.ctx.putImageData(this.image, 0, 0);

    // Outline of the ground the camera sees: the four screen corners cast onto y = 0.
    const ctx = this.ctx;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const corners = [
      [-1, 1],
      [1, 1],
      [1, -1],
      [-1, -1],
    ];
    for (let k = 0; k < 4; k++) {
      this.ray.setFromCamera(this.ndc.set(corners[k][0], corners[k][1]), this.camera);
      const { origin, direction } = this.ray.ray;
      // A corner looking above the horizon is treated as hitting the ground far away.
      const t = direction.y < -0.02 ? -origin.y / direction.y : 3000;
      const x = ((origin.x + direction.x * t) / MAP_SIZE) * N;
      const y = ((origin.z + direction.z * t) / MAP_SIZE) * N;
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
  }
}
