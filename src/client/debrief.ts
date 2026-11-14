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
} from '../sim/world';
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

export class Debrief {
  private won: boolean | null = null;
  private last: Snapshot | null = null;
  private html = '';

  constructor(
    private readonly el: HTMLElement,
    private readonly me: number,
    /** The players of a shared army by seat; one entry when playing alone. */
    private readonly players: () => DebriefPlayer[],
  ) {
    el.addEventListener('click', (e) => {
      const id = (e.target as HTMLElement).id;
      if (id === 'debrief-close') el.style.display = 'none';
      else if (id === 'debrief-new') location.reload();
    });
  }

  /** The game is decided. The screen stays up to date while it is open. */
  show(won: boolean): void {
    if (this.won !== null) return;
    this.won = won;
    this.el.style.display = 'block';
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
    const us = STAT_STRIDE * this.me;
    const them = STAT_STRIDE * (1 - this.me);
    let flagsOurs = 0;
    let flagsTheirs = 0;
    for (const o of s.townOwner) {
      if (o === this.me) flagsOurs++;
      else if (o === 1 - this.me) flagsTheirs++;
    }
    const civOurs = s.civStats[3 + this.me] ?? 0;
    const civTheirs = s.civStats[4 - this.me] ?? 0;
    const row = (label: string, a: number | string, b: number | string): string =>
      `<tr><td>${label}</td><td>${a}</td><td>${b}</td></tr>`;
    let html =
      `<h2 class="${this.won ? 'won' : 'lost'}">${this.won ? 'Victory' : 'Defeat'}</h2>` +
      `<p>${this.won ? 'The enemy headquarters has fallen.' : 'Your headquarters has fallen.'} ` +
      `The battle lasted ${clock(s.tick)}.</p>` +
      `<table><tr><th></th><th>Your army</th><th>Enemy</th></tr>` +
      row('Units destroyed', st[us + STAT_KILLS], st[them + STAT_KILLS]) +
      row('Army points destroyed', st[us + STAT_KILL_POINTS], st[them + STAT_KILL_POINTS]) +
      row('Units lost', st[us + STAT_LOST], st[them + STAT_LOST]) +
      row('Flags held at the end', flagsOurs, flagsTheirs) +
      row('Civilians killed', civOurs, civTheirs) +
      `</table>` +
      `<p>${st[STAT_RAZED]} city buildings were brought down. Of ${s.civStats[0]} civilians, ` +
      `${s.civStats[2]} got out of the town and ${civOurs + civTheirs} were killed.</p>`;
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
        `<table><tr><th>Player</th><th>Role</th><th>Destroyed</th><th>Points</th><th>Lost</th></tr>` +
        players
          .map((p, k) => {
            const o = STAT_SEAT0 + STAT_STRIDE * k;
            return (
              `<tr class="${k === mvp ? 'mvp' : ''}"><td>${p.name}${k === mvp ? ' <b>MVP</b>' : ''}</td>` +
              `<td>${p.role}</td><td>${st[o + STAT_KILLS]}</td>` +
              `<td>${st[o + STAT_KILL_POINTS]}</td><td>${st[o + STAT_LOST]}</td></tr>`
            );
          })
          .join('') +
        `</table><p class="note">A unit fights for the player who last ordered it directly. ` +
        `Units nobody has ordered count for the army only.</p>`;
    }
    html +=
      `<div class="buttons"><button id="debrief-close">Keep watching</button>` +
      `<button id="debrief-new">New game</button></div>`;
    if (html !== this.html) {
      this.html = html;
      this.el.innerHTML = html;
    }
  }
}
