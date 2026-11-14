// The map grid: eight columns A to H (west to east) and eight rows 1 to 8 (north to
// south), so that players can tell each other where: "armour to C4". Drawn on the minimap
// always, and on the battlefield when asked for (K): faint lines over the ground and the
// name of each square floating in it.
import * as THREE from 'three/webgpu';
import { MAP_SIZE } from '../sim/map';

export const GRID = 8;
const SQUARE = MAP_SIZE / GRID;

const clampIndex = (v: number) => Math.min(GRID - 1, Math.max(0, Math.floor(v / SQUARE)));

/** The square a ground point is in: "C4". */
export function gridRef(x: number, z: number): string {
  return `${String.fromCharCode(65 + clampIndex(x))}${clampIndex(z) + 1}`;
}

function label(text: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.font = 'bold 44px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(8,12,16,0.85)';
  ctx.strokeText(text, 64, 34);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, 64, 34);
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** The grid on the battlefield. Built the first time it is shown. */
export class GridOverlay {
  readonly group = new THREE.Group();
  private built = false;

  constructor(private readonly heightAt: (x: number, z: number) => number) {
    this.group.visible = false;
  }

  get shown(): boolean {
    return this.group.visible;
  }

  show(on: boolean): void {
    if (on && !this.built) this.build();
    this.group.visible = on;
  }

  private build(): void {
    this.built = true;
    // Lines that follow the ground, a little above it.
    const STEP = 4;
    const pts: number[] = [];
    const y = (x: number, z: number) => this.heightAt(x, z) + 0.6;
    for (let k = 0; k <= GRID; k++) {
      const at = Math.min(MAP_SIZE - 0.5, Math.max(0.5, k * SQUARE));
      for (let s = 0; s < MAP_SIZE; s += STEP) {
        const e = Math.min(MAP_SIZE, s + STEP);
        pts.push(at, y(at, s), s, at, y(at, e), e);
        pts.push(s, y(s, at), at, e, y(e, at), at);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const lines = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicNodeMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
      }),
    );
    lines.frustumCulled = false;
    lines.renderOrder = 5;
    this.group.add(lines);
    // The name of each square, four times in it, so that one is in view however far the
    // camera is zoomed in. They show through buildings and trees.
    for (let gx = 0; gx < GRID; gx++) {
      for (let gz = 0; gz < GRID; gz++) {
        const material = new THREE.SpriteNodeMaterial({
          map: label(gridRef((gx + 0.5) * SQUARE, (gz + 0.5) * SQUARE)),
          transparent: true,
          opacity: 0.5,
          depthTest: false,
          depthWrite: false,
        });
        for (const [fx, fz] of [
          [0.25, 0.25],
          [0.75, 0.25],
          [0.25, 0.75],
          [0.75, 0.75],
        ]) {
          const sprite = new THREE.Sprite(material);
          const x = (gx + fx) * SQUARE;
          const z = (gz + fz) * SQUARE;
          sprite.position.set(x, this.heightAt(x, z) + 6, z);
          sprite.scale.set(16, 8, 1);
          sprite.renderOrder = 6;
          this.group.add(sprite);
        }
      }
    }
  }
}
