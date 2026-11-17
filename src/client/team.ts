// A shared army, on screen (decision 146): who is in it and what each looks after, whose
// units are whose, handing units over, and the marks players put on the map for each other.
//
// The rules of it live in the sim (World.owner, CMD_GIVE, CMD_DUTY): every machine agrees
// whose a unit is. Nothing here locks anything; it only keeps four people out of each
// other's way and lets them talk without a headset.
import * as THREE from 'three/webgpu';
import { CMD_DUTY, CMD_GIVE, type Command } from '../sim/commands';
import { POINTS } from '../sim/units';
import { NO_SEAT, STATE_ALIVE } from '../sim/world';
import { INFO_STATE_MASK, type Snapshot } from '../worker/protocol';
import { DUTIES, SEAT_COLOURS, SEAT_RGB, type Coop } from './net';
import type { UnitView } from './units';
import { MARK_KINDS, esc } from './wire';

/** The marks a player can put on the map for his team: what it says, and its colour. */
export const MARKS: readonly { name: string; say: string; rgb: readonly number[] }[] = [
  { name: 'Look here', say: 'look here', rgb: [120, 225, 255] },
  { name: 'Attack here', say: 'attack here', rgb: [255, 122, 100] },
  { name: 'Defend here', say: 'defend here', rgb: [140, 230, 140] },
  { name: 'Help me here', say: 'needs help here', rgb: [255, 207, 90] },
];
if (MARKS.length !== MARK_KINDS) throw new Error('mark kinds');

/** How long a mark stands on the battlefield, and how long the choice of kind stays open. */
const MARK_SECONDS = 12;
const CHOICE_MS = 3500;

export interface TeamDeps {
  coop: Coop;
  units: UnitView;
  send: (c: Command) => void;
  lookAt: (x: number, z: number) => void;
  scene: THREE.Scene;
  camera: THREE.Camera;
  heightAt: (x: number, z: number) => number;
  /** The ground under the pointer, and where the pointer is on the screen. */
  pointerGround: () => { x: number; z: number } | null;
  /** Ring a place on the minimap. */
  ring: (x: number, z: number, rgb: readonly number[]) => void;
  /** Put a line on the alert list (and say it, if `voiced`). */
  say: (text: string, x: number, z: number, voiced: boolean) => void;
  /** "C4, Northgate": the place as it is said out loud. */
  place: (x: number, z: number) => string;
  beep: () => void;
}

interface Mark {
  x: number;
  z: number;
  born: number;
  group: THREE.Group;
  ring: THREE.Mesh;
  tag: HTMLElement;
}

export class Team {
  private readonly el: HTMLElement;
  private readonly tags: HTMLElement;
  private readonly choice: HTMLElement;
  private readonly marks: Mark[] = [];
  private built = '';
  /** Whose each unit was at the last picture, and which life of that number it was. */
  private readonly was = new Uint8Array(0x10000).fill(NO_SEAT);
  private readonly wasGen = new Uint16Array(0x10000);
  private first = true;
  /** When we last handed units over or took them ourselves: such changes are no news. */
  private acted = 0;
  /** The place of the mark just made, while its kind can still be changed. */
  private pending: { x: number; z: number; until: number } | null = null;
  private readonly probe = new THREE.Vector3();

