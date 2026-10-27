import { Simulation } from '../src/simulation.js';
import { UP, DOWN, CarState, DEFAULT_CONFIG, floorLabel, dirArrow } from '../src/constants.js';
import { STRATEGIES } from '../src/dispatch.js';
import { PATTERNS } from '../src/traffic.js';

/**
 * What the controls are set to. A reset or a scene builds a new simulation from these.
 * @typedef {object} Settings
 * @property {string} strategy key of `STRATEGIES`
 * @property {string} pattern key of `PATTERNS`
 * @property {number} rate arrivals per minute; 0 means manual only
 * @property {number} floors
 * @property {number} seed traffic seed
 * @property {boolean} park return an idle car to the lobby
 * @property {number} speed simulated seconds per real second: 1, 3, 10 or 30
 */

/**
 * A staged tenant complaint, one button in the Tenant complaints panel.
 * @typedef {object} Scene
 * @property {string} label button title
 * @property {string} summary what happens in the scene, shown under the title
 * @property {(s: Simulation) => void} setup stages the scene in a freshly reset simulation
 */

/**
 * DOM elements for one car in the shafts, plus what was last drawn, so unchanged parts
 * are not redrawn every frame.
 * @typedef {object} CarView
 * @property {HTMLElement} ind indicator above the shaft (car letter, arrow, floor)
 * @property {HTMLElement} arrow
 * @property {HTMLElement} num
 * @property {HTMLElement} el the car itself
 * @property {HTMLElement} riders one dot per passenger
 * @property {HTMLElement} doorL
 * @property {HTMLElement} doorR
 * @property {HTMLElement} loadbar
 * @property {HTMLElement} lantern direction arrow inside the car
 * @property {number} load last drawn
 * @property {number | null} dir last drawn
 * @property {string} floorText last drawn
 * @property {boolean} overload last drawn
 */

/**
 * DOM elements for one floor row.
 * @typedef {object} FloorView
 * @property {Record<number, { el: HTMLElement, tag: HTMLElement, lit: boolean, name: string }>} buttons hall buttons by direction; `tag` shows the assigned car's letter
 * @property {HTMLElement} waiting the ▲▼ marks for people waiting
 * @property {string} sig summary of the last drawn queue, to skip redraws
 */

/**
 * DOM elements for one row of the cars panel.
 * @typedef {object} RowView
 * @property {HTMLElement} row
 * @property {HTMLElement} pos
 * @property {HTMLElement} state
 * @property {HTMLElement} meter
 * @property {HTMLElement} loadText
 */

/**
 * Everything drawn for the current simulation; rebuilt on every reset.
 * @typedef {object} View
 * @property {number} rowH height of one floor row, px
 * @property {FloorView[]} floors by floor index
 * @property {CarView[]} cars by car id
 * @property {RowView[]} [rows] by car id
 */

/**
 * @param {string} id
 * @returns {HTMLElement} the element with that id (the page always has it)
 */
const byId = (id) => document.getElementById(id);
/** @type {Settings} */
const settings = { strategy: 'eta', pattern: 'uppeak', rate: 12, floors: 12, seed: 7, park: true, speed: 3 };
/**
 * Status text for each car state. A moving car shows its speed instead.
 * @type {Record<string, string>}
 */
const STATE_TEXT = {
  [CarState.IDLE]: 'Idle',
  [CarState.OPENING]: 'Doors opening',
  [CarState.OPEN]: 'Doors open',
  [CarState.CLOSING]: 'Doors closing',
};

/**
 * Tenant complaints, each staged as a short scene in a fresh building with no background traffic.
 * @type {Scene[]}
 */
const SCENES = [
  {
    label: '1 · Floor 7 doors',
    summary: 'Car A waits at 7. Two people arrive there: one going to 10, one going to 2.',
    setup(s) {
      // Car A starts at floor index 6 (labelled 7); B and C stay at the lobby.
      s.cars[0].pos = 6 * s.cfg.floorHeight;
      s.spawn(6, 9);
      s.spawn(6, 1);
    },
  },
  {
    label: '2 · Overload with two aboard',
    summary: 'Car A waits at 5, B and C at 12. Twelve people at 5 go down to L, where two people are waiting to go up.',
    setup(s) {
      // Car A starts at floor index 4 (labelled 5); B and C start at the top, index 11.
      s.cars[0].pos = 4 * s.cfg.floorHeight;
      s.cars[1].pos = 11 * s.cfg.floorHeight;
      s.cars[2].pos = 11 * s.cfg.floorHeight;
      for (let i = 0; i < 12; i++) s.spawn(4, 0);
      s.spawn(0, 7);
      s.spawn(0, 9);
    },
  },
  {
    label: '3 · Wait equals trip',
    summary: 'One person rides from L to 12. A car is already waiting at L.',
    setup(s) {
      s.spawn(0, 11);
    },
  },
];

