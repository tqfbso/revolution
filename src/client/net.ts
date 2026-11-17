// Co-op over the network (decisions 092, 093): up to four browsers, one army, the same battle.
//
// The game is a deterministic simulation, so nothing of the battle itself is sent: only
// the orders. The host's sim is the clock. Every tick it runs, it tells the guest which
// orders went in on that tick ("frames"); the guest's sim runs exactly those ticks with
// exactly those orders and arrives at the same world. The guest's own orders travel to the
// host first and come back in a frame, so the guest feels the round trip as a short delay
// on orders and the host feels none. Every two seconds both sides compare a hash of the
// whole world: if they ever differ the game says so instead of quietly drifting apart.
//
// The two browsers talk directly (WebRTC). To find each other they need a meeting point:
// (With more than two players every guest talks to the host only: the host's frames go to
// all of them, and it passes on where each one looks and what each one points at.)
// The meeting point is the free public PeerJS broker, which also lends a relay for networks that block direct
// connections. Nothing of ours runs on a server, so the game still deploys as static
// files. `?net=local` swaps the network for a channel between two tabs of one browser.
import { CMD_DUTY, type Command } from '../sim/commands';
import type { Frame, NetReport } from '../worker/protocol';
import { NAME_MAX, cleanName, isVersus, type Match } from '../sim/match';
import { DUTY_KINDS } from '../sim/units';
import { GameLog, expand } from './replay';
import { fieldLabel, matchFromParams } from './setup';
import { MAX_PLAYERS, esc, parseMsg, type Msg } from './wire';

export { MAX_PLAYERS };

declare const __BUILD__: string;

export type Role = 'host' | 'guest';
/** What each player has said he will look after. Advice, not a lock: anyone can do anything. */
export const DUTIES = ['Everything', 'Armour', 'Infantry', 'Air and drones', 'Economy'] as const;

/** One colour per seat, to tell the players of a shared army apart (never red or blue). */
export const SEAT_COLOURS = ['#3fd2ff', '#ffbe2e', '#d868ff', '#7fe03c'] as const;
export const SEAT_RGB: readonly (readonly number[])[] = [
  [63, 210, 255],
  [255, 190, 46],
  [216, 104, 255],
  [127, 224, 60],
];

/** The two armies of a versus game, as the lobby names them. */
export const SIDES = ['Red', 'Blue'] as const;

/** For each kind of unit: 1 if it falls under `mine`, 2 if under another player's, else 0. */
export function dutyOf(mine: number, theirs: number[], kinds: number): number[] {
  const out = new Array<number>(kinds).fill(0);
  for (const t of theirs) for (const k of DUTY_KINDS[t] ?? []) out[k] = 2;
  for (const k of DUTY_KINDS[mine] ?? []) out[k] = 1;
  return out;
}

/** One connection to the other player, whatever carries it. */
interface Link {
  send(m: Msg): void;
  onMessage: (m: Msg) => void;
  onClose: () => void;
  close(): void;
}

interface Listener {
  /** The address the guest must be given. */
  id: string;
  onLink: (l: Link) => void;
  close(): void;
}

// ---------------------------------------------------------------------------------------
// Two tabs of one browser: for trying co-op alone, and for the automated check.

interface LocalPacket {
  from: Role;
  /** The guest this is from or for: several may share the channel. */
  gid: string;
  m?: Msg;
  bye?: boolean;
}

function localLink(id: string): Link {
  const ch = new BroadcastChannel(`revolution-coop-${id}`);
  const gid = Math.random().toString(36).slice(2);
  const link: Link = {
    send: (m) => ch.postMessage({ from: 'guest', gid, m } satisfies LocalPacket),
    onMessage: () => {},
    onClose: () => {},
    close: () => {
      ch.postMessage({ from: 'guest', gid, bye: true } satisfies LocalPacket);
      ch.close();
    },
  };
  ch.onmessage = (e: MessageEvent<LocalPacket>) => {
    if (e.data.from !== 'host' || e.data.gid !== gid) return;
    if (e.data.bye) link.onClose();
    else {
      const m = parseMsg(e.data.m);
      if (m) link.onMessage(m);
    }
  };
  window.addEventListener('pagehide', () =>
    ch.postMessage({ from: 'guest', gid, bye: true } satisfies LocalPacket),
  );
  return link;
}

function localListen(id: string): Listener {
  // One channel serves every guest: a hello opens a link, a bye closes it.
  const ch = new BroadcastChannel(`revolution-coop-${id}`);
  const links = new Map<string, Link>();
  const listener: Listener = { id, onLink: () => {}, close: () => ch.close() };
  ch.onmessage = (e: MessageEvent<LocalPacket>) => {
    if (e.data.from !== 'guest') return;
    const gid = e.data.gid;
    if (e.data.bye) {
      links.get(gid)?.onClose();
      links.delete(gid);
      return;
    }
    const m = parseMsg(e.data.m);
    if (!m) return;
    if (m.t === 'hello') {
      links.get(gid)?.onClose();
      const link: Link = {
        send: (m) => ch.postMessage({ from: 'host', gid, m } satisfies LocalPacket),
        onMessage: () => {},
        onClose: () => {},
        close: () => ch.postMessage({ from: 'host', gid, bye: true } satisfies LocalPacket),
      };
      links.set(gid, link);
      listener.onLink(link);
    }
    links.get(gid)?.onMessage(m);
  };
  window.addEventListener('pagehide', () => {
    for (const gid of links.keys())
      ch.postMessage({ from: 'host', gid, bye: true } satisfies LocalPacket);
  });
  return listener;
}

