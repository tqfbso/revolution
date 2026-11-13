import * as THREE from 'three/webgpu';
import {
  CMD_ATTACK,
  CMD_ATTACK_MOVE,
  CMD_BOMBARD,
  CMD_BREACH,
  CMD_HOLD,
  CMD_ATTACK_STRUCTURE,
  CMD_GARRISON,
  CMD_LOAD,
  CMD_MOVE,
  CMD_OCCUPY,
  CMD_STOP,
  CMD_UNLOAD,
  type Command,
} from '../sim/commands';
import { S_BUILDING } from '../sim/map';
import { KINDS } from '../sim/units';
import type { CommandCard } from './card';
import type { StructureView } from './structures';
import { fx } from '../sim/fixed';
import type { Terrain } from './terrain';
import type { UnitView } from './units';
import { WORK_SANDBAG, WORK_TRENCH, canBreach } from '../sim/works';
import type { WorksView } from './works';

const CLICK_SLOP_PX = 5;
const CLICK_PICK_PX = 22;
const DOUBLE_MS = 350;

/**
 * Turns mouse and keyboard into selection (client-only state) and commands (sent to the sim).
 * Left drag: box select. Left click: select one. Double click (or Ctrl + click): everything
 * of that type on screen. Shift: add. Right click the ground: move (units fire on the way
 * but do not stop, so a fight can always be broken off). Right click an enemy: attack it.
 * C then left click (or Alt + right click): attack-move, fight whatever is met on the way.
 * Right click a building: infantry moves in.
 * Ctrl + right click a building or bridge: shell it. Ctrl + right click the ground: guns
 * shell that spot. Right click one of your carriers, or L
 * with squads and carriers selected: mount up. U: dismount. Ctrl/Alt + 1..9: save the selection as a
 * control group; 1..9: recall it; twice: jump the camera to it.
 */
