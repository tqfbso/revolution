import * as THREE from 'three/webgpu';
import { attribute, float, mix } from 'three/tsl';
import { MAP_CELLS, NO_OWNER, T_FORD, T_OPEN, isWork, type GameMap } from '../sim/map';
import {
  WORKS,
  WORK_COUNT,
  WORK_GATE,
  WORK_SANDBAG,
  WORK_TRAP,
  WORK_TRENCH,
  WORK_WALL,
  WORK_WIRE,
} from '../sim/works';
import { EV_WORK_LOST } from '../sim/world';
import type { Snapshot } from '../worker/protocol';
import { Batch } from './batch';
import type { Effects } from './effects';
import type { Fog } from './fog';
import { build, type Part } from './structures';
import type { Terrain } from './terrain';

// Field works: walls, gates, wire, tank obstacles, trenches, sandbags. There can be
// thousands of cells of them, so each kind is one instanced draw call (walls: two, a post
// and the arms that join it to its neighbours), rebuilt only when something changed.

const CELL = 4;
const CELLS = MAP_CELLS * MAP_CELLS;
const CONCRETE = 0x8d8b84;
const STEEL = 0x4b4f52;
const RUST = 0x5f4232;
const WIRE = 0x3d3b38;
const EARTH = 0x5e4d38;
const DUG = 0x2b251e;
const SACK = 0x9c8c69;
const TEAM = [
  [0.8, 0.16, 0.1],
  [0.12, 0.36, 0.95],
  [0.9, 0.62, 0.1],
];
/** Record bits (see Snapshot.works). */
const KIND_MASK = 15;
const DONE = 128;

function withMask(parts: (Part & { team?: boolean })[]): THREE.BufferGeometry {
  // One geometry per group of parts, so the team-paint mask can differ between them.
  const plain = parts.filter((p) => !p.team);
  const marked = parts.filter((p) => p.team);
  const g = build([...plain, ...marked]);
  const n = g.getAttribute('position').count;
  const mask = new Float32Array(n);
  // Every part is a box of 24 vertices; the marked ones come last.
  mask.fill(1, plain.length * 24);
  g.setAttribute('teamMask', new THREE.BufferAttribute(mask, 1));
  return g;
}

function hedgehog(x: number, z: number, turn: number): Part[] {
  const beam: [number, number, number] = [0.2, 2.3, 0.2];
  return [
    { size: beam, at: [x, 0.8, z], rot: [0, turn, 0.95], color: RUST },
    { size: beam, at: [x, 0.8, z], rot: [0.95, turn, 0], color: RUST, shade: 0.85 },
    { size: beam, at: [x, 0.8, z], rot: [-0.67, turn, -0.67], color: RUST, shade: 1.15 },
  ];
}

const GEOMETRY: (() => THREE.BufferGeometry)[] = [];
GEOMETRY[WORK_WALL] = () =>
  withMask([
    { size: [1.3, 2.75, 1.3], at: [0, 1.37, 0], color: CONCRETE },
    { size: [1.5, 0.22, 1.5], at: [0, 0.11, 0], color: CONCRETE, shade: 0.8 },
    { size: [1.0, 0.1, 1.0], at: [0, 2.8, 0], color: 0xffffff, team: true },
  ]);
GEOMETRY[WORK_GATE] = () =>
  withMask([
    { size: [0.8, 3.3, 1.3], at: [-1.6, 1.65, 0], color: CONCRETE, shade: 0.9 },
    { size: [0.8, 3.3, 1.3], at: [1.6, 1.65, 0], color: CONCRETE, shade: 0.9 },
    { size: [2.5, 1.9, 0.22], at: [0, 1.05, 0], color: STEEL },
    { size: [2.5, 0.16, 0.3], at: [0, 1.5, 0], color: STEEL, shade: 0.7 },
    { size: [2.5, 0.16, 0.3], at: [0, 0.6, 0], color: STEEL, shade: 0.7 },
    { size: [4.0, 0.25, 0.5], at: [0, 3.35, 0], color: 0xffffff, team: true },
  ]);
