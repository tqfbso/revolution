// The end of a game (decision 103): who won, how long it took, and what it cost. In a
// shared army each player has a line of his own, and the one whose units destroyed the
// most is named. The numbers come from the sim, so every machine shows the same ones.
import {
  STAT_KILLS,
  STAT_KILL_POINTS,
  STAT_LOST,
  STAT_LOST_POINTS,
  STAT_RAZED,
  STAT_SEAT0,
  STAT_STRIDE,
  STAT_TEAMS,
  SPENT_BUILDINGS,
  SPENT_CREDITS,
  SPENT_FUEL,
  SPENT_NOBODY,
  SPENT_STRIDE,
  SPENT_SUPPLIES,
  SPENT_UNITS,
} from '../sim/world';
import { spentLine } from './team';
import { saveLastBattle } from './menu';
import type { Snapshot } from '../worker/protocol';

const TICKS_PER_SECOND = 20;

export interface DebriefPlayer {
  /** "You", "Player 2"… */
  name: string;
  role: string;
}

const clock = (ticks: number): string => {
  const s = Math.floor(ticks / TICKS_PER_SECOND);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
};

const ARMY = ['Red', 'Blue', 'Gold', 'Green'];

export interface DebriefSetup {
  /** How many armies fought (2 to 4). */
  armies: number;
  /** The battle in a few words ("City · night · easy AI"), for the main menu's corner. */
  label: string;
  toMenu: () => void;
}

/** Army colours, as on the minimap. */
const COLOUR = ['#eb4637', '#468cff', '#f0be3c', '#5fd273'];
/** A point on the charts every this many ticks: ten seconds. */
const SAMPLE = 10 * TICKS_PER_SECOND;

/** What is drawn over time, per army. */
interface Series {
  title: string;
  /** One list of values per army, a value per sample. */
  values: number[][];
}

export class Debrief {
  private won: boolean | null = null;
  /** Ticks of the samples, and per chart the values of every army at each. */
  private readonly ticks: number[] = [];
  private readonly series: Series[] = [
    { title: 'Army in the field (points)', values: [[], [], [], []] },
    { title: 'Flags held', values: [[], [], [], []] },
    { title: 'Units lost', values: [[], [], [], []] },
  ];
  private last: Snapshot | null = null;
  private html = '';

  constructor(
    private readonly el: HTMLElement,
    private readonly me: number,
    /** The players of a shared army by seat; one entry when playing alone. */
    private readonly players: () => DebriefPlayer[],
    private readonly setup: DebriefSetup,
  ) {
    el.addEventListener('click', (e) => {
      const id = (e.target as HTMLElement).id;
      if (id === 'debrief-close') el.style.display = 'none';
      else if (id === 'debrief-new') location.reload();
      else if (id === 'debrief-menu') setup.toMenu();
    });
  }

  /** The game is decided. The screen stays up to date while it is open. */
  show(won: boolean): void {
    if (this.won !== null) return;
    this.won = won;
    this.el.style.display = 'block';
    if (this.last) saveLastBattle({ label: this.setup.label, won, time: clock(this.last.tick) });
    this.render();
  }

  applySnapshot(s: Snapshot): void {
    this.last = s;
    // Until the end, a sample every ten seconds of battle for the charts.
    if (
      this.won === null &&
      (this.ticks.length === 0 || s.tick - this.ticks[this.ticks.length - 1] >= SAMPLE)
    ) {
      this.ticks.push(s.tick);
      for (let t = 0; t < 4; t++) {
        this.series[0].values[t].push(s.pop[t] ?? 0);
        this.series[1].values[t].push(s.townOwner.reduce((n, o) => n + (o === t ? 1 : 0), 0));
        this.series[2].values[t].push(
          t < STAT_TEAMS ? (s.stats[STAT_STRIDE * t + STAT_LOST] ?? 0) : 0,
        );
      }
    }
    // Once a second is plenty: the fighting goes on after the headquarters falls.
    if (this.won !== null && s.tick % TICKS_PER_SECOND === 0) this.render();
  }

