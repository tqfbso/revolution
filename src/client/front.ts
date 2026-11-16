// The front line: where your ground ends and the enemy's begins, drawn the way a staff map
// draws it, a line in your colour with teeth on the enemy's side. It is traced from what
// your army knows and nothing more: your own units and buildings, the towns each army holds
// (shown to everyone already), enemy buildings you have found, and enemy troops you see or
// saw lately. An enemy you saw leave a place is remembered there for a while, then forgotten;
// a place you look at again and find empty is cleared at once. Presentation only: the
// simulation never reads it.
import { MAP_SIZE, MAX_TEAMS } from '../sim/map';

/** Squares of the influence grid across the map: 16 m each. */
export const FRONT_DIM = 64;
const CELL = MAP_SIZE / FRONT_DIM;
const CELLS = FRONT_DIM * FRONT_DIM;
/** How far influence spreads, in squares, per pass of the box blur (three passes). */
const SPREAD = 3;
/** Influence at which a side counts as half present. Saturates big armies: the line sits
 * where the two sides meet, not pushed back to the weaker one's gate. */
const HALF = 1.6;
/** Below this presence on both sides there is nobody there, so no line. */
const PRESENT = 0.18;
/** Seconds for a remembered enemy sighting to fade to half. */
const MEMORY_HALF_LIFE = 40;
/** How quickly the drawn field follows the true one, per second (so the line glides). */
const EASE = 2.2;
/** Scale of the blurred influence: about what makes one squad alone just count. */
const MASS = 30;

export const W_INFANTRY = 1;
export const W_VEHICLE = 2;
/** Per 16 m square of a base building's or a held town's ground. */
export const W_BASE = 0.3;
export const W_TOWN = 0.25;

/** One traced line: world x, z pairs, and per point which enemy army it faces. */
export interface FrontPath {
  pts: number[];
  foe: number[];
  closed: boolean;
}

/** What the front line is traced from, gathered fresh each time. */
export interface FrontSources {
  /** The player's army. */
  me: number;
  /** Units: call back (x, z, team, weight) for each living ground unit the player knows. */
  units(add: (x: number, z: number, team: number, weight: number) => void): void;
  /** Buildings and towns: `weight` on every square within `radius` metres. */
  places(add: (x: number, z: number, team: number, weight: number, radius: number) => void): void;
  /** Is world point (x, z) in the player's sight now? */
  sees(x: number, z: number): boolean;
}

/**
 * Box blur in place, `r` squares each way, rows then columns. Three passes are close to a
 * Gaussian and cost nothing at this size.
 */