GEOMETRY[WORK_WIRE] = () => {
  const parts: Part[] = [];
  for (const x of [-1.9, 0, 1.9]) {
    parts.push({ size: [0.09, 1.25, 0.09], at: [x, 0.62, 0], color: RUST, shade: 0.8 });
  }
  // Coils, seen as rows of tilted hoops with strands through them.
  for (let k = 0; k < 9; k++) {
    const x = -1.8 + k * 0.45;
    parts.push({ size: [0.04, 0.95, 0.95], at: [x, 0.55, 0], rot: [0.78, 0, 0], color: WIRE });
  }
  for (const [y, z] of [
    [0.25, -0.4],
    [0.25, 0.4],
    [0.95, 0],
  ]) {
    parts.push({ size: [4, 0.045, 0.045], at: [0, y, z], color: WIRE, shade: 1.3 });
  }
  return withMask(parts);
};
GEOMETRY[WORK_TRAP] = () =>
  withMask([
    ...hedgehog(-0.95, -0.7, 0.3),
    ...hedgehog(0.9, 0.75, 1.4),
    {
      size: [1.1, 0.75, 1.1],
      at: [1.0, 0.36, -1.0],
      rot: [0, 0.5, 0],
      color: CONCRETE,
      shade: 0.85,
    },
    {
      size: [1.1, 0.75, 1.1],
      at: [-1.0, 0.36, 1.05],
      rot: [0, 0.2, 0],
      color: CONCRETE,
      shade: 0.8,
    },
  ]);
GEOMETRY[WORK_TRENCH] = () =>
  withMask([
    { size: [4.02, 0.1, 2.0], at: [0, 0.05, 0], color: DUG },
    { size: [4.02, 0.6, 0.85], at: [0, 0.3, -1.4], color: EARTH },
    { size: [4.02, 0.6, 0.85], at: [0, 0.3, 1.4], color: EARTH, shade: 0.9 },
    { size: [4.02, 0.2, 0.5], at: [0, 0.65, -1.4], color: EARTH, shade: 1.12 },
    { size: [4.02, 0.2, 0.5], at: [0, 0.65, 1.4], color: EARTH, shade: 1.05 },
  ]);
GEOMETRY[WORK_SANDBAG] = () => {
  const parts: Part[] = [];
  for (const s of [-1, 1]) {
    parts.push({ size: [3.7, 0.5, 0.7], at: [0, 0.25, s * 1.55], color: SACK, shade: 0.9 });
    parts.push({ size: [3.4, 0.45, 0.6], at: [0, 0.72, s * 1.55], color: SACK });
    parts.push({ size: [0.7, 0.5, 2.3], at: [s * 1.55, 0.25, 0], color: SACK, shade: 0.95 });
    parts.push({ size: [0.6, 0.45, 2.0], at: [s * 1.55, 0.72, 0], color: SACK, shade: 1.06 });
  }
  return withMask(parts);
};

/** What the pointer is over, for orders. */
export interface WorkHit {
  cell: number;
  kind: number;
  team: number;
  done: boolean;
}

export class WorksView {
  readonly group = new THREE.Group();
  /** Per cell: the record of the work on it (see Snapshot.works), 0 = none. */
  readonly at = new Int32Array(CELLS);
  /** Bumped when works appear or go, so the minimap knows to redraw. */
  version = 0;
  /** Show the enemy's works whether or not they have been seen (spectating). */
  revealAll = false;
  private cells: number[] = [];
  /** Enemy works the player has laid eyes on. */
  private readonly seen = new Uint8Array(CELLS);
  private readonly batches: (Batch | null)[] = new Array(WORK_COUNT).fill(null);
  private readonly arms: Batch;
  private readonly ghosts: Batch;
  private readonly preview: Batch;
  private dirty = true;
  private lastBuild = 0;

