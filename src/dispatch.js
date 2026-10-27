import { CarState } from './constants.js';

/** @typedef {import('./constants.js').Direction} Direction */
/** @typedef {import('./constants.js').Config} Config */
/** @typedef {import('./elevator.js').Elevator} Elevator */
/** @typedef {import('./simulation.js').Simulation} Simulation */
/** @typedef {import('./simulation.js').HallCall} HallCall */

/**
 * One predicted stop on a car's route.
 * @typedef {object} RouteStop
 * @property {number} t seconds from now until the car opens its doors there
 * @property {number} floor floor index
 * @property {Direction} dir hall-call direction served, or 0 for a car call
 * @property {boolean} full whether the car is expected to arrive full (it would pass the hall call by)
 */

/**
 * A car picked for a hall call, with the cost the strategy gave it.
 * @typedef {object} Choice
 * @property {Elevator} car
 * @property {number} cost lower is better; 0 for strategies that don't price cars
 */

/**
 * A dispatch strategy. It has either `cost` (lower wins, and `chooseCar` asks every car)
 * or `choose` (picks a car directly).
 * @typedef {object} Strategy
 * @property {string} id key in `STRATEGIES`, e.g. 'eta'
 * @property {string} label name shown on the page
 * @property {string} summary one-line description shown on the page
 * @property {boolean} reassign may `redispatch` move an unanswered call to a better car later?
 * @property {number} hysteresis how much lower another car's cost must be before a call moves to it
 * @property {(sim: Simulation, car: Elevator, call: HallCall) => number} [cost]
 * @property {(sim: Simulation, call: HallCall) => Choice} [choose]
 */

/** Hall calls arrive here; the dispatcher picks which car answers each one. */

/**
 * Seconds to travel `distance` metres from rest to rest with a trapezoidal profile.
 * @param {number} distance metres
 * @param {Config} cfg reads `maxSpeed` and `acceleration`
 * @returns {number} seconds
 */
export function travelTime(distance, cfg) {
  if (distance <= 0) return 0;
  const { maxSpeed: v, acceleration: a } = cfg;
  const rampDistance = (v * v) / a; // accelerate to v, then brake from v
  // Long trip: speed up to v, cruise, brake, which takes distance / v + v / a.
  // Short trip: the car never reaches v; it speeds up for half the distance and brakes
  // for the other half, which takes 2 √(distance / a).
  return distance >= rampDistance ? distance / v + v / a : 2 * Math.sqrt(distance / a);
}

/** Stand-in `env` for planning: no hall buttons are lit, so only the car's own calls count. */
const NO_HALL_CALLS = Object.freeze({ hallCall: () => false });

/** Map key for a hall call in `simulateRoute`'s result, e.g. 'h-1:6' for Down at index 6. */
const hallKey = (dir, floor) => `h${dir}:${floor}`;
/** Map key for a car call in `simulateRoute`'s result, e.g. 'c9'. */
const carKey = (floor) => `c${floor}`;

/**
 * Predicts when `car` will serve each of its commitments by walking its LOOK sequence
 * stop by stop: travel time between stops plus a full door cycle at every stop.
 * `extra` is a hall call to add to the plan, `exclude` one to take out of it.
 *
 * With `sim`, it also projects the load: riders leave at their floors, and everyone
 * waiting at a hall stop is expected to board. Their destinations are unknown, so they
 * are assumed to be gone by the end of the sweep. A hall stop reached with a projected
 * full car is flagged `full` (the real car would bypass it).
 *
 * Returns a Map from commitment key to { t: seconds from now, floor, dir, full }
 * where dir 0 marks a car call.
 *
 * @param {Elevator} car the car to predict; it is not modified
 * @param {{ floor: number, dir: Direction } | null} [extra=null] hall call to add to its plan
 * @param {{ floor: number, dir: Direction } | null} [exclude=null] hall call to take out of its plan
 * @param {Simulation | null} [sim=null] when given, also project how full the car will be
 * @returns {Map<string, RouteStop>} keyed by `hallKey(dir, floor)` or `carKey(floor)`
 */
