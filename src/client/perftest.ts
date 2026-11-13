// The performance test (Menu, "Performance test"). Twenty seconds at whatever the camera
// shows: it switches one cost off at a time and measures what comes back. The answer to
// "is it the graphics card or the processor?" cannot be measured in the cloud, where the
// browser has no graphics card, so the game measures it on the machine it runs on.
import type { Levers } from './governor';
import type { PerfStats } from './hud';

interface Phase {
  name: string;
  levers: Partial<Levers>;
  hide?: { units?: boolean; town?: boolean };
}

const PHASES: Phase[] = [
  { name: 'Everything on', levers: {} },
  { name: 'Half the pixels', levers: { scale: 0.7 } },
  { name: 'Shadow map frozen', levers: { shadowEvery: 0 } },
  { name: 'No post effects', levers: { post: false } },
  { name: 'Units not drawn', levers: {}, hide: { units: true } },
  { name: 'Buildings and props not drawn', levers: {}, hide: { town: true } },
];
const PHASE_MS = 3300;
const SETTLE_MS = 1100;
const FULL: Levers = { scale: 1, shadowEvery: 1, post: true, lod: 1, props: true };

export interface PerfResult {
  name: string;
  ms: number;
  work: number;
}

export class PerfTest {
  running = false;
  results: PerfResult[] = [];
  verdict = '';
  private phase = 0;
  private since = 0;
  private sum = 0;
  private work = 0;
  private n = 0;
  private done = false;
  private levers: Levers = { ...FULL };
  private stats: PerfStats | null = null;
  private post = true;

  constructor(
    private readonly el: HTMLElement | null,
    private readonly hide: (h: { units?: boolean; town?: boolean }) => void,
  ) {
    el?.addEventListener('click', () => {
      if (!this.running && this.el) this.el.style.display = 'none';
    });
  }

  start(stats: PerfStats, now: Levers): void {
    if (this.running) return;
    this.running = true;
    this.stats = stats;
    this.post = now.post;
    this.results = [];
    this.phase = -1;
    this.since = 0;
    if (this.el) {
      this.el.style.display = 'block';
      this.el.textContent = 'Performance test: keep the view still for 20 seconds…';
    }
  }

  /** True once, on the first frame after the test ended, so the caller restores its levers. */
  finished(): boolean {
    const d = this.done;
    this.done = false;
    return d;
  }

  /** One frame of the test. Returns the levers to draw the next frame with. */
  frame(dtMs: number, workMs: number, now: number): Levers {
    if (this.phase < 0 || now - this.since >= PHASE_MS) {
      if (this.phase >= 0 && this.n > 0) {
        this.results.push({
          name: PHASES[this.phase].name,
          ms: this.sum / this.n,
          work: this.work / this.n,
        });
      }
      this.phase++;
      this.since = now;
      this.sum = this.work = this.n = 0;
      if (this.phase >= PHASES.length) {
        this.hide({});
        this.running = false;
        this.done = true;
        this.report();
        return this.levers;
      }
      const p = PHASES[this.phase];
      this.levers = { ...FULL, post: this.post, ...p.levers };
      this.hide(p.hide ?? {});
      if (this.el)
        this.el.textContent = `Performance test ${this.phase + 1} of ${PHASES.length}: ${p.name.toLowerCase()}…`;
    } else if (now - this.since > SETTLE_MS) {
      this.sum += dtMs;
      this.work += workMs;
      this.n++;
    }
    return this.levers;
  }

  private report(): void {
    const r = this.results;
    if (r.length < PHASES.length) return;
    const base = r[0];
    const gain = (i: number) => (base.ms - r[i].ms) / base.ms;
    const fps = (ms: number) => (1000 / ms).toFixed(0);
    // A frame that is all this thread's own work is the processor's; the rest is waiting
    // for the graphics card (or for the screen, when nothing is slow at all).
    const busy = base.work / base.ms;
    let verdict: string;
    if (base.ms < 17.4) {
      verdict =
        'Nothing is slow here: the frame rate sits at the screen refresh. Run the test again in the middle of a big fight.';
    } else if (busy > 0.7) {
      verdict = `The PROCESSOR is the limit: ${(busy * 100).toFixed(0)}% of each frame is the game's own work. Fewer pixels will not help; fewer units in full detail will.`;
    } else {
      const names = ['', 'the number of PIXELS', 'SHADOWS', 'POST EFFECTS', 'UNITS', 'BUILDINGS'];
      let best = 1;
      for (let i = 2; i < r.length; i++) if (gain(i) > gain(best)) best = i;
      verdict =
        gain(best) < 0.08
          ? 'The GRAPHICS CARD is the limit, but no single cost stands out.'
          : `The GRAPHICS CARD is the limit, and the biggest single cost is ${names[best]} (${(gain(best) * 100).toFixed(0)}% of the frame).`;
    }
    this.verdict = verdict;
    const s = this.stats;
    let text = `PERFORMANCE TEST   ${s ? `${s.backend}, ${s.units} units, camera ${s.zoom.toFixed(0)} m away, ${s.drawCalls} draws, ${(s.triangles / 1000).toFixed(0)}k triangles` : ''}\n\n`;
    for (const x of r) {
      text += `${x.name.padEnd(30)} ${fps(x.ms).padStart(4)} fps   ${x.ms.toFixed(1).padStart(5)} ms a frame, ${x.work.toFixed(1).padStart(5)} ms of it the game's own work\n`;
    }
    text += `\n${verdict}\n\n(click to close; a screenshot of this is what to send)`;
    if (this.el) this.el.textContent = text;
  }
}
