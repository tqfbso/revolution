// Battle alerts: the map is far larger than the screen, so what happens off it has to be
// announced. A banner with a tone and a spoken line, a ping on the minimap, an arrow at
// the screen edge pointing at it, and Backspace to jump there.
import { KINDS, KIND_DRONE, KIND_TRUCK } from '../sim/units';
import { EV_DEATH, EV_SHOT, EV_SIEGE, EV_STORM, EV_STORMED, MAX_UNITS } from '../sim/world';
import { BASE_STRIDE, INFO_CARRIED, INFO_INSIDE, type Snapshot } from '../worker/protocol';
import type { GameMap } from '../sim/map';
import type { Fog } from './fog';
import type { Minimap } from './minimap';
import type { Sound } from './sound';
import type { StructureView } from './structures';
import type { UnitView } from './units';

export const ALERT_BASE = 0;
export const ALERT_TOWN = 1;
export const ALERT_ARMY = 2;
export const ALERT_CONVOY = 3;
/** A recon drone (or, later, a camera) has found enemy troops nobody was watching. */
export const ALERT_CONTACT = 4;
/** Something to know that is not an attack: a commander's report, troops out of supply. */
export const ALERT_NOTE = 5;
export const ALERT_KINDS = 6;

export interface Alert {
  kind: number;
  x: number;
  z: number;
  text: string;
  /** Seconds on the client clock. */
  at: number;
}

/** The side of the squares the map is cut into: one alert of a kind per square at a time. */
export const ALERT_AREA = 160;
/** Seconds before the same kind of alert is raised again for the same square. */
const AGAIN = [50, 50, 40, 45, 60, 6];
/** Seconds between two alerts of the same kind anywhere: a wide front is not ten banners. */
const GAP = [8, 8, 10, 12, 6, 0];
const KEEP = 12;

/**
 * Which alerts are worth raising: each kind once per area for a while, and never two of a
 * kind in quick succession. No DOM in here, so the rules can be tested.
 */
export class AlertBook {
  /** The alerts raised, oldest first; the last KEEP of them. */
  readonly list: Alert[] = [];
  private readonly last = new Map<number, number>();
  private readonly lastKind = new Array<number>(ALERT_KINDS).fill(-1e9);

  /** May an alert of this kind be raised here now? */
  open(kind: number, x: number, z: number, now: number): boolean {
    if (now - this.lastKind[kind] < GAP[kind]) return false;
    const seen = this.last.get(this.key(kind, x, z));
    return seen === undefined || now - seen >= AGAIN[kind];
  }

  raise(kind: number, x: number, z: number, text: string, now: number): Alert | null {
    if (!this.open(kind, x, z, now)) return null;
    this.last.set(this.key(kind, x, z), now);
    this.lastKind[kind] = now;
    const alert = { kind, x, z, text, at: now };
    this.list.push(alert);
    if (this.list.length > KEEP) this.list.shift();
    return alert;
  }

  /**
   * The fight there is still going on (the player may be watching it): push the next alert
   * for this square back, so looking away does not set it off at once.
   */
  quiet(kind: number, x: number, z: number, now: number): void {
    this.last.set(this.key(kind, x, z), now - AGAIN[kind] + 15);
  }

  private key(kind: number, x: number, z: number): number {
    const ax = Math.max(0, Math.floor(x / ALERT_AREA));
    const az = Math.max(0, Math.floor(z / ALERT_AREA));
    return kind + ALERT_KINDS * (ax + 64 * az);
  }
}

/** A group of enemy units reported together, as words: "14 enemy units, 3 tanks". */
export function contactText(counts: readonly number[]): string {
  let total = 0;
  let top = -1;
  for (let k = 0; k < counts.length; k++) {
    total += counts[k];
    // The heaviest thing in the group is what the player wants to know about.
    if (counts[k] > 0 && KINDS[k].turn > 0 && (top < 0 || KINDS[k].hp > KINDS[top].hp)) top = k;
  }
  const what = total === 1 ? '1 enemy unit' : `${total} enemy units`;
  if (top < 0 || counts[top] === total) {
    if (total === 1) {
      const only = counts.findIndex((c) => c > 0);
      return `Contact: enemy ${KINDS[only].name.toLowerCase()}`;
    }
    return `Contact: ${what}`;
  }
  const name = KINDS[top].name.toLowerCase();
  return `Contact: ${what}, ${counts[top]} ${name}${counts[top] === 1 ? '' : 's'}`;
}

