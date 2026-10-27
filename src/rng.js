/**
 * Small seeded PRNG (mulberry32). Deterministic traffic lets different dispatch
 * strategies be compared on exactly the same stream of passengers.
 * @param {number} seed any number; the same seed always gives the same sequence
 * @returns {() => number} call it for the next value, uniform in [0, 1)
 */
export function createRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
