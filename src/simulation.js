import { UP, DOWN, CarState, DEFAULT_CONFIG, KG_PER_PERSON, floorLabel, dirArrow } from './constants.js';
import { Elevator } from './elevator.js';
import { STRATEGIES, chooseCar, estimateArrival } from './dispatch.js';
import { TrafficGenerator } from './traffic.js';

/** @typedef {import('./constants.js').Direction} Direction */
/** @typedef {import('./constants.js').Config} Config */
/** @typedef {import('./elevator.js').Env} Env */
/** @typedef {import('./dispatch.js').Strategy} Strategy */
/** @typedef {import('./traffic.js').TrafficOptions} TrafficOptions */

/**
 * One person using the elevators. Times are simulated seconds since the start of the run.
 * @typedef {object} Passenger
 * @property {number} id 1, 2, 3, … in order of arrival
 * @property {number} origin floor index where they wait
 * @property {number} dest floor index they want to reach
 * @property {Direction} dir UP or DOWN, from origin to dest
 * @property {number} spawnTime when they arrived and pressed the hall button
 * @property {number | null} boardTime when they stepped into a car; null while waiting
 * @property {number | null} arriveTime when they stepped out at `dest`; null until then
 * @property {number | null} carId id of the car they boarded; null while waiting
 */

/**
 * A lit hall button: someone at `floor` wants to go `dir`, and one car is assigned to it.
 * @typedef {object} HallCall
 * @property {number} floor floor index
 * @property {Direction} dir UP or DOWN
 * @property {number} since when the button was lit, s
 * @property {number | null} carId id of the assigned car
 * @property {number} cost the strategy's cost for the assigned car (for ETA, predicted seconds)
 */

/**
 * One line of the controller log shown on the page.
 * @typedef {object} LogEvent
 * @property {number} t when it happened, s
 * @property {'assign' | 'reassign' | 'serve' | 'park'} kind
 * @property {string} text
 */

/**
 * Service figures returned by `stats()`. Averages and percentiles cover delivered
 * passengers only; times are in seconds.
 * @typedef {object} Stats
 * @property {number} time simulated time now
 * @property {number} spawned passengers who have arrived so far
 * @property {number} delivered passengers who have reached their floor
 * @property {number} waitingNow passengers waiting at a floor right now
 * @property {number} ridingNow passengers inside a car right now
 * @property {number} avgWait mean wait
 * @property {number} p95Wait 95th percentile wait
 * @property {number} maxWait longest wait
 * @property {number} longWaitShare share of waits over 60 s, from 0 to 1
 * @property {number} avgRide mean ride
 * @property {number} avgTrip mean trip
 * @property {number} p95Trip 95th percentile trip
 * @property {number} longestWaitNow how long the longest-waiting person still waiting has waited so far
 * @property {number} distance metres travelled by all cars together
 * @property {number} stops door cycles of all cars together
 */

/**
 * Options for `new Simulation(...)`. Every field is optional.
 * @typedef {object} SimulationOptions
 * @property {Partial<Config>} [config] overrides for `DEFAULT_CONFIG`
 * @property {string} [strategy='eta'] key of `STRATEGIES`
 * @property {Omit<TrafficOptions, 'floors'>} [traffic] arrival pattern, rate and seed
 * @property {number} [dt=0.05] fixed time step, s
 * @property {boolean} [log=true] keep a controller log in `events` (the bench turns it off for speed)
 */

/** How many recent controller log entries `events` keeps. */
const MAX_EVENTS = 200;

/**
 * Value at quantile `q` of an ascending array (nearest-rank method).
 * @param {number[]} sorted values in ascending order
 * @param {number} q from 0 to 1, e.g. 0.95
 * @returns {number} 0 for an empty array
 */
function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  // Nearest rank: the smallest value with at least a share q of the values at or below
  // it. The index is clamped so q = 0 and q = 1 stay inside the array.
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}

/**
 * Arithmetic mean.
 * @param {number[]} xs
 * @returns {number} 0 for an empty array
 */