/** @type {Simulation} the simulation on screen; replaced on every reset */
let sim;
/** @type {View} */
let view;
/** Whether the simulation clock is running (false while paused). */
let running = true;

/**
 * Create an element.
 * @param {string} tag e.g. 'div'
 * @param {string} [className]
 * @param {string} [html] inner HTML
 * @returns {HTMLElement}
 */
function makeEl(tag, className, html) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (html !== undefined) el.innerHTML = html;
  return el;
}

/**
 * @param {number} t seconds
 * @returns {string} 'hh:mm:ss'
 */
function formatClock(t) {
  const s = Math.floor(t);
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((v) => String(v).padStart(2, '0')).join(':');
}

/**
 * Seconds with one decimal, as HTML for a stats tile.
 * @param {number} v seconds
 * @returns {string}
 */
function secs(v) {
  return `${v.toFixed(1)}<small>s</small>`;
}

// ------------------------------------------------------------------ setup

/** Build a fresh simulation from `settings`, then rebuild everything drawn for it. */
function newSimulation() {
  sim = new Simulation({
    strategy: settings.strategy,
    config: { floors: settings.floors, parkIdleAfter: settings.park ? DEFAULT_CONFIG.parkIdleAfter : 0 },
    traffic: { pattern: settings.pattern, rate: settings.rate, seed: settings.seed },
  });
  sim.advance(120); // warm up so the first frame shows a building already in service
  buildBuilding();
  buildCarRows();
  fillTripSelects();
  byId('subtitle').textContent = `${sim.cars.length} cars · ${sim.cfg.floors} floors · ${sim.cfg.maxSpeed} m/s · group control`;
  renderSlow();
}

/**
 * Reset into a staged complaint: a fresh 12-floor building with ETA dispatch and no
 * background traffic, then the scene's own setup. Un-pauses if needed.
 * @param {Scene} scene
 */
function playScene(scene) {
  Object.assign(settings, { strategy: 'eta', rate: 0, floors: 12 });
  syncStrategyButtons();
  syncRate();
  byId('floors').value = String(settings.floors);
  newSimulation();
  scene.setup(sim);
  setRunning(true);
  renderFrame();
  renderSlow();
}

/**
 * Draw the building for the current simulation: floor labels, hall buttons and waiting
 * marks on the left, one shaft per car with its indicator above. Fills `view`.
 */
