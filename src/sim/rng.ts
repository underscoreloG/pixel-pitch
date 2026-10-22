// Seeded PRNG (mulberry32). The seed lives in the match state so a match is
// fully reproducible from (seed, inputs). Never use Math.random() in the sim.

export function random(rng: { seed: number }): number {
  let t = (rng.seed = (rng.seed + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function randomRange(rng: { seed: number }, min: number, max: number): number {
  return min + (max - min) * random(rng);
}