// ---------------------------------------------------------------------------------------
// The real thing: WebRTC through the public PeerJS broker.

interface PeerConn {
  open: boolean;
  send(data: unknown): void;
  close(): void;
  on(event: 'open' | 'close', fn: () => void): void;
  on(event: 'data', fn: (data: unknown) => void): void;
  on(event: 'error', fn: (err: Error) => void): void;
}

function peerLink(conn: PeerConn): Link {
  const link: Link = {
    send: (m) => {
      if (conn.open) conn.send(m);
    },
    onMessage: () => {},
    onClose: () => {},
    close: () => conn.close(),
  };
  let closed = false;
  const shut = () => {
    if (closed) return;
    closed = true;
    link.onClose();
  };
  conn.on('data', (d) => {
    // Whatever the other browser sends is checked before anything reads it (wire.ts).
    const m = parseMsg(d);
    if (m) link.onMessage(m);
  });
  conn.on('close', shut);
  conn.on('error', shut);
  return link;
}

async function peerListen(id: string): Promise<Listener> {
  const { Peer } = await import('peerjs');
  return new Promise((resolve, reject) => {
    const peer = new Peer(id);
    const listener: Listener = { id, onLink: () => {}, close: () => peer.destroy() };
    peer.on('open', () => resolve(listener));
    peer.on('error', (e) => reject(e));
    peer.on('connection', (conn) => {
      const c = conn as unknown as PeerConn;
      c.on('open', () => listener.onLink(peerLink(c)));
    });
    // The broker drops idle sockets now and then; the game in progress does not need it,
    // but a partner who comes back does.
    peer.on('disconnected', () => {
      if (!peer.destroyed) peer.reconnect();
    });
  });
}

async function peerJoin(id: string): Promise<Link> {
  const { Peer } = await import('peerjs');
  return new Promise((resolve, reject) => {
    const peer = new Peer();
    let through = false;
    const fail = (e: unknown) => {
      // Once the two are talking, trouble with the broker no longer matters.
      if (through) return;
      peer.destroy();
      reject(e);
    };
    peer.on('error', fail);
    peer.on('open', () => {
      const conn = peer.connect(id, { reliable: true, serialization: 'json' });
      const c = conn as unknown as PeerConn;
      const timer = setTimeout(() => fail(new Error('timeout')), 15000);
      c.on('open', () => {
        clearTimeout(timer);
        through = true;
        resolve(peerLink(c));
      });
    });
  });
}

// ---------------------------------------------------------------------------------------

function overlay(): { el: HTMLElement; set: (html: string) => void; hide: () => void } {
  const el = document.createElement('div');
  el.id = 'coop-lobby';
  el.className = 'screen';
  document.body.appendChild(el);
  return { el, set: (html) => (el.innerHTML = html), hide: () => el.remove() };
}

/** A lobby page that only has something to say. */
const page = (title: string, body: string): string =>
  `<div class="top"><h1>${title}</h1></div><div class="text">${body}</div>`;

function readDuty(): number {
  try {
    const d = Number(localStorage.getItem('revolution.duty') ?? 0) | 0;
    return d >= 0 && d < DUTIES.length ? d : 0;
  } catch {
    return 0;
  }
}

function readName(): string {
  try {
    return cleanName(localStorage.getItem('revolution.name') ?? '');
  } catch {
    return '';
  }
}

const namePicker = (name: string): string =>
  `<label class="opt"><span>Your name</span>` +
  `<input id="coop-name" maxlength="${NAME_MAX}" value="${esc(name)}" placeholder="What the others call you" autocomplete="off" /></label>`;

function watchName(onPick: (name: string) => void): void {
  const el = document.getElementById('coop-name') as HTMLInputElement | null;
  el?.addEventListener('input', () => {
    const name = cleanName(el.value);
    try {
      localStorage.setItem('revolution.name', name);
    } catch {
      // not remembered
    }
    onPick(name);
  });
}

const dutyPicker = (duty: number): string =>
  `<label class="opt"><span>Your role</span>` +
  `<select id="coop-duty">${DUTIES.map((d, k) => `<option value="${k}"${k === duty ? ' selected' : ''}>${d}</option>`).join('')}</select>` +
  `<p>New units of your role are yours as they roll out. Nothing is locked: anyone can order anything, and you can change role or hand units over during the game.</p></label>`;

function watchDuty(onPick: (d: number) => void): void {
  const sel = document.getElementById('coop-duty') as HTMLSelectElement | null;
  sel?.addEventListener('change', () => {
    const d = Number(sel.value) | 0;
    try {
      localStorage.setItem('revolution.duty', String(d));
    } catch {
      // not remembered
    }
    onPick(d);
  });
}

const sideTag = (side: number): string =>
  `<span style="color:${side === 1 ? '#7fa8e8' : '#e8857a'}">${SIDES[side === 1 ? 1 : 0]}</span>`;

const sidePicker = (side: number): string =>
  `<label class="opt"><span>Your side</span>` +
  `<select id="coop-side">${SIDES.map((d, k) => `<option value="${k}"${k === side ? ' selected' : ''}>${d}</option>`).join('')}</select></label>`;

function watchSide(onPick: (side: number) => void): void {
  const sel = document.getElementById('coop-side') as HTMLSelectElement | null;
  sel?.addEventListener('change', () => onPick(Number(sel.value) === 1 ? 1 : 0));
}

const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

