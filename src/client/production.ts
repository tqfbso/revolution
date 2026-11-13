// The war production centre: every factory of the army on one screen. Orders are given
// to the army, not to a building: "20 more rifle squads", "keep 6 tanks in the field",
// "send the new ones to Ridgetop". The simulation hands them out to whichever factory
// has room (see dispatchOrders in the economy).
import { CMD_DEST, CMD_KEEP, CMD_ORDER, type Command } from '../sim/commands';
import { BUILDINGS, TIER_ITEM, UNIT_PRICE } from '../sim/economy';
import type { GameMap } from '../sim/map';
import { KINDS, KIND_COUNT, POINTS } from '../sim/units';
import { DEST_COMMANDER, DEST_RALLY, DEST_TOWN, KIND_SLOTS, TICK_RATE } from '../sim/world';
import { BASE_STRIDE, type Snapshot } from '../worker/protocol';
import type { UnitView } from './units';

const ME = 0;

/** A commander new units can be sent to (filled in by the mission board). */
export interface Posting {
  slot: number;
  name: string;
}

export class ProductionCentre {
  open = false;
  /** Commanders that can take reinforcements, for the "send to" lists. */
  postings: () => Posting[] = () => [];
  private orders: Int16Array = new Int16Array(KIND_SLOTS);
  private keep: Int16Array = new Int16Array(KIND_SLOTS);
  private dest: Uint8Array = new Uint8Array(KIND_SLOTS);
  private supplies = 0;
  private fuel = 0;
  private credits = 0;
  private tier = 1;
  private pop = 0;
  private popCap = 0;
  private bases: Int32Array = new Int32Array(0);
  /** What the table was built for; it is built again only when this changes. */
  private shape = '';
  private readonly body: HTMLElement;

  constructor(
    private readonly el: HTMLElement,
    private readonly map: GameMap,
    private readonly units: UnitView,
    private readonly send: (command: Command) => void,
  ) {
    el.innerHTML =
      `<div class="head"><b>War production</b><span>Orders go to the whole army: every factory of the right kind shares the work.</span><button data-act="close">Close <kbd>P</kbd></button></div>` +
      `<div class="body"></div>` +
      `<div class="foot">+1 / +5 / +20: order more (paid one by one as each starts, so order ahead of your money) · Keep: losses are replaced by themselves · Send to: where new units go when they roll out</div>`;
    this.body = el.querySelector('.body') as HTMLElement;
    // Act on press: the numbers are refreshed under the pointer.
    el.addEventListener('pointerdown', (e) => {
      const button = (e.target as HTMLElement).closest('button');
      if (!button) return;
      e.preventDefault();
      const act = button.dataset.act ?? '';
      const kind = Number(button.dataset.k ?? 0);
      const n = Number(button.dataset.n ?? 0);
      if (act === 'close') this.toggle(false);
      else if (act === 'order') this.send({ type: CMD_ORDER, team: ME, kind, count: n });
      else if (act === 'clear') {
        this.send({ type: CMD_KEEP, team: ME, kind, count: 0 });
        this.send({ type: CMD_ORDER, team: ME, kind, count: -9999 });
      } else if (act === 'keep') {
        const next = Math.max(0, this.keep[kind] + n);
        this.send({ type: CMD_KEEP, team: ME, kind, count: next });
        this.keep[kind] = next;
      }
      this.refresh();
    });
    el.addEventListener('change', (e) => {
      const pick = e.target as HTMLSelectElement;
      if (pick.tagName !== 'SELECT') return;
      const kind = Number(pick.dataset.k ?? 0);
      this.send({ type: CMD_DEST, team: ME, kind, dest: Number(pick.value) });
      this.dest[kind] = Number(pick.value);
      pick.blur();
    });
    setInterval(() => this.refresh(), 250);
  }

  toggle(open = !this.open): void {
    this.open = open;
    this.el.style.display = open ? 'block' : 'none';
    if (open) this.refresh();
  }

  applySnapshot(s: Snapshot): void {
    const o = ME * KIND_SLOTS;
    this.orders = s.orders.subarray(o, o + KIND_SLOTS);
    this.keep = s.keep.subarray(o, o + KIND_SLOTS);
    this.dest = s.dest.subarray(o, o + KIND_SLOTS);
    this.supplies = s.supplies[ME] ?? 0;
    this.fuel = s.fuel[ME] ?? 0;
    this.credits = s.credits[ME] ?? 0;
    this.tier = s.tier[ME] ?? 1;
    this.pop = s.pop[ME] ?? 0;
    this.popCap = s.popCap[ME] ?? 0;
    this.bases = s.bases;
  }

  /** How many units are on bulk order in all (for the button in the top bar). */
  get onOrder(): number {
    let n = 0;
    for (let k = 0; k < KIND_COUNT; k++) n += this.orders[k];
    return n;
  }