const CSS = ['#ff5a4a', '#ff5a4a', '#ff8a4a', '#ffb347', '#ffd24a', '#7fc8ff'];
const RGB: [number, number, number][] = [
  [255, 70, 60],
  [255, 70, 60],
  [255, 120, 60],
  [255, 170, 60],
  [255, 215, 70],
  [127, 200, 255],
];
const SPOKEN = [
  'Base under attack',
  'Town under attack',
  'Forces under attack',
  'Supply trucks under attack',
  'Contact',
  'Report',
];
/** Seconds a banner stays, and an edge arrow keeps pointing. */
const BANNER_SECONDS = 9;
const ARROW_SECONDS = 20;
/** How long an enemy must have been out of everyone's sight to count as found again. */
const LOST_SECONDS = 25;
const SIGHT = KINDS.map((k) => k.sight / 1024);

/** Where a ground point is on screen: pixels, and whether it is inside the view. */
export type Project = (x: number, z: number) => { sx: number; sy: number; on: boolean };

export class Alerts {
  readonly book = new AlertBook();
  /** Extra eyes that report contacts like a drone does: x, z, radius triples (cameras). */
  watchers: number[] = [];
  private readonly lastSeen = new Float32Array(MAX_UNITS).fill(-1e9);
  private readonly seenGen = new Uint16Array(MAX_UNITS);
  private readonly list: HTMLElement;
  private readonly arrows: HTMLElement;
  private readonly rows: { alert: Alert; el: HTMLElement }[] = [];
  private readonly pointers: { alert: Alert; el: HTMLElement }[] = [];
  private frame = 0;
  private cursor = 0;
  private lastJump = -1e9;
  private spokeAt = -1e9;

