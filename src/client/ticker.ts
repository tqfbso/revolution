// Text longer than its field (decision 127): it is never cut silently. It runs past once,
// like a news ticker, then rests with an ellipsis, and runs again under the pointer.
//
// The boards redraw themselves several times a second, which throws the elements away, so
// what has already run is remembered here by key: a line that has had its run stays at
// rest however often it is redrawn, and one in the middle of its run carries on from where
// it was.

interface Run {
  text: string;
  /** When it set off (performance.now()), and how long the run takes, in seconds. */
  at: number;
  seconds: number;
}

const runs = new Map<string, Run>();
/** Pixels a second. */
const SPEED = 45;

const escape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/** A field that scrolls what does not fit. `html` is trusted; `key` names the field. */
export function tickHtml(key: string, html: string, cls = ''): string {
  return `<span class="tick${cls ? ` ${cls}` : ''}" data-tick="${escape(key)}"><span class="tick-in">${html}</span></span>`;
}

/** The same as an element, for text. */
export function tickEl(text: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'tick';
  const inner = document.createElement('span');
  inner.className = 'tick-in';
  inner.textContent = text;
  el.append(inner);
  return el;
}

function arm(el: HTMLElement, now: number, again: boolean): void {
  const inner = el.firstElementChild as HTMLElement | null;
  if (!inner) return;
  // Measured at rest: the reading also restarts an animation taken off just before.
  el.classList.remove('go');
  const over = el.scrollWidth - el.clientWidth;
  const key = el.dataset.tick ?? '';
  if (over <= 1) {
    if (key) runs.delete(key);
    return;
  }
  const text = el.textContent ?? '';
  let run = key ? runs.get(key) : undefined;
  if (!run || run.text !== text || again) {
    run = { text, at: now, seconds: Math.max(3, over / SPEED + 2.4) };
    if (key) runs.set(key, run);
  }
  const gone = (now - run.at) / 1000;
  if (gone >= run.seconds) return;
  inner.style.setProperty('--tick', `${-over}px`);
  inner.style.animationDuration = `${run.seconds}s`;
  inner.style.animationDelay = `${-gone}s`;
  el.classList.add('go');
}

/** After a redraw of `root`: set off, carry on or leave at rest every field in it. */
export function runTickers(root: HTMLElement): void {
  const now = performance.now();
  for (const el of root.querySelectorAll<HTMLElement>('.tick')) arm(el, now, false);
}

/** One field that has just been put on the page. */
export function runTicker(el: HTMLElement): void {
  arm(el, performance.now(), false);
}

let wired = false;
/** Once: the end of a run puts the ellipsis back, and the pointer sets it off again. */
export function wireTickers(): void {
  if (wired) return;
  wired = true;
  document.addEventListener('animationend', (e) => {
    const inner = e.target as HTMLElement | null;
    if (inner?.classList?.contains('tick-in')) inner.parentElement?.classList.remove('go');
  });
  document.addEventListener('mouseover', (e) => {
    const el = (e.target as HTMLElement | null)?.closest?.('.tick') as HTMLElement | null;
    if (el && !el.classList.contains('go')) arm(el, performance.now(), true);
  });
}