function buildBuilding() {
  const n = sim.cfg.floors;
  const el = byId('building');
  el.innerHTML = '';
  const rowH = Math.max(26, Math.min(44, Math.floor(520 / n)));
  el.style.setProperty('--row-h', `${rowH}px`);
  el.style.setProperty('--cars', sim.cars.length);
  el.style.gridTemplateRows = `auto repeat(${n}, ${rowH}px)`;
  view = { rowH, floors: [], cars: [] };

  sim.cars.forEach((car, i) => {
    const ind = makeEl('div', 'indicator', `<span class="letter">${car.name}</span><span class="arrow"></span><span class="num"></span>`);
    ind.style.gridColumn = String(4 + i);
    el.append(ind);
    view.cars[i] = { ind, arrow: ind.querySelector('.arrow'), num: ind.querySelector('.num') };
  });

  for (let f = n - 1; f >= 0; f--) {
    const row = String(n - f + 1);
    const label = makeEl('div', `floor-label${f === 0 ? ' lobby' : ''}`, floorLabel(f));
    const hall = makeEl('div', 'hall');
    const waiting = makeEl('div', 'waiting');
    for (const cell of [label, hall, waiting]) cell.style.gridRow = row;
    label.style.gridColumn = '1';
    hall.style.gridColumn = '2';
    waiting.style.gridColumn = '3';
    const buttons = {};
    for (const dir of [UP, DOWN]) {
      const exists = dir === UP ? f < n - 1 : f > 0;
      const b = makeEl('button', `hall-btn${exists ? '' : ' none'}`, `<span class="dot">${dirArrow(dir)}</span><span class="tag"></span>`);
      b.type = 'button';
      b.dataset.floor = String(f);
      b.dataset.dir = String(dir);
      b.setAttribute('aria-label', `Call ${dir === UP ? 'up' : 'down'} at floor ${floorLabel(f)}`);
      if (!exists) b.tabIndex = -1;
      hall.append(b);
      buttons[dir] = { el: b, tag: b.querySelector('.tag'), lit: false, name: '' };
    }
    el.append(label, hall, waiting);
    view.floors[f] = { buttons, waiting, sig: '' };
  }

  sim.cars.forEach((car, i) => {
    const shaft = makeEl('div', 'shaft');
    shaft.style.gridColumn = String(4 + i);
    shaft.style.gridRow = `2 / ${n + 2}`;
    const carEl = makeEl('div', 'car',
      '<div class="riders"></div><div class="door l"></div><div class="door r"></div><div class="loadbar"></div><span class="lantern"></span>');
    shaft.append(carEl);
    el.append(shaft);
    Object.assign(view.cars[i], {
      el: carEl,
      riders: carEl.querySelector('.riders'),
      doorL: carEl.querySelector('.door.l'),
      doorR: carEl.querySelector('.door.r'),
      loadbar: carEl.querySelector('.loadbar'),
      lantern: carEl.querySelector('.lantern'),
      load: -1, dir: null, floorText: '', overload: false,
    });
  });
}

/** Build one row per car in the cars panel (`view.rows`). */
function buildCarRows() {
  const box = byId('carStatus');
  box.innerHTML = '';
  view.rows = sim.cars.map((car) => {
    const row = makeEl('div', 'car-row', `
      <span class="badge">${car.name}</span>
      <span class="pos"></span>
      <span class="state"></span>
      <div class="load"><div class="meter"><span></span></div><span class="load-text"></span></div>`);
    box.append(row);
    return {
      row,
      pos: row.querySelector('.pos'),
      state: row.querySelector('.state'),
      meter: row.querySelector('.meter span'),
      loadText: row.querySelector('.load-text'),
    };
  });
}

/** Fill the Add trip lists with the building's floors. */
function fillTripSelects() {
  const opts = Array.from({ length: sim.cfg.floors }, (_, f) => `<option value="${f}">${floorLabel(f)}</option>`).join('');
  byId('tripFrom').innerHTML = opts;
  byId('tripTo').innerHTML = opts;
  byId('tripTo').value = String(sim.cfg.floors - 1);
}

