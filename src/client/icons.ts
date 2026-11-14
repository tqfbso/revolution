// The readability layer: a map symbol over every unit, fading in as the camera pulls back
// to where a camouflaged vehicle is a few muddy pixels. Frames in the army's colour, a dark
// glyph per type, loosely after the symbols on staff maps. One texture, one draw call.
import * as THREE from 'three/webgpu';
import { attribute, texture, uv, vec2 } from 'three/tsl';
import {
  KIND_AD,
  KIND_ARTILLERY,
  KIND_ATGM,
  KIND_COUNT,
  KIND_DRONE,
  KIND_ENGINEER,
  KIND_HELI,
  KIND_LIFT,
  KIND_PARA,
  KIND_PLANE,
  KIND_EW,
  KIND_IFV,
  KIND_INFANTRY,
  KIND_RECON,
  KIND_STRIKE,
  KIND_TANK,
  KIND_TRUCK,
} from '../sim/units';
import { Batch } from './batch';

const GRID = 5; // symbols per row of the sheet
/** The first of the eight commander pennants on the sheet (A to H), after the unit types. */
export const ICON_PENNANT = KIND_COUNT;
/** A colour per sub-commander, bright enough to carry over camouflage and over snowless mud. */
export const COMMANDER_RGB: readonly (readonly [number, number, number])[] = [
  [1, 0.7, 0.05],
  [0.1, 0.78, 1],
  [1, 0.25, 0.75],
  [0.4, 1, 0.15],
  [1, 0.4, 0.05],
  [0.55, 0.4, 1],
  [0.95, 0.95, 0.95],
  [0.05, 1, 0.65],
];
const TILE = 64;
/** Camera distance at which the symbols start to show, and at which they are solid. */
export const ICON_FROM = 250;
export const ICON_FULL = 380;

type Draw = (c: CanvasRenderingContext2D) => void;

function glyphs(): Draw[] {
  const line = (c: CanvasRenderingContext2D, pts: number[]) => {
    c.beginPath();
    c.moveTo(pts[0], pts[1]);
    for (let k = 2; k < pts.length; k += 2) c.lineTo(pts[k], pts[k + 1]);
    c.stroke();
  };
  const cross: Draw = (c) => {
    line(c, [12, 18, 52, 46]);
    line(c, [12, 46, 52, 18]);
  };
  const oval: Draw = (c) => {
    c.beginPath();
    c.ellipse(32, 32, 13, 7, 0, 0, Math.PI * 2);
    c.stroke();
  };
  const dot = (c: CanvasRenderingContext2D, x: number, y: number, r: number) => {
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();
  };
  const g: Draw[] = new Array<Draw>(KIND_COUNT).fill(cross);
  g[KIND_TANK] = oval;
  g[KIND_INFANTRY] = cross;
  g[KIND_IFV] = (c) => {
    oval(c);
    cross(c);
  };
  g[KIND_ATGM] = (c) => {
    cross(c);
    line(c, [32, 44, 32, 22]);
    line(c, [26, 28, 32, 21, 38, 28]);
  };
  g[KIND_ARTILLERY] = (c) => dot(c, 32, 32, 7);
  g[KIND_RECON] = (c) => line(c, [12, 46, 52, 18]);
  g[KIND_DRONE] = (c) => line(c, [14, 26, 32, 38, 50, 26]);
  g[KIND_STRIKE] = (c) => {
    line(c, [14, 24, 32, 36, 50, 24]);
    dot(c, 32, 26, 4);
  };
  g[KIND_AD] = (c) => {
    c.beginPath();
    c.arc(32, 46, 17, Math.PI, 0);
    c.stroke();
  };
  g[KIND_EW] = (c) => line(c, [14, 36, 22, 26, 30, 38, 38, 26, 46, 38, 52, 30]);
  g[KIND_TRUCK] = (c) => {
    line(c, [14, 34, 50, 34]);
    dot(c, 22, 40, 4);
    dot(c, 42, 40, 4);
  };
  g[KIND_ENGINEER] = (c) => line(c, [16, 40, 16, 26, 48, 26, 48, 40, 32, 26, 32, 40]);
  // Helicopters: a rotor bow tie; the gunship has a dot under it, the transport an oval.
  const rotor = (c: CanvasRenderingContext2D) => line(c, [14, 20, 50, 34, 50, 20, 14, 34, 14, 20]);
  g[KIND_HELI] = (c) => {
    rotor(c);
    dot(c, 32, 42, 4);
  };
  g[KIND_LIFT] = (c) => {
    rotor(c);
    c.beginPath();
    c.ellipse(32, 42, 9, 4, 0, 0, Math.PI * 2);
    c.stroke();
  };
  // Paratroops: infantry under a canopy.
  g[KIND_PARA] = (c) => {
    cross(c);
    c.beginPath();
    c.arc(32, 26, 15, Math.PI, 0);
    c.stroke();
  };
  // The transport plane: wings and a tail.
  g[KIND_PLANE] = (c) => {
    line(c, [32, 14, 32, 50]);
    line(c, [12, 30, 52, 30]);
    line(c, [24, 46, 40, 46]);
  };
  return g;
}

