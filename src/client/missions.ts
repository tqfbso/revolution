// The mission board: the player's sub-commanders on one panel. A commander is given
// troops (the selection, a control group, new units from the factories) and a mission at
// a place; from then on its staff runs them (src/sim/staff.ts) and the board shows how it
// is going: what each is doing, how strong it still is, who is asking for more.
import { ME } from './me';
import { CMD_ASSIGN, CMD_MISSION, CMD_REINFORCE, CMD_STYLE, type Command } from '../sim/commands';
import type { GameMap } from '../sim/map';
import {
  ST_ARRIVED,
  ST_ATTACK,
  ST_DEFEND,
  ST_FALLBACK,
  ST_FOCUS,
  ST_GATHER,
  ST_HOLD,
  ST_IDLE,
  ST_MARCH,
  ST_MASSED,
  ST_MOVE,
  ST_PATROL,
  ST_REGROUP,
  ST_SCREEN,
  ST_SECURED,
} from '../sim/staff';
import { KINDS, KIND_TRUCK } from '../sim/units';
import {
  MAX_COMMANDERS,
  M_ATTACK,
  M_DEFEND,
  M_FOCUS,
  M_HOLD,
  M_MOVE,
  M_NONE,
  M_PATROL,
  M_SCREEN,
} from '../sim/world';
import {
  COMMANDER_AUTO,
  COMMANDER_STYLE_SHIFT,
  COMMANDER_FIGHTING,
  COMMANDER_NEED,
  COMMANDER_STRIDE,
  INFO_INSIDE,
  TASK_MOVING,
  type Snapshot,
} from '../worker/protocol';
import { gridRef } from './grid';
import { COMMANDER_RGB } from './icons';
import type { Posting } from './production';
import { CommanderReports, type Report } from './reports';
import { runTickers, tickHtml } from './ticker';
import type { UnitView } from './units';

export const COMMANDER_NAMES = [
  'Alpha',
  'Bravo',
  'Charlie',
  'Delta',
  'Echo',
  'Foxtrot',
  'Golf',
  'Hotel',
];

const MISSIONS = [
  {
    m: M_ATTACK,
    name: 'Attack',
    ask: 'attack',
    tip: 'Take a place. It forms up, marches as one body, assaults with smoke and guns, then holds what it took. It breaks off if it is losing and waits to be reinforced.',
  },
  {
    m: M_MOVE,
    name: 'Move',
    ask: 'move to',
    tip: 'Go to a place and stand there (T with its troops selected). It does not stop to fight on the way, does not go into the houses and never falls back: for getting a body where you want it. Once there it shoots at what comes at it.',
  },
  {
    m: M_FOCUS,
    name: 'Concentrate',
    ask: 'concentrate',
    tip: 'Everything it has onto one exact spot, now (R with its troops selected). Each unit goes at its own best speed, nobody forms up or waits outside, and the last stretch is fought. They stay massed on the spot and shoot at what they see. It never falls back and does not go into the houses: use it to pile onto a street corner, a breach or one building, then give it its mission again.',
  },
  {
    m: M_HOLD,
    name: 'Hold',
    ask: 'hold',
    tip: 'Hold a place to the last. Infantry goes into the houses, vehicles stand around them. It does not chase and it does not fall back.',
  },
  {
    m: M_DEFEND,
    name: 'Defend',
    ask: 'defend',
    tip: 'Defend an area. It holds the place, goes out to meet an enemy seen around it, gives ground to one far too strong and comes back afterwards.',
  },
  {
    m: M_PATROL,
    name: 'Patrol',
    ask: 'patrol to',
    tip: 'Go back and forth between where it stands now and the place you click, fighting what it meets.',
  },
  {
    m: M_SCREEN,
    name: 'Screen',
    ask: 'screen',
    tip: 'A thin line of lookouts through the place you click, across the way from your base. It warns you and pulls back from anything strong.',
  },
];
/** The mission as the board's first column has it. */
const MISSION_SHORT = [
  'No orders',
  'Attack',
  'Hold',
  'Defend',
  'Patrol',
  'Screen',
  'Move',
  'Concentrate',
];
/** The keys that give a mission without the board. */
const MISSION_KEY: Record<number, string> = { [M_MOVE]: 'T', [M_FOCUS]: 'R' };
const STATUS: Record<number, string> = {
  [ST_IDLE]: 'Awaiting orders',
  [ST_MARCH]: 'On the march',
  [ST_ATTACK]: 'Attacking',
  [ST_SECURED]: 'Objective taken, holding',
  [ST_HOLD]: 'Holding',
  [ST_DEFEND]: 'Defending',
  [ST_PATROL]: 'On patrol',
  [ST_SCREEN]: 'Screening',
  [ST_FALLBACK]: 'Falling back',
  [ST_REGROUP]: 'Regrouping',
  [ST_GATHER]: 'Closing up out of sight, then going in',
  [ST_MOVE]: 'Moving',
  [ST_ARRIVED]: 'In place, awaiting orders',
  [ST_FOCUS]: 'Concentrating',
  [ST_MASSED]: 'Massed on the spot',
};

