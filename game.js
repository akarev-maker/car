// Traffic Racer 3D — real-3D chase-cam driving game (Three.js + WebGL).
// You see your own car on the road, so you can judge lanes and gaps.
// Pass close to traffic at speed for big points.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Reflector } from "three/addons/objects/Reflector.js";

const canvas = document.getElementById("game");

// ---- World layout (real 3D, Three.js) ----
const LANES = [-0.8, -0.4, 0, 0.4, 0.8]; // 5-lane highway (lateral units; ±1 = road edges)
const SPAWN_DZ = 4800;   // how far ahead (game-z units) traffic appears
const ROAD_HALF_W = 9;   // world half-width of the asphalt (lx = ±1)
const ROAD_LEN = 660;    // world length of the road / ground meshes
const Z_SCALE = 0.055;   // world units per game-z unit (depth compression)
const PLAYER_DZ = 138;   // game-z plane where you sit; passes/crashes register here

// game coords -> Three world coords
const worldX = (lx) => lx * ROAD_HALF_W;
const worldZ = (dz) => -(dz - PLAYER_DZ) * Z_SCALE; // your plane at z=0, ahead is -Z

const TRAFFIC_COLORS = ["#ef476f", "#06d6a0", "#118ab2", "#ffd166", "#9b5de5", "#f78c6b"];

// ---- Roadside scenery ----
const SIGN_COLORS = ["#2e7d32", "#1565c0", "#f9a825"]; // highway / info / warning
const SCENERY_STEP = 150; // average spacing between roadside objects (world units)

// ---- Driving feel ----
const ACCEL = 1.3;
const ENGINE_BRAKE = 0.5;
const BRAKE = 2.6;
const DRAG = 0.0015; // light; the accel taper is what sets top speed now
const STEER_ACCEL = 0.0048;
const STEER_FRICTION = 0.84;
const STEER_MAX_V = 0.036;
const PLAYER_X_LIMIT = 0.86; // how far onto the shoulder you can go

// ---- Scoring / collision (lateral units) ----
const LANE_TOLERANCE = 0.3; // overlap closer than this = contact
const HARD_TOLERANCE = 0.17; // near head-on contact = crash (ends the run)
const NEAR_MISS_RANGE = 0.58; // within this (but safe) = bonus
const TRAFFIC_MAX_SPEED = 30; // absolute traffic speed (so better cars overtake more)
const TRAFFIC_MIN_FACTOR = 0.5; // slowest traffic is half top speed (nobody parks on the highway)
const TRAFFIC_GAP = 700; // min world gap between cars in a lane (they queue, not overlap)

// ---- Cars you can unlock (the first one is intentionally weak) ----
// engine = { idle, rev: firing-rate range (Hz); growl: distortion; bass: sub level; bright: filter }
const CARS = [
  { id: "hatch", name: "City Hatch", color: "#9aa0a6", price: 0, accel: 0.42, maxSpeed: 46, handling: 0.8,
    tier: 0, rarity: "Standard", blurb: "Humble runabout — gentle pace, easy to place in traffic.",
    engine: { idle: 50, rev: 190, growl: 1.6, bass: 0.3, bright: 1.05 } },
  { id: "sedan", name: "Sport Sedan", color: "#3aa0ff", price: 2500, accel: 0.58, maxSpeed: 60, handling: 1.0,
    tier: 1, rarity: "Sport", blurb: "Balanced all-rounder with a willing, eager engine.",
    engine: { idle: 44, rev: 175, growl: 2.2, bass: 0.5, bright: 1.0 } },
  { id: "muscle", name: "Muscle", color: "#ef476f", price: 7000, accel: 0.78, maxSpeed: 72, handling: 1.08,
    tier: 2, rarity: "Muscle", blurb: "Brutal low-end shove — thrilling, a handful up top.",
    engine: { idle: 34, rev: 150, growl: 3.4, bass: 0.85, bright: 0.95 } },
  { id: "gt", name: "GT Coupe", color: "#ffd166", price: 16000, accel: 0.95, maxSpeed: 84, handling: 1.22,
    tier: 3, rarity: "GT", blurb: "Poised grand tourer — quick, composed, effortless.",
    engine: { idle: 46, rev: 200, growl: 2.8, bass: 0.6, bright: 1.2 } },
  { id: "super", name: "Hypercar", color: "#06d6a0", price: 35000, accel: 1.2, maxSpeed: 100, handling: 1.45,
    tier: 4, rarity: "Hyper", blurb: "Savage pace and razor reflexes for the brave.",
    engine: { idle: 38, rev: 220, growl: 3.6, bass: 0.95, bright: 1.3 } },
  { id: "velox", name: "Velox SVX", color: "#eceff5", price: 90000, accel: 1.5, maxSpeed: 120, handling: 1.6,
    tier: 5, rarity: "Apex", blurb: "The halo car. Effortless violence, dressed in elegance.",
    engine: { idle: 40, rev: 240, growl: 3.2, bass: 1.0, bright: 1.4 } },
];
const getCar = (id) => CARS.find((c) => c.id === id) || CARS[0];

// ---- Per-car upgrades (bought in the garage, saved to localStorage) ----
const UPG_MAX = 4; // levels per track
const UPG_TRACKS = [
  { key: "engine",   label: "Engine",    per: 0.12 }, // boosts accel
  { key: "speed",    label: "Top Speed", per: 0.08 }, // boosts max speed
  { key: "handling", label: "Handling",  per: 0.08 }, // boosts handling
];
const upgradeCost = (c, level) => Math.round((c.price * 0.14 + 450) * (level + 1));

// Bar scale: a fully-upgraded top car reads as a full bar.
const STAT_CEIL = {
  accel: Math.max(...CARS.map((c) => c.accel)) * (1 + 0.12 * UPG_MAX),
  maxSpeed: Math.max(...CARS.map((c) => c.maxSpeed)) * (1 + 0.08 * UPG_MAX),
  handling: Math.max(...CARS.map((c) => c.handling)) * (1 + 0.08 * UPG_MAX),
};
// Rarity accent per tier (clean -> rich as cars improve).
const RARITY_COLOR = ["#9aa0a6", "#3aa0ff", "#ef476f", "#ffd166", "#06d6a0", "#e8d8a0"];

const defaultUpgrades = () => {
  const u = {};
  for (const c of CARS) u[c.id] = { engine: 0, speed: 0, handling: 0 };
  return u;
};
// A car's stats with its upgrades applied (used in the garage and in play).
function effStats(c) {
  const u = upgrades[c.id] || { engine: 0, speed: 0, handling: 0 };
  return {
    accel: c.accel * (1 + 0.12 * u.engine),
    maxSpeed: c.maxSpeed * (1 + 0.08 * u.speed),
    handling: c.handling * (1 + 0.08 * u.handling),
  };
}

// ---- Persistent progress (localStorage) ----
let bank = 0;
let owned = ["hatch"];
let selectedCar = "hatch";
let highScore = 0;
let activeCar = CARS[0];
let upgrades = defaultUpgrades();
let activeStats = effStats(CARS[0]); // active car's upgraded stats, set on start

function loadProgress() {
  try {
    bank = parseInt(localStorage.getItem("tr_bank")) || 0;
    owned = JSON.parse(localStorage.getItem("tr_owned")) || ["hatch"];
    selectedCar = localStorage.getItem("tr_selected") || "hatch";
    highScore = parseInt(localStorage.getItem("tr_hi")) || 0;
    upgrades = JSON.parse(localStorage.getItem("tr_upg")) || {};
  } catch (e) { /* use defaults */ }
  if (!owned.includes("hatch")) owned.push("hatch");
  if (!owned.includes(selectedCar)) selectedCar = "hatch";
  // Backfill any missing cars/tracks and clamp saved levels.
  const def = defaultUpgrades();
  for (const id in def) {
    const saved = upgrades[id] || {};
    for (const k in def[id]) def[id][k] = clamp(parseInt(saved[k]) || 0, 0, UPG_MAX);
  }
  upgrades = def;
}
function saveProgress() {
  try {
    localStorage.setItem("tr_bank", bank);
    localStorage.setItem("tr_owned", JSON.stringify(owned));
    localStorage.setItem("tr_selected", selectedCar);
    localStorage.setItem("tr_hi", highScore);
    localStorage.setItem("tr_upg", JSON.stringify(upgrades));
  } catch (e) { /* ignore */ }
}

// ---- State ----
const state = {
  running: false,
  score: 0,
  position: 0,
  speed: 0,
  maxSpeed: 60,
  playerX: 0,
  playerVX: 0,
  lastSpawnPos: 0,
  nextSceneryZ: 0,
  flash: 0,
  hitFlash: 0,      // red flash on a glancing hit
  shake: 0,         // camera shake amount
  // combo + run stats
  combo: 0,
  comboTimer: 0,    // frames remaining before the combo lapses
  mult: 1,
  maxCombo: 0,
  passed: 0,
  topSpeed: 0,
};

