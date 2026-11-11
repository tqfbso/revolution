import * as THREE from 'three/webgpu';
import { positionWorld, texture } from 'three/tsl';
import { MAP_CELLS, MAP_SIZE } from '../sim/map';

/** How far a unit sees, in terrain cells (4 world units each). */
const SIGHT_CELLS = 15;
const BRIGHT_VISIBLE = 255;
const BRIGHT_EXPLORED = 150;
const BRIGHT_UNEXPLORED = 80;
const CELLS = MAP_CELLS * MAP_CELLS;

/**
 * Fog of war for the player's army. Presentation only: the simulation knows everything,
 * this decides what the player is shown. A cell is visible while one of the player's units
 * is within sight range, explored once it has been visible, otherwise unexplored. The
 * result is a small texture that darkens the world, plus lookups for hiding enemy units.
 */
export class Fog {
  readonly visible = new Uint8Array(CELLS);
  readonly explored = new Uint8Array(CELLS);
  readonly texture: THREE.DataTexture;
  private readonly pixels = new Uint8Array(CELLS * 4).fill(BRIGHT_VISIBLE);
  private readonly stamped = new Uint8Array(CELLS);
  /** Half-width of the sight circle for each row offset. */
  private readonly span: number[] = [];

  constructor(readonly enabled: boolean) {
    this.texture = new THREE.DataTexture(this.pixels, MAP_CELLS, MAP_CELLS, THREE.RGBAFormat);
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.needsUpdate = true;
    for (let dy = -SIGHT_CELLS; dy <= SIGHT_CELLS; dy++) {
      this.span.push(Math.floor(Math.sqrt(SIGHT_CELLS * SIGHT_CELLS - dy * dy)));
    }
    if (!enabled) {
      this.visible.fill(1);
      this.explored.fill(1);
    }
  }

  /** Brightness (0..1) of the world at the fragment being shaded. Multiply colours by it. */
  shade() {
    return texture(this.texture, positionWorld.xz.div(MAP_SIZE)).r;
  }

  reset(): void {
    if (this.enabled) this.explored.fill(0);
  }

  /** Recompute visibility from the positions (x, z per unit) of the player's living units. */
  update(positions: Float32Array, count: number, isMine: (id: number) => boolean): void {
    if (!this.enabled) return;
    const visible = this.visible;
    visible.fill(0);
    this.stamped.fill(0);
    for (let i = 0; i < count; i++) {
      if (!isMine(i)) continue;
      const cx = Math.min(MAP_CELLS - 1, Math.max(0, positions[2 * i] >> 2));
      const cy = Math.min(MAP_CELLS - 1, Math.max(0, positions[2 * i + 1] >> 2));
      // Units sharing a cell see the same thing: stamp each cell once.
      if (this.stamped[cy * MAP_CELLS + cx]) continue;
      this.stamped[cy * MAP_CELLS + cx] = 1;
      for (let dy = -SIGHT_CELLS; dy <= SIGHT_CELLS; dy++) {
        const y = cy + dy;
        if (y < 0 || y >= MAP_CELLS) continue;
        const half = this.span[dy + SIGHT_CELLS];
        const x0 = Math.max(0, cx - half);
        const x1 = Math.min(MAP_CELLS - 1, cx + half);
        visible.fill(1, y * MAP_CELLS + x0, y * MAP_CELLS + x1 + 1);
      }
    }
    const explored = this.explored;
    const px = this.pixels;
    for (let c = 0; c < CELLS; c++) {
      if (visible[c]) explored[c] = 1;
      const goal = visible[c] ? BRIGHT_VISIBLE : explored[c] ? BRIGHT_EXPLORED : BRIGHT_UNEXPLORED;
      // Ease toward the goal so the edge of sight glides instead of flickering.
      const v = px[4 * c];
      const step = Math.round((goal - v) * 0.4);
      px[4 * c] = step === 0 ? goal : v + step;
    }
    this.texture.needsUpdate = true;
  }

  /** Can the player currently see world position (x, z)? */
  sees(x: number, z: number): boolean {
    return this.visible[this.cell(x, z)] === 1;
  }

  hasExplored(x: number, z: number): boolean {
    return this.explored[this.cell(x, z)] === 1;
  }

  private cell(x: number, z: number): number {
    const cx = Math.min(MAP_CELLS - 1, Math.max(0, x >> 2));
    const cy = Math.min(MAP_CELLS - 1, Math.max(0, z >> 2));
    return cy * MAP_CELLS + cx;
  }
}
