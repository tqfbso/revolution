import * as THREE from 'three/webgpu';
import { attribute, mix, vec3 } from 'three/tsl';
import { KIND_TANK } from '../sim/units';
import { EV_DEATH, EV_SHOT, MAX_UNITS, STATE_ALIVE, STATE_FREE, TICK_MS } from '../sim/world';
import {
  INFO_KIND_SHIFT,
  INFO_STATE_MASK,
  INFO_TEAM_SHIFT,
  NO_AIM,
  type Snapshot,
} from '../worker/protocol';
import { Batch } from './batch';
import type { Effects } from './effects';
import type { Fog } from './fog';
import {
  MUZZLE_Y,
  MUZZLE_Z,
  SQUAD_OFFSETS,
  SQUAD_SIZE,
  TURRET_Y,
  TURRET_Z,
  buildInfantry,
  buildTank,
} from './models';
import type { Terrain } from './terrain';

// Marking colours (linear RGB): red, blue, gold. Hulls stay in service paint.
const TEAM_RGB = [
  [0.52, 0.045, 0.03],
  [0.03, 0.15, 0.62],
  [0.62, 0.36, 0.02],
];
const HULL_TURN = 2.6; // rad/s, visual only
const TURRET_TURN = 3.2;
const SOLDIER_TURN = 9;
const CULL_RADIUS = 4;
const WRECK_SMOKE_SECONDS = 50;
const LOD_HIDDEN = 3;

export interface LodStats {
  /** Units drawn at each level of detail this frame, and units culled as off-screen. */
  lod: [number, number, number];
  culled: number;
}

/**
 * Draws every unit with a handful of instanced draw calls. Each frame, per unit: interpolate
 * between the last two 20 Hz snapshots, cull against the view frustum, pick a level of
 * detail by distance, and write the instance into that level's batch.
 */
export class UnitView {
  readonly group = new THREE.Group();
  readonly rings: THREE.InstancedMesh;
  count = 0;
  /** Interpolated render positions (x, y, z per unit), reused by selection picking. */
  readonly renderPos = new Float32Array(MAX_UNITS * 3);
  readonly selected = new Uint8Array(MAX_UNITS);
  selectedCount = 0;
  /** Latest per-unit state/kind/team bits from the sim (see INFO_* in the protocol). */
  readonly info = new Uint8Array(MAX_UNITS);
  readonly stats: LodStats = { lod: [0, 0, 0], culled: 0 };
  /** Distances (world units) at which units drop to LOD 1 and LOD 2. */
  lodNear = 120;
  lodFar = 340;

  private prev = new Float32Array(MAX_UNITS * 2);
  private curr = new Float32Array(MAX_UNITS * 2);
  private readonly hp = new Uint8Array(MAX_UNITS);
  private readonly aim = new Uint16Array(MAX_UNITS).fill(NO_AIM);
  private readonly heading = new Float32Array(MAX_UNITS);
  private readonly headingGoal = new Float32Array(MAX_UNITS);
  private readonly turret = new Float32Array(MAX_UNITS);
  private readonly moving = new Uint8Array(MAX_UNITS);
  /** Seconds (client clock) of the last shot and of death, for recoil and wreck smoke. */
  private readonly shotAt = new Float32Array(MAX_UNITS).fill(-1e9);
  private readonly diedAt = new Float32Array(MAX_UNITS).fill(-1e9);
  private snapshotTime = 0;
  private fogAge = 0;
  /** Bumped each time a slot gets a new occupant, so stale references can be told apart. */
  readonly gen = new Uint16Array(MAX_UNITS);
  /** The army the player commands and sees through. */
  playerTeam = 0;
  /** Level of detail each unit was last drawn at; LOD_HIDDEN when off-screen. */
  private readonly lodOf = new Uint8Array(MAX_UNITS).fill(LOD_HIDDEN);

  private readonly hull: Batch[];
  private readonly turretBatch: Batch[];
  private readonly tankFar: Batch;
  private readonly soldier: Batch[];
  private readonly squadFar: Batch;
  private readonly frustum = new THREE.Frustum();
  private readonly projScreen = new THREE.Matrix4();

