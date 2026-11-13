import * as THREE from 'three/webgpu';
import { attribute, mix, vec3 } from 'three/tsl';
import {
  AIR_HEIGHT,
  KINDS,
  KIND_AD,
  KIND_ARTILLERY,
  KIND_ATGM,
  KIND_COUNT,
  KIND_DRONE,
  KIND_EW,
  KIND_IFV,
  KIND_INFANTRY,
  KIND_RECON,
  KIND_STRIKE,
  KIND_TANK,
  KIND_TRUCK,
  SMOKE_CELLS,
} from '../sim/units';
import { CLASS_AIR } from '../sim/map';
import {
  EV_BREACH,
  EV_COLLAPSE,
  EV_DEATH,
  EV_GUTTED,
  EV_IMPACT,
  EV_SMOKE,
  EV_LAUNCH,
  EV_SHOT,
  EV_SIEGE,
  EV_UNLOAD,
  EV_WALL,
  MAX_UNITS,
  STATE_ALIVE,
  STATE_FREE,
  TICK_MS,
  unpackX,
  unpackY,
} from '../sim/world';
import {
  INFO_CARRIED,
  INFO_INSIDE,
  INFO_REVEALED,
  INFO_SPOTTED,
  INFO_STATE_MASK,
  INFO_TEAM_MASK,
  INFO_TEAM_SHIFT,
  NO_AIM,
  type Snapshot,
} from '../worker/protocol';
import { Batch } from './batch';
import { Soldiers } from './soldiers';
import type { Effects } from './effects';
import type { Fog } from './fog';
import { ICON_FROM, ICON_FULL, Icons } from './icons';
import type { Look } from './look';
import { fieldPaint } from './surface';
import {
  SQUAD_OFFSETS,
  TEAM_OFFSETS,
  buildAirDefence,
  buildArtillery,
  buildIfv,
  buildJammer,
  buildTruck,
  buildReconDrone,
  buildStrikeDrone,
  buildInfantry,
  buildLauncher,
  buildTank,
  type VehicleModel,
} from './models';
import type { StructureView } from './structures';
import type { Scars } from './scars';
import {
  SND_AUTOCANNON,
  SND_CANNON,
  SND_COLLAPSE,
  SND_EXPLOSION,
  SND_HOWITZER,
  SND_IMPACT,
  SND_MISSILE,
  SND_RIFLE,
  type Sound,
} from './sound';
import type { Terrain } from './terrain';

