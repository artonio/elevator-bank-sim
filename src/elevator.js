import { UP, DOWN, CarState } from './constants.js';

/** @typedef {import('./constants.js').Direction} Direction */
/** @typedef {import('./constants.js').CarStateName} CarStateName */
/** @typedef {import('./constants.js').Config} Config */
/** @typedef {import('./simulation.js').Passenger} Passenger */

/**
 * Hooks the simulation passes to each car on every step (`car.step(dt, env)`), so a car
 * can ask about the building without knowing about passengers or the other cars.
 * @typedef {object} Env
 * @property {(floor: number, dir: Direction) => boolean} hallCall
 *   Is the hall button for `dir` at `floor` lit (assigned to any car)?
 * @property {(car: Elevator, floor: number, dir: Direction) => void} onServe
 *   The car is opening at `floor` to answer the hall call for `dir`.
 * @property {(car: Elevator, floor: number) => boolean} transferOne
 *   Move one passenger out of or into the car; false when nobody is left to move.
 * @property {(car: Elevator, floor: number) => boolean} wantsReopen
 *   Someone arrived who could still board: should the closing doors reopen?
 */

/** Tolerance, in floors, when comparing a car position with a landing level. */
const FLOOR_TOL = 1e-3;

/**
 * One car: motion profile, doors, and its own stop sequence.
 *
 * Stop selection is the directional-collective rule (the LOOK disk-scheduling
 * algorithm): keep travelling in the current direction while there is work ahead,
 * stopping for car calls and same-direction hall calls. An opposite-direction hall
 * call is answered only at the far end of the sweep, where the car turns round.
 *
 * The car knows nothing about passengers or the other cars. The simulation passes an
 * `env` object with four hooks (see the `Env` type above):
 *   hallCall(floor, dir)       is that hall button lit (assigned to any car)?
 *   onServe(car, floor, dir)   the car is opening to answer that hall direction
 *   transferOne(car, floor)    move one passenger out or in; false when nobody is left
 *   wantsReopen(car, floor)    someone arrived who could still board: reopen the doors?
 *
 * Positions are in metres (`pos`, measured up from the lobby); floors are indices
 * (0 = lobby). Most planning methods take fractional floors so they can work from a
 * position between landings.
 */
export class Elevator {
  /**
   * @param {number} id index of the car in the bank; 0, 1, 2 are shown as A, B, C
   * @param {Config} cfg building settings shared with the simulation
   * @param {number} [startFloor=0] floor index the car starts at
   */
  constructor(id, cfg, startFloor = 0) {
    /** @type {number} index in `sim.cars`; hall calls record it as `carId`, and dispatch ties go to the lower id */
    this.id = id;
    /** @type {string} letter shown on the page and in the log: 'A' for id 0, 'B' for 1, … */
    this.name = String.fromCharCode(65 + id);
    /** @type {Config} building settings; the same object the simulation holds, not a copy */
    this.cfg = cfg;
    /** @type {number} position in metres above the lobby; exactly `floor * floorHeight` when stopped at a landing */
    this.pos = startFloor * cfg.floorHeight;
    /** @type {number} velocity in m/s, positive is up; 0 whenever the car is not MOVING */
    this.vel = 0;
    /**
     * Direction the car is serving: the way it is travelling, or about to travel from
     * this floor. Shown by the car's arrows on the page. 0 when it has nothing to do.
     * @type {Direction}
     */
    this.direction = 0;
    /** @type {CarStateName} what the car is doing now: idle, moving, opening, open or closing */
    this.state = CarState.IDLE;
    /** @type {number} how far open the doors are: 0 closed … 1 fully open; the car only moves at 0 */
    this.door = 0;
    /** @type {number} seconds of minimum open time left; set to `cfg.minDwell` when the doors finish opening */
    this.dwell = 0;
    /** @type {number} seconds left for the passenger in the doorway; each one takes `cfg.transferTime` */
    this.transfer = 0;
    /** @type {number | null} floor index the car is driving to while MOVING, re-planned every tick; null otherwise */
    this.target = null;
    /**
     * Seconds the car has been IDLE without a break; reset to 0 in any other state.
     * The simulation sends a car back to the lobby once this reaches `cfg.parkIdleAfter`.
     * @type {number}
     */
    this.idleTime = 0;
    /** @type {Passenger[]} riders in the car, in boarding order; `Simulation.transferOne` adds and removes them */
    this.passengers = [];
    /** @type {number} reading of the car's load-weighing device, kg; `Simulation.transferOne` updates it */
    this.loadKg = 0;
    /**
     * Floor indices pressed inside the car (and the lobby, when the car is sent to park).
     * A floor is removed when the car opens there.
     * @type {Set<number>}
     */
    this.carCalls = new Set();
    /**
     * Hall calls the dispatcher has assigned to this car, as floor indices per direction:
     * `hallCalls[UP]` and `hallCalls[DOWN]`. `Simulation.assign` adds a floor; it comes off
     * when the call moves to another car, when the button goes off (`dropCall`), or when
     * this car answers it.
     * @type {Record<number, Set<number>>}
     */
    this.hallCalls = { [UP]: new Set(), [DOWN]: new Set() };
    /** @type {number} total metres travelled; summed over all cars into `stats().distance` */
    this.distance = 0;
    /** @type {number} times the doors have opened from fully shut; summed into `stats().stops` */
    this.stops = 0;
  }