export interface CommanderInfo {
  slot: number;
  name: string;
  mission: number;
  x: number;
  z: number;
  status: number;
  power: number;
  best: number;
  count: number;
  cx: number;
  cz: number;
  auto: boolean;
  /** How it goes into an attack: 0 together, 1 infantry first, 2 armour first. */
  style: number;
  need: boolean;
  fighting: boolean;
}

export interface BoardHooks {
  lookAt: (x: number, z: number) => void;
  /** Ask the player for a place on the map (or, with null, stop asking). */
  ask: (prompt: string | null, done?: (x: number, z: number) => void) => void;
  /**
   * A commander has something to say. `mine` is false in co-op for a commander another
   * player is running: it is shown if it matters, but not spoken.
   */
  report: (report: Report, mine: boolean) => void;
}

/** Seconds within which a change of orders seen in the game counts as this player's own. */
const MY_ORDER = 6;

/** How a commander goes into an attack (decision 112). The first is the default. */
const STYLES = [
  {
    name: 'together',
    tip: 'Everyone goes in at once. In testing this loses the fewest troops and is the fastest.',
  },
  {
    name: 'infantry first',
    tip: 'Squads lead; vehicles keep 25 m behind until the squads are on the objective. Slower and costs more squads, but keeps tanks away from missile teams in a town.',
  },
  {
    name: 'armour first',
    tip: 'Vehicles lead; squads keep 25 m behind until the vehicles are on the objective. Spares the squads against guns, risks the vehicles against missiles.',
  },
];

export class MissionBoard {
  /** Shown or hidden (M). It is on the screen all the time unless the player hides it. */
  open = true;
  /** The button at the top that shows whether the board is up. */
  button: HTMLElement | null = null;
  readonly info: CommanderInfo[] = [];
  /** The commander whose row is opened up, or -1. */
  private focus = -1;
  private html = '';
  /**
   * Co-op: several players share the commanders. Each hears the ones they gave the last
   * orders to (the game does not record who ordered what, so the board remembers what it
   * sent itself and takes any other change of orders to be somebody else's).
   */
  shared = false;
  private readonly mine = new Array<boolean>(MAX_COMMANDERS).fill(false);
  private readonly orderedAt = new Array<number>(MAX_COMMANDERS).fill(-1e9);
  private readonly reports: CommanderReports;
  private readonly body: HTMLElement;

  constructor(
    private readonly el: HTMLElement,
    private readonly map: GameMap,
    private readonly units: UnitView,
    private readonly send: (command: Command) => void,
    private readonly hooks: BoardHooks,
  ) {
    this.reports = new CommanderReports({
      name: (x, z) => this.spot(x, z),
      there: (c) => this.there(c.x, c.z, c.cx, c.cz),
    });
    for (let slot = 0; slot < MAX_COMMANDERS; slot++) {
      this.info.push({
        slot,
        name: COMMANDER_NAMES[slot],
        mission: M_NONE,
        x: 0,
        z: 0,
        status: ST_IDLE,
        power: 0,
        best: 0,
        count: 0,
        cx: 0,
        cz: 0,
        auto: false,
        style: 0,
        need: false,
        fighting: false,
      });
    }
    el.innerHTML = `<div class="body"></div>`;
    this.body = el.querySelector('.body') as HTMLElement;
    try {
      this.open = localStorage.getItem('revolution.board') !== '0';
    } catch {
      // not remembered: the board is up
    }
    el.style.display = this.open ? 'block' : 'none';
    // Act on press: the board is redrawn under the pointer.
    el.addEventListener('pointerdown', (e) => {
      const button = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
      if (!button) return;
      e.preventDefault();
      this.act(button.dataset.act ?? '', Number(button.dataset.s ?? -1), Number(button.dataset.m));
      this.render();
    });
    setInterval(() => this.render(), 300);
  }