interface Peer {
  link: Link;
  /** Hashes of theirs that we have not reached yet. */
  ahead: Map<number, number>;
  heard: number;
  suspect: boolean;
  ping: number;
  /** Guest: ticks it has received and not yet run, as it last told us. */
  behind: number;
  /** Until then its silence is forgiven (a player coming back is busy loading the map). */
  grace: number;
  /** Host: his world was found to differ from ours at this tick, or -1. */
  desync: number;
  /** Host: orders from him in the current second, and when that second began. */
  orders: number;
  second: number;
  /** Host, in a versus game: the times he has paused the game. */
  pauses: number;
}

/** Host: the most orders a player may give in one second; the rest are dropped. */
const ORDERS_PER_SECOND = 60;
/** Host, in a versus game: how often each other player may pause it. */
const VERSUS_PAUSES = 3;
/** What the host takes from a guest, and a guest from the host. Anything else is dropped. */
const FROM_GUEST = new Set(['c', 'h', 'ctl', 'p', 'q', 'cam', 'mark']);
const FROM_HOST = new Set(['f', 'r', 'back', 'gone', 'h', 'st', 'p', 'q', 'cam', 'mark']);

/** The co-op session once the players are in. Seat 0 is the host, guests sit in 1 to 3. */
export class Coop {
  /** Someone else is still connected and the sims are in step. */
  live = true;
  /** The worlds were found to differ at this tick, or -1. */
  desyncAt = -1;
  /** Hashes compared with another player's so far. */
  checked = 0;
  /** Round trip to the host (guest) or to the slowest guest (host), in milliseconds. */
  ping = 0;
  /** Guest: ticks received and not yet run. */
  behind = 0;
  /** Where each other player is looking, by seat, for the minimap; x < 0 = unknown. */
  readonly partners: { x: number; z: number; at: number }[] = [];
  /** Set by the game. */
  onFrames: (frames: Frame[]) => void = () => {};
  /** Host: an order from the player in `seat`, still to be checked against his army. */
  onCommand: (c: Command, seat: number) => void = () => {};
  onControl: (pause: boolean | undefined, speed: number | undefined) => void = () => {};
  onState: (paused: boolean, speed: number) => void = () => {};
  onMark: (x: number, z: number, from: number, kind: number) => void = () => {};
  /** Someone has come, gone or changed his name: whoever lists the players draws again. */
  onRoster: () => void = () => {};
  /** The host has gone: the guest's sim must run on its own clock from here. */
  onAlone: () => void = () => {};
  /** Host: a player has come back and must be told how the game stands (pause, speed). */
  onJoined: () => void = () => {};
  /** Host: everything every sim has been sent, for a player who comes back. */
  private readonly log = new GameLog();
  /** Host: seats being brought up to date, not yet in the game. */
  private readonly joining = new Set<number>();
  /** Guest who came back: the most ticks he has had to catch up, and the notice that says so. */
  private backlog = 0;
  private catchEl: HTMLElement | null = null;
  /** Our own hashes, by tick. */
  private readonly mine = new Map<number, number>();
  /** Host: the guests by seat. Guest: the host, under seat 0. */
  private readonly peers = new Map<number, Peer>();
  /** Seats still in the game (ours included). */
  private readonly present = new Set<number>();
  private readonly bar: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly noteEl: HTMLElement;
  private early: Frame[] = [];
  private started = false;

  /** The players this game was started with: fixed, the computer's strength hangs on it. */
  readonly humans: number;
  /** The army each seat plays (all 0 in a game together against the computer). */
  readonly teams: number[];
  /** Our army. */
  readonly team: number;
  /** Players against players, no computer. */
  readonly versus: boolean;
  /** Every player's role, by seat: as the game began, then as the game itself has it. */
  readonly duties: number[];
  /** What each player is called, by seat. */
  readonly names: string[];

  constructor(
    readonly role: Role,
    links: Link[],
    /** Our seat. */
    readonly seat: number,
    /** What is being played, and who plays what (sim/match.ts). */
    readonly match: Match,
    listener: Listener | null,
    /** Guest: we are coming back into a game in progress. */
    resumed = false,
  ) {
    const duties = match.players.map((p) => p.duty);
    this.duties = duties;
    this.names = match.players.map((p, k) => cleanName(p.name) || `Player ${k + 1}`);
    this.humans = duties.length;
    this.teams = match.players.map((p) => p.army);
    this.versus = isVersus(match);
    this.team = this.teams[seat] ?? 0;
    for (let k = 0; k < duties.length; k++) {
      this.present.add(k);
      this.partners.push({ x: -1, z: -1, at: 0 });
    }
    this.bar = document.createElement('div');
    this.bar.id = 'coop-status';
    this.bar.className = 'pill';
    this.statusEl = document.createElement('div');
    this.noteEl = document.createElement('div');
    this.bar.append(this.statusEl, this.noteEl);
    (document.getElementById('left') ?? document.body).appendChild(this.bar);
    links.forEach((link, k) => this.attach(role === 'host' ? k + 1 : 0, link));
    if (listener) {
      // A player who lost the connection and opens the invite again is let back in: into
      // the seat he (or anyone) left, with the game so far to play through.
      listener.onLink = (l) => {
        l.onMessage = (m) => {
          if (m.t === 'hello') this.readmit(l, m.build, m.duty | 0, cleanName(m.name));
        };
      };
    }
    if (resumed) {
      this.catchEl = document.createElement('div');
      this.catchEl.id = 'coop-catchup';
      this.catchEl.className = 'panel';
      this.catchEl.textContent = 'Rejoining the battle…';
      document.body.appendChild(this.catchEl);
    }
    let checked = performance.now();
    setInterval(() => {
      const now = performance.now();
      // If this page itself stood still (loading the map, a tab in the background), what
      // the others sent meanwhile has not been read yet: their silence proves nothing.
      // This check is skipped, and a line is only given up after two unbroken ones.
      const stalled = now - checked > 6000;
      checked = now;
      for (const [seat, p] of [...this.peers]) {
        p.link.send({ t: 'p', ts: now, behind: this.behind });
        if (stalled) {
          p.suspect = false;
          continue;
        }
        // A line that dies without saying so (a closed lid, a lost network) is noticed by
        // its silence: twelve seconds without a word, seen on two checks running, so that
        // a long stall of our own (loading) is not mistaken for theirs.
        const quiet = now - p.heard > 12000 && now > p.grace;
        if (quiet && p.suspect) this.drop(seat, 'silent');
        p.suspect = quiet;
      }
      this.paint();
    }, 1000);
    this.paint();
  }