  private refresh(): void {
    if (!this.open) return;
    // Finished factories per building type, and what their queues hold per kind.
    const factories = new Array<number>(BUILDINGS.length).fill(0);
    const queued = new Array<number>(KIND_COUNT).fill(0);
    const b = this.bases;
    for (let o = 0; o < b.length; o += BASE_STRIDE) {
      if (b[o + 2] !== ME) continue;
      if (b[o + 5] >= 100) factories[b[o + 1]]++;
      for (let q = 0; q < b[o + 6]; q++) {
        const item = b[o + 8 + q];
        if (item !== TIER_ITEM && item < KIND_COUNT) queued[item]++;
      }
    }
    const fielded = new Array<number>(KIND_COUNT).fill(0);
    const u = this.units;
    for (let i = 0; i < u.count; i++) if (u.isMine(i)) fielded[u.kindOf(i)]++;
    const posts = this.postings();
    const shape = `${factories.join()}|${this.tier}|${posts.map((p) => `${p.slot}${p.name}`).join()}`;
    if (shape !== this.shape) {
      this.shape = shape;
      this.build(factories, posts);
    }
    const set = (id: string, text: string, cls = '') => {
      const cell = this.body.querySelector(`[data-cell="${id}"]`) as HTMLElement | null;
      if (!cell) return;
      if (cell.textContent !== text) cell.textContent = text;
      if (cell.className !== cls) cell.className = cls;
    };
    for (let k = 0; k < KIND_COUNT; k++) {
      const p = UNIT_PRICE[k];
      set(`have${k}`, String(fielded[k]));
      set(`make${k}`, queued[k] > 0 ? String(queued[k]) : '·');
      set(
        `order${k}`,
        this.orders[k] > 0 ? String(this.orders[k]) : '·',
        this.orders[k] > 0 ? 'hot' : '',
      );
      set(
        `keep${k}`,
        this.keep[k] > 0 ? String(this.keep[k]) : 'off',
        this.keep[k] > 0 ? 'hot' : '',
      );
      const short =
        this.orders[k] > 0 &&
        (this.supplies < p.supplies || this.fuel < p.fuel || this.credits < p.credits);
      const full = this.orders[k] > 0 && this.pop + POINTS[k] > this.popCap;
      set(
        `why${k}`,
        factories[p.from] === 0
          ? ''
          : this.tier < p.tier
            ? `needs tier ${p.tier}`
            : full
              ? 'army limit: build depots'
              : short
                ? 'waiting for money'
                : '',
      );
      const pick = this.body.querySelector(`select[data-k="${k}"]`) as HTMLSelectElement | null;
      if (pick && document.activeElement !== pick && pick.value !== String(this.dest[k])) {
        pick.value = String(this.dest[k]);
      }
    }
    set(
      'bank',
      `Supplies ${this.supplies} · Fuel ${this.fuel} · Credits ${this.credits} · Army ${this.pop}/${this.popCap} points`,
    );
  }

  /** The rows: one block per factory type, one row per unit it makes. */
  private build(factories: number[], posts: Posting[]): void {
    let html = `<div class="bank" data-cell="bank"></div><table>`;
    html +=
      '<tr><th>Unit</th><th>Cost</th><th title="In the field now">Have</th><th title="On a factory queue, paid for">Making</th><th title="Ordered, waiting for a free factory or for money">Ordered</th><th>Order more</th><th title="Keep this many in the field: losses are ordered again by themselves">Keep</th><th title="Where new units of this kind go when they roll out">Send to</th><th></th></tr>';
    let options = `<option value="${DEST_RALLY}">Factory rally point</option>`;
    for (const p of posts) {
      options += `<option value="${DEST_COMMANDER + p.slot}">Commander: ${p.name}</option>`;
    }
    for (let t = 0; t < this.map.townCount; t++) {
      options += `<option value="${DEST_TOWN + t}">Town: ${this.map.townName[t]}</option>`;
    }
    BUILDINGS.forEach((building, type) => {
      const makes = UNIT_PRICE.map((p, kind) => ({ p, kind })).filter(({ p }) => p.from === type);
      if (makes.length === 0) return;
      const n = factories[type];
      html += `<tr class="group${n === 0 ? ' none' : ''}"><td colspan="9">${building.name} × ${n}${n === 0 ? ' · trucks build one' : ''}</td></tr>`;
      for (const { p, kind } of makes) {
        const cost =
          (p.supplies > 0 ? `<i class="sup">${p.supplies}</i>` : '') +
          (p.fuel > 0 ? `<i class="fuel">${p.fuel}</i>` : '') +
          (p.credits > 0 ? `<i class="cred">${p.credits}</i>` : '');
        const dim = n === 0 || this.tier < p.tier ? ' class="dim"' : '';
        const add = (count: number, label: string) =>
          `<button data-act="order" data-k="${kind}" data-n="${count}">${label}</button>`;
        const keep = (count: number, label: string) =>
          `<button data-act="keep" data-k="${kind}" data-n="${count}">${label}</button>`;
        html +=
          `<tr${dim}><td title="${Math.round(p.ticks / TICK_RATE)} s each, ${POINTS[kind]} army point${POINTS[kind] === 1 ? '' : 's'}">${KINDS[kind].name}</td>` +
          `<td>${cost}</td>` +
          `<td data-cell="have${kind}"></td><td data-cell="make${kind}"></td><td data-cell="order${kind}"></td>` +
          `<td>${add(1, '+1')}${add(5, '+5')}${add(20, '+20')}${add(-5, '−5')}</td>` +
          `<td>${keep(-5, '−')}<span data-cell="keep${kind}"></span>${keep(5, '+')}</td>` +
          `<td><select data-k="${kind}">${options}</select></td>` +
          `<td><button data-act="clear" data-k="${kind}" title="Drop this unit's orders and its keep">Clear</button><span data-cell="why${kind}"></span></td></tr>`;
      }
    });
    html += '</table>';
    this.body.innerHTML = html;
  }
}