const COMBO_WINDOW = 150;   // frames (~2.5s) to land the next near-miss
const comboMult = (combo) => Math.min(8, 1 + Math.floor(combo / 2)); // x1..x8
const DIST_DIV = 16000;     // game-units per displayed "km"
const CREDIT_RATE = 0.125;  // credits earned = score x this (score stays the bragging number)

// ---- Biome engine -------------------------------------------------------
// The world continuously cycles through a ring of biomes as you drive. Each
// entry is a full set of environment params; every frame the engine cosine-
// blends between neighbours so the world is always gently shifting. Drop another
// biome in the ring and it slots straight in — Day<->Night is the first two.
const BIOME_CYCLE_KM = 6;     // distance for one full day->night->day lap
const BIOMES = [
  { name: "Day",
    sky: 0x86c8e8, fogNear: 70, fogFar: 300,
    hemiSky: 0xbfe3ff, hemiGround: 0x4a6b3a, hemiInt: 1.0,
    sunColor: 0xfff1da, sunInt: 1.0, grass: 0x2f9e44, night: 0 },
  { name: "Night",
    sky: 0x050811, fogNear: 38, fogFar: 175,
    hemiSky: 0x1b2747, hemiGround: 0x03040a, hemiInt: 0.28,
    sunColor: 0x8aa0e0, sunInt: 0.22, grass: 0x0e2a18, night: 1 },
];

let traffic = [];
let scenery = [];
let popups = [];

const input = { steer: 0, throttle: 0, brake: 0 };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---- Audio (Web Audio API, all synthesized) ----
let audio = null;
let muted = false;

// Soft-clip distortion curve for engine grit/growl.
function makeDistortionCurve(amount) {
  const n = 256;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * amount);
  }
  return curve;
}

function initAudio() {
  if (audio) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  const ac = new Ctx();

  const master = ac.createGain();
  master.gain.value = muted ? 0 : 0.9;
  master.connect(ac.destination);

  // Reusable noise buffer (combustion texture, whooshes, crash).
  const len = Math.floor(ac.sampleRate * 1.0);
  const noiseBuffer = ac.createBuffer(1, len, ac.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

  // ---- Engine ----
  // Signal chain: [noise exhaust + body saw + sub] -> mixBus -> pulse (AM at
  // firing rate) -> waveshaper (growl) -> lowpass (opens with revs) -> out.
  // Pulsing the ENTIRE mix at the firing rate is what makes it read as an
  // engine (exhaust pulses) instead of a steady drone.
  const engineGain = ac.createGain();
  engineGain.gain.value = 0;
  engineGain.connect(master);

  const engineFilter = ac.createBiquadFilter();
  engineFilter.type = "lowpass";
  engineFilter.frequency.value = 700;
  engineFilter.connect(engineGain);

  const shaper = ac.createWaveShaper();
  shaper.curve = makeDistortionCurve(2.4);
  shaper.oversample = "2x";
  shaper.connect(engineFilter);

  const pulse = ac.createGain(); // AM by LFO -> exhaust pulses
  pulse.gain.value = 0.55;
  pulse.connect(shaper);

  const mixBus = ac.createGain();
  mixBus.gain.value = 1;
  mixBus.connect(pulse);

  // Exhaust body: band-passed noise (the bulk of the character)
  const noiseSrc = ac.createBufferSource();
  noiseSrc.buffer = noiseBuffer;
  noiseSrc.loop = true;
  const noiseBP = ac.createBiquadFilter();
  noiseBP.type = "bandpass";
  noiseBP.frequency.value = 300;
  noiseBP.Q.value = 1.2;
  const noiseGain = ac.createGain();
  noiseGain.gain.value = 0.7;
  noiseSrc.connect(noiseBP).connect(noiseGain).connect(mixBus);

  // A little tonal body + low rumble
  const osc1 = ac.createOscillator();
  osc1.type = "sawtooth";
  osc1.frequency.value = 40;
  const oscGain = ac.createGain();
  oscGain.gain.value = 0.22;
  osc1.connect(oscGain).connect(mixBus);

  const sub = ac.createOscillator();
  sub.type = "sine";
  sub.frequency.value = 20;
  const subGain = ac.createGain();
  subGain.gain.value = 0.5;
  sub.connect(subGain).connect(mixBus);

  // Firing-rate pulse LFO (swings pulse gain ~0.1 .. 1.0)
  const lfo = ac.createOscillator();
  lfo.type = "sawtooth";
  lfo.frequency.value = 40;
  const lfoDepth = ac.createGain();
  lfoDepth.gain.value = 0.45;
  lfo.connect(lfoDepth).connect(pulse.gain);

  osc1.start();
  sub.start();
  noiseSrc.start();
  lfo.start();

  audio = {
    ac, master, engineGain, engineFilter, shaper, osc1, sub, subGain, lfo, noiseBP, noiseBuffer,
    eIdle: 44, eRev: 175, eBright: 1.0,
  };
}

function setEngineProfile(car) {
  if (!audio || !car.engine) return;
  const e = car.engine;
  audio.eIdle = e.idle;
  audio.eRev = e.rev;
  audio.eBright = e.bright;
  audio.shaper.curve = makeDistortionCurve(e.growl);
  audio.subGain.gain.value = e.bass;
}

function audioEngine(speed, maxSpeed, throttle, running) {
  if (!audio) return;
  const t = audio.ac.currentTime;
  const ratio = clamp(speed / maxSpeed, 0, 1);
  const f = audio.eIdle + ratio * (audio.eRev - audio.eIdle); // firing rate (Hz)
  audio.osc1.frequency.setTargetAtTime(f, t, 0.06);
  audio.sub.frequency.setTargetAtTime(f * 0.5, t, 0.06);
  audio.lfo.frequency.setTargetAtTime(f, t, 0.06); // pulses speed up with revs
  audio.noiseBP.frequency.setTargetAtTime((260 + ratio * 500) * audio.eBright, t, 0.1);
  audio.engineFilter.frequency.setTargetAtTime((360 + ratio * 2600 + throttle * 600) * audio.eBright, t, 0.1);
  // Quieter overall so passing whooshes are clearly audible.
  const vol = running ? 0.035 + 0.075 * ratio + 0.03 * throttle : 0;
  audio.engineGain.gain.setTargetAtTime(vol, t, 0.08);
}

function audioWhoosh(panVal, intensity) {
  if (!audio || intensity <= 0.01) return;
  const t = audio.ac.currentTime;
  const dur = 0.3;
  const src = audio.ac.createBufferSource();
  src.buffer = audio.noiseBuffer;
  const bp = audio.ac.createBiquadFilter();
  bp.type = "bandpass";
  bp.Q.value = 0.9;
  bp.frequency.setValueAtTime(500, t);
  bp.frequency.exponentialRampToValueAtTime(2200, t + dur);
  const g = audio.ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.8 * intensity, t + 0.05);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(bp).connect(g);
  if (audio.ac.createStereoPanner) {
    const pan = audio.ac.createStereoPanner();
    pan.pan.value = clamp(panVal, -1, 1);
    g.connect(pan).connect(audio.master);
  } else {
    g.connect(audio.master);
  }
  src.start(t);
  src.stop(t + dur);
}

