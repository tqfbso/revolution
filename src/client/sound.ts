// Sound. Every sample is synthesised at start-up from noise and sine waves (no
// files, no licences). What makes it sound like a battlefield is what happens between the
// source and the ear: sound takes time to arrive, loses its top end with distance, and is
// quieter from the far side of the map, so a gun close by cracks and a barrage three
// kilometres off is a late, dull rumble.
//
// Second pass (decision 072): every shot is layers (crack, body, thump, tail) so that the
// distance filter has something to strip; an echo off the land that grows with distance; a
// bed of far-off firing that carries the shots there are no voices for; birds and wind
// that give way to it.

export const SND_RIFLE = 0;
export const SND_AUTOCANNON = 1;
export const SND_CANNON = 2;
export const SND_HOWITZER = 3;
export const SND_MISSILE = 4;
export const SND_EXPLOSION = 5;
export const SND_IMPACT = 6;
export const SND_COLLAPSE = 7;
const SOUNDS = 8;

/** World units a second. Slower than the real thing would be at this scale, but audibly late. */
const SPEED_OF_SOUND = 170;
/** Distance at which a sound is at half its level. */
const HALF_LEVEL = [26, 34, 55, 80, 30, 70, 60, 60];
/** How loud each is at the source, relative to the others. */
const LEVEL = [0.3, 0.42, 0.85, 1, 0.4, 1, 0.8, 0.9];
/** The most of each that may start in one tick: a hundred rifles are not a hundred voices. */
const PER_TICK = [3, 2, 2, 2, 1, 2, 2, 1];
const MAX_VOICES = 36;
/** Voices in use above which a kind no longer starts: small arms never crowd out a blast. */
const ROOM = [20, 24, 30, 36, 28, 36, 36, 36];
const VARIANTS = 3;
/** The level of the far-battle bed with the whole map firing. */
const BED = 0.3;

type Shape = (t: number, noise: () => number, state: number[]) => number;

/** Fill a buffer from a function of time. `state` is scratch space for filters. */
function render(
  ctx: AudioContext,
  seconds: number,
  seed: number,
  shape: Shape,
  drive = 1,
): AudioBuffer {
  const rate = ctx.sampleRate;
  const n = Math.ceil(seconds * rate);
  const buffer = ctx.createBuffer(1, n, rate);
  const out = buffer.getChannelData(0);
  let s = seed * 2654435761 + 1;
  const noise = () => {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    return s / 2147483648;
  };
  const state = [0, 0, 0, 0, 0, 0, 0, 0];
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const v = shape(i / rate, noise, state);
    out[i] = v;
    if (Math.abs(v) > peak) peak = Math.abs(v);
  }
  // Normalise, and fade the last few milliseconds so nothing ends on a click.
  const fade = Math.min(n, Math.floor(rate * 0.02));
  // `drive` above 1 presses the peaks down, which makes a blast with one sharp spike loud.
  const top = Math.tanh(drive);
  for (let i = 0; i < n; i++) {
    const v = Math.tanh((out[i] / (peak || 1)) * drive) / top;
    out[i] = v * 0.9 * (i > n - fade ? (n - i) / fade : 1);
  }
  return buffer;
}

/** One-pole low-pass: `k` near 0 is dark, 1 passes everything. Uses one slot of state. */
function low(state: number[], slot: number, x: number, k: number): number {
  return (state[slot] += (x - state[slot]) * k);
}

