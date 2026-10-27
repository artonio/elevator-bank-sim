/**
 * Travel / service direction of a car or a hall call. 0 means "no committed direction".
 * Directions are used both as object keys (`car.hallCalls[UP]`) and in arithmetic:
 * `dir * (target - floor) > 0` means "target is ahead of floor when travelling in dir".
 * @typedef {1 | -1 | 0} Direction
 */

/** @type {1} */
export const UP = 1;
/** @type {-1} */
export const DOWN = -1;

/**
 * Car controller states. A car goes idle → moving → opening → open → closing, and when
 * the doors are shut it decides again whether to open, move on, or go idle.
 * @typedef {'idle' | 'moving' | 'opening' | 'open' | 'closing'} CarStateName
 */
export const CarState = Object.freeze({
  IDLE: 'idle',       // stopped at a floor, doors closed, nothing to do
  MOVING: 'moving',
  OPENING: 'opening',
  OPEN: 'open',       // doors fully open, passengers transfer
  CLOSING: 'closing',
});

/**
 * Physical and operational defaults. Figures are typical for a mid-rise office
 * building served by traction elevators.
 */
export const DEFAULT_CONFIG = Object.freeze({
  floors: 12,
  cars: 3,
  floorHeight: 3.5,         // m between landings
  maxSpeed: 2.5,            // m/s rated speed
  acceleration: 1.0,        // m/s², also used for braking
  capacity: 13,             // persons (1000 kg rated load at 75 kg per person)
  ratedLoad: 1000,          // kg; a car weighing more holds its doors open and won't leave
  doorOpenTime: 1.8,        // s for the doors to open fully
  doorCloseTime: 2.4,       // s for the doors to close fully
  minDwell: 2.0,            // s the doors stay fully open before they may close
  transferTime: 1.2,        // s per passenger boarding or alighting
  parkIdleAfter: 20,        // s an empty idle car waits before returning to the lobby (0 disables)
  redispatchInterval: 1.0,  // s between re-evaluations of unanswered hall calls
});

/**
 * Building settings: `DEFAULT_CONFIG` with any overrides passed to `new Simulation({ config })`.
 * The simulation, every car and the dispatcher all read the same object.
 * @typedef {typeof DEFAULT_CONFIG} Config
 */

/** Average passenger mass in kg; each car's load reading counts this much per person. */
export const KG_PER_PERSON = 75;

/**
 * North-American style landing labels: the ground floor is the lobby "L", the next one is 2.
 * Code always works with floor indices; labels are for display only.
 * @param {number} index floor index, 0 = lobby
 * @returns {string} e.g. 'L' for 0, '7' for 6
 */
export function floorLabel(index) {
  return index === 0 ? 'L' : String(index + 1);
}

/**
 * Arrow for a direction, for display.
 * @param {Direction} dir
 * @returns {string} '▲' for UP, '▼' for DOWN, '' for 0
 */
export function dirArrow(dir) {
  return dir === UP ? '▲' : dir === DOWN ? '▼' : '';
}