function audioCrash() {
  if (!audio) return;
  const t = audio.ac.currentTime;
  const src = audio.ac.createBufferSource();
  src.buffer = audio.noiseBuffer;
  const lp = audio.ac.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 900;
  const g = audio.ac.createGain();
  g.gain.setValueAtTime(0.9, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
  src.connect(lp).connect(g).connect(audio.master);
  src.start(t);
  src.stop(t + 0.5);
  const o = audio.ac.createOscillator();
  o.type = "sine";
  o.frequency.setValueAtTime(120, t);
  o.frequency.exponentialRampToValueAtTime(40, t + 0.4);
  const og = audio.ac.createGain();
  og.gain.setValueAtTime(0.6, t);
  og.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
  o.connect(og).connect(audio.master);
  o.start(t);
  o.stop(t + 0.4);
}

// Metallic scrape for a glancing sideswipe.
function audioScrape(pan) {
  if (!audio) return;
  const t = audio.ac.currentTime;
  const src = audio.ac.createBufferSource();
  src.buffer = audio.noiseBuffer;
  const bp = audio.ac.createBiquadFilter();
  bp.type = "bandpass"; bp.frequency.value = 1600; bp.Q.value = 0.8;
  const g = audio.ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.6, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
  src.connect(bp).connect(g);
  if (audio.ac.createStereoPanner) {
    const p = audio.ac.createStereoPanner(); p.pan.value = clamp(pan, -1, 1);
    g.connect(p).connect(audio.master);
  } else g.connect(audio.master);
  src.start(t); src.stop(t + 0.25);
}

// ---- UI / reward sounds (synth, sharing the engine's AudioContext) ----
function ensureAudio() {
  initAudio();
  if (audio && audio.ac.state === "suspended") audio.ac.resume();
}
function uiTone(freq, when, dur, type = "sine", peak = 0.18) {
  if (!audio) return;
  const t = audio.ac.currentTime + when;
  const o = audio.ac.createOscillator(); o.type = type; o.frequency.value = freq;
  const g = audio.ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(audio.master);
  o.start(t); o.stop(t + dur + 0.03);
}
function audioTick()   { ensureAudio(); uiTone(880, 0, 0.05, "triangle", 0.10); uiTone(1320, 0.02, 0.05, "triangle", 0.07); }
function audioCoin()   { ensureAudio(); uiTone(784, 0, 0.08, "triangle", 0.13); uiTone(1175, 0.06, 0.10, "triangle", 0.13); uiTone(1568, 0.12, 0.16, "sine", 0.10); }
function audioUnlock() { ensureAudio(); [523, 659, 784, 1047, 1319].forEach((f, i) => uiTone(f, i * 0.08, 0.45, "triangle", 0.11)); }
function audioDenied() { ensureAudio(); uiTone(150, 0, 0.14, "square", 0.08); uiTone(110, 0.07, 0.18, "square", 0.08); }

function toggleMute() {
  muted = !muted;
  if (audio) audio.master.gain.setTargetAtTime(muted ? 0 : 0.9, audio.ac.currentTime, 0.02);
  const btn = document.getElementById("mute");
  if (btn) btn.textContent = muted ? "🔇" : "🔊";
}

// ---- Keyboard ----
const keys = { left: false, right: false, up: false, down: false };
window.addEventListener("keydown", (e) => {
  switch (e.key) {
    case "ArrowLeft": case "a": case "A": keys.left = true; break;
    case "ArrowRight": case "d": case "D": keys.right = true; break;
    case "ArrowUp": case "w": case "W": keys.up = true; break;
    case "ArrowDown": case "s": case "S": keys.down = true; break;
    case "m": case "M": toggleMute(); break;
  }
});
window.addEventListener("keyup", (e) => {
  switch (e.key) {
    case "ArrowLeft": case "a": case "A": keys.left = false; break;
    case "ArrowRight": case "d": case "D": keys.right = false; break;
    case "ArrowUp": case "w": case "W": keys.up = false; break;
    case "ArrowDown": case "s": case "S": keys.down = false; break;
  }
});

// ---- Joystick (mobile) ----
if (window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window) {
  document.body.classList.add("touch");
}
const joystick = document.getElementById("joystick");
const stick = document.getElementById("stick");
const JOY_R = 44;
let joyActive = false;
let joyId = null;
let joyCenter = { x: 0, y: 0 };

function joyStart(x, y) {
  const rect = joystick.getBoundingClientRect();
  joyCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  joyActive = true;
  joyMove(x, y);
}
function joyMove(x, y) {
  if (!joyActive) return;
  let dx = x - joyCenter.x;
  let dy = y - joyCenter.y;
  const dist = Math.hypot(dx, dy);
  if (dist > JOY_R) { dx *= JOY_R / dist; dy *= JOY_R / dist; }
  stick.style.transform = `translate(${dx}px, ${dy}px)`;
  input.steer = clamp(dx / JOY_R, -1, 1);
  input.throttle = clamp(-dy / JOY_R, 0, 1);
  input.brake = clamp(dy / JOY_R, 0, 1);
}
function joyEnd() {
  joyActive = false;
  stick.style.transform = "translate(0, 0)";
  input.steer = input.throttle = input.brake = 0;
}
joystick.addEventListener("touchstart", (e) => {
  e.preventDefault();
  const t = e.changedTouches[0];
  joyId = t.identifier;
  joyStart(t.clientX, t.clientY);
}, { passive: false });
window.addEventListener("touchmove", (e) => {
  if (!joyActive) return;
  for (const t of e.changedTouches) {
    if (t.identifier === joyId) { e.preventDefault(); joyMove(t.clientX, t.clientY); }
  }
}, { passive: false });
window.addEventListener("touchend", (e) => {
  for (const t of e.changedTouches) {
    if (t.identifier === joyId) { joyEnd(); joyId = null; }
  }
});
joystick.addEventListener("mousedown", (e) => { e.preventDefault(); joyStart(e.clientX, e.clientY); });
window.addEventListener("mousemove", (e) => { if (joyActive) joyMove(e.clientX, e.clientY); });
window.addEventListener("mouseup", () => { if (joyActive) joyEnd(); });

// ---- Traffic ----
function spawnCarInLane(lane) {
  const z = state.position + SPAWN_DZ;
  // Don't drop a car on top of one already in this lane near the spawn point.
  for (const c of traffic) {
    if (c.lx === lane && Math.abs(c.z - z) < TRAFFIC_GAP * 1.6) return;
  }
  traffic.push({
    lx: lane,
    z,
    prevDz: SPAWN_DZ,
    // Everyone keeps moving — slowest is still half of top traffic speed.
    speed: TRAFFIC_MAX_SPEED * (TRAFFIC_MIN_FACTOR + (1 - TRAFFIC_MIN_FACTOR) * Math.random()),
    color: TRAFFIC_COLORS[Math.floor(Math.random() * TRAFFIC_COLORS.length)],
  });
}

// On a wide highway, sometimes spawn a few cars at once (never all lanes,
// so there's always a gap to thread through).
function spawnWave() {
  const lanes = [...LANES];
  let count = 1;
  if (Math.random() < Math.min(0.6, state.position / 40000)) count++;
  if (Math.random() < Math.min(0.35, state.position / 80000)) count++;
  count = Math.min(count, LANES.length - 2);
  for (let n = 0; n < count; n++) {
    const idx = Math.floor(Math.random() * lanes.length);
    spawnCarInLane(lanes.splice(idx, 1)[0]);
  }
}

function addPopup(x, y, text, color) {
  popups.push({ x, y, text, color, life: 1 });
}

// Car-following: within each lane, a faster car can't drive through the car
// ahead. It closes the gap, then matches the leader's speed (like real traffic).
function resolveTrafficFollowing() {
  const lanes = new Map();
  for (const car of traffic) {
    if (!lanes.has(car.lx)) lanes.set(car.lx, []);
    lanes.get(car.lx).push(car);
  }
  for (const list of lanes.values()) {
    list.sort((a, b) => a.z - b.z); // back -> front
    for (let i = list.length - 2; i >= 0; i--) {
      const behind = list[i], ahead = list[i + 1];
      if (ahead.z - behind.z < TRAFFIC_GAP) {
        behind.z = ahead.z - TRAFFIC_GAP;
        behind.speed = Math.min(behind.speed, ahead.speed); // don't accelerate into it
      }
    }
  }
}

// ---- Roadside scenery ----
function spawnScenery(z) {
  const side = Math.random() < 0.5 ? -1 : 1;
  const type = Math.random() < 0.78 ? "tree" : "sign";
  // place just beyond the road edge (lx = ±1); trees can sit further out
  const lx = side * (1.15 + Math.random() * (type === "tree" ? 0.8 : 0.25));
  scenery.push({
    z,
    lx,
    type,
    sizeVar: 0.8 + Math.random() * 0.5,
    color: SIGN_COLORS[Math.floor(Math.random() * SIGN_COLORS.length)],
  });
}

// Keep the roadside populated ahead of the player; recycle what's passed.
function updateScenery() {
  while (state.nextSceneryZ < state.position + SPAWN_DZ + 1500) {
    spawnScenery(state.nextSceneryZ);
    state.nextSceneryZ += SCENERY_STEP * (0.6 + Math.random() * 0.8);
  }
  for (let i = scenery.length - 1; i >= 0; i--) {
    if (scenery[i].z - state.position < -200) scenery.splice(i, 1);
  }
}

// Project a 3D world point to 2D overlay (fx canvas) pixels, for score popups.
const _projV = new THREE.Vector3();
function worldToScreen(x, y, z) {
  _projV.set(x, y, z).project(camera);
  return { x: (_projV.x * 0.5 + 0.5) * fx.width, y: (-_projV.y * 0.5 + 0.5) * fx.height };
}

// ---- Update ----
function update() {
  if (!joyActive) {
    input.steer = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    input.throttle = keys.up ? 1 : 0;
    input.brake = keys.down ? 1 : 0;
  }

  // Top speed comes from your car, with a small bonus the farther you get.
  state.maxSpeed = activeStats.maxSpeed + Math.min(18, Math.floor(state.position / 10000) * 6);

  // Forward speed. Engine power tapers as you near top speed (so the last
  // stretch takes effort), but keeps a floor so the stated top speed is
  // actually reachable instead of stalling out well below it.
  if (input.throttle > 0) {
    const accelFade = Math.max(0.2, 1 - Math.pow(state.speed / state.maxSpeed, 2));
    state.speed += activeStats.accel * input.throttle * accelFade;
  } else state.speed -= ENGINE_BRAKE;
  if (input.brake > 0) state.speed -= BRAKE * input.brake;
  state.speed -= state.speed * DRAG;
  state.speed = clamp(state.speed, 0, state.maxSpeed);
  state.position += state.speed;

  // Steering (handling scales with the car)
  const grip = 0.25 + 0.75 * (state.speed / state.maxSpeed);
  state.playerVX += input.steer * STEER_ACCEL * activeStats.handling * grip;
  if (input.steer === 0) state.playerVX *= STEER_FRICTION;
  state.playerVX = clamp(state.playerVX, -STEER_MAX_V * activeStats.handling, STEER_MAX_V * activeStats.handling);
  state.playerX += state.playerVX;
  if (state.playerX < -PLAYER_X_LIMIT) { state.playerX = -PLAYER_X_LIMIT; state.playerVX = 0; }
  if (state.playerX > PLAYER_X_LIMIT) { state.playerX = PLAYER_X_LIMIT; state.playerVX = 0; }

  // Spawn traffic by distance (denser over time)
  const spawnGap = Math.max(1500, 3000 - state.position / 30);
  if (state.position - state.lastSpawnPos > spawnGap) {
    state.lastSpawnPos = state.position;
    spawnWave();
  }

  updateScenery();

  // Advance traffic, then keep same-lane cars from overlapping.
  for (const car of traffic) car.z += car.speed;
  resolveTrafficFollowing();

  if (state.speed > state.topSpeed) state.topSpeed = state.speed;

  // Combo lapses if you go too long without landing a near miss.
  if (state.comboTimer > 0 && --state.comboTimer === 0) { state.combo = 0; state.mult = 1; }

  // Passes/crashes happen at YOUR plane (where you see them alongside).
  const speedFactor = state.speed / state.maxSpeed;
  for (let i = traffic.length - 1; i >= 0; i--) {
    const car = traffic[i];
    const dz = car.z - state.position;

    if (car.prevDz > PLAYER_DZ && dz <= PLAYER_DZ) {
      const lateral = Math.abs(state.playerX - car.lx);
      const sp = worldToScreen(worldX(car.lx), 1.8, 0);
      const pan = clamp(car.lx - state.playerX, -1, 1);

      if (lateral < HARD_TOLERANCE) {           // near head-on -> crash
        gameOver();
        return;
      } else if (lateral < LANE_TOLERANCE) {    // sideswipe -> survive, but punished
        sideswipe(pan);
      } else {                                  // clean pass
        state.passed++;
        let closeness = 0;
        if (lateral < NEAR_MISS_RANGE) {        // near miss: build the combo
          closeness = 1 - (lateral - LANE_TOLERANCE) / (NEAR_MISS_RANGE - LANE_TOLERANCE);
          state.combo++;
          state.maxCombo = Math.max(state.maxCombo, state.combo);
          state.comboTimer = COMBO_WINDOW;
          state.mult = comboMult(state.combo);
          const pts = Math.round((40 + closeness * 200) * (0.35 + 0.65 * speedFactor)) * state.mult;
          state.score += pts;
          const tag = state.mult > 1 ? `x${state.mult} +${pts}` : `+${pts}`;
          if (closeness > 0.6 && speedFactor > 0.6) {
            addPopup(sp.x, sp.y, "NEAR MISS " + tag, "#ffd166");
            state.flash = Math.max(state.flash, closeness);
          } else {
            addPopup(sp.x, sp.y, tag, "#06d6a0");
          }
        } else {
          state.score += Math.round(8 * (0.5 + 0.5 * speedFactor)) * state.mult;
        }
        audioWhoosh(pan, (0.25 + 0.75 * closeness) * (0.4 + 0.6 * speedFactor));
      }
    }
    car.prevDz = dz;

    if (dz < -300 || dz > SPAWN_DZ + 4000) traffic.splice(i, 1);
  }

  for (let i = popups.length - 1; i >= 0; i--) {
    popups[i].life -= 0.02;
    popups[i].y -= 0.6;
    if (popups[i].life <= 0) popups.splice(i, 1);
  }
  state.flash *= 0.9;
  state.hitFlash *= 0.88;
  state.shake *= 0.85;

  audioEngine(state.speed, state.maxSpeed, input.throttle, true);
  updateHUD();
}

// Glancing contact: heavy speed loss, lost combo, red flash + scrape — but you
// keep driving. Only near head-on contact (HARD_TOLERANCE) ends the run.
function sideswipe(pan) {
  state.speed *= 0.5;
  state.combo = 0; state.mult = 1; state.comboTimer = 0;
  state.hitFlash = 1;
  state.shake = Math.max(state.shake, 1);
  audioScrape(pan);
}

// ---- HUD ----
let hud = null;
function cacheHUD() {
  hud = {
    score: document.getElementById("score"),
    speed: document.getElementById("speed"),
    dist: document.getElementById("dist"),
    spdFill: document.getElementById("spd-fill"),
    combo: document.getElementById("combo"),
    comboMult: document.getElementById("combo-mult"),
    comboFill: document.getElementById("combo-fill"),
  };
}
function updateHUD() {
  if (!hud) cacheHUD();
  hud.score.textContent = fmt(state.score);
  hud.speed.textContent = Math.round(state.speed * 3);
  hud.dist.textContent = (state.position / DIST_DIV).toFixed(1);
  hud.spdFill.style.width = clamp(state.speed / state.maxSpeed, 0, 1) * 100 + "%";
  if (state.mult > 1) {
    hud.combo.classList.add("on");
    hud.comboMult.textContent = "x" + state.mult;
    hud.comboFill.style.width = (state.comboTimer / COMBO_WINDOW * 100) + "%";
  } else {
    hud.combo.classList.remove("on");
  }
}

// ============================================================
//  3D rendering (Three.js / WebGL)
// ============================================================
let scene, camera, renderer, fx, fxCtx, roadTex;
let trafficGroup, sceneryGroup, playerMesh = null, playerCarId = null;
let hemiLight, sunLight, grassMat;   // updated each frame by the biome engine
let ready3d = false;
const CAM_FOV = 55; // base camera FOV (widens with speed)

// ---- Real car models (GLB). Drop files in models/<id>.glb — see models/README.md.
// Until a file exists, the game falls back to the detailed procedural car below.
const gltfLoader = new GLTFLoader();
const modelCache = {}; // id -> { mesh } | "loading" | "failed"
const MODEL_CFG = {
  hatch:  { url: "models/hatch.glb",  scale: 1, yaw: Math.PI, y: 0 },
  sedan:  { url: "models/sedan.glb",  scale: 1, yaw: Math.PI, y: 0 },
  muscle: { url: "models/muscle.glb", scale: 1, yaw: Math.PI, y: 0 },
  gt:     { url: "models/gt.glb",     scale: 1, yaw: Math.PI, y: 0 },
  super:  { url: "models/super.glb",  scale: 1, yaw: Math.PI, y: 0 },
  velox:  { url: "models/velox.glb",  scale: 1, yaw: Math.PI, y: 0 },
};

// ---- Shared geometry/materials (built once; every mesh just references them,
// so spawning traffic is cheap and removing it leaks nothing on the GPU).
const _geo = {};
const _paintMats = new Map();
const _signMats = new Map();
let _matGlass, _matTire, _matHead, _matTail, _matShadow, _matTrunk, _matLeaf, _matPost, _matSilhouette;

function initSharedAssets() {
  _geo.skirt  = new THREE.BoxGeometry(2.12, 0.4, 4.5);
  _geo.body   = new THREE.BoxGeometry(2.0, 0.62, 4.3);
  _geo.hood   = new THREE.BoxGeometry(1.86, 0.3, 1.3);
  _geo.cabin  = new THREE.BoxGeometry(1.7, 0.6, 2.1);
  _geo.glass  = new THREE.BoxGeometry(1.74, 0.52, 1.72);
  _geo.wheel  = new THREE.CylinderGeometry(0.42, 0.42, 0.34, 18);
  _geo.light  = new THREE.BoxGeometry(0.42, 0.22, 0.1);
  _geo.shadow = new THREE.CircleGeometry(1.7, 24);
  _geo.trunk  = new THREE.CylinderGeometry(0.18, 0.26, 2.2, 8);
  _geo.leaf   = new THREE.IcosahedronGeometry(1.5, 0);
  _geo.post   = new THREE.CylinderGeometry(0.12, 0.12, 3, 8);
  _geo.sign   = new THREE.BoxGeometry(2.4, 1.4, 0.14);

  _matGlass  = new THREE.MeshStandardMaterial({ color: 0x10141b, metalness: 0.3, roughness: 0.12 });
  _matTire   = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.85 });
  _matHead   = new THREE.MeshStandardMaterial({ color: 0xfff4cc, emissive: 0xffe9a0, emissiveIntensity: 0.9, roughness: 0.4 });
  _matTail   = new THREE.MeshStandardMaterial({ color: 0x5a0000, emissive: 0xff2b2b, emissiveIntensity: 0.9, roughness: 0.4 });
  _matShadow = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false });
  _matTrunk  = new THREE.MeshStandardMaterial({ color: 0x5b3a21, roughness: 1 });
  _matLeaf   = new THREE.MeshStandardMaterial({ color: 0x2f8f3e, roughness: 1, flatShading: true });
  _matPost   = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.6, metalness: 0.4 });
  _matSilhouette = new THREE.MeshStandardMaterial({ color: 0x0b0d12, roughness: 0.7, metalness: 0.2 });
}

