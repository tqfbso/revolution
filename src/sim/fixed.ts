// Fixed-point helpers. All simulation quantities are integers; world distances use
// Q22.10 (1 world unit = 1024). With a 1024-unit map every intermediate product in the
// sim stays far below 2^53, so plain JS number arithmetic on these integers is exact
// and therefore identical on every engine.

export const FP_SHIFT = 10;
export const FP_ONE = 1 << FP_SHIFT;

/** Convert a float to fixed-point. Only for constants and for input at the sim boundary. */
export function fx(n: number): number {
  return Math.round(n * FP_ONE);
}

export function fromFx(n: number): number {
  return n / FP_ONE;
}

/**
 * Integer square root: floor(sqrt(n)) for 0 <= n < 2^53.
 * The correction loops make the result exact even if an engine's Math.sqrt is off by an ulp.
 */
export function isqrt(n: number): number {
  if (n <= 0) return 0;
  let r = Math.floor(Math.sqrt(n));
  while (r * r > n) r--;
  while ((r + 1) * (r + 1) <= n) r++;
  return r;
}

export function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