export function makeBuffers(ctx: AudioContext): AudioBuffer[][] {
  const out: AudioBuffer[][] = [];
  for (let k = 0; k < SOUNDS; k++) out.push([]);
  for (let v = 0; v < VARIANTS; v++) {
    const j = 1 + (v - 1) * 0.12; // each take a little different in pitch and timing
    // A rifle squad: a ragged burst of three or four rounds. Each round is a crack, the
    // body of the report, a thump you only get close by, and a short tail.
    out[SND_RIFLE].push(
      render(ctx, 0.75, 11 + v, (t, noise, st) =>
        rounds(t, noise, st, 3 + (v & 1), 0.085 * j, v === 1 ? 0.03 : 0.012),
      ),
    );
    // An autocannon: three heavy, evenly spaced thumps.
    out[SND_AUTOCANNON].push(
      render(ctx, 0.9, 23 + v, (t, noise, st) => {
        let e = 0;
        let tone = 0;
        for (let r = 0; r < 3; r++) {
          const u = t - r * 0.13 * j;
          if (u < 0) continue;
          e += Math.exp(-u / 0.03) + 0.3 * Math.exp(-u / 0.16);
          tone += Math.exp(-u / 0.06) * Math.sin(2 * Math.PI * 120 * j * u);
        }
        return low(st, 0, noise() * e, 0.25) + tone * 0.8;
      }),
    );
    // A tank gun: crack, a boom that drops, a long rolling tail.
    out[SND_CANNON].push(
      render(ctx, 1.6, 37 + v, (t, noise, st) => {
        const crack = noise() * Math.exp(-t / 0.012);
        const boom =
          Math.exp(-t / 0.18) * Math.sin(2 * Math.PI * 62 * j * t * (1 - Math.min(0.5, t * 1.5)));
        const tail = low(st, 0, noise(), 0.03) * 5 * Math.exp(-t / 0.42) * Math.min(1, t * 40);
        return crack * 0.9 + boom * 0.9 + tail;
      }),
    );
    // A howitzer: lower, longer, with the ground in it.
    out[SND_HOWITZER].push(
      render(ctx, 2.4, 41 + v, (t, noise, st) => {
        const crack = noise() * Math.exp(-t / 0.02);
        const boom =
          Math.exp(-t / 0.3) * Math.sin(2 * Math.PI * 44 * j * t * (1 - Math.min(0.4, t)));
        const tail = low(st, 0, noise(), 0.018) * 8 * Math.exp(-t / 0.7) * Math.min(1, t * 25);
        return crack * 0.7 + boom * 1.2 + tail;
      }),
    );
    // A missile leaving: a bang, then the motor tearing away.
    out[SND_MISSILE].push(
      render(ctx, 1.3, 53 + v, (t, noise, st) => {
        const bang = noise() * Math.exp(-t / 0.03);
        const k = 0.05 + 0.25 * Math.exp(-t * 2.2);
        const x = noise();
        const motor = (low(st, 0, x, k) - low(st, 1, x, k * 0.3)) * 4 * Math.exp(-t / 0.45);
        return bang * 0.8 + motor * Math.min(1, t * 30);
      }),
    );
    // A vehicle exploding: the blast, then a tail that closes down as it rolls away.
    out[SND_EXPLOSION].push(
      render(
        ctx,
        2.8,
        67 + v,
        (t, noise, st) => {
          const k = 0.012 + 0.5 * Math.exp(-t * 7);
          const body = low(st, 0, noise(), k) * (1 + 6 * Math.exp(-t / 0.5)) * Math.exp(-t / 0.9);
          const sub =
            Math.exp(-t / 0.45) *
            Math.sin(2 * Math.PI * 38 * j * t * (1 - Math.min(0.35, t * 0.5)));
          // Rounds cooking off inside it.
          const pop = noise() > 0.9993 && t > 0.3 && t < 1.8 ? 1 : 0;
          st[1] = Math.max(st[1] * 0.9992, pop);
          return body + sub * 1.4 + noise() * st[1] * 0.25;
        },
        2.6,
      ),
    );
    // A shell landing: shorter and sharper than a vehicle going up, with earth falling after.
    out[SND_IMPACT].push(
      render(
        ctx,
        2.0,
        79 + v,
        (t, noise, st) => {
          const crack = noise() * Math.exp(-t / 0.025);
          const k = 0.02 + 0.4 * Math.exp(-t * 9);
          const body = low(st, 0, noise(), k) * (1 + 5 * Math.exp(-t / 0.3)) * Math.exp(-t / 0.55);
          const sub = Math.exp(-t / 0.3) * Math.sin(2 * Math.PI * 50 * j * t);
          const patter = low(st, 1, noise(), 0.3) * 0.12 * Math.exp(-Math.abs(t - 0.9) / 0.35);
          return crack * 0.8 + body + sub + patter;
        },
        2.4,
      ),
    );
    // A building coming down: a long rumble with slabs landing in it.
    out[SND_COLLAPSE].push(
      render(ctx, 3.4, 83 + v, (t, noise, st) => {
        const swell = Math.min(1, t * 2.5) * Math.exp(-Math.max(0, t - 0.8) / 0.9);
        const rumble = low(st, 0, noise(), 0.012) * 9 * swell;
        const hit = noise() > 0.9996 ? 1 : 0;
        st[1] = Math.max(st[1] * 0.9994, hit * swell);
        return rumble + low(st, 2, noise(), 0.12) * st[1] * 1.6;
      }),
    );
  }
  // More takes of small arms than of anything else, since it is what is heard most: a
  // pair of aimed shots, one alone, and a machine gun's long burst.
  out[SND_RIFLE].push(
    render(ctx, 0.6, 131, (t, noise, st) => rounds(t, noise, st, 2, 0.21, 0)),
    render(ctx, 0.5, 137, (t, noise, st) => rounds(t, noise, st, 1, 0.1, 0)),
    render(ctx, 1.0, 139, (t, noise, st) => rounds(t, noise, st, 7, 0.072, 0.004)),
    render(ctx, 0.9, 149, (t, noise, st) => rounds(t, noise, st, 5, 0.1, 0.02)),
  );
  return out;
}

