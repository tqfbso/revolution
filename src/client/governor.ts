// The frame-time governor (R3, decision 089). It watches how long frames take and where
// the time goes, and trades detail for frame rate one step at a time. It first finds out
// what the limit is, because the cure differs: fewer pixels help a graphics card that is
// out of fill rate and do nothing for a processor that is busy posing units.
//
// Pure logic, no DOM and no renderer: main.ts feeds it frame times and applies `levers`.
import type { Quality } from './look';

/** What limits the frame rate right now, as far as the governor can tell. */
export type Limit = 'none' | 'pixels' | 'scene' | 'cpu';

export interface Levers {
  /** Render resolution as a fraction of the level's full resolution, 0.6 to 1. */
  scale: number;
  /** Redraw the sun's shadow map every Nth frame. */
  shadowEvery: number;
  /** Ambient occlusion, grade and bloom. */
  post: boolean;
  /** Multiplier on the distances at which units drop a level of detail. */
  lod: number;
  /** Small street and field props. */
  props: boolean;
}

type Step = 'scale' | 'shadow' | 'post' | 'lod' | 'props';

/** Pixels drawn at most per graphics level: what the level may cost before any governing. */
export const PIXEL_BUDGET: Record<Quality, number> = {
  low: 2.1e6,
  normal: 5.2e6,
  high: 8.3e6,
};

const MIN_SCALE = 0.6;
const SCALE_STEP = 0.1;
/** Slower than this (ms a frame, about 51 fps) for two seconds running: give something up. */
const SLOW = 19.5;
/** Faster than this for long enough: take something back. */
const SMOOTH = 17.2;

export class Governor {
  readonly levers: Levers;
  limit: Limit = 'none';
  /** Steps taken so far, newest last, so they are given back in reverse order. */
  private readonly taken: Step[] = [];
  private sumMs = 0;
  private sumCpu = 0;
  private frames = 0;
  private slow = 0;
  private smooth = 0;
  /** Seconds of smooth running asked for before detail comes back; doubles when it backfires. */
  private patience = 10;
  private sinceUp = 99;
  /** A resolution step under trial: the frame time before it, and seconds since. */
  private trial: { before: number; from: number; age: number } | null = null;
  /** Seconds left in which resolution is known not to be the limit. */
  private notPixels = 0;
  private readonly base: Levers;

  constructor(
    quality: Quality,
    readonly enabled = true,
  ) {
    this.base = {
      scale: 1,
      // Below `high` the shadow map is redrawn every second frame from the start: at 60
      // frames a second a shadow that is one frame late cannot be seen, and it halves the
      // cost of the most expensive pass after the scene itself.
      shadowEvery: quality === 'high' ? 1 : 2,
      post: quality !== 'low',
      lod: 1,
      props: true,
    };
    this.levers = { ...this.base };
  }

  /** One frame: how long since the last one, and how much of that was this thread working. */
  frame(frameMs: number, cpuMs: number): boolean {
    // A hitch or a tab in the background says nothing about the machine.
    if (frameMs > 250) return false;
    this.sumMs += frameMs;
    this.sumCpu += cpuMs;
    this.frames++;
    if (this.sumMs < 1000) return false;
    const avg = this.sumMs / this.frames;
    const cpu = this.sumCpu / this.frames;
    this.sumMs = this.sumCpu = this.frames = 0;
    return this.second(avg, cpu);
  }

  /** Once a second. Returns true when a lever moved. */
  second(avg: number, cpu: number): boolean {
    if (!this.enabled) {
      this.limit = avg <= SLOW ? 'none' : cpu > avg * 0.7 ? 'cpu' : 'scene';
      return false;
    }
    this.sinceUp++;
    if (this.notPixels > 0) this.notPixels--;
    if (this.trial) {
      const t = this.trial;
      t.age++;
      if (t.age >= 2) {
        this.trial = null;
        // A card out of fill rate speeds up in step with the pixels taken away. If less
        // than a quarter of that showed up, the pixels were not the problem: put them back
        // and look elsewhere for a while.
        const pixels = (this.levers.scale * this.levers.scale) / (t.from * t.from);
        const hoped = t.before * (1 - pixels);
        if (t.before - avg < hoped * 0.25) {
          this.levers.scale = t.from;
          this.drop('scale');
          this.notPixels = 45;
          this.limit = 'scene';
          this.slow = 1;
          return true;
        }
        this.limit = 'pixels';
      }
    }
    this.slow = avg > SLOW ? this.slow + 1 : 0;
    this.smooth = avg < SMOOTH ? this.smooth + 1 : 0;
    if (this.slow >= 2) {
      this.slow = 0;
      // Detail that came back and broke the frame rate again stays away longer next time.
      if (this.sinceUp < 6) this.patience = Math.min(120, this.patience * 2);
      return this.down(avg, cpu);
    }
    if (this.smooth >= this.patience && this.taken.length > 0) {
      this.smooth = 0;
      this.sinceUp = 0;
      this.up();
      if (this.taken.length === 0) this.limit = 'none';
      return true;
    }
    if (avg <= SLOW && this.taken.length === 0) this.limit = 'none';
    return false;
  }

