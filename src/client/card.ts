import * as THREE from 'three/webgpu';
import {
  CMD_ASSIST,
  CMD_BUILD,
  CMD_CANCEL,
  CMD_GATHER,
  CMD_HOLD,
  CMD_RALLY,
  CMD_RESEARCH,
  CMD_STANCE,
  CMD_STOP,
  CMD_TRAIN,
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
import { canPlace, type GameMap } from '../sim/map';
import { KINDS, KIND_TRUCK } from '../sim/units';
import { STANCE_FREE, STANCE_HOLD_FIRE } from '../sim/world';
import { BASE_STRIDE, TASK_HOLD_FIRE, type Snapshot } from '../worker/protocol';
import type { StructureView } from './structures';
import type { Terrain } from './terrain';
import type { UnitView } from './units';

const CELL = 4;
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

  private trucks(): number[] {
    return this.units.selectedIds().filter((id) => this.units.kindOf(id) === KIND_TRUCK);
  }

  private act(act: string, k: number): void {
    const ids = this.units.selectedIds();
    const s = this.building;
    if (act === 'train') this.send({ type: CMD_TRAIN, structure: s, kind: k });
    else if (act === 'tier') this.send({ type: CMD_RESEARCH, structure: s });
    else if (act === 'cancel') this.send({ type: CMD_CANCEL, structure: s });
    else if (act === 'place') this.placing = k;
    else if (act === 'stop') this.send({ type: CMD_STOP, units: ids });
    else if (act === 'hold') this.send({ type: CMD_HOLD, units: ids });
    else if (act === 'fire') this.toggleFire();
    this.render();
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

  private button(act: string, k: number, label: string, p: Price | null, note = ''): string {
    const locked = p !== null && this.tier < p.tier;
    const off = p !== null && !this.can(p);
    const sub = locked ? `<i class="short">tier ${p.tier}</i>` : p ? this.cost(p) : note;
    return `<button data-act="${act}" data-k="${k}" class="${off ? 'off' : ''}">${label}<span>${sub}</span></button>`;
  }

  private render(): void {
    const res =
      `<i class="sup">Supplies ${this.supplies}</i><i class="fuel">Fuel ${this.fuel}</i>` +
      `<i class="cred">Credits ${this.credits}</i><i>Units ${this.pop}/${this.popCap}</i>` +
      `<i>Tier ${this.tier}</i>`;
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
        if (queued > 0) {
          const names: string[] = [];
          for (let q = 0; q < queued; q++) {
            const item = bases[rec + 8 + q];
            const name = item === TIER_ITEM ? `Tier ${this.tier + 1}` : KINDS[item].name;
            names.push(q === 0 ? `<b>${name} ${bases[rec + 7]}%</b>` : name);
          }
          const waiting = this.pop >= this.popCap && bases[rec + 8] !== TIER_ITEM;
          html += `<div class="queue">${names.join(' · ')}${waiting ? ' <i class="short">unit limit reached: build depots</i>' : ''}</div>`;
        }
        html += '<div class="row">';
        UNIT_PRICE.forEach((p, kind) => {
          if (p.from === type) html += this.button('train', kind, KINDS[kind].name, p);
        });
        const next = TIER_PRICE[this.tier];
        if (type === B_HQ && this.tier < MAX_TIER && next) {
          html += this.button('tier', 0, `Tier ${this.tier + 1}`, { ...next, tier: 0 });
        }
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
      const held = ids.every((id) => (this.units.task[id] & TASK_HOLD_FIRE) !== 0);
      html += '<div class="row">';
      html += this.button('stop', 0, 'Stop', null, 'X');
      html += this.button('hold', 0, 'Hold position', null, 'H');
      html += this.button('fire', 0, held ? 'Fire at will' : 'Hold fire', null, 'G');
      html += '</div>';
    } else if (this.placing >= 0) this.placing = -1;
    if (html !== this.html) {
      this.el.innerHTML = this.html = html;
      this.el.style.display = html === '' ? 'none' : 'block';
    }
  }
}
