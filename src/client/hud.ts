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
  /** Units drawn per level of detail, units off-screen, live effect particles. */
  lod: number[];
  culled: number;
  particles: number;
  backend: string;
  /** Render resolution as a fraction of full (lowered automatically under load). */
  scale: number;
  drawCalls: number;
  triangles: number;
  /** Camera distance, and the CPU cost per frame of the units, the effects and the draw submit. */
  zoom: number;
  cpuUnits: number;
  cpuFx: number;
  cpuDraw: number;
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
    lod: [0, 0, 0],
    culled: 0,
    particles: 0,
    backend: '',
    scale: 1,
    drawCalls: 0,
    triangles: 0,
    zoom: 0,
    cpuUnits: 0,
    cpuFx: 0,
    cpuDraw: 0,
    hash: '',
  };
  private readonly el = document.getElementById('perf') as HTMLPreElement;
  private frames = 0;
  private frameMax = 0;
  private windowStart = performance.now();
  private simSum = 0;
  private simMax = 0;
  private simTicks = 0;
  /** The full readout, or one line. Click the panel or press F3 to switch. */
  private full = false;

  constructor() {
    try {
      this.full = localStorage.getItem('revolution.perf') === '1';
    } catch {
      // storage may be blocked; the short line is fine
    }
    const toggle = () => {
      this.full = !this.full;
      try {
        localStorage.setItem('revolution.perf', this.full ? '1' : '0');
      } catch {
        // not remembered
      }
      this.draw();
    };
    this.el.addEventListener('click', toggle);
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'F3') return;
      e.preventDefault();
      toggle();
    });
  }

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
    this.draw();
  }

  private draw(): void {
    const s = this.stats;
    if (!this.full) {
      this.el.textContent = `FPS ${s.fps.toFixed(0)} · ${s.alive.reduce((a, b) => a + b, 0)} units · build ${__BUILD__}`;
      return;
    }
    this.el.textContent =
      `FPS        ${s.fps.toFixed(0)}\n` +
      `Frame      ${s.frameMs.toFixed(1)} ms (worst ${s.frameMsMax.toFixed(1)})\n` +
      `Sim tick   ${s.simMs.toFixed(2)} ms (worst ${s.simMsMax.toFixed(2)}) @ ${TICK_RATE} Hz\n` +
      `Units      ${s.alive.reduce((a, b) => a + b, 0)} alive   selected ${s.selected}\n` +
      `Armies     red (you) ${s.alive[0] ?? 0}   blue ${s.alive[1] ?? 0}   gold ${s.alive[2] ?? 0}\n` +
      `Detail     near ${s.lod[0]}  mid ${s.lod[1]}  far ${s.lod[2]}  off-screen ${s.culled}  fx ${s.particles}\n` +
      `Renderer   ${s.backend}   ${s.drawCalls} draws, ${(s.triangles / 1000).toFixed(0)}k tris, scale ${(s.scale * 100).toFixed(0)}%\n` +
      `CPU/frame  units ${s.cpuUnits.toFixed(1)}  fx ${s.cpuFx.toFixed(1)}  draw submit ${s.cpuDraw.toFixed(1)} ms   camera ${s.zoom.toFixed(0)} m away\n` +
      `State hash ${s.hash}   build ${__BUILD__}`;
  }

  simTick(ms: number): void {
    this.simSum += ms;
    this.simTicks++;
    if (ms > this.simMax) this.simMax = ms;
  }
}