  toggle(open = !this.open): void {
    this.open = open;
    this.el.style.display = open ? 'block' : 'none';
    this.button?.classList.toggle('on', open);
    try {
      localStorage.setItem('revolution.board', open ? '1' : '0');
    } catch {
      // not remembered
    }
    if (!open) this.hooks.ask(null);
    else this.render();
  }

  applySnapshot(s: Snapshot, now = performance.now() / 1000): void {
    for (let slot = 0; slot < MAX_COMMANDERS; slot++) {
      const o = slot * COMMANDER_STRIDE;
      const c = this.info[slot];
      const was = { ...c };
      const flags = s.commanders[o + 9];
      c.mission = s.commanders[o];
      c.x = s.commanders[o + 1];
      c.z = s.commanders[o + 2];
      c.status = s.commanders[o + 3];
      c.power = s.commanders[o + 4];
      c.best = s.commanders[o + 5];
      c.count = s.commanders[o + 6];
      if (c.count > 0) {
        c.cx = s.commanders[o + 7];
        c.cz = s.commanders[o + 8];
      }
      c.auto = (flags & COMMANDER_AUTO) !== 0;
      c.style = (flags >> COMMANDER_STYLE_SHIFT) & 3;
      c.need = (flags & COMMANDER_NEED) !== 0;
      c.fighting = (flags & COMMANDER_FIGHTING) !== 0;
      // New orders, or troops for a commander that had none: whose is it now?
      const ordered = c.mission !== was.mission || c.x !== was.x || c.z !== was.z;
      if (ordered || (c.count > 0 && was.count === 0)) {
        this.mine[slot] = now - this.orderedAt[slot] < MY_ORDER;
      }
      // What the player must hear about, wherever they are looking.
      const mine = !this.shared || this.mine[slot];
      for (const r of this.reports.step(c, was, now)) this.hooks.report(r, mine);
    }
  }

  /** This player has just given commander `slot` orders (or its first troops). */
  private own(slot: number): void {
    this.orderedAt[slot] = performance.now() / 1000;
  }

  /** Commanders new units can be sent to: those with troops or with orders. */
  postings(): Posting[] {
    return this.info
      .filter((c) => c.count > 0 || c.mission !== M_NONE)
      .map((c) => ({ slot: c.slot, name: c.name }));
  }

  /** The living units of commander `slot`. */
  members(slot: number): number[] {
    const u = this.units;
    const out: number[] = [];
    for (let i = 0; i < u.count; i++) if (u.isMine(i) && u.cmdr[i] === slot) out.push(i);
    return out;
  }

  /** Fighting units standing about with no commander and nothing to do. */
  idle(): number[] {
    const u = this.units;
    const out: number[] = [];
    for (let i = 0; i < u.count; i++) {
      if (!u.isMine(i) || u.cmdr[i] >= 0 || u.kindOf(i) === KIND_TRUCK) continue;
      if ((u.task[i] & TASK_MOVING) !== 0 || (u.info[i] & INFO_INSIDE) !== 0) continue;
      if (u.isFiring(i) || !KINDS[u.kindOf(i)].damage.some((d) => d > 0)) continue;
      out.push(i);
    }
    return out;
  }

  /** Put the selection under the first commander that has no troops. Returns it, or -1. */
  newFromSelection(): number {
    if (this.units.selectedCount === 0) return -1;
    const free = this.info.find((c) => c.count === 0);
    if (!free) return -1;
    this.own(free.slot);
    this.send({ type: CMD_ASSIGN, units: this.units.selectedIds(), slot: free.slot });
    // A new command starts with no orders, whatever the last holder of the name had.
    this.send({ type: CMD_MISSION, team: ME, slot: free.slot, mission: M_NONE, x: 0, y: 0 });
    this.focus = free.slot;
    this.toggle(true);
    return free.slot;
  }

  /**
   * T and R: tell a commander to move, or to concentrate on a spot, without opening the
   * board. The commander is the one whose troops are selected, or else the one opened on
   * the board. False if there is none.
   */
  quickMove(mission = M_MOVE): boolean {
    const u = this.units;
    let slot = -1;
    for (const id of u.selectedIds()) {
      if (u.cmdr[id] >= 0) {
        slot = u.cmdr[id];
        break;
      }
    }
    if (slot < 0 && this.open) slot = this.focus;
    if (slot < 0 || this.info[slot].count === 0) return false;
    this.act('mission', slot, mission);
    return true;
  }

  /** The name of the town a point is in, or a rough map reference. */
  place(x: number, z: number): string {
    const map = this.map;
    for (let t = 0; t < map.townCount; t++) {
      const dx = map.townX[t] / 1024 - x;
      const dz = map.townY[t] / 1024 - z;
      const r = map.townR[t] / 1024 + 15;
      if (dx * dx + dz * dz < r * r) return map.townName[t];
    }
    return `grid ${gridRef(x, z)}`;
  }

