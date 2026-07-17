// Seeded PRNG (mulberry32) — the sim's ONLY source of randomness. world.ts
// owns exactly one instance per Sim and threads it into every car's step in
// car order, so a fixed seed makes deslot/tumble kinematics fully
// reproducible (same seed → same tumble kick/spin every run), which is what
// lets determinism.test.ts assert bit-identical replays.
export interface Rng {
  /** Next pseudorandom value, in [0, 1). */
  next(): number;
  /** Next pseudorandom value, in [lo, hi). */
  range(lo: number, hi: number): number;
}

export function createRng(seed: number): Rng {
  let a = seed >>> 0;

  function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function range(lo: number, hi: number): number {
    return lo + next() * (hi - lo);
  }

  return { next, range };
}