  private render(): void {
    const s = this.last;
    if (!s || this.won === null) return;
    const st = s.stats;
    const me = this.me;
    // Your army first, then every other army that fought.
    const teams = [me];
    for (let t = 0; t < this.setup.armies; t++) if (t !== me) teams.push(t);
    const two = teams.length === 2;
    const flags = teams.map((t) => s.townOwner.reduce((n, o) => n + (o === t ? 1 : 0), 0));
    const civ = teams.map((t) => s.civStats[3 + t] ?? 0);
    const civAll = civ.reduce((a, b) => a + b, 0);
    // The score is kept for all four armies.
    const stat = (t: number, k: number): string =>
      t < STAT_TEAMS ? (st[STAT_STRIDE * t + k] ?? 0).toLocaleString('en-US') : '–';
    const row = (label: string, cells: (number | string)[]): string =>
      `<span class="l">${label}</span>` +
      cells.map((c, k) => `<span${k === 0 ? ' class="a"' : ''}>${c}</span>`).join('');
    let html =
      `<h1 class="${this.won ? 'won' : 'lost'}">${this.won ? 'Victory' : 'Defeat'}</h1>` +
      `<p class="sub">${this.won ? (two ? 'The enemy headquarters has fallen.' : 'The last enemy headquarters has fallen.') : 'Your headquarters has fallen.'} ` +
      `The battle lasted ${clock(s.tick)}.</p>` +
      `<div class="cols2" style="margin-top:clamp(18px,5vh,48px)"><div class="col" style="gap:0">` +
      `<div class="score" style="grid-template-columns:minmax(0,1fr) repeat(${teams.length},${two ? 110 : 76}px)">` +
      `<span class="h l"></span>` +
      teams
        .map((t, k) => `<span class="h">${k === 0 ? 'Your army' : two ? 'Enemy' : ARMY[t]}</span>`)
        .join('') +
      row(
        'Units destroyed',
        teams.map((t) => stat(t, STAT_KILLS)),
      ) +
      row(
        'Army points destroyed',
        teams.map((t) => stat(t, STAT_KILL_POINTS)),
      ) +
      row(
        'Units lost',
        teams.map((t) => stat(t, STAT_LOST)),
      ) +
      row('Flags held at the end', flags) +
      row('Civilians killed', civ) +
      `</div>` +
      `<p class="sub" style="font-size:13px;margin-top:16px">${st[STAT_RAZED]} city buildings were brought down. Of ${s.civStats[0]} civilians, ` +
      `${s.civStats[2]} got out of the town and ${civAll} were killed.` +
      `</p>${this.charts(teams, s.tick)}</div>`;
    const players = this.players();
    if (players.length > 1) {
      // The most valuable player: whose units destroyed the most, by army points; a tie
      // goes to whoever lost less doing it.
      let mvp = -1;
      for (let p = 0; p < players.length; p++) {
        const o = STAT_SEAT0 + STAT_STRIDE * p;
        if (st[o + STAT_KILL_POINTS] === 0) continue;
        const b = STAT_SEAT0 + STAT_STRIDE * mvp;
        if (
          mvp < 0 ||
          st[o + STAT_KILL_POINTS] > st[b + STAT_KILL_POINTS] ||
          (st[o + STAT_KILL_POINTS] === st[b + STAT_KILL_POINTS] &&
            st[o + STAT_LOST_POINTS] < st[b + STAT_LOST_POINTS])
        ) {
          mvp = p;
        }
      }
      html +=
        `<div class="col" style="gap:10px">` +
        `<div class="seat stat h"><b>Player</b><span>Role</span><span>Destroyed</span><span>Points</span><span>Lost</span></div>` +
        players
          .map((p, k) => {
            const o = STAT_SEAT0 + STAT_STRIDE * k;
            return (
              `<div class="seat stat${k === mvp ? ' mvp' : ''}"><b>${p.name}${k === mvp ? ' · MVP' : ''}</b>` +
              `<span>${p.role}</span><span>${st[o + STAT_KILLS]}</span>` +
              `<span>${st[o + STAT_KILL_POINTS]}</span><span>${st[o + STAT_LOST]}</span></div>`
            );
          })
          .join('') +
        `<p class="small">A unit fights for the player who last ordered it directly. ` +
        `Units nobody has ordered count for the army only.</p>` +
        this.spending(s.spent, players) +
        `</div>`;
    }
    html +=
      `</div><div class="bar"><button id="debrief-close">Keep watching</button>` +
      `<button id="debrief-menu">Main menu</button>` +
      `<button id="debrief-new" class="go">New game</button></div>`;
    if (html !== this.html) {
      this.html = html;
      this.el.innerHTML = html;
    }
  }

