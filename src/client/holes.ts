// Mouseholes on screen (decision 166). Two things, kept apart as the art direction asks:
//  - the real look: a dark opening at the foot of each wall knocked through (seen across a
//    yard, or through the cutaway; a party wall's hole is inside the block, as it should be);
//  - the readability layer: a thin pale bar across the top of the wall over each hole, so
//    that from the usual camera height the player can tell which houses are joined.
// Drawn once the player has seen the place, and gone when either house is down.
import * as THREE from 'three/webgpu';
import { fromFx } from '../sim/fixed';
import { holeNet } from '../sim/holes';
import type { GameMap } from '../sim/map';
import type { Fog } from './fog';

/** Cell size in metres. */
const CELL = 4;
const WIDE = 1.1;
const HIGH = 1.9;
/** How far the opening stands out of each face, so it reads on any wall. */
const DEEP = 0.9;
/** The bar over the wall: how far it reaches into each house, how wide and thick it is. */
const BAR = 2.4;
const BAR_W = 0.55;
const BAR_H = 0.25;
/** It lies on the parapet, not in it. */
const BAR_UP = 0.9;
const MAX = 4096;

export class HoleMarks {
  readonly group = new THREE.Group();
  private readonly openings: THREE.InstancedMesh;
  private readonly bars: THREE.InstancedMesh;
  private readonly shown: number[] = [];
  private readonly known = new Set<number>();
  private calls = 0;

  constructor(
    private readonly map: GameMap,
    private readonly fog: Fog,
    /** Height of the top of the walls of building `s` as it stands now, or -1 if it is down. */
    private readonly eaves: (s: number) => number,
  ) {
    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);
    this.openings = new THREE.InstancedMesh(
      box,
      new THREE.MeshStandardNodeMaterial({ color: 0x17130f, roughness: 1 }),
      MAX,
    );
    this.bars = new THREE.InstancedMesh(
      box,
      new THREE.MeshBasicNodeMaterial({ color: 0xd9cba4 }),
      MAX,
    );
    for (const m of [this.openings, this.bars]) {
      m.count = 0;
      m.frustumCulled = false;
      this.group.add(m);
    }
  }

  /** The holes open now, by pair. */
  update(open: readonly number[] | undefined): void {
    if (!open) return;
    let changed = false;
    const net = holeNet(this.map);
    for (const p of open) {
      if (this.known.has(p) || p >= net.pairCount) continue;
      const x = (net.px2[p] / 2) * CELL;
      const z = (net.py2[p] / 2) * CELL;
      if (!this.fog.sees(x, z) && !this.fog.hasExplored(x, z)) continue;
      this.known.add(p);
      this.shown.push(p);
      changed = true;
    }
    // Houses come down and lose floors: look again now and then.
    if (!changed && (this.calls++ & 31) !== 0) return;
    if (this.shown.length > 0) this.draw();
  }

  private draw(): void {
    const net = holeNet(this.map);
    const m = this.map;
    const tmp = new THREE.Matrix4();
    let o = 0;
    let b = 0;
    for (const p of this.shown) {
      const a = net.pa[p];
      const c = net.pb[p];
      const top = Math.min(this.eaves(a), this.eaves(c));
      if (top < 0) continue;
      const x = (net.px2[p] / 2) * CELL;
      const z = (net.py2[p] / 2) * CELL;
      const along = net.axis[p] === 1;
      const base = Math.min(fromFx(m.sBase[a]), fromFx(m.sBase[c]));
      const g = net.gap[p] * CELL;
      // One opening through a party wall; two, one in each house, across a yard.
      for (const off of g === 0 ? [0] : [-g / 2, g / 2]) {
        if (o >= MAX) break;
        if (along) tmp.makeScale(WIDE, HIGH, DEEP).setPosition(x, base, z + off);
        else tmp.makeScale(DEEP, HIGH, WIDE).setPosition(x + off, base, z);
        this.openings.setMatrixAt(o++, tmp);
      }
      if (b >= MAX) continue;
      const len = 2 * BAR + g;
      if (along) tmp.makeScale(BAR_W, BAR_H, len).setPosition(x, top + BAR_UP, z);
      else tmp.makeScale(len, BAR_H, BAR_W).setPosition(x, top + BAR_UP, z);
      this.bars.setMatrixAt(b++, tmp);
    }
    this.openings.count = o;
    this.bars.count = b;
    this.openings.instanceMatrix.needsUpdate = true;
    this.bars.instanceMatrix.needsUpdate = true;
  }
}
