// Seeded PRNG (spec §4.3: "Seeded PRNG ... default = wall clock"). Every random
// draw in src/show and src/gpu must go through this; the global Math random API is prohibited.

export type RNG = () => number;

/** mulberry32: fast, deterministic 32-bit PRNG. Returns a float in [0, 1). */
export function mulberry32(seed: number): RNG {
  let a = seed >>> 0;
  return function rng(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform float in the inclusive-exclusive range [a, b). */
export function range(rng: RNG, [a, b]: readonly [number, number]): number {
  return a + rng() * (b - a);
}

/** Uniform pick from a non-empty array. */
export function pick<T>(rng: RNG, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}
