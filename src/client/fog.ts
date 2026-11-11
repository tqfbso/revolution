import * as THREE from 'three/webgpu';
import { positionWorld, texture } from 'three/tsl';
import { MAP_CELLS, MAP_SIZE, T_FOREST, type GameMap } from '../sim/map';

const BRIGHT_VISIBLE = 255;
const BRIGHT_EXPLORED = 150;
const BRIGHT_UNEXPLORED = 80;
const CELLS = MAP_CELLS * MAP_CELLS;
/** Rays cast from each viewpoint. At the edge of sight they are about one cell apart. */
const RAYS = 120;
const EYE = 0.7;
/** Cells of forest one can see into before the trees close the view. */
const FOREST_SIGHT = 3;
/** Extra sight per unit of height above the plain, and its cap, in cells. */
const HIGH_GROUND = 5;
const SEE_WALL = 1;
const SEE_FOREST = 2;

/**
 * Fog of war for the player's army. Presentation only: the simulation knows everything,
 * this decides what the player is shown. A cell is visible while one of the player's units
 * has a line of sight to it: within sight range, not behind a building, a hill or deep
 * forest. From high ground one sees further and over things. Explored cells stay dimly
 * lit. The result is a small texture that darkens the world, plus lookups for hiding
 * enemy units.
 */
export class Fog {
  readonly visible = new Uint8Array(CELLS);
  readonly explored = new Uint8Array(CELLS);
  readonly texture: THREE.DataTexture;
  private readonly pixels = new Uint8Array(CELLS * 4).fill(BRIGHT_VISIBLE);
  private readonly stamped = new Uint8Array(CELLS);
  /** How far the viewpoint of each 2x2 block sees, in cells. */
  private readonly reach = new Uint8Array(CELLS);
  /** What stands in each cell that stops the eye (SEE_*), and how high the ground is. */
  private readonly block = new Uint8Array(CELLS);
  private readonly ground = new Float32Array(CELLS);
  private readonly rayX = new Float32Array(RAYS);
  private readonly rayY = new Float32Array(RAYS);
  private plain = 0;

