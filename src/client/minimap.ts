import { SUPPLY_DIM } from '../sim/logistics';
import type { SupplyView } from './supply';
import * as THREE from 'three/webgpu';
import {
  MAP_CELLS,
  MAP_SIZE,
  S_BRIDGE,
  T_CLIFF,
  T_FORD,
  T_FOREST,
  T_GATE,
  T_WALL,
  T_WATER,
  type GameMap,
} from '../sim/map';
import type { Fog } from './fog';
import type { StructureView } from './structures';
import type { UnitView } from './units';
import type { WorksView } from './works';

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
  /** Alert pings: rings that close in on a point for a few seconds. */
  private readonly pings: { x: number; y: number; at: number; rgb: number[] }[] = [];
  private clock = 0;
  private baseVersion = -1;

  constructor(
    canvas: HTMLCanvasElement,
    _map: GameMap,
    private readonly fog: Fog,
    private readonly units: UnitView,
    private readonly camera: THREE.PerspectiveCamera,
    lookAt: (x: number, z: number) => void,
    order: (x: number, z: number, attack: boolean) => void,
    private readonly structures: StructureView,
    private readonly map: GameMap,
    private readonly works: WorksView,
    private readonly supply: SupplyView,
  ) {
    canvas.width = canvas.height = N;
    this.ctx = canvas.getContext('2d')!;
    this.image = this.ctx.createImageData(N, N);
    this.paintBase();

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
      if (e.button === 0 && this.pick(p.x, p.z)) {
        // The click answered a question (where a commander is to go).
      } else if (e.button === 0) {
        dragging = true;
        canvas.setPointerCapture(e.pointerId);
        lookAt(p.x, p.z);
      } else if (e.button === 2) {
        order(p.x, p.z, e.altKey);
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

  /** Set by the client: a left click is offered here first; true if it was taken. */
  pick: (x: number, z: number) => boolean = () => false;
  /** Set by the client: the commanders to mark (letter, where its troops are, where it is sent). */
  commanders: () => { name: string; cx: number; cz: number; x: number; z: number; on: boolean }[] =
    () => [];

  /** Draw attention to a world point: an alert happened there. */
  ping(x: number, z: number, rgb: readonly number[]): void {
    this.pings.push({
      x: (x / MAP_SIZE) * N,
      y: (z / MAP_SIZE) * N,
      at: this.clock,
      rgb: [...rgb],
    });
    if (this.pings.length > 16) this.pings.shift();
    // Shown at once, not on the next slow redraw.
    this.lastDraw = 0;
  }

  /** Terrain colours. Redone when a building falls or a bridge is cut: the map changes. */
  private paintBase(): void {
    const map = this.map;
    this.baseVersion = this.structures.version + this.works.version;
    for (let c = 0; c < N * N; c++) {
      let rgb = TERRAIN_RGB[map.baseType[c]] ?? OPEN_RGB;
      const s = map.structAt[c];
      if (s >= 0 && !this.structures.hidden(s)) {
        const standing = this.structures.hp[s] > 0;
        if (map.sKind[s] === S_BRIDGE) rgb = standing ? [196, 192, 180] : rgb;
        else if (standing && this.structures.baseTeam[s] >= 0) {
          const paint = TEAM_RGB[this.structures.baseTeam[s]];
          if (paint) rgb = [paint[0], paint[1], paint[2]];
        } else rgb = standing ? [168, 162, 150] : [74, 70, 66];
      }
      // Field works you know of: walls and gates light, the rest a dark line.
      if (map.type[c] >= T_WALL && this.works.workAt((c % N) * 4 + 2, ((c / N) | 0) * 4 + 2)) {
        rgb = map.type[c] === T_WALL || map.type[c] === T_GATE ? [200, 198, 190] : [58, 52, 44];
      }
      // Lighter on high ground, so mesas read on the minimap too.
      const lift = Math.min(1.25, Math.max(0.85, 0.95 + map.heights[c + ((c / N) | 0)] / 40000));
      for (let k = 0; k < 3; k++) this.base[3 * c + k] = rgb[k] * lift;
    }
  }

  /** Redraw at most ten times a second. */
  update(now: number): void {
    this.clock = now;
    // While a ping runs the map is redrawn more often, so the ring moves smoothly.
    if (now - this.lastDraw < (this.pings.length > 0 ? 40 : 100)) return;
    this.lastDraw = now;
    if (this.baseVersion !== this.structures.version + this.works.version) this.paintBase();
    const px = this.image.data;
    const base = this.base;
    const { visible, explored } = this.fog;
    // Ground inside your supply is tinted, with a brighter edge: where an army can be
    // kept fed. A square of the supply map is four by four cells of this one.
    const area = this.supply.area;
    for (let c = 0; c < N * N; c++) {
      const shade = visible[c] ? 256 : explored[c] ? 150 : 80;
      const sx = (c % N) >> 2;
      const sy = ((c / N) | 0) >> 2;
      const s = sy * SUPPLY_DIM + sx;
      let lift = 0;
      if (area[s] !== 0) {
        const cx = (c % N) & 3;
        const cy = ((c / N) | 0) & 3;
        const edge =
          (cx === 0 && (sx === 0 || area[s - 1] === 0)) ||
          (cx === 3 && (sx === SUPPLY_DIM - 1 || area[s + 1] === 0)) ||
          (cy === 0 && (sy === 0 || area[s - SUPPLY_DIM] === 0)) ||
          (cy === 3 && (sy === SUPPLY_DIM - 1 || area[s + SUPPLY_DIM] === 0));
        lift = edge ? 90 : 16;
      }
      px[4 * c] = ((base[3 * c] * shade) >> 8) + (lift >> 1);
      px[4 * c + 1] = Math.min(255, ((base[3 * c + 1] * shade) >> 8) + lift);
      px[4 * c + 2] = ((base[3 * c + 2] * shade) >> 8) + (lift >> 2);
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

    const ctx = this.ctx;
    // Resource sites you have found: tan for supplies, amber for fuel.
    for (let k = 0; k < this.map.siteCount; k++) {
      const x = this.map.siteX[k] / 4096;
      const y = this.map.siteY[k] / 4096;
      const fuel = this.map.siteKind[k] === 1;
      if (!explored[(y | 0) * N + (x | 0)] || (!fuel && this.structures.siteStock[k] <= 0))
        continue;
      ctx.fillStyle = fuel ? 'rgb(245,170,30)' : 'rgb(225,195,135)';
      ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
    }
    // Towns: a ring in the colour of whoever holds them.
    ctx.lineWidth = 1.5;
    for (let t = 0; t < this.map.townCount; t++) {
      const owner = TEAM_RGB[this.structures.townOwner[t]];
      ctx.strokeStyle = owner ? `rgb(${owner[0]},${owner[1]},${owner[2]})` : 'rgb(215,215,205)';
      ctx.beginPath();
      ctx.arc(this.map.townX[t] / 4096, this.map.townY[t] / 4096, 5, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Commanders: a letter on their troops, a line to where they have been sent.
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const c of this.commanders()) {
      const x = (c.cx / MAP_SIZE) * N;
      const y = (c.cz / MAP_SIZE) * N;
      if (c.on) {
        ctx.strokeStyle = 'rgba(255,224,130,0.7)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo((c.x / MAP_SIZE) * N, (c.z / MAP_SIZE) * N);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.fillStyle = 'rgba(12,16,20,0.85)';
      ctx.fillRect(x - 6, y - 6, 12, 12);
      ctx.strokeStyle = 'rgb(255,224,130)';
      ctx.strokeRect(x - 6, y - 6, 12, 12);
      ctx.fillStyle = 'rgb(255,224,130)';
      ctx.fillText(c.name[0], x, y + 0.5);
    }

    // Alerts: a ring closing in on the place, three times, then a dot that lingers.
    for (let k = this.pings.length - 1; k >= 0; k--) {
      const p = this.pings[k];
      const age = (now - p.at) / 1000;
      if (age > 9) {
        this.pings.splice(k, 1);
        continue;
      }
      const [r, g, b] = p.rgb;
      if (age < 3.6) {
        const t = (age % 1.2) / 1.2;
        ctx.strokeStyle = `rgba(${r},${g},${b},${0.95 - 0.5 * t})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4 + 22 * (1 - t), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = `rgba(${r},${g},${b},${Math.min(1, (9 - age) / 2)})`;
      ctx.fillRect(p.x - 2.5, p.y - 2.5, 5, 5);
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1;
      ctx.strokeRect(p.x - 3, p.y - 3, 6, 6);
    }

    // Outline of the ground the camera sees: the four screen corners cast onto y = 0.
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
