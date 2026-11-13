// The mission board: the player's sub-commanders on one panel. A commander is given
// troops (the selection, a control group, new units from the factories) and a mission at
// a place; from then on its staff runs them (src/sim/staff.ts) and the board shows how it
// is going: what each is doing, how strong it still is, who is asking for more.
import { CMD_ASSIGN, CMD_MISSION, CMD_REINFORCE, type Command } from '../sim/commands';
import type { GameMap } from '../sim/map';
import {
  ST_ATTACK,
  ST_DEFEND,
  ST_FALLBACK,
  ST_HOLD,
  ST_IDLE,
  ST_MARCH,
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
  M_HOLD,
  M_NONE,
  M_PATROL,
  M_SCREEN,
} from '../sim/world';
import {
  COMMANDER_AUTO,
  COMMANDER_FIGHTING,
  COMMANDER_NEED,
  COMMANDER_STRIDE,
  INFO_INSIDE,
  TASK_MOVING,
  type Snapshot,
} from '../worker/protocol';
import type { Posting } from './production';
import type { UnitView } from './units';

const ME = 0;

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
const MISSION_NAME = ['No orders', 'Attack', 'Hold', 'Defend', 'Patrol to', 'Screen'];
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
  need: boolean;
  fighting: boolean;
}

export interface BoardHooks {
  lookAt: (x: number, z: number) => void;
  /** Ask the player for a place on the map (or, with null, stop asking). */
  ask: (prompt: string | null, done?: (x: number, z: number) => void) => void;
  alert: (text: string, x: number, z: number) => void;
}

export class MissionBoard {
  open = false;
  readonly info: CommanderInfo[] = [];
  /** The commander whose row is opened up, or -1. */
  private focus = -1;
  private html = '';
  private readonly body: HTMLElement;