  constructor(readonly enabled: boolean) {
    this.texture = new THREE.DataTexture(this.pixels, MAP_CELLS, MAP_CELLS, THREE.RGBAFormat);
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.needsUpdate = true;
    for (let r = 0; r < RAYS; r++) {
      this.rayX[r] = Math.cos((r / RAYS) * Math.PI * 2);
      this.rayY[r] = Math.sin((r / RAYS) * Math.PI * 2);
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

  /** Take the lie of the land from the map: heights, forest. Buildings come via setWall. */
  setMap(map: GameMap): void {
    let sum = 0;
    for (let c = 0; c < CELLS; c++) {
      const v = c + ((c / MAP_CELLS) | 0);
      const h = map.heights;
      const avg = (h[v] + h[v + 1] + h[v + MAP_CELLS + 1] + h[v + MAP_CELLS + 2]) / 4096;
      this.ground[c] = avg;
      sum += avg;
      this.block[c] = map.type[c] === T_FOREST ? SEE_FOREST : 0;
    }
    this.plain = sum / CELLS;
  }

  /** A building went up or came down in this cell. */
  setWall(cell: number, standing: boolean): void {
    this.block[cell] = standing ? SEE_WALL : 0;
  }

  reset(): void {
    if (this.enabled) this.explored.fill(0);
  }

  /**
   * Recompute visibility from the positions (x, z per unit) of the player's living units.
   * `sightOf` is how far a unit sees in cells (0 = blind), negative for one in the air,
   * which nothing on the ground blocks.
   */
  update(
    positions: Float32Array,
    count: number,
    isMine: (id: number) => boolean,
    sightOf: (id: number) => number,
  ): void {
    if (!this.enabled) return;
    const visible = this.visible;
    visible.fill(0);
    this.stamped.fill(0);
    const stamped = this.stamped;
    const reach = this.reach;
    const N = MAP_CELLS;
    // Units standing close together see the same things: one viewpoint per 2x2 cells.
    for (let i = 0; i < count; i++) {
      if (!isMine(i)) continue;
      const sight = sightOf(i);
      if (sight === 0) continue;
      const cx = Math.min(N - 1, Math.max(0, positions[2 * i] >> 2));
      const cy = Math.min(N - 1, Math.max(0, positions[2 * i + 1] >> 2));
      if (sight < 0) {
        this.lookDown(cx, cy, -sight);
        continue;
      }
      // The viewpoint of a block is whoever in it sees furthest.
      const b = (cy >> 1) * N + (cx >> 1);
      if (stamped[b] === 0 || sight > reach[b]) {
        stamped[b] = 1 + (cy & 1) * 2 + (cx & 1);
        reach[b] = sight;
      }
    }
    const H = N >> 1;
    for (let by = 0; by < H; by++) {
      for (let bx = 0; bx < H; bx++) {
        const b = by * N + bx;
        if (stamped[b] === 0) continue;
        // In the middle of a formation the neighbours see everything this one would.
        if (
          bx > 0 &&
          by > 0 &&
          bx < H - 1 &&
          by < H - 1 &&
          stamped[b - 1] !== 0 &&
          stamped[b + 1] !== 0 &&
          stamped[b - N] !== 0 &&
          stamped[b + N] !== 0 &&
          reach[b - 1] >= reach[b] &&
          reach[b + 1] >= reach[b] &&
          reach[b - N] >= reach[b] &&
          reach[b + N] >= reach[b]
        ) {
          continue;
        }
        const k = stamped[b] - 1;
        this.look(bx * 2 + (k & 1), by * 2 + (k >> 1), reach[b]);
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

  /** Mark what can be seen from a cell: rays outward, each stopped by what blocks sight. */
  /** From the air: everything within the circle, whatever stands on the ground. */
  private lookDown(cx: number, cy: number, r: number): void {
    const N = MAP_CELLS;
    const y0 = Math.max(0, cy - r);
    const y1 = Math.min(N - 1, cy + r);
    for (let y = y0; y <= y1; y++) {
      const half = Math.floor(Math.sqrt(r * r - (y - cy) * (y - cy)));
      this.visible.fill(1, y * N + Math.max(0, cx - half), y * N + Math.min(N - 1, cx + half) + 1);
    }
  }

  private look(cx: number, cy: number, sight: number): void {
    const N = MAP_CELLS;
    const visible = this.visible;
    const block = this.block;
    const ground = this.ground;
    const from = cy * N + cx;
    visible[from] = 1;
    // On a roof when looking out of a building; a longer view from high ground.
    const eye = ground[from] + EYE + (block[from] === SEE_WALL ? 2 : 0);
    const lift = Math.min(HIGH_GROUND, Math.max(0, (ground[from] - this.plain - 2) * 0.7));
    const reach = sight + Math.round(lift);
    for (let r = 0; r < RAYS; r++) {
      const dx = this.rayX[r];
      const dy = this.rayY[r];
      let slope = -1e9;
      let forest = block[from] === SEE_FOREST ? 1 : 0;
      for (let d = 1; d <= reach; d++) {
        const x = Math.floor(cx + 0.5 + dx * d);
        const y = Math.floor(cy + 0.5 + dy * d);
        if (x < 0 || y < 0 || x >= N || y >= N) break;
        const c = y * N + x;
        const rise = (ground[c] - eye) / d;
        // Seen if something standing there would clear every crest in between.
        if (rise + EYE / d >= slope) visible[c] = 1;
        if (rise > slope) slope = rise;
        const what = block[c];
        if (what === SEE_WALL) break;
        if (what === SEE_FOREST && ++forest > FOREST_SIGHT) break;
      }
    }
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