function paintMat(color) {
  if (!_paintMats.has(color))
    _paintMats.set(color, new THREE.MeshStandardMaterial({ color, metalness: 0.55, roughness: 0.38 }));
  return _paintMats.get(color);
}
function signMat(color) {
  if (!_signMats.has(color)) _signMats.set(color, new THREE.MeshStandardMaterial({ color, roughness: 0.8 }));
  return _signMats.get(color);
}

// A proper 3D car: chassis + body + hood + cabin + glass + 4 wheels + lights.
function buildProceduralCar(color) {
  const g = new THREE.Group();
  const paint = paintMat(color);
  const skirt = new THREE.Mesh(_geo.skirt, paint); skirt.position.y = 0.42; g.add(skirt);
  const body  = new THREE.Mesh(_geo.body, paint);  body.position.y = 0.74; g.add(body);
  const hood  = new THREE.Mesh(_geo.hood, paint);  hood.position.set(0, 0.95, -1.55); g.add(hood);
  const cabin = new THREE.Mesh(_geo.cabin, paint); cabin.position.set(0, 1.15, 0.2); g.add(cabin);
  const glass = new THREE.Mesh(_geo.glass, _matGlass); glass.position.set(0, 1.18, 0.2); g.add(glass);
  for (const [x, z] of [[0.92, 1.45], [-0.92, 1.45], [0.92, -1.45], [-0.92, -1.45]]) {
    const w = new THREE.Mesh(_geo.wheel, _matTire);
    w.rotation.z = Math.PI / 2; w.position.set(x, 0.42, z); g.add(w);
  }
  for (const x of [0.6, -0.6]) {
    const h = new THREE.Mesh(_geo.light, _matHead); h.position.set(x, 0.7, -2.18); g.add(h);
    const t = new THREE.Mesh(_geo.light, _matTail); t.position.set(x, 0.78, 2.18); g.add(t);
  }
  const sh = new THREE.Mesh(_geo.shadow, _matShadow);
  sh.rotation.x = -Math.PI / 2; sh.position.y = 0.02; g.add(sh);
  return g;
}

