// Co-op over the network (decision 092): two browsers, one army, the same battle.
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
// the free public PeerJS broker, which also lends a relay for networks that block direct
// connections. Nothing of ours runs on a server, so the game still deploys as static
// files. `?net=local` swaps the network for a channel between two tabs of one browser.
import type { Command } from '../sim/commands';
import type { Frame, NetReport } from '../worker/protocol';

declare const __BUILD__: string;

export type Role = 'host' | 'guest';
/** What each player has said he will look after. Advice, not a lock: anyone can do anything. */
export const DUTIES = ['Everything', 'Armour', 'Infantry', 'Air and drones', 'Economy'] as const;

/** The kinds of unit each role looks after (KIND_* numbers), by index into DUTIES. */
const DUTY_KINDS: number[][] = [[], [0, 3, 4, 8, 9], [1, 2, 5, 11], [6, 7], [10]];

/** For each kind of unit: 1 if it falls under `mine`, 2 if under `theirs`, else 0. */
export function dutyOf(mine: number, theirs: number, kinds: number): number[] {
  const out = new Array<number>(kinds).fill(0);
  for (const k of DUTY_KINDS[theirs] ?? []) out[k] = 2;
  for (const k of DUTY_KINDS[mine] ?? []) out[k] = 1;
  return out;
}

interface Config {
  seed: number;
  map: string;
  ai: string;
}

type Msg =
  | { t: 'hello'; build: string; duty: number }
  | { t: 'cfg'; cfg: Config; duty: number }
  | { t: 'busy' }
  | { t: 'bad'; build: string }
  | { t: 'f'; f: Frame[] }
  | { t: 'c'; c: Command }
  | { t: 'h'; k: number; v: number }
  | { t: 'ctl'; pause?: boolean; speed?: number }
  | { t: 'st'; paused: boolean; speed: number }
  | { t: 'p'; ts: number }
  | { t: 'q'; ts: number }
  | { t: 'cam'; x: number; z: number }
  | { t: 'mark'; x: number; z: number };

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

function localLink(id: string, me: Role): Link {
  const ch = new BroadcastChannel(`revolution-coop-${id}`);
  const link: Link = {
    send: (m) => ch.postMessage({ from: me, m }),
    onMessage: () => {},
    onClose: () => {},
    close: () => {
      ch.postMessage({ from: me, bye: true });
      ch.close();
    },
  };
  ch.onmessage = (e: MessageEvent<{ from: Role; m?: Msg; bye?: boolean }>) => {
    if (e.data.from === me) return;
    if (e.data.bye) link.onClose();
    else if (e.data.m) link.onMessage(e.data.m);
  };
  window.addEventListener('pagehide', () => ch.postMessage({ from: me, bye: true }));
  return link;
}