  /** Who spent what of the army's money (src/sim/spend.ts), a line a player. */
  private spending(spent: Int32Array | undefined, players: DebriefPlayer[]): string {
    if (!spent) return '';
    const rows: { name: string; row: number }[] = players.map((p, k) => ({ name: p.name, row: k }));
    const nobody = SPENT_NOBODY(this.me);
    const o = nobody * SPENT_STRIDE;
    if (spent[o + SPENT_SUPPLIES] + spent[o + SPENT_FUEL] + spent[o + SPENT_CREDITS] !== 0) {
      rows.push({ name: "Commanders' reinforcements", row: nobody });
    }
    const n = (v: number) => (v ?? 0).toLocaleString('en-US');
    return (
      `<div class="seat stat spend h" style="margin-top:8px"><b>Spent</b><span>Supplies</span>` +
      `<span>Fuel</span><span>Credits</span><span>Units</span><span>Buildings</span></div>` +
      rows
        .map(({ name, row }) => {
          const b = row * SPENT_STRIDE;
          return (
            `<div class="seat stat spend" title="${spentLine(spent, row).title}"><b>${name}</b>` +
            `<span>${n(spent[b + SPENT_SUPPLIES])}</span><span>${n(spent[b + SPENT_FUEL])}</span>` +
            `<span>${n(spent[b + SPENT_CREDITS])}</span><span>${n(spent[b + SPENT_UNITS])}</span>` +
            `<span>${n(spent[b + SPENT_BUILDINGS])}</span></div>`
          );
        })
        .join('') +
      `<p class="small">The money is the army's and anyone may spend it. Each order is booked ` +
      `to the player who gave it; bulk and standing orders to the player who set them.</p>`
    );
  }

  /** The battle over time: a small line chart per measure, a line per army. */
  private charts(teams: number[], end: number): string {
    if (this.ticks.length < 2) return '';
    const W = 220;
    const H = 96;
    const t0 = this.ticks[0];
    const span = Math.max(1, this.ticks[this.ticks.length - 1] - t0);
    const out = this.series.map((ser) => {
      let top = 1;
      for (const t of teams) for (const v of ser.values[t]) top = Math.max(top, v);
      const y = (v: number) => (H - 14 - ((H - 22) * v) / top).toFixed(1);
      const x = (k: number) => (((this.ticks[k] - t0) / span) * (W - 34)).toFixed(1);
      // Yours drawn last, on top, and thicker.
      const lines = [...teams]
        .reverse()
        .map((t) => {
          const v = ser.values[t];
          const pts = v.map((n, k) => `${x(k)},${y(n)}`).join(' ');
          const last = v[v.length - 1] ?? 0;
          return (
            `<polyline points="${pts}" fill="none" stroke="${COLOUR[t]}" stroke-width="${t === this.me ? 2.2 : 1.4}" stroke-linejoin="round" stroke-linecap="round"/>` +
            `<text x="${W - 30}" y="${y(last)}" dy="4" style="fill:${COLOUR[t]}">${last}</text>`
          );
        })
        .join('');
      return (
        `<div class="chart"><b>${ser.title}</b>` +
        `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${ser.title} over the battle, a line per army">` +
        `<line x1="0" x2="${W - 34}" y1="${H - 14}" y2="${H - 14}" stroke="rgba(255,255,255,0.15)"/>` +
        lines +
        `<text x="0" y="${H}">${clock(t0)}</text><text x="${W - 34}" y="${H}" text-anchor="end">${clock(Math.min(end, this.ticks[this.ticks.length - 1]))}</text>` +
        `</svg></div>`
      );
    });
    return `<div class="charts">${out.join('')}</div>`;
  }
}