/** `count` small-arms rounds `gap` seconds apart, each a little off the beat by `ragged`. */
function rounds(
  t: number,
  noise: () => number,
  st: number[],
  count: number,
  gap: number,
  ragged: number,
): number {
  let crack = 0;
  let body = 0;
  let tail = 0;
  let thump = 0;
  for (let r = 0; r < count; r++) {
    const u = t - r * gap - ragged * ((r * 7) % 3);
    if (u < 0) continue;
    crack += Math.exp(-u / 0.004);
    body += Math.exp(-u / 0.022);
    tail += Math.exp(-u / 0.11);
    thump += Math.exp(-u / 0.028) * Math.sin(2 * Math.PI * 150 * u);
  }
  const x = noise();
  // Band-limited body: what is left between a bright and a dark low-pass.
  const mid = low(st, 0, x, 0.45) - low(st, 1, x, 0.06);
  return x * crack * 0.9 + mid * body * 1.3 + low(st, 2, x, 0.035) * tail * 1.1 + thump * 0.55;
}

/** What the land gives back: a few slaps off woods and slopes, then a dark, thinning wash. */
export function echo(ctx: AudioContext): AudioBuffer {
  const rate = ctx.sampleRate;
  const n = Math.floor(rate * 2.4);
  const buffer = ctx.createBuffer(2, n, rate);
  for (let ch = 0; ch < 2; ch++) {
    const out = buffer.getChannelData(ch);
    let s = 7919 + ch * 104729;
    const noise = () => {
      s = (Math.imul(s, 1664525) + 1013904223) | 0;
      return s / 2147483648;
    };
    const slaps = ch === 0 ? [0.11, 0.26, 0.43, 0.71] : [0.14, 0.23, 0.49, 0.64];
    let dark = 0;
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      // The wash loses its top end as it dies away.
      dark += (noise() - dark) * (0.02 + 0.3 * Math.exp(-t / 0.25));
      let v = dark * Math.exp(-t / 0.55) * Math.min(1, t * 30) * 0.5;
      for (let k = 0; k < slaps.length; k++) {
        const u = t - slaps[k];
        if (u >= 0) v += noise() * Math.exp(-u / 0.012) * (0.55 - k * 0.11);
      }
      out[i] = v * (i > n - 2000 ? (n - i) / 2000 : 1);
    }
  }
  return buffer;
}