  constructor(
    private readonly map: GameMap,
    private readonly units: UnitView,
    private readonly structures: StructureView,
    private readonly fog: Fog,
    private readonly minimap: Minimap,
    private readonly sound: Sound,
    private readonly project: Project,
    private readonly lookAt: (x: number, z: number) => void,
  ) {
    this.list = document.getElementById('alerts') as HTMLElement;
    this.arrows = document.getElementById('alert-arrows') as HTMLElement;
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Backspace' || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      this.jump(performance.now() / 1000);
    });
  }

  /** Backspace: look at the latest alert; again within a few seconds, the one before it. */
  jump(now: number): void {
    const list = this.book.list;
    if (list.length === 0) return;
    this.cursor = now - this.lastJump < 4 ? (this.cursor + 1) % list.length : 0;
    this.lastJump = now;
    const a = list[list.length - 1 - this.cursor];
    this.lookAt(a.x, a.z);
    this.minimap.ping(a.x, a.z, RGB[a.kind]);
  }

  applySnapshot(s: Snapshot, now: number): void {
    const u = this.units;
    const me = u.playerTeam;
    const ev = s.events;
    for (let e = 0; e < ev.length; e += 3) {
      const type = ev[e];
      const a = ev[e + 1];
      const b = ev[e + 2];
      if (type === EV_SHOT) {
        if (u.teamOf(b) === me && u.teamOf(a) !== me) this.struck(b, now);
      } else if (type === EV_DEATH) {
        if (u.teamOf(a) === me && b >= 0 && b < s.count && u.teamOf(b) !== me) this.struck(a, now);
      } else if (type === EV_STORM) {
        // The enemy is fighting its way into a building the player holds.
        if (b === me || this.structures.occTeam[a] !== me) continue;
        const c = this.structures.centreOf(a);
        this.attack(ALERT_ARMY, c.x, c.z, 'Garrison being stormed', now);
      } else if (type === EV_STORMED) {
        const c = this.structures.centreOf(a);
        if (b === me) this.show(this.book.raise(ALERT_NOTE, c.x, c.z, 'Building taken', now));
      } else if (type === EV_SIEGE) {
        if (u.teamOf(a) === me) continue;
        const c = this.structures.centreOf(b);
        if (this.structures.baseTeam[b] === me) {
          this.attack(ALERT_BASE, c.x, c.z, 'Base under attack', now);
        } else {
          const town = this.map.sTown[b];
          if (town >= 0 && this.structures.townOwner[town] === me) {
            this.attack(ALERT_TOWN, c.x, c.z, `${this.map.townName[town]} under attack`, now);
          }
        }
      }
    }
    // Twice a second is plenty for spotting.
    if (this.frame++ % 10 === 0) this.contacts(s, now);
  }

  /** One of the player's units was shot at (or killed) by the enemy. */
  private struck(id: number, now: number): void {
    const u = this.units;
    const x = u.renderPos[3 * id];
    const z = u.renderPos[3 * id + 2];
    if (u.kindOf(id) === KIND_TRUCK) {
      this.attack(ALERT_CONVOY, x, z, 'Supply trucks under attack', now);
      return;
    }
    const bases = this.structures.bases;
    for (let o = 0; o < bases.length; o += BASE_STRIDE) {
      if (bases[o + 2] !== u.playerTeam) continue;
      const c = this.structures.centreOf(bases[o]);
      if ((c.x - x) ** 2 + (c.z - z) ** 2 < 70 * 70) {
        this.attack(ALERT_BASE, x, z, 'Base under attack', now);
        return;
      }
    }
    const map = this.map;
    for (let t = 0; t < map.townCount; t++) {
      if (this.structures.townOwner[t] !== u.playerTeam) continue;
      const p = this.structures.townPos(t);
      const r = map.townR[t] / 1024 + 20;
      if ((p.x - x) ** 2 + (p.z - z) ** 2 < r * r) {
        this.attack(ALERT_TOWN, x, z, `${map.townName[t]} under attack`, now);
        return;
      }
    }
    this.attack(ALERT_ARMY, x, z, 'Our forces under attack', now);
  }

  /** Raise an alert from elsewhere in the client (a camera lost, say). */
  report(kind: number, x: number, z: number, text: string, now: number): void {
    this.show(this.book.raise(kind, x, z, text, now));
  }

  private attack(kind: number, x: number, z: number, text: string, now: number): void {
    if (!this.book.open(kind, x, z, now)) return;
    // What the player is looking at needs no announcement.
    if (this.project(x, z).on) {
      this.book.quiet(kind, x, z, now);
      return;
    }
    this.show(this.book.raise(kind, x, z, text, now));
  }

  /**
   * Enemy troops that have just come into the sight of a recon drone (or a camera) after
   * being out of everyone's sight: one alert per area, however many they are.
   */
  private contacts(s: Snapshot, now: number): void {
    const u = this.units;
    const pos = u.renderPos;
    const eyes = this.watchers.slice();
    for (let i = 0; i < s.count; i++) {
      // A jammed drone sends nothing back (its load is 1 while jammed).
      if (u.isMine(i) && u.kindOf(i) === KIND_DRONE && u.load[i] === 0) {
        eyes.push(pos[3 * i], pos[3 * i + 2], SIGHT[KIND_DRONE]);
      }
    }
    const groups = new Map<number, { x: number; z: number; n: number; counts: number[] }>();
    for (let i = 0; i < s.count; i++) {
      if (!u.isAlive(i) || u.teamOf(i) === u.playerTeam) continue;
      if ((s.info[i] & (INFO_INSIDE | INFO_CARRIED)) !== 0) continue;
      const x = pos[3 * i];
      const z = pos[3 * i + 2];
      if (!this.fog.sees(x, z)) continue;
      if (this.seenGen[i] !== u.gen[i]) {
        this.seenGen[i] = u.gen[i];
        this.lastSeen[i] = -1e9;
      }
      const fresh = now - this.lastSeen[i] > LOST_SECONDS;
      this.lastSeen[i] = now;
      if (!fresh) continue;
      let watched = false;
      for (let k = 0; k < eyes.length && !watched; k += 3) {
        watched = (eyes[k] - x) ** 2 + (eyes[k + 1] - z) ** 2 < eyes[k + 2] * eyes[k + 2];
      }
      if (!watched) continue;
      const key = Math.floor(x / ALERT_AREA) + 64 * Math.floor(z / ALERT_AREA);
      let g = groups.get(key);
      if (!g) {
        g = { x: 0, z: 0, n: 0, counts: new Array<number>(KINDS.length).fill(0) };
        groups.set(key, g);
      }
      g.x += x;
      g.z += z;
      g.n++;
      g.counts[u.kindOf(i)]++;
    }
    for (const g of groups.values()) {
      this.show(this.book.raise(ALERT_CONTACT, g.x / g.n, g.z / g.n, contactText(g.counts), now));
    }
  }

  private show(alert: Alert | null): void {
    if (alert === null) return;
    this.cursor = 0;
    this.minimap.ping(alert.x, alert.z, RGB[alert.kind]);
    this.sound.alert(alert.kind === ALERT_CONTACT || alert.kind === ALERT_NOTE ? 1 : 0);
    this.speak(alert);
    const row = document.createElement('div');
    row.className = 'alert';
    row.style.borderLeftColor = CSS[alert.kind];
    row.textContent = alert.text;
    const hint = document.createElement('span');
    hint.textContent = 'Backspace';
    row.append(hint);
    row.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.lookAt(alert.x, alert.z);
    });
    this.list.append(row);
    this.rows.push({ alert, el: row });
    while (this.rows.length > 4) this.rows.shift()!.el.remove();
    const el = document.createElement('div');
    el.className = 'alert-arrow';
    el.style.color = CSS[alert.kind];
    el.textContent = '➤';
    el.title = alert.text;
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.lookAt(alert.x, alert.z);
    });
    this.arrows.append(el);
    this.pointers.push({ alert, el });
  }

  /** The spoken line, in whatever voice the browser has. Quiet when the sound is off. */
  private speak(alert: Alert): void {
    const synth = window.speechSynthesis as SpeechSynthesis | undefined;
    if (!synth || this.sound.volume === 0 || alert.at - this.spokeAt < 3) return;
    this.spokeAt = alert.at;
    try {
      const line = new SpeechSynthesisUtterance(
        alert.kind === ALERT_TOWN || alert.kind === ALERT_NOTE ? alert.text : SPOKEN[alert.kind],
      );
      line.rate = 1.1;
      line.pitch = 0.85;
      line.volume = Math.min(1, this.sound.volume * 0.9);
      synth.speak(line);
    } catch {
      // no voice on this machine: the tone and the banner still say it
    }
  }

  /** Every frame: fade the banners out and keep the arrows on the edge of the screen. */
  update(now: number): void {
    for (let k = this.rows.length - 1; k >= 0; k--) {
      const age = now - this.rows[k].alert.at;
      if (age > BANNER_SECONDS) {
        this.rows[k].el.remove();
        this.rows.splice(k, 1);
      } else this.rows[k].el.style.opacity = String(Math.min(1, (BANNER_SECONDS - age) / 1.5));
    }
    const w = window.innerWidth;
    const h = window.innerHeight;
    const cx = w / 2;
    const cy = h / 2;
    const inset = 46;
    for (let k = this.pointers.length - 1; k >= 0; k--) {
      const { alert, el } = this.pointers[k];
      const age = now - alert.at;
      const p = this.project(alert.x, alert.z);
      if (age > ARROW_SECONDS) {
        el.remove();
        this.pointers.splice(k, 1);
        continue;
      }
      if (p.on) {
        el.style.display = 'none';
        continue;
      }
      // From the middle of the screen toward the place, stopped at the edge.
      const dx = p.sx - cx;
      const dy = p.sy - cy;
      const scale = Math.min(
        (cx - inset) / Math.max(1, Math.abs(dx)),
        (cy - inset) / Math.max(1, Math.abs(dy)),
      );
      el.style.display = 'block';
      el.style.left = `${cx + dx * scale}px`;
      el.style.top = `${cy + dy * scale}px`;
      const pulse = 1 + 0.18 * Math.sin(now * 7);
      el.style.transform = `translate(-50%, -50%) rotate(${Math.atan2(dy, dx)}rad) scale(${pulse})`;
      el.style.opacity = String(Math.min(1, (ARROW_SECONDS - age) / 3));
    }
  }
}