export function simulateRoute(car, extra = null, exclude = null, sim = null) {
  const cfg = car.cfg;
  const H = cfg.floorHeight;
  // Time spent at every stop: doors open, minimum dwell, doors close, plus one passenger
  // getting through.
  const stopTime = cfg.doorOpenTime + cfg.minDwell + cfg.doorCloseTime + cfg.transferTime;
  const moving = car.state === CarState.MOVING;
  const times = new Map();

  // Load projection: how many riders get out at each floor, and how many people are
  // waiting at a hall stop (0 everywhere when there is no `sim`, so no projection).
  const riders = new Map();
  for (const p of car.passengers) riders.set(p.dest, (riders.get(p.dest) ?? 0) + 1);
  const waitingAt = (f, d) => (sim ? waitingCount(sim, f, d) : 0);
  let known = car.load; // riders already aboard
  let boarded = 0;      // expected to board during the current sweep

  // Plan on a stripped copy so the real car is never touched, with `exclude` taken out
  // and `extra` put in.
  const g = car.planningCopy();
  if (exclude) g.hallCalls[exclude.dir].delete(exclude.floor);
  if (extra) {
    // A stationary car that can already take this direction answers on the spot.
    if (!moving && car.floor === extra.floor && (car.direction === extra.dir || car.direction === 0)) {
      times.set(hallKey(extra.dir, extra.floor), { t: 0, floor: extra.floor, dir: extra.dir, full: car.isFull });
    } else {
      g.hallCalls[extra.dir].add(extra.floor);
    }
  }

  // A car with its doors in motion has to finish the door cycle before it can leave.
  let t = 0; // time until the car can leave its current floor
  switch (car.state) {
    case CarState.OPENING: t = (1 - car.door) * cfg.doorOpenTime + cfg.minDwell + cfg.doorCloseTime; break;
    case CarState.OPEN: t = Math.max(car.dwell, car.transfer) + cfg.doorCloseTime; break;
    case CarState.CLOSING: t = car.door * cfg.doorCloseTime; break;
    default: break;
  }

  // A moving car plans from where it could still stop (its braking point), and a stop
  // exactly there counts. A stopped car plans from its floor.
  let from = moving ? car.commitFloor : car.floor;
  let inclusive = moving;
  let dir = car.direction;
  let headStart = moving ? car.speed / (2 * cfg.acceleration) : 0; // already partly up to speed

  // One stop per pass. The cap only guards against a plan that never ends; a real route
  // finishes long before it.
  for (let i = 0; i < 4 * cfg.floors + 8; i++) {
    // No direction yet: head for the nearest thing to do, or stop planning if there is none.
    if (dir === 0) {
      const nearest = g.nearestRequest(from, inclusive ? null : Math.round(from));
      if (nearest === null) break;
      dir = Math.sign(nearest - from);
    }
    // The next floor the LOOK rules would stop at going this way.
    const next = g.nextStop(dir, from, inclusive);
    if (next === null) {
      // Nothing more ahead: turn round if there is work behind, otherwise the route is done.
      // People who boarded on this sweep are assumed to be out by now.
      if (g.hasRequestsBeyond(from, -dir)) {
        dir = -dir;
        inclusive = false;
        boarded = 0;
        continue;
      }
      break;
    }
    // Drive there. A moving car's first leg is measured from where it actually is, less a
    // head start for the speed it already has.
    const legFrom = moving && i === 0 ? car.floatFloor : from;
    t += Math.max(0, travelTime(Math.abs(next - legFrom) * H, cfg) - headStart);
    headStart = 0;

    // Put the copy at the stop and ask which direction it would leave in, counting only
    // its own calls. A hall call here in that direction is answered by this stop.
    g.pos = next * H;
    g.direction = dir;
    const served = g.chooseDirectionAt(next, NO_HALL_CALLS);
    // A car call here: its riders get out.
    if (g.carCalls.delete(next)) {
      known -= riders.get(next) ?? 0;
      times.set(carKey(next), { t, floor: next, dir: 0, full: false });
    }
    if (served !== 0 && served !== dir) boarded = 0; // turning round here
    // A hall call here: record when it is answered and whether the car would arrive full.
    // If there is room, the people waiting are expected to get in.
    if (served !== 0 && g.hallCalls[served].delete(next)) {
      const full = known + boarded >= cfg.capacity;
      times.set(hallKey(served, next), { t, floor: next, dir: served, full });
      if (!full) boarded += waitingAt(next, served);
    }
    // Door cycle, then carry on from here in the direction just served.
    t += stopTime;
    from = next;
    inclusive = false;
    if (served !== 0) dir = served;
  }

  // Anything left can only be at the floor the car ended on (a call behind its doors).
  const here = Math.round(from);
  for (const d of [1, -1]) {
    if (g.hallCalls[d].has(here)) times.set(hallKey(d, here), { t, floor: here, dir: d, full: false });
  }
  return times;
}