  private attach(seat: number, link: Link): void {
    this.peers.set(seat, {
      link,
      ahead: new Map(),
      heard: performance.now(),
      suspect: false,
      ping: 0,
      behind: 0,
      grace: 0,
      desync: -1,
      orders: 0,
      second: 0,
      pauses: 0,
    });
    link.onMessage = (m) => this.receive(seat, m);
    link.onClose = () => this.drop(seat, 'closed');
  }

  /** Host: someone has opened the invite while the game is running. */
  private readmit(link: Link, build: string, duty: number, name: string): void {
    if (build !== __BUILD__) {
      link.send({ t: 'bad', build: __BUILD__ });
      return;
    }
    let seat = -1;
    for (let k = 1; k < this.humans && seat < 0; k++) {
      if (!this.present.has(k) && !this.joining.has(k)) seat = k;
    }
    if (seat < 0) {
      link.send({ t: 'full' });
      return;
    }
    this.joining.add(seat);
    // The same game as it began: his sim plays it through from the first tick, and the
    // roles, which are part of the game now (decision 146), must begin as they did for
    // everyone else. The role he has just picked goes in as an order once he is in.
    const who = name || this.names[seat];
    const players = this.match.players.map((p, k) => {
      const called = k === seat ? name || undefined : cleanName(this.names[k]) || undefined;
      return called ? { ...p, name: called } : { army: p.army, duty: p.duty };
    });
    link.send({ t: 'cfg', match: { ...this.match, players }, you: seat, resume: true });
    this.say(`${esc(who)} is coming back into the game…`);
    let open = true;
    link.onMessage = () => {};
    link.onClose = () => {
      open = false;
      this.joining.delete(seat);
    };
    // The record goes out a few pieces at a time so the line is not choked; the game runs
    // on meanwhile and the record with it. The moment he has all of it he is in, and the
    // next frames go to him like to everyone else.
    let from = 0;
    let at = 0;
    const feed = () => {
      if (!open) return;
      for (let n = 0; n < 24; n++) {
        const next = this.log.piece(from, at);
        if (!next) {
          this.joining.delete(seat);
          this.present.add(seat);
          this.names[seat] = who;
          this.live = true;
          this.send({ t: 'back', seat, duty, name: name || undefined });
          this.attach(seat, link);
          if (duty !== this.duties[seat]) this.onCommand({ type: CMD_DUTY, duty }, seat);
          // His page is still loading the map and cannot answer yet: a minute's grace
          // before his silence counts against him.
          const p = this.peers.get(seat);
          if (p) p.grace = performance.now() + 90000;
          this.say(`${esc(who)} is back and catching up.`);
          this.onJoined();
          this.onRoster();
          this.paint();
          return;
        }
        link.send({ t: 'r', ...next.piece });
        from = next.piece.to;
        at = next.at;
      }
      setTimeout(feed, 25);
    };
    feed();
  }

  /** The line to this seat is gone. */
  private drop(seat: number, why: string): void {
    const p = this.peers.get(seat);
    if (!p) return;
    console.info(`co-op: the line to seat ${seat} is gone (${why})`);
    this.peers.delete(seat);
    this.present.delete(seat);
    this.partners[seat].x = -1;
    try {
      p.link.close();
    } catch {
      // it was gone already
    }
    if (this.role === 'guest') {
      this.live = false;
      this.say(
        'The line to the host is gone. You keep playing alone from here. If the others are still playing, <button id="coop-rejoin">rejoin their game</button>',
      );
      document.getElementById('coop-rejoin')?.addEventListener('click', () => location.reload());
      this.onAlone();
    } else {
      this.send({ t: 'gone', seat });
      if (this.peers.size === 0) {
        this.live = false;
        this.say(
          'You are the only one left. The game runs on; anyone who opens the invite link again comes back into it.',
        );
      } else {
        this.say(
          `${esc(this.names[seat])} has left. The rest of you play on; the invite link brings them back.`,
        );
      }
    }
    this.onRoster();
    this.paint();
  }

  private say(html: string): void {
    this.noteEl.innerHTML = html;
  }

  /** To everyone we are connected to (but one). */
  private send(m: Msg, except = -1): void {
    for (const [seat, p] of this.peers) if (seat !== except) p.link.send(m);
  }

  /** The game is ready to take frames (the guest may have been sent some while loading). */
  start(): void {
    this.started = true;
    if (this.early.length > 0) this.onFrames(this.early);
    this.early = [];
  }