function localListen(id: string): Listener {
  // One channel serves every guest in turn: a hello opens a link, a bye closes it.
  const ch = new BroadcastChannel(`revolution-coop-${id}`);
  let link: Link | null = null;
  const listener: Listener = { id, onLink: () => {}, close: () => ch.close() };
  ch.onmessage = (e: MessageEvent<{ from: Role; m?: Msg; bye?: boolean }>) => {
    if (e.data.from !== 'guest') return;
    if (e.data.bye) {
      link?.onClose();
      link = null;
      return;
    }
    if (!e.data.m) return;
    if (e.data.m.t === 'hello') {
      link?.onClose();
      link = {
        send: (m) => ch.postMessage({ from: 'host', m }),
        onMessage: () => {},
        onClose: () => {},
        close: () => ch.postMessage({ from: 'host', bye: true }),
      };
      listener.onLink(link);
    }
    link?.onMessage(e.data.m);
  };
  window.addEventListener('pagehide', () => ch.postMessage({ from: 'host', bye: true }));
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
  `<label style="display:block;margin-top:14px">Your role (advice for the two of you, nothing is locked): ` +
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

/** The co-op session once both players are in. */
export class Coop {
  /** The other player is connected and the two sims are in step. */
  live = true;
  /** The worlds were found to differ at this tick, or -1. */
  desyncAt = -1;
  /** Round trip to the other player, in milliseconds. */
  ping = 0;
  /** Guest: ticks received and not yet run. */
  behind = 0;
  /** Where the partner is looking, for the minimap; x < 0 = unknown. */
  partner = { x: -1, z: -1, at: 0 };
  /** Set by the game. */
  onFrames: (frames: Frame[]) => void = () => {};
  onCommand: (c: Command) => void = () => {};
  onControl: (pause: boolean | undefined, speed: number | undefined) => void = () => {};
  onState: (paused: boolean, speed: number) => void = () => {};
  onMark: (x: number, z: number) => void = () => {};
  /** The host has gone: the guest's sim must run on its own clock from here. */
  onAlone: () => void = () => {};
  private readonly mine = new Map<number, number>();
  private readonly theirs = new Map<number, number>();
  private readonly bar: HTMLElement;
  private note = '';
  private early: Frame[] = [];
  private started = false;
  private heard = performance.now();
  private suspect = false;

  constructor(
    readonly role: Role,
    private link: Link,
    readonly duty: number,
    readonly partnerDuty: number,
    listener: Listener | null,
  ) {
    this.bar = document.createElement('div');
    this.bar.id = 'coop-status';
    this.bar.style.cssText =
      'position:fixed;top:44px;left:50%;transform:translateX(-50%);z-index:20;padding:3px 12px;' +
      'background:rgba(20,23,26,0.82);color:#d8d6cf;border:1px solid #3a4046;border-radius:6px;' +
      'font:12px/1.5 ui-monospace,monospace;pointer-events:auto;text-align:center';
    document.body.appendChild(this.bar);
    this.attach(link);
    if (listener) {
      // A partner who lost the connection and opens the invite again finds a game already
      // under way, which he cannot join half way: the host is offered a fresh start.
      listener.onLink = (l) => {
        l.onMessage = (m) => {
          if (m.t !== 'hello') return;
          l.send({ t: 'busy' });
          if (!this.live) {
            this.note =
              'Your partner is back. <button id="coop-restart">Restart the game together</button>';
            this.paint();
            document
              .getElementById('coop-restart')
              ?.addEventListener('click', () => location.reload());
          }
        };
      };
    }
    setInterval(() => {
      if (this.live) {
        this.link.send({ t: 'p', ts: performance.now() });
        // A line that dies without saying so (a closed lid, a lost network) is noticed by
        // its silence: twelve seconds without a word, seen on two checks running, so that
        // a long stall of our own (loading) is not mistaken for theirs.
        const quiet = performance.now() - this.heard > 12000;
        if (quiet && this.suspect) this.link.onClose();
        this.suspect = quiet;
      }
      this.paint();
    }, 1000);
    this.paint();
  }

  private attach(link: Link): void {
    link.onMessage = (m) => this.receive(m);
    link.onClose = () => {
      if (!this.live) return;
      this.live = false;
      this.note =
        this.role === 'guest'
          ? 'The host has left. You keep playing alone from here.'
          : 'Your partner has left. You keep playing alone; if they open the invite link again you can restart together.';
      if (this.role === 'guest') this.onAlone();
      this.paint();
    };
  }

  /** The game is ready to take frames (the guest may have been sent some while loading). */
  start(): void {
    this.started = true;
    if (this.early.length > 0) this.onFrames(this.early);
    this.early = [];
  }

  private receive(m: Msg): void {
    this.heard = performance.now();
    if (m.t === 'f') {
      if (this.started) this.onFrames(m.f);
      else this.early.push(...m.f);
    } else if (m.t === 'c') this.onCommand(m.c);
    else if (m.t === 'h') this.compare(this.theirs, this.mine, m.k, m.v);
    else if (m.t === 'ctl') this.onControl(m.pause, m.speed);
    else if (m.t === 'st') this.onState(m.paused, m.speed);
    else if (m.t === 'p') this.link.send({ t: 'q', ts: m.ts });
    else if (m.t === 'q') this.ping = performance.now() - m.ts;
    else if (m.t === 'cam') this.partner = { x: m.x, z: m.z, at: performance.now() };
    else if (m.t === 'mark') this.onMark(m.x, m.z);
  }

  private compare(
    into: Map<number, number>,
    other: Map<number, number>,
    tick: number,
    hash: number,
  ): void {
    const seen = other.get(tick);
    if (seen === undefined) {
      into.set(tick, hash);
      // Never let the books grow: an entry the other side never answers is dropped.
      if (into.size > 64) into.delete(into.keys().next().value as number);
      return;
    }
    other.delete(tick);
    if (seen !== hash && this.desyncAt < 0) {
      this.desyncAt = tick;
      console.error(`co-op out of sync at tick ${tick}: ${seen >>> 0} vs ${hash >>> 0}`);
      this.paint();
    }
  }

  /** What the sim worker reports after running ticks. */
  fromWorker(net: NetReport): void {
    if (net.frames && net.frames.length > 0 && this.live && this.role === 'host') {
      this.link.send({ t: 'f', f: net.frames });
    }
    if (net.behind !== undefined) this.behind = net.behind;
    if (net.hashes) {
      for (let k = 0; k < net.hashes.length; k += 2) {
        if (this.live) this.link.send({ t: 'h', k: net.hashes[k], v: net.hashes[k + 1] });
        this.compare(this.mine, this.theirs, net.hashes[k], net.hashes[k + 1]);
      }
    }
  }

  /** Guest: an order of his goes to the host, and comes back in a frame. */
  sendCommand(c: Command): void {
    this.link.send({ t: 'c', c });
  }

  control(pause: boolean | undefined, speed: number | undefined): void {
    this.link.send({ t: 'ctl', pause, speed });
  }

  state(paused: boolean, speed: number): void {
    if (this.live) this.link.send({ t: 'st', paused, speed });
  }

  camera(x: number, z: number): void {
    if (this.live) this.link.send({ t: 'cam', x: Math.round(x), z: Math.round(z) });
  }

  mark(x: number, z: number): void {
    if (this.live) this.link.send({ t: 'mark', x: Math.round(x), z: Math.round(z) });
  }

  private paint(): void {
    let html: string;
    if (this.desyncAt >= 0) {
      html = `<span style="color:#ff8a70">CO-OP OUT OF SYNC since ${(this.desyncAt / 20).toFixed(0)} s: the two screens no longer show the same battle. Start a new co-op game.</span>`;
    } else if (!this.live) {
      html = `<span style="color:#e8c36a">${this.note}</span>`;
    } else {
      const lag = this.behind > 8 ? ` · catching up ${this.behind}` : '';
      const duties =
        this.duty > 0 || this.partnerDuty > 0
          ? ` · you: ${DUTIES[this.duty]} · partner: ${DUTIES[this.partnerDuty]}`
          : '';
      html = `Co-op ${this.role} · ${this.ping.toFixed(0)} ms${lag}${duties}`;
    }
    if (html !== this.bar.innerHTML && !this.bar.querySelector('button')) this.bar.innerHTML = html;
    else if (this.bar.querySelector('button') && this.desyncAt >= 0) this.bar.innerHTML = html;
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
      `<h2 style="margin:0 0 8px">Co-op: invite your partner</h2>` +
        `<p>Send this link to the person you want to play with. The game starts for both of you the moment they open it.</p>` +
        `<p><input id="coop-link" readonly value="${invite}" style="width:100%;padding:7px;background:#101214;color:#e8e6df;border:1px solid #3a4046;border-radius:5px;font:13px ui-monospace,monospace" /></p>` +
        `<p><button id="coop-copy" style="padding:6px 14px">Copy link</button> <span id="coop-copied" style="color:#8fbf8f"></span></p>` +
        dutyPicker(duty) +
        `<p style="color:#a9a79f;margin-top:14px">You play the same army against the computer: either of you can order any unit. Keep this tab open; you are the host, and the map and opponent are the ones you had chosen. Both of you should use the same browser version if you can.</p>${alone}`,
    );
    watchDuty((d) => (duty = d));
    document.getElementById('coop-copy')?.addEventListener('click', () => {
      const done = document.getElementById('coop-copied');
      navigator.clipboard?.writeText(invite).then(
        () => done && (done.textContent = 'copied'),
        () => done && (done.textContent = 'select the link and copy it by hand'),
      );
    });
    const listening = listener;
    return new Promise<Coop>((resolve) => {
      listening.onLink = (link) => {
        link.onMessage = (m) => {
          if (m.t !== 'hello') return;
          if (m.build !== __BUILD__) {
            link.send({ t: 'bad', build: __BUILD__ });
            return;
          }
          const cfg: Config = {
            seed: Number(params.get('seed') ?? 1) | 0,
            map: params.get('map') ?? 'city',
            ai: params.get('ai') ?? '',
          };
          link.send({ t: 'cfg', cfg, duty });
          ui.hide();
          resolve(new Coop('host', link, duty, m.duty | 0, listening));
        };
      };
    });
  }

  // The guest.
  ui.set(
    `<h2 style="margin:0 0 8px">Co-op</h2><p id="coop-say">Looking for the host…</p>${dutyPicker(duty)}${alone}`,
  );
  watchDuty((d) => (duty = d));
  const say = (text: string) => {
    const el = document.getElementById('coop-say');
    if (el) el.textContent = text;
  };
  for (let attempt = 0; attempt < 120; attempt++) {
    let link: Link;
    try {
      link = local ? localLink(join as string, 'guest') : await peerJoin(join as string);
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
    const answer = await new Promise<Msg | null>((done) => {
      const timer = setTimeout(() => done(null), local ? 1500 : 8000);
      link.onMessage = (m) => {
        if (m.t === 'cfg' || m.t === 'busy' || m.t === 'bad') {
          clearTimeout(timer);
          done(m);
        }
      };
      link.onClose = () => done(null);
      link.send({ t: 'hello', build: __BUILD__, duty });
    });
    if (answer?.t === 'cfg') {
      params.set('seed', String(answer.cfg.seed));
      params.set('map', answer.cfg.map);
      if (answer.cfg.ai) params.set('ai', answer.cfg.ai);
      else params.delete('ai');
      ui.hide();
      return new Coop('guest', link, duty, answer.duty | 0, null);
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
        ? 'The host is in the middle of a game. Waiting for them to restart it (they have been told you are here)…'
        : 'Waiting for the host…',
    );
    await wait(2500);
  }
  say('No host found. Ask for a new link.');
  return new Promise<never>(() => {});
}
