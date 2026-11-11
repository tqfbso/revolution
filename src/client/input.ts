import * as THREE from 'three/webgpu';
import { CMD_MOVE, CMD_STOP, type Command } from '../sim/commands';
import { fx } from '../sim/fixed';
import type { Terrain } from './terrain';
import type { UnitView } from './units';

const CLICK_SLOP_PX = 5;
const CLICK_PICK_PX = 22;

/**
 * Turns mouse and keyboard into selection (client-only state) and commands (sent to the sim).
 * Left drag: box select. Left click: select one. Shift: add. Right click: move.
 */
export class Input {
  readonly marker: THREE.Mesh;
  private dragStart: { x: number; y: number } | null = null;
  private markerAge = 1;
  private readonly box = document.getElementById('select-box') as HTMLDivElement;
  private readonly v = new THREE.Vector3();
  private readonly ray = new THREE.Raycaster();
  private readonly hit = new THREE.Vector3();

  constructor(
    private readonly dom: HTMLElement,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly terrain: Terrain,
    private readonly units: UnitView,
    private readonly send: (command: Command) => void,
  ) {
    const markerMaterial = new THREE.MeshBasicNodeMaterial({ color: 0x7dff8a, transparent: true });
    markerMaterial.depthWrite = false;
    this.marker = new THREE.Mesh(
      new THREE.RingGeometry(1.6, 2.1, 32).rotateX(-Math.PI / 2),
      markerMaterial,
    );
    this.marker.visible = false;

    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    dom.addEventListener('pointerdown', (e) => {
      if (e.button === 0) {
        this.dragStart = { x: e.clientX, y: e.clientY };
        dom.setPointerCapture(e.pointerId);
      } else if (e.button === 2) {
        this.orderMove(e.clientX, e.clientY);
      }
    });
    dom.addEventListener('pointermove', (e) => {
      if (!this.dragStart) return;
      const s = this.dragStart;
      const w = Math.abs(e.clientX - s.x);
      const h = Math.abs(e.clientY - s.y);
      if (w < CLICK_SLOP_PX && h < CLICK_SLOP_PX) return;
      this.box.style.display = 'block';
      this.box.style.left = `${Math.min(s.x, e.clientX)}px`;
      this.box.style.top = `${Math.min(s.y, e.clientY)}px`;
      this.box.style.width = `${w}px`;
      this.box.style.height = `${h}px`;
    });
    dom.addEventListener('pointerup', (e) => {
      if (e.button !== 0 || !this.dragStart) return;
      const s = this.dragStart;
      this.dragStart = null;
      this.box.style.display = 'none';
      this.select(s.x, s.y, e.clientX, e.clientY, e.shiftKey);
    });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') units.setSelected([], false);
      else if (e.code === 'KeyA' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        units.setSelected(range(units.count), false);
      } else if (e.code === 'KeyX' && units.selectedCount > 0) {
        send({ type: CMD_STOP, units: units.selectedIds() });
      }
    });
  }

  update(dt: number): void {
    if (!this.marker.visible) return;
    this.markerAge += dt * 2.2;
    if (this.markerAge >= 1) {
      this.marker.visible = false;
      return;
    }
    const s = 1 + this.markerAge * 1.5;
    this.marker.scale.set(s, 1, s);
    (this.marker.material as THREE.MeshBasicNodeMaterial).opacity = 1 - this.markerAge;
  }

  private select(x0: number, y0: number, x1: number, y1: number, additive: boolean): void {
    const rect = this.dom.getBoundingClientRect();
    const isClick = Math.abs(x1 - x0) < CLICK_SLOP_PX && Math.abs(y1 - y0) < CLICK_SLOP_PX;
    const minX = Math.min(x0, x1);
    const maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1);
    const maxY = Math.max(y0, y1);
    const pos = this.units.renderPos;
    const picked: number[] = [];
    let best = -1;
    let bestD = CLICK_PICK_PX * CLICK_PICK_PX;
    for (let i = 0; i < this.units.count; i++) {
      this.v.set(pos[3 * i], pos[3 * i + 1] + 0.5, pos[3 * i + 2]).project(this.camera);
      if (this.v.z < -1 || this.v.z > 1) continue;
      const sx = rect.left + (this.v.x * 0.5 + 0.5) * rect.width;
      const sy = rect.top + (-this.v.y * 0.5 + 0.5) * rect.height;
      if (isClick) {
        const d = (sx - x1) * (sx - x1) + (sy - y1) * (sy - y1);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      } else if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) {
        picked.push(i);
      }
    }
    if (isClick && best >= 0) picked.push(best);
    this.units.setSelected(picked, additive);
  }

  private orderMove(clientX: number, clientY: number): void {
    if (this.units.selectedCount === 0) return;
    const rect = this.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.ray.setFromCamera(ndc, this.camera);
    const p = this.terrain.raycast(this.ray.ray.origin, this.ray.ray.direction, this.hit);
    if (!p) return;
    // Float -> fixed happens here, once, at the sim boundary. The command carries integers.
    this.send({ type: CMD_MOVE, units: this.units.selectedIds(), x: fx(p.x), y: fx(p.z) });
    this.marker.position.set(p.x, p.y + 0.15, p.z);
    this.marker.visible = true;
    this.markerAge = 0;
  }
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}