  // ---------------------------------------------------------------- read-outs

  /** @returns {number} position in floors, fractional between landings (2.5 = halfway between index 2 and 3) */
  get floatFloor() { return this.pos / this.cfg.floorHeight; }
  /** @returns {number} index of the nearest landing */
  get floor() { return Math.round(this.floatFloor); }
  /** @returns {number} number of passengers aboard */
  get load() { return this.passengers.length; }
  /** @returns {boolean} whether the car is full; a full car takes nobody else on and passes hall calls by */
  get isFull() { return this.passengers.length >= this.cfg.capacity; }
  /** @returns {boolean} whether the load reading is over the rated load; an overloaded car holds its doors open */
  get isOverloaded() { return this.loadKg > this.cfg.ratedLoad; }
  /** @returns {number} current speed in m/s, whichever way the car is moving */
  get speed() { return Math.abs(this.vel); }

  /**
   * Fractional floor where the car would come to rest if it braked now.
   * @returns {number}
   */
  get commitFloor() {
    const brake = (this.vel * this.vel) / (2 * this.cfg.acceleration);
    return (this.pos + Math.sign(this.vel) * brake) / this.cfg.floorHeight;
  }

  /**
   * Every floor this car currently intends to visit, ascending. Shown in the cars panel.
   * @returns {number[]} floor indices
   */
  get plannedStops() {
    const s = new Set(this.carCalls);
    for (const f of this.hallCalls[UP]) s.add(f);
    for (const f of this.hallCalls[DOWN]) s.add(f);
    return [...s].sort((a, b) => a - b);
  }

  // ---------------------------------------------------------------- planning

  /**
   * Floors with work for this car. A full car ignores hall calls (it bypasses them).
   * @returns {Generator<number>} floor indices; a floor may appear more than once
   */
  *requests() {
    yield* this.carCalls;
    if (!this.isFull) {
      yield* this.hallCalls[UP];
      yield* this.hallCalls[DOWN];
    }
  }

  /**
   * Is there any work strictly beyond `floor` in direction `dir`?
   * @param {number} floor fractional floor to look from
   * @param {Direction} dir UP or DOWN
   * @returns {boolean}
   */
  hasRequestsBeyond(floor, dir) {
    for (const g of this.requests()) if (dir * (g - floor) > FLOOR_TOL) return true;
    return false;
  }

  /**
   * The requested floor closest to `floor`; on a tie, the lower one.
   * @param {number} floor fractional floor to measure from
   * @param {number | null} [exclude=null] a floor index to ignore
   * @returns {number | null} floor index, or null when there is no other request
   */
  nearestRequest(floor, exclude = null) {
    let best = null;
    for (const g of this.requests()) {
      if (g === exclude) continue;
      const d = Math.abs(g - floor);
      if (best === null || d < Math.abs(best - floor) || (d === Math.abs(best - floor) && g < best)) best = g;
    }
    return best;
  }

  /**
   * Would the car stop at floor g while travelling in dir? Car calls always count; a full
   * car passes hall calls by; an opposite-direction hall call counts only where the sweep
   * ends (nothing further ahead).
   * @param {number} g floor index
   * @param {Direction} dir UP or DOWN
   * @returns {boolean}
   */
  wantsStopAt(g, dir) {
    if (this.carCalls.has(g)) return true;
    if (this.isFull) return false;
    if (this.hallCalls[dir].has(g)) return true;
    return this.hallCalls[-dir].has(g) && !this.hasRequestsBeyond(g, dir);
  }

