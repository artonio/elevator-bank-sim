// Public API of the engine, for the tests and the bench. The browser page imports the
// individual modules instead, because the bundler (scripts/build.mjs) can't follow re-exports.
export { UP, DOWN, CarState, DEFAULT_CONFIG, floorLabel } from './constants.js';
export { Elevator } from './elevator.js';
export { STRATEGIES, chooseCar, estimateArrival, travelTime } from './dispatch.js';
export { PATTERNS, TrafficGenerator } from './traffic.js';
export { Simulation, runScenario } from './simulation.js';
