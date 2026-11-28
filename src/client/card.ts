import type { UiSound } from './sound';
import { factionOf, myKinds, myPoints, myPrices } from './army';
import { FACTION_REBEL } from '../sim/factions';
import { ME } from './me';
import * as THREE from 'three/webgpu';
import {
  CMD_ASSIST,
  CMD_ATTACK_STRUCTURE,
  CMD_BREACH,
  CMD_BUILD,
  CMD_CANCEL,
  CMD_REPEAT,
  CMD_DEMOLISH,
  CMD_ENTRENCH,
  CMD_FELL,
  CMD_FORTIFY,
  CMD_GATHER,
  CMD_HOLD,
  CMD_RALLY,
  CMD_RESEARCH,
  CMD_CAMERA,
  CMD_SHAPE,
  CMD_STANCE,
  CMD_STOP,
  CMD_TRAIN,
  CMD_LOAD,
  CMD_UNLOAD,
  CMD_ROOF,
  CMD_AMBUSH,
  type Command,
} from '../sim/commands';
import {
  BUILDINGS,
  B_HELIPAD,
  B_HQ,
  MAX_TIER,
  TIER_ITEM,
  TIER_PRICE,
  type Price,
} from '../sim/economy';
import {
  AIR_GUIDED,
  AIR_NONE,
  AIR_STICK,
  AIR_STRIKE_COOLDOWN,
  AIR_STRIKE_PRICE,
  AIR_STRIKE_TIER,
  STRIKE_COOLING,
  STRIKE_NAMES,
  STRIKE_NO_PLANES,
  STRIKE_POOR,
  STRIKE_READY,
  STRIKE_TIER_LOW,
} from '../sim/air';
import { fromFx, fx } from '../sim/fixed';
import { FELL_CELLS } from '../sim/demolish';
import {
  CLASS_AIR,
  MAP_CELLS,
  MAP_SIZE,
  S_BUILDING,
  T_FOREST,
  canPlace,
  type GameMap,
} from '../sim/map';
import {
  CAMERA_COST,
  KINDS,
  AMBUSH_MAX,
  AMBUSH_MIN,
  KIND_HELI,
  KIND_LIFT,
  KIND_PARA,
  KIND_TRUCK,
  PARA_PLANE_LOAD,
  PARA_RESERVE_MAX,
  TOWN_FUEL,
  TOWN_INCOME,
  TOWN_SUPPLIES,
} from '../sim/units';
import { MAX_ORDER, WORKS, WORK_BOMB, WORK_BUILDABLE, WORK_COUNT, canFortify } from '../sim/works';
import { STANCE_FREE, STANCE_HOLD_FIRE, TICK_RATE } from '../sim/world';

/** Income is summed over this many ticks of game time: one minute. */
const INCOME_WINDOW = 60 * TICK_RATE;
import { DOCTRINE, SHAPES, SHAPE_AUTO, SHAPE_BLOCK, SHAPE_COUNT } from '../sim/formations';
import {
  BASE_STRIDE,
  TASK_HOLD_FIRE,
  TASK_JOB_MASK,
  TASK_MOVING,
  TASK_ROOF,
  TASK_AMBUSH,
  type Snapshot,
} from '../worker/protocol';
import type { StructureView } from './structures';
import type { Terrain } from './terrain';
import type { UnitView } from './units';
import type { WorksView } from './works';

/** World units per map cell. */
const CELL = MAP_SIZE / MAP_CELLS;
/** An ambush laid with a click and no drag covers this much round the point (metres). */
const AMBUSH_DEFAULT = 15;
const QUEUE_SLOTS = 8;
/** Names short enough for a queue slot, and what each unit is for (the button's tooltip). */
const SHORT = [
  'Tank',
  'Rifles',
  'Missile',
  'IFV',
  'Gun',
  'Recon',
  'Drone',
  'Strike',
  'Air def.',
  'Jammer',
  'Truck',
  'Engineer',
  'Gunship',
  'Lift',
  'Paras',
  'Plane',
  'Mortar',
];
/** What the rebels (I8) call theirs in a queue slot, and what theirs are for. */
const REBEL_SHORT: Record<number, string> = {
  1: 'Fighters',
  2: 'Rockets',
  3: 'Pickup',
  4: 'Rocket tr.',
  8: 'Gun truck',
  11: 'Sappers',
};
const REBEL_HINT: Record<number, string> = {
  0: 'Captured tank. Dear and slow to come by: a few at most. Kills vehicles and breaks walls; weak to missile teams, to infantry up close and to strike drones.',
  1: 'Rebel fighters. The cheapest and quickest squad in the game, and the weakest man for man. In a town where people still live they are as hard to see as men in a wood until they fire, and they run a quarter faster through any town. Rockets hurt vehicles within 8 m; a shoulder-launched missile or two keeps helicopters honest.',
  2: "Rocket team. Rocket-propelled grenades, not guided missiles: three quarters of a missile team's reach and two thirds of its punch, but twice the rate of fire and half the price. Fight them from windows, roofs (Shift + R) and ambushes (Shift + H).",
  3: 'Technical. A pickup with a heavy machine gun: the fastest thing on wheels, carries one squad (L to mount, U to dismount), mows down infantry, and dies to anything with a cannon. One army point, not two.',
  4: 'Rocket truck. Twelve tubes on a pickup: shells what others have spotted out to 70 m, then drives off before the answer lands. Ctrl + right click: shell a spot. F: smoke. I: a flare, at night.',
  8: 'Gun truck. A twin anti-aircraft cannon on a pickup: your answer to drones and helicopters. Shorter reach than a real air-defence vehicle, and no armour.',
  9: "Jammer van. Enemy drones in its ring crash, enemy cameras in it are blinded. A smaller ring than any army's jammer.",
  11: "Sappers. Build field works, blow up the enemy's, leave cameras (V), and lay roadside bombs: hidden from the enemy, one goes off under his first vehicle to cross it.",
};
const hintOf = (kind: number): string =>
  (factionOf(ME) === FACTION_REBEL ? REBEL_HINT[kind] : undefined) ?? HINT[kind];
const shortOf = (kind: number): string =>
  (factionOf(ME) === FACTION_REBEL ? REBEL_SHORT[kind] : undefined) ?? SHORT[kind];