/** A battle too far or too crowded to hear shot by shot: crackle over a low rolling thud. */
export function battle(ctx: AudioContext): AudioBuffer {
  const shots: number[] = [];
  const thuds: number[] = [];
  let s = 4241;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    return (s >>> 8) / 16777216;
  };
  // Firing comes in flurries, not evenly.
  for (let t = 0; t < 9;) {
    const flurry = 2 + Math.floor(rnd() * 7);
    for (let k = 0; k < flurry; k++) shots.push(t + k * (0.05 + rnd() * 0.07), 0.3 + rnd() * 0.7);
    t += 0.12 + rnd() * 0.5;
  }
  // Flurries overlap, and the loop below wants them in order.
  const order = shots.map((_, i) => i).filter((i) => i % 2 === 0);
  order.sort((a, b) => shots[a] - shots[b]);
  const sorted = order.flatMap((i) => [shots[i], shots[i + 1]]);
  shots.length = 0;
  shots.push(...sorted);
  for (let t = 0.4; t < 8.2; t += 0.7 + rnd() * 1.6) thuds.push(t, 0.5 + rnd() * 0.5);
  let first = 0;
  return render(ctx, 9, 151, (t, noise, st) => {
    while (first < shots.length && t - shots[first] > 0.25) first += 2;
    let e = 0;
    for (let k = first; k < shots.length && shots[k] <= t; k += 2) {
      e += shots[k + 1] * Math.exp(-(t - shots[k]) / 0.03);
    }
    let low2 = 0;
    for (let k = 0; k < thuds.length; k += 2) {
      const u = t - thuds[k];
      if (u >= 0 && u < 2)
        low2 += thuds[k + 1] * Math.exp(-u / 0.35) * Math.sin(2 * Math.PI * 48 * u);
    }
    const x = noise();
    // Heard through a kilometre of air: nothing above the middle of the band survives.
    const crackle = (low(st, 0, x, 0.12) - low(st, 1, x, 0.02)) * e;
    const roll = low(st, 2, x, 0.006) * 3 * (0.5 + low2 * low2);
    return crackle * 1.6 + low2 * 0.8 + roll;
  });
}

/** A few small birds, for when nobody is shooting. */
export function birds(ctx: AudioContext): AudioBuffer {
  const calls: number[] = [];
  let s = 977;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    return (s >>> 8) / 16777216;
  };
  for (let t = 0.6; t < 15; t += 1.4 + rnd() * 3.2) {
    const notes = 2 + Math.floor(rnd() * 5);
    const pitch = 2600 + rnd() * 2400;
    const step = 0.09 + rnd() * 0.08;
    const level = 0.3 + rnd() * 0.7;
    for (let k = 0; k < notes; k++) calls.push(t + k * step, pitch * (1 + (k % 2) * 0.12), level);
  }
  return render(ctx, 16, 157, (t) => {
    let v = 0;
    for (let k = 0; k < calls.length; k += 3) {
      const u = t - calls[k];
      if (u < 0 || u > 0.07) continue;
      // Each note slides up and is shaped like a small bell.
      const f = calls[k + 1] * (1 + u * 4);
      v += calls[k + 2] * Math.sin(Math.PI * (u / 0.07)) ** 2 * Math.sin(2 * Math.PI * f * u);
    }
    return v;
  });
}

interface Pending {
  kind: number;
  gain: number;
  delay: number;
  /** Share of the level sent to the echo as well. */
  echo: number;
  pan: number;
  cutoff: number;
}

export class Sound {
  /** 0 = off, 1 = full. Remembered between sessions. */
  volume = 0.7;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers: AudioBuffer[][] = [];
  private voices = 0;
  private pending: Pending[] = [];
  private seq = 0;
  private wet: GainNode | null = null;
  private bed: GainNode | null = null;
  private song: GainNode | null = null;
  private air: GainNode | null = null;
  /** How much firing went unvoiced lately: too far, or more than there are voices for. */
  private heat = 0;
  private unheard = 0;
  // Where the ear is: the point the camera looks at, raised with the zoom.
  private earX = 0;
  private earZ = 0;
  private earUp = 0;
  private rightX = 1;
  private rightZ = 0;