function buildTree() {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(_geo.trunk, _matTrunk); trunk.position.y = 1.1; g.add(trunk);
  const leaf = new THREE.Mesh(_geo.leaf, _matLeaf); leaf.position.y = 2.7; leaf.scale.set(1.4, 1.7, 1.4); g.add(leaf);
  return g;
}
function buildSign(color) {
  const g = new THREE.Group();
  const post = new THREE.Mesh(_geo.post, _matPost); post.position.y = 1.5; g.add(post);
  const board = new THREE.Mesh(_geo.sign, signMat(color)); board.position.y = 3.1; g.add(board);
  return g;
}
function makeScenery(o) {
  const m = o.type === "tree" ? buildTree() : buildSign(o.color);
  m.scale.setScalar(o.sizeVar * 1.5);
  return m;
}

// Asphalt + lane markings baked into a tiling texture that scrolls with travel.
function makeRoadTexture() {
  const c = document.createElement("canvas"); c.width = 256; c.height = 256;
  const x = c.getContext("2d");
  x.fillStyle = "#3b4048"; x.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1400; i++) { // subtle asphalt grain
    x.fillStyle = `rgba(0,0,0,${Math.random() * 0.06})`;
    x.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  }
  x.fillStyle = "#e8e8e8"; // solid edge lines (lx = ±1 -> u 0 / 1)
  x.fillRect(4, 0, 7, 256); x.fillRect(256 - 11, 0, 7, 256);
  for (const u of [0.2, 0.4, 0.6, 0.8]) { // dashed lane boundaries
    x.fillStyle = "#f0f0f0";
    x.fillRect(u * 256 - 3, 0, 6, 150); // dash (top) + gap (bottom) tiles into dashes
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 70);
  tex.anisotropy = 8;
  return tex;
}

function initThree() {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  scene = new THREE.Scene();
  // Sky + fog share one persistent Color that the biome engine recolors in place.
  scene.background = _biomeSky;
  scene.fog = new THREE.Fog(_biomeSky, 70, 300);

  camera = new THREE.PerspectiveCamera(CAM_FOV, 16 / 9, 0.3, 400);
  camera.position.set(0, 4.3, 9.5);
  camera.lookAt(0, 1.2, -26);

  hemiLight = new THREE.HemisphereLight(0xbfe3ff, 0x4a6b3a, 1.0);
  scene.add(hemiLight);
  sunLight = new THREE.DirectionalLight(0xfff1da, 1.0);
  sunLight.position.set(-40, 60, 20);
  scene.add(sunLight);

  initSharedAssets();

  grassMat = new THREE.MeshStandardMaterial({ color: 0x2f9e44, roughness: 1 });
  const grass = new THREE.Mesh(
    new THREE.PlaneGeometry(420, ROAD_LEN + 200),
    grassMat
  );
  grass.rotation.x = -Math.PI / 2;
  grass.position.set(0, -0.02, -(ROAD_LEN / 2 - 30));
  scene.add(grass);

  roadTex = makeRoadTexture();
  const road = new THREE.Mesh(
    new THREE.PlaneGeometry(ROAD_HALF_W * 2, ROAD_LEN),
    new THREE.MeshStandardMaterial({ map: roadTex, roughness: 0.92 })
  );
  road.rotation.x = -Math.PI / 2;
  road.position.set(0, 0, -(ROAD_LEN / 2 - 30));
  scene.add(road);

  trafficGroup = new THREE.Group(); scene.add(trafficGroup);
  sceneryGroup = new THREE.Group(); scene.add(sceneryGroup);

  fx = document.getElementById("fx");
  fxCtx = fx.getContext("2d");

  window.addEventListener("resize", onResize);
  window.addEventListener("orientationchange", () => setTimeout(onResize, 200));
  onResize();

  ready3d = true;
  setPlayerCar(getCar(selectedCar)); // show the selected car behind the menu
}

function onResize() {
  const w = canvas.clientWidth || 960, h = canvas.clientHeight || 540;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  fx.width = w; fx.height = h;
}

// Use a real GLB model when present; otherwise keep the procedural car.
function loadCarModel(car) {
  const cfg = MODEL_CFG[car.id];
  if (!cfg || modelCache[car.id]) return; // already loading / loaded / failed
  modelCache[car.id] = "loading";
  gltfLoader.load(cfg.url, (gltf) => {
    const m = gltf.scene;
    m.scale.setScalar(cfg.scale);
    m.rotation.y = cfg.yaw;
    m.position.y = cfg.y;
    const wrap = new THREE.Group(); wrap.add(m); // wrap so clones keep transforms
    modelCache[car.id] = { mesh: wrap };
    if (state.running && playerCarId === car.id) setPlayerCar(car); // hot-swap in
    if (garageOpen && CARS[garageIndex].id === car.id) setPreviewCar(car); // showroom swap
  }, undefined, () => { modelCache[car.id] = "failed"; });
}

function setPlayerCar(car) {
  if (playerMesh) { scene.remove(playerMesh); playerMesh = null; }
  playerCarId = car.id;
  const cached = modelCache[car.id];
  if (cached && cached !== "loading" && cached !== "failed") {
    playerMesh = cached.mesh.clone(true);
  } else {
    playerMesh = buildProceduralCar(car.color);
    loadCarModel(car); // try to upgrade to the real model
  }
  scene.add(playerMesh);
}

function placeOnRoad(o) {
  o.mesh.position.set(worldX(o.lx), 0, worldZ(o.z - state.position));
}

// Add/remove Three meshes so they mirror the game's traffic/scenery arrays.
function reconcile(group, list, make, place) {
  const present = new Set(list);
  for (let i = group.children.length - 1; i >= 0; i--) {
    const m = group.children[i];
    if (!present.has(m.userData.ref)) group.remove(m);
  }
  for (const o of list) {
    if (!o.mesh || o.mesh.parent !== group) {
      o.mesh = make(o);
      o.mesh.userData.ref = o;
      group.add(o.mesh);
    }
    place(o);
  }
}

// Reused so the per-frame blend allocates nothing.
const _biomeSky = new THREE.Color(0x86c8e8);
const _biomeTmp = new THREE.Color();
let nightFactor = 0;          // 0 day .. 1 night; drives the headlight glow
let biomeShown = null;        // dominant biome currently named in the HUD

