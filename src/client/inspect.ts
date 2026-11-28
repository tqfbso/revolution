// The hover inspector (the audit, 3C): rest the pointer on a unit or a building and a small
// glass card beside it says what it is. A unit: its name, its army, its health, how far it
// reaches and sees. A building: what it is, how many floors, its health and state, a fire
// on the ground floor, a breach, sandbags, who holds it and how much room is left, whether
// its roof can still be used. It shows what the player can already see, nothing more.
import { BUILDINGS } from '../sim/economy';
import { FACTIONS } from '../sim/factions';
import {
  BUILD_BLOCK,
  BUILD_HALL,
  S_BASE,
  S_BRIDGE,
  STAGE_DAMAGED,
  STAGE_GUTTED,
  STAGE_INTACT,
  type GameMap,
} from '../sim/map';
import { GARRISON_MAX } from '../sim/units';
import { factionOf, kindIn } from './army';
import type { StructureView } from './structures';
import type { UnitView } from './units';
import { esc } from './wire';

/** The pointer has to rest this long before the card shows, in seconds. */
const REST = 0.35;
/** Then the card is filled in again this often while it shows. */
const REFRESH = 0.25;
const FX = 1024;
const TEAM_CSS = ['#eb4637', '#468cff', '#f0be3c', '#5fd273'];

/** Kowloon's building styles (sim/kowloon.ts). */
const STYLE_NAME: Record<number, string> = {
  1: 'Tenement',
  2: 'Office tower',
  3: 'Shopping mall',
  4: 'Hotel',
  5: 'Civic building',
  6: 'Old colonial building',
  8: 'Clock tower',
  9: 'Mosque',
  10: 'Sports hall',
  11: 'Kiosk',
  12: 'Church',
};

export interface Pointed {
  unit: number;
  structure: number;
}

export class Inspector {
  private readonly el: HTMLDivElement;
  private rest = 0;
  private since = REFRESH;
  private x = 0;
  private y = 0;
  private on = true;
  /** What is under the pointer now (set by the input). */
  pick: (x: number, y: number) => Pointed = () => ({ unit: -1, structure: -1 });

  constructor(
    private readonly units: UnitView,
    private readonly structures: StructureView,
    private readonly map: GameMap,
    canvas: HTMLElement,
  ) {
    this.el = document.createElement('div');
    this.el.id = 'inspect';
    this.el.className = 'pill';
    document.body.append(this.el);
    canvas.addEventListener('pointermove', (e) => {
      if (e.buttons !== 0) return this.hide();
      if (Math.abs(e.clientX - this.x) + Math.abs(e.clientY - this.y) < 3) return;
      this.x = e.clientX;
      this.y = e.clientY;
      this.hide();
    });
    canvas.addEventListener('pointerleave', () => this.hide());
    canvas.addEventListener('pointerdown', () => this.hide());
    canvas.addEventListener('wheel', () => this.hide(), { passive: true });
  }

  /** Off while the player is placing something or drawing (the card has the pointer then). */
  set enabled(v: boolean) {
    this.on = v;
    if (!v) this.hide();
  }

  private hide(): void {
    this.rest = 0;
    this.since = REFRESH;
    this.el.classList.remove('on');
  }

  update(dt: number): void {
    if (!this.on) return;
    this.rest += dt;
    if (this.rest < REST) return;
    this.since += dt;
    if (this.since < REFRESH) return;
    this.since = 0;
    const { unit, structure } = this.pick(this.x, this.y);
    const html = unit >= 0 ? this.unit(unit) : structure >= 0 ? this.building(structure) : '';
    if (!html) {
      this.el.classList.remove('on');
      return;
    }
    this.el.innerHTML = html;
    // Beside the pointer, kept on the screen.
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    const left = this.x + 18 + w > innerWidth ? this.x - 18 - w : this.x + 18;
    const top = Math.min(innerHeight - h - 8, Math.max(8, this.y + 14));
    this.el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    this.el.classList.add('on');
  }