function mean(xs) {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

/**
 * A building with a group of cars, the people waiting for them, and the group
 * controller that registers hall calls and hands them to cars.
 *
 * Fixed-step and deterministic: the same options and seed always produce the same run.
 */
export class Simulation {
  /**
   * @param {SimulationOptions} [options]
   */
  constructor({ config = {}, strategy = 'eta', traffic = {}, dt = 0.05, log = true } = {}) {
    // Settings: the defaults with any overrides on top. Every car shares this same object.
    /** @type {Config} */
    this.cfg = { ...DEFAULT_CONFIG, ...config };
    if (this.cfg.floors < 3) throw new RangeError('A building needs at least 3 floors');
    /** @type {number} length of one step, s */
    this.dt = dt;
    /** @type {number} simulated time, s */
    this.time = 0;
    /** @type {boolean} whether to keep the controller log in `events` */
    this.logging = log;
    this.setStrategy(strategy);
    /** @type {TrafficGenerator} where new passengers come from */
    this.traffic = new TrafficGenerator({ floors: this.cfg.floors, ...traffic });

    // Every car starts at the lobby, empty and idle.
    /** @type {Elevator[]} indexed by car id */
    this.cars = Array.from({ length: this.cfg.cars }, (_, i) => new Elevator(i, this.cfg, 0));
    /** @type {Passenger[][]} people waiting at each floor, oldest first: `waiting[floor]` */
    this.waiting = Array.from({ length: this.cfg.floors }, () => []);
    /** @type {Record<number, HallCall | null>[]} the building's hall buttons: `hallCalls[floor][dir]`, null when unlit */
    this.hallCalls = Array.from({ length: this.cfg.floors }, () => ({ [UP]: null, [DOWN]: null }));
    /** @type {Passenger[]} everyone who has reached their floor, in order of arrival */
    this.delivered = [];
    /** @type {number} passengers who have arrived so far */
    this.spawned = 0;
    /** @type {number} id for the next passenger */
    this.nextPassengerId = 1;
    /** @type {number} round-robin counter; the next call goes to car `roundRobinNext % cars.length` */
    this.roundRobinNext = 0;
    /** @type {number} time of the last `redispatch`, s */
    this.lastRedispatch = 0;
    /** @type {LogEvent[]} the controller log, newest last */
    this.events = [];

    // Hooks the cars call back into. See Elevator for the contract.
    /** @type {Env} */
    this.env = {
      // Lit means the button is on and the call is assigned to some car, not necessarily this one.
      hallCall: (f, d) => this.hallCalls[f][d] !== null,
      onServe: (car, f, d) => this.serveCall(car, f, d),
      transferOne: (car, f) => this.transferOne(car, f),
      // Reopen for someone waiting here who could board: there is room, and they are going
      // the car's way (or the car has no direction yet).
      wantsReopen: (car, f) => !car.isFull && this.waiting[f].some((p) => car.direction === 0 || p.dir === car.direction),
    };
  }

  /**
   * Switch the dispatch strategy. Calls already assigned stay where they are.
   * @param {string} id key of `STRATEGIES`: 'eta', 'nearest' or 'roundRobin'
   * @throws {RangeError} for an unknown id
   */
  setStrategy(id) {
    const s = STRATEGIES[id];
    if (!s) throw new RangeError(`Unknown strategy "${id}"`);
    /** @type {Strategy} */
    this.strategy = s;
  }

  // ---------------------------------------------------------------- main loop

  /**
   * Advance one fixed time step: add new arrivals, light or clear hall buttons,
   * re-evaluate calls once every `redispatchInterval` (and maybe send an idle car to
   * the lobby), then move every car.
   * @param {number} [dt=this.dt] seconds
   */
  step(dt = this.dt) {
    // 1. Everyone who arrives during this step joins the queue at their floor.
    for (const a of this.traffic.arrivalsUntil(this.time + dt)) this.spawn(a.origin, a.dest, a.time);
    // 2. Light buttons for new arrivals, clear buttons nobody is waiting at any more.
    this.syncHallCalls();
    // 3. Once a second (by default), reconsider unanswered calls and idle cars.
    if (this.time - this.lastRedispatch >= this.cfg.redispatchInterval) {
      this.redispatch();
      this.parkIdleCars();
      this.lastRedispatch = this.time;
    }
    // 4. Move every car: motion, doors and passengers.
    for (const car of this.cars) car.step(dt, this.env);
    this.time += dt;
  }

  /**
   * Advance by `seconds` of simulated time.
   * @param {number} seconds
   */
  advance(seconds) {
    // The tiny margin stops floating-point rounding in `time` from adding one extra step.
    const end = this.time + seconds - 1e-9;
    while (this.time < end) this.step();
  }

  // ---------------------------------------------------------------- passengers

  /**
   * Add a passenger waiting at `origin` to go to `dest`. Their hall button lights on the next step.
   * @param {number} origin floor index
   * @param {number} dest floor index, different from `origin`
   * @param {number} [time=this.time] when they arrived, s
   * @returns {Passenger}
   * @throws {RangeError} when either floor is out of range or they are the same
   */
  spawn(origin, dest, time = this.time) {
    const n = this.cfg.floors;
    // Both floors must be whole floor indices inside the building, and different.
    if (!Number.isInteger(origin) || !Number.isInteger(dest) || origin < 0 || dest < 0 || origin >= n || dest >= n || origin === dest) {
      throw new RangeError(`Invalid trip ${origin} → ${dest}`);
    }
    // Their direction follows from the trip; the three times are filled in as it happens.
    const p = {
      id: this.nextPassengerId++,
      origin,
      dest,
      dir: dest > origin ? UP : DOWN,
      spawnTime: time,
      boardTime: null,
      arriveTime: null,
      carId: null,
    };
    // Join the back of the queue at their floor.
    this.waiting[origin].push(p);
    this.spawned++;
    return p;
  }

  /**
   * One passenger leaves or boards. Alighting goes first; boarding is first come, first served.
   * Only people going the car's way board, or anyone if the car has no direction yet.
   * Called by the car (through `env`) while its doors are open.
   *
   * HINT, complaint 2 (overload with two aboard): the fix belongs in this function.
   * @param {Elevator} car
   * @param {number} f floor index the car is open at
   * @returns {boolean} true if someone moved; false when nobody is left to move
   */
  transferOne(car, f) {
    // Getting out: the first rider whose destination is this floor.
    const out = car.passengers.findIndex((p) => p.dest === f);
    if (out >= 0) {
      // They leave the car and count as delivered.
      const [p] = car.passengers.splice(out, 1);
      p.arriveTime = this.time;
      this.delivered.push(p);
      return true;
    }
    // Getting in: nobody else boards a full car.
    if (car.isFull) return false;
    // The longest-waiting person here going the car's way (anyone, if it has no direction).
    const queue = this.waiting[f];
    const i = queue.findIndex((p) => car.direction === 0 || p.dir === car.direction);
    if (i < 0) return false;
    // They leave the queue and step in.
    const [p] = queue.splice(i, 1);
    p.boardTime = this.time;
    p.carId = car.id;
    car.passengers.push(p);
    // The car's load reading goes up by one person.
    car.loadKg += KG_PER_PERSON;
    // They press their floor's button inside the car.
    car.carCalls.add(p.dest);
    if (car.direction === 0) {
      // A car that opened with no direction takes the first passenger's.
      car.direction = p.dir;
      car.hallCalls[p.dir].delete(f);
      this.serveCall(car, f, p.dir);
    }
    return true;
  }

  // ---------------------------------------------------------------- hall calls

  /** Light hall buttons for anyone waiting without one; clear buttons nobody is waiting at. */
  syncHallCalls() {
    for (let f = 0; f < this.cfg.floors; f++) {
      for (const d of [UP, DOWN]) {
        const call = this.hallCalls[f][d];
        const waiting = this.waiting[f].some((p) => p.dir === d);
        // Lit, but nobody here is going that way any more: turn it off.
        if (call && !waiting) this.dropCall(call);
        // Someone is waiting with the button off, and no car is already open here for
        // them: light it, which also assigns it to a car.
        else if (!call && waiting && !this.isBeingServed(f, d)) this.registerCall(f, d);
      }
    }
  }

  /**
   * Is a car already open at floor `f` that someone going `d` can board? If so, there is
   * no need to light the button.
   * @param {number} f floor index
   * @param {Direction} d UP or DOWN
   * @returns {boolean}
   */
  isBeingServed(f, d) {
    // Doors opening or open at f, going d or with no direction yet, and not full.
    return this.cars.some((c) =>
      (c.state === CarState.OPENING || c.state === CarState.OPEN) &&
      c.floor === f && (c.direction === d || c.direction === 0) && !c.isFull);
  }

  /**
   * Light the hall button for `d` at `f` and let the active strategy assign it to a car.
   * @param {number} f floor index
   * @param {Direction} d UP or DOWN
   */
  registerCall(f, d) {
    const call = { floor: f, dir: d, since: this.time, carId: null, cost: 0 };
    this.hallCalls[f][d] = call;
    // The strategy picks the car; `assign` records the choice on the call and on the car.
    const { car, cost } = chooseCar(this.strategy, this, call);
    this.assign(call, car, cost);
    if (this.logging) this.log('assign', `${dirArrow(d)} ${floorLabel(f)} → car ${car.name}${this.etaNote(car, call)}`);
  }

  /**
   * Give `call` to `car`, taking it off the car that had it before. Keeps the building's
   * record (`hallCalls`) and the cars' own lists (`car.hallCalls`) in step.
   * @param {HallCall} call
   * @param {Elevator} car
   * @param {number} cost the strategy's cost for this car
   */
  assign(call, car, cost) {
    // Off the previous car's list, if it had one, then onto the new car's.
    if (call.carId !== null) this.cars[call.carId].hallCalls[call.dir].delete(call.floor);
    call.carId = car.id;
    call.cost = cost;
    car.hallCalls[call.dir].add(call.floor);
  }

  /**
   * Turn a hall button off and take the call off its car's list.
   * @param {HallCall} call
   */
  dropCall(call) {
    // Off the car's list first, then off the building's.
    if (call.carId !== null) this.cars[call.carId].hallCalls[call.dir].delete(call.floor);
    this.hallCalls[call.floor][call.dir] = null;
  }

  /**
   * A car is opening at f for direction d: that hall call is answered, whoever it was assigned to.
   * @param {Elevator} car the car that is opening
   * @param {number} f floor index
   * @param {Direction} d UP or DOWN
   */
  serveCall(car, f, d) {
    const call = this.hallCalls[f][d];
    // The button isn't lit (nobody pressed it, or it was already answered): nothing to do.
    if (!call) return;
    this.dropCall(call);
    // Worth a log line only when a car answers a call that was assigned to another car.
    if (call.carId !== car.id) this.log('serve', `Car ${car.name} answers ${dirArrow(d)} ${floorLabel(f)} on the way`);
  }

  /**
   * Re-evaluate every unanswered call; move it if another car is now clearly better.
   * Only for strategies with `reassign` (Nearest car); ETA and round robin never move a call.
   */
  redispatch() {
    const s = this.strategy;
    for (let f = 0; f < this.cfg.floors; f++) {
      for (const d of [UP, DOWN]) {
        const call = this.hallCalls[f][d];
        // Skip unlit buttons, and every call when the strategy never reassigns.
        if (!call || !s.reassign) continue;
        // What keeping the call costs now, against the best car now.
        const current = this.cars[call.carId];
        const currentCost = s.cost(this, current, call);
        const best = chooseCar(s, this, call);
        call.cost = currentCost;
        // Move it if its car is full, or another car beats it by more than the hysteresis
        // margin (the margin stops calls bouncing between two cars with similar costs).
        if (best.car !== current && (current.isFull || best.cost < currentCost - s.hysteresis)) {
          this.assign(call, best.car, best.cost);
          if (this.logging) this.log('reassign', `${dirArrow(d)} ${floorLabel(f)} moved ${current.name} → ${best.car.name}${this.etaNote(best.car, call)}`);
        }
      }
    }
  }

  /**
   * Send one empty, idle car back to the lobby so the next arrivals find it there.
   * Does nothing if parking is off (`parkIdleAfter` is 0) or a car is at or heading to the lobby.
   */
  parkIdleCars() {
    if (!(this.cfg.parkIdleAfter > 0)) return;
    // The lobby is covered if a car is stopped there, is driving there, has it as a car
    // call, or holds the lobby's Up call.
    const covered = this.cars.some((c) =>
      (c.floor === 0 && c.state !== CarState.MOVING) || c.target === 0 || c.carCalls.has(0) || c.hallCalls[UP].has(0));
    if (covered) return;
    // Empty cars that have been idle long enough, the lowest (closest to the lobby) first.
    const candidates = this.cars
      .filter((c) => c.state === CarState.IDLE && c.load === 0 && c.idleTime >= this.cfg.parkIdleAfter)
      .sort((a, b) => a.floatFloor - b.floatFloor);
    if (candidates.length === 0) return;
    // A car call for the lobby sends it down like any other trip.
    candidates[0].carCalls.add(0);
    this.log('park', `Car ${candidates[0].name} returns to the lobby`);
  }

  // ---------------------------------------------------------------- reporting

  /**
   * Log suffix with the car's predicted arrival.
   * @param {Elevator} car
   * @param {HallCall} call
   * @returns {string} e.g. ', ETA 12 s', or '' when there is no estimate
   */
  etaNote(car, call) {
    if (!car) return '';
    // Infinity means the car's planned route never reaches the call.
    const eta = estimateArrival(car, call);
    return Number.isFinite(eta) ? `, ETA ${eta.toFixed(0)} s` : '';
  }

  /**
   * Add a line to the controller log (when logging is on), keeping the latest `MAX_EVENTS`.
   * @param {LogEvent['kind']} kind
   * @param {string} text
   */
  log(kind, text) {
    if (!this.logging) return;
    this.events.push({ t: this.time, kind, text });
    // Drop the oldest entry once the log is over its limit.
    if (this.events.length > MAX_EVENTS) this.events.shift();
  }

  /** @returns {number} people waiting at all floors */
  waitingCount() {
    return this.waiting.reduce((s, q) => s + q.length, 0);
  }

  /** @returns {number} people inside all cars */
  ridingCount() {
    return this.cars.reduce((s, c) => s + c.load, 0);
  }

  /**
   * Service figures so far. The page shows them in "Service since reset", and the bench prints them.
   *
   * HINT, complaint 3 (average wait equals average trip): the fix belongs in this function.
   * @returns {Stats}
   */
  stats() {
    const d = this.delivered;
    // One duration per delivered passenger. Waits and trips are sorted for the percentiles.
    const waits = d.map((p) => p.arriveTime - p.spawnTime).sort((a, b) => a - b);
    const rides = d.map((p) => p.arriveTime - p.boardTime);
    const trips = d.map((p) => p.arriveTime - p.spawnTime).sort((a, b) => a - b);
    // People still standing at a floor, timed from when they arrived until now.
    let longestWaitNow = 0;
    for (const q of this.waiting) for (const p of q) longestWaitNow = Math.max(longestWaitNow, this.time - p.spawnTime);
    return {
      time: this.time,
      spawned: this.spawned,
      delivered: d.length,
      waitingNow: this.waitingCount(),
      ridingNow: this.ridingCount(),
      avgWait: mean(waits),
      p95Wait: quantile(waits, 0.95),
      maxWait: waits.length ? waits[waits.length - 1] : 0,
      longWaitShare: waits.length ? waits.filter((w) => w > 60).length / waits.length : 0,
      avgRide: mean(rides),
      avgTrip: mean(trips),
      p95Trip: quantile(trips, 0.95),
      longestWaitNow,
      // Totals over all cars.
      distance: this.cars.reduce((s, c) => s + c.distance, 0),
      stops: this.cars.reduce((s, c) => s + c.stops, 0),
    };
  }
}

/**
 * Options for `runScenario`. Every field is optional.
 * @typedef {object} ScenarioOptions
 * @property {string} [strategy='eta'] key of `STRATEGIES`
 * @property {string} [pattern='uppeak'] key of `PATTERNS`
 * @property {number} [rate=20] arrivals per minute
 * @property {number} [seed=1] traffic seed
 * @property {number} [minutes=30] how long new passengers keep arriving
 * @property {number} [drainMinutes=30] extra time allowed for everyone to be delivered
 * @property {Partial<Config>} [config] overrides for `DEFAULT_CONFIG`
 */

/**
 * Headless run: arrivals for `minutes`, then no new arrivals until everyone has been
 * delivered (or `drainMinutes` pass), so slow strategies cannot hide stranded passengers.
 * @param {ScenarioOptions} [options]
 * @returns {Stats & { strategy: string, drained: boolean }} `drained` is false if anyone was still waiting or riding at the end
 */
export function runScenario({ strategy = 'eta', pattern = 'uppeak', rate = 20, seed = 1, minutes = 30, drainMinutes = 30, config = {} } = {}) {
  const sim = new Simulation({ strategy, config, traffic: { pattern, rate, seed }, log: false });
  // Busy period: passengers keep arriving.
  sim.advance(minutes * 60);
  // Drain: no new arrivals; stop as soon as everyone is delivered, or at the time limit.
  sim.traffic.setRate(0);
  const limit = sim.time + drainMinutes * 60;
  while ((sim.waitingCount() > 0 || sim.ridingCount() > 0) && sim.time < limit) sim.step();
  return { strategy, ...sim.stats(), drained: sim.waitingCount() + sim.ridingCount() === 0 };
}
