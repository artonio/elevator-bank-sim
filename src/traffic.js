import { createRng } from './rng.js';

/**
 * A passenger arrival pattern.
 * @typedef {object} Pattern
 * @property {string} id key in `PATTERNS`
 * @property {string} label name shown on the page
 * @property {number | null} fromLobby share of trips that start at the lobby, 0 to 1; null for interfloor
 * @property {number | null} toLobby share of trips that end at the lobby, 0 to 1; null for interfloor
 */

/**
 * One new passenger.
 * @typedef {object} Arrival
 * @property {number} time when they arrive, s
 * @property {number} origin floor index
 * @property {number} dest floor index, never equal to origin
 */

/**
 * Options for `new TrafficGenerator(...)`.
 * @typedef {object} TrafficOptions
 * @property {string} [pattern='uppeak'] key of `PATTERNS`; unknown keys fall back to up-peak
 * @property {number} [rate=20] passengers per minute; 0 for no arrivals
 * @property {number} [seed=1] seed for the random stream
 * @property {number} floors number of floors in the building
 */

/**
 * Passenger arrival patterns. `fromLobby` / `toLobby` are the shares of trips that
 * start or end at the lobby; the rest travel between upper floors.
 * @type {Readonly<Record<string, Pattern>>}
 */
export const PATTERNS = Object.freeze({
  uppeak: { id: 'uppeak', label: 'Morning up-peak', fromLobby: 0.85, toLobby: 0.05 },
  downpeak: { id: 'downpeak', label: 'Evening down-peak', fromLobby: 0.05, toLobby: 0.85 },
  lunch: { id: 'lunch', label: 'Lunch two-way', fromLobby: 0.4, toLobby: 0.4 },
  interfloor: { id: 'interfloor', label: 'Interfloor', fromLobby: null, toLobby: null },
});

/**
 * Poisson arrivals at `rate` passengers per minute, origins and destinations drawn
 * from the pattern. Consumes its own seeded RNG and nothing else, so the arrival
 * stream is identical whatever the cars do.
 */
export class TrafficGenerator {
  /**
   * @param {TrafficOptions} options
   */
  constructor({ pattern = 'uppeak', rate = 20, seed = 1, floors }) {
    this.rng = createRng(seed);
    this.floors = floors;
    /** @type {Pattern} */
    this.pattern = PATTERNS[pattern] ?? PATTERNS.uppeak;
    this.rate = rate;
    // s; arrivals up to this time have already been handed out
    this.clock = 0;
    this.nextTime = this.rate > 0 ? this.sampleGap() : Infinity;
  }

  /**
   * Change the arrival rate from now on.
   * @param {number} rate passengers per minute; 0 stops new arrivals
   */
  setRate(rate) {
    this.rate = rate;
    this.nextTime = rate > 0 ? this.clock + this.sampleGap() : Infinity;
  }

  /**
   * Change the pattern for arrivals from now on. Unknown ids are ignored.
   * @param {string} id key of `PATTERNS`
   */
  setPattern(id) {
    this.pattern = PATTERNS[id] ?? this.pattern;
  }

  /**
   * Arrivals with time <= t, in order.
   * @param {number} t simulated time, s
   * @returns {Arrival[]} everyone arriving since the previous call, up to `t`
   */
  arrivalsUntil(t) {
    const out = [];
    while (this.nextTime <= t) {
      out.push({ time: this.nextTime, ...this.sampleTrip() });
      this.nextTime += this.sampleGap();
    }
    this.clock = t;
    return out;
  }

  /**
   * Seconds until the next arrival, drawn from an exponential distribution (which makes
   * arrivals a Poisson process).
   * @returns {number}
   */
  sampleGap() {
    return (-Math.log(1 - this.rng()) * 60) / this.rate;
  }

  /**
   * Origin and destination for one passenger, following the current pattern.
   * @returns {{ origin: number, dest: number }} floor indices, never equal
   */
  sampleTrip() {
    const n = this.floors;
    const rng = this.rng;
    const anyFloor = () => Math.floor(rng() * n);
    const upperFloor = () => 1 + Math.floor(rng() * (n - 1));
    const p = this.pattern;
    if (p.fromLobby === null) {
      const origin = anyFloor();
      let dest = anyFloor();
      while (dest === origin) dest = anyFloor();
      return { origin, dest };
    }
    const r = rng();
    if (r < p.fromLobby) return { origin: 0, dest: upperFloor() };
    if (r < p.fromLobby + p.toLobby) return { origin: upperFloor(), dest: 0 };
    const origin = upperFloor();
    let dest = upperFloor();
    while (dest === origin) dest = upperFloor();
    return { origin, dest };
  }
}
