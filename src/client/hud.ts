import { TICK_RATE } from '../sim/world';

declare const __BUILD__: string;

export interface PerfStats {
  fps: number;
  frameMs: number;
  frameMsMax: number;
  simMs: number;
  simMsMax: number;
  units: number;
  selected: number;
  /** Living units per team. */
  alive: number[];
  backend: string;
  drawCalls: number;
  triangles: number;
  hash: string;
}

/** Rolling performance numbers, refreshed on screen twice a second. */
export class Hud {
  readonly stats: PerfStats = {
    fps: 0,
    frameMs: 0,
    frameMsMax: 0,
    simMs: 0,
    simMsMax: 0,
    units: 0,
    selected: 0,
    alive: [],
    backend: '',
    drawCalls: 0,
    triangles: 0,
    hash: '',
  };
  private readonly el = document.getElementById('perf') as HTMLPreElement;
  private frames = 0;
  private frameMax = 0;
  private windowStart = performance.now();
  private simSum = 0;
  private simMax = 0;
  private simTicks = 0;

  frame(dtMs: number): void {
    this.frames++;
    if (dtMs > this.frameMax) this.frameMax = dtMs;
    const now = performance.now();
    const elapsed = now - this.windowStart;
    if (elapsed < 500) return;
    const s = this.stats;
    s.fps = (this.frames * 1000) / elapsed;
    s.frameMs = elapsed / this.frames;
    s.frameMsMax = this.frameMax;
    if (this.simTicks > 0) {
      s.simMs = this.simSum / this.simTicks;
      s.simMsMax = this.simMax;
    }
    this.frames = 0;
    this.frameMax = 0;
    this.simSum = 0;
    this.simMax = 0;
    this.simTicks = 0;
    this.windowStart = now;
    this.el.textContent =
      `FPS        ${s.fps.toFixed(0)}\n` +
      `Frame      ${s.frameMs.toFixed(1)} ms (worst ${s.frameMsMax.toFixed(1)})\n` +
      `Sim tick   ${s.simMs.toFixed(2)} ms (worst ${s.simMsMax.toFixed(2)}) @ ${TICK_RATE} Hz\n` +
      `Units      ${s.alive.reduce((a, b) => a + b, 0)} alive   selected ${s.selected}\n` +
      `Armies     red ${s.alive[0] ?? 0}   blue ${s.alive[1] ?? 0}   gold ${s.alive[2] ?? 0}\n` +
      `Renderer   ${s.backend}   ${s.drawCalls} draws, ${(s.triangles / 1000).toFixed(0)}k tris\n` +
      `State hash ${s.hash}   build ${__BUILD__}`;
  }

  simTick(ms: number): void {
    this.simSum += ms;
    this.simTicks++;
    if (ms > this.simMax) this.simMax = ms;
  }
}
