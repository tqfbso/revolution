import * as THREE from 'three/webgpu';
import {
  CMD_ASSIST,
  CMD_BUILD,
  CMD_CANCEL,
  CMD_REPEAT,
  CMD_DEMOLISH,
  CMD_FORTIFY,
  CMD_GATHER,
  CMD_HOLD,
  CMD_RALLY,
  CMD_RESEARCH,
  CMD_CAMERA,
  CMD_STANCE,
  CMD_STOP,
  CMD_TRAIN,
  CMD_LOAD,
  CMD_UNLOAD,
  type Command,
} from '../sim/commands';
import {
  BUILDINGS,
  B_HQ,
  MAX_TIER,
  TIER_ITEM,
  TIER_PRICE,
  UNIT_PRICE,
  type Price,
} from '../sim/economy';
import { fx } from '../sim/fixed';
import { MAP_CELLS, canPlace, type GameMap } from '../sim/map';
import { CAMERA_COST, KINDS, KIND_TRUCK, POINTS } from '../sim/units';
import { MAX_ORDER, WORKS, WORK_COUNT, canFortify } from '../sim/works';
import { STANCE_FREE, STANCE_HOLD_FIRE } from '../sim/world';
import {
  BASE_STRIDE,
  TASK_HOLD_FIRE,
  TASK_JOB_MASK,
  TASK_MOVING,
  type Snapshot,
} from '../worker/protocol';
import type { StructureView } from './structures';
import type { Terrain } from './terrain';
import type { UnitView } from './units';
import type { WorksView } from './works';