/** Wire up every control on the page. Called once at start-up. */
function buildControls() {
  const scenes = byId('scenes');
  for (const s of SCENES) {
    const b = makeEl('button', 'scene', `<strong>${s.label}</strong><span>${s.summary}</span>`);
    b.type = 'button';
    b.addEventListener('click', () => playScene(s));
    scenes.append(b);
  }

  const strat = byId('strategies');
  for (const s of Object.values(STRATEGIES)) {
    const b = makeEl('button', 'strategy', `<strong>${s.label}</strong><span>${s.summary}</span>`);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.id = s.id;
    b.addEventListener('click', () => {
      settings.strategy = s.id;
      sim.setStrategy(s.id);
      syncStrategyButtons();
    });
    strat.append(b);
  }
  syncStrategyButtons();

  const pattern = byId('pattern');
  pattern.innerHTML = Object.values(PATTERNS).map((p) => `<option value="${p.id}">${p.label}</option>`).join('');
  pattern.value = settings.pattern;
  pattern.addEventListener('change', () => {
    settings.pattern = pattern.value;
    sim.traffic.setPattern(pattern.value);
  });

  const rate = byId('rate');
  syncRate();
  rate.addEventListener('input', () => {
    settings.rate = Number(rate.value);
    sim.traffic.setRate(settings.rate);
    syncRate();
  });

  // Floors and seed take effect on Reset; parking takes effect at once.
  byId('floors').value = String(settings.floors);
  byId('seed').value = String(settings.seed);
  const park = byId('park');
  park.checked = settings.park;
  park.addEventListener('change', () => {
    settings.park = park.checked;
    sim.cfg.parkIdleAfter = park.checked ? DEFAULT_CONFIG.parkIdleAfter : 0;
  });

  byId('resetBtn').addEventListener('click', () => {
    settings.floors = Math.max(4, Math.min(20, Math.round(Number(byId('floors').value) || 12)));
    settings.seed = Math.max(1, Math.round(Number(byId('seed').value) || 1));
    byId('floors').value = String(settings.floors);
    byId('seed').value = String(settings.seed);
    newSimulation();
  });

  byId('tripBtn').addEventListener('click', () => {
    const from = Number(byId('tripFrom').value);
    const to = Number(byId('tripTo').value);
    if (from !== to) sim.spawn(from, to);
  });

  // A hall button adds one passenger at that floor, going to a random floor in that direction.
  byId('building').addEventListener('click', (e) => {
    const b = e.target.closest('.hall-btn');
    if (!b || b.classList.contains('none')) return;
    const f = Number(b.dataset.floor);
    const dir = Number(b.dataset.dir);
    const n = sim.cfg.floors;
    const lo = dir === UP ? f + 1 : 0;
    const hi = dir === UP ? n - 1 : f - 1;
    sim.spawn(f, lo + Math.floor(Math.random() * (hi - lo + 1)));
  });

  const speed = byId('speedSeg');
  speed.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-speed]');
    if (!b) return;
    settings.speed = Number(b.dataset.speed);
    syncSpeedButtons();
  });
  syncSpeedButtons();

  // Play/Pause button, or the space bar when no control has focus.
  const toggle = () => setRunning(!running);
  byId('playBtn').addEventListener('click', toggle);
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !e.target.closest('input, select, button, textarea')) {
      e.preventDefault();
      toggle();
    }
  });
}

/** Mark the selected strategy's button. */
function syncStrategyButtons() {
  for (const b of byId('strategies').children) b.setAttribute('aria-checked', String(b.dataset.id === settings.strategy));
}

/** Mark the selected speed button. */
function syncSpeedButtons() {
  for (const b of byId('speedSeg').children) b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === settings.speed));
}

/** Show `settings.rate` on the Arrivals slider and its label. */
function syncRate() {
  byId('rate').value = String(settings.rate);
  byId('rateOut').textContent = settings.rate ? `${settings.rate} per min` : 'Manual only';
}

/**
 * Run or pause the simulation clock, and update the Play/Pause button to match.
 * @param {boolean} on
 */
function setRunning(on) {
  running = on;
  const play = byId('playBtn');
  play.textContent = running ? 'Pause' : 'Play';
  play.setAttribute('aria-pressed', String(running));
}

// ------------------------------------------------------------------ rendering

/**
 * Every animation frame: move the cars and their doors, update the indicators, hall
 * buttons and waiting marks. Skips DOM writes for anything unchanged since last frame.
 */
function renderFrame() {
  const n = sim.cfg.floors;
  const H = sim.cfg.floorHeight;
  const cap = sim.cfg.capacity;

  sim.cars.forEach((car, i) => {
    const v = view.cars[i];
    v.el.style.transform = `translateY(${(n - 1 - car.pos / H) * view.rowH + 2}px)`;
    v.doorL.style.transform = `scaleX(${1 - car.door})`;
    v.doorR.style.transform = `scaleX(${1 - car.door})`;
    if (v.load !== car.load) {
      v.load = car.load;
      v.riders.innerHTML = '<b></b>'.repeat(car.load);
      v.loadbar.style.width = `${(100 * car.load) / cap}%`;
    }
    if (v.dir !== car.direction) {
      v.dir = car.direction;
      v.lantern.textContent = dirArrow(car.direction);
      v.lantern.className = `lantern ${car.direction === UP ? 'up' : car.direction === DOWN ? 'down' : ''}`;
      v.arrow.textContent = dirArrow(car.direction);
    }
    const ft = floorLabel(car.floor);
    if (v.floorText !== ft) { v.floorText = ft; v.num.textContent = ft; }
    if (v.overload !== car.isOverloaded) { v.overload = car.isOverloaded; v.el.classList.toggle('overload', v.overload); }
  });

  for (let f = 0; f < n; f++) {
    const fv = view.floors[f];
    for (const dir of [UP, DOWN]) {
      const call = sim.hallCalls[f][dir];
      const bv = fv.buttons[dir];
      const lit = call !== null;
      const name = lit ? sim.cars[call.carId].name : '';
      if (bv.lit !== lit) { bv.lit = lit; bv.el.classList.toggle('lit', lit); }
      if (bv.name !== name) { bv.name = name; bv.tag.textContent = name; }
    }
    // Waiting marks turn amber after 30 s and red after 60 s.
    const q = sim.waiting[f];
    const shown = q.slice(0, 14);
    let sig = String(q.length);
    let html = '';
    for (const p of shown) {
      const w = sim.time - p.spawnTime;
      const heat = w > 60 ? 'hot' : w > 30 ? 'warm' : '';
      sig += p.dir + heat;
      html += `<i class="${heat}">${dirArrow(p.dir)}</i>`;
    }
    if (q.length > shown.length) html += `<span class="more">+${q.length - shown.length}</span>`;
    if (sig !== fv.sig) { fv.sig = sig; fv.waiting.innerHTML = html; }
  }
}