  private receive(seat: number, m: Msg): void {
    const p = this.peers.get(seat);
    if (!p) return;
    p.heard = performance.now();
    // Only the host runs the clock and says who comes and goes; only guests send orders in.
    if (!(this.role === 'host' ? FROM_GUEST : FROM_HOST).has(m.t)) return;
    if (m.t === 'f' || m.t === 'r') {
      const frames = m.t === 'f' ? m.f : expand(m);
      if (this.started) this.onFrames(frames);
      else for (const f of frames) this.early.push(f);
    } else if (m.t === 'back') {
      this.present.add(m.seat);
      if (m.name) this.names[m.seat] = m.name;
      this.say(`${esc(this.names[m.seat] ?? '')} is back in the game.`);
      this.onRoster();
    } else if (m.t === 'c') {
      const now = performance.now();
      if (now - p.second > 1000) {
        p.second = now;
        p.orders = 0;
      }
      if (++p.orders <= ORDERS_PER_SECOND) this.onCommand(m.c, seat);
    } else if (m.t === 'h') this.theirs(seat, p, m.k, m.v);
    else if (m.t === 'ctl') {
      // In a versus game a player may stop the clock on his opponent only a few times.
      if (this.versus && m.pause === true && ++p.pauses > VERSUS_PAUSES) {
        this.onControl(undefined, m.speed);
      } else this.onControl(m.pause, m.speed);
    } else if (m.t === 'st') this.onState(m.paused, m.speed);
    else if (m.t === 'p') {
      p.behind = m.behind ?? 0;
      p.link.send({ t: 'q', ts: m.ts });
    } else if (m.t === 'q') {
      p.ping = performance.now() - m.ts;
      this.ping = 0;
      for (const o of this.peers.values()) this.ping = Math.max(this.ping, o.ping);
    } else if (m.t === 'cam' || m.t === 'mark') {
      // The host passes these on, saying whose they are.
      const from = this.role === 'host' ? seat : (m.from ?? 0);
      const k = m.t === 'mark' ? (m.k ?? 0) : 0;
      if (this.role === 'host') {
        this.send(
          m.t === 'mark'
            ? { t: 'mark', x: m.x, z: m.z, from, k }
            : { t: 'cam', x: m.x, z: m.z, from },
          seat,
        );
      }
      // Where the other side looks and what it points at is its own business.
      if (this.teams[from] !== this.team) return;
      if (m.t === 'mark') this.onMark(m.x, m.z, from, k);
      else if (this.partners[from]) this.partners[from] = { x: m.x, z: m.z, at: performance.now() };
    } else if (m.t === 'gone') {
      this.present.delete(m.seat);
      if (this.partners[m.seat]) this.partners[m.seat].x = -1;
      this.say(
        `${esc(this.names[m.seat] ?? '')} has left. The rest of you play on; the invite link brings them back.`,
      );
      this.onRoster();
    }
  }

  /**
   * Our world and the one in `seat` differ. For a guest the game is broken. The host's world
   * is the game itself, so for the host only that player is out of step (and a player who
   * claims to be cannot spoil the game for the rest): he can reload and come back in.
   */
  private differ(seat: number, tick: number, a: number, b: number): void {
    this.checked++;
    if (a === b) return;
    if (this.role === 'host') {
      const p = this.peers.get(seat);
      if (!p || p.desync >= 0) return;
      p.desync = tick;
    } else {
      if (this.desyncAt >= 0) return;
      this.desyncAt = tick;
    }
    console.error(`co-op out of sync with seat ${seat} at tick ${tick}: ${a >>> 0} vs ${b >>> 0}`);
    this.paint();
  }

  /** A hash of ours: kept for those who have not reached the tick, checked against those who have. */
  private own(tick: number, hash: number): void {
    this.mine.set(tick, hash);
    // Never let the books grow: an entry nobody answers is dropped.
    if (this.mine.size > 64) this.mine.delete(this.mine.keys().next().value as number);
    for (const [seat, p] of this.peers) {
      const seen = p.ahead.get(tick);
      if (seen === undefined) continue;
      p.ahead.delete(tick);
      this.differ(seat, tick, seen, hash);
    }
  }

  private theirs(seat: number, p: Peer, tick: number, hash: number): void {
    const seen = this.mine.get(tick);
    if (seen !== undefined) {
      this.differ(seat, tick, seen, hash);
      return;
    }
    p.ahead.set(tick, hash);
    if (p.ahead.size > 64) p.ahead.delete(p.ahead.keys().next().value as number);
  }

  /** What the sim worker reports after running ticks. */
  fromWorker(net: NetReport): void {
    if (net.frames && net.frames.length > 0 && this.role === 'host') {
      this.log.add(net.frames);
      this.send({ t: 'f', f: net.frames });
    }
    if (net.behind !== undefined) this.behind = net.behind;
    if (this.catchEl) {
      if (this.behind > this.backlog) this.backlog = this.behind;
      if (this.backlog > 0 && this.behind < 40) {
        this.catchEl.remove();
        this.catchEl = null;
      } else if (this.backlog > 0) {
        const done = Math.floor((100 * (this.backlog - this.behind)) / this.backlog);
        this.catchEl.textContent = `Rejoining the battle… ${done}% (${Math.ceil(this.behind / 1200)} min of it still to play through)`;
      }
    }
    if (net.hashes) {
      for (let k = 0; k < net.hashes.length; k += 2) {
        this.send({ t: 'h', k: net.hashes[k], v: net.hashes[k + 1] });
        this.own(net.hashes[k], net.hashes[k + 1]);
      }
    }
  }

  /** Guest: an order of his goes to the host, and comes back in a frame. */
  sendCommand(c: Command): void {
    this.send({ t: 'c', c });
  }

  control(pause: boolean | undefined, speed: number | undefined): void {
    this.send({ t: 'ctl', pause, speed });
  }