// Sample the biome ring at the given distance (km) and push the blended
// environment onto the scene, lights, grass and shared car materials.
function applyBiome(km) {
  const n = BIOMES.length;
  const f = ((km / BIOME_CYCLE_KM) % 1 + 1) % 1 * n; // wrapped position on the ring
  const i = Math.floor(f);
  // Continuous, ever-moving blend — no plateaus, so the world is always visibly
  // shifting. Cosine easing keeps each handoff smooth at the pure day/night ends.
  const t = (1 - Math.cos((f - i) * Math.PI)) / 2;
  const a = BIOMES[i % n], b = BIOMES[(i + 1) % n];
  const mix = (ka, kb) => ka + (kb - ka) * t;

  _biomeSky.set(a.sky).lerp(_biomeTmp.set(b.sky), t);
  scene.background = _biomeSky;        // background tracks the live sky color
  scene.fog.color.copy(_biomeSky);     // Fog keeps its own Color, so copy into it
  scene.fog.near = mix(a.fogNear, b.fogNear);
  scene.fog.far  = mix(a.fogFar,  b.fogFar);

  hemiLight.color.set(a.hemiSky).lerp(_biomeTmp.set(b.hemiSky), t);
  hemiLight.groundColor.set(a.hemiGround).lerp(_biomeTmp.set(b.hemiGround), t);
  hemiLight.intensity = mix(a.hemiInt, b.hemiInt);

  sunLight.color.set(a.sunColor).lerp(_biomeTmp.set(b.sunColor), t);
  sunLight.intensity = mix(a.sunInt, b.sunInt);

  grassMat.color.set(a.grass).lerp(_biomeTmp.set(b.grass), t);

  nightFactor = mix(a.night, b.night);
  _matHead.emissiveIntensity = 0.9 + nightFactor * 1.7; // lamps burn brighter after dark
  _matTail.emissiveIntensity = 0.9 + nightFactor * 1.1;

  const dom = (t < 0.5 ? a : b).name;
  if (dom !== biomeShown) showBiome(dom);
}

// Briefly name the biome we just crossed into, top-center on the HUD.
function showBiome(name) {
  biomeShown = name;
  const el = document.getElementById("biome");
  if (!el) return;
  el.textContent = name;
  el.classList.remove("flash");
  void el.offsetWidth;          // restart the entrance animation
  el.classList.add("flash");
}

function render() {
  if (!ready3d) return;

  applyBiome(state.position / DIST_DIV);
  roadTex.offset.y = -(state.position * Z_SCALE) * (70 / ROAD_LEN); // scroll markings

  reconcile(trafficGroup, traffic, (o) => buildProceduralCar(o.color), placeOnRoad);
  reconcile(sceneryGroup, scenery, makeScenery, (o) => {
    placeOnRoad(o);
    o.mesh.rotation.y = o.lx < 0 ? 0.3 : -0.3;
  });

  if (playerMesh) {
    playerMesh.position.set(worldX(state.playerX), 0, 0);
    playerMesh.rotation.z = -state.playerVX * 6; // lean into the steering
    playerMesh.rotation.y = -state.playerVX * 3; // slight yaw
  }

  // Speed sells itself: FOV widens with pace, the camera shakes a touch at
  // speed, and jolts on a near-miss / sideswipe.
  const sf = clamp(state.speed / state.maxSpeed, 0, 1);
  camera.fov += (CAM_FOV + sf * 10 - camera.fov) * 0.1;
  camera.updateProjectionMatrix();
  const shake = state.flash * 0.25 + state.shake * 0.6 + sf * 0.03;
  camera.position.x = state.playerX * 1.4 + (Math.random() - 0.5) * shake;
  camera.position.y = 4.3 + (Math.random() - 0.5) * shake * 0.5;
  camera.lookAt(state.playerX * 2.2, 1.2, -26);

  renderer.render(scene, camera);
  drawFx(sf);
}

// 2D overlay: hit flash, speed streaks, near-miss flash, score popups.
function drawFx(sf = 0) {
  fxCtx.clearRect(0, 0, fx.width, fx.height);

  if (state.hitFlash > 0.02) { // red on a sideswipe
    fxCtx.fillStyle = `rgba(255,40,40,${state.hitFlash * 0.35})`;
    fxCtx.fillRect(0, 0, fx.width, fx.height);
  }

  if (sf > 0.55) { // radial speed streaks
    const a = (sf - 0.55) / 0.45;
    fxCtx.strokeStyle = `rgba(255,255,255,${0.1 * a})`;
    fxCtx.lineWidth = 2;
    const cx = fx.width / 2, cy = fx.height * 0.42;
    for (let i = 0; i < 14; i++) {
      const ang = (i / 14) * Math.PI * 2 + state.position * 0.001;
      const r0 = 120 + (i % 3) * 30, r1 = r0 + 60 + a * 130;
      fxCtx.beginPath();
      fxCtx.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0);
      fxCtx.lineTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
      fxCtx.stroke();
    }
  }

  if (state.flash > 0.02) { // gold near-miss border
    fxCtx.strokeStyle = `rgba(255,209,102,${state.flash * 0.7})`;
    fxCtx.lineWidth = 10;
    fxCtx.strokeRect(5, 5, fx.width - 10, fx.height - 10);
  }

  fxCtx.textAlign = "center";
  fxCtx.font = "bold 18px 'Segoe UI', sans-serif";
  for (const pop of popups) {
    fxCtx.globalAlpha = clamp(pop.life, 0, 1);
    fxCtx.fillStyle = pop.color;
    fxCtx.fillText(pop.text, pop.x, pop.y);
  }
  fxCtx.globalAlpha = 1;
}

// Freeze the game while a mobile player holds the device in portrait.
function isBlocked() {
  return document.body.classList.contains("touch") &&
    window.matchMedia("(orientation: portrait)").matches;
}

// ---- Loop ----
function loop() {
  if (!state.running) return;
  if (!isBlocked()) update();
  if (state.running) render();
  requestAnimationFrame(loop);
}

// Idle "hero" loop for the home screen: the road drifts and the selected car
// sits in view behind a light overlay, so the title screen feels alive.
let idleActive = false, idleRAF = 0;
function startIdle() {
  if (idleActive || !ready3d) return;
  if (playerCarId !== selectedCar) setPlayerCar(getCar(selectedCar));
  idleActive = true;
  idleLoop();
}
function stopIdle() {
  idleActive = false;
  if (idleRAF) cancelAnimationFrame(idleRAF);
}
function idleLoop() {
  if (!idleActive) return;
  state.flash = state.hitFlash = state.shake = 0; // no leftover crash FX on the home screen
  state.position += 6;     // gentle drift
  state.speed = 0;
  updateScenery();
  render();
  idleRAF = requestAnimationFrame(idleLoop);
}

// ---- State transitions ----
function resetRunState() {
  state.score = 0;
  state.position = 0;
  state.speed = 0;
  state.maxSpeed = 60;
  state.playerX = 0;
  state.playerVX = 0;
  state.lastSpawnPos = 0;
  state.nextSceneryZ = 0;
  state.flash = state.hitFlash = state.shake = 0;
  state.combo = 0; state.comboTimer = 0; state.mult = 1;
  state.maxCombo = 0; state.passed = 0; state.topSpeed = 0;
  traffic = [];
  scenery = [];
  popups = [];
}

function startGame() {
  ensureAudio();
  stopIdle();
  activeCar = getCar(selectedCar);
  activeStats = effStats(activeCar);
  setEngineProfile(activeCar);
  setPlayerCar(activeCar);
  resetRunState();
  state.running = true;
  document.body.classList.add("playing");
  document.getElementById("overlay").classList.add("hidden");
  document.getElementById("results").classList.add("hidden");
  updateHUD();
  loop();
}

function gameOver() {
  if (!state.running) return;
  state.running = false;
  if (audio) audio.engineGain.gain.setTargetAtTime(0, audio.ac.currentTime, 0.1);
  audioCrash();
  state.shake = 1.6;
  render(); // one shaken, frozen frame for impact

  // Score is the bragging number; credits earned are a fraction of it.
  lastEarned = Math.round(state.score * CREDIT_RATE);
  bank += lastEarned;
  const isHi = state.score > highScore;
  if (isHi) highScore = state.score;
  saveProgress();

  setTimeout(() => showResults(isHi), 550); // a beat before the results card
}

const RANKS = [
  { min: 12000, label: "S" }, { min: 7000, label: "A" },
  { min: 3500, label: "B" }, { min: 1500, label: "C" }, { min: 0, label: "D" },
];
const rankFor = (score) => RANKS.find((r) => score >= r.min);