  constructor() {
    try {
      const saved = localStorage.getItem('revolution.volume');
      if (saved !== null) this.volume = Math.min(1, Math.max(0, Number(saved) || 0));
    } catch {
      // storage may be blocked; the default is fine
    }
    // Browsers only let sound start after the player has touched the page.
    const wake = () => this.start();
    window.addEventListener('pointerdown', wake, { once: true });
    window.addEventListener('keydown', wake, { once: true });
  }

  private start(): void {
    if (this.ctx) return;
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    try {
      this.ctx = new Ctx();
    } catch {
      return;
    }
    const ctx = this.ctx;
    // Everything goes through a compressor: a battle must get dense, not deafening.
    const squash = ctx.createDynamicsCompressor();
    squash.threshold.value = -16;
    squash.ratio.value = 5;
    squash.attack.value = 0.004;
    squash.release.value = 0.3;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(squash).connect(ctx.destination);
    this.buffers = makeBuffers(ctx);
    // One shared echo; each voice sends more of itself there the further off it is.
    const land = ctx.createConvolver();
    land.buffer = echo(ctx);
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.7;
    this.wet.connect(land).connect(this.master);
    this.wind(ctx);
    this.bed = this.loop(ctx, battle(ctx), 0);
    this.song = this.loop(ctx, birds(ctx), 0);
  }

  private loop(ctx: AudioContext, buffer: AudioBuffer, level: number): GainNode {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = level;
    source.connect(gain).connect(this.master!);
    source.start();
    return gain;
  }

