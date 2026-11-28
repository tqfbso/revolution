export const lerp = (a, b, t) => a + (b - a) * t;
export const v = (a, b, t) => a.map((x, i) => lerp(x, b[i], t));
export const ease = t => t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t);
export const lin = t => Math.min(1, Math.max(0, t));
/** A move from one camera to another over the whole shot (dur seconds), linear drift by default: steady, like a dolly. */
export const dolly = (dur, a, b, e = lin) => (t) => { const k = e(t / dur); return { pos: v(a.pos, b.pos, k), target: v(a.target, b.target, k), fov: lerp(a.fov ?? 34, b.fov ?? a.fov ?? 34, k), lod: lerp(a.lod ?? 40, b.lod ?? a.lod ?? 40, k), roll: lerp(a.roll ?? 0, b.roll ?? 0, k) }; };
