# Elevator Bank Simulator

Three elevators serving a 12-floor building (both configurable), with a group
controller that decides which car answers each hall call. The engine is plain ES
modules with no rendering code and no dependencies. The browser view and the CLI
benchmark both drive the same engine.

## Run it

```bash
open dist/elevator-bank.html   # the visual simulation, self-contained, works from disk
npm run dev                    # the same page served from src/ and web/, reloads when you save
npm test                       # node:test suite (Node 20+)
npm run bench -- --pattern lunch --rate 14
npm run build                  # rebuild dist/ after editing src/ or web/
```

In the page: press a hall button to add a passenger, change the dispatch strategy
live, change the traffic pattern and arrival rate, or add a specific trip. The
tenant complaints panel stages each reported problem as a short scene in a fresh
building with no background traffic.

## Layout

```
src/
  constants.js   directions, car states, physical defaults (3.5 m floors, 2.5 m/s, 1 m/s², 13 persons, 1000 kg)
  elevator.js    one car: motion profile, door cycle, its own stop planning
  dispatch.js    group control: ETA, nearest car, round robin
  traffic.js     seeded Poisson arrivals: up-peak, down-peak, lunch, interfloor
  simulation.js  building, waiting passengers, hall-call registry, stats, runScenario()
web/             index.html + styles.css + app.js (DOM view, reads engine state each frame)
scripts/         build.mjs (zero-dep bundler to one HTML file), bench.mjs, dev.mjs (dev server with reload)
test/            invariants and behaviour tests
```

## Model

**Time.** Fixed 50 ms step, fully deterministic for a given seed, so strategies
can be compared on identical passenger streams.

**Car (`Elevator`).** Motion is a trapezoidal profile: accelerate at *a*, cruise at *v*max, and brake so
the car stops exactly at the target. Every tick the car re-plans from its braking
point, so a request ahead of where it could still stop gets picked up and one it has
already passed does not. Doors take 1.8 s to open and 2.4 s to close, stay open at
least 2 s, and each passenger takes 1.2 s to get through. The doors reopen if
someone who could board arrives while they are closing. Each car weighs its load
(75 kg a person); while the reading is over the 1000 kg rated load, the doors stay
open and the car won't leave.

**Stop selection (per car).** Each car plans its own stops; see `src/elevator.js`.

**Group control (`Simulation` + `dispatch.js`).** A hall button lights when
someone is waiting and no suitable car is open at that floor. The active strategy
assigns the call to one car. Any car that opens at that floor in that direction
answers the call, whichever car it was assigned to. Passengers left behind by a
full car press the button again.

| Strategy | Rule |
|---|---|
| ETA | Walks each car's remaining route stop by stop (travel time plus a door cycle per stop) and picks the earliest arrival. A full car gets a penalty. |
| Nearest car | Figure of suitability: a car moving toward the call in the same direction scores highest, an idle car next, a car moving away lowest. Re-evaluated every second with hysteresis. |
| Round robin | Calls go to cars in turn, ignoring their state. A baseline. |

Optional parking: an empty car idle for 20 s returns to the lobby when no other car
is there.

## Sample results

`npm run bench`, morning up-peak, 14 passengers/min for 30 min, then drained:

| Strategy | Avg wait | P95 wait | Avg trip |
|---|---|---|---|
| ETA | 16.0 s | 45.4 s | 60.3 s |
| Nearest car | 22.0 s | 60.3 s | 66.4 s |
| Round robin | 61.6 s | 161.7 s | 109.8 s |

ETA wins clearly in up-peak. In down-peak and interfloor traffic, nearest car is
level with it or slightly ahead on average wait. The ETA model ignores calls that
arrive after an assignment, and those calls add stops to the chosen car. Ways to
close the gap: weight the cost by delay to people already committed to the car,
project the car's load, and reallocate calls carefully (naive reallocation makes
calls bounce between cars and increases worst-case waits).

## Tests

`npm test` (6 tests, all passing) covers rated speed and acceleration, doors
closed whenever the car moves, the order a car visits floors, who may board,
determinism, and an idle car answering at its floor.
