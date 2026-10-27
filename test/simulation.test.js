import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Simulation, runScenario, CarState, UP } from '../src/index.js';

/**
 * A simulation with no background traffic and no log, so a test controls every passenger.
 * @param {object} [opts] extra options for `new Simulation`
 * @returns {Simulation}
 */
const quiet = (opts = {}) => new Simulation({ traffic: { rate: 0 }, log: false, ...opts });
/**
 * Step `sim` until `cond()` is true, and fail the test if it isn't within `maxSeconds`.
 * @param {Simulation} sim
 * @param {() => boolean} cond
 * @param {number} [maxSeconds=600] simulated seconds
 */
function runUntil(sim, cond, maxSeconds = 600) {
  const end = sim.time + maxSeconds;
  while (!cond() && sim.time < end) sim.step();
  assert.ok(cond(), `condition not met within ${maxSeconds}s`);
}

test('car respects rated speed and acceleration and stops exactly at the floor', () => {
  const sim = quiet();
  sim.spawn(0, 11);
  let prevVel = 0;
  runUntil(sim, () => sim.delivered.length === 1, 120);
  // re-run tracking kinematics
  const s2 = quiet();
  const c2 = s2.cars[0];
  s2.spawn(0, 11);
  while (s2.delivered.length === 0) {
    s2.step();
    assert.ok(c2.speed <= s2.cfg.maxSpeed + 1e-9, 'over speed');
    const acc = Math.abs(c2.vel - prevVel) / s2.dt;
    if (c2.vel !== 0) assert.ok(acc <= s2.cfg.acceleration + 1e-6, `over acceleration ${acc}`);
    if (c2.state !== CarState.MOVING) assert.equal(c2.vel, 0);
    prevVel = c2.vel;
  }
  assert.equal(c2.pos, 11 * s2.cfg.floorHeight);
  const ride = sim.delivered[0].arriveTime - sim.delivered[0].boardTime;
  assert.ok(ride > 17 && ride < 30, `ride ${ride}`); // 38.5 m at 2.5 m/s ≈ 18 s plus doors
});

test('doors are closed whenever the car moves', () => {
  const sim = new Simulation({ traffic: { rate: 20, pattern: 'lunch', seed: 3 }, log: false });
  for (let i = 0; i < 20000; i++) {
    sim.step();
    for (const c of sim.cars) if (c.vel !== 0) assert.equal(c.door, 0);
  }
});

test('LOOK: car calls are served in sweep order, not request order', () => {
  const sim = quiet({ config: { cars: 1 } });
  const car = sim.cars[0];
  car.carCalls.add(8); car.carCalls.add(3); car.carCalls.add(5);
  const visits = [];
  runUntil(sim, () => {
    if (car.state === CarState.OPENING && visits.at(-1) !== car.floor) visits.push(car.floor);
    return car.carCalls.size === 0 && car.state === CarState.IDLE;
  });
  assert.deepEqual(visits, [3, 5, 8]);
});

test('a car going up does not pick up someone going down on the way', () => {
  const sim = quiet({ config: { cars: 1, parkIdleAfter: 0 } });
  const rider = sim.spawn(0, 9);
  runUntil(sim, () => rider.boardTime !== null);
  const down = sim.spawn(5, 1); // appears while the car is heading up
  runUntil(sim, () => rider.arriveTime !== null);
  assert.equal(down.boardTime === null || down.boardTime > rider.arriveTime, true);
  runUntil(sim, () => down.arriveTime !== null);
});

test('runs are deterministic for a given seed', () => {
  const a = runScenario({ strategy: 'eta', pattern: 'lunch', rate: 15, seed: 42, minutes: 10 });
  const b = runScenario({ strategy: 'eta', pattern: 'lunch', rate: 15, seed: 42, minutes: 10 });
  assert.deepEqual(a, b);
});

test('an idle car at the floor answers a hall call immediately', () => {
  const sim = quiet();
  const p = sim.spawn(0, 4);
  runUntil(sim, () => p.boardTime !== null, 30);
  assert.ok(p.boardTime - p.spawnTime < 5);
  assert.equal(p.dir, UP);
});