/**
 * How many people at floor `f` are waiting to go in direction `d`, counting at least one
 * (a lit button means someone is there).
 * @param {Simulation} sim
 * @param {number} f floor index
 * @param {Direction} d UP or DOWN
 * @returns {number}
 */
function waitingCount(sim, f, d) {
  let n = 0;
  for (const p of sim.waiting[f]) if (p.dir === d) n++;
  // Never 0: the call exists, so the plan should expect at least one person to board.
  return Math.max(1, n);
}

/**
 * Seconds until `car` would open its doors at call.floor for call.dir if it took the call.
 * @param {Elevator} car
 * @param {{ floor: number, dir: Direction }} call
 * @returns {number} seconds, or Infinity if the route never reaches the call
 */
export function estimateArrival(car, call) {
  // Add the call to the car's plan and read off when it is answered. No `sim` is passed,
  // so this is timing only, with no load projection.
  return simulateRoute(car, call).get(hallKey(call.dir, call.floor))?.t ?? Infinity;
}

/**
 * Dispatch strategies. Cost-based strategies return a number per car (lower wins)
 * and may move an unanswered call to a better car later; `hysteresis` is how much
 * better the new car must be, which stops calls bouncing between cars.
 * @type {Readonly<Record<string, Strategy>>}
 */
export const STRATEGIES = Object.freeze({
  eta: {
    id: 'eta',
    label: 'ETA',
    summary: 'Simulates each car’s remaining route, stop by stop, and gives the call to the one that gets there first.',
    reassign: false,
    hysteresis: 0,
    /** Predicted seconds until this car opens for the call, plus a 90 s penalty if it is full. */
    cost(sim, car, call) {
      // A full car would pass the call by, so its estimate is too hopeful. With the penalty,
      // any car that is not full and arrives less than 90 s later wins instead.
      return estimateArrival(car, call) + (car.isFull ? 90 : 0);
    },
  },
  nearest: {
    id: 'nearest',
    label: 'Nearest car',
    summary: 'Textbook figure-of-suitability rule: prefers a car already heading toward the call in the same direction.',
    reassign: true,
    hysteresis: 1,
    /**
     * Minus the figure of suitability (FS), so the most suitable car has the lowest cost.
     * With d = distance to the call in floors and n = floors - 1, FS is n + 2 - d for a
     * car heading toward the call in the call's direction, n + 1 - d for an idle car or
     * one heading toward it the other way, 1 for a car moving away, and 0 for a full car.
     */
    cost(sim, car, call) {
      // n is the largest possible distance, so n + 1 - d is never below 1, the score of a
      // car moving away.
      const n = car.cfg.floors - 1;
      const d = Math.abs(car.floatFloor - call.floor);
      let fs;
      // Full: least suitable of all.
      if (car.isFull) fs = 0;
      // Idle: the closer, the better.
      else if (car.direction === 0) fs = n + 1 - d;
      // Heading toward the call: one point more if it is also going the call's way.
      else if (car.direction * (call.floor - car.floatFloor) > 0) fs = car.direction === call.dir ? n + 2 - d : n + 1 - d;
      // Moving away: only better than a full car.
      else fs = 1;
      // Lower cost wins, so the most suitable car gets the most negative number.
      return -fs;
    },
  },
  roundRobin: {
    id: 'roundRobin',
    label: 'Round robin',
    summary: 'Hands calls to the cars in turn, ignoring where they are. A baseline to beat.',
    reassign: false,
    hysteresis: 0,
    /** The next car in turn, whatever its position or load. */
    choose(sim) {
      // The counter only grows; taking it modulo the number of cars cycles A, B, C, A, …
      return { car: sim.cars[sim.roundRobinNext++ % sim.cars.length], cost: 0 };
    },
  },
});

/**
 * Best car for a call. Ties go to the lower car id.
 * @param {Strategy} strategy
 * @param {Simulation} sim
 * @param {HallCall} call
 * @returns {Choice}
 */
export function chooseCar(strategy, sim, call) {
  // Strategies that pick a car directly (round robin) don't price anything.
  if (strategy.choose) return strategy.choose(sim, call);
  // Price every car. Only a strictly lower cost replaces the best so far, so on a tie the
  // earlier car (lower id) keeps the call. The first car is always taken, even at Infinity.
  let best = { car: null, cost: Infinity };
  for (const car of sim.cars) {
    const cost = strategy.cost(sim, car, call);
    if (best.car === null || cost < best.cost) best = { car, cost };
  }
  return best;
}