  /**
   * A bed of wind, so that silence is not digital silence: two loops of different length,
   * a dull one and a hissing one, so the gusts never line up the same way twice.
   */
  private wind(ctx: AudioContext): void {
    const dull = render(ctx, 6, 97, (t, noise, st) => {
      const gust = 0.6 + 0.4 * Math.sin((2 * Math.PI * t) / 6) * Math.sin((2 * Math.PI * t) / 3);
      return low(st, 1, low(st, 0, noise(), 0.03), 0.03) * gust;
    });
    const hiss = render(ctx, 9.7, 101, (t, noise, st) => {
      const gust = 0.35 + 0.65 * Math.sin((Math.PI * t) / 9.7) ** 2;
      const x = noise();
      return (low(st, 0, x, 0.2) - low(st, 1, x, 0.05)) * gust;
    });
    this.air = ctx.createGain();
    this.air.gain.value = 1;
    this.air.connect(this.master!);
    for (const [buffer, level] of [
      [dull, 0.05],
      [hiss, 0.012],
    ] as const) {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const gain = ctx.createGain();
      gain.gain.value = level;
      source.connect(gain).connect(this.air);
      source.start();
    }
  }

  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.master && this.ctx)
      this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.05);
    try {
      localStorage.setItem('revolution.volume', String(this.volume));
    } catch {
      // not remembered; still applied
    }
  }

  /**
   * An alert tone, heard wherever the camera is: 0 = under attack (two urgent falling
   * notes), 1 = contact (a short rising radio blip).
   */
  alert(kind: number): void {
    const ctx = this.ctx;
    if (ctx === null || this.master === null || this.volume === 0) return;
    if (ctx.state === 'suspended') void ctx.resume();
    const t0 = ctx.currentTime + 0.02;
    const notes = kind === 0 ? [880, 660, 880, 660] : [520, 780];
    const step = kind === 0 ? 0.16 : 0.09;
    notes.forEach((hz, k) => {
      const osc = ctx.createOscillator();
      osc.type = kind === 0 ? 'square' : 'sine';
      osc.frequency.value = hz;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 2400;
      const gain = ctx.createGain();
      const at = t0 + k * step;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(kind === 0 ? 0.11 : 0.16, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.001, at + step * 0.95);
      osc.connect(filter).connect(gain).connect(this.master!);
      osc.start(at);
      osc.stop(at + step);
      osc.onended = () => gain.disconnect();
    });
  }

  /** Where the camera looks, how far out it is, and which way is right on screen. */
  listen(x: number, z: number, distance: number, rightX: number, rightZ: number): void {
    this.earX = x;
    this.earZ = z;
    this.earUp = distance * 0.55;
    this.rightX = rightX;
    this.rightZ = rightZ;
  }

  /**
   * Something made a noise at world (x, z). `seen` false = out of the player's sight:
   * still heard, but as from behind a hill.
   */
  at(kind: number, x: number, z: number, seen: boolean): void {
    if (this.ctx === null || this.volume === 0) return;
    const dx = x - this.earX;
    const dz = z - this.earZ;
    const flat = Math.hypot(dx, dz);
    const d = Math.hypot(flat, this.earUp);
    const gain = ((LEVEL[kind] * HALF_LEVEL[kind]) / (HALF_LEVEL[kind] + d)) * (seen ? 1 : 0.5);
    if (gain < 0.012) {
      this.unheard += 0.02 * LEVEL[kind];
      return;
    }
    this.pending.push({
      kind,
      gain,
      delay: d / SPEED_OF_SOUND,
      echo: Math.min(0.9, 0.12 + d / 180),
      pan: Math.max(-0.85, Math.min(0.85, (dx * this.rightX + dz * this.rightZ) / (60 + d * 0.6))),
      // Air eats the high frequencies first.
      cutoff: Math.max(180, (seen ? 16000 : 5000) / (1 + (d / 55) ** 1.5)),
    });
  }

  /** Start the loudest few of what was heard this tick. Call once per snapshot. */
  flush(): void {
    const ctx = this.ctx;
    const pending = this.pending;
    if (ctx === null || this.master === null) {
      pending.length = 0;
      return;
    }
    const now = ctx.currentTime;
    if (pending.length > 0) {
      if (ctx.state === 'suspended') void ctx.resume();
      pending.sort((a, b) => b.gain - a.gain);
      const started = new Array<number>(SOUNDS).fill(0);
      for (const p of pending) {
        if (
          this.voices >= MAX_VOICES ||
          this.voices >= ROOM[p.kind] ||
          started[p.kind] >= PER_TICK[p.kind]
        ) {
          this.unheard += p.gain * 0.35;
          continue;
        }
        started[p.kind]++;
        const takes = this.buffers[p.kind];
        const source = ctx.createBufferSource();
        source.buffer = takes[(this.seq++ * 7) % takes.length];
        source.playbackRate.value = 0.92 + Math.random() * 0.16;
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = p.cutoff;
        const gain = ctx.createGain();
        gain.gain.value = p.gain;
        const pan = ctx.createStereoPanner();
        pan.pan.value = p.pan;
        source.connect(filter).connect(gain).connect(pan).connect(this.master);
        const send = ctx.createGain();
        send.gain.value = p.echo;
        gain.connect(send).connect(this.wet!);
        this.voices++;
        source.onended = () => {
          this.voices--;
          pan.disconnect();
          send.disconnect();
        };
        source.start(now + p.delay);
      }
      pending.length = 0;
    }
    // The bed follows the firing that had no voice, rising fast and settling slowly; the
    // birds stop for it, and are only heard from near the ground in any case.
    this.heat = this.heat * 0.96 + this.unheard;
    this.unheard = 0;
    const battle = 1 - Math.exp(-this.heat / 3);
    this.bed?.gain.setTargetAtTime(BED * battle, now, 0.4);
    const near = 1 / (1 + this.earUp / 45);
    this.song?.gain.setTargetAtTime(0.035 * near * Math.max(0, 1 - battle * 4), now, 1.5);
    this.air?.gain.setTargetAtTime(0.7 + Math.min(1.3, this.earUp / 90), now, 0.5);
  }
}