  private army(team: number): string {
    const name = FACTIONS[factionOf(team)]?.name ?? 'Army';
    const mine = team === this.units.playerTeam;
    return `<span style="color:${TEAM_CSS[team] ?? '#b9c4cf'}">${esc(name)}${mine ? ' (yours)' : ''}</span>`;
  }

  private unit(id: number): string {
    const u = this.units;
    const team = u.teamOf(id);
    const k = kindIn(team, u.kindOf(id));
    const hp = Math.round((u.healthOf(id) * 100) / 255);
    const facts: string[] = [`Health ${hp}%`];
    if (k.range > 0) {
      facts.push(
        k.minRange > 0
          ? `Reach ${Math.round(k.minRange / FX)} to ${Math.round(k.range / FX)} m`
          : `Reach ${Math.round(k.range / FX)} m`,
      );
    }
    facts.push(`Sees ${Math.round(k.sight / FX)} m`);
    return (
      `<b>${esc(k.name)}</b><span>${this.army(team)}</span>` +
      `<span class="bar"><i style="width:${hp}%"></i></span>` +
      `<span>${facts.join(' · ')}</span>`
    );
  }

  private building(s: number): string {
    const st = this.structures;
    const m = this.map;
    if (m.sKind[s] === S_BRIDGE) {
      const hp = Math.round((st.hp[s] * 100) / 255);
      return `<b>Bridge</b><span class="bar"><i style="width:${hp}%"></i></span><span>Health ${hp}%</span>`;
    }
    if (m.sKind[s] === S_BASE || st.baseTeam[s] >= 0) {
      const team = st.baseTeam[s];
      if (team < 0) return '';
      const name = BUILDINGS[st.baseType[s]]?.name ?? 'Base building';
      const hp = Math.round((st.hp[s] * 100) / 255);
      const building = st.basePct[s] < 100 ? ` · going up, ${st.basePct[s]}%` : '';
      return (
        `<b>${esc(name)}</b><span>${this.army(team)}</span>` +
        `<span class="bar"><i style="width:${hp}%"></i></span><span>Health ${hp}%${building}</span>`
      );
    }
    const style = STYLE_NAME[m.sStyle[s]];
    const cls = m.sClass[s];
    const what =
      style ?? (cls === BUILD_HALL ? 'Hall' : cls === BUILD_BLOCK ? 'Block of flats' : 'House');
    const floors = m.sFloors[s];
    const hp = Math.round((st.hp[s] * 100) / 255);
    const stage = st.stage[s];
    const state =
      st.hp[s] === 0
        ? 'Ruin: cover, no roof'
        : stage === STAGE_INTACT
          ? 'Intact'
          : stage === STAGE_DAMAGED
            ? 'Shot up'
            : stage === STAGE_GUTTED
              ? 'Gutted: no roof left'
              : 'Ruin';
    const facts: string[] = [];
    if (st.alight[s] > 0) facts.push('<span class="hot">Ground floor on fire</span>');
    if (st.breached[s] > 0) facts.push('Breached');
    const fort = st.fort[s] > 0;
    if (fort) facts.push('Fortified');
    // Room inside: the sim's rule (garrisonCapacity), a fortified house holds half again.
    const room = Math.min(GARRISON_MAX, (m.sW[s] * m.sH[s] * (fort ? 3 : 2)) >> 1);
    const n = st.occ[s];
    let held = '';
    if (st.hp[s] > 0) {
      held =
        n > 0
          ? `${n} of ${room} squads inside, ${this.army(st.occTeam[s])}`
          : `Empty: room for ${room} squads`;
    }
    const roof = st.hp[s] > 0 && stage < STAGE_GUTTED ? ' · roof can be held' : '';
    return (
      `<b>${esc(what)}</b><span>${floors > 0 ? `${floors} floor${floors > 1 ? 's' : ''} · ` : ''}${state}${roof}</span>` +
      `<span class="bar"><i style="width:${hp}%"></i></span>` +
      (held ? `<span>${held}</span>` : '') +
      (facts.length > 0 ? `<span>${facts.join(' · ')}</span>` : '')
    );
  }
}