function blur(a: Float32Array, tmp: Float32Array, r: number): void {
  const N = FRONT_DIM;
  const norm = 1 / (2 * r + 1);
  for (let y = 0; y < N; y++) {
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += a[y * N + Math.min(N - 1, Math.max(0, x))];
    for (let x = 0; x < N; x++) {
      tmp[y * N + x] = sum * norm;
      sum += a[y * N + Math.min(N - 1, x + r + 1)] - a[y * N + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < N; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[Math.min(N - 1, Math.max(0, y)) * N + x];
    for (let y = 0; y < N; y++) {
      a[y * N + x] = sum * norm;
      sum += tmp[Math.min(N - 1, y + r + 1) * N + x] - tmp[Math.max(0, y - r) * N + x];
    }
  }
}

/**
 * Trace the line where `mine` equals `theirs` (marching squares on the square corners),
 * only where someone is present, and join the pieces into paths. `foeAt` names the enemy
 * army met at a square. Points are in world metres; the field lives on square centres.
 */
export function traceFront(
  mine: Float32Array,
  theirs: Float32Array,
  foeAt: Int8Array,
): FrontPath[] {
  const N = FRONT_DIM;
  const f = (c: number) => mine[c] - theirs[c];
  const on = (c: number) => mine[c] > PRESENT && theirs[c] > PRESENT;
  // An edge of the corner lattice by id: horizontal edges first, then vertical ones.
  const H = N * N;
  const point = new Map<number, [number, number]>();
  const where = (id: number): [number, number] => {
    let p = point.get(id);
    if (p) return p;
    let a: number;
    let b: number;
    if (id < H) {
      a = id;
      b = id + 1;
    } else {
      a = id - H;
      b = a + N;
    }
    const fa = f(a);
    const fb = f(b);
    const t = fa === fb ? 0.5 : Math.min(1, Math.max(0, fa / (fa - fb)));
    const ax = (a % N) + 0.5;
    const ay = ((a / N) | 0) + 0.5;
    const bx = (b % N) + 0.5;
    const by = ((b / N) | 0) + 0.5;
    p = [(ax + (bx - ax) * t) * CELL, (ay + (by - ay) * t) * CELL];
    point.set(id, p);
    return p;
  };
  // Each edge touches at most two segments: link them both ways.
  const links = new Map<number, number[]>();
  const link = (e1: number, e2: number) => {
    let l = links.get(e1);
    if (!l) links.set(e1, (l = []));
    l.push(e2);
    let m = links.get(e2);
    if (!m) links.set(e2, (m = []));
    m.push(e1);
  };
  for (let y = 0; y < N - 1; y++) {
    for (let x = 0; x < N - 1; x++) {
      const a = y * N + x;
      const b = a + 1;
      const c = a + N + 1;
      const d = a + N;
      if (!on(a) || !on(b) || !on(c) || !on(d)) continue;
      const k = (f(a) > 0 ? 1 : 0) | (f(b) > 0 ? 2 : 0) | (f(c) > 0 ? 4 : 0) | (f(d) > 0 ? 8 : 0);
      if (k === 0 || k === 15) continue;
      const top = a;
      const bottom = d;
      const left = H + a;
      const right = H + b;
      switch (k) {
        case 1:
        case 14:
          link(top, left);
          break;
        case 2:
        case 13:
          link(top, right);
          break;
        case 3:
        case 12:
          link(left, right);
          break;
        case 4:
        case 11:
          link(right, bottom);
          break;
        case 6:
        case 9:
          link(top, bottom);
          break;
        case 7:
        case 8:
          link(left, bottom);
          break;
        case 5:
        case 10: {
          // A saddle: the middle decides which corners join.
          const middle = (f(a) + f(b) + f(c) + f(d)) / 4 > 0;
          if ((k === 5) === middle) {
            link(top, right);
            link(left, bottom);
          } else {
            link(top, left);
            link(right, bottom);
          }
          break;
        }
      }
    }
  }
  // Walk the links into paths: open ones from their loose ends first, then the loops.
  const used = new Set<string>();
  const key = (p: number, q: number) => (p < q ? `${p}:${q}` : `${q}:${p}`);
  const paths: FrontPath[] = [];
  const walk = (start: number) => {
    const ids = [start];
    let prev = -1;
    let at = start;
    for (;;) {
      const next = (links.get(at) ?? []).find((n) => n !== prev && !used.has(key(at, n)));
      if (next === undefined) break;
      used.add(key(at, next));
      ids.push(next);
      prev = at;
      at = next;
      if (at === start) break;
    }
    if (ids.length < 2) return;
    const closed = ids.length > 2 && ids[ids.length - 1] === start;
    if (closed) ids.pop();
    const pts: number[] = [];
    const foe: number[] = [];
    for (const id of ids) {
      const [px, pz] = where(id);
      pts.push(px, pz);
      const sx = Math.min(N - 1, Math.max(0, Math.floor(px / CELL)));
      const sy = Math.min(N - 1, Math.max(0, Math.floor(pz / CELL)));
      foe.push(foeAt[sy * N + sx]);
    }
    paths.push({ pts, foe, closed });
  };
  for (const [id, l] of links) if (l.length === 1 && !used.has(key(id, l[0]))) walk(id);
  for (const [id, l] of links) for (const n of l) if (!used.has(key(id, n))) walk(id);
  return paths;
}

/** Cut corners (Chaikin), twice: the square lattice becomes a hand-drawn curve. */
export function smoothPath(p: FrontPath, rounds = 2): FrontPath {
  let { pts, foe } = p;
  for (let r = 0; r < rounds; r++) {
    const n = pts.length >> 1;
    if (n < 3) break;
    const out: number[] = [];
    const of: number[] = [];
    const segs = p.closed ? n : n - 1;
    if (!p.closed) {
      out.push(pts[0], pts[1]);
      of.push(foe[0]);
    }
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n;
      const ax = pts[2 * i];
      const az = pts[2 * i + 1];
      const bx = pts[2 * j];
      const bz = pts[2 * j + 1];
      out.push(
        ax * 0.75 + bx * 0.25,
        az * 0.75 + bz * 0.25,
        ax * 0.25 + bx * 0.75,
        az * 0.25 + bz * 0.75,
      );
      of.push(foe[i], foe[j]);
    }
    if (!p.closed) {
      out.push(pts[2 * n - 2], pts[2 * n - 1]);
      of.push(foe[n - 1]);
    }
    pts = out;
    foe = of;
  }
  return { pts, foe, closed: p.closed };
}

/** A tooth: where it stands on the line, which way the enemy is (unit vector), whose. */
export interface Tooth {
  x: number;
  z: number;
  nx: number;
  nz: number;
  foe: number;
}

/**
 * The player's front line against every enemy army at once. Call `update` a few times a
 * second; read `paths` and `teeth`, and `version`, which changes whenever they do.
 */
export class FrontLine {
  paths: FrontPath[] = [];
  teeth: Tooth[] = [];
  version = 0;
  /** Teeth every this many metres along the line. */
  toothGap = 28;
  private readonly raw = new Float32Array(CELLS * MAX_TEAMS);
  /** Enemy troops remembered per army and square (the last count seen there, fading). */
  private readonly memory = new Float32Array(CELLS * MAX_TEAMS);
  /** The eased field per army, as drawn. */
  private readonly field = new Float32Array(CELLS * MAX_TEAMS);
  private readonly mine = new Float32Array(CELLS);
  private readonly theirs = new Float32Array(CELLS);
  private readonly foeAt = new Int8Array(CELLS);
  private readonly tmp = new Float32Array(CELLS);
  private readonly work = new Float32Array(CELLS);
  private readonly seen = new Float32Array(CELLS * MAX_TEAMS);
  private last = -1;
  private readonly present = new Uint8Array(MAX_TEAMS);

  /** Recompute from what the player knows; `now` in seconds. */
  update(src: FrontSources, now: number): void {
    const dt = this.last < 0 ? 0 : Math.min(2, now - this.last);
    this.last = now;
    const N = FRONT_DIM;
    const raw = this.raw;
    const seen = this.seen;
    raw.fill(0);
    seen.fill(0);
    const sq = (x: number, z: number) =>
      Math.min(N - 1, Math.max(0, Math.floor(z / CELL))) * N +
      Math.min(N - 1, Math.max(0, Math.floor(x / CELL)));
    src.units((x, z, team, weight) => {
      if (team < 0 || team >= MAX_TEAMS) return;
      if (team === src.me) raw[team * CELLS + sq(x, z)] += weight;
      else seen[team * CELLS + sq(x, z)] += weight;
    });
    src.places((x, z, team, weight, radius) => {
      if (team < 0 || team >= MAX_TEAMS) return;
      const r = Math.max(0, Math.round(radius / CELL));
      const cx = Math.min(N - 1, Math.max(0, Math.floor(x / CELL)));
      const cy = Math.min(N - 1, Math.max(0, Math.floor(z / CELL)));
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > r * r) continue;
          const gx = cx + dx;
          const gy = cy + dy;
          if (gx < 0 || gy < 0 || gx >= N || gy >= N) continue;
          raw[team * CELLS + gy * N + gx] += weight;
        }
      }
    });
    // Enemy troops: what is seen now replaces the memory of that square; a square in sight
    // with nobody in it is cleared; the rest fades.
    const fade = Math.pow(0.5, dt / MEMORY_HALF_LIFE);
    const inSight = this.tmp;
    for (let c = 0; c < CELLS; c++) {
      inSight[c] = src.sees(((c % N) + 0.5) * CELL, (((c / N) | 0) + 0.5) * CELL) ? 1 : 0;
    }
    for (let t = 0; t < MAX_TEAMS; t++) {
      if (t === src.me) continue;
      const o = t * CELLS;
      for (let c = 0; c < CELLS; c++) {
        const now = seen[o + c];
        const m = this.memory[o + c] * fade;
        this.memory[o + c] = inSight[c] ? now : Math.max(now, m);
        raw[o + c] += this.memory[o + c];
      }
    }
    // Spread, saturate, and ease the drawn field toward it.
    const ease = dt === 0 ? 1 : 1 - Math.exp(-EASE * dt);
    const work = this.work;
    for (let t = 0; t < MAX_TEAMS; t++) {
      const o = t * CELLS;
      // An army nobody knows of (or not in this battle) costs nothing.
      if (!hasAny(raw, o)) {
        if (!this.present[t]) continue;
        if (!hasAny(this.field, o, 1e-3)) {
          // Faded out completely: rest.
          this.present[t] = 0;
          this.field.fill(0, o, o + CELLS);
          continue;
        }
      } else this.present[t] = 1;
      work.set(raw.subarray(o, o + CELLS));
      for (let pass = 0; pass < 3; pass++) blur(work, this.tmp, SPREAD);
      for (let c = 0; c < CELLS; c++) {
        // Blurring spreads a squad over the area around it: scale back so it is felt.
        const v = work[c] * MASS;
        const goal = v / (v + HALF);
        this.field[o + c] += (goal - this.field[o + c]) * ease;
      }
    }
    // Mine against the strongest enemy at each square.
    this.mine.set(this.field.subarray(src.me * CELLS, src.me * CELLS + CELLS));
    this.theirs.fill(0);
    this.foeAt.fill(-1);
    for (let t = 0; t < MAX_TEAMS; t++) {
      if (t === src.me) continue;
      const o = t * CELLS;
      for (let c = 0; c < CELLS; c++) {
        if (this.field[o + c] > this.theirs[c]) {
          this.theirs[c] = this.field[o + c];
          this.foeAt[c] = t;
        }
      }
    }
    this.paths = traceFront(this.mine, this.theirs, this.foeAt)
      .map((p) => smoothPath(p))
      .filter((p) => length(p) > 40);
    this.teeth = this.paths.flatMap((p) => this.teethOf(p));
    this.version++;
  }

  /** The enemy-side normal along a path, a tooth every `toothGap` metres. */
  private teethOf(p: FrontPath): Tooth[] {
    const out: Tooth[] = [];
    const n = p.pts.length >> 1;
    const segs = p.closed ? n : n - 1;
    let carry = this.toothGap * 0.5;
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n;
      const ax = p.pts[2 * i];
      const az = p.pts[2 * i + 1];
      const dx = p.pts[2 * j] - ax;
      const dz = p.pts[2 * j + 1] - az;
      const len = Math.hypot(dx, dz);
      if (len === 0) continue;
      let at = carry;
      while (at < len) {
        const x = ax + (dx * at) / len;
        const z = az + (dz * at) / len;
        let nx = -dz / len;
        let nz = dx / len;
        // The enemy is on the side where their presence outweighs ours.
        if (this.balance(x + nx * 8, z + nz * 8) > this.balance(x - nx * 8, z - nz * 8)) {
          nx = -nx;
          nz = -nz;
        }
        out.push({ x, z, nx, nz, foe: at < len / 2 ? p.foe[i] : p.foe[j] });
        at += this.toothGap;
      }
      carry = at - len;
    }
    return out;
  }

  /** Our presence minus the enemy's at a world point (bilinear on square centres). */
  balance(x: number, z: number): number {
    const N = FRONT_DIM;
    const gx = Math.min(N - 1.001, Math.max(0, x / CELL - 0.5));
    const gy = Math.min(N - 1.001, Math.max(0, z / CELL - 0.5));
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = gx - x0;
    const fy = gy - y0;
    const v = (c: number) => this.mine[c] - this.theirs[c];
    const c = y0 * N + x0;
    return (
      (v(c) * (1 - fx) + v(c + 1) * fx) * (1 - fy) + (v(c + N) * (1 - fx) + v(c + N + 1) * fx) * fy
    );
  }
}

function hasAny(a: Float32Array, from: number, above = 0): boolean {
  for (let c = from; c < from + CELLS; c++) if (a[c] > above) return true;
  return false;
}

function length(p: FrontPath): number {
  let sum = 0;
  const n = p.pts.length >> 1;
  for (let i = 1; i < n; i++) {
    sum += Math.hypot(p.pts[2 * i] - p.pts[2 * i - 2], p.pts[2 * i + 1] - p.pts[2 * i - 1]);
  }
  return sum;
}
