// What a sub-commander reports, and when. The player runs commanders without watching
// them, so every one of them says the same things at the same moments of a mission:
// order received, forming up, going in, in position, objective taken, in contact, heavy
// losses, falling back, regrouping, needs reinforcements, back up to strength, wiped out.
// Worked out on the client from what the snapshot says of each commander: no game state,
// and no DOM in here, so the rules can be tested.
import {
  ST_ARRIVED,
  ST_ATTACK,
  ST_FALLBACK,
  ST_GATHER,
  ST_REGROUP,
  ST_SECURED,
} from '../sim/staff';
import {
  MAX_COMMANDERS,
  M_ATTACK,
  M_DEFEND,
  M_HOLD,
  M_MOVE,
  M_NONE,
  M_PATROL,
  M_SCREEN,
} from '../sim/world';
import { SAY_NORMAL, SAY_ROUTINE, SAY_URGENT } from './voice';

/** A commander as the snapshot gives it (the mission board's `CommanderInfo` fits). */
export interface Command {
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

export interface Report {
  slot: number;
  text: string;
  /** SAY_URGENT, SAY_NORMAL or SAY_ROUTINE. */
  level: number;
  /** Bad news: shown in the colour of an attack, not of a note. */
  bad: boolean;
  x: number;
  z: number;
}

/** Seconds a commander stays off the air after a line, unless the next one is urgent. */
export const QUIET = 4;
/** Share of its best strength below which it reports heavy losses, then its last troops. */
export const HEAVY = 0.6;
export const LAST = 0.3;
/** Back above this, the next losses are news again. */
const RECOVERED = 0.75;
/** Losses count as losses only this long after it last fought (the rest were taken away). */
const FOUGHT = 15;

const ORDER: Record<number, string> = {
  [M_ATTACK]: 'attacking',
  [M_MOVE]: 'moving to',
  [M_HOLD]: 'moving to hold',
  [M_DEFEND]: 'moving to defend',
  [M_PATROL]: 'patrolling to',
  [M_SCREEN]: 'moving to screen',
};
const SETTLED: Record<number, string> = {
  [M_HOLD]: 'holding',
  [M_DEFEND]: 'defending',
  [M_SCREEN]: 'screening',
  [M_PATROL]: 'patrolling',
};

interface Memory {
  /** It has reported being where its mission wants it. */
  arrived: boolean;
  /** 0 = in good shape, 1 = heavy losses reported, 2 = last troops reported. */
  losses: number;
  foughtAt: number;
  /** When it last said anything, and when it last said each kind of thing. */
  spokeAt: number;
  said: Map<string, number>;
  /** How many it had when it asked for reinforcements. */
  shortAt: number;
}

function fresh(): Memory {
  return { arrived: false, losses: 0, foughtAt: -1e9, spokeAt: -1e9, said: new Map(), shortAt: 0 };
}

export interface Places {
  /** Words for a place: "Northgate, D4", or "grid D4" in open country. */
  name(x: number, z: number): string;
  /** Is the body of this commander at the place of its mission? */
  there(c: Command): boolean;
}

export class CommanderReports {
  private readonly mem: Memory[] = [];

  constructor(private readonly places: Places) {
    for (let k = 0; k < MAX_COMMANDERS; k++) this.mem.push(fresh());
  }

