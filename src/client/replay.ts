// Rejoining a co-op game in progress (decision 104).
//
// The world is never sent. The game is deterministic, so a player who comes back is sent
// what every sim was sent: the orders, tick by tick, from the first tick. His sim plays
// them through as fast as the machine allows and arrives where the others are. Nearly
// every tick has no orders, so the record is small: only the ticks that had some, and how
// far the game has got.
import type { Frame } from '../worker/protocol';

/** A stretch of the game: every tick in [from, to), and the ones among them with orders. */
export interface Piece {
  from: number;
  to: number;
  f: Frame[];
}

/** No piece covers more ticks than this, or (roughly) more characters of orders than that. */
export const PIECE_TICKS = 4000;
export const PIECE_CHARS = 12000;

/** The host's record of a game: the ticks with orders in them, and the next tick to come. */
export class GameLog {
  readonly busy: Frame[] = [];
  /** Every tick below this has been run by the host and is in the record. */
  through = 0;

  add(frames: readonly Frame[]): void {
    for (const f of frames) {
      if (f[1].length > 0) this.busy.push(f);
      this.through = f[0] + 1;
    }
  }

  /**
   * The next piece for someone who has everything before `from` (and whose next busy tick
   * is `this.busy[at]`), or null if he has it all. Returns where the piece after it starts.
   */
  piece(from: number, at: number): { piece: Piece; at: number } | null {
    if (from >= this.through) return null;
    let to = Math.min(this.through, from + PIECE_TICKS);
    const f: Frame[] = [];
    let chars = 0;
    while (at < this.busy.length && this.busy[at][0] < to) {
      const frame = this.busy[at];
      const size = JSON.stringify(frame).length;
      if (f.length > 0 && chars + size > PIECE_CHARS) {
        to = frame[0];
        break;
      }
      f.push(frame);
      chars += size;
      at++;
    }
    return { piece: { from, to, f }, at };
  }
}

/** A piece as the frames it stands for: one per tick, most of them without orders. */
export function expand(p: Piece): Frame[] {
  const out: Frame[] = [];
  let k = 0;
  for (let t = p.from; t < p.to; t++) {
    if (k < p.f.length && p.f[k][0] === t) out.push(p.f[k++]);
    else out.push([t, []]);
  }
  return out;
}