  /** A place as a commander says it: the town with its grid square, or the square alone. */
  spot(x: number, z: number): string {
    const place = this.place(x, z);
    return place.startsWith('grid ') ? place : `${place}, ${gridRef(x, z)}`;
  }

  /** Is a body centred on (cx, cz) at the place (x, z): in that town, or within 60 of it? */
  there(x: number, z: number, cx: number, cz: number): boolean {
    const map = this.map;
    for (let t = 0; t < map.townCount; t++) {
      const tx = map.townX[t] / 1024;
      const tz = map.townY[t] / 1024;
      const r = map.townR[t] / 1024 + 15;
      if ((tx - x) ** 2 + (tz - z) ** 2 < r * r) return (tx - cx) ** 2 + (tz - cz) ** 2 < r * r;
    }
    return (x - cx) ** 2 + (z - cz) ** 2 < 60 * 60;
  }

  private act(act: string, slot: number, mission: number): void {
    const u = this.units;
    const c = this.info[slot];
    if (act === 'close') this.toggle(false);
    else if (act === 'new') this.newFromSelection();
    else if (act === 'open') {
      this.focus = this.focus === slot ? -1 : slot;
      const ids = this.members(slot);
      u.setSelected(ids, false);
    } else if (act === 'jump') this.hooks.lookAt(c.cx, c.cz);
    else if (act === 'add') {
      if (c.count === 0) this.own(slot);
      this.send({ type: CMD_ASSIGN, units: u.selectedIds(), slot });
    } else if (act === 'mission') {
      const def = MISSIONS.find((d) => d.m === mission);
      if (!def) return;
      this.hooks.ask(`Click the map: where should ${c.name} ${def.ask}? (Esc cancels)`, (x, z) => {
        this.own(slot);
        this.send({
          type: CMD_MISSION,
          team: ME,
          slot,
          mission,
          x: Math.round(x * 1024),
          y: Math.round(z * 1024),
        });
      });
    } else if (act === 'stand') {
      this.own(slot);
      this.send({ type: CMD_MISSION, team: ME, slot, mission: M_NONE, x: 0, y: 0 });
    } else if (act === 'auto') {
      this.send({ type: CMD_REINFORCE, team: ME, slot, on: !c.auto });
      c.auto = !c.auto;
    } else if (act === 'style') {
      c.style = (c.style + 1) % STYLES.length;
      this.send({ type: CMD_STYLE, team: ME, slot, style: c.style });
    } else if (act === 'disband') {
      this.send({ type: CMD_MISSION, team: ME, slot, mission: -1, x: 0, y: 0 });
      this.focus = -1;
    } else if (act === 'idle') {
      const ids = this.idle();
      u.setSelected(ids, false);
      const at = u.centreOf(ids);
      if (at) this.hooks.lookAt(at.x, at.z);
    } else if (act === 'absorb') this.absorb();
  }