function showResults(isHi) {
  const r = rankFor(state.score);
  const el = document.getElementById("results");
  const stat = (k, v) => `<div class="rstat"><span>${k}</span><b>${v}</b></div>`;
  el.innerHTML = `
    <div class="results-card">
      <div class="results-rank rank-${r.label.toLowerCase()}">${r.label}</div>
      <h1 class="results-title">${isHi ? "NEW BEST!" : "Run Complete"}</h1>
      <div class="results-grid">
        ${stat("Score", fmt(state.score))}
        ${stat("Distance", (state.position / DIST_DIV).toFixed(1) + " km")}
        ${stat("Cars passed", state.passed)}
        ${stat("Best combo", "x" + comboMult(state.maxCombo))}
        ${stat("Top speed", Math.round(state.topSpeed * 3) + " km/h")}
        ${stat("Best ever", fmt(highScore))}
      </div>
      <div class="results-earn">+ <span class="cred">${CRED_ICO}<span class="cred-num" id="earn-num" data-val="0">0</span></span> CR earned</div>
      <div class="results-btns">
        <button id="retry-btn">Retry</button>
        <button id="r-garage" class="alt">Garage</button>
        <button id="r-home" class="alt">Home</button>
      </div>
    </div>
  `;
  el.classList.remove("hidden");
  document.body.classList.remove("playing");
  rollNumber(document.getElementById("earn-num"), lastEarned, 900);
  audioCoin();
  if (isHi) celebrateBest();
  pendingEarn = 0; // results already showed the earnings
  document.getElementById("retry-btn").addEventListener("click", startGame);
  document.getElementById("r-garage").addEventListener("click", () => { el.classList.add("hidden"); showMenu(); openGarage(); });
  document.getElementById("r-home").addEventListener("click", () => { el.classList.add("hidden"); showMenu(); });
}

function celebrateBest() {
  audioUnlock();
  const card = document.querySelector(".results-card");
  if (card) card.animate(
    [{ boxShadow: "0 0 0 rgba(255,209,102,0)" }, { boxShadow: "0 0 40px rgba(255,209,102,0.6)" }, { boxShadow: "0 0 0 rgba(255,209,102,0)" }],
    { duration: 1400, iterations: 2 }
  );
}

// ---- Currency (Credits) + UI helpers ----
let pendingEarn = 0; // credits earned on the last run, animated into the wallet
let lastEarned = 0;  // credits granted by the most recent run (shown on results)
const CRED_ICO = '<svg class="cred-ico" viewBox="0 0 24 24" aria-hidden="true"><use href="#cred-coin"/></svg>';
const fmt = (n) => Math.round(n).toLocaleString();
const credCost = (n) => `<span class="cred">${CRED_ICO}<span class="cred-num">${fmt(n)}</span></span>`;
const walletPill = (id) =>
  `<span class="wallet">${CRED_ICO}<span class="cred-num" ${id ? `id="${id}"` : ""} data-val="${bank}">${fmt(bank)}</span><span class="cred-cr">CR</span></span>`;

// Animate an element's number from its last value up/down to `to`.
function rollNumber(el, to, dur = 650) {
  if (!el) return;
  const from = Number(el.dataset.val || 0);
  el.dataset.val = to;
  if (from === to) { el.textContent = fmt(to); return; }
  const start = performance.now();
  (function step(now) {
    const k = Math.min(1, (now - start) / dur);
    const e = 1 - Math.pow(1 - k, 3); // easeOutCubic
    el.textContent = fmt(from + (to - from) * e);
    if (k < 1) requestAnimationFrame(step);
  })(performance.now());
}

// A small "+N" / "-N" label that floats up and fades from an anchor element.
function floatDelta(anchor, text, cls) {
  if (!anchor) return;
  const wrap = document.getElementById("game-wrapper");
  const a = anchor.getBoundingClientRect();
  const w = wrap.getBoundingClientRect();
  const el = document.createElement("div");
  el.className = "float-delta " + cls;
  el.textContent = text;
  el.style.left = (a.left - w.left + a.width / 2) + "px";
  el.style.top = (a.top - w.top) + "px";
  wrap.appendChild(el);
  el.animate(
    [{ transform: "translate(-50%,0)", opacity: 1 }, { transform: "translate(-50%,-44px)", opacity: 0 }],
    { duration: 950, easing: "ease-out" }
  ).onfinish = () => el.remove();
}

// "UNLOCKED" banner over the showroom when a car is bought.
function celebrate(name) {
  const host = document.querySelector(".showroom");
  if (!host) return;
  const b = document.createElement("div");
  b.className = "unlock-banner";
  b.innerHTML = `<span class="unlock-lead">UNLOCKED</span><span class="unlock-name">${name}</span>`;
  host.appendChild(b);
  b.animate([
    { opacity: 0, transform: "translate(-50%,-50%) scale(0.7)" },
    { opacity: 1, transform: "translate(-50%,-50%) scale(1.06)", offset: 0.25 },
    { opacity: 1, transform: "translate(-50%,-50%) scale(1)", offset: 0.8 },
    { opacity: 0, transform: "translate(-50%,-50%) scale(1.02)" },
  ], { duration: 1900, easing: "ease-out" }).onfinish = () => b.remove();
}

// ---- Menu + Garage UI ----
function showMenu() {
  const car = getCar(selectedCar);
  const overlay = document.getElementById("overlay");
  overlay.innerHTML = `
    <div class="home-top">
      <h1 class="home-logo">TRAFFIC <span>RACER</span></h1>
      <p class="home-stats">${walletPill("menu-credits")} &nbsp;·&nbsp; <span class="best">🏆 ${fmt(highScore)}</span> &nbsp;·&nbsp; <span class="best">🚗 ${owned.length}/${CARS.length}</span></p>
    </div>
    <div class="home-bottom">
      <p class="home-car">Now driving · <b style="color:${car.color}">${car.name}</b></p>
      <div class="menu-btns">
        <button id="start-btn">Start</button>
        <button id="garage-btn" class="alt">Garage</button>
      </div>
      <p class="controls">↑/W gas · ↓/S brake · ←→/AD steer · M mute</p>
    </div>
  `;
  overlay.classList.remove("hidden");
  document.body.classList.remove("playing");
  document.getElementById("start-btn").addEventListener("click", startGame);
  document.getElementById("garage-btn").addEventListener("click", openGarage);
  startIdle(); // bring the hero car / road to life behind the menu
}

function statBars(c) {
  // Bars + numbers for the car's current (upgraded) stats. Scale headroom
  // covers a fully-upgraded top car so a maxed bar reads as full.
  const s = effStats(c);
  const r10 = (v, m) => (clamp(v / m, 0, 1) * 10).toFixed(1);
  const bar = (label, val, m, text) => {
    const pct = Math.round(clamp(val / m, 0, 1) * 100);
    return `<div class="stat"><span class="stat-k">${label}</span><div class="bar"><i style="width:${pct}%"></i></div><span class="stat-v">${text}</span></div>`;
  };
  return bar("ACC", s.accel, STAT_CEIL.accel, r10(s.accel, STAT_CEIL.accel))
    + bar("SPD", s.maxSpeed, STAT_CEIL.maxSpeed, Math.round(s.maxSpeed * 3) + " km/h")
    + bar("HND", s.handling, STAT_CEIL.handling, r10(s.handling, STAT_CEIL.handling));
}

function gainText(c, track) {
  if (track.key === "speed") return `+${Math.round(c.maxSpeed * 0.08 * 3)} km/h`;
  if (track.key === "engine") return `+12% accel`;
  return `+8% grip`;
}

function upgradeRowHTML(c, track) {
  const lvl = upgrades[c.id][track.key];
  const pips = Array.from({ length: UPG_MAX },
    (_, i) => `<span class="pip ${i < lvl ? "on" : ""}"></span>`).join("");
  let btn, hint = "";
  if (lvl >= UPG_MAX) {
    btn = `<span class="tag sel">MAX</span>`;
  } else {
    const cost = upgradeCost(c, lvl);
    btn = `<button class="upg-btn" data-car="${c.id}" data-track="${track.key}" ${bank < cost ? "disabled" : ""}>+ ${credCost(cost)}</button>`;
    hint = `<span class="upg-gain">${gainText(c, track)}</span>`;
  }
  return `<div class="upg-row"><span class="upg-label">${track.label}${hint}</span><div class="pips">${pips}</div>${btn}</div>`;
}

// ---- Garage showroom: one rotating 3D car on a lit podium ----
let garageOpen = false;
let garageBuilt = false;
let garageIndex = 0;
let pvScene, pvCam, pvRenderer, pvCanvas, pvCar = null, pvRAF = 0, pvAngle = 0, pvSpin = 0;
let pvRing, pvPodium, pvMirror, pvSpot, pvHemi;
let pvW = 0, pvH = 0;

