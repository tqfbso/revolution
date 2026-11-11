// Seeded xorshift32. State lives in the world so it is hashed and (later) saved/synced.

export function seedRng(state: Uint32Array, seed: number): void {
  // Avalanche the seed so nearby seeds diverge immediately; state must never be 0.
  let s = (seed ^ 0x9e3779b9) >>> 0;
  s = Math.imul(s ^ (s >>> 16), 0x85ebca6b) >>> 0;
  s = Math.imul(s ^ (s >>> 13), 0xc2b2ae35) >>> 0;
  s = (s ^ (s >>> 16)) >>> 0;
  state[0] = s === 0 ? 0x6d2b79f5 : s;
}

export function nextU32(state: Uint32Array): number {
  let x = state[0];
  x ^= x << 13;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  x >>>= 0;
  state[0] = x;
  return x;
}

/** Uniform-ish integer in [0, n). Modulo bias is irrelevant for gameplay ranges. */
export function nextInt(state: Uint32Array, n: number): number {
  return nextU32(state) % n;
}