const CELL = 4;
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
];
const HINT = [
  'Main battle tank. Kills vehicles and breaks walls; weak to missile teams and to infantry up close in streets.',
  'Infantry squad. Cheap and fast to raise. Holds buildings, trenches and forest; rockets hurt vehicles within 8 m.',
  'Missile team. Kills vehicles from beyond gun range. Helpless against infantry: keep riflemen with it.',
  'Infantry fighting vehicle. Carries two squads fast (L to mount, U to dismount) and mows down infantry.',
  'Self-propelled gun. Shells what others have spotted from far behind. Ctrl + right click: shell a spot. F: smoke.',
  'Recon team. Sees far, hard to see, unarmed. Everything else is half blind without it.',
  'Recon drone. Eyes in the sky over hills and houses. Dies to air defence and jammers.',
  'Strike drone. Flies into what it finds, once.',
  'Air-defence vehicle. The only thing that shoots drones down reliably.',
  'Jammer. Enemy drones in its ring crash; enemy cameras in it are blinded and revealed. Works by itself.',
  'Logistics truck. Hauls supplies and fuel, builds and repairs base buildings and field works.',
  "Engineer squad. Builds field works, blows up the enemy's, and leaves surveillance cameras (V).",
];
/** The tool after the kinds of field work: take works down. */
export const TOOL_REMOVE = WORK_COUNT;
const ME = 0;

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
  private html = '';
  private resHtml = '';
  private readonly hadHq = [false, false];
  /**
   * An order waiting for a click on the ground: attack-move or a smoke screen. The input
   * handler reads it and carries it out; `arm` is how both sides change it.
   */
  armed: '' | 'attack' | 'smoke' = '';
  private over = false;

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
    this.group.add(this.ghost, this.outline, this.rally);
    // Act on press, not on click: the card is redrawn as numbers change, and a redraw
    // between press and release would swallow a click.
    el.addEventListener('pointerdown', (e) => {
      const button = (e.target as HTMLElement).closest('button');
      if (!button || button.classList.contains('off')) return;
      e.preventDefault();
      this.act(button.dataset.act ?? '', Number(button.dataset.k ?? 0));
    });
    resEl.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button')) this.selectIdle();
    });
    setInterval(() => this.render(), 200);
  }

  applySnapshot(s: Snapshot): void {
    this.supplies = s.supplies[ME] ?? 0;
    this.fuel = s.fuel[ME] ?? 0;
    this.credits = s.credits[ME] ?? 0;
    this.tier = s.tier[ME] ?? 1;
    this.pop = s.pop[ME] ?? 0;
    this.popCap = s.popCap[ME] ?? 0;
    // The game is decided when a headquarters that stood is gone.
    const standing = [false, false];
    for (let o = 0; o < s.bases.length; o += BASE_STRIDE) {
      const team = s.bases[o + 2];
      if (team < 2 && s.bases[o + 1] === B_HQ && s.structHp[s.bases[o]] > 0) standing[team] = true;
    }
    for (let t = 0; t < 2; t++) {
      if (standing[t]) this.hadHq[t] = true;
      else if (this.hadHq[t] && !this.over) {
        this.over = true;
        this.bannerEl.textContent =
          t === ME
            ? 'Defeat: your headquarters has fallen'
            : 'Victory: the enemy headquarters has fallen';
        this.bannerEl.style.display = 'block';
      }
    }
    if (this.building >= 0 && this.structures.hp[this.building] === 0) this.select(-1);
  }

  arm(mode: '' | 'attack' | 'smoke'): void {
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
    else if (act === 'camera') this.placeCamera();
    else if (act === 'amove') this.arm(this.armed === 'attack' ? '' : 'attack');
    else if (act === 'smoke') this.arm(this.armed === 'smoke' ? '' : 'smoke');
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
    });
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
  order(x: number, z: number, structure: number): boolean {
    if (this.building >= 0 && this.units.selectedCount === 0) {
      const site = this.structures.siteAt(x, z);
      const rx = site >= 0 ? this.map.siteX[site] : fx(x);
      const ry = site >= 0 ? this.map.siteY[site] : fx(z);
      this.send({ type: CMD_RALLY, structure: this.building, x: rx, y: ry });
      return true;
    }
    // Builders on a planned work of yours: go and build it.
    const sappers = this.builders();
    const work = this.works.workAt(x, z);
    if (sappers.length > 0 && work && !work.done && work.team === ME) {
      this.send({ type: CMD_FORTIFY, units: sappers, work: work.kind, cells: [work.cell] });
      return true;
    }
    const crew = this.trucks();
    if (crew.length === 0) return false;
    if (structure >= 0 && this.structures.baseTeam[structure] === this.units.teamOf(crew[0])) {
      this.send({ type: CMD_ASSIST, units: crew, structure });
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
    let res =
      `<i class="sup">Supplies ${this.supplies}</i><i class="fuel">Fuel ${this.fuel}</i>` +
      `<i class="cred">Credits ${this.credits}</i><i>Army ${this.pop}/${this.popCap}</i>` +
      `<i>Tier ${this.tier}</i>`;
    const idle = this.idle().length;
    if (idle > 0) res += `<button>Idle trucks ${idle} (.)</button>`;
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
          const name = item === TIER_ITEM ? `Tier ${this.tier + 1}` : SHORT[item];
          html += `<div class="slot" title="${item === TIER_ITEM ? name : KINDS[item].name}">${name}${q === 0 ? `<b style="width:${bases[rec + 7]}%"></b>` : ''}</div>`;
        }
        html += '</div>';
        const first = bases[rec + 8];
        const waiting = queued > 0 && first !== TIER_ITEM && this.pop + POINTS[first] > this.popCap;
        html += `<div class="note">${waiting ? 'Army limit reached: build supply depots' : ''}</div>`;
        html += '<div class="row">';
        UNIT_PRICE.forEach((p, kind) => {
          if (p.from === type) {
            const pts = POINTS[kind] > 1 ? ` ${POINTS[kind]} pts` : '';
            html += this.button('train', kind, KINDS[kind].name + pts, p, '', false, HINT[kind]);
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
            ? `<div class="hint">Click to place the ${BUILDINGS[this.placing].name.toLowerCase()} (Shift: place several) · right click or Esc: cancel</div>`
            : `<div class="hint">Right click a stockpile or a well: haul from it · right click one of your buildings: build or repair it</div>`;
      }
      if (mine && this.builders().length > 0) {
        html += '<div class="row works">';
        for (let k = 1; k < WORK_COUNT; k++) {
          const w = WORKS[k];
          const p = { supplies: w.supplies, fuel: 0, credits: 0, ticks: w.ticks, tier: 1 };
          html += this.button('work', k, w.name, p, '', this.tool === k);
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