  /** Every idle unit goes to the commander whose troops are nearest to it. */
  private absorb(): void {
    const u = this.units;
    const active = this.info.filter((c) => c.count > 0);
    if (active.length === 0) return;
    const lists = new Map<number, number[]>();
    for (const id of this.idle()) {
      const x = u.renderPos[3 * id];
      const z = u.renderPos[3 * id + 2];
      let best = active[0];
      let bestD = Infinity;
      for (const c of active) {
        const d = (c.cx - x) * (c.cx - x) + (c.cz - z) * (c.cz - z);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      const list = lists.get(best.slot);
      if (list) list.push(id);
      else lists.set(best.slot, [id]);
    }
    for (const [slot, units] of lists) this.send({ type: CMD_ASSIGN, units, slot });
  }

  private render(): void {
    if (!this.open) return;
    const u = this.units;
    const active = this.info.filter((c) => c.count > 0 || c.mission !== M_NONE);
    const picked = u.selectedIds();
    const free = this.info.some((c) => c.count === 0);
    let html = '';
    if (active.length === 0) {
      html +=
        '<p class="hint">No commanders yet. Select troops and press <kbd>N</kbd>: they get a commander. Give it a mission and it runs them for you: it marches, attacks, holds, falls back and asks for more by itself.</p>';
    } else {
      html +=
        '<div class="cols"><span></span><span>Mission</span><span>Objective and state</span><span>Grid</span><span>Strength</span><span class="r">Units</span></div>';
    }
    for (const c of active) {
      const pct = c.best > 0 ? Math.min(100, Math.round((c.power * 100) / c.best)) : 0;
      const tone = c.status === ST_FALLBACK || pct < 45 ? 'bad' : c.need ? 'warn' : 'ok';
      const notes = [(STATUS[c.status] ?? '').toLowerCase()];
      if (c.fighting && c.status !== ST_ATTACK) notes.push('in contact');
      if (c.need) notes.push(c.auto ? 'replacements on order' : 'needs reinforcements');
      // Where it is going if it has orders, where it stands if it has none.
      const ordered = c.mission !== M_NONE;
      const place = ordered ? this.place(c.x, c.z).replace(/^grid /, 'Grid ') : '';
      const sq = ordered ? gridRef(c.x, c.z) : c.count > 0 ? gridRef(c.cx, c.cz) : '';
      const rgb = COMMANDER_RGB[c.slot].map((v) => Math.round(v * 255)).join(',');
      html +=
        `<div class="cmd ${tone}${this.focus === c.slot ? ' open' : ''}" data-act="open" data-s="${c.slot}" title="${c.name}. Click: select its troops and show its orders. The colour is the pennant its troops carry">` +
        `<i class="chip" style="background:rgb(${rgb})">${c.name[0]}</i>` +
        `<b>${MISSION_SHORT[c.mission]}</b>` +
        tickHtml(`cmd${c.slot}`, `${place} <i>${notes.filter((n) => n !== '').join(', ')}</i>`) +
        `<span class="sq">${sq}</span>` +
        `<span class="str"><span class="bar"><i style="width:${pct}%"></i></span><em>${pct}%</em></span>` +
        `<span class="n">${c.count}</span>` +
        `</div>`;
    }
    // The orders of the commander whose row is open, under the table.
    const c = active.find((a) => a.slot === this.focus);
    if (c) {
      html += `<div class="orders first"><span>${c.name}</span>`;
      for (const d of MISSIONS) {
        const key = MISSION_KEY[d.m] ? ` <kbd>${MISSION_KEY[d.m]}</kbd>` : '';
        html += `<button data-act="mission" data-s="${c.slot}" data-m="${d.m}" title="${d.tip}"${c.mission === d.m ? ' class="on"' : ''}>${d.name}${key}</button>`;
      }
      html +=
        `</div><div class="orders">` +
        `<button data-act="jump" data-s="${c.slot}" title="Look at its troops">Go to</button>` +
        `<button data-act="style" data-s="${c.slot}" title="${STYLES[c.style].tip} Click to change.">Attack: ${STYLES[c.style].name}</button>` +
        `<button data-act="auto" data-s="${c.slot}" title="Replace losses: what ${c.name} loses is ordered again from your factories and sent to it, as money allows">Replace losses: ${c.auto ? 'on' : 'off'}</button>` +
        `<button data-act="stand" data-s="${c.slot}" title="Stop where it is and wait for orders">Stand down</button>` +
        `<button data-act="disband" data-s="${c.slot}" title="Its troops go back under your own orders">Disband</button>` +
        `</div>`;
    }
    // Troops selected that are not some commander's: one click puts them under it.
    const joinable = active.filter((a) => picked.some((id) => u.cmdr[id] !== a.slot));
    if (picked.length > 0 && joinable.length > 0) {
      html += `<div class="orders"><span>Add ${picked.length} selected to</span>`;
      for (const a of joinable) {
        html += `<button data-act="add" data-s="${a.slot}" title="Put the selected units under ${a.name}. New arrivals join its body when they catch up with it">${a.name}</button>`;
      }
      html += '</div>';
    }
    const idle = this.idle().length;
    html += '<div class="foot"><span>';
    if (idle > 0) {
      html +=
        `${idle} idle unit${idle === 1 ? '' : 's'}` +
        `<button data-act="idle" title="Units with no commander and nothing to do. Select them and look at them">Select</button>` +
        `<button data-act="absorb" title="Each joins the commander whose troops are nearest"${active.some((a) => a.count > 0) ? '' : ' disabled'}>Give to nearest</button>`;
    }
    html += `</span><span><button data-act="new" title="The selected units get a commander of their own. An order you give a unit yourself takes it out of its commander's hands; to put it back, select it and add it to the commander"${u.selectedCount === 0 || !free ? ' disabled' : ''}>New commander <kbd>N</kbd></button></span></div>`;
    if (html !== this.html) {
      this.body.innerHTML = this.html = html;
      runTickers(this.body);
    }
  }
}