  state(paused: boolean, speed: number): void {
    // The host's clock is the only one: a guest has no state to announce.
    if (this.role === 'host') this.send({ t: 'st', paused, speed });
  }

  camera(x: number, z: number): void {
    this.send({ t: 'cam', x: Math.round(x), z: Math.round(z), from: this.seat });
  }

  mark(x: number, z: number, kind = 0): void {
    this.send({ t: 'mark', x: Math.round(x), z: Math.round(z), from: this.seat, k: kind });
  }

  /** Whether the player in `seat` is in the game now. */
  isPresent(seat: number): boolean {
    return this.present.has(seat);
  }

  /** The seats that share our army, ours included, in order. */
  mates(): number[] {
    const out: number[] = [];
    for (let k = 0; k < this.humans; k++) if (this.teams[k] === this.team) out.push(k);
    return out;
  }

  /** The roles as the game has them now (the sim's word). True if any changed. */
  setDuties(duties: readonly number[]): boolean {
    let changed = false;
    for (let k = 0; k < this.duties.length; k++) {
      if (duties[k] === undefined || duties[k] === this.duties[k]) continue;
      this.duties[k] = duties[k];
      changed = true;
    }
    if (changed) this.paint();
    return changed;
  }

  /** The roles of the players still in the game, ours left out. */
  otherDuties(): number[] {
    return this.duties.filter(
      (_, seat) => seat !== this.seat && this.present.has(seat) && this.teams[seat] === this.team,
    );
  }

  private paint(): void {
    let html: string;
    if (this.desyncAt >= 0) {
      html = `<span style="color:#ff8a70">CO-OP OUT OF SYNC since ${(this.desyncAt / 20).toFixed(0)} s: your screen no longer shows the host's battle. Reload the page to rejoin it.</span>`;
    } else if (!this.live) {
      html = '';
    } else {
      let lag = this.behind > 8 ? ` · catching up ${this.behind}` : '';
      // The host's clock never waits for a slow player; it says who is running late.
      for (const [seat, p] of this.peers) {
        if (this.role !== 'host') continue;
        if (p.desync >= 0)
          lag += ` · <span style="color:#ff8a70">${esc(this.names[seat])} is out of sync (a reload brings them back)</span>`;
        else if (p.behind > 40)
          lag += ` · ${esc(this.names[seat])} is ${(p.behind / 20).toFixed(0)} s behind`;
      }
      // Who plays what is on the team panel (client/team.ts); this line is the connection.
      const duties = '';
      const count = this.present.size > 2 ? ` · ${this.present.size} players` : '';
      const what = this.versus ? `Versus (you are ${SIDES[this.team].toLowerCase()})` : 'Co-op';
      html = `${what} ${this.role}${count} · ${this.ping.toFixed(0)} ms${lag}${duties}`;
    }
    if (html !== this.statusEl.innerHTML) this.statusEl.innerHTML = html;
  }
}

function randomId(): string {
  const letters = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = 'rev-';
  const r = new Uint32Array(8);
  crypto.getRandomValues(r);
  for (const v of r) s += letters[v % letters.length];
  return s;
}

/**
 * Before the game is built: if the address asks for co-op, meet the other players and
 * agree what is to be played. The game is the host's (`Coop.match`): his address read as a
 * Match, with the players the lobby gathered. Resolves null for a game alone.
 */