const HINT = [
  'Main battle tank. Kills vehicles and breaks walls; weak to missile teams, to infantry up close in streets, and to strike drones without air defence or a jammer near.',
  'Infantry squad. Cheap and fast to raise. Holds buildings, trenches and forest; rockets hurt vehicles within 8 m.',
  'Missile team. Kills vehicles from beyond gun range. Helpless against infantry: keep riflemen with it.',
  'Infantry fighting vehicle. Carries two squads fast (L to mount, U to dismount) and mows down infantry.',
  'Self-propelled gun. Shells what others have spotted from far behind. Ctrl + right click: shell a spot. F: smoke. I: a flare, at night.',
  'Recon team. Sees far, hard to see, unarmed. Everything else is half blind without it.',
  'Recon drone. Eyes in the sky over hills and houses. Dies to air defence and jammers.',
  'Strike drone. Flies into a vehicle, once. They circle, then hit one at a time: four for a tank. Dies to air defence and jammers.',
  'Air-defence vehicle. The only thing that shoots drones down reliably.',
  'Jammer. Enemy drones in its ring crash; enemy cameras in it are blinded and revealed. Works by itself.',
  'Logistics truck. Hauls supplies and fuel, builds and repairs base buildings and field works.',
  "Engineer squad. Builds field works, blows up the enemy's, and leaves surveillance cameras (V).",
  'Attack helicopter. Rockets from above the roofs: hunts vehicles and squads in the open, and shoots down other helicopters. Left alone it flies at enemies your army has found nearby and comes back; Hold (H) keeps it where it is. No armour: air defence takes it apart, massed rifles wear it down. Each helipad holds three helicopters.',
  'Transport helicopter. Lifts four squads over rivers, walls and front lines (L to board, U to set down). Unarmed. Each helipad holds three helicopters.',
  'Paratroopers. Trained into a reserve that waits off the map. Press J and click the map: a transport plane drops up to eight squads there. Air defence can shoot the plane down with everyone aboard.',
  'Transport plane.',
  'Mortar team. Lobs bombs over the houses at anything your army has spotted within 65 m (not closer than 12): bombs pin men in the open, barely scratch armour or walls. Ctrl + right click: shell a spot. F: smoke. Fires from a roof (Roof order) but not from inside a house. Helpless up close.',
];
/** The tool after the kinds of field work: take works down. */
export const TOOL_REMOVE = WORK_COUNT;

/**
 * The command card: what the selection can do, as buttons. Three cases: a base building
 * (its queue, what it can produce, the next technology tier), trucks (what they can
 * build) and any units (stop, hold position, hold fire). It also owns the two bits of
 * client state that go with it: which building is selected, and a building being placed.
 */
export class CommandCard {
  /** Selected base building (structure id), or -1. */
  building = -1;
  /** Building type being placed, or -1. */
  placing = -1;
  /**
   * Field-work tool in hand: 0 = none, a kind of work (drag draws a line of it), or
   * TOOL_REMOVE (drag a box over works of yours to take them down).
   */
  tool = 0;
  /** Cell where the drag with the tool started, or -1. */
  private dragFrom = -1;
  private dragCells: number[] = [];
  private dragCost = 0;
  readonly group = new THREE.Group();
  private readonly ghost: THREE.Mesh;
  private readonly lurkRing: THREE.Mesh;
  private readonly ghostMaterial: THREE.MeshBasicNodeMaterial;
  private readonly outline: THREE.LineSegments;
  private readonly rally: THREE.Mesh;
  private plotX = 0;
  private plotY = 0;
  private plotOk = false;
  private supplies = 0;
  private fuel = 0;
  private credits = 0;
  private tier = 1;
  private pop = 0;
  private popCap = 0;
  private upkeep = 0;
  /** Paratroop squads in reserve, helicopters flying and what the helipads hold. */
  private reserve = 0;
  private helis = 0;
  private heliCap = 0;
  /** Set by the client: asks for the place of a paratroop drop. */
  paradrop: () => void = () => {};
  /** The army's air strike (I7): which (AIR_*), whether it can go (STRIKE_*), seconds to go. */
  private strikeType = AIR_NONE;
  private strikeStatus = STRIKE_NO_PLANES;
  private strikeIn = 0;
  /** Set by the client: asks for the point of an air strike. */
  airStrike: () => void = () => {};
  /** Flags the player holds: each pays supplies, fuel and credits every second. */
  private flags = 0;
  private flagsKnown = false;
  /** A chime or a click for what happened (set by the client). */
  uiSound: (kind: UiSound) => void = () => {};
  /**
   * Supplies that came in (trucks unloading, flags paying), as [tick, amount], over the last
   * INCOME_WINDOW ticks: what the army earns a minute, set against upkeep.
   */
  private gains: number[] = [];
  private lastSupplies = -1;
  private lastTick = -1;
  /** Supplies a minute coming in, less upkeep. */
  private net = 0;
  /** The player's units that are out of supply (set by whoever knows: the supply view). */
  hungry: () => number[] = () => [];
  private html = '';
  private resHtml = '';
  private readonly hadHq = [false, false, false, false];
  private readonly lostHq = [false, false, false, false];

  /** Has the army of `team` lost its headquarters? */
  fallen(team: number): boolean {
    return this.lostHq[team] === true;
  }
  /**
   * An order waiting for a click on the ground: attack-move or a smoke screen. The input
   * handler reads it and carries it out; `arm` is how both sides change it.
   */
  armed: '' | 'attack' | 'smoke' | 'flare' = '';
  private over = false;
  /** The game is decided (true: won). Without it, a banner says so. */
  onOver: ((won: boolean) => void) | null = null;

