import { describe, expect, it } from 'vitest';
import type * as THREE from 'three/webgpu';
import { prism } from '../src/client/kit';
import { buildArsenal, type VehicleModel } from '../src/client/models';
import { KIND_COUNT } from '../src/sim/units';

const tris = (g: THREE.BufferGeometry) =>
  (g.index ? g.index.count : g.getAttribute('position').count) / 3;

/** Six times the volume a closed mesh encloses: positive when its faces look outward. */
function volume(g: THREE.BufferGeometry): number {
  const p = g.getAttribute('position');
  const at = (k: number) => (g.index ? g.index.getX(k) : k);
  let v = 0;
  for (let k = 0; k < (g.index ? g.index.count : p.count); k += 3) {
    const [a, b, c] = [at(k), at(k + 1), at(k + 2)];
    v +=
      p.getX(a) * (p.getY(b) * p.getZ(c) - p.getZ(b) * p.getY(c)) -
      p.getY(a) * (p.getX(b) * p.getZ(c) - p.getZ(b) * p.getX(c)) +
      p.getZ(a) * (p.getX(b) * p.getY(c) - p.getY(b) * p.getX(c));
  }
  return v;
}

function sound(g: THREE.BufferGeometry): void {
  for (const name of ['position', 'normal', 'color', 'teamMask', 'aBoxP', 'aBoxH']) {
    const a = g.getAttribute(name);
    expect(a, name).toBeDefined();
    expect(a.count).toBe(g.getAttribute('position').count);
    for (const v of a.array as Float32Array) expect(Number.isFinite(v)).toBe(true);
  }
}

describe('unit models', () => {
  const arsenals = [0, 1, 2, 3].map(buildArsenal);

  it('builds every kind for every army, sound and within its triangle budget', () => {
    for (const a of arsenals) {
      const models = [...a.vehicles, a.jet].filter((m): m is VehicleModel => m !== null);
      expect(models.length).toBe(12);
      expect(a.vehicles.length).toBe(KIND_COUNT);
      for (const m of models) {
        expect(m.hull.length).toBe(2);
        for (const g of [...m.hull, ...m.turret, m.far]) sound(g);
        const near = tris(m.hull[0]) + (m.turret[0] ? tris(m.turret[0]) : 0);
        const mid = tris(m.hull[1]) + (m.turret[1] ? tris(m.turret[1]) : 0);
        expect(near).toBeLessThan(6500);
        expect(mid).toBeLessThan(1400);
        expect(tris(m.far)).toBeLessThan(420);
        // Detail falls away with distance, never the other way.
        expect(mid).toBeLessThanOrEqual(near);
      }
    }
  });

  it('stands ground vehicles on the ground and keeps them the size of the old ones', () => {
    for (const a of arsenals) {
      for (const kind of [0, 3, 4, 8, 9, 10]) {
        const m = a.vehicles[kind]!;
        m.far.computeBoundingBox();
        expect(m.far.boundingBox!.min.y).toBeGreaterThan(-0.03);
        for (const g of m.hull) {
          g.computeBoundingBox();
          const b = g.boundingBox!;
          expect(b.min.y).toBeGreaterThan(-0.03);
          expect(b.min.y).toBeLessThan(0.06);
          // Hull length between 2 and 3.5 map units, width under 1.5: what the sim's
          // spacing and the selection rings were made for.
          expect(b.max.z - b.min.z).toBeGreaterThan(2);
          expect(b.max.z - b.min.z).toBeLessThan(3.6);
          expect(b.max.x - b.min.x).toBeLessThan(1.5);
          expect(Math.abs(b.max.x + b.min.x)).toBeLessThan(0.2);
        }
      }
    }
  });

  it("gives each army's vehicles their own outline", () => {
    const outline = (m: VehicleModel) => {
      m.far.computeBoundingBox();
      const b = m.far.boundingBox!;
      return [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z];
    };
    for (const kind of [0, 3, 4, 8, 9, 10]) {
      for (const [p, q] of [
        [1, 2],
        [1, 3],
        [2, 3],
      ]) {
        const a = outline(arsenals[p].vehicles[kind]!);
        const b = outline(arsenals[q].vehicles[kind]!);
        const apart = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
        expect(apart, `kind ${kind}, armies ${p} and ${q}`).toBeGreaterThan(0.08);
      }
    }
    // The alliance's tank stands tallest, Russia's lowest.
    const tall = (f: number) => outline(arsenals[f].vehicles[0]!)[1];
    expect(tall(1)).toBeGreaterThan(tall(2));
  });

  it('turns every plate of a prism outward whichever way round it is drawn', () => {
    const shape: [number, number][] = [
      [-1, 0],
      [-1, 1],
      [0.5, 1],
      [1, 0.4],
      [1, 0],
    ];
    for (const half of [0.5, [0.5, 0.4, 0.4, 0.3, 0.5]]) {
      const a = prism(shape, half);
      const b = prism([...shape].reverse(), Array.isArray(half) ? [...half].reverse() : half);
      expect(volume(a)).toBeGreaterThan(0);
      expect(volume(b)).toBeCloseTo(volume(a), 4);
    }
  });
});
