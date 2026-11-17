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
} from '../sim/world';
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

export class Debrief {
  private won: boolean | null = null;
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
      `</p></div>`;
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
        `Units nobody has ordered count for the army only.</p></div>`;
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
}