function sheet(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = GRID * TILE;
  const c = canvas.getContext('2d')!;
  const draw = glyphs();
  for (let k = 0; k < KIND_COUNT; k++) {
    c.save();
    c.translate((k % GRID) * TILE, Math.floor(k / GRID) * TILE);
    // The frame: white, so the army's colour shows through it; dark edge and glyph.
    c.fillStyle = '#fff';
    c.strokeStyle = '#0b0d0f';
    c.lineWidth = 4;
    c.beginPath();
    c.rect(8, 14, 48, 36);
    c.fill();
    c.stroke();
    c.fillStyle = '#0b0d0f';
    c.lineWidth = 3.5;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    draw[k](c);
    c.restore();
  }
  // Commander pennants: a small flag with the commander's letter, tinted per commander.
  for (let k = 0; k < 8; k++) {
    const n = ICON_PENNANT + k;
    c.save();
    c.translate((n % GRID) * TILE, Math.floor(n / GRID) * TILE);
    c.fillStyle = '#fff';
    c.strokeStyle = '#0b0d0f';
    c.lineWidth = 4;
    c.lineJoin = 'round';
    c.beginPath();
    c.moveTo(10, 8);
    c.lineTo(54, 8);
    c.lineTo(54, 40);
    c.lineTo(32, 58);
    c.lineTo(10, 40);
    c.closePath();
    c.fill();
    c.stroke();
    c.fillStyle = '#0b0d0f';
    c.font = 'bold 30px sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(String.fromCharCode(65 + k), 32, 27);
    c.restore();
  }
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.flipY = false;
  return t;
}

export class Icons {
  readonly batch: Batch;

  constructor(capacity: number) {
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true });
    const tint = attribute('aTint', 'vec4');
    // tint.w: the whole part picks the symbol, the fraction is how solid it is.
    const kind = tint.w.floor();
    const cell = vec2(kind.mod(GRID), kind.div(GRID).floor());
    const at = cell.add(vec2(uv().x, uv().y.oneMinus())).div(GRID);
    const symbol = texture(sheet(), at);
    material.colorNode = symbol.rgb.mul(tint.xyz);
    material.opacityNode = symbol.a.mul(tint.w.fract().mul(1.25).min(1));
    material.depthWrite = false;
    material.depthTest = false;
    material.fog = false;
    this.batch = new Batch(new THREE.PlaneGeometry(1, 1), material, capacity);
    this.batch.mesh.renderOrder = 4;
  }

  /** A symbol of size `s` facing the camera, whose right and up axes are (rx..) and (ux..). */
  put(
    x: number,
    y: number,
    z: number,
    s: number,
    right: THREE.Vector3,
    up: THREE.Vector3,
    kind: number,
    r: number,
    g: number,
    b: number,
    alpha: number,
  ): void {
    const batch = this.batch;
    if (batch.n >= batch.capacity) return;
    const m = batch.m;
    const o = batch.n * 16;
    m[o] = right.x * s;
    m[o + 1] = right.y * s;
    m[o + 2] = right.z * s;
    m[o + 3] = 0;
    m[o + 4] = up.x * s;
    m[o + 5] = up.y * s;
    m[o + 6] = up.z * s;
    m[o + 7] = 0;
    m[o + 8] = 0;
    m[o + 9] = 0;
    m[o + 10] = 1;
    m[o + 11] = 0;
    m[o + 12] = x;
    m[o + 13] = y;
    m[o + 14] = z;
    m[o + 15] = 1;
    const t = batch.t;
    const q = batch.n * 4;
    t[q] = r;
    t[q + 1] = g;
    t[q + 2] = b;
    t[q + 3] = kind + Math.min(0.79, alpha * 0.79) + 0.005;
    batch.n++;
  }
}