  constructor(
    private readonly map: GameMap,
    private readonly terrain: Terrain,
    private readonly fog: Fog,
    private readonly effects: Effects,
    shadows: boolean,
  ) {
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.94, metalness: 0.02 });
    const tint = attribute('aTint', 'vec4');
    // tint.xyz is the owner's paint (on the marked parts only), tint.w the damage.
    const painted = mix(attribute('color', 'vec3'), tint.xyz, attribute('teamMask', 'float'));
    material.colorNode = painted.mul(float(1).sub(tint.w.mul(0.55))).mul(fog.shade());
    const batch = (g: THREE.BufferGeometry, cap: number, shadow: boolean) => {
      const b = new Batch(g, material, cap);
      b.mesh.castShadow = shadows && shadow;
      b.mesh.receiveShadow = shadows;
      this.group.add(b.mesh);
      return b;
    };
    for (let k = 1; k < WORK_COUNT; k++) {
      this.batches[k] = batch(GEOMETRY[k](), 4096, k !== WORK_TRENCH && k !== WORK_WIRE);
    }
    // A wall is a post per cell and an arm toward each neighbour that is wall or gate.
    this.arms = batch(
      withMask([
        { size: [2.02, 2.5, 0.85], at: [1.0, 1.25, 0], color: CONCRETE, shade: 0.94 },
        { size: [2.02, 0.2, 1.0], at: [1.0, 0.1, 0], color: CONCRETE, shade: 0.78 },
      ]),
      4096 * 3,
      true,
    );
    const flat = new THREE.MeshBasicNodeMaterial({ transparent: true });
    flat.colorNode = tint.xyz;
    flat.opacityNode = tint.w;
    flat.depthWrite = false;
    const slab = new THREE.BoxGeometry(3.7, 1, 3.7).translate(0, 0.5, 0);
    this.ghosts = new Batch(slab, flat, 4096);
    this.preview = new Batch(slab.clone(), flat, 512);
    this.group.add(this.ghosts.mesh, this.preview.mesh);
  }

  /** The work on the cell under world point (x, z) that the player knows about, or null. */
  workAt(x: number, z: number): WorkHit | null {
    const cx = Math.floor(x / CELL);
    const cy = Math.floor(z / CELL);
    if (cx < 0 || cy < 0 || cx >= MAP_CELLS || cy >= MAP_CELLS) return null;
    const cell = cy * MAP_CELLS + cx;
    const rec = this.at[cell];
    if (rec === 0 || !this.known(cell, rec)) return null;
    return { cell, kind: rec & KIND_MASK, team: (rec >> 4) & 7, done: (rec & DONE) !== 0 };
  }

  /** May the player be shown this work? His own always; the enemy's once seen, if finished. */
  private known(cell: number, rec: number): boolean {
    if (((rec >> 4) & 7) === 0 || this.revealAll) return true;
    return (rec & DONE) !== 0 && this.seen[cell] === 1;
  }

  /** Every work of army `team` in the cell rectangle, for taking them down. */
  inRect(x0: number, y0: number, x1: number, y1: number, team: number): number[] {
    const out: number[] = [];
    for (const c of this.cells) {
      const x = c % MAP_CELLS;
      const y = (c - x) / MAP_CELLS;
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      if (((this.at[c] >> 4) & 7) === team) out.push(c);
    }
    return out;
  }

  applySnapshot(s: Snapshot): void {
    for (let e = 0; e < s.events.length; e += 3) {
      if (s.events[e] !== EV_WORK_LOST) continue;
      const c = s.events[e + 1];
      const x = ((c % MAP_CELLS) + 0.5) * CELL;
      const z = (Math.floor(c / MAP_CELLS) + 0.5) * CELL;
      if (this.fog.sees(x, z)) this.effects.squadHit(x, this.terrain.heightAt(x, z) + 0.6, z);
    }
    const works = s.works;
    if (!works) return;
    const map = this.map;
    const at = this.at;
    const old = this.cells;
    const next: number[] = [];
    const fresh = new Int32Array(works.length >> 1);
    for (let k = 0; k < works.length; k += 2) {
      next.push(works[k]);
      fresh[k >> 1] = works[k + 1];
    }
    // Gone: the ground is as it was.
    const keep = new Set(next);
    for (const c of old) {
      if (keep.has(c)) continue;
      if ((at[c] & DONE) !== 0 && isWork(map.type[c])) {
        map.type[c] = map.baseType[c];
        map.workTeam[c] = NO_OWNER;
        this.fog.setLowWall(c, false);
      }
      at[c] = 0;
      this.seen[c] = 0;
    }
    for (let k = 0; k < next.length; k++) {
      const c = next[k];
      const rec = fresh[k];
      if ((rec & DONE) !== 0 && (at[c] & DONE) === 0) {
        // Finished: it is part of the terrain now, on this copy of the map as in the sim.
        const kind = rec & KIND_MASK;
        if (map.type[c] === T_OPEN || map.type[c] === T_FORD) {
          map.baseType[c] = map.type[c];
          map.type[c] = WORKS[kind].terrain;
          map.workTeam[c] = (rec >> 4) & 7;
          if (kind === WORK_WALL || kind === WORK_GATE) this.fog.setLowWall(c, true);
        }
      }
      at[c] = rec;
    }
    this.cells = next;
    this.dirty = true;
    this.version++;
  }

  /**
   * While drawing a line of works: show the cells, green where one will go and red where
   * it cannot (or cannot be paid for).
   */
  setPreview(cells: readonly number[], ok: readonly boolean[]): void {
    const b = this.preview;
    b.n = 0;
    for (let k = 0; k < cells.length; k++) {
      const x = ((cells[k] % MAP_CELLS) + 0.5) * CELL;
      const z = (Math.floor(cells[k] / MAP_CELLS) + 0.5) * CELL;
      const y = this.terrain.heightAt(x, z) + 0.05;
      if (ok[k]) b.put(x, y, z, 0, 1, 1.4, 0.3, 1, 0.42, 0.42);
      else b.put(x, y, z, 0, 1, 1.4, 1, 0.3, 0.22, 0.42);
    }
    b.flush();
  }

  /** Does cell `c` hold a finished work of one of these kinds that the player knows? */
  private joins(c: number, a: number, b: number): boolean {
    if (c < 0 || c >= CELLS) return false;
    const rec = this.at[c];
    if ((rec & DONE) === 0 || !this.known(c, rec)) return false;
    const kind = rec & KIND_MASK;
    return kind === a || kind === b;
  }

  update(seconds: number): void {
    // Enemy works come into view as the fog lifts: look again twice a second.
    if (!this.dirty && seconds - this.lastBuild < 0.5) return;
    let changed = this.dirty;
    for (const c of this.cells) {
      if (this.seen[c] === 0 && this.fog.visible[c] === 1) {
        this.seen[c] = 1;
        changed = true;
      }
    }
    this.lastBuild = seconds;
    this.dirty = false;
    if (!changed) return;
    for (const b of this.batches) if (b) b.n = 0;
    this.arms.n = 0;
    this.ghosts.n = 0;
    const N = MAP_CELLS;
    for (const c of this.cells) {
      const rec = this.at[c];
      if (!this.known(c, rec)) continue;
      const kind = rec & KIND_MASK;
      const team = (rec >> 4) & 7;
      const cx = c % N;
      const x = (cx + 0.5) * CELL;
      const z = (Math.floor(c / N) + 0.5) * CELL;
      const y = this.terrain.heightAt(x, z);
      const paint = TEAM[team] ?? TEAM[0];
      const value = (rec >> 8) & 255;
      if ((rec & DONE) === 0) {
        // Planned: a pale slab that fills as the work gets done.
        this.ghosts.put(x, y + 0.05, z, 0, 1, 0.25 + value / 60, 0.85, 0.9, 0.8, 0.3);
        continue;
      }
      const worn = 1 - value / 255;
      const batch = this.batches[kind];
      if (!batch) continue;
      const east = cx < N - 1 && this.joins(c + 1, kind, kind);
      const west = cx > 0 && this.joins(c - 1, kind, kind);
      const north = this.joins(c - N, kind, kind);
      const south = this.joins(c + N, kind, kind);
      if (kind === WORK_WALL) {
        batch.put(x, y, z, 0, 1, 1, paint[0], paint[1], paint[2], worn);
        const link = (to: number, sin: number, cos: number, edge: boolean) => {
          if (edge && this.joins(to, WORK_WALL, WORK_GATE)) {
            this.arms.put(x, y, z, sin, cos, 1, paint[0], paint[1], paint[2], worn);
          }
        };
        const before = this.arms.n;
        link(c + 1, 0, 1, cx < N - 1);
        link(c - 1, 0, -1, cx > 0);
        link(c + N, -1, 0, true);
        link(c - N, 1, 0, true);
        if (this.arms.n === before) {
          // Standing alone: a slab, not a post.
          this.arms.put(x, y, z, 0, 1, 1, paint[0], paint[1], paint[2], worn);
          this.arms.put(x, y, z, 0, -1, 1, paint[0], paint[1], paint[2], worn);
        }
      } else if (kind === WORK_GATE) {
        // Across the gap in the wall it closes.
        const alongZ =
          (this.joins(c - N, WORK_WALL, WORK_GATE) || this.joins(c + N, WORK_WALL, WORK_GATE)) &&
          !(cx > 0 && this.joins(c - 1, WORK_WALL, WORK_GATE)) &&
          !(cx < N - 1 && this.joins(c + 1, WORK_WALL, WORK_GATE));
        batch.put(x, y, z, alongZ ? 1 : 0, alongZ ? 0 : 1, 1, paint[0], paint[1], paint[2], worn);
      } else if (kind === WORK_WIRE || kind === WORK_TRENCH) {
        // Along the line it is part of; a crossing or a single cell gets both ways.
        const ew = east || west;
        const ns = north || south;
        if (ew || !ns) batch.put(x, y, z, 0, 1, 1, paint[0], paint[1], paint[2], worn);
        if (ns && (kind === WORK_WIRE || !ew)) {
          batch.put(x, y, z, 1, 0, 1, paint[0], paint[1], paint[2], worn);
        }
      } else {
        // Obstacles and sandbags: turned a little from cell to cell, so a line is not a stamp.
        const turn = kind === WORK_TRAP ? ((c * 2654435761) >>> 28) * 0.39 : 0;
        batch.put(x, y, z, Math.sin(turn), Math.cos(turn), 1, paint[0], paint[1], paint[2], worn);
      }
    }
    for (const b of this.batches) if (b) b.flush();
    this.arms.flush();
    this.ghosts.flush();
  }
}