  private down(avg: number, cpu: number): boolean {
    const l = this.levers;
    const cpuBound = cpu > avg * 0.7;
    if (cpuBound) this.limit = 'cpu';
    else if (this.limit === 'none' || this.limit === 'cpu') this.limit = 'scene';
    // The order of what goes, by what the limit is. Resolution only when the thread has
    // time to spare, and not while a trial has just shown it does nothing.
    const order: Step[] = cpuBound
      ? ['lod', 'shadow', 'props', 'lod', 'lod']
      : this.notPixels > 0
        ? ['shadow', 'post', 'lod', 'props', 'lod']
        : ['scale', 'scale', 'shadow', 'post', 'scale', 'scale', 'lod', 'props'];
    for (const step of order) {
      if (!this.can(step)) continue;
      if (step === 'scale') {
        this.trial = { before: avg, from: l.scale, age: 0 };
        l.scale = Math.max(MIN_SCALE, Math.round((l.scale - SCALE_STEP) * 100) / 100);
      } else if (step === 'shadow') l.shadowEvery++;
      else if (step === 'post') l.post = false;
      else if (step === 'lod') l.lod = Math.round((l.lod - 0.15) * 100) / 100;
      else l.props = false;
      this.taken.push(step);
      return true;
    }
    return false;
  }

  private can(step: Step): boolean {
    const l = this.levers;
    if (step === 'scale') return l.scale > MIN_SCALE + 0.001;
    if (step === 'shadow') return l.shadowEvery < 3;
    if (step === 'post') return l.post;
    if (step === 'lod') return l.lod > 0.56;
    return l.props;
  }

  private up(): void {
    const step = this.taken.pop();
    const l = this.levers;
    if (step === 'scale') l.scale = Math.min(1, Math.round((l.scale + SCALE_STEP) * 100) / 100);
    else if (step === 'shadow') l.shadowEvery--;
    else if (step === 'post') l.post = this.base.post;
    else if (step === 'lod') l.lod = Math.round((l.lod + 0.15) * 100) / 100;
    else if (step === 'props') l.props = true;
  }

  /** Forget the newest step of a kind (its effect was undone by hand). */
  private drop(step: Step): void {
    const i = this.taken.lastIndexOf(step);
    if (i >= 0) this.taken.splice(i, 1);
  }

  /** For the overlay: what was given up, in words. */
  describe(): string {
    const l = this.levers;
    const parts: string[] = [];
    if (l.scale < 1) parts.push(`resolution ${(l.scale * 100).toFixed(0)}%`);
    if (l.shadowEvery > this.base.shadowEvery) parts.push(`shadows 1 in ${l.shadowEvery}`);
    if (l.post !== this.base.post) parts.push('no post effects');
    if (l.lod < 1) parts.push(`detail range ${(l.lod * 100).toFixed(0)}%`);
    if (!l.props) parts.push('no small props');
    const why =
      this.limit === 'pixels'
        ? 'graphics card (pixels)'
        : this.limit === 'scene'
          ? 'graphics card (scene and shadows)'
          : this.limit === 'cpu'
            ? 'processor'
            : 'none';
    return `limit: ${why}${parts.length > 0 ? `, gave up ${parts.join(', ')}` : ''}`;
  }
}

/** The pixel ratio a level may draw at on a screen of this size (CSS pixels). */
export function ratioFor(quality: Quality, width: number, height: number, dpr: number): number {
  const fit = Math.sqrt(PIXEL_BUDGET[quality] / Math.max(1, width * height));
  return Math.max(0.5, Math.min(dpr, 2, fit));
}