function initGaragePreview() {
  pvCanvas = document.getElementById("preview");
  pvRenderer = new THREE.WebGLRenderer({ canvas: pvCanvas, antialias: true, alpha: true });
  pvRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  pvScene = new THREE.Scene();
  pvCam = new THREE.PerspectiveCamera(38, 1.7, 0.1, 100);
  pvCam.position.set(4.6, 2.4, 6.6); // hero ¾ angle
  pvCam.lookAt(0, 0.65, 0);

  pvHemi = new THREE.HemisphereLight(0xadecff, 0x14161c, 1.1); pvScene.add(pvHemi);
  const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(6, 9, 5); pvScene.add(key);
  const rim = new THREE.DirectionalLight(0x5fa8ff, 1.1); rim.position.set(-7, 3, -5); pvScene.add(rim);

  pvPodium = new THREE.Mesh(
    new THREE.CylinderGeometry(3.3, 3.6, 0.4, 56),
    new THREE.MeshStandardMaterial({ color: 0x14161f, metalness: 0.7, roughness: 0.28 })
  );
  pvPodium.position.y = -0.2; pvScene.add(pvPodium);

  pvRing = new THREE.Mesh( // glowing accent ring that takes the car's colour
    new THREE.RingGeometry(3.05, 3.4, 56),
    new THREE.MeshBasicMaterial({ color: 0x06d6a0, side: THREE.DoubleSide })
  );
  pvRing.rotation.x = -Math.PI / 2; pvRing.position.y = 0.015; pvScene.add(pvRing);

  // Premium reflective stage (used for high-tier cars only).
  pvMirror = new Reflector(new THREE.CircleGeometry(7, 64), {
    color: 0x70798a, textureWidth: 1024, textureHeight: 1024,
  });
  pvMirror.rotation.x = -Math.PI / 2;
  pvMirror.visible = false;
  pvScene.add(pvMirror);

  pvSpot = new THREE.SpotLight(0xffffff, 0, 40, Math.PI / 7, 0.5, 1.0);
  pvSpot.position.set(0, 14, 3);
  pvSpot.target.position.set(0, 0.6, 0);
  pvScene.add(pvSpot); pvScene.add(pvSpot.target);
}

// Dress the stage to the car's tier: clean podium for everyday cars, a
// reflective floor + spotlight for the high-end machines.
function setStage(car) {
  const tier = car.tier || 0;
  const lux = tier >= 4;  // Hyper / Apex get the reflective showcase
  const mid = tier >= 2;
  pvPodium.visible = !lux;
  pvRing.visible = !lux;
  pvMirror.visible = lux;
  pvSpot.intensity = lux ? 6 : 0;
  pvHemi.intensity = lux ? 0.5 : 1.1;
  pvRing.material.color.set(car.color);
  pvPodium.material.metalness = mid ? 0.85 : 0.6;
  pvPodium.material.roughness = mid ? 0.18 : 0.32;
}

function applySilhouette(obj) {
  obj.traverse((o) => { if (o.isMesh) o.material = _matSilhouette; });
}

function pvResize() {
  const w = pvCanvas.clientWidth || 1, h = pvCanvas.clientHeight || 1;
  if (w === pvW && h === pvH) return;
  pvW = w; pvH = h;
  pvRenderer.setSize(w, h, false);
  pvCam.aspect = w / h; pvCam.updateProjectionMatrix();
}

function setPreviewCar(car) {
  if (pvCar) { pvScene.remove(pvCar); pvCar = null; }
  const cached = modelCache[car.id];
  if (cached && cached !== "loading" && cached !== "failed") pvCar = cached.mesh.clone(true);
  else { pvCar = buildProceduralCar(car.color); loadCarModel(car); }
  if (!owned.includes(car.id)) applySilhouette(pvCar); // locked = blacked-out tease
  pvCar.rotation.y = pvAngle;
  pvScene.add(pvCar);
  setStage(car);
}

function pvLoop() {
  if (!garageOpen) return;
  pvResize();
  pvSpin *= 0.94;                       // celebratory spin decays back to idle
  pvAngle += 0.008 + pvSpin;
  if (pvCar) pvCar.rotation.y = pvAngle;
  pvRenderer.render(pvScene, pvCam);
  pvRAF = requestAnimationFrame(pvLoop);
}

function openGarage() {
  const g = document.getElementById("garage");
  if (!garageBuilt) {
    g.innerHTML = `
      <h2>Garage ${walletPill("garage-credits")}</h2>
      <div class="showroom">
        <button class="arrow" id="car-prev" aria-label="Previous car">‹</button>
        <canvas id="preview"></canvas>
        <button class="arrow" id="car-next" aria-label="Next car">›</button>
      </div>
      <div id="showroom-info"></div>
      <button id="garage-back">Back</button>
    `;
    initGaragePreview();
    document.getElementById("car-prev").addEventListener("click", () => navCar(-1));
    document.getElementById("car-next").addEventListener("click", () => navCar(1));
    document.getElementById("garage-back").addEventListener("click", closeGarage);
    garageBuilt = true;
  }
  g.classList.remove("hidden");
  stopIdle(); // the garage has its own preview renderer
  garageOpen = true;
  garageIndex = Math.max(0, CARS.findIndex((c) => c.id === selectedCar));
  updateGarageBank();
  refreshShowroom();
  pvResize();
  pvLoop();
}

function closeGarage() {
  garageOpen = false;
  if (pvRAF) cancelAnimationFrame(pvRAF);
  document.getElementById("garage").classList.add("hidden");
  startIdle(); // resume the home hero (also refreshes the car if it changed)
}

function navCar(dir) {
  garageIndex = (garageIndex + dir + CARS.length) % CARS.length;
  audioTick();
  refreshShowroom();
}

function updateGarageBank() {
  rollNumber(document.getElementById("garage-credits"), bank);
}

// Update the info panel + preview car for the focused car (canvas is reused).
function refreshShowroom() {
  const c = CARS[garageIndex];
  setPreviewCar(c);

  const isOwned = owned.includes(c.id);
  const isSel = selectedCar === c.id;
  const accent = RARITY_COLOR[c.tier] || c.color;

  let action;
  if (isSel) action = `<span class="tag sel">★ Selected</span>`;
  else if (isOwned) action = `<button class="alt car-btn" data-car="${c.id}">Select</button>`;
  else action = `<button class="car-btn buy" data-car="${c.id}" ${bank < c.price ? "disabled" : ""}>Buy ${credCost(c.price)}</button>`;

  const upg = isOwned
    ? `<div class="upgrades">${UPG_TRACKS.map((t) => upgradeRowHTML(c, t)).join("")}</div>`
    : `<p class="locked-note">🔒 Purchase to unlock tuning.</p>`;

  // Stage dressing reacts to tier; accent colour flows into CSS.
  const sr = document.querySelector(".showroom");
  if (sr) {
    sr.className = `showroom tier-${c.tier}${isOwned ? "" : " locked"}`;
    sr.style.setProperty("--accent", accent);
  }

  document.getElementById("showroom-info").innerHTML = `
    <div class="car-head">
      <span class="rarity" style="--rc:${accent}">${c.rarity}</span>
      <span class="owned-count">${owned.length}/${CARS.length} owned</span>
    </div>
    <div class="car-title" style="color:${c.color}">${c.name}</div>
    <p class="car-blurb">${c.blurb}</p>
    <div class="stats">${statBars(c)}</div>
    ${upg}
    <div class="showroom-actions">${action}</div>
  `;

  const info = document.getElementById("showroom-info");
  info.querySelectorAll(".car-btn").forEach((btn) =>
    btn.addEventListener("click", () => handleCarClick(btn.dataset.car)));
  info.querySelectorAll(".upg-btn").forEach((btn) =>
    btn.addEventListener("click", () => buyUpgrade(btn.dataset.car, btn.dataset.track)));
}

function buyUpgrade(carId, trackKey) {
  const c = getCar(carId);
  const lvl = upgrades[carId][trackKey];
  if (lvl >= UPG_MAX) { audioDenied(); return; }
  const cost = upgradeCost(c, lvl);
  const btn = document.querySelector(`.upg-btn[data-car="${carId}"][data-track="${trackKey}"]`);
  if (bank < cost) { audioDenied(); return; }
  bank -= cost;
  upgrades[carId][trackKey] = lvl + 1;
  if (carId === selectedCar) activeStats = effStats(c); // reflect immediately
  saveProgress();
  audioTick(); audioCoin();
  floatDelta(btn, `- ${fmt(cost)}`, "spend");
  updateGarageBank();
  refreshShowroom();
  showMenu(); // refresh wallet on the menu behind
}

function handleCarClick(id) {
  const c = getCar(id);
  if (owned.includes(id)) {
    selectedCar = id;
    audioTick();
  } else if (bank >= c.price) {
    const btn = document.querySelector(`.car-btn[data-car="${id}"]`);
    bank -= c.price;
    owned.push(id);
    selectedCar = id;
    audioUnlock();
    floatDelta(btn, `- ${fmt(c.price)}`, "spend");
    pvSpin = 0.42;        // celebratory spin of the new car
    celebrate(c.name);
  } else {
    audioDenied();
    return;
  }
  saveProgress();
  updateGarageBank();
  refreshShowroom();
  showMenu(); // refresh wallet/selected car behind
}

document.getElementById("mute").addEventListener("click", toggleMute);
loadProgress();
initThree();
showMenu();
render();