/** Four times a second: the clock, the stats tiles, the cars panel and the controller log. */
function renderSlow() {
  const s = sim.stats();
  byId('clock').textContent = formatClock(sim.time);
  byId('kpis').innerHTML = [
    ['Average wait', secs(s.avgWait)],
    ['95th pct wait', secs(s.p95Wait)],
    ['Average trip', secs(s.avgTrip)],
    ['Delivered', String(s.delivered)],
    ['Waiting now', String(s.waitingNow)],
    ['Longest wait now', secs(s.longestWaitNow)],
  ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');

  const cap = sim.cfg.capacity;
  sim.cars.forEach((car, i) => {
    const r = view.rows[i];
    const cls = car.direction === UP ? 'up' : car.direction === DOWN ? 'down' : '';
    r.pos.innerHTML = `<span class="${cls}">${dirArrow(car.direction) || '·'}</span> ${floorLabel(car.floor)}`;
    const state = car.isOverloaded ? '<b class="overload">Overload</b> · doors held open'
      : car.state === CarState.MOVING ? `Moving ${car.speed.toFixed(1)} m/s` : STATE_TEXT[car.state];
    const stops = car.plannedStops.map(floorLabel).join(' · ');
    const detail = stops ? `Stops ${stops}` : 'No stops queued';
    r.state.innerHTML = `${state}<span class="stops">${detail}</span>`;
    r.meter.style.width = `${(100 * car.load) / cap}%`;
    r.loadText.textContent = `${car.load}/${cap} · ${car.loadKg} kg`;
    r.row.classList.toggle('overload', car.isOverloaded);
  });

  const recent = sim.events.slice(-8).reverse();
  byId('log').innerHTML = recent.length
    ? recent.map((e) => `<li class="${e.kind}"><time>${formatClock(e.t).slice(3)}</time><span>${e.text}</span></li>`).join('')
    : '<li>No hall calls yet.</li>';
}

// ------------------------------------------------------------------ loop

/** Timestamp of the previous animation frame, ms. */
let last = performance.now();
/** Simulated seconds owed but not yet stepped (less than one `dt`). */
let carry = 0;
/** Real seconds since the last `renderSlow`. */
let slowTimer = 0;

/**
 * Animation loop: advance the simulation by `settings.speed` × the real time elapsed, in
 * fixed steps (at most 1000 per frame, and at most 0.1 s of real time, so a background
 * tab doesn't jump ahead), then draw.
 * @param {number} now timestamp from requestAnimationFrame, ms
 */
function frame(now) {
  const elapsed = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (running) {
    carry += elapsed * settings.speed;
    let steps = 0;
    while (carry >= sim.dt && steps < 1000) {
      sim.step();
      carry -= sim.dt;
      steps++;
    }
  }
  renderFrame();
  slowTimer += elapsed;
  if (slowTimer >= 0.25) {
    slowTimer = 0;
    renderSlow();
  }
  requestAnimationFrame(frame);
}

buildControls();
newSimulation();
renderFrame();
requestAnimationFrame(frame);