  /**
   * Next floor to stop at travelling in dir from fractional floor `from`.
   * `inclusive` lets the floor exactly at `from` count (used for a moving car,
   * where `from` is the braking point).
   * @param {Direction} dir UP or DOWN
   * @param {number} from fractional floor
   * @param {boolean} inclusive
   * @returns {number | null} floor index, or null when there is nothing to stop for
   */
  nextStop(dir, from, inclusive) {
    const n = this.cfg.floors;
    let g = dir > 0
      ? (inclusive ? Math.ceil(from - FLOOR_TOL) : Math.floor(from + FLOOR_TOL) + 1)
      : (inclusive ? Math.floor(from + FLOOR_TOL) : Math.ceil(from - FLOOR_TOL) - 1);
    for (; g >= 0 && g < n; g += dir) if (this.wantsStopAt(g, dir)) return g;
    return null;
  }

  /**
   * Direction the car should serve when standing at floor f. Its own commitments
   * come first; with none, it takes whichever hall call is waiting here.
   * @param {number} f floor index the car is standing at
   * @param {Env} env
   * @returns {Direction} 0 when there is nothing to do
   */
  chooseDirectionAt(f, env) {
    const own = (d) => !this.isFull && this.hallCalls[d].has(f);
    const beyond = (d) => this.hasRequestsBeyond(f, d);
    const d0 = this.direction;
    if (d0 !== 0) {
      if (beyond(d0) || own(d0)) return d0;
      if (beyond(-d0) || own(-d0)) return -d0;
    } else {
      if (own(UP) && own(DOWN)) return beyond(DOWN) && !beyond(UP) ? DOWN : UP;
      if (own(UP)) return UP;
      if (own(DOWN)) return DOWN;
      const g = this.nearestRequest(f, f);
      if (g !== null) return g > f ? UP : DOWN;
    }
    if (env.hallCall(f, UP)) return UP;
    if (env.hallCall(f, DOWN)) return DOWN;
    return 0;
  }

  /**
   * Should a car standing at floor `f` with its doors shut open them now, given the
   * direction it has chosen to serve from here?
   *
   * HINT, complaint 1 (doors keep opening and closing): the fix belongs in this function.
   * @param {number} f floor index the car is standing at
   * @param {Direction} dir direction from `chooseDirectionAt`; 0 if it has none
   * @param {Env} env
   * @returns {boolean}
   */
  shouldOpenAt(f, dir, env) {
    // Someone inside asked for this floor: open, whatever the direction.
    if (this.carCalls.has(f)) return true;
    // A full car takes nobody else on, so it opens only for riders getting out (checked above).
    // dir is 0 when chooseDirectionAt found nothing to do from here.
    if (this.isFull || dir === 0) return false;
    // Open if any of these holds: this car is assigned the `dir` hall call at f; the `dir`
    // button at f is lit, whichever car it is assigned to; the button at f for the
    // opposite direction (-dir) is lit.
    return this.hallCalls[dir].has(f) || env.hallCall(f, dir) || env.hallCall(f, -dir);
  }

  /**
   * Called whenever the car is stationary at a floor with doors closed: after it
   * arrives, after the doors shut, and on every tick while idle. Either opens the
   * doors here, sets off toward the next stop, or goes idle.
   * @param {Env} env
   */
  decideNext(env) {
    const f = this.floor;
    const dir = this.chooseDirectionAt(f, env);
    if (this.shouldOpenAt(f, dir, env)) {
      this.direction = dir;
      this.beginOpening(env, f);
      return;
    }
    if (dir === 0 || !this.hasRequestsBeyond(f, dir)) {
      this.direction = 0;
      this.target = null;
      this.state = CarState.IDLE;
      return;
    }
    this.direction = dir;
    this.target = this.nextStop(dir, f, false);
    this.state = CarState.MOVING;
  }

  /**
   * Start opening the doors at floor `f`. Clears the car call for this floor and, when
   * the car has a direction, takes this floor's hall call for that direction off its
   * list and tells the simulation it is answering it.
   * @param {Env} env
   * @param {number} f floor index
   */
  beginOpening(env, f) {
    if (this.door <= 0) this.stops++;
    this.state = CarState.OPENING;
    this.target = null;
    this.carCalls.delete(f);
    if (this.direction !== 0) {
      this.hallCalls[this.direction].delete(f);
      env.onServe(this, f, this.direction);
    }
  }

  // ---------------------------------------------------------------- stepping

  /**
   * Advance this car by one time step. The simulation calls it once per tick for each car.
   * @param {number} dt seconds
   * @param {Env} env
   */
  step(dt, env) {
    switch (this.state) {
      case CarState.IDLE: this.idleTime += dt; this.decideNext(env); break;
      case CarState.MOVING: this.stepMoving(dt, env); break;
      case CarState.OPENING: this.stepOpening(dt); break;
      case CarState.OPEN: this.stepOpen(dt, env); break;
      case CarState.CLOSING: this.stepClosing(dt, env); break;
    }
    if (this.state !== CarState.IDLE) this.idleTime = 0;
  }

