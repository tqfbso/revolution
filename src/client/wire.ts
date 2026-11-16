// What the co-op players say to each other, and the check every message passes on arrival
// (security review, findings 2, 4 and 6). Another player's browser does not have to run
// this game: whatever it sends is checked here, at the one place messages come in, and
// anything that is not a message this game sends is dropped without a word.
import type { Command } from '../sim/commands';
import type { Frame } from '../worker/protocol';
import { DUTY_COUNT, MAX_PLAYERS, validMatch, type Match } from '../sim/match';
import { PIECE_TICKS, type Piece } from './replay';

export { DUTY_COUNT, MAX_PLAYERS };

export type Msg =
  | { t: 'hello'; build: string; duty: number }
  /** Guest, in the lobby: I have changed my role. */
  | { t: 'duty'; duty: number }
  /** Guest, in the lobby of a versus game: I have changed sides. */
  | { t: 'side'; side: number }
  /**
   * Host, in the lobby: you are in, with this many players so far. In a versus game also
   * every player's side by seat, and which seat is yours.
   */
  | { t: 'wait'; n: number; versus?: boolean; sides?: number[]; you?: number }
  /**
   * Host: the game starts. The whole of it (the map, the armies, and every player's army
   * and role by seat, 0 = the host), and which seat is yours.
   */
  | { t: 'cfg'; match: Match; you: number; resume?: boolean }
  /** Host, to a player coming back: a stretch of the game so far (see replay.ts). */
  | ({ t: 'r' } & Piece)
  /** Host: the seat is taken again, by a player with this role. */
  | { t: 'back'; seat: number; duty: number }
  | { t: 'busy' }
  | { t: 'full' }
  /** Host: the player in this seat has left. */
  | { t: 'gone'; seat: number }
  | { t: 'bad'; build: string }
  | { t: 'f'; f: Frame[] }
  | { t: 'c'; c: Command }
  | { t: 'h'; k: number; v: number }
  | { t: 'ctl'; pause?: boolean; speed?: number }
  | { t: 'st'; paused: boolean; speed: number }
  | { t: 'p'; ts: number; behind?: number }
  | { t: 'q'; ts: number }
  | { t: 'cam'; x: number; z: number; from?: number }
  | { t: 'mark'; x: number; z: number; from?: number };

/** No message carries more ticks than this. */
const MAX_FRAMES = 20000;

/** Text made safe to put into HTML. */
export function esc(v: unknown): string {
  return String(v).replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string,
  );
}

const isInt = (v: unknown, lo: number, hi: number): v is number =>
  Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isBuild = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9._-]{1,40}$/.test(v);
const intList = (v: unknown, max: number, lo: number, hi: number): v is number[] =>
  Array.isArray(v) && v.length <= max && v.every((x) => isInt(x, lo, hi));

function frames(v: unknown): v is Frame[] {
  if (!Array.isArray(v) || v.length > MAX_FRAMES) return false;
  for (const f of v) {
    if (!Array.isArray(f) || f.length !== 2 || !isInt(f[0], 0, 2 ** 31) || !Array.isArray(f[1]))
      return false;
    // The orders themselves are checked by every sim before it applies them (guard.ts).
    for (const c of f[1]) if (typeof c !== 'object' || c === null) return false;
  }
  return true;
}

/**
 * The message `d` as this game sends it, or null. Positions to show are rebuilt from
 * their numbers, so nothing else rides along when the host passes them on.
 */
export function parseMsg(d: unknown): Msg | null {
  if (typeof d !== 'object' || d === null) return null;
  const m = d as Record<string, unknown>;
  const seat = (v: unknown) => isInt(v, 0, MAX_PLAYERS - 1);
  switch (m.t) {
    case 'hello':
      return isBuild(m.build) && isInt(m.duty, 0, DUTY_COUNT - 1) ? (m as Msg) : null;
    case 'duty':
      return isInt(m.duty, 0, DUTY_COUNT - 1) ? (m as Msg) : null;
    case 'side':
      return isInt(m.side, 0, 1) ? (m as Msg) : null;
    case 'wait':
      return isInt(m.n, 1, MAX_PLAYERS) &&
        (m.versus === undefined || isBool(m.versus)) &&
        (m.sides === undefined || intList(m.sides, MAX_PLAYERS, 0, 1)) &&
        (m.you === undefined || seat(m.you))
        ? (m as Msg)
        : null;
    case 'cfg': {
      // The game itself is checked whole (sim/match.ts): nothing after this doubts it.
      if (!validMatch(m.match) || !isInt(m.you, 0, m.match.players.length - 1)) return null;
      if (m.resume !== undefined && !isBool(m.resume)) return null;
      return m as Msg;
    }
    case 'r':
      return isInt(m.from, 0, 2 ** 31) &&
        isInt(m.to, m.from as number, (m.from as number) + PIECE_TICKS) &&
        frames(m.f)
        ? (m as Msg)
        : null;
    case 'back':
      return isInt(m.seat, 1, MAX_PLAYERS - 1) && isInt(m.duty, 0, DUTY_COUNT - 1)
        ? (m as Msg)
        : null;
    case 'gone':
      return seat(m.seat) ? (m as Msg) : null;
    case 'busy':
    case 'full':
      return { t: m.t };
    case 'bad':
      return isBuild(m.build) ? (m as Msg) : null;
    case 'f':
      return frames(m.f) ? (m as Msg) : null;
    case 'c':
      return typeof m.c === 'object' && m.c !== null ? (m as Msg) : null;
    case 'h':
      return isInt(m.k, 0, 2 ** 31) && isNum(m.v) ? (m as Msg) : null;
    case 'ctl':
      return (m.pause === undefined || isBool(m.pause)) && (m.speed === undefined || isNum(m.speed))
        ? (m as Msg)
        : null;
    case 'st':
      return isBool(m.paused) && isNum(m.speed) ? (m as Msg) : null;
    case 'p':
      return isNum(m.ts) && (m.behind === undefined || isInt(m.behind, 0, 2 ** 31))
        ? (m as Msg)
        : null;
    case 'q':
      return isNum(m.ts) ? (m as Msg) : null;
    case 'cam':
    case 'mark':
      if (!isNum(m.x) || !isNum(m.z) || (m.from !== undefined && !seat(m.from))) return null;
      return { t: m.t, x: m.x, z: m.z, from: m.from as number | undefined };
    default:
      return null;
  }
}
