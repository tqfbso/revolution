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
import type { Command } from '../sim/commands';
import type { Frame, NetReport } from '../worker/protocol';
import { GameLog, expand, type Piece } from './replay';

declare const __BUILD__: string;

export type Role = 'host' | 'guest';
/** What each player has said he will look after. Advice, not a lock: anyone can do anything. */
export const DUTIES = ['Everything', 'Armour', 'Infantry', 'Air and drones', 'Economy'] as const;

/** The kinds of unit each role looks after (KIND_* numbers), by index into DUTIES. */
const DUTY_KINDS: number[][] = [[], [0, 3, 4, 8, 9], [1, 2, 5, 11], [6, 7, 12, 13, 14], [10]];

/** The most players in one game, the host included. */
export const MAX_PLAYERS = 4;

/** For each kind of unit: 1 if it falls under `mine`, 2 if under another player's, else 0. */
export function dutyOf(mine: number, theirs: number[], kinds: number): number[] {
  const out = new Array<number>(kinds).fill(0);
  for (const t of theirs) for (const k of DUTY_KINDS[t] ?? []) out[k] = 2;
  for (const k of DUTY_KINDS[mine] ?? []) out[k] = 1;
  return out;
}

interface Config {
  seed: number;
  map: string;
  ai: string;
  /** Players in the game: the computer is given more to fight three or four with. */
  humans: number;
}

type Msg =
  | { t: 'hello'; build: string; duty: number }
  /** Guest, in the lobby: I have changed my role. */
  | { t: 'duty'; duty: number }
  /** Host, in the lobby: you are in, with this many players so far. */
  | { t: 'wait'; n: number }
  /** Host: the game starts. Every player's role by seat (0 = the host), and your seat. */
  | { t: 'cfg'; cfg: Config; duties: number[]; you: number; resume?: boolean }
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
    else if (e.data.m) link.onMessage(e.data.m);
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
    if (!e.data.m) return;
    if (e.data.m.t === 'hello') {
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
    links.get(gid)?.onMessage(e.data.m);
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
  conn.on('data', (d) => link.onMessage(d as Msg));
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
  el.style.cssText =
    'position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;' +
    'background:rgba(12,14,16,0.86);color:#e8e6df;font:15px/1.5 system-ui,sans-serif';
  const box = document.createElement('div');
  box.style.cssText =
    'max-width:560px;padding:26px 30px;background:#1b1e21;border:1px solid #3a4046;border-radius:10px';
  el.appendChild(box);
  document.body.appendChild(el);
  return { el, set: (html) => (box.innerHTML = html), hide: () => el.remove() };
}

function readDuty(): number {
  try {
    const d = Number(localStorage.getItem('revolution.duty') ?? 0) | 0;
    return d >= 0 && d < DUTIES.length ? d : 0;
  } catch {
    return 0;
  }
}