export class Input {
  readonly marker: THREE.Mesh;
  private dragStart: { x: number; y: number } | null = null;
  private markerAge = 1;
  /** With `?control=all` every army can be selected and ordered (sandbox). */
  controlAll = false;
  private readonly groups: { id: number; gen: number }[][] = [];
  private lastClick = { time: 0, x: 0, y: 0 };
  private lastGroup = { time: 0, n: -1 };
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
    private readonly lookAt: (x: number, z: number) => void,
    private readonly structures: StructureView,
    private readonly card: CommandCard,
    private readonly works: WorksView,
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
      if (this.pick) {
        // Someone asked for a place on the map: a left click gives it, anything else calls
        // it off.
        const done = this.pick;
        this.ask(null);
        const { ground } = this.structureAt(e.clientX, e.clientY);
        if (e.button === 0 && ground) {
          done(ground.x, ground.z);
          this.mark(ground.x, ground.y + 0.15, ground.z);
        }
      } else if (card.placing >= 0) {
        // Placing a building: left click puts it down, anything else calls it off.
        if (e.button === 0) card.confirm(e.shiftKey);
        else card.cancelPlacing();
      } else if (card.tool !== 0) {
        // A field-work tool in hand: left drag draws, anything else puts the tool away.
        const { ground } = this.structureAt(e.clientX, e.clientY);
        if (e.button === 0 && ground) {
          card.toolDown(ground.x, ground.z);
          this.drawing = true;
          dom.setPointerCapture(e.pointerId);
        } else card.cancelTool();
      } else if (e.button === 0 && card.armed === 'smoke') {
        card.arm('');
        this.smokeAt(e.clientX, e.clientY);
      } else if (e.button === 0 && this.attackMoveArmed) {
        // C, then left click: attack-move to the spot.
        this.armAttackMove(false);
        this.orderMove(e.clientX, e.clientY, true, false);
      } else if (e.button === 0) {
        this.dragStart = { x: e.clientX, y: e.clientY };
        dom.setPointerCapture(e.pointerId);
      } else if (e.button === 2) {
        const attackMove = e.altKey || this.attackMoveArmed;
        card.arm('');
        this.orderMove(e.clientX, e.clientY, attackMove, e.ctrlKey || e.metaKey);
      }
    });
    dom.addEventListener('pointermove', (e) => {
      this.pointerX = e.clientX;
      this.pointerY = e.clientY;
      if (card.placing >= 0 || card.tool !== 0) {
        const { ground } = this.structureAt(e.clientX, e.clientY);
        if (ground && card.placing >= 0) card.hover(ground.x, ground.z);
        else if (ground) card.toolHover(ground.x, ground.z);
      }
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
      if (e.button === 0 && this.drawing) {
        this.drawing = false;
        card.toolUp(e.shiftKey);
        return;
      }
      if (e.button !== 0 || !this.dragStart) return;
      const s = this.dragStart;
      this.dragStart = null;
      this.box.style.display = 'none';
      this.select(s.x, s.y, e.clientX, e.clientY, e.shiftKey, e.ctrlKey || e.metaKey);
    });
    window.addEventListener('keydown', (e) => {
      const digit = /^Digit[0-9]$/.test(e.code) ? Number(e.code[5]) : -1;
      if (digit >= 0) {
        e.preventDefault();
        this.controlGroup(digit, e.ctrlKey || e.altKey || e.metaKey, e.shiftKey);
      } else if (e.code === 'Escape' && this.pick) {
        this.ask(null);
      } else if (e.code === 'Escape') {
        card.arm('');
        this.drawing = false;
        if (card.placing >= 0) card.cancelPlacing();
        else if (card.tool !== 0) card.cancelTool();
        else {
          units.setSelected([], false);
          card.select(-1);
        }
      } else if (e.code === 'KeyC' && !e.ctrlKey && !e.metaKey && units.selectedCount > 0) {
        this.armAttackMove(!this.attackMoveArmed);
      } else if (e.code === 'KeyG' && units.selectedCount > 0) card.toggleFire();
      else if (e.code === 'KeyV' && units.selectedCount > 0) card.placeCamera();
      else if (e.code === 'KeyB' && units.selectedCount > 0) card.armEntrench();
      else if (e.code === 'Period') card.selectIdle();
      else if (e.code === 'KeyA' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        units.setSelected(
          range(units.count).filter((i) => this.mayCommand(i)),
          false,
        );
      } else if (e.code === 'KeyX' && units.selectedCount > 0) {
        send({ type: CMD_STOP, units: units.selectedIds() });
      } else if (e.code === 'KeyH' && units.selectedCount > 0) {
        send({ type: CMD_HOLD, units: units.selectedIds() });
      } else if (e.code === 'KeyF' && units.selectedCount > 0) {
        // Smoke: each selected gun puts one smoke shell where the pointer is.
        this.smokeAt(this.pointerX, this.pointerY);
      } else if (e.code === 'KeyU' && units.selectedCount > 0) {
        send({ type: CMD_UNLOAD, units: units.selectedIds().filter((id) => units.load[id] > 0) });
      } else if (e.code === 'KeyL' && units.selectedCount > 0) {
        card.mount();
      }
    });
  }

  /** After pressing C: the next left or right click is an attack-move. */
  private get attackMoveArmed(): boolean {
    return this.card.armed === 'attack';
  }
  private armAttackMove(on: boolean): void {
    if (on || this.card.armed === 'attack') this.card.arm(on ? 'attack' : '');
  }

  /** Each selected gun puts one smoke shell on the ground under a screen point. */
  private smokeAt(clientX: number, clientY: number): void {
    const units = this.units;
    const guns = units.selectedIds().filter((id) => KINDS[units.kindOf(id)].indirect);
    const { ground } = this.structureAt(clientX, clientY);
    if (guns.length > 0 && ground) {
      this.send({ type: CMD_BOMBARD, units: guns, x: fx(ground.x), y: fx(ground.z), smoke: true });
      this.mark(ground.x, ground.y + 0.15, ground.z);
    }
  }

  private pointerX = 0;
  private pointerY = 0;
  /** A line of field works is being drawn (see the card's tool). */
  private drawing = false;

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

  private mayCommand(id: number): boolean {
    return this.controlAll ? this.units.isAlive(id) : this.units.isMine(id);
  }

  /** The living members of control group `n`. */
  groupIds(n: number): number[] {
    const u = this.units;
    return (this.groups[n] ?? [])
      .filter((m) => u.isAlive(m.id) && u.gen[m.id] === m.gen)
      .map((m) => m.id);
  }

  /** Save the selection as the first group number that is free. Returns it, or -1. */
  saveNewGroup(): number {
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 0]) {
      if (this.groupIds(n).length > 0) continue;
      this.controlGroup(n, true, false);
      return n;
    }
    return -1;
  }

  /** Select control group `n` (as the number key does); twice quickly looks at it. */
  recallGroup(n: number, additive: boolean): void {
    this.controlGroup(n, false, additive);
  }

  private controlGroup(n: number, assign: boolean, additive: boolean): void {
    const u = this.units;
    if (assign) {
      // Ctrl + number saves the selection as the group; with Shift it joins the group.
      const keep = additive ? this.groupIds(n).filter((id) => !u.selected[id]) : [];
      this.groups[n] = [...keep, ...u.selectedIds()].map((id) => ({ id, gen: u.gen[id] }));
      return;
    }
    // Drop members that died (a reused slot has a different generation).
    const ids = (this.groups[n] ?? [])
      .filter((m) => u.isAlive(m.id) && u.gen[m.id] === m.gen)
      .map((m) => m.id);
    if (ids.length === 0) return;
    u.setSelected(ids, additive);
    const now = performance.now();
    if (this.lastGroup.n === n && now - this.lastGroup.time < DOUBLE_MS) {
      const c = u.centreOf(ids);
      if (c) this.lookAt(c.x, c.z);
    }
    this.lastGroup = { time: now, n };
  }

  private select(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    additive: boolean,
    sameType: boolean,
  ): void {
    const rect = this.dom.getBoundingClientRect();
    const isClick = Math.abs(x1 - x0) < CLICK_SLOP_PX && Math.abs(y1 - y0) < CLICK_SLOP_PX;
    const minX = Math.min(x0, x1);
    const maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1);
    const maxY = Math.max(y0, y1);
    const pos = this.units.renderPos;
    const picked: number[] = [];
    const onScreen: number[] = [];
    let best = -1;
    let bestD = CLICK_PICK_PX * CLICK_PICK_PX;
    for (let i = 0; i < this.units.count; i++) {
      if (!this.mayCommand(i)) continue;
      this.v.set(pos[3 * i], pos[3 * i + 1] + 0.5, pos[3 * i + 2]).project(this.camera);
      if (this.v.z < -1 || this.v.z > 1) continue;
      const sx = rect.left + (this.v.x * 0.5 + 0.5) * rect.width;
      const sy = rect.top + (-this.v.y * 0.5 + 0.5) * rect.height;
      if (Math.abs(this.v.x) <= 1 && Math.abs(this.v.y) <= 1) onScreen.push(i);
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
    if (isClick && best >= 0) {
      const now = performance.now();
      const last = this.lastClick;
      const double =
        now - last.time < DOUBLE_MS && Math.abs(last.x - x1) < 8 && Math.abs(last.y - y1) < 8;
      this.lastClick = { time: now, x: x1, y: y1 };
      if (double || sameType) {
        // Everything of the same type and army that is on screen.
        const u = this.units;
        for (const i of onScreen) {
          if (u.kindOf(i) === u.kindOf(best) && u.teamOf(i) === u.teamOf(best)) picked.push(i);
        }
      } else picked.push(best);
    } else if (isClick) {
      // Clicking a house selects the squads you have inside it; one of your base
      // buildings, the building itself.
      const s = this.structureAt(x1, y1).structure;
      const owner = s >= 0 ? this.structures.baseTeam[s] : -1;
      if (owner >= 0 && (this.controlAll || owner === this.units.playerTeam)) {
        this.units.setSelected([], false);
        this.card.select(s);
        return;
      }
      if (s >= 0) {
        for (let i = 0; i < this.units.count; i++) {
          if (this.mayCommand(i) && this.units.insideOf(i) === s) picked.push(i);
        }
      }
    }
    this.card.select(-1);
    this.units.setSelected(picked, additive);
  }

  /** Waiting for a click on the map (see `ask`). */
  private pick: ((x: number, z: number) => void) | null = null;
  /** Set by the client: shows (or, with null, clears) the line that says what is asked. */
  prompt: (text: string | null) => void = () => {};

  /** Ask the player for a place: the next left click on the map (or minimap) goes to `done`. */
  ask(text: string | null, done?: (x: number, z: number) => void): void {
    this.pick = text !== null && done ? done : null;
    this.prompt(this.pick ? text : null);
    this.dom.style.cursor = this.pick ? 'crosshair' : '';
  }

  /** A click on the minimap while a place is asked for. True if it was taken. */
  pickAt(x: number, z: number): boolean {
    if (!this.pick) return false;
    const done = this.pick;
    this.ask(null);
    done(x, z);
    return true;
  }

  /** What is under a screen point: the ground point, and a standing structure if any. */
  private structureAt(
    clientX: number,
    clientY: number,
  ): { ground: THREE.Vector3 | null; structure: number } {
    const rect = this.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.ray.setFromCamera(ndc, this.camera);
    const { origin, direction } = this.ray.ray;
    const ground = this.terrain.raycast(origin, direction, this.hit);
    const reach = ground ? origin.distanceTo(ground) : 1200;
    return { ground, structure: this.structures.pick(origin, direction, reach) };
  }

  /** Tells the player something about an order just given, at a place (set by the client). */
  say: (text: string, x: number, z: number) => void = () => {};

  private enemyBase(structure: number): boolean {
    const team = this.structures.baseTeam[structure];
    return team >= 0 && team !== this.units.playerTeam && !this.controlAll;
  }

  private orderMove(clientX: number, clientY: number, attack: boolean, shell: boolean): void {
    const { ground, structure } = this.structureAt(clientX, clientY);
    // The card first: a rally point for a building, or trucks sent to haul or to build.
    if (ground && !shell && this.card.order(ground.x, ground.z, structure)) {
      this.mark(ground.x, ground.y + 0.15, ground.z);
      return;
    }
    if (this.units.selectedCount === 0) return;
    const ids = this.units.selectedIds();
    // An enemy base building is attacked on a plain right click; a house or a bridge only
    // with Ctrl held (a plain click on a house sends the infantry in).
    if (structure >= 0 && (shell || this.enemyBase(structure))) {
      this.send({ type: CMD_ATTACK_STRUCTURE, units: ids, structure });
      const c = this.structures.centreOf(structure);
      this.mark(c.x, this.structures.topOf(structure) + 0.2, c.z);
      if (!ids.some((id) => KINDS[this.units.kindOf(id)].siege > 0)) {
        this.say(
          'Nothing selected can damage buildings: send infantry, engineers, tanks or guns',
          c.x,
          c.z,
        );
      }
      return;
    }
    if (structure >= 0 && this.terrain.map.sKind[structure] === S_BUILDING) {
      // Infantry goes in; whatever else is selected moves up beside the house.
      const foot = ids.filter((id) => KINDS[this.units.kindOf(id)].garrison);
      if (foot.length > 0) {
        this.send({ type: CMD_GARRISON, units: foot, structure });
        const c = this.structures.centreOf(structure);
        this.mark(c.x, this.structures.topOf(structure) + 0.2, c.z);
        const rest = ids.filter((id) => !KINDS[this.units.kindOf(id)].garrison);
        if (rest.length > 0 && ground) {
          this.send({
            type: attack ? CMD_ATTACK_MOVE : CMD_MOVE,
            units: rest,
            x: fx(ground.x),
            y: fx(ground.z),
          });
        }
        return;
      }
    }
    if (shell && ground) {
      // Guns shell the spot, seen or not. Nothing else in the selection takes the order.
      const guns = ids.filter((id) => KINDS[this.units.kindOf(id)].indirect);
      if (guns.length > 0) {
        this.send({ type: CMD_BOMBARD, units: guns, x: fx(ground.x), y: fx(ground.z) });
        this.mark(ground.x, ground.y + 0.15, ground.z);
        return;
      }
    }
    // An enemy unit under the pointer: armed units attack it, guns shell where it stands,
    // the rest just move there.
    const enemy = this.enemyAt(clientX, clientY);
    if (enemy >= 0) {
      const armed = ids.filter((id) => {
        const k = KINDS[this.units.kindOf(id)];
        return !k.indirect && k.damage.some((d) => d > 0) && k.damage[this.units.kindOf(enemy)] > 0;
      });
      const guns = ids.filter((id) => KINDS[this.units.kindOf(id)].indirect);
      if (armed.length > 0) this.send({ type: CMD_ATTACK, units: armed, target: enemy });
      const p = this.units.renderPos;
      const ex = p[3 * enemy];
      const ez = p[3 * enemy + 2];
      if (guns.length > 0) {
        this.send({ type: CMD_BOMBARD, units: guns, x: fx(ex), y: fx(ez) });
      }
      const rest = ids.filter((id) => !armed.includes(id) && !guns.includes(id));
      if (rest.length > 0) this.send({ type: CMD_MOVE, units: rest, x: fx(ex), y: fx(ez) });
      this.mark(ex, p[3 * enemy + 1] + 0.2, ez);
      return;
    }
    // A field work under the pointer. The enemy's: whoever can, brings it down (guns shell
    // it). A trench or sandbags, whoever dug them: infantry takes position in them.
    const work = ground ? this.works.workAt(ground.x, ground.z) : null;
    if (work && work.done && ground) {
      const u = this.units;
      const cover = work.kind === WORK_TRENCH || work.kind === WORK_SANDBAG;
      const foot = ids.filter((id) => KINDS[u.kindOf(id)].garrison);
      const gx = fx((work.cell % 256) * 4 + 2);
      const gy = fx(Math.floor(work.cell / 256) * 4 + 2);
      if (cover && foot.length > 0 && !shell) {
        this.send({ type: CMD_OCCUPY, units: foot, x: gx, y: gy });
        const rest = ids.filter((id) => !foot.includes(id));
        if (rest.length > 0) {
          this.send({ type: attack ? CMD_ATTACK_MOVE : CMD_MOVE, units: rest, x: gx, y: gy });
        }
        this.mark(ground.x, ground.y + 0.15, ground.z);
        return;
      }
      const able = ids.filter((id) => canBreach(KINDS[u.kindOf(id)], work.kind));
      if (work.team !== u.playerTeam && able.length > 0) {
        this.send({ type: CMD_BREACH, units: able, x: gx, y: gy });
        this.mark(ground.x, ground.y + 0.6, ground.z);
        return;
      }
    }
    // On one of your carriers: the selected squads climb aboard.
    const carrier = this.carrierAt(clientX, clientY);
    const squads = ids.filter((id) => KINDS[this.units.kindOf(id)].garrison);
    if (carrier >= 0 && squads.length > 0) {
      this.send({ type: CMD_LOAD, units: squads, carriers: [carrier] });
      const p = this.units.renderPos;
      this.mark(p[3 * carrier], p[3 * carrier + 1] + 0.2, p[3 * carrier + 2]);
      return;
    }
    if (!ground) return;
    this.orderTo(ground.x, ground.z, attack);
  }

  /** A visible enemy unit under a screen point (the nearest to it), or -1. */
  private enemyAt(clientX: number, clientY: number): number {
    const rect = this.dom.getBoundingClientRect();
    const pos = this.units.renderPos;
    let best = -1;
    let bestD = CLICK_PICK_PX * CLICK_PICK_PX;
    for (let i = 0; i < this.units.count; i++) {
      if (!this.units.isTargetable(i)) continue;
      this.v.set(pos[3 * i], pos[3 * i + 1] + 0.5, pos[3 * i + 2]).project(this.camera);
      if (this.v.z < -1 || this.v.z > 1) continue;
      const sx = rect.left + (this.v.x * 0.5 + 0.5) * rect.width;
      const sy = rect.top + (-this.v.y * 0.5 + 0.5) * rect.height;
      const d = (sx - clientX) * (sx - clientX) + (sy - clientY) * (sy - clientY);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /** The player's carrier under a screen point, or -1. */
  private carrierAt(clientX: number, clientY: number): number {
    const rect = this.dom.getBoundingClientRect();
    const pos = this.units.renderPos;
    let best = -1;
    let bestD = CLICK_PICK_PX * CLICK_PICK_PX;
    for (let i = 0; i < this.units.count; i++) {
      if (!this.mayCommand(i) || KINDS[this.units.kindOf(i)].carry === 0) continue;
      this.v.set(pos[3 * i], pos[3 * i + 1] + 0.5, pos[3 * i + 2]).project(this.camera);
      if (this.v.z < -1 || this.v.z > 1) continue;
      const sx = rect.left + (this.v.x * 0.5 + 0.5) * rect.width;
      const sy = rect.top + (-this.v.y * 0.5 + 0.5) * rect.height;
      const d = (sx - clientX) * (sx - clientX) + (sy - clientY) * (sy - clientY);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  private mark(x: number, y: number, z: number): void {
    this.marker.position.set(x, y, z);
    this.marker.visible = true;
    this.markerAge = 0;
  }

  /** Order the selection to a ground point (also used by the minimap). */
  orderTo(x: number, z: number, attack: boolean): void {
    if (this.units.selectedCount === 0) return;
    // Float -> fixed happens here, once, at the sim boundary. The command carries integers.
    this.send({
      type: attack ? CMD_ATTACK_MOVE : CMD_MOVE,
      units: this.units.selectedIds(),
      x: fx(x),
      y: fx(z),
    });
    this.mark(x, this.terrain.heightAt(x, z) + 0.15, z);
  }
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}