  constructor(private readonly d: TeamDeps) {
    this.el = document.createElement('div');
    this.el.id = 'team';
    this.el.className = 'pill';
    (document.getElementById('left') ?? document.body).appendChild(this.el);
    this.tags = document.createElement('div');
    this.tags.id = 'mark-tags';
    document.body.appendChild(this.tags);
    this.choice = document.createElement('div');
    this.choice.id = 'mark-choice';
    this.choice.className = 'panel';
    this.choice.innerHTML =
      `<span>Marked for your team. Make it:</span>` +
      MARKS.slice(1)
        .map((m, k) => `<button data-k="${k + 1}"><kbd>${k + 1}</kbd> ${m.name}</button>`)
        .join('');
    document.body.appendChild(this.choice);
    this.choice.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (b) this.choose(Number(b.dataset.k));
    });
    d.units.mySeat = d.coop.seat;
    d.units.seatRgb = SEAT_RGB;
    try {
      d.units.ownerMarks = localStorage.getItem('revolution.ownerMarks') !== '0';
    } catch {
      // shown, then
    }
    d.coop.onRoster = () => this.render();
    d.coop.onMark = (x, z, from, kind) => this.show(x, z, from, kind);
    this.el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      const seat = Number(b.dataset.seat);
      if (b.dataset.act === 'give') this.give(seat);
      else if (b.dataset.act === 'take') this.give(d.coop.seat);
      else if (b.dataset.act === 'look') {
        const p = d.coop.partners[seat];
        if (p && p.x >= 0) d.lookAt(p.x, p.z);
      }
      b.blur();
    });
    this.el.addEventListener('change', (e) => {
      const t = e.target as HTMLElement;
      if (t instanceof HTMLSelectElement && t.dataset.act === 'duty') {
        d.send({ type: CMD_DUTY, duty: Number(t.value) | 0 });
        try {
          localStorage.setItem('revolution.duty', t.value);
        } catch {
          // not remembered
        }
        t.blur();
      } else if (t instanceof HTMLInputElement && t.dataset.act === 'marks') {
        d.units.ownerMarks = t.checked;
        try {
          localStorage.setItem('revolution.ownerMarks', t.checked ? '1' : '0');
        } catch {
          // not remembered
        }
        t.blur();
      }
    });
    // Z marks the ground under the pointer for the team; 1 to 3 just after says what for.
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const typing = (e.target as HTMLElement | null)?.closest?.('input, select, textarea');
        if (typing) return;
        if (e.code === 'KeyZ' && !e.repeat) {
          const g = d.pointerGround();
          if (!g) return;
          this.pending = { x: g.x, z: g.z, until: performance.now() + CHOICE_MS };
          this.fire(g.x, g.z, 0);
          this.choice.classList.add('open');
        } else if (this.pending && /^Digit[1-3]$/.test(e.code)) {
          // The number is ours for these few seconds, not a control group's.
          e.stopImmediatePropagation();
          e.preventDefault();
          this.choose(Number(e.code.slice(5)));
        }
      },
      true,
    );
    this.render();
    setInterval(() => this.render(), 500);
  }

  private choose(kind: number): void {
    const p = this.pending;
    if (!p || !(kind >= 1 && kind < MARKS.length)) return;
    this.pending = null;
    this.choice.classList.remove('open');
    this.fire(p.x, p.z, kind);
  }

  /** Our own mark: shown here, and sent to the others. */
  private fire(x: number, z: number, kind: number): void {
    this.show(x, z, this.d.coop.seat, kind);
    this.d.coop.mark(x, z, kind);
  }

  /** A mark from the player in `from`: on the minimap, on the ground, and said. */
  private show(x: number, z: number, from: number, kind: number): void {
    const d = this.d;
    const m = MARKS[kind] ?? MARKS[0];
    const mine = from === d.coop.seat;
    const who = mine ? 'You' : (d.coop.names[from] ?? `Player ${from + 1}`);
    // The same player marking the same spot again (to say what for) replaces his mark.
    for (let k = this.marks.length - 1; k >= 0; k--) {
      const o = this.marks[k];
      if (o.tag.dataset.from === String(from) && Math.hypot(o.x - x, o.z - z) < 12) this.drop(k);
    }
    d.ring(x, z, m.rgb);
    d.say(`${who}: ${m.say}, ${d.place(x, z)}`, x, z, !mine);
    if (!mine) d.beep();
    const colour = new THREE.Color(m.rgb[0] / 255, m.rgb[1] / 255, m.rgb[2] / 255);
    const material = new THREE.MeshBasicNodeMaterial({ color: colour, transparent: true });
    material.opacity = 0.85;
    material.depthWrite = false;
    material.fog = false;
    const y = d.heightAt(x, z);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 22, 6), material);
    pole.position.y = 11;
    const ring = new THREE.Mesh(new THREE.RingGeometry(5.2, 6, 40).rotateX(-Math.PI / 2), material);
    ring.position.y = 0.25;
    const group = new THREE.Group();
    group.position.set(x, y, z);
    group.add(pole, ring);
    d.scene.add(group);
    const tag = document.createElement('div');
    tag.className = 'mark-tag';
    tag.dataset.from = String(from);
    tag.style.borderColor = `rgb(${m.rgb.join(',')})`;
    tag.innerHTML = `<i style="background:${SEAT_COLOURS[from] ?? '#fff'}"></i>${esc(who)}: ${esc(m.name)}`;
    this.tags.appendChild(tag);
    this.marks.push({ x, z, born: performance.now(), group, ring, tag });
    if (this.marks.length > 8) this.drop(0);
  }

  private drop(k: number): void {
    const m = this.marks[k];
    this.d.scene.remove(m.group);
    m.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    (m.ring.material as THREE.Material).dispose();
    m.tag.remove();
    this.marks.splice(k, 1);
  }

  /** Every frame: the marks pulse, their labels follow them, and they fade out. */
  update(now: number): void {
    if (this.pending && now > this.pending.until) {
      this.pending = null;
      this.choice.classList.remove('open');
    }
    for (let k = this.marks.length - 1; k >= 0; k--) {
      const m = this.marks[k];
      const age = (now - m.born) / 1000;
      if (age > MARK_SECONDS) {
        this.drop(k);
        continue;
      }
      const pulse = 0.75 + 0.25 * Math.sin(age * 5);
      m.ring.scale.setScalar(pulse);
      (m.ring.material as THREE.MeshBasicNodeMaterial).opacity =
        0.85 * Math.min(1, (MARK_SECONDS - age) / 2);
      this.probe.set(m.x, m.group.position.y + 23, m.z).project(this.d.camera);
      const on = this.probe.z < 1 && Math.abs(this.probe.x) < 1.05 && Math.abs(this.probe.y) < 1.05;
      m.tag.style.display = on ? '' : 'none';
      if (on) {
        m.tag.style.left = `${(this.probe.x * 0.5 + 0.5) * window.innerWidth}px`;
        m.tag.style.top = `${(-this.probe.y * 0.5 + 0.5) * window.innerHeight}px`;
      }
    }
  }

  /** The selection goes to the player in `seat` (ourselves: we take it). */
  private give(seat: number): void {
    const { units, coop, send } = this.d;
    const ids = units.selectedIds().filter((id) => units.owner[id] !== seat);
    if (ids.length === 0) return;
    this.acted = performance.now();
    send({ type: CMD_GIVE, units: ids, to: seat });
    if (seat !== coop.seat) {
      const c = units.centreOf(ids);
      this.d.say(
        `You gave ${ids.length} unit${ids.length === 1 ? '' : 's'} to ${coop.names[seat]}`,
        c?.x ?? 0,
        c?.z ?? 0,
        false,
      );
      units.setSelected([], false);
    }
  }

  /** Units that changed hands without our doing: say so, once per picture. */
  applySnapshot(s: Snapshot): void {
    const { units, coop } = this.d;
    const me = coop.seat;
    const quiet = this.first || performance.now() - this.acted < 1500;
    const got = new Map<number, { n: number; x: number; z: number }>();
    const lost = new Map<number, { n: number; x: number; z: number }>();
    const pos = s.positions;
    for (let i = 0; i < s.count; i++) {
      const now = s.owner[i];
      const gen = units.gen[i];
      if (!quiet && gen === this.wasGen[i] && now !== this.was[i]) {
        const before = this.was[i];
        if (now === me && before !== NO_SEAT) {
          const g = got.get(before) ?? { n: 0, x: pos[2 * i], z: pos[2 * i + 1] };
          g.n++;
          got.set(before, g);
        } else if (before === me && now !== NO_SEAT) {
          const g = lost.get(now) ?? { n: 0, x: pos[2 * i], z: pos[2 * i + 1] };
          g.n++;
          lost.set(now, g);
        }
      }
      this.was[i] = now;
      this.wasGen[i] = gen;
    }
    this.first = false;
    for (const [seat, g] of got) {
      this.d.say(
        `${coop.names[seat] ?? 'A teammate'} gave you ${g.n} unit${g.n === 1 ? '' : 's'}`,
        g.x,
        g.z,
        true,
      );
    }
    for (const [seat, g] of lost) {
      this.d.say(
        `${coop.names[seat] ?? 'A teammate'} took ${g.n} of your unit${g.n === 1 ? '' : 's'}`,
        g.x,
        g.z,
        false,
      );
    }
  }

  /** The panel: one row a player, what he looks after and how much of the army is his. */
  private render(): void {
    const { coop, units } = this.d;
    const seats = coop.mates();
    const count = new Array<number>(coop.humans + 1).fill(0);
    const points = new Array<number>(coop.humans + 1).fill(0);
    let foreign = 0;
    let unowned = 0;
    for (let i = 0; i < units.count; i++) {
      if ((units.info[i] & INFO_STATE_MASK) !== STATE_ALIVE) continue;
      if (units.teamOf(i) !== units.playerTeam) continue;
      const o = units.owner[i];
      const slot = o < coop.humans ? o : coop.humans;
      count[slot]++;
      points[slot] += POINTS[units.kind[i]] ?? 0;
      if (units.selected[i]) {
        if (o !== coop.seat) foreign++;
        if (o === NO_SEAT) unowned++;
      }
    }
    const picked = units.selectedCount;
    const shape = seats
      .map((k) => `${k}${coop.isPresent(k) ? '+' : '-'}${coop.names[k]}`)
      .join('|');
    if (shape !== this.built) {
      this.built = shape;
      this.el.innerHTML =
        seats
          .map((k) => {
            const me = k === coop.seat;
            const gone = coop.isPresent(k) ? '' : ' gone';
            const role = me
              ? `<select data-act="duty" data-cell="duty${k}" title="What you look after: new units of these kinds are yours as they roll out. Nothing is locked.">${DUTIES.map((n, v) => `<option value="${v}">${n}</option>`).join('')}</select>`
              : `<span class="role" data-cell="duty${k}"></span>`;
            const acts = me
              ? `<button data-act="take" data-cell="take" title="The units you have selected become yours">Take</button>`
              : `<button data-act="look" data-seat="${k}" title="Go to where ${esc(coop.names[k])} is looking">Go to</button>` +
                `<button data-act="give" data-seat="${k}" data-cell="give${k}" title="The units you have selected become ${esc(coop.names[k])}'s">Give</button>`;
            return (
              `<div class="mate${gone}"><i style="background:${SEAT_COLOURS[k]}"></i>` +
              `<b>${esc(coop.names[k])}${me ? ' (you)' : ''}</b>${role}` +
              `<span class="have" data-cell="have${k}"></span>${acts}</div>`
            );
          })
          .join('') +
        `<div class="foot"><span data-cell="free"></span>` +
        `<label title="A ring in each teammate's colour under his units, and his colour on the minimap"><input type="checkbox" data-act="marks"${units.ownerMarks ? ' checked' : ''} /> Show whose units</label></div>`;
    }
    const cell = (name: string) => this.el.querySelector(`[data-cell="${name}"]`);
    for (const k of seats) {
      const have = cell(`have${k}`);
      const text = coop.isPresent(k)
        ? `${count[k]} unit${count[k] === 1 ? '' : 's'} · ${points[k]} pts`
        : `away · ${count[k]} unit${count[k] === 1 ? '' : 's'}`;
      if (have && have.textContent !== text) have.textContent = text;
      const duty = cell(`duty${k}`);
      if (duty instanceof HTMLSelectElement) {
        if (document.activeElement !== duty && duty.value !== String(coop.duties[k])) {
          duty.value = String(coop.duties[k]);
        }
      } else if (duty) {
        const name = DUTIES[coop.duties[k]] ?? DUTIES[0];
        if (duty.textContent !== name) duty.textContent = name;
      }
      const give = cell(`give${k}`) as HTMLButtonElement | null;
      if (give) give.disabled = picked === 0;
    }
    const take = cell('take') as HTMLButtonElement | null;
    if (take) {
      take.disabled = foreign === 0;
      const label = foreign > 0 && foreign > unowned ? `Take ${foreign}` : 'Take';
      if (take.textContent !== label) take.textContent = label;
    }
    const free = cell('free');
    const text =
      count[coop.humans] > 0
        ? `${count[coop.humans]} unit${count[coop.humans] === 1 ? ' is' : 's are'} nobody's yet: whoever orders them first has them`
        : '';
    if (free && free.textContent !== text) free.textContent = text;
  }
}