  /**
   * What commander `c` has to say now, given what it was a snapshot ago. `now` in seconds.
   * At most one line of each kind, the urgent ones never held back.
   */
  step(c: Command, was: Command, now: number): Report[] {
    const out: Report[] = [];
    let m = this.mem[c.slot];
    const say = (key: string, text: string, level: number, again = 0, bad = false): boolean => {
      if (again > 0 && now - (m.said.get(key) ?? -1e9) < again) return false;
      if (level !== SAY_URGENT && now - m.spokeAt < QUIET) return false;
      m.said.set(key, now);
      m.spokeAt = now;
      out.push({ slot: c.slot, text: `${c.name} ${text}`, level, bad, x: c.cx, z: c.cz });
      return true;
    };
    if (c.fighting) m.foughtAt = now;
    const ordered = c.mission !== was.mission || c.x !== was.x || c.z !== was.z;
    if (c.count === 0) {
      // Troops the player took back are not a loss: only a command that died fighting.
      const died = was.fighting || was.status === ST_FALLBACK || now - m.foughtAt < 3;
      if (was.count > 0 && died && !ordered) say('gone', 'has no troops left', SAY_URGENT, 0, true);
      this.mem[c.slot] = fresh();
      return out;
    }
    if (ordered || was.count === 0) m = this.mem[c.slot] = fresh();
    const place = this.places.name(c.x, c.z);
    const changed = c.status !== was.status;
    const strength = c.best > 0 ? c.power / c.best : 1;
    let arrivedNow = false;

    // Where it was sent: every mission says so once, not only an attack and a move.
    if (!m.arrived && c.mission in SETTLED && this.places.there(c)) {
      m.arrived = arrivedNow = true;
      const text =
        c.mission === M_PATROL
          ? `has reached ${place}, patrolling`
          : `in position at ${place}, ${SETTLED[c.mission]}`;
      say('there', text, SAY_URGENT);
    }
    if (changed && c.status === ST_ARRIVED && !m.arrived) {
      m.arrived = arrivedNow = true;
      say('there', `in position at ${place}`, SAY_URGENT);
    }
    if (changed && c.status === ST_SECURED) {
      m.arrived = true;
      // Taken once; after that it has beaten off whoever came to take it back.
      if (!m.said.has('taken')) say('taken', `has taken ${place}`, SAY_URGENT);
      else say('held', `has held ${place}`, SAY_NORMAL, 60);
    }

    // Bad news.
    const fellBack = changed && c.status === ST_FALLBACK;
    if (fellBack) say('back', `falling back from ${place}`, SAY_URGENT, 0, true);
    if (strength >= RECOVERED) m.losses = 0;
    else if (now - m.foughtAt < FOUGHT) {
      if (strength < LAST && m.losses < 2) {
        m.losses = 2;
        if (!fellBack) say('last', 'is down to its last troops', SAY_URGENT, 0, true);
      } else if (strength < HEAVY && m.losses < 1) {
        m.losses = 1;
        if (!fellBack) say('heavy', 'taking heavy losses', SAY_URGENT, 0, true);
      }
    }
    const asks = c.need && !c.auto;
    if (c.need && !was.need) m.shortAt = c.count;
    if (changed && c.status === ST_REGROUP) {
      if (asks && say('regroup', 'regrouping, needs reinforcements', SAY_URGENT, 30)) {
        m.said.set('need', now);
      } else say('regroup', 'regrouping', SAY_NORMAL, 30);
    } else if (asks && !was.need && !fellBack) say('need', 'needs reinforcements', SAY_URGENT, 60);
    if (!c.need && was.need && !ordered && c.count > m.shortAt) {
      say('strong', 'is back up to strength', SAY_NORMAL, 60);
    }

    // How the mission is getting on.
    if (changed && c.status === ST_GATHER) {
      say('gather', `forming up outside ${place}`, SAY_NORMAL, 60);
    } else if (changed && c.status === ST_ATTACK) {
      if (was.status === ST_SECURED)
        say('contact', `under attack at ${place}`, SAY_NORMAL, 45, true);
      else say('in', `going in at ${place}`, SAY_NORMAL, 60);
    } else if (changed && was.status === ST_REGROUP && c.status !== ST_FALLBACK && !ordered) {
      const text =
        c.mission === M_ATTACK ? `resuming the attack on ${place}` : `returning to ${place}`;
      say('resume', text, SAY_NORMAL, 30);
    }
    // Shot at when it is not in an attack of its own (that one has said "going in").
    if (c.fighting && !was.fighting && c.status !== ST_ATTACK && c.status !== ST_FALLBACK) {
      const here = this.places.name(c.cx, c.cz);
      const moving = !m.arrived && c.status !== ST_REGROUP;
      if (moving) say('contact', `in contact at ${here}`, SAY_NORMAL, 60, true);
      else say('contact', `under attack at ${here}`, SAY_NORMAL, 60, true);
    }

    // The order itself, unless it was already standing where it was told to go.
    if (ordered && !arrivedNow) {
      if (c.mission === M_NONE) say('order', 'standing by', SAY_ROUTINE);
      else if (c.mission in ORDER) say('order', `${ORDER[c.mission]} ${place}`, SAY_ROUTINE);
    }
    return out;
  }
}