// Marking colours (linear RGB): red, blue, gold. Hulls stay in service paint.
export const TEAM_RGB = [
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
/** What the men of a foot unit do when it halts. */
const DRILL_SQUAD = 0;
const DRILL_CREW = 1;
const DRILL_SCOUT = 2;
/** Paint patterns to go round, and the room left under 1 for the burn (see the material). */
const SEEDS = 16;
const BURN_SCALE = 0.97;
/** Keeps the packed value clear of a whole number, where rounding would flip the seed. */
const BURN_BASE = 0.01;

/** How a vehicle type is drawn: hull and turret batches per level of detail. */
interface VehicleDraw {
  model: VehicleModel;
  hull: Batch[];
  turret: Batch[];
  far: Batch;
}
/** How a foot unit is drawn: figures (men, a launcher) around the unit's centre. */
interface SquadDraw {
  /** `batch` is a fixed model (the launcher); without one the figure is a soldier. */
  figures: { batch?: Batch[]; x: number; z: number }[];
  /** What the men do when halted: see DRILL_*. */
  drill: number;
  far: Batch;
}
/** Kinds with a hull whose direction comes from the sim. */
const IS_VEHICLE = KINDS.map((k) => k.turn > 0);
const IS_AIR = KINDS.map((k) => k.cls === CLASS_AIR);
const ALTITUDE = AIR_HEIGHT / 1024;
/**
 * How far each type lifts the fog, in cells: its sight in the sim plus a little, negative
 * for drones, which look straight down past houses and hills.
 */
const FOG_SIGHT = KINDS.map(
  (k) => (Math.ceil(k.sight / 4096) + 1) * (k.cls === CLASS_AIR ? -1 : 1),
);
const JAM_RADIUS = KINDS.map((k) => k.jam / 1024);

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
  /**
   * Full-detail units drawn at most this many (the nearest distance shrinks until it is so,
   * and grows back when there is room): looking down into a battle from close by must not
   * mean thousands of soldiers modelled in full. Set from the graphics level.
   */
  nearBudget = 300;
  private nearScale = 1;

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
  /** Per foot unit, eased 0 to 1: how settled it is at the halt, and how much in a fight. */
  private readonly halted = new Float32Array(MAX_UNITS);
  private readonly fight = new Float32Array(MAX_UNITS);
  private readonly soldiers: Soldiers;
  /** For tuning and screenshots: force every foot unit to [halted, fight, seconds since a shot]. */
  pose: [number, number, number] | null = null;
  private readonly diedAt = new Float32Array(MAX_UNITS).fill(-1e9);
  private snapshotTime = 0;
  private fogAge = 0;
  /** Bumped each time a slot gets a new occupant, so stale references can be told apart. */
  readonly gen = new Uint16Array(MAX_UNITS);
  /** The army the player commands and sees through. */
  playerTeam = 0;
  /** Level of detail each unit was last drawn at; LOD_HIDDEN when off-screen. */
  private readonly lodOf = new Uint8Array(MAX_UNITS).fill(LOD_HIDDEN);

  /** Latest per-unit type, hull heading and passengers from the sim. */
  readonly kind = new Uint8Array(MAX_UNITS);
  readonly load = new Uint8Array(MAX_UNITS);
  /** Per unit: job | stance, see TASK_* in the protocol. */
  readonly task = new Uint8Array(MAX_UNITS);
  private readonly vehicles: (VehicleDraw | null)[] = new Array(KIND_COUNT).fill(null);
  private readonly squads: (SquadDraw | null)[] = new Array(KIND_COUNT).fill(null);
  private readonly batches: Batch[] = [];
  private readonly jamRings: Batch;
  private readonly icons = new Icons(MAX_UNITS);
  /** How far the camera is from what it looks at: decides when the map symbols show. */
  zoom = 0;
  private readonly camRight = new THREE.Vector3();
  private readonly camUp = new THREE.Vector3();
  private readonly frustum = new THREE.Frustum();
  private readonly projScreen = new THREE.Matrix4();

  constructor(
    private readonly terrain: Terrain,
    private readonly effects: Effects,
    private readonly fog: Fog,
    look: Look,
    private readonly structures: StructureView,
    private readonly scars: Scars,
  ) {
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.82, metalness: 0.08 });
    const tint = attribute('aTint', 'vec4');
    const marking = attribute('teamMask', 'float');
    const painted = mix(attribute('color', 'vec3'), tint.xyz, marking);
    // tint.w carries two things: its whole part is a number per unit (see SEEDS), its
    // fraction is "burn", where 1 turns the model into a scorched wreck.
    const burn = tint.w.fract().sub(BURN_BASE).div(BURN_SCALE).clamp(0, 1);
    if (look.rich) {
      const paint = fieldPaint(look, painted, marking, tint.w.floor(), burn);
      material.colorNode = paint.colour.mul(fog.cloud());
      material.roughnessNode = paint.roughness;
      material.metalnessNode = paint.metalness;
    } else material.colorNode = mix(painted, vec3(0.022, 0.02, 0.019), burn);

    const shadows = look.shadows;
    this.nearBudget = look.quality === 'low' ? 120 : look.quality === 'high' ? 500 : 300;
    const batch = (g: THREE.BufferGeometry, cap: number, lod: number, men = false) => {
      const b = new Batch(g, material, cap);
      // Far LOD is a few pixels: no shadow work for it. Soldiers are five meshes a squad, so
      // only the nearest cast any; a vehicle keeps its shadow one level further out.
      b.mesh.castShadow = shadows && lod < (men ? 1 : 2);
      b.mesh.receiveShadow = shadows && lod === 0;
      this.group.add(b.mesh);
      this.batches.push(b);
      return b;
    };
    const vehicle = (model: VehicleModel, cap: number): VehicleDraw => ({
      model,
      hull: model.hull.map((g, lod) => batch(g, cap, lod)),
      turret: model.turret.map((g, lod) => batch(g, cap, lod)),
      far: batch(model.far, cap, 2),
    });
    this.vehicles[KIND_TANK] = vehicle(buildTank(), MAX_UNITS);
    this.vehicles[KIND_IFV] = vehicle(buildIfv(), MAX_UNITS >> 1);
    this.vehicles[KIND_ARTILLERY] = vehicle(buildArtillery(), MAX_UNITS >> 2);
    this.vehicles[KIND_AD] = vehicle(buildAirDefence(), MAX_UNITS >> 3);
    this.vehicles[KIND_EW] = vehicle(buildJammer(), MAX_UNITS >> 3);
    this.vehicles[KIND_TRUCK] = vehicle(buildTruck(), MAX_UNITS >> 4);
    this.vehicles[KIND_DRONE] = vehicle(buildReconDrone(), MAX_UNITS >> 2);
    this.vehicles[KIND_STRIKE] = vehicle(buildStrikeDrone(), MAX_UNITS >> 1);
    const infantry = buildInfantry();
    this.soldiers = new Soldiers((g, cap, lod) => batch(g, cap, lod, true));
    this.squads[KIND_INFANTRY] = {
      figures: SQUAD_OFFSETS.map(([x, z]) => ({ x, z })),
      drill: DRILL_SQUAD,
      far: batch(infantry.far, MAX_UNITS, 2),
    };
    const team = buildLauncher();
    const launcher = [0, 1].map((lod) => batch(team.launcher.clone(), MAX_UNITS >> 2, lod, true));
    this.squads[KIND_ATGM] = {
      figures: [{ batch: launcher, x: 0, z: 0.25 }, ...TEAM_OFFSETS.map(([x, z]) => ({ x, z }))],
      drill: DRILL_CREW,
      far: batch(team.far, MAX_UNITS >> 2, 2),
    };
    // A recon team is two men: fewer, and that is how you tell it from a rifle squad.
    const pair: [number, number][] = [
      [-0.3, 0.1],
      [0.35, -0.2],
    ];
    this.squads[KIND_RECON] = {
      figures: pair.map(([x, z]) => ({ x, z })),
      drill: DRILL_SCOUT,
      far: batch(
        new THREE.BoxGeometry(0.9, 0.5, 0.5).translate(0, 0.25, 0).deleteAttribute('uv'),
        MAX_UNITS >> 3,
        2,
      ),
    };

    // The jammer's bubble, drawn on the ground: yours in amber, the enemy's in red.
    const jamMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true });
    const jamTint = attribute('aTint', 'vec4');
    jamMaterial.colorNode = jamTint.xyz;
    jamMaterial.opacityNode = jamTint.w;
    jamMaterial.depthWrite = false;
    jamMaterial.depthTest = false;
    jamMaterial.fog = false;
    this.jamRings = new Batch(
      new THREE.RingGeometry(0.985, 1, 128).rotateX(-Math.PI / 2),
      jamMaterial,
      512,
    );
    this.jamRings.mesh.renderOrder = 3;
    this.group.add(this.jamRings.mesh);

    this.group.add(this.icons.batch.mesh);

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
      this.smokes.length = 0;
      this.scars.clear();
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
        const h =
          ((s.info[i] >> INFO_TEAM_SHIFT) & INFO_TEAM_MASK) === 0 ? Math.PI / 2 : -Math.PI / 2;
        this.heading[i] = this.headingGoal[i] = this.turret[i] = h + ((i * 0.618) % 0.3) - 0.15;
        this.shotAt[i] = -1e9;
      }
      const dx = curr[2 * i] - prev[2 * i];
      const dz = curr[2 * i + 1] - prev[2 * i + 1];
      const d2 = dx * dx + dz * dz;
      // Only turn when really moving, so separation nudges do not make idle units twitch.
      this.moving[i] = d2 > 0.012 ? 1 : 0;
      if (IS_VEHICLE[s.kind[i]]) {
        // Hulls point where the sim says: that is the armour the enemy is shooting at.
        const h = (s.heading[i] * Math.PI) / 128;
        this.headingGoal[i] = h > Math.PI ? h - 2 * Math.PI : h;
        if (!wasAlive) this.heading[i] = this.turret[i] = this.headingGoal[i];
      } else if (this.moving[i]) this.headingGoal[i] = Math.atan2(dx, dz);
    }
    this.info.set(s.info);
    this.kind.set(s.kind);
    this.load.set(s.load);
    this.task.set(s.task);
    this.hp.set(s.hp);
    this.aim.set(s.aim);
    this.count = n;
    this.snapshotTime = now;
    // Sight is refreshed every other tick (10 Hz): plenty for units that move this slowly.
    if (this.fogAge++ % 2 === 0) {
      this.fog.clock = now / 1000;
      this.fog.update(
        this.curr,
        n,
        (id) => this.isMine(id),
        // A jammed drone sends nothing back.
        (id) => (IS_AIR[this.kind[id]] && this.load[id] > 0 ? 0 : FOG_SIGHT[this.kind[id]]),
      );
    }
    // Vehicles wear the ground they drive over (where the player can see it happen): a
    // column's route turns to mud. Five times a second is plenty at these speeds.
    if (this.fogAge % 4 === 0) {
      for (let i = 0; i < n; i++) {
        const k = this.kind[i];
        if (this.moving[i] === 0 || !IS_VEHICLE[k] || IS_AIR[k]) continue;
        const x = curr[2 * i];
        const z = curr[2 * i + 1];
        if (this.teamOf(i) !== this.playerTeam && !this.fog.sees(x, z)) continue;
        this.terrain.stamp(x, z, 1.2, 3, 190);
      }
    }
    this.playEvents(s.events, now / 1000);
    this.sound?.flush();
  }

  /** Set by the game once there is sound; without it the battle is silent. */
  sound: Sound | null = null;

  /** The noise unit `a` makes when it fires. */
  private report(a: number): void {
    const sound = this.sound;
    if (sound === null) return;
    const kind = this.kind[a];
    const x = this.renderPos[3 * a];
    const z = this.renderPos[3 * a + 2];
    const snd =
      kind === KIND_ATGM || kind === KIND_STRIKE
        ? SND_MISSILE
        : kind === KIND_IFV || kind === KIND_AD
          ? SND_AUTOCANNON
          : this.vehicles[kind]
            ? SND_CANNON
            : SND_RIFLE;
    sound.at(snd, x, z, this.fog.sees(x, z));
  }

  /** Smoke screens standing on the field. */
  private smokes: { x: number; y: number; z: number; until: number }[] = [];

  /** Keep the smoke screens billowing until they blow away. */
  private billow(seconds: number, dt: number): void {
    const smokes = this.smokes;
    for (let k = smokes.length - 1; k >= 0; k--) {
      const s = smokes[k];
      if (s.until - 3 < seconds) {
        smokes[k] = smokes[smokes.length - 1];
        smokes.pop();
      } else if (Math.random() < dt * 7) {
        this.effects.thin = 0;
        this.effects.smokeScreen(s.x, s.y, s.z);
      }
    }
  }

  private playEvents(ev: Int32Array, seconds: number): void {
    const pos = this.renderPos;
    const fx = this.effects;
    for (let e = 0; e < ev.length; e += 3) {
      const a = ev[e + 1];
      const b = ev[e + 2];
      if (ev[e] === EV_COLLAPSE) {
        const c = this.structures.centreOf(a);
        const seen = this.fog.sees(c.x, c.z);
        this.sound?.at(SND_COLLAPSE, c.x, c.z, seen);
        if (seen) this.structures.collapse(a);
        continue;
      }
      if (ev[e] === EV_GUTTED || ev[e] === EV_WALL) {
        const c = this.structures.centreOf(a);
        const seen = this.fog.sees(c.x, c.z);
        if (ev[e] === EV_GUTTED) {
          this.sound?.at(SND_COLLAPSE, c.x, c.z, seen);
          if (seen) this.structures.gut(a);
        } else {
          this.sound?.at(SND_IMPACT, c.x, c.z, seen);
          if (seen) this.structures.breach(a, b);
        }
        continue;
      }
      if (ev[e] === EV_UNLOAD) continue;
      if (ev[e] === EV_SMOKE) {
        const x = unpackX(a);
        const z = unpackY(a);
        const until = seconds + b / 20;
        this.fog.addSmoke(x, z, SMOKE_CELLS, until);
        // Shells of one salvo landing together make one cloud, not a white-out.
        const near = this.smokes.find((s) => Math.abs(s.x - x) + Math.abs(s.z - z) < 7);
        if (near) near.until = until;
        else this.smokes.push({ x, y: this.terrain.heightAt(x, z), z, until });
        continue;
      }
      if (ev[e] === EV_IMPACT) {
        // A shell lands. The crater stays whether or not anyone saw it fall.
        const x = unpackX(a);
        const z = unpackY(a);
        this.scars.add(x, z, 1.2 + Math.random() * 0.9, false);
        this.terrain.stamp(x, z, 3.2, 110);
        const seen = this.fog.sees(x, z);
        this.sound?.at(SND_IMPACT, x, z, seen);
        if (seen) fx.shellImpact(x, this.terrain.heightAt(x, z), z);
        continue;
      }
      if (ev[e] === EV_LAUNCH) {
        this.shotAt[a] = seconds;
        this.sound?.at(
          SND_HOWITZER,
          pos[3 * a],
          pos[3 * a + 2],
          this.fog.sees(pos[3 * a], pos[3 * a + 2]),
        );
        if (this.lodOf[a] === LOD_HIDDEN) continue;
        const m = this.vehicles[this.kind[a]]?.model;
        const d = Math.hypot(unpackX(b) - pos[3 * a], unpackY(b) - pos[3 * a + 2]) || 1;
        const ux = (unpackX(b) - pos[3 * a]) / d;
        const uz = (unpackY(b) - pos[3 * a + 2]) / d;
        this.turret[a] = Math.atan2(ux, uz);
        fx.thin = this.lodOf[a] >= 2 ? 1 : 0;
        fx.howitzer(
          pos[3 * a] + ux * (m?.muzzleZ ?? 2),
          pos[3 * a + 1] + (m ? m.turretY + m.muzzleY : 1.5),
          pos[3 * a + 2] + uz * (m?.muzzleZ ?? 2),
          ux,
          uz,
        );
        continue;
      }
      const veh = this.vehicles[this.kind[a]];
      const ax = pos[3 * a];
      const ay = pos[3 * a + 1];
      const az = pos[3 * a + 2];
      if (ev[e] === EV_SIEGE) {
        // Shelling a building or a bridge.
        this.shotAt[a] = seconds;
        this.report(a);
        if (this.lodOf[a] === LOD_HIDDEN) continue;
        const p = this.structures.hit(b);
        fx.thin = this.lodOf[a] >= 2 ? 1 : 0;
        this.shoot(a, ax, ay, az, p.x, p.y, p.z);
        fx.squadHit(p.x, p.y, p.z);
        continue;
      }
      if (ev[e] === EV_BREACH) {
        // Firing at a field work, or laying a charge against it.
        this.shotAt[a] = seconds;
        if (KINDS[this.kind[a]].engineer) this.sound?.at(SND_IMPACT, ax, az, this.fog.sees(ax, az));
        else this.report(a);
        if (this.lodOf[a] === LOD_HIDDEN) continue;
        const px = ((b % 256) + 0.5) * 4;
        const pz = (Math.floor(b / 256) + 0.5) * 4;
        const py = this.terrain.heightAt(px, pz) + 1;
        fx.thin = this.lodOf[a] >= 2 ? 1 : 0;
        if (KINDS[this.kind[a]].engineer) fx.shellImpact(px, py - 0.8, pz);
        else {
          this.shoot(a, ax, ay, az, px, py, pz);
          fx.squadHit(px, py, pz);
        }
        continue;
      }
      if (ev[e] !== EV_SHOT && ev[e] !== EV_DEATH) continue;
      // Effects nobody can see are the main cost of a big battle: skip them when both ends
      // are off-screen and thin them when both are far away.
      const near = Math.min(this.lodOf[a], ev[e] === EV_SHOT ? this.lodOf[b] : LOD_HIDDEN);
      fx.thin = near >= 2 ? 1 : 0;
      if (ev[e] === EV_SHOT) {
        this.shotAt[a] = seconds;
        this.report(a);
        if (near === LOD_HIDDEN) continue;
        const by = pos[3 * b + 1] + (IS_VEHICLE[this.kind[b]] ? 0.7 : 0.35);
        this.shoot(a, ax, ay, az, pos[3 * b], by, pos[3 * b + 2]);
      } else if (ev[e] === EV_DEATH) {
        this.diedAt[a] = seconds;
        const air = IS_AIR[this.kind[a]];
        if (veh && !air) {
          this.scars.add(ax, az, 2.3, true);
          this.terrain.stamp(ax, az, 2.6, 70);
          this.sound?.at(SND_EXPLOSION, ax, az, this.fog.sees(ax, az));
        }
        if (near === LOD_HIDDEN) continue;
        if (veh && !air) fx.explosion(ax, ay, az);
        else fx.squadHit(ax, ay, az);
      }
    }
    fx.thin = 0;
  }

  /** The effect of unit `a` at (ax, ay, az) firing its weapon at a point. */
  private shoot(
    a: number,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
  ): void {
    const fx = this.effects;
    const kind = this.kind[a];
    const veh = this.vehicles[kind];
    if (kind === KIND_STRIKE) {
      // The drone dives into its target.
      fx.missile(ax, ay, az, bx, by, bz);
      return;
    }
    if (!veh) {
      if (kind === KIND_ATGM) fx.missile(ax, ay + 0.45, az, bx, by, bz);
      else fx.rifleBurst(ax, ay + 0.42, az, bx, by, bz);
      return;
    }
    // The shot leaves along the turret, which is laid on the target.
    const d = Math.hypot(bx - ax, bz - az) || 1;
    const ux = (bx - ax) / d;
    const uz = (bz - az) / d;
    this.turret[a] = Math.atan2(ux, uz);
    const m = veh.model;
    const mx = ax + ux * m.muzzleZ;
    const my = ay + m.turretY + m.muzzleY;
    const mz = az + uz * m.muzzleZ;
    if (kind === KIND_IFV || kind === KIND_AD) fx.autocannon(mx, my, mz, bx, by, bz);
    else fx.cannonShot(mx, my, mz, bx, by, bz);
  }

  teamOf(id: number): number {
    return (this.info[id] >> INFO_TEAM_SHIFT) & INFO_TEAM_MASK;
  }

  /** Structure a unit is garrisoned in, or -1. */
  insideOf(id: number): number {
    if ((this.info[id] & INFO_INSIDE) === 0) return -1;
    const map = this.terrain.map;
    const cx = Math.min(255, Math.max(0, this.curr[2 * id] >> 2));
    const cy = Math.min(255, Math.max(0, this.curr[2 * id + 1] >> 2));
    return map.structAt[cy * 256 + cx];
  }

  kindOf(id: number): number {
    return this.kind[id];
  }

  /** A living unit of the player's army. */
  isMine(id: number): boolean {
    return this.isAlive(id) && this.teamOf(id) === this.playerTeam;
  }

  /** A living enemy unit that is drawn this frame (so the player can see it), outside buildings. */
  isTargetable(id: number): boolean {
    return (
      this.isAlive(id) &&
      this.teamOf(id) !== this.playerTeam &&
      (this.info[id] & INFO_INSIDE) === 0 &&
      this.lodOf[id] !== LOD_HIDDEN
    );
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
    // A squad riding in a carrier is out of play: not drawn, not selectable.
    return id < this.count && (this.info[id] & (INFO_STATE_MASK | INFO_CARRIED)) === STATE_ALIVE;
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
    this.billow(seconds, dt);

    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);
    const planes = this.frustum.planes;
    const cam = camera.position;
    const nearNow = this.lodNear * this.nearScale;
    const near2 = nearNow * nearNow;
    const far2 = this.lodFar * this.lodFar;

    const batches = this.batches;
    for (const b of batches) b.n = 0;
    this.jamRings.n = 0;
    // Map symbols: nothing up close, solid when the camera is far out.
    const icons = this.icons;
    icons.batch.n = 0;
    const iconAlpha = Math.min(1, Math.max(0, (this.zoom - ICON_FROM) / (ICON_FULL - ICON_FROM)));
    const right = this.camRight.setFromMatrixColumn(camera.matrixWorld, 0);
    const up = this.camUp.setFromMatrixColumn(camera.matrixWorld, 1);
    const lodCount = this.stats.lod;
    lodCount[0] = lodCount[1] = lodCount[2] = 0;
    let culled = 0;
    let ringCount = 0;
    const r = this.rings.instanceMatrix.array as Float32Array;

    for (let i = 0; i < n; i++) {
      const state = info[i] & INFO_STATE_MASK;
      if (state === STATE_FREE) continue;
      const veh = this.vehicles[this.kind[i]];
      const isTank = veh !== null;
      const alive = state === STATE_ALIVE;
      // Fallen squads and shot-down drones leave no wreck.
      if (!alive && (!isTank || IS_AIR[this.kind[i]])) continue;
      if ((info[i] & INFO_CARRIED) !== 0) {
        this.lodOf[i] = LOD_HIDDEN;
        continue;
      }

      const x = prev[2 * i] + (curr[2 * i] - prev[2 * i]) * alpha;
      const z = prev[2 * i + 1] + (curr[2 * i + 1] - prev[2 * i + 1]) * alpha;
      const flying = IS_AIR[this.kind[i]];
      const y =
        this.terrain.heightAt(x, z) + (flying ? ALTITUDE + Math.sin(seconds * 1.3 + i) * 0.3 : 0);
      pos[3 * i] = x;
      pos[3 * i + 1] = y;
      pos[3 * i + 2] = z;
      const teamId = (info[i] >> INFO_TEAM_SHIFT) & INFO_TEAM_MASK;
      if (alive && (info[i] & INFO_INSIDE) !== 0) {
        // In a building: no model to draw. The house shows a pip per squad, for your own
        // garrisons always and for the enemy's once its fire has given it away.
        const st = this.insideOf(i);
        const known =
          teamId === this.playerTeam || ((info[i] & INFO_REVEALED) !== 0 && this.fog.sees(x, z));
        if (st >= 0) {
          pos[3 * i + 1] = this.structures.topOf(st) - 0.6;
          if (known) {
            this.structures.occ[st]++;
            this.structures.occTeam[st] = teamId;
            if (this.selected[i]) this.structures.occSelected[st] = 1;
          }
        }
        this.lodOf[i] = known ? 1 : LOD_HIDDEN;
        continue;
      }
      // Fog of war: enemies show only where the player can see, wrecks where they have been.
      if (teamId !== this.playerTeam || !alive) {
        // A unit the army has located (a gun that fired, say) shows through the fog.
        const located = (info[i] & INFO_SPOTTED) !== 0;
        if (alive ? !located && !this.fog.sees(x, z) : !this.fog.hasExplored(x, z)) {
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

      const team = TEAM_RGB[teamId] ?? TEAM_RGB[0];
      if (iconAlpha > 0 && alive) {
        // The same size on screen at any distance; brighter than the paint, to carry far.
        const s = Math.sqrt(d2) * 0.018;
        const lift = flying ? 0 : 1.2 + s * 0.5;
        const sel = this.selected[i] ? 1.6 : 1;
        icons.put(
          x + up.x * lift,
          y + up.y * lift,
          z + up.z * lift,
          s,
          right,
          up,
          this.kind[i],
          Math.min(1, team[0] * 1.9 * sel + 0.04),
          Math.min(1, team[1] * 1.9 * sel + 0.04),
          Math.min(1, team[2] * 1.9 * sel + 0.04),
          iconAlpha,
        );
      }
      const h = this.heading[i];
      const sin = Math.sin(h);
      const cos = Math.cos(h);

      const jam = JAM_RADIUS[this.kind[i]];
      if (jam > 0 && alive) {
        const mine = teamId === this.playerTeam;
        const a = 0.35 + 0.15 * Math.sin(seconds * 3 + i);
        this.jamRings.put(x, y + 0.4, z, 0, jam, 1, 1, mine ? 0.72 : 0.22, mine ? 0.15 : 0.18, a);
      }
      if (veh) {
        // A jammed drone flickers: its link is gone.
        const jammedNow = flying && alive && this.load[i] > 0;
        const burn =
          (i % SEEDS) +
          BURN_BASE +
          BURN_SCALE * (alive ? (jammedNow ? 0.45 + 0.4 * Math.sin(seconds * 24 + i) : 0) : 1);
        if (lod === 2) {
          veh.far.put(x, y, z, sin, cos, 1, team[0], team[1], team[2], burn);
        } else {
          veh.hull[lod].put(x, y, z, sin, cos, 1, team[0], team[1], team[2], burn);
          // Wrecks keep the turret where it died, knocked slightly askew.
          const th = this.turret[i] + (alive ? 0 : 0.5);
          const ts = Math.sin(th);
          const tc = Math.cos(th);
          // Recoil: the turret kicks back along the gun and recovers.
          const since = seconds - this.shotAt[i];
          const kick = since < 0.35 ? 0.16 * (1 - since / 0.35) ** 2 : 0;
          const m = veh.model;
          const px = x + sin * m.turretZ - ts * kick;
          const pz = z + cos * m.turretZ - tc * kick;
          if (veh.turret.length > 0) {
            veh.turret[lod].put(px, y + m.turretY, pz, ts, tc, 1, team[0], team[1], team[2], burn);
          }
        }
        if (!alive && lod < 2) {
          const age = seconds - this.diedAt[i];
          if (age < WRECK_SMOKE_SECONDS && Math.random() < dt * 3) {
            fx.wreckSmoke(x, y, z, Math.max(0, 1 - age / 12));
          }
        }
      } else {
        const squad = this.squads[this.kind[i]] ?? this.squads[KIND_INFANTRY]!;
        if (lod === 2) {
          squad.far.put(x, y, z, sin, cos, 1, team[0], team[1], team[2], (i % SEEDS) + BURN_BASE);
        } else {
          // Men drop out of the squad as it loses health.
          const figures = squad.figures;
          const men = Math.ceil((this.hp[i] * figures.length) / 255);
          const face = Number.isNaN(aimAngle) ? h : aimAngle;
          const fs = Math.sin(face);
          const fc = Math.cos(face);
          // Ease between halted and moving, and between at ease and in a fight, so a squad
          // settles into its stances instead of snapping.
          const forced = this.pose;
          const since = forced ? forced[2] : seconds - this.shotAt[i];
          const ease = Math.min(1, dt * 4.5);
          let halted = (this.halted[i] += ((this.moving[i] === 1 ? 0 : 1) - this.halted[i]) * ease);
          let fight = (this.fight[i] +=
            ((since < 3 || !Number.isNaN(aimAngle) ? 1 : 0) - this.fight[i]) * ease);
          if (forced) {
            halted = forced[0];
            fight = forced[1];
          }
          const drill = squad.drill;
          const near = lod === 0 && this.soldiers.roomNear ? 0 : 1;
          for (let k = 0; k < men; k++) {
            const f = figures[k];
            const sx = x + f.x * cos + f.z * sin;
            const sz = z - f.x * sin + f.z * cos;
            const sy = this.terrain.heightAt(sx, sz);
            const seed = ((i + k * 5) % SEEDS) + BURN_BASE;
            if (f.batch) {
              f.batch[lod].put(sx, sy, sz, fs, fc, 1, team[0], team[1], team[2], seed);
              continue;
            }
            // Halted, a squad takes a knee, and in a fight some of it goes flat; a missile
            // crew kneels by its launcher; scouts lie up and watch.
            const role = (i + k) % 5;
            let kneel = halted;
            let prone = 0;
            if (drill === DRILL_SCOUT) prone = halted;
            else if (drill === DRILL_SQUAD) {
              if (role === 1 || role === 4) prone = halted * fight;
              else if (role === 3) kneel = halted * (1 - fight);
              else if (role === 0) kneel = halted * fight;
            }
            const burst = since * 7 + k * 0.37;
            const firing = since < 0.9 && halted > 0.6 && ((burst | 0) + k) % 2 === 0;
            const phase = burst - (burst | 0);
            this.soldiers.man(
              near,
              sx,
              sy,
              sz,
              fs,
              fc,
              kneel,
              prone,
              1 - halted,
              fight * halted,
              seconds * 11 + i * 1.3 + k * 2.1,
              firing ? 0.035 * (1 - phase) : 0,
              team[0],
              team[1],
              team[2],
              seed,
            );
            if (firing && phase < dt * 7) {
              const mz = this.soldiers.muzzle;
              fx.thin = 0;
              fx.muzzle(mz[0], mz[1], mz[2], mz[3], mz[4]);
            }
          }
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
    this.jamRings.flush();
    icons.batch.flush();
    this.rings.count = ringCount;
    // Hold the number of full-detail units near the budget for the next frame.
    if (lodCount[0] > this.nearBudget) {
      this.nearScale = Math.max(
        0.25,
        this.nearScale * Math.max(0.5, Math.sqrt(this.nearBudget / lodCount[0])),
      );
    } else if (lodCount[0] < this.nearBudget * 0.7)
      this.nearScale = Math.min(1, this.nearScale * 1.03);
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