  constructor(
    private readonly terrain: Terrain,
    private readonly effects: Effects,
    private readonly fog: Fog,
    shadows: boolean,
  ) {
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.82, metalness: 0.08 });
    const tint = attribute('aTint', 'vec4');
    const painted = mix(attribute('color', 'vec3'), tint.xyz, attribute('teamMask', 'float'));
    // tint.w is "burn": 1 turns the model into a scorched wreck.
    material.colorNode = mix(painted, vec3(0.022, 0.02, 0.019), tint.w);

    const tank = buildTank();
    const infantry = buildInfantry();
    const batch = (g: THREE.BufferGeometry, cap: number, lod: number) => {
      const b = new Batch(g, material, cap);
      // Far LOD is a few pixels: no shadow work for it.
      b.mesh.castShadow = shadows && lod < 2;
      b.mesh.receiveShadow = shadows && lod === 0;
      this.group.add(b.mesh);
      return b;
    };
    this.hull = tank.hull.map((g, lod) => batch(g, MAX_UNITS, lod));
    this.turretBatch = tank.turret.map((g, lod) => batch(g, MAX_UNITS, lod));
    this.tankFar = batch(tank.far, MAX_UNITS, 2);
    this.soldier = infantry.soldier.map((g, lod) => batch(g, MAX_UNITS * SQUAD_SIZE, lod));
    this.squadFar = batch(infantry.far, MAX_UNITS, 2);

    const ringGeometry = new THREE.RingGeometry(1.5, 1.72, 24).rotateX(-Math.PI / 2);
    const ringMaterial = new THREE.MeshBasicNodeMaterial({ color: 0x7dff8a, transparent: true });
    ringMaterial.opacity = 0.9;
    ringMaterial.depthWrite = false;
    this.rings = new THREE.InstancedMesh(ringGeometry, ringMaterial, MAX_UNITS);
    this.rings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.rings.frustumCulled = false;
    this.rings.count = 0;
    this.group.add(this.rings);
  }

  applySnapshot(s: Snapshot, now: number): void {
    const n = s.count;
    const before = this.count;
    const swap = this.prev;
    this.prev = this.curr;
    this.curr = swap;
    this.curr.set(s.positions);
    if (n < before) {
      // World was reset.
      this.selected.fill(0);
      this.selectedCount = 0;
      this.info.fill(0);
      this.diedAt.fill(-1e9);
      this.fog.reset();
    }
    const curr = this.curr;
    const prev = this.prev;
    for (let i = 0; i < n; i++) {
      const alive = (s.info[i] & INFO_STATE_MASK) === STATE_ALIVE;
      const wasAlive = (this.info[i] & INFO_STATE_MASK) === STATE_ALIVE;
      if (!alive) {
        if (this.selected[i]) {
          this.selected[i] = 0;
          this.selectedCount--;
        }
        prev[2 * i] = curr[2 * i];
        prev[2 * i + 1] = curr[2 * i + 1];
        this.moving[i] = 0;
        continue;
      }
      if (!wasAlive) {
        // New unit (or a reused slot): do not interpolate from wherever the slot was before.
        this.gen[i]++;
        prev[2 * i] = curr[2 * i];
        prev[2 * i + 1] = curr[2 * i + 1];
        // Face the enemy side of the map until it moves.
        const h = s.info[i] >> INFO_TEAM_SHIFT === 0 ? Math.PI / 2 : -Math.PI / 2;
        this.heading[i] = this.headingGoal[i] = this.turret[i] = h + ((i * 0.618) % 0.3) - 0.15;
        this.shotAt[i] = -1e9;
      }
      const dx = curr[2 * i] - prev[2 * i];
      const dz = curr[2 * i + 1] - prev[2 * i + 1];
      const d2 = dx * dx + dz * dz;
      // Only turn when really moving, so separation nudges do not make idle units twitch.
      this.moving[i] = d2 > 0.012 ? 1 : 0;
      if (this.moving[i]) this.headingGoal[i] = Math.atan2(dx, dz);
    }
    this.info.set(s.info);
    this.hp.set(s.hp);
    this.aim.set(s.aim);
    this.count = n;
    this.snapshotTime = now;
    // Sight is refreshed every other tick (10 Hz): plenty for units that move this slowly.
    if (this.fogAge++ % 2 === 0) this.fog.update(this.curr, n, (id) => this.isMine(id));
    this.playEvents(s.events, now / 1000);
  }

  private playEvents(ev: Int32Array, seconds: number): void {
    const pos = this.renderPos;
    const fx = this.effects;
    for (let e = 0; e < ev.length; e += 3) {
      const a = ev[e + 1];
      const b = ev[e + 2];
      const isTank = (this.info[a] >> INFO_KIND_SHIFT) & 3 ? false : true;
      // Effects nobody can see are the main cost of a big battle: skip them when both ends
      // are off-screen and thin them when both are far away.
      const near = Math.min(this.lodOf[a], ev[e] === EV_SHOT ? this.lodOf[b] : LOD_HIDDEN);
      fx.thin = near >= 2 ? 1 : 0;
      const ax = pos[3 * a];
      const ay = pos[3 * a + 1];
      const az = pos[3 * a + 2];
      if (ev[e] === EV_SHOT) {
        this.shotAt[a] = seconds;
        if (near === LOD_HIDDEN) continue;
        const bx = pos[3 * b];
        const bz = pos[3 * b + 2];
        const targetTank = ((this.info[b] >> INFO_KIND_SHIFT) & 3) === KIND_TANK;
        const by = pos[3 * b + 1] + (targetTank ? 0.7 : 0.35);
        if (isTank) {
          // The shot leaves along the turret, which is already laid on the target.
          const d = Math.hypot(bx - ax, bz - az) || 1;
          const ux = (bx - ax) / d;
          const uz = (bz - az) / d;
          this.turret[a] = Math.atan2(ux, uz);
          fx.cannonShot(
            ax + ux * MUZZLE_Z,
            ay + TURRET_Y + MUZZLE_Y,
            az + uz * MUZZLE_Z,
            bx,
            by,
            bz,
          );
        } else {
          fx.rifleBurst(ax, ay + 0.42, az, bx, by, bz);
        }
      } else if (ev[e] === EV_DEATH) {
        this.diedAt[a] = seconds;
        if (isTank) fx.explosion(ax, ay, az);
        else fx.squadHit(ax, ay, az);
      }
    }
    fx.thin = 0;
  }

  teamOf(id: number): number {
    return this.info[id] >> INFO_TEAM_SHIFT;
  }

  kindOf(id: number): number {
    return (this.info[id] >> INFO_KIND_SHIFT) & 3;
  }

  /** A living unit of the player's army. */
  isMine(id: number): boolean {
    return this.isAlive(id) && this.teamOf(id) === this.playerTeam;
  }

  /** Centre of the living units among `ids` (render x, z), or null if none are left. */
  centreOf(ids: readonly number[]): { x: number; z: number } | null {
    let x = 0;
    let z = 0;
    let n = 0;
    for (const id of ids) {
      if (!this.isAlive(id)) continue;
      x += this.renderPos[3 * id];
      z += this.renderPos[3 * id + 2];
      n++;
    }
    return n ? { x: x / n, z: z / n } : null;
  }

  isAlive(id: number): boolean {
    return id < this.count && (this.info[id] & INFO_STATE_MASK) === STATE_ALIVE;
  }

  setSelected(ids: Iterable<number>, additive: boolean): void {
    if (!additive) this.selected.fill(0);
    for (const id of ids) if (this.isAlive(id)) this.selected[id] = 1;
    let c = 0;
    for (let i = 0; i < this.count; i++) c += this.selected[i];
    this.selectedCount = c;
  }

  selectedIds(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.count; i++) if (this.selected[i]) out.push(i);
    return out;
  }

  update(now: number, dt: number, camera: THREE.PerspectiveCamera): void {
    const n = this.count;
    const seconds = now / 1000;
    const alpha = Math.min(Math.max((now - this.snapshotTime) / TICK_MS, 0), 1);
    const pos = this.renderPos;
    const prev = this.prev;
    const curr = this.curr;
    const info = this.info;
    const fx = this.effects;

    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);
    const planes = this.frustum.planes;
    const cam = camera.position;
    const near2 = this.lodNear * this.lodNear;
    const far2 = this.lodFar * this.lodFar;

    const batches = [
      ...this.hull,
      ...this.turretBatch,
      this.tankFar,
      ...this.soldier,
      this.squadFar,
    ];
    for (const b of batches) b.n = 0;
    const lodCount = this.stats.lod;
    lodCount[0] = lodCount[1] = lodCount[2] = 0;
    let culled = 0;
    let ringCount = 0;
    const r = this.rings.instanceMatrix.array as Float32Array;

    for (let i = 0; i < n; i++) {
      const state = info[i] & INFO_STATE_MASK;
      if (state === STATE_FREE) continue;
      const isTank = ((info[i] >> INFO_KIND_SHIFT) & 3) === KIND_TANK;
      const alive = state === STATE_ALIVE;
      if (!alive && !isTank) continue; // fallen squads leave no wreck

      const x = prev[2 * i] + (curr[2 * i] - prev[2 * i]) * alpha;
      const z = prev[2 * i + 1] + (curr[2 * i + 1] - prev[2 * i + 1]) * alpha;
      const y = this.terrain.heightAt(x, z);
      pos[3 * i] = x;
      pos[3 * i + 1] = y;
      pos[3 * i + 2] = z;
      // Fog of war: enemies show only where the player can see, wrecks where they have been.
      if (info[i] >> INFO_TEAM_SHIFT !== this.playerTeam || !alive) {
        if (alive ? !this.fog.sees(x, z) : !this.fog.hasExplored(x, z)) {
          this.lodOf[i] = LOD_HIDDEN;
          continue;
        }
      }

      const target = this.aim[i];
      let aimAngle = NaN;
      if (alive) {
        this.heading[i] = turn(
          this.heading[i],
          this.headingGoal[i],
          (isTank ? HULL_TURN : SOLDIER_TURN) * dt,
        );
        if (target !== NO_AIM && target < n) {
          aimAngle = Math.atan2(pos[3 * target] - x, pos[3 * target + 2] - z);
        }
        if (isTank) {
          this.turret[i] = turn(
            this.turret[i],
            Number.isNaN(aimAngle) ? this.heading[i] : aimAngle,
            TURRET_TURN * dt,
          );
        }
      }

      let visible = true;
      for (let p = 0; p < 6; p++) {
        const pl = planes[p];
        if (pl.normal.x * x + pl.normal.y * y + pl.normal.z * z + pl.constant < -CULL_RADIUS) {
          visible = false;
          break;
        }
      }
      if (!visible) {
        culled++;
        this.lodOf[i] = LOD_HIDDEN;
        continue;
      }
      const dx = x - cam.x;
      const dy = y - cam.y;
      const dz = z - cam.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      const lod = d2 < near2 ? 0 : d2 < far2 ? 1 : 2;
      lodCount[lod]++;
      this.lodOf[i] = lod;

      const team = TEAM_RGB[info[i] >> INFO_TEAM_SHIFT] ?? TEAM_RGB[0];
      const h = this.heading[i];
      const sin = Math.sin(h);
      const cos = Math.cos(h);

      if (isTank) {
        const burn = alive ? 0 : 1;
        if (lod === 2) {
          this.tankFar.put(x, y, z, sin, cos, 1, team[0], team[1], team[2], burn);
        } else {
          this.hull[lod].put(x, y, z, sin, cos, 1, team[0], team[1], team[2], burn);
          // Wrecks keep the turret where it died, knocked slightly askew.
          const th = this.turret[i] + (alive ? 0 : 0.5);
          const ts = Math.sin(th);
          const tc = Math.cos(th);
          // Recoil: the turret kicks back along the gun and recovers.
          const since = seconds - this.shotAt[i];
          const kick = since < 0.35 ? 0.16 * (1 - since / 0.35) ** 2 : 0;
          const px = x + sin * TURRET_Z - ts * kick;
          const pz = z + cos * TURRET_Z - tc * kick;
          this.turretBatch[lod].put(
            px,
            y + TURRET_Y,
            pz,
            ts,
            tc,
            1,
            team[0],
            team[1],
            team[2],
            burn,
          );
        }
        if (!alive && lod < 2) {
          const age = seconds - this.diedAt[i];
          if (age < WRECK_SMOKE_SECONDS && Math.random() < dt * 3) {
            fx.wreckSmoke(x, y, z, Math.max(0, 1 - age / 12));
          }
        }
      } else if (lod === 2) {
        this.squadFar.put(x, y, z, sin, cos, 1, team[0], team[1], team[2], 0);
      } else {
        // Soldiers drop out of the squad as it loses health.
        const men = Math.ceil((this.hp[i] * SQUAD_SIZE) / 255);
        const face = Number.isNaN(aimAngle) ? h : aimAngle;
        const fs = Math.sin(face);
        const fc = Math.cos(face);
        const batch = this.soldier[lod];
        const walking = this.moving[i] === 1;
        for (let k = 0; k < men; k++) {
          const ox = SQUAD_OFFSETS[k][0];
          const oz = SQUAD_OFFSETS[k][1];
          const sx = x + ox * cos + oz * sin;
          const sz = z - ox * sin + oz * cos;
          const bob = walking ? Math.abs(Math.sin(seconds * 9 + i + k * 1.7)) * 0.035 : 0;
          batch.put(
            sx,
            this.terrain.heightAt(sx, sz) + bob,
            sz,
            fs,
            fc,
            1,
            team[0],
            team[1],
            team[2],
            0,
          );
        }
      }

      if (this.selected[i]) {
        const q = ringCount++ * 16;
        r.fill(0, q, q + 16);
        r[q] = r[q + 5] = r[q + 10] = r[q + 15] = 1;
        r[q + 12] = x;
        r[q + 13] = y + 0.12;
        r[q + 14] = z;
      }
    }
    this.stats.culled = culled;
    for (const b of batches) b.flush();
    this.rings.count = ringCount;
    if (ringCount > 0) {
      const attr = this.rings.instanceMatrix;
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, ringCount * 16);
      attr.needsUpdate = true;
    }
  }
}

/** Rotate `from` toward `to` along the shortest arc by at most `max` radians. */
function turn(from: number, to: number, max: number): number {
  let d = to - from;
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  const h = from + (d > max ? max : d < -max ? -max : d);
  return h > Math.PI ? h - Math.PI * 2 : h < -Math.PI ? h + Math.PI * 2 : h;
}