export async function openCoop(params: URLSearchParams): Promise<Coop | null> {
  const join = params.get('join');
  const hosting = params.get('coop') === 'host';
  if (!join && !hosting) return null;
  const local = params.get('net') === 'local';
  const ui = overlay();
  let duty = readDuty();
  let name = readName();
  const home = `${location.origin}${location.pathname}`;
  const alone = `<p class="small"><a href="${esc(home)}">Back to the main menu</a></p>`;

  if (hosting) {
    let id = '';
    try {
      id = sessionStorage.getItem('revolution.coop.id') ?? '';
    } catch {
      // a fresh address each time, then
    }
    if (!/^rev-[a-z0-9]{8}$/.test(id)) id = randomId();
    let listener: Listener | null = null;
    ui.set(page('Co-op with friends', '<p>Opening a line…</p>'));
    for (let attempt = 0; attempt < 6 && !listener; attempt++) {
      try {
        listener = local ? localListen(id) : await peerListen(id);
      } catch (e) {
        const type = (e as { type?: string }).type;
        // The address is still held by the page we just left: give the broker a moment.
        if (type === 'unavailable-id' && attempt < 3) await wait(1200);
        else if (type === 'unavailable-id') id = randomId();
        else {
          ui.set(
            page(
              'Co-op with friends',
              `<p>Could not reach the meeting point (the public PeerJS broker): ${esc((e as Error).message ?? type ?? e)}.</p><p>Check the connection and reload the page to try again.</p>${alone}`,
            ),
          );
          return new Promise<never>(() => {});
        }
      }
    }
    if (!listener) return new Promise<never>(() => {});
    try {
      sessionStorage.setItem('revolution.coop.id', id);
    } catch {
      // fine
    }
    const invite = `${home}?join=${id}${local ? '&net=local' : ''}`;
    // What the address asks for, as a game alone: the lobby adds the players. A shared
    // game is always the plain skirmish.
    const asked = new URLSearchParams(params);
    for (const k of ['scenario', 'demo', 'units']) asked.delete(k);
    const base = matchFromParams(asked);
    const battle = fieldLabel(base);
    ui.set(
      `<div class="top"><h1>Invite your team</h1><span>${esc(battle)}</span></div>` +
        `<div class="cols2"><div class="col">` +
        `<label class="opt"><span>Game</span><select id="coop-mode"><option value="coop">Together against the computer</option><option value="versus">Versus: players against players</option></select></label>` +
        `<div id="coop-side-box"></div>` +
        namePicker(name) +
        dutyPicker(duty) +
        `<p id="coop-blurb" class="small"></p>${alone}` +
        `</div><div class="col" style="gap:10px">` +
        `<span class="label" id="coop-count">Players</span>` +
        `<div id="coop-roster" class="col" style="gap:10px"></div>` +
        `<div class="linkrow"><input id="coop-link" readonly value="${esc(invite)}" aria-label="Invitation link" /><button id="coop-copy" class="ghost">Copy link</button></div>` +
        `<p class="small">Send this link to everyone you want to play with (up to ${MAX_PLAYERS - 1} others; the same link for all). When they are all listed, press Start. <span id="coop-copied" style="color:var(--good)"></span></p>` +
        `</div></div>` +
        `<div class="bar"><button id="coop-start" class="go" disabled>Start the game</button></div>`,
    );
    document.getElementById('coop-copy')?.addEventListener('click', () => {
      const done = document.getElementById('coop-copied');
      navigator.clipboard?.writeText(invite).then(
        () => done && (done.textContent = 'copied'),
        () => done && (done.textContent = 'select the link and copy it by hand'),
      );
    });
    const listening = listener;
    return new Promise<Coop>((resolve) => {
      const guests: { link: Link; duty: number; side: number; name: string }[] = [];
      // What each is called: his own name, or his place at the table.
      const called = () => [
        name || 'Player 1',
        ...guests.map((g, k) => g.name || `Player ${k + 2}`),
      ];
      const startBtn = document.getElementById('coop-start') as HTMLButtonElement;
      const modeEl = document.getElementById('coop-mode') as HTMLSelectElement;
      let versus = false;
      let side = 0;
      try {
        versus = sessionStorage.getItem('revolution.coop.mode') === 'versus';
      } catch {
        // co-op, then
      }
      modeEl.value = versus ? 'versus' : 'coop';
      const sides = () => [side, ...guests.map((g) => g.side)];
      const roster = () => {
        const all = sides();
        const el = document.getElementById('coop-roster');
        if (el) {
          const tag = (k: number) => (versus ? ` · ${sideTag(all[k])}` : '');
          const seat = (who: string, d: number, k: number) =>
            `<div class="seat"><i style="background:${SEAT_COLOURS[k]}"></i><b>${esc(who)}</b><span>${DUTIES[d] ?? DUTIES[0]}${tag(k)}</span></div>`;
          const names = called();
          el.innerHTML =
            seat(`${names[0]} (you, host)`, duty, 0) +
            guests.map((g, k) => seat(names[k + 1], g.duty, k + 1)).join('') +
            `<div class="seat open"><i></i><b>Open seat</b><span>Waiting for someone to open the link</span></div>`.repeat(
              MAX_PLAYERS - 1 - guests.length,
            );
        }
        const count = document.getElementById('coop-count');
        if (count) count.textContent = `Players, ${guests.length + 1} of ${MAX_PLAYERS}`;
        const box = document.getElementById('coop-side-box');
        if (box) {
          box.innerHTML = versus ? sidePicker(side) : '';
          watchSide((v) => {
            side = v;
            roster();
          });
        }
        const blurb = document.getElementById('coop-blurb');
        if (blurb) {
          blurb.textContent = versus
            ? 'Red against blue, no computer. Players on the same side share one army, like co-op: two a side is 2 v 2, one a side is a duel, and uneven sides are allowed. Each side sees only what its own troops see. Keep this tab open; you are the host, and the map and the time of day are the ones you had chosen.'
            : 'You all play the same army against the computer: any of you can order any unit. With three or four players the computer gets a bigger economy and attacks sooner. Keep this tab open; you are the host, and the map and opponent are the ones you had chosen. Use the same browser version if you can.';
        }
        const both = all.includes(0) && all.includes(1);
        startBtn.disabled = guests.length === 0 || (versus && !both);
        startBtn.textContent =
          guests.length === 0
            ? 'Start the game'
            : versus && !both
              ? 'Each side needs a player'
              : `Start the game with ${guests.length + 1} players`;
        const names = called();
        const duties = [duty, ...guests.map((g) => g.duty)];
        guests.forEach((g, k) =>
          g.link.send({
            t: 'wait',
            n: guests.length + 1,
            versus,
            sides: all,
            you: k + 1,
            names,
            duties,
          }),
        );
      };
      modeEl.addEventListener('change', () => {
        versus = modeEl.value === 'versus';
        try {
          sessionStorage.setItem('revolution.coop.mode', modeEl.value);
        } catch {
          // not remembered
        }
        roster();
      });
      watchDuty((d) => {
        duty = d;
        roster();
      });
      watchName((n) => {
        name = n;
        roster();
      });
      roster();
      listening.onLink = (link) => {
        link.onMessage = (m) => {
          if (m.t !== 'hello') return;
          if (m.build !== __BUILD__) {
            link.send({ t: 'bad', build: __BUILD__ });
            return;
          }
          if (guests.length >= MAX_PLAYERS - 1) {
            link.send({ t: 'full' });
            return;
          }
          // A newcomer goes to the side that is short of a player.
          const all = sides();
          const reds = all.filter((v) => v === 0).length;
          const guest = {
            link,
            duty: m.duty | 0,
            side: reds > all.length - reds ? 1 : 0,
            name: cleanName(m.name),
          };
          guests.push(guest);
          link.onMessage = (n) => {
            if (n.t === 'duty') {
              guest.duty = n.duty | 0;
              guest.name = cleanName(n.name);
            } else if (n.t === 'side') guest.side = n.side === 1 ? 1 : 0;
            else return;
            roster();
          };
          link.onClose = () => {
            const k = guests.indexOf(guest);
            if (k >= 0) guests.splice(k, 1);
            roster();
          };
          roster();
        };
      };
      startBtn.addEventListener('click', () => {
        if (guests.length === 0) return;
        // The one description of the game: every player's sim is built from this and
        // nothing else. Versus is red against blue with players for both and no computer.
        const duties = [duty, ...guests.map((g) => g.duty)];
        const armyOf = versus ? sides() : duties.map(() => 0);
        const match: Match = {
          ...base,
          armies: versus
            ? base.armies.slice(0, 2).map((a) => ({ faction: a.faction, controller: 'human' }))
            : base.armies,
          players: duties.map((d, k) => {
            const who = k === 0 ? name : guests[k - 1].name;
            return who ? { army: armyOf[k], duty: d, name: who } : { army: armyOf[k], duty: d };
          }),
        };
        guests.forEach((g, k) => g.link.send({ t: 'cfg', match, you: k + 1 }));
        ui.hide();
        resolve(
          new Coop(
            'host',
            guests.map((g) => g.link),
            0,
            match,
            listening,
          ),
        );
      });
    });
  }

  // The guest.
  ui.set(
    `<div class="top"><h1>Joining a battle</h1></div><div class="cols2"><div class="col">` +
      `<p id="coop-say" class="sub" style="margin:0">Looking for the host…</p><div id="coop-side-box"></div>${namePicker(name)}${dutyPicker(duty)}${alone}</div>` +
      `<div class="col" style="gap:10px"><span class="label">Players</span><div id="coop-roster" class="col" style="gap:10px"></div></div></div>`,
  );
  let lobby: Link | null = null;
  watchDuty((d) => {
    duty = d;
    lobby?.send({ t: 'duty', duty, name: name || undefined });
  });
  watchName((n) => {
    name = n;
    lobby?.send({ t: 'duty', duty, name: name || undefined });
  });
  const say = (text: string) => {
    const el = document.getElementById('coop-say');
    if (el) el.textContent = text;
  };
  type Answer = Extract<Msg, { t: 'cfg' | 'busy' | 'bad' | 'full' }>;
  for (let attempt = 0; attempt < 120; attempt++) {
    let link: Link;
    try {
      link = local ? localLink(join as string) : await peerJoin(join as string);
    } catch (e) {
      const type = (e as { type?: string }).type;
      say(
        type === 'peer-unavailable'
          ? 'The host is not there yet (or the link is an old one). Trying again every few seconds…'
          : `No connection yet (${String((e as Error).message ?? type ?? e)}). Trying again…`,
      );
      await wait(2500);
      continue;
    }
    const answer = await new Promise<Answer | null>((done) => {
      // The host answers at once that we are in; the game itself starts when he says so.
      const timer = setTimeout(() => done(null), local ? 1500 : 8000);
      link.onMessage = (m) => {
        if (m.t === 'wait') {
          clearTimeout(timer);
          lobby = link;
          say(`You are in: ${m.n} players so far. The game starts when the host presses Start.`);
          const list = document.getElementById('coop-roster');
          if (list && m.names) {
            list.innerHTML = m.names
              .map(
                (who, k) =>
                  `<div class="seat"><i style="background:${SEAT_COLOURS[k]}"></i><b>${esc(who)}${k === m.you ? ' (you)' : k === 0 ? ' (host)' : ''}</b><span>${DUTIES[m.duties?.[k] ?? 0] ?? DUTIES[0]}</span></div>`,
              )
              .join('');
          }
          const box = document.getElementById('coop-side-box');
          if (box) {
            const all = m.sides ?? [];
            const mine = all[m.you ?? -1] ?? 0;
            box.innerHTML = m.versus
              ? `<p class="small">A versus game: red against blue. ${all
                  .map((v, k) => `${k === m.you ? 'You' : `Player ${k + 1}`}: ${sideTag(v)}`)
                  .join(' · ')}</p>${sidePicker(mine)}`
              : '';
            watchSide((v) => link.send({ t: 'side', side: v }));
          }
        } else if (m.t === 'cfg' || m.t === 'busy' || m.t === 'bad' || m.t === 'full') {
          clearTimeout(timer);
          done(m);
        }
      };
      link.onClose = () => done(null);
      link.send({ t: 'hello', build: __BUILD__, duty, name: name || undefined });
    });
    lobby = null;
    if (answer?.t === 'cfg') {
      ui.hide();
      // The game is the host's, whole; our role is as the host has it.
      return new Coop('guest', [link], answer.you, answer.match, null, answer.resume === true);
    }
    link.close();
    if (answer?.t === 'bad') {
      ui.set(
        page(
          'Joining a battle',
          `<p>You and the host are on different versions of the game (yours: ${esc(__BUILD__)}, the host's: ${esc(answer.build)}). Both of you: reload the page with Cmd+Shift+R (Ctrl+Shift+R on Windows), then the host sends a new link.</p>${alone}`,
        ),
      );
      return new Promise<never>(() => {});
    }
    say(
      answer?.t === 'busy'
        ? 'The host is in the middle of a game. Waiting…'
        : answer?.t === 'full'
          ? `That game already has ${MAX_PLAYERS} players. Waiting for a place…`
          : 'Waiting for the host…',
    );
    await wait(2500);
  }
  say('No host found. Ask for a new link.');
  return new Promise<never>(() => {});
}