  constructor(
    private readonly el: HTMLElement,
    private readonly map: GameMap,
    private readonly units: UnitView,
    private readonly send: (command: Command) => void,
    private readonly hooks: BoardHooks,
  ) {
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
        need: false,
        fighting: false,
      });
    }
    el.innerHTML =
      `<div class="head"><b>Commanders</b><button data-act="close">Close <kbd>M</kbd></button></div>` +
      `<div class="body"></div>`;
    this.body = el.querySelector('.body') as HTMLElement;
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
    if (!open) this.hooks.ask(null);
    else this.render();
  }

  applySnapshot(s: Snapshot): void {
    for (let slot = 0; slot < MAX_COMMANDERS; slot++) {
      const o = slot * COMMANDER_STRIDE;
      const c = this.info[slot];
      const was = { status: c.status, need: c.need, count: c.count };
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
      c.need = (flags & COMMANDER_NEED) !== 0;
      c.fighting = (flags & COMMANDER_FIGHTING) !== 0;
      // What the player must hear about, wherever they are looking.
      if (c.count === 0 && was.count > 0) {
        this.hooks.alert(`${c.name} has no troops left`, c.cx, c.cz);
      } else if (c.status !== was.status && c.status === ST_FALLBACK) {
        this.hooks.alert(`${c.name} is falling back`, c.cx, c.cz);
      } else if (c.status !== was.status && c.status === ST_SECURED) {
        this.hooks.alert(`${c.name} has taken ${this.place(c.x, c.z)}`, c.cx, c.cz);
      } else if (c.need && !was.need && !c.auto) {
        this.hooks.alert(`${c.name} needs reinforcements`, c.cx, c.cz);
      }
    }
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
    this.send({ type: CMD_ASSIGN, units: this.units.selectedIds(), slot: free.slot });
    // A new command starts with no orders, whatever the last holder of the name had.
    this.send({ type: CMD_MISSION, team: ME, slot: free.slot, mission: M_NONE, x: 0, y: 0 });
    this.focus = free.slot;
    this.toggle(true);
    return free.slot;
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
    return `grid ${String.fromCharCode(65 + Math.min(7, Math.max(0, Math.floor(x / 128))))}${Math.min(8, Math.max(1, Math.floor(z / 128) + 1))}`;
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
      this.send({ type: CMD_ASSIGN, units: u.selectedIds(), slot });
    } else if (act === 'mission') {
      const def = MISSIONS.find((d) => d.m === mission);
      if (!def) return;
      this.hooks.ask(`Click the map: where should ${c.name} ${def.ask}? (Esc cancels)`, (x, z) => {
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
      this.send({ type: CMD_MISSION, team: ME, slot, mission: M_NONE, x: 0, y: 0 });
    } else if (act === 'auto') {
      this.send({ type: CMD_REINFORCE, team: ME, slot, on: !c.auto });
      c.auto = !c.auto;
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
    let html = '';
    if (active.length === 0) {
      html +=
        '<p class="hint">No commanders yet. Select troops and press <kbd>N</kbd> (or the button below): they get a commander. Give it a mission and it runs them for you: it marches, attacks, holds, falls back and asks for more by itself.</p>';
    }
    for (const c of active) {
      const pct = c.best > 0 ? Math.min(100, Math.round((c.power * 100) / c.best)) : 0;
      const tone = c.status === ST_FALLBACK || pct < 45 ? 'bad' : c.need ? 'warn' : 'ok';
      const what =
        c.mission === M_NONE ? 'No orders' : `${MISSION_NAME[c.mission]} ${this.place(c.x, c.z)}`;
      const notes = [STATUS[c.status] ?? ''];
      if (c.fighting && c.status !== ST_ATTACK) notes.push('in contact');
      if (c.need) notes.push(c.auto ? 'replacements on order' : 'needs reinforcements');
      const openRow = this.focus === c.slot;
      html +=
        `<div class="cmd ${tone}${openRow ? ' open' : ''}">` +
        `<div class="row" data-act="open" data-s="${c.slot}" title="Click: select its troops and show its orders"><b>${c.name}</b><span class="what">${what}</span><span class="n">${c.count}</span></div>` +
        `<div class="bar"><i style="width:${pct}%"></i></div>` +
        `<div class="state">${notes.join(' · ')}</div>`;
      if (openRow) {
        html += '<div class="orders">';
        for (const d of MISSIONS) {
          html += `<button data-act="mission" data-s="${c.slot}" data-m="${d.m}" title="${d.tip}"${c.mission === d.m ? ' class="on"' : ''}>${d.name}</button>`;
        }
        html +=
          `</div><div class="orders">` +
          `<button data-act="jump" data-s="${c.slot}" title="Look at its troops">Go to</button>` +
          `<button data-act="add" data-s="${c.slot}" title="Put the selected units under ${c.name}"${u.selectedCount === 0 ? ' disabled' : ''}>+ Selection</button>` +
          `<button data-act="auto" data-s="${c.slot}" class="${c.auto ? 'on' : ''}" title="Replace losses: what ${c.name} loses is ordered again from your factories and sent to it, as money allows">Replace losses: ${c.auto ? 'on' : 'off'}</button>` +
          `<button data-act="stand" data-s="${c.slot}" title="Stop where it is and wait for orders">Stand down</button>` +
          `<button data-act="disband" data-s="${c.slot}" title="Its troops go back under your own orders">Disband</button>` +
          `</div>`;
      }
      html += '</div>';
    }
    const idle = this.idle().length;
    const free = this.info.some((c) => c.count === 0);
    html += '<div class="foot">';
    html += `<button data-act="new" title="The selected units get a commander of their own"${u.selectedCount === 0 || !free ? ' disabled' : ''}>New commander from selection <kbd>N</kbd></button>`;
    if (idle > 0) {
      html +=
        `<div class="idle"><span>${idle} idle unit${idle === 1 ? '' : 's'} without a commander</span>` +
        `<button data-act="idle" title="Select them and look at them">Select</button>` +
        `<button data-act="absorb" title="Each joins the commander whose troops are nearest"${active.some((c) => c.count > 0) ? '' : ' disabled'}>Give to nearest</button></div>`;
    }
    html +=
      '<p class="hint">An order you give a unit yourself takes it out of its commander\'s hands. Dragging a box leaves commanded troops alone when it also holds others.</p></div>';
    if (html !== this.html) this.body.innerHTML = this.html = html;
  }
}