const dutyPicker = (duty: number): string =>
  `<label style="display:block;margin-top:14px">Your role (advice for the team, nothing is locked): ` +
  `<select id="coop-duty">${DUTIES.map((d, k) => `<option value="${k}"${k === duty ? ' selected' : ''}>${d}</option>`).join('')}</select></label>`;

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
}

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
  onCommand: (c: Command) => void = () => {};
  onControl: (pause: boolean | undefined, speed: number | undefined) => void = () => {};
  onState: (paused: boolean, speed: number) => void = () => {};
  onMark: (x: number, z: number, from: number) => void = () => {};
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

  constructor(
    readonly role: Role,
    links: Link[],
    /** Our seat. */
    readonly seat: number,
    /** Every player's role, by seat. */
    readonly duties: number[],
    listener: Listener | null,
    /** Host: what is being played, for a player who comes back. */
    private readonly cfg: Config | null = null,
    /** Guest: we are coming back into a game in progress. */
    resumed = false,
  ) {
    this.humans = duties.length;
    for (let k = 0; k < duties.length; k++) {
      this.present.add(k);
      this.partners.push({ x: -1, z: -1, at: 0 });
    }
    this.bar = document.createElement('div');
    this.bar.id = 'coop-status';
    this.bar.style.cssText =
      'position:fixed;top:44px;left:50%;transform:translateX(-50%);z-index:20;padding:3px 12px;' +
      'background:rgba(20,23,26,0.82);color:#d8d6cf;border:1px solid #3a4046;border-radius:6px;' +
      'font:12px/1.5 ui-monospace,monospace;pointer-events:auto;text-align:center';
    this.statusEl = document.createElement('div');
    this.noteEl = document.createElement('div');
    this.noteEl.style.color = '#e8c36a';
    this.bar.append(this.statusEl, this.noteEl);
    document.body.appendChild(this.bar);
    links.forEach((link, k) => this.attach(role === 'host' ? k + 1 : 0, link));
    if (listener) {
      // A player who lost the connection and opens the invite again is let back in: into
      // the seat he (or anyone) left, with the game so far to play through.
      listener.onLink = (l) => {
        l.onMessage = (m) => {
          if (m.t === 'hello') this.readmit(l, m.build, m.duty | 0);
        };
      };
    }
    if (resumed) {
      this.catchEl = document.createElement('div');
      this.catchEl.id = 'coop-catchup';
      this.catchEl.style.cssText =
        'position:fixed;top:38%;left:50%;transform:translateX(-50%);z-index:40;padding:18px 28px;' +
        'background:rgba(20,23,26,0.92);color:#e8e6df;border:1px solid #3a4046;border-radius:8px;' +
        'font:16px/1.5 system-ui,sans-serif;text-align:center';
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
    });
    link.onMessage = (m) => this.receive(seat, m);
    link.onClose = () => this.drop(seat, 'closed');
  }

  /** Host: someone has opened the invite while the game is running. */
  private readmit(link: Link, build: string, duty: number): void {
    if (build !== __BUILD__) {
      link.send({ t: 'bad', build: __BUILD__ });
      return;
    }
    let seat = -1;
    for (let k = 1; k < this.humans && seat < 0; k++) {
      if (!this.present.has(k) && !this.joining.has(k)) seat = k;
    }
    if (seat < 0 || !this.cfg || this.desyncAt >= 0) {
      link.send({ t: 'full' });
      return;
    }
    this.joining.add(seat);
    const duties = this.duties.slice();
    duties[seat] = duty;
    link.send({ t: 'cfg', cfg: this.cfg, duties, you: seat, resume: true });
    this.say(`Player ${seat + 1} is coming back into the game…`);
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
          this.duties[seat] = duty;
          this.present.add(seat);
          this.live = true;
          this.send({ t: 'back', seat, duty });
          this.attach(seat, link);
          // His page is still loading the map and cannot answer yet: a minute's grace
          // before his silence counts against him.
          const p = this.peers.get(seat);
          if (p) p.grace = performance.now() + 90000;
          this.say(`Player ${seat + 1} is back and catching up.`);
          this.onJoined();
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
          `Player ${seat + 1} has left. The rest of you play on; the invite link brings him back.`,
        );
      }
    }
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
    if (m.t === 'f' || m.t === 'r') {
      const frames = m.t === 'f' ? m.f : expand(m);
      if (this.started) this.onFrames(frames);
      else for (const f of frames) this.early.push(f);
    } else if (m.t === 'back') {
      this.present.add(m.seat);
      this.duties[m.seat] = m.duty;
      this.say(`Player ${m.seat + 1} is back in the game.`);
    } else if (m.t === 'c') this.onCommand(m.c);
    else if (m.t === 'h') this.theirs(p, m.k, m.v);
    else if (m.t === 'ctl') this.onControl(m.pause, m.speed);
    else if (m.t === 'st') this.onState(m.paused, m.speed);
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
      if (this.role === 'host') this.send({ ...m, from }, seat);
      if (m.t === 'mark') this.onMark(m.x, m.z, from);
      else if (this.partners[from]) this.partners[from] = { x: m.x, z: m.z, at: performance.now() };
    } else if (m.t === 'gone') {
      this.present.delete(m.seat);
      if (this.partners[m.seat]) this.partners[m.seat].x = -1;
      this.say(
        `Player ${m.seat + 1} has left. The rest of you play on; the invite link brings him back.`,
      );
    }
  }

  private differ(tick: number, a: number, b: number): void {
    this.checked++;
    if (a === b || this.desyncAt >= 0) return;
    this.desyncAt = tick;
    console.error(`co-op out of sync at tick ${tick}: ${a >>> 0} vs ${b >>> 0}`);
    this.paint();
  }

  /** A hash of ours: kept for those who have not reached the tick, checked against those who have. */
  private own(tick: number, hash: number): void {
    this.mine.set(tick, hash);
    // Never let the books grow: an entry nobody answers is dropped.
    if (this.mine.size > 64) this.mine.delete(this.mine.keys().next().value as number);
    for (const p of this.peers.values()) {
      const seen = p.ahead.get(tick);
      if (seen === undefined) continue;
      p.ahead.delete(tick);
      this.differ(tick, seen, hash);
    }
  }

  private theirs(p: Peer, tick: number, hash: number): void {
    const seen = this.mine.get(tick);
    if (seen !== undefined) {
      this.differ(tick, seen, hash);
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

  mark(x: number, z: number): void {
    this.send({ t: 'mark', x: Math.round(x), z: Math.round(z), from: this.seat });
  }

  /** The roles of the players still in the game, ours left out. */
  otherDuties(): number[] {
    return this.duties.filter((_, seat) => seat !== this.seat && this.present.has(seat));
  }

  private paint(): void {
    let html: string;
    if (this.desyncAt >= 0) {
      html = `<span style="color:#ff8a70">CO-OP OUT OF SYNC since ${(this.desyncAt / 20).toFixed(0)} s: the screens no longer show the same battle. Start a new co-op game.</span>`;
    } else if (!this.live) {
      html = '';
    } else {
      let lag = this.behind > 8 ? ` · catching up ${this.behind}` : '';
      // The host's clock never waits for a slow player; it says who is running late.
      for (const [seat, p] of this.peers) {
        if (this.role === 'host' && p.behind > 40)
          lag += ` · P${seat + 1} is ${(p.behind / 20).toFixed(0)} s behind`;
      }
      let duties = '';
      if (this.duties.some((d) => d > 0)) {
        for (const seat of [...this.present].sort()) {
          duties += ` · ${seat === this.seat ? 'you' : `P${seat + 1}`}: ${DUTIES[this.duties[seat]]}`;
        }
      }
      const count = this.present.size > 2 ? ` · ${this.present.size} players` : '';
      html = `Co-op ${this.role}${count} · ${this.ping.toFixed(0)} ms${lag}${duties}`;
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
 * Before the game is built: if the address asks for co-op, meet the other player and
 * agree what is to be played. A guest's `params` are overwritten with the host's choice of
 * map, seed and opponent. Resolves null for a game alone.
 */
export async function openCoop(params: URLSearchParams): Promise<Coop | null> {
  const join = params.get('join');
  const hosting = params.get('coop') === 'host';
  if (!join && !hosting) return null;
  const local = params.get('net') === 'local';
  const ui = overlay();
  let duty = readDuty();
  const home = `${location.origin}${location.pathname}`;
  const alone = `<p style="margin-top:18px"><a href="${home}" style="color:#9fb7c9">Play alone instead</a></p>`;

  if (hosting) {
    let id = '';
    try {
      id = sessionStorage.getItem('revolution.coop.id') ?? '';
    } catch {
      // a fresh address each time, then
    }
    if (!/^rev-[a-z0-9]{8}$/.test(id)) id = randomId();
    let listener: Listener | null = null;
    ui.set('<h2 style="margin:0 0 8px">Co-op</h2><p>Opening a line…</p>');
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
            `<h2 style="margin:0 0 8px">Co-op</h2><p>Could not reach the meeting point (the public PeerJS broker): ${String((e as Error).message ?? type ?? e)}.</p><p>Check the connection and reload the page to try again.</p>${alone}`,
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
    ui.set(
      `<h2 style="margin:0 0 8px">Co-op: invite your team</h2>` +
        `<p>Send this link to everyone you want to play with (up to ${MAX_PLAYERS - 1} others; the same link for all). When they are all listed below, press Start.</p>` +
        `<p><input id="coop-link" readonly value="${invite}" style="width:100%;padding:7px;background:#101214;color:#e8e6df;border:1px solid #3a4046;border-radius:5px;font:13px ui-monospace,monospace" /></p>` +
        `<p><button id="coop-copy" style="padding:6px 14px">Copy link</button> <span id="coop-copied" style="color:#8fbf8f"></span></p>` +
        `<div id="coop-roster" style="margin:12px 0;padding:8px 12px;background:#101214;border:1px solid #3a4046;border-radius:5px"></div>` +
        `<p><button id="coop-start" disabled style="padding:8px 20px;font-weight:600">Start the game</button></p>` +
        dutyPicker(duty) +
        `<p style="color:#a9a79f;margin-top:14px">You all play the same army against the computer: any of you can order any unit. With three or four players the computer gets a bigger economy and attacks sooner. Keep this tab open; you are the host, and the map and opponent are the ones you had chosen. Use the same browser version if you can.</p>${alone}`,
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
      const guests: { link: Link; duty: number }[] = [];
      const startBtn = document.getElementById('coop-start') as HTMLButtonElement;
      const roster = () => {
        const el = document.getElementById('coop-roster');
        if (el) {
          el.innerHTML =
            `<div>Player 1 (you, host): ${DUTIES[duty]}</div>` +
            guests.map((g, k) => `<div>Player ${k + 2}: ${DUTIES[g.duty]}</div>`).join('') +
            (guests.length === 0
              ? `<div style="color:#a9a79f">Waiting for someone to open the link…</div>`
              : '');
        }
        startBtn.disabled = guests.length === 0;
        startBtn.textContent =
          guests.length === 0
            ? 'Start the game'
            : `Start the game with ${guests.length + 1} players`;
        for (const g of guests) g.link.send({ t: 'wait', n: guests.length + 1 });
      };
      watchDuty((d) => {
        duty = d;
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
          const guest = { link, duty: m.duty | 0 };
          guests.push(guest);
          link.onMessage = (n) => {
            if (n.t !== 'duty') return;
            guest.duty = n.duty | 0;
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
        const cfg: Config = {
          seed: Number(params.get('seed') ?? 1) | 0,
          map: params.get('map') ?? 'city',
          ai: params.get('ai') ?? '',
          humans: guests.length + 1,
        };
        const duties = [duty, ...guests.map((g) => g.duty)];
        guests.forEach((g, k) => g.link.send({ t: 'cfg', cfg, duties, you: k + 1 }));
        ui.hide();
        resolve(
          new Coop(
            'host',
            guests.map((g) => g.link),
            0,
            duties,
            listening,
            cfg,
          ),
        );
      });
    });
  }

  // The guest.
  ui.set(
    `<h2 style="margin:0 0 8px">Co-op</h2><p id="coop-say">Looking for the host…</p>${dutyPicker(duty)}${alone}`,
  );
  let lobby: Link | null = null;
  watchDuty((d) => {
    duty = d;
    lobby?.send({ t: 'duty', duty });
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
        } else if (m.t === 'cfg' || m.t === 'busy' || m.t === 'bad' || m.t === 'full') {
          clearTimeout(timer);
          done(m);
        }
      };
      link.onClose = () => done(null);
      link.send({ t: 'hello', build: __BUILD__, duty });
    });
    lobby = null;
    if (answer?.t === 'cfg') {
      params.set('seed', String(answer.cfg.seed));
      params.set('map', answer.cfg.map);
      if (answer.cfg.ai) params.set('ai', answer.cfg.ai);
      else params.delete('ai');
      ui.hide();
      // Our role as the host has it, unless we changed it in the last instant.
      return new Coop(
        'guest',
        [link],
        answer.you,
        answer.duties,
        null,
        null,
        answer.resume === true,
      );
    }
    link.close();
    if (answer?.t === 'bad') {
      ui.set(
        `<h2 style="margin:0 0 8px">Co-op</h2><p>You and the host are on different versions of the game (yours: ${__BUILD__}, the host's: ${answer.build}). Both of you: reload the page with Cmd+Shift+R (Ctrl+Shift+R on Windows), then the host sends a new link.</p>${alone}`,
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