  /**
   * MOVING: re-plan the stop ahead, drive toward it, and decide what to do on arrival.
   * @param {number} dt seconds
   * @param {Env} env
   */
  stepMoving(dt, env) {
    const { floorHeight: H, maxSpeed: vmax, acceleration: a, floors } = this.cfg;
    const dir = this.direction;

    // Re-plan every tick: a new request ahead of the braking point can still be taken.
    const plan = this.nextStop(dir, this.commitFloor, true);
    const wanted = this.target !== null && this.wantsStopAt(this.target, dir);
    if (plan !== null && (!wanted || dir * (plan - this.target) < 0)) {
      this.target = plan;
    } else if (plan === null && !wanted) {
      // Nothing left ahead (a call was reassigned away): stop at the first reachable floor.
      const ahead = this.target !== null && dir * (this.target - this.floatFloor) > -FLOOR_TOL;
      if (!ahead) {
        const c = this.commitFloor;
        const g = dir > 0 ? Math.ceil(c - FLOOR_TOL) : Math.floor(c + FLOOR_TOL);
        this.target = Math.max(0, Math.min(floors - 1, g));
      }
    }

    if (this.drive(this.target * H, dt, vmax, a)) {
      this.target = null;
      this.decideNext(env);
    }
  }

  /**
   * Trapezoidal motion profile toward `goal` (m): accelerate, cruise, brake to stop exactly. True on arrival.
   * @param {number} goal target position in metres
   * @param {number} dt seconds
   * @param {number} vmax top speed, m/s
   * @param {number} a acceleration and braking, m/s²
   * @returns {boolean} true once the car is stopped at `goal`
   */
  drive(goal, dt, vmax, a) {
    const d = goal - this.pos;
    const s = Math.sign(d);
    const vWanted = s * Math.min(vmax, Math.sqrt(2 * a * Math.abs(d)));
    this.vel += Math.max(-a * dt, Math.min(a * dt, vWanted - this.vel));
    const prev = this.pos;
    this.pos += this.vel * dt;
    if (s === 0 || Math.sign(goal - this.pos) !== s || Math.abs(goal - this.pos) < 1e-4) {
      this.distance += Math.abs(goal - prev);
      this.pos = goal;
      this.vel = 0;
      return true;
    }
    this.distance += Math.abs(this.pos - prev);
    return false;
  }

  /**
   * OPENING: open the doors a little more; once fully open, start the minimum dwell.
   * @param {number} dt seconds
   */
  stepOpening(dt) {
    this.door = Math.min(1, this.door + dt / this.cfg.doorOpenTime);
    if (this.door >= 1) {
      this.state = CarState.OPEN;
      this.dwell = this.cfg.minDwell;
      this.transfer = 0;
    }
  }

  /**
   * OPEN: move passengers one at a time (each takes `transferTime`), then start closing
   * once nobody is in the doorway, the minimum dwell is over and the car is not overloaded.
   * @param {number} dt seconds
   * @param {Env} env
   */
  stepOpen(dt, env) {
    if (this.transfer > 0) this.transfer -= dt;
    if (this.transfer <= 0) {
      if (env.transferOne(this, this.floor)) this.transfer += this.cfg.transferTime;
      else this.transfer = 0;
    }
    this.dwell -= dt;
    if (this.transfer <= 0 && this.dwell <= 0 && !this.isOverloaded) this.state = CarState.CLOSING;
  }

  /**
   * CLOSING: reopen if someone who could board has arrived; otherwise close a little
   * more, and once the doors are shut decide what to do next.
   * @param {number} dt seconds
   * @param {Env} env
   */
  stepClosing(dt, env) {
    const f = this.floor;
    if (env.wantsReopen(this, f)) {
      this.beginOpening(env, f);
      return;
    }
    this.door = Math.max(0, this.door - dt / this.cfg.doorCloseTime);
    if (this.door <= 0) this.decideNext(env);
  }

  /**
   * Cheap copy that only carries what the planner reads. Used by the ETA dispatcher.
   * Only the planning methods (`requests` to `chooseDirectionAt`) work on the copy.
   * @returns {Elevator} a stationary, empty copy with the same position, direction and calls
   */
  planningCopy() {
    const g = Object.create(Elevator.prototype);
    g.cfg = this.cfg;
    g.pos = this.pos;
    g.vel = 0;
    g.direction = this.direction;
    g.carCalls = new Set(this.carCalls);
    g.hallCalls = { [UP]: new Set(this.hallCalls[UP]), [DOWN]: new Set(this.hallCalls[DOWN]) };
    g.passengers = []; // capacity is priced separately by the dispatcher
    return g;
  }
}
