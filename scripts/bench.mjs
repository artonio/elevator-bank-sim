// Compare dispatch strategies on identical seeded traffic.
// Usage: node scripts/bench.mjs [--pattern uppeak|downpeak|lunch|interfloor] [--rate 14] [--minutes 30] [--seed 7] [--floors 12]
import { runScenario, STRATEGIES } from '../src/index.js';

/**
 * Value of a `--name value` command-line flag.
 * @param {string} name flag name without the dashes
 * @param {string | number} fallback used when the flag is absent
 * @returns {string | number} the flag's value (a string) or the fallback
 */
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const opts = {
  pattern: arg('pattern', 'uppeak'),
  rate: Number(arg('rate', 14)),
  minutes: Number(arg('minutes', 30)),
  seed: Number(arg('seed', 7)),
  config: { floors: Number(arg('floors', 12)) },
};

console.log(`${opts.pattern}, ${opts.rate}/min for ${opts.minutes} min, ${opts.config.floors} floors, seed ${opts.seed}\n`);
const rows = Object.values(STRATEGIES).map((s) => {
  const r = runScenario({ ...opts, strategy: s.id });
  return {
    strategy: s.label,
    passengers: r.delivered,
    'avg wait s': r.avgWait.toFixed(1),
    'p95 wait s': r.p95Wait.toFixed(1),
    'max wait s': r.maxWait.toFixed(0),
    'avg trip s': r.avgTrip.toFixed(1),
    'car travel km': (r.distance / 1000).toFixed(2),
  };
});
console.table(rows);
