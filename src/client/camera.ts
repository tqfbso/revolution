import * as THREE from 'three/webgpu';
import { MAP_SIZE } from '../sim/world';
import type { Terrain } from './terrain';

const MIN_DIST = 14;
const MAX_DIST = 900;
const PITCH = THREE.MathUtils.degToRad(52);
const EDGE_PX = 6;

/** Classic RTS camera: looks at a point on the ground, pans, zooms and rotates around it. */
export class RtsCamera {
  readonly camera = new THREE.PerspectiveCamera(40, 1, 1, 4000);
  private goal = { x: MAP_SIZE / 2, z: MAP_SIZE / 2 + 8, dist: 260, yaw: 0 };
  private cur = { ...this.goal };
  private keys = new Set<string>();
  private mouse = { x: 0, y: 0, inside: false };
  private rotating = false;

  constructor(
    dom: HTMLElement,
    private readonly terrain: Terrain,
  ) {
    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouse.inside = false;
    });
    document.addEventListener('mouseleave', () => (this.mouse.inside = false));
    window.addEventListener('pointermove', (e) => {
      this.mouse.inside = true;
      if (this.rotating) this.goal.yaw -= (e.clientX - this.mouse.x) * 0.006;
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
    });
    dom.addEventListener('pointerdown', (e) => {
      if (e.button === 1) {
        this.rotating = true;
        e.preventDefault();
      }
    });
    window.addEventListener('pointerup', (e) => {
      if (e.button === 1) this.rotating = false;
    });
    dom.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const delta = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
        this.goal.dist = THREE.MathUtils.clamp(
          this.goal.dist * Math.exp(delta * 0.0012),
          MIN_DIST,
          MAX_DIST,
        );
      },
      { passive: false },
    );
  }

  /** Jump straight to a view (used by tests and, later, the minimap). */
  look(x: number, z: number, dist: number, yaw = 0): void {
    this.goal = { x, z, dist: THREE.MathUtils.clamp(dist, MIN_DIST, MAX_DIST), yaw };
    this.cur = { ...this.goal };
  }

  /** Glide to look at a ground point, keeping zoom and rotation. */
  moveTo(x: number, z: number): void {
    this.goal.x = x;
    this.goal.z = z;
  }

  /** The ground point the camera looks at, and how far it is from it. */
  readonly focus = new THREE.Vector3();
  get distance(): number {
    return this.cur.dist;
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  update(dt: number): void {
    const k = this.keys;
    let right = 0;
    let forward = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) forward += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) forward -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) right += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) right -= 1;
    if (this.mouse.inside && !this.rotating && document.hasFocus()) {
      if (this.mouse.x <= EDGE_PX) right -= 1;
      if (this.mouse.x >= window.innerWidth - EDGE_PX) right += 1;
      if (this.mouse.y <= EDGE_PX) forward += 1;
      if (this.mouse.y >= window.innerHeight - EDGE_PX) forward -= 1;
    }
    if (k.has('KeyQ')) this.goal.yaw += 1.6 * dt;
    if (k.has('KeyE')) this.goal.yaw -= 1.6 * dt;

    const g = this.goal;
    if (right !== 0 || forward !== 0) {
      const speed = g.dist * 1.1 * dt;
      const sin = Math.sin(g.yaw);
      const cos = Math.cos(g.yaw);
      g.x += (right * cos - forward * sin) * speed;
      g.z += (-right * sin - forward * cos) * speed;
    }
    g.x = THREE.MathUtils.clamp(g.x, 0, MAP_SIZE);
    g.z = THREE.MathUtils.clamp(g.z, 0, MAP_SIZE);

    // Exponential smoothing: frame-rate independent, no overshoot.
    const a = 1 - Math.exp(-14 * dt);
    const c = this.cur;
    c.x += (g.x - c.x) * a;
    c.z += (g.z - c.z) * a;
    c.dist += (g.dist - c.dist) * a;
    c.yaw += (g.yaw - c.yaw) * a;

    const groundY = this.terrain.heightAt(c.x, c.z);
    const horizontal = Math.cos(PITCH) * c.dist;
    this.camera.position.set(
      c.x + Math.sin(c.yaw) * horizontal,
      groundY + Math.sin(PITCH) * c.dist,
      c.z + Math.cos(c.yaw) * horizontal,
    );
    this.focus.set(c.x, groundY, c.z);
    this.camera.lookAt(c.x, groundY, c.z);
    this.camera.updateMatrixWorld();
  }
}