  constructor(
    private readonly el: HTMLElement,
    private readonly resEl: HTMLElement,
    private readonly bannerEl: HTMLElement,
    private readonly map: GameMap,
    private readonly terrain: Terrain,
    private readonly units: UnitView,
    private readonly structures: StructureView,
    private readonly send: (command: Command) => void,
    private readonly lookAt: (x: number, z: number) => void,
    private readonly works: WorksView,
  ) {
    this.ghostMaterial = new THREE.MeshBasicNodeMaterial({
      color: 0x7dff8a,
      transparent: true,
      opacity: 0.35,
    });
    this.ghostMaterial.depthWrite = false;
    this.ghost = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.ghostMaterial);
    this.outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicNodeMaterial({ color: 0x7dff8a }),
    );
    const ring = new THREE.MeshBasicNodeMaterial({ color: 0x7dff8a, transparent: true });
    ring.depthWrite = false;
    this.rally = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.3, 24).rotateX(-Math.PI / 2), ring);
    this.ghost.visible = this.outline.visible = this.rally.visible = false;
    // The circle of an ambush being drawn (I6): amber, flat on the ground.
    const lurk = new THREE.MeshBasicNodeMaterial({ color: 0xffb347, transparent: true });
    lurk.opacity = 0.7;
    lurk.depthWrite = false;
    lurk.depthTest = false;
    this.lurkRing = new THREE.Mesh(new THREE.RingGeometry(0.96, 1, 96).rotateX(-Math.PI / 2), lurk);
    this.lurkRing.renderOrder = 3;
    this.lurkRing.visible = false;
    this.group.add(this.ghost, this.outline, this.rally, this.lurkRing);
    // Act on press, not on click: the card is redrawn as numbers change, and a redraw
    // between press and release would swallow a click.
    el.addEventListener('pointerdown', (e) => {
      const button = (e.target as HTMLElement).closest('button');
      if (!button || button.classList.contains('off')) return;
      e.preventDefault();
      this.act(button.dataset.act ?? '', Number(button.dataset.k ?? 0));
    });
    resEl.addEventListener('pointerdown', (e) => {
      const button = (e.target as HTMLElement).closest('button');
      if (!button) return;
      if (button.dataset.act === 'hungry') this.selectHungry();
      else if (button.dataset.act === 'paradrop') this.paradrop();
      else if (button.dataset.act === 'strike') this.callStrike();
      else this.selectIdle();
    });
    setInterval(() => this.render(), 200);
  }

  /** Shift + J or the button: ask for the point, if the strike can go. */
  callStrike(): void {
    if (this.strikeType !== AIR_NONE && this.strikeStatus === STRIKE_READY) this.airStrike();
  }

  /** The air strike's button in the resource bar, from tier 2 on, for the armies that have one. */
  private strikeButton(): string {
    if (this.strikeType === AIR_NONE || this.tier < AIR_STRIKE_TIER - 1) return '';
    const name = STRIKE_NAMES[this.strikeType];
    const p = AIR_STRIKE_PRICE;
    const what =
      this.strikeType === AIR_GUIDED
        ? 'one guided bomb, exactly where you click: it kills a tank and takes most of a building'
        : this.strikeType === AIR_STICK
          ? 'a stick of six bombs along its run: it clears a street of men in the open'
          : 'a swarm of eight drones that dive on the vehicles round the point, two to a tank, then on men in the open. A jammer sends them astray';
    const title = `Air strike: a jet brings ${what}. Costs ${p.supplies} supplies, ${p.fuel} fuel and ${p.credits} credits, needs tier ${AIR_STRIKE_TIER} and your headquarters, then ${AIR_STRIKE_COOLDOWN / 1200} minutes before the next. Air defence can shoot the jet down on the way in. Bombs hurt your own men too`;
    const st = this.strikeStatus;
    const note =
      st === STRIKE_READY
        ? '<kbd>⇧J</kbd>'
        : st === STRIKE_TIER_LOW
          ? `tier ${AIR_STRIKE_TIER}`
          : st === STRIKE_COOLING
            ? `${Math.floor(this.strikeIn / 60)}:${String(this.strikeIn % 60).padStart(2, '0')}`
            : st === STRIKE_POOR
              ? 'funds'
              : 'no HQ';
    return `<button data-act="strike" class="air${st === STRIKE_READY ? '' : ' off'}" title="${title}">${name} ${note}</button>`;
  }

  applySnapshot(s: Snapshot): void {
    this.income(s.tick, s.supplies[ME] ?? 0, s.upkeep[ME] ?? 0);
    this.supplies = s.supplies[ME] ?? 0;
    this.fuel = s.fuel[ME] ?? 0;
    this.credits = s.credits[ME] ?? 0;
    this.tier = s.tier[ME] ?? 1;
    this.pop = s.pop[ME] ?? 0;
    this.popCap = s.popCap[ME] ?? 0;
    this.reserve = s.reserve[ME] ?? 0;
    this.strikeType = s.strikeType?.[ME] ?? AIR_NONE;
    this.strikeStatus = s.strikeStatus?.[ME] ?? STRIKE_NO_PLANES;
    this.strikeIn = s.strikeIn?.[ME] ?? 0;
    this.helis = s.helis[ME] ?? 0;
    this.heliCap = s.heliCap[ME] ?? 0;
    this.upkeep = s.upkeep[ME] ?? 0;
    let flags = 0;
    for (let t = 0; t < s.townOwner.length; t++) if (s.townOwner[t] === ME) flags++;
    // A chime up for a flag taken, down for one lost (not for the count at the start).
    if (this.flagsKnown && flags !== this.flags) this.uiSound(flags > this.flags ? 'gain' : 'loss');
    this.flagsKnown = true;
    this.flags = flags;
    // The game is decided when a headquarters that stood is gone.
    // With several enemies (decision 124) it is won when the last of them has lost his.
    const standing = [false, false, false, false];
    for (let o = 0; o < s.bases.length; o += BASE_STRIDE) {
      const team = s.bases[o + 2];
      if (team < 4 && s.bases[o + 1] === B_HQ && s.structHp[s.bases[o]] > 0) standing[team] = true;
    }
    let foes = 0;
    let fallen = false;
    let out = -1;
    for (let t = 0; t < 4; t++) {
      if (standing[t]) {
        this.hadHq[t] = true;
        if (t !== ME) foes++;
      } else if (this.hadHq[t]) {
        this.hadHq[t] = false;
        this.lostHq[t] = true;
        if (t !== ME) out = t;
        fallen = true;
      }
    }
    const lost = fallen && !standing[ME];
    if (out >= 0 && foes > 0 && !lost && !this.over) {
      // One enemy down, others still in the field: say so, and carry on.
      this.bannerEl.textContent = `The ${['red', 'blue', 'gold', 'green'][out]} headquarters has fallen: ${foes} ${foes === 1 ? 'army' : 'armies'} left to beat`;
      this.bannerEl.style.display = 'block';
      setTimeout(() => {
        if (!this.over) this.bannerEl.style.display = 'none';
      }, 7000);
    }
    if (fallen && !this.over && (lost || foes === 0)) {
      this.over = true;
      if (this.onOver) this.onOver(!lost);
      else {
        this.bannerEl.textContent = lost
          ? 'Defeat: your headquarters has fallen'
          : 'Victory: the enemy headquarters has fallen';
        this.bannerEl.style.display = 'block';
      }
    }
    if (this.building >= 0 && this.structures.hp[this.building] === 0) this.select(-1);
  }

  arm(mode: '' | 'attack' | 'smoke' | 'flare'): void {
    this.armed = mode;
    const game = document.getElementById('game');
    if (game) game.style.cursor = mode === '' ? '' : 'cell';
    this.render();
  }

  select(s: number): void {
    this.building = s;
    this.render();
  }

  private can(p: Price): boolean {
    return (
      this.tier >= p.tier &&
      this.supplies >= p.supplies &&
      this.fuel >= p.fuel &&
      this.credits >= p.credits
    );
  }

  /** Your trucks with no job that are standing still. */
  private idle(): number[] {
    const u = this.units;
    const out: number[] = [];
    for (let i = 0; i < u.count; i++) {
      if (u.kindOf(i) !== KIND_TRUCK || !u.isMine(i)) continue;
      if ((u.task[i] & (TASK_JOB_MASK | TASK_MOVING)) === 0) out.push(i);
    }
    return out;
  }

  /** Select the idle trucks and look at them. */
  selectIdle(): void {
    const ids = this.idle();
    if (ids.length === 0) return;
    this.select(-1);
    this.units.setSelected(ids, false);
    const c = this.units.centreOf(ids);
    if (c) this.lookAt(c.x, c.z);
  }

  /** Select the units that are out of supply and look at them. */
  selectHungry(): void {
    const ids = this.hungry();
    if (ids.length === 0) return;
    this.select(-1);
    this.units.setSelected(ids, false);
    const c = this.units.centreOf(ids);
    if (c) this.lookAt(c.x, c.z);
  }

  private trucks(): number[] {
    return this.units.selectedIds().filter((id) => this.units.kindOf(id) === KIND_TRUCK);
  }

  private act(act: string, k: number): void {
    const ids = this.units.selectedIds();
    const s = this.building;
    if (act === 'train') this.send({ type: CMD_TRAIN, structure: s, kind: k });
    else if (act === 'tier') this.send({ type: CMD_RESEARCH, structure: s });
    else if (act === 'cancel') this.send({ type: CMD_CANCEL, structure: s });
    else if (act === 'repeat') {
      const rec = this.record(s);
      const on = rec >= 0 && this.structures.bases[rec + 18] === 1;
      this.send({ type: CMD_REPEAT, structure: s, on: !on });
    } else if (act === 'place') {
      this.placing = k;
      this.cancelTool();
    } else if (act === 'work') {
      this.placing = -1;
      this.cancelTool();
      this.tool = k;
    } else if (act === 'stop') this.send({ type: CMD_STOP, units: ids });
    else if (act === 'hold') this.send({ type: CMD_HOLD, units: ids });
    else if (act === 'fire') this.toggleFire();
    else if (act === 'shape') this.cycleShape();
    else if (act === 'camera') this.placeCamera();
    else if (act === 'entrench') this.armEntrench();
    else if (act === 'demolish') this.armDemolish();
    else if (act === 'roof') this.armRoof();
    else if (act === 'down') this.comeDown();
    else if (act === 'ambush') this.armAmbush();
    else if (act === 'amove') this.arm(this.armed === 'attack' ? '' : 'attack');
    else if (act === 'smoke') this.arm(this.armed === 'smoke' ? '' : 'smoke');
    else if (act === 'flare') this.arm(this.armed === 'flare' ? '' : 'flare');
    else if (act === 'unload') {
      this.send({ type: CMD_UNLOAD, units: ids.filter((id) => this.units.load[id] > 0) });
    } else if (act === 'load') this.mount();
    this.render();
  }

  /** Every selected squad boards the nearest selected carrier with a seat. */
  mount(): void {
    const ids = this.units.selectedIds();
    const carriers = ids.filter((id) => KINDS[this.units.kindOf(id)].carry > 0);
    const squads = ids.filter((id) => KINDS[this.units.kindOf(id)].garrison);
    if (carriers.length > 0 && squads.length > 0) {
      this.send({ type: CMD_LOAD, units: squads, carriers });
    }
  }

  /**
   * "Repair / fortify" is in hand: the next right click on a building sends the selected
   * engineers and trucks to work on it instead of sending the infantry inside.
   */
  entrench = false;

  armEntrench(): void {
    this.entrench = !this.entrench && this.builders().length > 0;
    this.demolish = false;
    this.html = '';
  }

  /**
   * "Demolish" is in hand: the next right click sends the selected engineers to bring
   * down what is under the pointer. A building or a bridge: charges. A wood: they fell a
   * patch of it. A field work: the enemy's is breached, your own is taken down.
   */
  demolish = false;

  armDemolish(): void {
    this.demolish = !this.demolish && this.sappers().length > 0;
    this.entrench = false;
    this.html = '';
  }

  /**
   * "Roof" is in hand (I6): the next right click on a building sends the selected squads
   * up on its roof (those already inside it climb up; the rest walk there first).
   */
  roof = false;

  armRoof(): void {
    this.roof = !this.roof && this.climbers().length > 0;
    this.entrench = this.demolish = false;
    this.cancelAmbush();
    this.html = '';
  }

  /** Squads of yours in the selection that can go into a building, and so up on a roof. */
  private climbers(): number[] {
    const u = this.units;
    return u.selectedIds().filter((id) => u.isMine(id) && KINDS[u.kindOf(id)].garrison);
  }

  /** Selected squads on a roof come back down inside. */
  comeDown(): void {
    const u = this.units;
    const by = new Map<number, number[]>();
    for (const id of u.selectedIds()) {
      if (!u.isMine(id) || (u.task[id] & TASK_ROOF) === 0) continue;
      const st = u.insideOf(id);
      if (st < 0) continue;
      const list = by.get(st) ?? [];
      list.push(id);
      by.set(st, list);
    }
    for (const [structure, units] of by) this.send({ type: CMD_ROOF, units, structure, off: true });
  }

  /**
   * "Ambush" is in hand (I6): press on the ground where the vehicles will come and drag
   * out the circle. The selected units hold their fire until a vehicle enters it.
   */
  ambush = false;
  private ambushX = 0;
  private ambushZ = 0;
  private ambushR = -1;

  armAmbush(): void {
    const on = !this.ambush && this.lurkers().length > 0;
    this.cancelAmbush();
    this.ambush = on;
    this.roof = this.entrench = this.demolish = false;
    this.html = '';
  }

  /** Selected units of yours that can lie in wait: armed, on the ground, not guns. */
  private lurkers(): number[] {
    const u = this.units;
    return u.selectedIds().filter((id) => {
      const k = KINDS[u.kindOf(id)];
      return u.isMine(id) && !k.indirect && k.cls !== CLASS_AIR && k.damage.some((d) => d > 0);
    });
  }

  /** The circle starts here (the press). */
  ambushDown(x: number, z: number): void {
    this.ambushX = x;
    this.ambushZ = z;
    this.ambushR = AMBUSH_DEFAULT;
    this.showLurk();
  }

  /** The pointer moved with the button held: the circle reaches it. */
  ambushDrag(x: number, z: number): void {
    if (this.ambushR < 0) return;
    const r = Math.hypot(x - this.ambushX, z - this.ambushZ);
    this.ambushR = Math.min(fromFx(AMBUSH_MAX), Math.max(fromFx(AMBUSH_MIN), r));
    this.showLurk();
  }

  /** Released: the order goes out. A click without a drag lays an ambush of the usual size. */
  ambushUp(): void {
    if (this.ambushR < 0) return;
    const units = this.lurkers();
    if (units.length > 0) {
      this.send({
        type: CMD_AMBUSH,
        units,
        x: fx(this.ambushX),
        y: fx(this.ambushZ),
        radius: fx(this.ambushR),
      });
    }
    this.cancelAmbush();
    this.render();
  }

  /** Is a circle being drawn right now? */
  get drawingAmbush(): boolean {
    return this.ambushR >= 0;
  }

  cancelAmbush(): void {
    this.ambush = false;
    this.ambushR = -1;
    this.lurkRing.visible = false;
    this.html = '';
  }

  private showLurk(): void {
    const r = this.ambushR;
    this.lurkRing.visible = r > 0;
    this.lurkRing.position.set(
      this.ambushX,
      this.terrain.heightAt(this.ambushX, this.ambushZ) + 0.3,
      this.ambushZ,
    );
    this.lurkRing.scale.set(r, 1, r);
  }

  /** Your selected engineer squads. */
  private sappers(): number[] {
    const u = this.units;
    return u.selectedIds().filter((id) => u.isMine(id) && KINDS[u.kindOf(id)].engineer);
  }

  /** Is there a wood within an order's reach of the cell under (x, z)? */
  private woodAt(x: number, z: number): boolean {
    const cx = Math.floor(x / CELL);
    const cy = Math.floor(z / CELL);
    for (let j = cy - FELL_CELLS; j <= cy + FELL_CELLS; j++) {
      for (let i = cx - FELL_CELLS; i <= cx + FELL_CELLS; i++) {
        if (i < 0 || j < 0 || i >= MAP_CELLS || j >= MAP_CELLS) continue;
        if ((i - cx) ** 2 + (j - cy) ** 2 > FELL_CELLS * FELL_CELLS + 1) continue;
        if (this.map.type[j * MAP_CELLS + i] === T_FOREST) return true;
      }
    }
    return false;
  }

  /** The demolition order on what is under the pointer. False if there is nothing to bring down. */
  private bringDown(x: number, z: number, structure: number): boolean {
    const units = this.sappers();
    if (units.length === 0) return false;
    if (structure >= 0) {
      this.send({ type: CMD_ATTACK_STRUCTURE, units, structure });
      return true;
    }
    const work = this.works.workAt(x, z);
    if (work && work.team === ME) {
      this.send({ type: CMD_DEMOLISH, team: ME, cells: [work.cell] });
      return true;
    }
    if (work && work.done) {
      this.send({ type: CMD_BREACH, units, x: fx(x), y: fx(z) });
      return true;
    }
    if (this.woodAt(x, z)) {
      this.send({ type: CMD_FELL, units, x: fx(x), y: fx(z) });
      return true;
    }
    return false;
  }

  /** Each selected engineer squad of yours leaves a surveillance camera where it stands. */
  placeCamera(): void {
    const u = this.units;
    const ids = u.selectedIds().filter((id) => u.isMine(id) && KINDS[u.kindOf(id)].engineer);
    if (ids.length > 0) this.send({ type: CMD_CAMERA, units: ids });
  }

  /** Hold fire for the whole selection, or fire at will again if all of it already holds. */
  toggleFire(): void {
    const ids = this.units.selectedIds();
    if (ids.length === 0) return;
    const all = ids.every((id) => (this.units.task[id] & TASK_HOLD_FIRE) !== 0);
    this.send({ type: CMD_STANCE, units: ids, stance: all ? STANCE_FREE : STANCE_HOLD_FIRE });
  }

  /** The shape the whole selection is told to move in, or -1 if they differ. */
  private shapeOf(ids: readonly number[]): number {
    if (ids.length === 0) return -1;
    const shape = this.units.shape[ids[0]];
    return ids.every((id) => this.units.shape[id] === shape) ? shape : -1;
  }

  /** The next way of moving for the selection: Auto, then each shape in turn. */
  cycleShape(): void {
    const ids = this.units.selectedIds().filter((id) => this.units.isMine(id));
    if (ids.length === 0) return;
    const shape = (this.shapeOf(ids) + 1) % SHAPE_COUNT;
    for (const id of ids) this.units.shape[id] = shape;
    this.send({ type: CMD_SHAPE, units: ids, shape });
    this.render();
  }

  /** While placing: move the outline of the building to the plot under the pointer. */
  hover(x: number, z: number): void {
    if (this.placing < 0) return;
    const b = BUILDINGS[this.placing];
    this.plotX = Math.round(x / CELL - b.w / 2);
    this.plotY = Math.round(z / CELL - b.h / 2);
    this.plotOk = canPlace(this.map, this.plotX, this.plotY, b.w, b.h) && this.can(b);
  }

  /** While placing: put the building down where it is shown. False if it cannot go there. */
  confirm(keep: boolean): boolean {
    if (this.placing < 0 || !this.plotOk) return false;
    const crew = this.trucks();
    if (crew.length === 0) return false;
    this.send({
      type: CMD_BUILD,
      units: crew,
      building: this.placing,
      x: this.plotX,
      y: this.plotY,
      // With Shift it is one more for the list: built after those placed before it.
      ...(keep ? { queue: true } : {}),
    });
    this.uiSound('place');
    if (!keep) this.placing = -1;
    this.plotOk = false;
    return true;
  }

  cancelPlacing(): void {
    this.placing = -1;
  }

  /** Your selected units that can put up field works: trucks and engineers. */
  private builders(): number[] {
    const u = this.units;
    return u.selectedIds().filter((id) => {
      const kind = u.kindOf(id);
      return u.isMine(id) && (kind === KIND_TRUCK || KINDS[kind].engineer);
    });
  }

  private cellAt(x: number, z: number): number {
    const cx = Math.min(MAP_CELLS - 1, Math.max(0, Math.floor(x / CELL)));
    const cy = Math.min(MAP_CELLS - 1, Math.max(0, Math.floor(z / CELL)));
    return cy * MAP_CELLS + cx;
  }

  /** With a tool in hand: the pointer is over (x, z). Draws what a click or drag would do. */
  toolHover(x: number, z: number): void {
    if (this.tool === 0) return;
    const to = this.cellAt(x, z);
    const from = this.dragFrom < 0 ? to : this.dragFrom;
    const x0 = from % MAP_CELLS;
    const y0 = Math.floor(from / MAP_CELLS);
    const x1 = to % MAP_CELLS;
    const y1 = Math.floor(to / MAP_CELLS);
    if (this.tool === TOOL_REMOVE) {
      this.dragCells = this.works.inRect(
        Math.min(x0, x1),
        Math.min(y0, y1),
        Math.max(x0, x1),
        Math.max(y0, y1),
        ME,
      );
      this.works.setPreview(
        this.dragCells,
        this.dragCells.map(() => false),
      );
      return;
    }
    // A line of cells joined edge to edge: a wall that only touched at corners would leak.
    const cells: number[] = [];
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x1 > x0 ? 1 : -1;
    const sy = y1 > y0 ? 1 : -1;
    let cx = x0;
    let cy = y0;
    let err = dx - dy;
    cells.push(cy * MAP_CELLS + cx);
    while ((cx !== x1 || cy !== y1) && cells.length < MAX_ORDER) {
      if (2 * err > -dy && cx !== x1) {
        err -= dy;
        cx += sx;
      } else {
        err += dx;
        cy += sy;
      }
      cells.push(cy * MAP_CELLS + cx);
    }
    const price = WORKS[this.tool].supplies;
    let left = this.supplies;
    this.dragCost = 0;
    const ok = cells.map((c) => {
      const rec = this.works.at[c];
      // One of yours, planned and not yet built: the builders will simply work on it.
      if (rec !== 0) return ((rec >> 4) & 7) === ME && (rec & 128) === 0;
      if (!canFortify(this.map, this.tool, c) || left < price) return false;
      left -= price;
      this.dragCost += price;
      return true;
    });
    this.dragCells = cells.filter((_, k) => ok[k]);
    this.works.setPreview(cells, ok);
  }

  /** With a tool in hand: the button went down over (x, z). */
  toolDown(x: number, z: number): void {
    if (this.tool === 0) return;
    this.dragFrom = this.cellAt(x, z);
    this.toolHover(x, z);
  }

  /** The button came up: order what was drawn. `keep` leaves the tool in hand. */
  toolUp(keep: boolean): void {
    if (this.tool === 0 || this.dragFrom < 0) return;
    const cells = this.dragCells;
    if (cells.length > 0) {
      if (this.tool === TOOL_REMOVE) this.send({ type: CMD_DEMOLISH, team: ME, cells });
      else {
        const crew = this.builders();
        if (crew.length > 0) {
          this.send({ type: CMD_FORTIFY, units: crew, work: this.tool, cells });
        }
      }
    }
    this.dragFrom = -1;
    this.dragCells = [];
    this.dragCost = 0;
    this.works.setPreview([], []);
    if (!keep) this.tool = 0;
    this.render();
  }

  cancelTool(): void {
    this.tool = 0;
    this.dragFrom = -1;
    this.dragCells = [];
    this.works.setPreview([], []);
  }

  /**
   * A right click with this card's context. Returns true if it used the click: a rally
   * point for the selected building, or trucks sent to a site or to work on a building.
   */
  order(x: number, z: number, structure: number, queue = false): boolean {
    if (this.building >= 0 && this.units.selectedCount === 0) {
      const site = this.structures.siteAt(x, z);
      const rx = site >= 0 ? this.map.siteX[site] : fx(x);
      const ry = site >= 0 ? this.map.siteY[site] : fx(z);
      this.send({ type: CMD_RALLY, structure: this.building, x: rx, y: ry });
      return true;
    }
    if (this.roof) {
      // Stays in hand until a building is clicked.
      if (structure < 0 || this.map.sKind[structure] !== S_BUILDING) return true;
      const units = this.climbers();
      if (units.length > 0) this.send({ type: CMD_ROOF, units, structure });
      this.roof = false;
      this.html = '';
      return true;
    }
    if (this.demolish) {
      // Stays in hand after a click on nothing, so the next one can be better aimed.
      if (!this.bringDown(x, z, structure)) return true;
      this.demolish = false;
      this.html = '';
      return true;
    }
    // Builders on a planned work of yours: go and build it.
    const sappers = this.builders();
    const work = this.works.workAt(x, z);
    if (sappers.length > 0 && work && !work.done && work.team === ME) {
      this.send({ type: CMD_FORTIFY, units: sappers, work: work.kind, cells: [work.cell] });
      return true;
    }
    // Repair / fortify: with the order in hand, or with nothing selected that could go in.
    if (structure >= 0 && sappers.length > 0 && this.map.sKind[structure] === S_BUILDING) {
      const u = this.units;
      const onlyTrucks = u.selectedIds().every((id) => !KINDS[u.kindOf(id)].garrison);
      if (this.entrench || onlyTrucks) {
        this.send({ type: CMD_ENTRENCH, units: sappers, structure });
        this.entrench = false;
        this.html = '';
        return true;
      }
    }
    const crew = this.trucks();
    if (crew.length === 0) return false;
    if (structure >= 0 && this.structures.baseTeam[structure] === this.units.teamOf(crew[0])) {
      this.send({ type: CMD_ASSIST, units: crew, structure, ...(queue ? { queue: true } : {}) });
      return true;
    }
    const site = this.structures.siteAt(x, z);
    if (site < 0) return false;
    this.send({ type: CMD_GATHER, units: crew, site });
    return true;
  }

  /** Per frame: the 3D parts (placement outline, selection box, rally ring). */
  update(): void {
    const b = this.placing >= 0 ? BUILDINGS[this.placing] : null;
    this.ghost.visible = b !== null;
    if (b) {
      const x = (this.plotX + b.w / 2) * CELL;
      const z = (this.plotY + b.h / 2) * CELL;
      this.ghost.position.set(x, this.terrain.heightAt(x, z) + 1, z);
      this.ghost.scale.set(b.w * CELL, 2.4, b.h * CELL);
      this.ghostMaterial.color.setHex(this.plotOk ? 0x7dff8a : 0xff5a4a);
    }
    const s = this.building;
    const rec = this.record(s);
    this.outline.visible = this.rally.visible = rec >= 0;
    if (rec >= 0) {
      const m = this.map;
      const c = this.structures.centreOf(s);
      const top = this.structures.topOf(s) + 0.6;
      const base = this.terrain.heightAt(c.x, c.z) - 0.2;
      this.outline.position.set(c.x, (top + base) / 2, c.z);
      this.outline.scale.set(m.sW[s] * CELL + 0.8, top - base, m.sH[s] * CELL + 0.8);
      const rx = this.structures.bases[rec + 16];
      const rz = this.structures.bases[rec + 17];
      this.rally.position.set(rx, this.terrain.heightAt(rx, rz) + 0.2, rz);
    }
  }

  /** Offset of structure `s` in the base records, or -1. */
  private record(s: number): number {
    const bases = this.structures.bases;
    if (s < 0) return -1;
    for (let o = 0; o < bases.length; o += BASE_STRIDE) if (bases[o] === s) return o;
    return -1;
  }

  /**
   * Income is measured, not predicted: every rise in supplies between two snapshots is
   * money in (spending only ever lowers it), summed over the last minute of game time.
   */
  private income(tick: number, supplies: number, upkeep: number): void {
    if (tick < this.lastTick) this.gains = []; // a new game, or a rejoin from the start
    if (this.lastSupplies >= 0 && tick > this.lastTick && supplies > this.lastSupplies) {
      this.gains.push(tick, supplies - this.lastSupplies);
    }
    this.lastSupplies = supplies;
    this.lastTick = tick;
    let k = 0;
    while (k < this.gains.length && this.gains[k] <= tick - INCOME_WINDOW) k += 2;
    if (k > 0) this.gains.splice(0, k);
    let sum = 0;
    for (let j = 1; j < this.gains.length; j += 2) sum += this.gains[j];
    // Before a full minute has passed, scale what came in so far up to a minute.
    const span = Math.min(INCOME_WINDOW, Math.max(TICK_RATE * 10, tick));
    this.net = Math.round((sum * INCOME_WINDOW) / span) - upkeep;
  }

  private cost(p: Price): string {
    const part = (v: number, have: number, cls: string) =>
      v > 0 ? `<i class="${cls}${have < v ? ' short' : ''}">${v}</i>` : '';
    return (
      part(p.supplies, this.supplies, 'sup') +
      part(p.fuel, this.fuel, 'fuel') +
      part(p.credits, this.credits, 'cred')
    );
  }

  private button(
    act: string,
    k: number,
    label: string,
    p: Price | null,
    note = '',
    on = false,
    tip = '',
    key = '',
  ): string {
    const locked = p !== null && this.tier < p.tier;
    const off = p !== null && !this.can(p);
    const sub = locked ? `<i class="short">tier ${p.tier}</i>` : p ? this.cost(p) : note;
    const hot = key === '' ? '' : `<kbd>${key}</kbd>`;
    return `<button data-act="${act}" data-k="${k}" title="${tip}" class="${off ? 'off' : ''}${on ? ' on' : ''}">${hot}${label}<span>${sub || '&nbsp;'}</span></button>`;
  }

  private render(): void {
    const n = (v: number) => v.toLocaleString('en-US');
    let res =
      `<span class="pill stats">` +
      `<span class="sup"><b>${n(this.supplies)}</b> supplies</span>` +
      `<span class="fuel"><b>${n(this.fuel)}</b> fuel</span>` +
      `<span class="cred"><b>${n(this.credits)}</b> credits</span>` +
      `<i class="sep"></i>` +
      `<span title="Army points in the field, and the most your depots allow"><b>${this.pop}</b>/${this.popCap} army</span>` +
      `<span>Tier ${this.tier}</span>` +
      `<span class="${this.net < 0 ? 'bad' : 'good'}" title="Supplies a minute: what came in over the last minute (trucks unloading and flags paying), less upkeep (${this.upkeep} a minute: every army point above 60 costs supplies). Spending is not counted."><b>Net ${this.net > 0 ? '+' : this.net < 0 ? '−' : ''}${Math.abs(this.net)}</b>/min</span>` +
      `<span${this.flags > 0 ? ' class="cred"' : ''} title="What the flags you hold pay, in supplies a minute. Each flag also pays ${TOWN_FUEL * 60} fuel and ${TOWN_INCOME * 60} credits a minute. Lose the flag and you lose the income.">Flags +${this.flags * TOWN_SUPPLIES * 60}/min</span>` +
      `</span>`;
    const idle = this.idle().length;
    if (idle > 0)
      res += `<button title="Trucks with nothing to do. Click (or press .) to select them">${idle} idle truck${idle === 1 ? '' : 's'} <kbd>.</kbd></button>`;
    const hungry = this.hungry().length;
    if (hungry > 0)
      res += `<button data-act="hungry" class="warn" title="These units have been beyond your supply for two minutes: they fire at half rate and their vehicles crawl. Bring a truck, build a depot nearby, or take the town. Click to select them">${hungry} out of supply</button>`;
    if (this.reserve > 0)
      res += `<button data-act="paradrop" class="air" title="Paratroop squads waiting in reserve. Click (or press J), then click the map: a transport plane drops up to ${PARA_PLANE_LOAD} of them there. Enemy air defence can shoot the plane down">${this.reserve} paratroops <kbd>J</kbd></button>`;
    res += this.strikeButton();
    if (res !== this.resHtml) this.resEl.innerHTML = this.resHtml = res;

    let html = '';
    const rec = this.record(this.building);
    const ids = this.units.selectedIds();
    if (ids.length > 0 && this.building >= 0) this.building = -1;
    if (rec >= 0 && ids.length === 0) {
      const bases = this.structures.bases;
      const type = bases[rec + 1];
      const b = BUILDINGS[type];
      const built = bases[rec + 5];
      const hp = Math.round((this.structures.hp[this.building] * 100) / 255);
      html += `<div class="title">${b.name} <span>${built < 100 ? `going up ${built}%` : `${hp}%`}</span></div>`;
      if (built < 100) {
        html += `<div class="hint">Right click it with trucks selected to speed up the work.</div>`;
      } else {
        const queued = bases[rec + 6];
        // Eight slots, always drawn: the buttons below must not move as the queue fills.
        html += '<div class="slots">';
        for (let q = 0; q < QUEUE_SLOTS; q++) {
          if (q >= queued) {
            html += '<div class="slot empty"></div>';
            continue;
          }
          const item = bases[rec + 8 + q];
          const name = item === TIER_ITEM ? `Tier ${this.tier + 1}` : shortOf(item);
          html += `<div class="slot" title="${item === TIER_ITEM ? name : myKinds()[item].name}">${name}${q === 0 ? `<b style="width:${bases[rec + 7]}%"></b>` : ''}</div>`;
        }
        html += '</div>';
        const first = bases[rec + 8];
        const waiting =
          queued > 0 && first !== TIER_ITEM && this.pop + myPoints()[first] > this.popCap;
        const grounded =
          queued > 0 && (first === KIND_HELI || first === KIND_LIFT) && this.helis >= this.heliCap;
        const full = queued > 0 && first === KIND_PARA && this.reserve >= PARA_RESERVE_MAX;
        const pads =
          type === B_HELIPAD ? `Landing space: ${this.helis} of ${this.heliCap} helicopters` : '';
        html += `<div class="note">${waiting ? 'Army limit reached: build supply depots' : grounded ? `No landing space (${this.helis} of ${this.heliCap}): build another helipad` : full ? 'Paratroop reserve is full: drop them (J)' : pads}</div>`;
        html += '<div class="row">';
        myPrices().forEach((p, kind) => {
          if (p.from === type) {
            const pts = myPoints()[kind] > 1 ? ` ${myPoints()[kind]} pts` : '';
            html += this.button(
              'train',
              kind,
              myKinds()[kind].name + pts,
              p,
              '',
              false,
              hintOf(kind),
            );
          }
        });
        const next = TIER_PRICE[this.tier];
        if (type === B_HQ && this.tier < MAX_TIER && next) {
          html += this.button('tier', 0, `Tier ${this.tier + 1}`, { ...next, tier: 0 });
        }
        const repeating = bases[rec + 18] === 1;
        if (type !== B_HQ)
          html += this.button('repeat', 0, 'Repeat', null, repeating ? 'on' : 'off', repeating);
        if (queued > 0) html += this.button('cancel', 0, 'Cancel last', null, 'refund');
        html += '</div>';
        html += `<div class="hint">Right click the ground: rally point. On a stockpile or a well: new trucks start hauling.</div>`;
      }
    } else if (ids.length > 0) {
      const mine = ids.some((id) => this.units.isMine(id));
      if (mine && this.trucks().length > 0) {
        html += '<div class="row">';
        BUILDINGS.forEach((b, type) => (html += this.button('place', type, b.name, b)));
        html += '</div>';
        html +=
          this.placing >= 0
            ? `<div class="hint">Click to place the ${BUILDINGS[this.placing].name.toLowerCase()} (Shift: place several, built one after the other) · right click or Esc: cancel</div>`
            : `<div class="hint">Right click a stockpile or a well: haul from it · right click one of your buildings: build or repair it<br />Supply: a depot feeds troops within 150 m, a held town a little past its edge, and a truck the 50 m around it while it is within 260 m of a depot or town of yours. The lighter ground on the minimap is your supply.</div>`;
      }
      if (mine && this.builders().length > 0) {
        html += '<div class="row works">';
        for (let k = 1; k < WORK_BUILDABLE; k++) {
          const w = WORKS[k];
          const p = { supplies: w.supplies, fuel: 0, credits: 0, ticks: w.ticks, tier: 1 };
          html += this.button('work', k, w.name, p, '', this.tool === k);
        }
        if (
          factionOf(ME) === FACTION_REBEL &&
          this.builders().some((id) => KINDS[this.units.kindOf(id)].engineer)
        ) {
          // The rebels' own (I8): laid by sappers, sprung by the first enemy vehicle over it.
          const w = WORKS[WORK_BOMB];
          const p = { supplies: w.supplies, fuel: 0, credits: 0, ticks: w.ticks, tier: 1 };
          html += this.button(
            'work',
            WORK_BOMB,
            w.name,
            p,
            '',
            this.tool === WORK_BOMB,
            'Sappers only. Hidden from the enemy; goes off under his first vehicle to cross it: wrecks a truck or a carrier, cripples a tank, hurts the men around. Yours can cross it.',
          );
        }
        html += this.button(
          'work',
          TOOL_REMOVE,
          'Remove',
          null,
          'yours',
          this.tool === TOOL_REMOVE,
        );
        html += '</div>';
        if (this.tool === TOOL_REMOVE) {
          html += `<div class="hint">Drag a box over field works of yours to take them down (planned ones are refunded) · right click or Esc: done</div>`;
        } else if (this.tool > 0) {
          const n = this.dragFrom >= 0 ? this.dragCells.length : 0;
          const what = WORKS[this.tool].name.toLowerCase();
          html +=
            n > 0
              ? `<div class="hint">${n} × ${what}: <i class="sup">${this.dragCost}</i> · release to order · right click: cancel</div>`
              : `<div class="hint">Drag on the ground to draw a line of ${what} (price is per 4 m) · Shift: keep drawing · right click or Esc: done</div>`;
        }
      } else if (this.tool !== 0) this.cancelTool();
      const held = ids.every((id) => (this.units.task[id] & TASK_HOLD_FIRE) !== 0);
      const u = this.units;
      const has = (test: (kind: number) => boolean) =>
        ids.some((id) => u.isMine(id) && test(u.kindOf(id)));
      html += '<div class="row">';
      html += this.button(
        'amove',
        0,
        'Attack-move',
        null,
        this.armed === 'attack' ? 'click the ground' : 'then click',
        this.armed === 'attack',
        'Advance to a point and fight whatever is met on the way. Press C (or this), then click the ground. Alt + right click does the same.',
        'C',
      );
      html += this.button('stop', 0, 'Stop', null, '', false, 'Halt and drop all orders.', 'X');
      html += this.button(
        'hold',
        0,
        'Hold position',
        null,
        '',
        false,
        'Stay on the spot: shoot what comes into range, never chase.',
        'H',
      );
      html += this.button(
        'fire',
        0,
        held ? 'Fire at will' : 'Hold fire',
        null,
        '',
        false,
        'Hold fire keeps recon teams and ambushes hidden until you say so.',
        'G',
      );
      if (mine) {
        const shape = this.shapeOf(ids.filter((id) => u.isMine(id)));
        const open = DOCTRINE[factionOf(ME)] ?? SHAPE_BLOCK;
        const auto =
          open === SHAPE_BLOCK
            ? 'Now: a plain block (an army without a faction has no formation of its own).'
            : `Now: a convoy on roads and into towns, a ${SHAPES[open].name.toLowerCase()} in open ground.`;
        html += this.button(
          'shape',
          0,
          `Movement: ${shape < 0 ? 'mixed' : SHAPES[shape].name}`,
          null,
          shape === SHAPE_AUTO ? 'by the ground' : shape < 0 ? '' : 'forced',
          shape > SHAPE_AUTO,
          `${shape < 0 ? 'These units move in different ways.' : SHAPES[shape].tip} ${shape === SHAPE_AUTO ? auto : ''} Click to change: Auto, Convoy, Wedge, Line, Vee, Echelon, Block. It applies from their next move order.`,
          ',',
        );
      }
      html += '</div>';
      // What only some units can do. These used to be keys you had to know about.
      let special = '';
      if (has((k) => KINDS[k].engineer)) {
        const p = { supplies: CAMERA_COST, fuel: 0, credits: 0, ticks: 0, tier: 1 };
        special += this.button(
          'camera',
          0,
          'Deploy camera',
          p,
          '',
          false,
          'Each selected engineer squad leaves a hidden surveillance camera where it stands. It watches a small circle and raises an alert when the enemy walks in. 12 at most.',
          'V',
        );
      }
      if (this.builders().length > 0) {
        special += this.button(
          'entrench',
          0,
          'Repair / fortify',
          null,
          this.entrench ? 'right click a building' : 'then right click',
          this.entrench,
          'Right click a building: trucks and engineers mend its walls and structure (costs supplies), then engineers fortify it with sandbags and loopholes. A fortified building holds half as many men again, shelters them better and takes longer to bring down. Engineers also clear street rubble: right click it.',
          'B',
        );
      } else this.entrench = false;
      if (has((k) => KINDS[k].engineer)) {
        special += this.button(
          'demolish',
          0,
          'Demolish',
          null,
          this.demolish ? 'right click a target' : 'then right click',
          this.demolish,
          'Right click what the engineers should bring down. A building or a bridge: they walk up and lay charges (a house takes two squads about ten seconds). A wood: they fell a patch about 20 m across, which opens a lane for vehicles and a field of fire. A wall, wire, obstacle or street rubble: charges and cutters. People still inside a house that comes down are killed, and your army pays for them: charges give no warning.',
          'O',
        );
      } else this.demolish = false;
      if (this.climbers().length > 0) {
        special += this.button(
          'roof',
          0,
          'Roof',
          null,
          this.roof ? 'right click a building' : 'then right click',
          this.roof,
          'Right click a building: the selected squads go up on its roof (those inside it climb up, the rest walk there first). From a roof they see and reach further, a mortar can fire, and rockets hit a vehicle on its thin top plate. But there are no walls round them: they are seen, splinters reach them and machine guns pin them. A roof goes when the building is gutted.',
          'Shift R',
        );
      } else this.roof = false;
      if (ids.some((id) => u.isMine(id) && (u.task[id] & TASK_ROOF) !== 0)) {
        special += this.button(
          'down',
          0,
          'Off the roof',
          null,
          '',
          false,
          'The selected squads on a roof come back down into the building.',
          '',
        );
      }
      if (this.lurkers().length > 0) {
        const waiting = ids.filter((id) => u.isMine(id) && (u.task[id] & TASK_AMBUSH) !== 0);
        special += this.button(
          'ambush',
          0,
          waiting.length > 0 ? `Ambush (${waiting.length} waiting)` : 'Ambush',
          null,
          this.ambush ? 'drag a circle' : 'then drag',
          this.ambush || waiting.length > 0,
          'Press on the ground where vehicles will come and drag out a circle. The selected units stay where they are (in a house, on a roof, in a wood) and hold their fire, and men lying in wait are as hard to see as in a forest. When an enemy vehicle enters the circle, or the enemy finds one of them, every unit waiting on it opens fire at once. Any other order calls it off.',
          'Shift H',
        );
      } else if (this.ambush) this.cancelAmbush();
      if (has((k) => KINDS[k].indirect)) {
        special += this.button(
          'smoke',
          0,
          'Smoke screen',
          null,
          this.armed === 'smoke' ? 'click the ground' : 'then click',
          this.armed === 'smoke',
          'Each selected gun fires one smoke shell at the point you click. Smoke blinds both sides for 30 seconds. F fires at the pointer at once.',
          'F',
        );
        if (this.units.night) {
          special += this.button(
            'flare',
            0,
            'Flare',
            null,
            this.armed === 'flare' ? 'click the ground' : 'then click',
            this.armed === 'flare',
            'The nearest selected gun puts a flare over the point you click. For 30 seconds everything under it is seen as far as by day, yours as well as theirs. I fires at the pointer at once.',
            'I',
          );
        }
      }
      const riders = has((k) => KINDS[k].garrison);
      const carriers = has((k) => KINDS[k].carry > 0);
      if (carriers) {
        if (riders) {
          special += this.button(
            'load',
            0,
            'Mount up',
            null,
            '',
            false,
            'The selected squads climb aboard the selected carriers. Right clicking a carrier does the same.',
            'L',
          );
        }
        special += this.button(
          'unload',
          0,
          'Dismount',
          null,
          '',
          false,
          'The selected carriers put down everyone aboard, here and now.',
          'U',
        );
      }
      if (special !== '') html += `<div class="row">${special}</div>`;
      if (has((k) => KINDS[k].jam > 0)) {
        html += `<div class="hint">Jammer: enemy drones inside its ring fall blind and crash, and enemy cameras in it are blinded and shown to you. It works by itself: park it near what you want covered.</div>`;
      }
      if (has((k) => KINDS[k].carry > 0) && !riders) {
        html += `<div class="hint">Carrier: select squads with it and press L, or right click it with squads selected.</div>`;
      }
    } else {
      if (this.placing >= 0) this.placing = -1;
      if (this.tool !== 0) this.cancelTool();
    }
    if (html !== this.html) {
      this.el.innerHTML = this.html = html;
      this.el.style.display = html === '' ? 'none' : 'block';
    }
  }
}
