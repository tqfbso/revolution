// The spoken lines, as a queue. The browser's voice says one thing at a time, and the old
// rule (nothing within three seconds of the last line) threw away whatever came second:
// a commander's "objective taken" was lost whenever something else had just been said.
// Lines now wait their turn, the important ones first, and go stale rather than pile up.

/** Must be heard: an attack on the base, an objective taken, a commander falling back. */
export const SAY_URGENT = 0;
/** Worth hearing: forming up, going in, in contact. */
export const SAY_NORMAL = 1;
/** Nice to hear, the first to go when the radio is busy: an order acknowledged. */
export const SAY_ROUTINE = 2;

/** Seconds a line of each level may wait before it is no longer worth saying. */
const STALE = [25, 12, 6];
/** How many lines may be waiting already for one of each level to still join them. */
const ROOM = [6, 4, 2];
/** A voice that claims to be speaking for this long is stuck (it happens in Chrome). */
const STUCK = 12;

/** What actually talks: the browser's speech synthesis, or a stand-in under test. */
export interface Mouth {
  busy(): boolean;
  say(text: string): void;
  /** Stop whatever it is doing: it has hung. */
  reset(): void;
}

interface Line {
  text: string;
  level: number;
  /** The second on the client clock after which it is dropped unsaid. */
  until: number;
}

export class Speaker {
  private readonly queue: Line[] = [];
  private saidAt = -1e9;

  constructor(private readonly mouth: Mouth) {}

  get waiting(): number {
    return this.queue.length;
  }

  /**
   * Have a line said when its turn comes. False if it was turned away: the same words
   * are waiting already, or the radio is too busy for a line of its level. `keep` is how
   * long it may wait (an attack warning is only worth hearing at once).
   */
  push(text: string, level: number, now: number, keep = STALE[level]): boolean {
    if (this.queue.some((l) => l.text === text)) return false;
    if (this.queue.length >= ROOM[level]) {
      // An urgent line takes the place of the least urgent one waiting.
      if (level !== SAY_URGENT) return false;
      let worst = 0;
      for (let k = 1; k < this.queue.length; k++) {
        if (this.queue[k].level >= this.queue[worst].level) worst = k;
      }
      if (this.queue[worst].level === SAY_URGENT) this.queue.shift();
      else this.queue.splice(worst, 1);
    }
    this.queue.push({ text, level, until: now + keep });
    this.update(now);
    return true;
  }

  /** Every frame: say the next line once the voice is free. */
  update(now: number): void {
    if (this.queue.length === 0) return;
    if (this.mouth.busy()) {
      if (now - this.saidAt < STUCK) return;
      this.mouth.reset();
    }
    for (let k = this.queue.length - 1; k >= 0; k--) {
      if (this.queue[k].until < now) this.queue.splice(k, 1);
    }
    if (this.queue.length === 0) return;
    // The most urgent, and of those the one that has waited longest.
    let next = 0;
    for (let k = 1; k < this.queue.length; k++) {
      if (this.queue[k].level < this.queue[next].level) next = k;
    }
    const line = this.queue.splice(next, 1)[0];
    this.saidAt = now;
    this.mouth.say(line.text);
  }

  clear(): void {
    this.queue.length = 0;
  }
}

/** The browser's own voice. `volume` is read at the moment of speaking; 0 is silence. */
export function browserMouth(volume: () => number): Mouth {
  const synth = (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
  return {
    busy: () => synth !== undefined && (synth.speaking || synth.pending),
    say: (text) => {
      const v = volume();
      if (!synth || v === 0) return;
      try {
        const line = new SpeechSynthesisUtterance(text);
        line.rate = 1.1;
        line.pitch = 0.85;
        line.volume = Math.min(1, v * 0.9);
        synth.speak(line);
      } catch {
        // no voice on this machine: the tone and the banner still say it
      }
    },
    reset: () => {
      try {
        synth?.cancel();
      } catch {
        // nothing to stop
      }
    },
  };
}
