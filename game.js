// Traffic Racer 3D — real-3D chase-cam driving game (Three.js + WebGL).
// You see your own car on the road, so you can judge lanes and gaps.
// Pass close to traffic at speed for big points.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Reflector } from "three/addons/objects/Reflector.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const canvas = document.getElementById("game");

// ---- World layout (real 3D, Three.js) ----
// 4 lanes across the carriageway (±1 = road edges); split into your direction
// and oncoming further down (see FWD_LANES / ONC_LANES).
const START_LANE = 0.25; // you begin in an inner lane, clear of oncoming traffic
const SPAWN_DZ = 6000;   // how far ahead (game-z units) traffic appears (deep enough to fade in behind the fog)
const ROAD_HALF_W = 9;   // world half-width of the asphalt (lx = ±1)
const ROAD_LEN = 660;    // world length of the road / ground meshes
const Z_SCALE = 0.055;   // world units per game-z unit (depth compression)
const ROAD_REPEAT = 50;  // lane-dash cycles down the road (lower = more spaced-out dashes)
const PLAYER_DZ = 138;   // game-z plane where you sit; passes/crashes register here

// game coords -> Three world coords
const worldX = (lx) => lx * ROAD_HALF_W;
const worldZ = (dz) => -(dz - PLAYER_DZ) * Z_SCALE; // your plane at z=0, ahead is -Z

const TRAFFIC_COLORS = ["#ef476f", "#06d6a0", "#118ab2", "#ffd166", "#9b5de5", "#f78c6b"];

// ---- Roadside scenery ----
const SIGN_COLORS = ["#2e7d32", "#1565c0", "#f9a825"]; // highway / info / warning
const SCENERY_STEP = 280; // average spacing between roadside objects (world units)

// ---- Driving feel ----
const ACCEL = 1.3;
const ENGINE_BRAKE = 0.5;
const BRAKE_BASE = 0.9; // brake decel per unit of a car's brake spec — better cars stop harder (see effStats)
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

// ---- Traffic modes ----
// One-way: five evenly-spaced lanes (incl. the center) all flow your direction.
// Two-way: the carriageway splits down the middle — you drive the right lanes,
// the left lanes carry oncoming traffic. Dipping left for a near miss pays big.
const ONEWAY_LANES = [-0.8, -0.4, 0, 0.4, 0.8]; // sorted left -> right, center filled
// Two-way: no middle slot. Each side's two lanes fill its half of the
// carriageway (quarter-points), so the inner lanes butt against the centerline.
// Parking on the line now sits inside the sideswipe band of every inner-lane car
// instead of a safe near-miss gap — no more free combo-farming down the middle.
const FWD_LANES = [0.25, 0.75];    // two-way: your direction (right side)
const ONC_LANES = [-0.25, -0.75];  // two-way: oncoming (left side)
const ONCOMING_BONUS = 1.8;      // near-miss score multiplier vs oncoming traffic
const LANE_CHANGE_RATE = 0.007;  // how fast a weaving car slides between its lanes (lower = gentler, more readable merge)
const SIGNAL_FRAMES = 95;        // blinker flashes this long before the merge starts (longer = more warning)
// Per-kind traffic: heavies are slower and a touch wider. halfW is added to the
// contact tolerances, so it MUST stay well under the 0.4 lane spacing or a heavy
// in the next lane over would falsely register contact (it's only the extra
// width vs a car, which is small — not the truck's whole body).
const VEHICLES = {
  car:   { speedF: 1.00, halfW: 0.00 },
  truck: { speedF: 0.60, halfW: 0.05 },
  bus:   { speedF: 0.70, halfW: 0.04 },
};

// ---- Cars you can unlock (the first one is intentionally weak) ----
// engine = { idle, rev: firing-rate range (Hz); growl: distortion; bass: sub level; bright: filter }
const CARS = [
  { id: "hatch", name: "City Hatch", color: "#9aa0a6", price: 0, accel: 0.42, maxSpeed: 46, handling: 0.8, brake: 0.75,
    tier: 0, rarity: "Standard", blurb: "Humble runabout — gentle pace, easy to place in traffic.",
    engine: { idle: 50, rev: 190, growl: 1.6, bass: 0.3, bright: 1.05 } },
  { id: "sedan", name: "Sport Sedan", color: "#3aa0ff", price: 2500, accel: 0.58, maxSpeed: 60, handling: 1.0, brake: 1.0,
    tier: 1, rarity: "Sport", blurb: "Balanced all-rounder with a willing, eager engine.",
    engine: { idle: 44, rev: 175, growl: 2.2, bass: 0.5, bright: 1.0 } },
  { id: "muscle", name: "Muscle", color: "#ef476f", price: 7000, accel: 0.78, maxSpeed: 72, handling: 1.08, brake: 1.25,
    tier: 2, rarity: "Muscle", blurb: "Brutal low-end shove — thrilling, a handful up top.",
    engine: { idle: 34, rev: 150, growl: 3.4, bass: 0.85, bright: 0.95 } },
  { id: "gt", name: "GT Coupe", color: "#ffd166", price: 16000, accel: 0.95, maxSpeed: 84, handling: 1.22, brake: 1.35,
    tier: 3, rarity: "GT", blurb: "Poised grand tourer — quick, composed, effortless.",
    engine: { idle: 46, rev: 200, growl: 2.8, bass: 0.6, bright: 1.2 } },
  { id: "super", name: "Hypercar", color: "#06d6a0", price: 35000, accel: 1.2, maxSpeed: 100, handling: 1.45, brake: 1.6,
    tier: 4, rarity: "Hyper", blurb: "Savage pace and razor reflexes for the brave.",
    engine: { idle: 38, rev: 220, growl: 3.6, bass: 0.95, bright: 1.3 } },
  { id: "velox", name: "Velox SVX", color: "#eceff5", price: 90000, accel: 1.5, maxSpeed: 120, handling: 1.6, brake: 1.8,
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
STAT_CEIL.braking = BRAKE_BASE * Math.max(...CARS.map((c) => c.brake)) * (1 + 0.08 * UPG_MAX);
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
  const handling = c.handling * (1 + 0.08 * u.handling);
  return {
    accel: c.accel * (1 + 0.12 * u.engine),
    maxSpeed: c.maxSpeed * (1 + 0.08 * u.speed),
    handling,
    // Brakes come from the car's own brake spec; the handling upgrade also sharpens them.
    braking: BRAKE_BASE * c.brake * (1 + 0.08 * u.handling),
  };
}

// ---- Persistent progress (localStorage) ----
let bank = 0;
let owned = ["hatch"];
let selectedCar = "hatch";
let ownedEnvs = ["plains"];  // unlocked driving environments (Plains is free)
let selectedEnv = "plains";  // the environment the next run takes place in
let trafficMode = "twoway"; // "oneway" (all lanes your way) | "twoway" (oncoming half)
let speedUnit = "kmh";      // "kmh" | "mph" — display only; internal units unchanged
let quality = "high";       // "high" | "low" — Low caps the render resolution for slow GPUs
const QUALITY_DPR = { high: 1.5, low: 1.0 }; // pixel-ratio cap per quality (fill-rate lever)
let highScore = 0;
let goals = null;  // daily goals:  { date, items:[{id,target,reward,progress,done}] } — see goals section
let weekly = null; // weekly goals: same shape, keyed by ISO-ish week, bigger targets/rewards

// Internal speed -> display number. 1 internal unit = 3 km/h; mph = km/h × 0.621371.
const SPEED_UNITS = { kmh: { factor: 3, label: "km/h" }, mph: { factor: 1.864113, label: "mph" } };
const spd = (internal) => Math.round(internal * SPEED_UNITS[speedUnit].factor);
const spdLabel = () => SPEED_UNITS[speedUnit].label;
let activeCar = CARS[0];
let upgrades = defaultUpgrades();
let activeStats = effStats(CARS[0]); // active car's upgraded stats, set on start

function loadProgress() {
  try {
    bank = parseInt(localStorage.getItem("tr_bank")) || 0;
    owned = JSON.parse(localStorage.getItem("tr_owned")) || ["hatch"];
    selectedCar = localStorage.getItem("tr_selected") || "hatch";
    ownedEnvs = JSON.parse(localStorage.getItem("tr_envs")) || ["plains"];
    selectedEnv = localStorage.getItem("tr_env") || "plains";
    trafficMode = localStorage.getItem("tr_mode") === "oneway" ? "oneway" : "twoway";
    speedUnit = localStorage.getItem("tr_unit") === "mph" ? "mph" : "kmh";
    quality = localStorage.getItem("tr_quality") === "low" ? "low" : "high";
    muted = localStorage.getItem("tr_muted") === "1";
    highScore = parseInt(localStorage.getItem("tr_hi")) || 0;
    upgrades = JSON.parse(localStorage.getItem("tr_upg")) || {};
    goals = JSON.parse(localStorage.getItem("tr_goals")) || null;
    weekly = JSON.parse(localStorage.getItem("tr_weekly")) || null;
  } catch (e) { /* use defaults */ }
  ensureGoals(); // (re)generate today's / this week's sets if missing or stale
  if (!owned.includes("hatch")) owned.push("hatch");
  if (!owned.includes(selectedCar)) selectedCar = "hatch";
  ownedEnvs = ownedEnvs.filter((id) => ENVIRONMENTS.some((e) => e.id === id));
  if (!ownedEnvs.includes("plains")) ownedEnvs.push("plains");
  if (!ownedEnvs.includes(selectedEnv)) selectedEnv = "plains";
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
    localStorage.setItem("tr_envs", JSON.stringify(ownedEnvs));
    localStorage.setItem("tr_env", selectedEnv);
    localStorage.setItem("tr_mode", trafficMode);
    localStorage.setItem("tr_unit", speedUnit);
    localStorage.setItem("tr_quality", quality);
    localStorage.setItem("tr_muted", muted ? "1" : "0");
    localStorage.setItem("tr_hi", highScore);
    localStorage.setItem("tr_upg", JSON.stringify(upgrades));
    localStorage.setItem("tr_goals", JSON.stringify(goals));
    localStorage.setItem("tr_weekly", JSON.stringify(weekly));
  } catch (e) { /* ignore */ }
}

// ---- Daily & weekly goals ----
// Two sets: dailies (small, refresh each calendar day) and weeklies (a long
// haul — mostly cumulative totals across many runs, far bigger rewards, refresh
// each week). Each set is picked deterministically from its period key so it's
// identical across reloads. Progress rolls in live during a run and at the end
// of every run; finishing one credits its reward instantly. "max" goals want a
// single best; "sum" goals accumulate over the period.
const DAILY_POOL = [
  { id: "dist", mode: "max", stat: (r) => r.distKm,
    tiers: [[5, 150], [8, 300], [12, 500]],
    fmt: (t) => `Drive ${t} km in a single run`,
    prog: (p, t) => `${Math.min(p, t).toFixed(1)} / ${t} km` },
  { id: "score", mode: "max", stat: (r) => r.score,
    tiers: [[5000, 150], [9000, 320], [15000, 550]],
    fmt: (t) => `Score ${fmt(t)} in a single run`,
    prog: (p, t) => `${fmt(Math.min(Math.floor(p), t))} / ${fmt(t)}` },
  { id: "passed", mode: "sum", stat: (r) => r.passed,
    tiers: [[120, 150], [220, 320], [350, 550]],
    fmt: (t) => `Pass ${t} cars today`,
    prog: (p, t) => `${Math.min(Math.floor(p), t)} / ${t}` },
  { id: "combo", mode: "max", stat: (r) => r.maxCombo,
    tiers: [[8, 150], [12, 320], [18, 550]],
    fmt: (t) => `Chain a ${t}-pass near-miss combo`,
    prog: (p, t) => `${Math.min(Math.floor(p), t)} / ${t}` },
  { id: "earn", mode: "sum", stat: (r) => r.earned,
    tiers: [[700, 120], [1400, 260], [2400, 450]],
    fmt: (t) => `Earn ${fmt(t)} CR today`,
    prog: (p, t) => `${fmt(Math.min(Math.floor(p), t))} / ${fmt(t)}` },
];
const WEEKLY_POOL = [
  { id: "wdist", mode: "sum", stat: (r) => r.distKm,
    tiers: [[100, 1200], [175, 2200], [300, 3500]],
    fmt: (t) => `Drive ${t} km total this week`,
    prog: (p, t) => `${Math.min(p, t).toFixed(0)} / ${t} km` },
  { id: "wpassed", mode: "sum", stat: (r) => r.passed,
    tiers: [[1200, 1200], [2200, 2200], [3500, 3500]],
    fmt: (t) => `Pass ${fmt(t)} cars this week`,
    prog: (p, t) => `${fmt(Math.min(Math.floor(p), t))} / ${fmt(t)}` },
  { id: "wearn", mode: "sum", stat: (r) => r.earned,
    tiers: [[12000, 1500], [22000, 2800], [38000, 4500]],
    fmt: (t) => `Earn ${fmt(t)} CR this week`,
    prog: (p, t) => `${fmt(Math.min(Math.floor(p), t))} / ${fmt(t)}` },
  { id: "wscore", mode: "max", stat: (r) => r.score,
    tiers: [[18000, 1800], [26000, 3000], [35000, 4500]],
    fmt: (t) => `Score ${fmt(t)} in a single run`,
    prog: (p, t) => `${fmt(Math.min(Math.floor(p), t))} / ${fmt(t)}` },
  { id: "wcombo", mode: "max", stat: (r) => r.maxCombo,
    tiers: [[25, 1800], [35, 3000], [50, 4500]],
    fmt: (t) => `Chain a ${t}-pass near-miss combo`,
    prog: (p, t) => `${Math.min(Math.floor(p), t)} / ${t}` },
];
const ALL_GOAL_TMPL = [...DAILY_POOL, ...WEEKLY_POOL];
const goalTmpl = (id) => ALL_GOAL_TMPL.find((g) => g.id === id);

// FNV-1a hash of the period key -> seed; mulberry32 for a stable shuffle.
function _goalSeed(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function _goalRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const _todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
const _weekStr = () => {
  const d = new Date();
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const week = Math.floor(((d - jan1) / 86400000 + jan1.getDay()) / 7);
  return `${d.getFullYear()}-W${week}`;
};

function genGoalSet(key, pool, count) {
  const rand = _goalRng(_goalSeed(key));
  const p = pool.slice();
  const items = [];
  while (items.length < count && p.length) {
    const t = p.splice(Math.floor(rand() * p.length), 1)[0];
    const [target, reward] = t.tiers[Math.floor(rand() * t.tiers.length)];
    items.push({ id: t.id, target, reward, progress: 0, done: false });
  }
  return { date: key, items };
}
function ensureGoals() {
  const today = _todayStr();
  if (!goals || goals.date !== today || !Array.isArray(goals.items)) goals = genGoalSet(today, DAILY_POOL, 3);
  const wk = _weekStr();
  if (!weekly || weekly.date !== wk || !Array.isArray(weekly.items)) weekly = genGoalSet(wk, WEEKLY_POOL, 3);
}
const allGoalItems = () => { ensureGoals(); return [...goals.items, ...weekly.items]; };

// Where a goal sits given a run-stats snapshot `r` (committed progress from
// earlier runs + this run so far). "sum" goals add the run; "max" goals take
// whichever is bigger.
function goalLiveValue(it, t, r) {
  const runVal = t.stat(r) || 0;
  return t.mode === "sum" ? it.progress + runVal : Math.max(it.progress, runVal);
}
function _liveCheckSet(set, r) {
  if (!set) return;
  for (const it of set.items) {
    if (it.done) continue;
    const t = goalTmpl(it.id);
    if (t && goalLiveValue(it, t, r) >= it.target) {
      it.done = true;
      it.progress = it.target;
      bank += it.reward;
      saveProgress();
      goalToast(it);
    }
  }
}

// During a run, fire a toast + reward the instant a goal is met. endRun's
// trackGoals skips done goals, so nothing is credited or committed twice. Runs
// every physics step, so it builds the stats snapshot once (no per-goal allocs)
// and reads the already-ensured sets directly.
function checkGoalsLive() {
  const r = {
    distKm: state.position / DIST_DIV,
    score: state.score,
    passed: state.passed,
    maxCombo: state.maxCombo,
    earned: Math.round(state.score * CREDIT_RATE),
  };
  _liveCheckSet(goals, r);
  _liveCheckSet(weekly, r);
}

// Roll a finished run's stats into the goals; returns the goals just completed.
function trackGoals() {
  const r = {
    distKm: state.position / DIST_DIV,
    score: state.score,
    passed: state.passed,
    maxCombo: state.maxCombo,
    earned: lastEarned,
  };
  const done = [];
  for (const it of allGoalItems()) {
    if (it.done) continue;
    const t = goalTmpl(it.id);
    if (!t) continue;
    const v = t.stat(r) || 0;
    it.progress = t.mode === "sum" ? it.progress + v : Math.max(it.progress, v);
    if (it.progress >= it.target) { it.done = true; bank += it.reward; done.push(it); }
  }
  return done;
}

// ---- Toasts ----
// Transient top-center cards (e.g. a goal completing mid-run). Auto-dismiss.
function showToast(inner, cls = "") {
  const wrap = document.getElementById("toasts");
  if (!wrap) return;
  const el = document.createElement("div");
  el.className = "toast " + cls;
  el.innerHTML = inner;
  wrap.appendChild(el);
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 400); }, 2600);
}
function goalToast(it) {
  const t = goalTmpl(it.id);
  showToast(
    `<span class="toast-ico">✓</span>` +
    `<div class="toast-body"><b>Goal complete</b><span>${t.fmt(it.target)}</span></div>` +
    `<span class="toast-rew">${CRED_ICO}${it.reward}</span>`,
    "goal"
  );
  audioUnlock();
}

// ---- State ----
const state = {
  running: false,
  score: 0,
  position: 0,
  speed: 0,
  maxSpeed: 60,
  playerX: START_LANE,
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

// ---- Environments -------------------------------------------------------
// You PICK one environment to drive in (free Plains by default, the rest bought
// with credits — see the Environments screen). Each is a self-contained world:
// a `scape` (roadside prop palette, see spawnScenery) plus a `day` and `night`
// param block that the engine blends between as you drive. Day<->night rides on
// the distance you've covered (DAYNIGHT_CYCLE_KM per full lap); `startNight`
// flips the phase so a run opens after dark, and `nightOnly` pins it to night
// (Neon Paradise is always lit). Each param block carries:
//   sky/fog colour + range, hemi + sun lights, and grass = the ground colour
//   (so it doubles as sand / asphalt / neon-slick tarmac per environment).
const DAYNIGHT_CYCLE_KM = 12;   // distance for one full day->night->day lap
const ENVIRONMENTS = [
  { id: "plains", name: "Plains", scape: "plains", price: 0,
    blurb: "Rolling green country roads. Where every driver starts out.",
    day: { sky: 0x86c8e8, fogNear: 70, fogFar: 380, hemiSky: 0xbfe3ff, hemiGround: 0x4a6b3a, hemiInt: 1.0, sunColor: 0xfff1da, sunInt: 1.0, grass: 0x2f9e44 },
    night: { sky: 0x050811, fogNear: 48, fogFar: 290, hemiSky: 0x2b3a64, hemiGround: 0x06080f, hemiInt: 0.6, sunColor: 0xaec2ff, sunInt: 0.85, grass: 0x10331e } },
  { id: "desert", name: "Desert", scape: "desert", price: 5000, dayOnly: true,
    blurb: "Sun-baked dunes and saguaro under an endless warm afternoon sky.",
    day: { sky: 0xf2c879, fogNear: 95, fogFar: 440, hemiSky: 0xffe6b0, hemiGround: 0x9c6b3f, hemiInt: 1.05, sunColor: 0xfff0d0, sunInt: 1.2, grass: 0xc9a063 } },
  { id: "city", name: "City", scape: "city", price: 15000, startNight: true,
    blurb: "Glass towers and streetlights. The night shift never really ends.",
    day: { sky: 0x9fb6cf, fogNear: 60, fogFar: 340, hemiSky: 0xd5e3f0, hemiGround: 0x4a4d57, hemiInt: 1.0, sunColor: 0xfff4e2, sunInt: 1.0, grass: 0x44474f },
    night: { sky: 0x0e1020, fogNear: 55, fogFar: 300, hemiSky: 0x3a3f63, hemiGround: 0x141620, hemiInt: 0.6, sunColor: 0x9fb0ff, sunInt: 0.6, grass: 0x23252d } },
  { id: "neon", name: "Neon Paradise", scape: "neon", price: 40000, nightOnly: true,
    blurb: "Endless electric night. Pure glow, no sunrise — the dream lives here.",
    night: { sky: 0x0a0618, fogNear: 48, fogFar: 300, hemiSky: 0x3a1f6b, hemiGround: 0x0a0618, hemiInt: 0.5, sunColor: 0xb070ff, sunInt: 0.55, grass: 0x140b26 } },
];
const getEnv = (id) => ENVIRONMENTS.find((e) => e.id === id) || ENVIRONMENTS[0];

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

// The sound of a car blowing past: filtered noise whose pitch doppler-shifts up
// as it nears then drops as it recedes, volume swelling at the moment it's
// alongside, the whole thing sweeping across the stereo field.
function audioWhoosh(panVal, intensity) {
  if (!audio || intensity <= 0.01) return;
  const t = audio.ac.currentTime;
  const dur = 0.42;
  const peak = t + dur * 0.4;            // the instant it's right beside you
  const src = audio.ac.createBufferSource();
  src.buffer = audio.noiseBuffer;
  src.loop = true;

  // Bandpass gives it a wind/tyre-roar body; sweep = doppler (rise then fall).
  const bp = audio.ac.createBiquadFilter();
  bp.type = "bandpass";
  bp.Q.value = 1.1;
  bp.frequency.setValueAtTime(360, t);
  bp.frequency.exponentialRampToValueAtTime(1100, peak);
  bp.frequency.exponentialRampToValueAtTime(300, t + dur);
  // Roll off the hiss so it reads as "air", not "static".
  const lp = audio.ac.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 2600;

  const g = audio.ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.7 * intensity, peak); // swell as it arrives
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);       // fade as it leaves
  src.connect(bp).connect(lp).connect(g);

  if (audio.ac.createStereoPanner) {
    const pan = audio.ac.createStereoPanner();
    const side = clamp(panVal, -1, 1) || 0.5;
    pan.pan.setValueAtTime(side, t);                 // starts on the car's side
    pan.pan.linearRampToValueAtTime(-side * 0.7, t + dur); // sweeps past behind you
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
  saveProgress();
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
    case "f": case "F": toggleFps(); break; // perf overlay (fps / frame time / draw calls)
    case "p": case "P": case "Escape": togglePause(); break; // pause / resume (Quit to Home lives in the menu)
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

// ---- Touch controls (mobile) ----
// Hold buttons that emulate the arrow keys: ◀ ▶ steer, GAS accelerates, BRAKE
// brakes. Separate elements mean multitouch (steer + gas at once) just works,
// and touch events stay with their start element so sliding a finger off still
// releases cleanly.
if (window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window) {
  document.body.classList.add("touch");
}
function holdButton(id, key) {
  const el = document.getElementById(id);
  if (!el) return;
  const set = (v) => { keys[key] = v; };
  const press = (e) => { e.preventDefault(); set(true); };
  const release = (e) => { if (e.cancelable) e.preventDefault(); set(false); };
  el.addEventListener("touchstart", press, { passive: false });
  el.addEventListener("touchend", release);
  el.addEventListener("touchcancel", release);
  el.addEventListener("mousedown", press);
  el.addEventListener("mouseup", release);
  el.addEventListener("mouseleave", () => set(false));
}
holdButton("btn-left", "left");
holdButton("btn-right", "right");
holdButton("btn-gas", "up");
holdButton("btn-brake", "down");

// ---- Traffic ----
// Mostly cars, with the occasional heavy. Oncoming keeps fewer heavies so the
// fast-closing side stays readable.
function pickKind(dir) {
  const r = Math.random();
  if (dir < 0) return r < 0.10 ? "truck" : r < 0.17 ? "bus" : "car";
  return r < 0.15 ? "truck" : r < 0.26 ? "bus" : "car";
}
// Lanes flowing your way: all four in one-way mode, the right pair in two-way.
function fwdLanes() { return trafficMode === "oneway" ? ONEWAY_LANES : FWD_LANES; }
// The set of lanes a vehicle can weave within (its own carriageway).
function laneGroupOf(car) {
  if (car.dir < 0) return ONC_LANES;
  return trafficMode === "oneway" ? ONEWAY_LANES : FWD_LANES;
}
// A random lane immediately adjacent to `lane` within its group (or itself).
function adjacentLane(lane, group) {
  const i = group.indexOf(lane);
  const opts = [];
  if (i > 0) opts.push(group[i - 1]);
  if (i < group.length - 1) opts.push(group[i + 1]);
  return opts.length ? opts[Math.floor(Math.random() * opts.length)] : lane;
}

function spawnVehicle(lane, dir) {
  const z = state.position + SPAWN_DZ;
  // Don't drop a vehicle on top of one already heading the same way in this lane.
  for (const c of traffic) {
    if (c.lane === lane && c.dir === dir && Math.abs(c.z - z) < TRAFFIC_GAP * 1.6) return;
  }
  const kind = pickKind(dir);
  const v = VEHICLES[kind];
  // Everyone keeps moving — slowest is still half of top traffic speed.
  const base = TRAFFIC_MAX_SPEED * (TRAFFIC_MIN_FACTOR + (1 - TRAFFIC_MIN_FACTOR) * Math.random());
  traffic.push({
    lane, lx: lane, z, dir, kind,
    halfW: v.halfW,
    prevDz: SPAWN_DZ,
    speed: base * v.speedF,
    color: TRAFFIC_COLORS[Math.floor(Math.random() * TRAFFIC_COLORS.length)],
    changeCD: 90 + Math.floor(Math.random() * 180), // frames until it may weave
    signalDir: 0,      // world side it's signaling (-1 left, +1 right, 0 none)
    signalTimer: 0,    // frames of blinker left before the merge commits
    targetLane: null,  // lane it intends to merge into
  });
}

function spawnWave() {
  const fl = fwdLanes();
  if (trafficMode === "oneway") {
    // Classic: 1–3 cars across the four lanes, always leaving a gap to thread.
    const lanes = [...fl];
    let count = 1;
    if (Math.random() < Math.min(0.6, state.position / 40000)) count++;
    if (Math.random() < Math.min(0.35, state.position / 80000)) count++;
    count = Math.min(count, fl.length - 2);
    for (let n = 0; n < count; n++)
      spawnVehicle(lanes.splice(Math.floor(Math.random() * lanes.length), 1)[0], 1);
    return;
  }
  // Two-way: one forward vehicle (so a forward lane is always threadable), plus
  // a chance of oncoming whose density ramps with distance.
  spawnVehicle(fl[Math.floor(Math.random() * fl.length)], 1);
  const oncChance = Math.min(0.75, 0.25 + state.position / 50000);
  if (Math.random() < oncChance)
    spawnVehicle(ONC_LANES[Math.floor(Math.random() * ONC_LANES.length)], -1);
}

function addPopup(x, y, text, color) {
  popups.push({ x, y, text, color, life: 1 });
}

// Car-following: within each lane, a faster car can't drive through the car
// ahead. It closes the gap, then matches the leader's speed (like real traffic).
function resolveTrafficFollowing() {
  const lanes = new Map();
  for (const car of traffic) {
    const key = car.dir + ":" + car.lane; // each carriageway lane queues on its own
    if (!lanes.has(key)) lanes.set(key, []);
    lanes.get(key).push(car);
  }
  for (const list of lanes.values()) {
    // Sort back -> front along the direction of travel (forward = +z, oncoming = -z).
    list.sort((a, b) => (a.z - b.z) * a.dir);
    for (let i = list.length - 2; i >= 0; i--) {
      const behind = list[i], ahead = list[i + 1];
      if ((ahead.z - behind.z) * ahead.dir < TRAFFIC_GAP) {
        behind.z = ahead.z - ahead.dir * TRAFFIC_GAP;
        behind.speed = Math.min(behind.speed, ahead.speed); // don't accelerate into it
      }
    }
  }
}

// Cars occasionally slide to the other lane in their carriageway; heavies don't
// weave. A merge runs in three beats: signal (blinker only) -> commit -> glide.
// True only if `lane` has room around this car's z for it to slot in without the
// follower having to snap anyone's z to de-overlap (that snap is what made merges
// look like teleporting). We check both a car's committed lane and where it's
// visually sitting, so we don't merge on top of someone mid-merge either.
function laneClearForMerge(car, lane) {
  for (const c of traffic) {
    if (c === car || c.dir !== car.dir) continue;
    const occupies = c.lane === lane || Math.abs(c.lx - lane) < 0.2;
    if (occupies && Math.abs(c.z - car.z) < TRAFFIC_GAP * 1.3) return false;
  }
  return true;
}

function updateLaneChange(car) {
  if (car.kind !== "car") return;

  // Mid-merge: glide toward the committed lane; blinker stays on until arrival.
  if (car.lx !== car.lane) {
    const d = car.lane - car.lx;
    car.lx = Math.abs(d) <= LANE_CHANGE_RATE ? car.lane : car.lx + Math.sign(d) * LANE_CHANGE_RATE;
    if (car.lx === car.lane) { car.signalDir = 0; car.targetLane = null; } // arrived
    return;
  }

  // Signaling: flash the blinker a beat, then commit so the glide can begin —
  // but only if the gap is still there. Otherwise abandon the merge cleanly
  // (no snap into an occupied lane) and try again later.
  if (car.signalTimer > 0) {
    if (--car.signalTimer === 0) {
      if (laneClearForMerge(car, car.targetLane)) car.lane = car.targetLane;
      else { car.signalDir = 0; car.targetLane = null; }
    }
    return;
  }

  // Idle: maybe pick a neighbour lane and start signaling toward it.
  if (--car.changeCD <= 0) {
    car.changeCD = 120 + Math.floor(Math.random() * 180);
    const dz = car.z - state.position;
    const lead = car.dir < 0 ? 1600 : 950; // extra lead so the longer signal + slower glide still finishes well ahead
    const dest = adjacentLane(car.lane, laneGroupOf(car));
    if (dz > lead && dest !== car.lane && laneClearForMerge(car, dest) && Math.random() < 0.5) {
      car.targetLane = dest;
      car.signalDir = Math.sign(dest - car.lane); // +lx is world-right
      car.signalTimer = SIGNAL_FRAMES;
    }
  }
}

// ---- Roadside scenery ----
// Each region's roadside palette: prop types with relative weights. The scape
// is picked from the biome ring at the spawn distance (scapeAt), so the props
// match the ground they land on as the world cycles through regions.
const SCAPES = {
  plains: [["tree", 78], ["sign", 22]],
  desert: [["cactus", 60], ["rock", 28], ["sign", 12]],
  city:   [["building", 56], ["streetlight", 30], ["sign", 14]],
  neon:   [["neonbuild", 54], ["streetlight", 26], ["neonsign", 20]],
};
function pickType(scape) {
  const table = SCAPES[scape] || SCAPES.plains;
  let total = 0; for (const e of table) total += e[1];
  let r = Math.random() * total;
  for (const [type, w] of table) { if ((r -= w) < 0) return type; }
  return table[0][0];
}

function spawnScenery(z) {
  const side = Math.random() < 0.5 ? -1 : 1;
  const scape = scapeAt(z / DIST_DIV);
  const type = pickType(scape);
  const o = {
    z, type,
    sizeVar: 0.8 + Math.random() * 0.5,
    color: SIGN_COLORS[Math.floor(Math.random() * SIGN_COLORS.length)],
    rot: Math.random() * Math.PI * 2,   // default: free spin (trees/cactus/rocks)
  };
  switch (type) {
    case "building":
    case "neonbuild": {
      // Footprint + height in world units; placed so the inner face clears the
      // asphalt (worldX = lx*ROAD_HALF_W), and pushed a little further out.
      o.w = 6 + Math.random() * 8;
      o.d = 6 + Math.random() * 8;
      o.h = (type === "neonbuild" ? 7 : 9) + Math.random() * (type === "neonbuild" ? 22 : 32);
      o.colorIdx = Math.floor(Math.random() * 5);
      o.lx = side * ((ROAD_HALF_W + 1 + o.w / 2) / ROAD_HALF_W + Math.random() * 0.7);
      o.rot = (Math.random() - 0.5) * 0.4;   // slight yaw jitter, roughly road-aligned
      break;
    }
    case "streetlight":
      o.lx = side * 1.12;                    // hug the verge; the arm reaches over the road
      o.rot = side < 0 ? 0 : Math.PI;        // arm (+x local) points toward road center
      break;
    case "sign":
    case "neonsign":
      o.lx = side * (1.15 + Math.random() * 0.25);
      o.rot = side < 0 ? 0.3 : -0.3;         // angle the board toward the driver
      break;
    default: // tree / cactus / rock
      o.lx = side * (1.15 + Math.random() * 0.8);
  }
  scenery.push(o);
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
  input.steer = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  input.throttle = keys.up ? 1 : 0;
  input.brake = keys.down ? 1 : 0;

  // Top speed comes from your car, with a small bonus the farther you get.
  state.maxSpeed = activeStats.maxSpeed + Math.min(18, Math.floor(state.position / 10000) * 6);

  // Forward speed. Engine power tapers as you near top speed (so the last
  // stretch takes effort), but keeps a floor so the stated top speed is
  // actually reachable instead of stalling out well below it.
  if (input.throttle > 0) {
    const accelFade = Math.max(0.2, 1 - Math.pow(state.speed / state.maxSpeed, 2));
    state.speed += activeStats.accel * input.throttle * accelFade;
  } else state.speed -= ENGINE_BRAKE;
  if (input.brake > 0) state.speed -= activeStats.braking * input.brake;
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

  // Advance traffic (oncoming travels toward you), weave, then de-overlap lanes.
  for (const car of traffic) { car.z += car.speed * car.dir; updateLaneChange(car); }
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

      const tol = car.halfW;                    // heavies are wider, so contact sooner
      if (lateral < HARD_TOLERANCE + tol) {     // near head-on -> crash
        gameOver();
        return;
      } else if (lateral < LANE_TOLERANCE + tol) { // sideswipe -> survive, but punished
        sideswipe(pan);
      } else {                                  // clean pass
        state.passed++;
        const lo = LANE_TOLERANCE + tol;        // inner edge of the near-miss band
        let closeness = 0;
        if (lateral < NEAR_MISS_RANGE) {        // near miss: build the combo
          closeness = clamp(1 - (lateral - lo) / (NEAR_MISS_RANGE - lo), 0, 1);
          state.combo++;
          state.maxCombo = Math.max(state.maxCombo, state.combo);
          state.comboTimer = COMBO_WINDOW;
          state.mult = comboMult(state.combo);
          const onc = car.dir < 0 ? ONCOMING_BONUS : 1; // threading oncoming pays more
          const pts = Math.round((40 + closeness * 200) * (0.35 + 0.65 * speedFactor) * onc) * state.mult;
          state.score += pts;
          const tag = state.mult > 1 ? `x${state.mult} +${pts}` : `+${pts}`;
          if (car.dir < 0 && closeness > 0.4) {
            addPopup(sp.x, sp.y, "ONCOMING! " + tag, "#ff6b6b");
            state.flash = Math.max(state.flash, Math.max(closeness, 0.6));
          } else if (closeness > 0.6 && speedFactor > 0.6) {
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
  checkGoalsLive(); // celebrate the moment a daily goal is met, mid-run
  // NOTE: HUD + engine audio are presentation, not physics. They run once per
  // rendered frame from loop(), never inside this (possibly multi-step) update.
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
    spdUnit: document.querySelector(".spd-unit"),
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
  hud.speed.textContent = spd(state.speed);
  if (hud.spdUnit) hud.spdUnit.textContent = spdLabel();
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
let roadTexOne, roadTexTwo, roadMat; // one-way / two-way road textures + shared material
let _blinkOn = true; // shared on/off phase so all active turn signals flash in sync

// Point the road at the texture for the current traffic mode.
function applyRoadMode() {
  if (!roadMat) return;
  roadTex = trafficMode === "twoway" ? roadTexTwo : roadTexOne;
  roadMat.map = roadTex;
  roadMat.needsUpdate = true;
}
let trafficGroup, sceneryGroup, playerMesh = null, playerCarId = null;
let hemiLight, sunLight, grassMat;   // updated each frame by the biome engine
let ready3d = false;
const CAM_FOV = 55; // base camera FOV (widens with speed)

// ---- Real car models (GLB). Drop files in models/<id>.glb — see models/README.md.
// The game falls back to the detailed procedural car below, so to avoid 404s for
// files that aren't there we only fetch ids listed in MODELS_AVAILABLE. Add an id
// here once you've dropped its models/<id>.glb in.
const MODELS_AVAILABLE = new Set([]);
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
let _matGlass, _matTire, _matHead, _matTail, _matShadow, _matTrunk, _matLeaf, _matPost, _matSilhouette, _matTrailer;
let _matBodyDark, _matChrome; // rocker/bumper cladding + chrome trim (grille, hubs)
// Region scenery: cactus/rock (desert), building + glowing windows (city),
// street lamp head (city/neon), dark neon-district body, and a small palette of
// MeshBasic neon colours (unlit + fogged, so they read as pure glow in the dark).
let _matCactus, _matRock, _matWindow, _matLamp, _matNeonBody;
let _neonMats = [];
const _matBlinker = new THREE.MeshBasicMaterial({ color: 0xffae2b }); // bright amber, blinks via visibility

function initSharedAssets() {
  // Car body, sculpted from a few layered slabs (see buildProceduralCar).
  _geo.skirt   = new THREE.BoxGeometry(1.96, 0.34, 4.4);  // dark rocker / lower body
  _geo.body    = new THREE.BoxGeometry(2.04, 0.5, 4.46);  // main beltline mass
  _geo.hood    = new THREE.BoxGeometry(1.9, 0.26, 1.6);   // front hood
  _geo.deck    = new THREE.BoxGeometry(1.9, 0.28, 1.2);   // rear deck
  _geo.cabin   = new THREE.BoxGeometry(1.66, 0.5, 2.2);   // greenhouse base
  _geo.roof    = new THREE.BoxGeometry(1.46, 0.42, 1.5);  // tapered roof panel
  _geo.glassF  = new THREE.BoxGeometry(1.54, 0.5, 0.12);  // windshield (raked)
  _geo.glassR  = new THREE.BoxGeometry(1.52, 0.46, 0.12); // rear window (raked)
  _geo.glassS  = new THREE.BoxGeometry(0.06, 0.34, 1.5);  // a side window
  _geo.bumper  = new THREE.BoxGeometry(2.02, 0.32, 0.5);  // front/rear bumpers
  _geo.grille  = new THREE.BoxGeometry(1.2, 0.22, 0.12);  // grille slab
  _geo.hub     = new THREE.CylinderGeometry(0.17, 0.17, 0.36, 12); // wheel hub cap
  _geo.spoiler = new THREE.BoxGeometry(1.66, 0.07, 0.34); // subtle rear lip
  _geo.glass  = new THREE.BoxGeometry(1.74, 0.52, 1.72);  // (kept for the truck cab)
  _geo.wheel  = new THREE.CylinderGeometry(0.42, 0.42, 0.34, 18);
  _geo.light  = new THREE.BoxGeometry(0.42, 0.2, 0.12);
  _geo.shadow = new THREE.CircleGeometry(1.8, 24);
  _geo.trunk  = new THREE.CylinderGeometry(0.18, 0.26, 2.2, 8);
  _geo.leaf   = new THREE.IcosahedronGeometry(1.5, 0);
  _geo.post   = new THREE.CylinderGeometry(0.12, 0.12, 3, 8);
  _geo.sign   = new THREE.BoxGeometry(2.4, 1.4, 0.14);
  // Heavy vehicles (trucks + buses) reuse these so spawning stays cheap.
  _geo.truckCab     = new THREE.BoxGeometry(2.0, 1.5, 1.7);
  _geo.truckTrailer = new THREE.BoxGeometry(2.2, 2.0, 5.2);
  _geo.busBody      = new THREE.BoxGeometry(2.1, 1.9, 6.4);
  _geo.busStripe    = new THREE.BoxGeometry(2.14, 0.55, 5.4);
  _geo.bigWheel     = new THREE.CylinderGeometry(0.5, 0.5, 0.4, 16);
  _geo.blinker      = new THREE.BoxGeometry(0.18, 0.16, 0.18);
  // Region scenery (desert / city / neon). Buildings are a unit cube scaled per
  // instance; lamp + neon parts are scaled too, so a handful of geos cover all.
  _geo.cactusBody = new THREE.CylinderGeometry(0.42, 0.58, 3.2, 8);
  _geo.cactusArm  = new THREE.CylinderGeometry(0.26, 0.26, 1.3, 7);
  _geo.rock       = new THREE.DodecahedronGeometry(1.2, 0);
  _geo.building   = new THREE.BoxGeometry(1, 1, 1);
  _geo.lampArm    = new THREE.BoxGeometry(2.0, 0.13, 0.13);
  _geo.lampHead   = new THREE.BoxGeometry(0.5, 0.2, 0.5);
  _geo.neonBar    = new THREE.BoxGeometry(1, 1, 1);   // scaled into stripes/signs

  _matGlass  = new THREE.MeshStandardMaterial({ color: 0x10141b, metalness: 0.3, roughness: 0.12 });
  _matTire   = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.85 });
  _matHead   = new THREE.MeshStandardMaterial({ color: 0xfff4cc, emissive: 0xffe9a0, emissiveIntensity: 0.9, roughness: 0.4 });
  _matTail   = new THREE.MeshStandardMaterial({ color: 0x5a0000, emissive: 0xff2b2b, emissiveIntensity: 0.9, roughness: 0.4 });
  _matShadow = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false });
  _matTrunk  = new THREE.MeshStandardMaterial({ color: 0x5b3a21, roughness: 1 });
  _matLeaf   = new THREE.MeshStandardMaterial({ color: 0x2f8f3e, roughness: 1, flatShading: true });
  _matPost   = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.6, metalness: 0.4 });
  _matSilhouette = new THREE.MeshStandardMaterial({ color: 0x0b0d12, roughness: 0.7, metalness: 0.2 });
  _matTrailer = new THREE.MeshStandardMaterial({ color: 0xdfe3e8, roughness: 0.7, metalness: 0.1 });
  _matBodyDark = new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.6, metalness: 0.3 });
  _matChrome   = new THREE.MeshStandardMaterial({ color: 0xb9c1cd, roughness: 0.28, metalness: 0.9 });

  // Region scenery materials (all shared, so a whole skyline draws in a few calls).
  _matCactus   = new THREE.MeshStandardMaterial({ color: 0x4f7d3a, roughness: 1, flatShading: true });
  _matRock     = new THREE.MeshStandardMaterial({ color: 0xb08a5a, roughness: 1, flatShading: true });
  _matNeonBody = new THREE.MeshStandardMaterial({ color: 0x0c0a16, roughness: 0.5, metalness: 0.4 });
  // Lamp head: emissive box; intensity is ramped by nightFactor in applyBiome.
  _matLamp     = new THREE.MeshStandardMaterial({ color: 0xfff2cc, emissive: 0xffe9a0, emissiveIntensity: 0.25, roughness: 0.5 });
  // Building wall: a tiling window texture used as BOTH colour map and emissive
  // map, so windows are visible by day and light up at night (emissiveIntensity
  // tracks nightFactor). Mild UV stretch on tall blocks is invisible at speed.
  const winTex = makeWindowTexture();
  _matWindow   = new THREE.MeshStandardMaterial({
    map: winTex, emissiveMap: winTex, emissive: 0xfff0c0, emissiveIntensity: 0.1,
    color: 0xdfe4ec, roughness: 0.85,   // near-white so the texture reads true
  });
  _neonMats = [0xff3aa5, 0x21e6ff, 0x9d4dff, 0x4dff88, 0xffc23d]
    .map((c) => new THREE.MeshBasicMaterial({ color: c }));

  // --- Pre-merged vehicle parts -------------------------------------------
  // A vehicle's shape is colour-independent, so we bake each material's panels
  // into ONE geometry up front. A car then draws in ~9 calls instead of ~30,
  // which is the bulk of the per-frame cost when traffic is dense.
  const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
  const at = (geo, pos = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1]) => {
    const c = geo.clone();
    _e.set(rot[0], rot[1], rot[2]); _q.setFromEuler(_e);
    _m4.compose(new THREE.Vector3(...pos), _q, new THREE.Vector3(...scale));
    return c.applyMatrix4(_m4);
  };
  const merge = (parts) => mergeGeometries(parts, false);
  const RZ = [0, 0, Math.PI / 2]; // wheels lie on their side

  _geo.carPaint = merge([
    at(_geo.body, [0, 0.62, 0]), at(_geo.hood, [0, 0.8, -1.42]),
    at(_geo.deck, [0, 0.82, 1.62]), at(_geo.cabin, [0, 1.04, 0.12]),
    at(_geo.roof, [0, 1.32, 0.18]),
  ]);
  _geo.carDark = merge([
    at(_geo.skirt, [0, 0.34, 0]), at(_geo.bumper, [0, 0.48, -2.12]),
    at(_geo.bumper, [0, 0.48, 2.12]), at(_geo.spoiler, [0, 0.98, 2.16]),
  ]);
  _geo.carGlass = merge([
    at(_geo.glassF, [0, 1.16, -0.86], [0.62, 0, 0]),
    at(_geo.glassR, [0, 1.18, 1.12], [-0.66, 0, 0]),
    at(_geo.glassS, [0.81, 1.12, 0.18]), at(_geo.glassS, [-0.81, 1.12, 0.18]),
  ]);
  const wheels = [], hubs = [];
  for (const [x, z] of [[0.94, 1.4], [-0.94, 1.4], [0.94, -1.4], [-0.94, -1.4]]) {
    wheels.push(at(_geo.wheel, [x, 0.42, z], RZ));
    hubs.push(at(_geo.hub, [x, 0.42, z], RZ));
  }
  _geo.carWheels = merge(wheels);
  _geo.carChrome = merge([...hubs, at(_geo.grille, [0, 0.66, -2.24])]);
  _geo.carHead = merge([at(_geo.light, [0.64, 0.68, -2.22]), at(_geo.light, [-0.64, 0.68, -2.22])]);
  _geo.carTail = merge([at(_geo.light, [0.64, 0.74, 2.22]), at(_geo.light, [-0.64, 0.74, 2.22])]);
  _geo.carBlinkR = merge([at(_geo.blinker, [0.95, 0.74, -2.0]), at(_geo.blinker, [0.95, 0.74, 2.0])]);
  _geo.carBlinkL = merge([at(_geo.blinker, [-0.95, 0.74, -2.0]), at(_geo.blinker, [-0.95, 0.74, 2.0])]);

  _geo.truckWheels = merge([[1, -2.6], [-1, -2.6], [1, 0], [-1, 0], [1, 2.6], [-1, 2.6]]
    .map(([x, z]) => at(_geo.bigWheel, [x, 0.5, z], RZ)));
  _geo.truckHead = merge([at(_geo.light, [0.7, 0.7, -3.45]), at(_geo.light, [-0.7, 0.7, -3.45])]);
  _geo.truckTail = merge([at(_geo.light, [0.7, 1.0, 3.5]), at(_geo.light, [-0.7, 1.0, 3.5])]);

  _geo.busWheels = merge([[1, -2.4], [-1, -2.4], [1, 2.4], [-1, 2.4]]
    .map(([x, z]) => at(_geo.bigWheel, [x, 0.5, z], RZ)));
  _geo.busHead = merge([at(_geo.light, [0.7, 0.7, -3.25]), at(_geo.light, [-0.7, 0.7, -3.25])]);
  _geo.busTail = merge([at(_geo.light, [0.7, 0.7, 3.25]), at(_geo.light, [-0.7, 0.7, 3.25])]);
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

// A sculpted 3D car: layered body slabs, a tapered greenhouse with raked glass,
// chrome trim, hub-capped wheels and a subtle lip — front faces -Z.
function buildProceduralCar(color) {
  const g = new THREE.Group();
  // One mesh per material (panels pre-merged in initSharedAssets), so the whole
  // car is ~9 draw calls. Front faces -Z.
  g.add(new THREE.Mesh(_geo.carPaint, paintMat(color)));
  g.add(new THREE.Mesh(_geo.carDark, _matBodyDark));
  g.add(new THREE.Mesh(_geo.carGlass, _matGlass));
  g.add(new THREE.Mesh(_geo.carWheels, _matTire));
  g.add(new THREE.Mesh(_geo.carChrome, _matChrome));
  g.add(new THREE.Mesh(_geo.carHead, _matHead));
  g.add(new THREE.Mesh(_geo.carTail, _matTail));

  const sh = new THREE.Mesh(_geo.shadow, _matShadow);
  sh.rotation.x = -Math.PI / 2; sh.position.y = 0.02; g.add(sh);

  // Turn indicators (both corners per side merged into one mesh), hidden until a
  // merge. placeTraffic flips them on by world side, blinking; the player leaves
  // them dark. Kept in arrays so the existing toggle code is unchanged.
  const blinkR = new THREE.Mesh(_geo.carBlinkR, _matBlinker); blinkR.visible = false; g.add(blinkR);
  const blinkL = new THREE.Mesh(_geo.carBlinkL, _matBlinker); blinkL.visible = false; g.add(blinkL);
  g.userData.blinkR = [blinkR]; // local +X
  g.userData.blinkL = [blinkL]; // local -X
  return g;
}

// Heavy vehicles share the car's orientation: front faces -Z (away from you).
// placeTraffic spins oncoming ones 180° so their headlights point back at you.
function buildTruck(color) {
  const g = new THREE.Group();
  const cab = new THREE.Mesh(_geo.truckCab, paintMat(color)); cab.position.set(0, 1.05, -2.6); g.add(cab);
  const glass = new THREE.Mesh(_geo.glass, _matGlass);
  glass.scale.set(1.06, 0.7, 0.28); glass.position.set(0, 1.35, -3.35); g.add(glass);
  const trailer = new THREE.Mesh(_geo.truckTrailer, _matTrailer); trailer.position.set(0, 1.45, 0.9); g.add(trailer);
  g.add(new THREE.Mesh(_geo.truckWheels, _matTire));
  g.add(new THREE.Mesh(_geo.truckHead, _matHead));
  g.add(new THREE.Mesh(_geo.truckTail, _matTail));
  const sh = new THREE.Mesh(_geo.shadow, _matShadow);
  sh.rotation.x = -Math.PI / 2; sh.position.y = 0.02; sh.scale.set(1.25, 2.1, 1); g.add(sh);
  return g;
}
function buildBus(color) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(_geo.busBody, paintMat(color)); body.position.set(0, 1.5, 0); g.add(body);
  const stripe = new THREE.Mesh(_geo.busStripe, _matGlass); stripe.position.set(0, 1.95, 0.2); g.add(stripe);
  g.add(new THREE.Mesh(_geo.busWheels, _matTire));
  g.add(new THREE.Mesh(_geo.busHead, _matHead));
  g.add(new THREE.Mesh(_geo.busTail, _matTail));
  const sh = new THREE.Mesh(_geo.shadow, _matShadow);
  sh.rotation.x = -Math.PI / 2; sh.position.y = 0.02; sh.scale.set(1.2, 2.0, 1); g.add(sh);
  return g;
}
function buildVehicle(o) {
  if (o.kind === "truck") return buildTruck(o.color);
  if (o.kind === "bus")   return buildBus(o.color);
  return buildProceduralCar(o.color);
}

// One facade "block" of BWIN_COLS x BWIN_ROWS windows on a concrete wall: a
// narrow mullion grid with most panes dark glass and a scattering lit warm.
// Used as both colour and emissive map (windows show by day, glow at night).
// The texture has NO built-in repeat — buildingGeo tiles it per building so
// window size stays roughly constant whatever the tower's proportions, instead
// of a fixed 2x5 grid stretched into big slabs. One shared canvas for the city.
const BWIN_COLS = 5, BWIN_ROWS = 4;
function makeWindowTexture() {
  const cell = 26, m = 4;                 // px per window cell + mullion margin
  const c = document.createElement("canvas");
  c.width = BWIN_COLS * cell; c.height = BWIN_ROWS * cell;
  const x = c.getContext("2d");
  x.fillStyle = "#0b0e15"; x.fillRect(0, 0, c.width, c.height); // concrete + mullions
  const dark = ["#10141d", "#141a26", "#0d1119"];               // unlit glass tints
  const lit  = ["#ffe6a0", "#ffd27a", "#fff2d2", "#cfe0ff"];    // lights-on (mostly warm)
  for (let cy = 0; cy < BWIN_ROWS; cy++)
    for (let cx = 0; cx < BWIN_COLS; cx++) {
      const on = Math.random() < 0.32;     // a minority of windows are lit
      x.fillStyle = on ? lit[Math.floor(Math.random() * lit.length)]
                       : dark[Math.floor(Math.random() * dark.length)];
      x.fillRect(cx * cell + m, cy * cell + m, cell - 2 * m, cell - 2 * m);
    }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
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
// --- Desert -------------------------------------------------------------
function buildCactus() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(_geo.cactusBody, _matCactus); body.position.y = 1.6; g.add(body);
  const arms = Math.floor(Math.random() * 3); // 0-2 arms, alternating sides
  for (let i = 0; i < arms; i++) {
    const side = i % 2 === 0 ? 1 : -1;
    const arm = new THREE.Mesh(_geo.cactusArm, _matCactus);
    arm.position.set(side * 0.45, 1.5 + Math.random() * 0.7, 0);
    arm.rotation.z = side * (0.5 + Math.random() * 0.3);
    g.add(arm);
  }
  return g;
}
function buildRock() {
  const g = new THREE.Group();
  const r = new THREE.Mesh(_geo.rock, _matRock);
  r.position.y = 0.6; r.scale.set(1, 0.6 + Math.random() * 0.5, 1);
  r.rotation.y = Math.random() * Math.PI;
  g.add(r);
  return g;
}
// --- City ---------------------------------------------------------------
// Window cells should stay roughly this big in world units whatever the tower
// size; buildingGeo tiles the BWIN_COLS x BWIN_ROWS block an integer number of
// times to land near it (integer keeps the window grid seamless).
const BWIN_W = 2.2, BWIN_FLOOR = 3.4;
const _buildGeoCache = {};
function buildingGeo(w, h, d) {
  const tx = Math.max(1, Math.round(w / (BWIN_COLS * BWIN_W)));
  const tz = Math.max(1, Math.round(d / (BWIN_COLS * BWIN_W)));
  const ty = Math.max(1, Math.round(h / (BWIN_ROWS * BWIN_FLOOR)));
  const key = tx + "," + tz + "," + ty;
  if (_buildGeoCache[key]) return _buildGeoCache[key];
  // Unit cube with per-face UVs scaled to the tile counts; the mesh is then
  // scaled to w/h/d (UV tiling is independent of mesh scale, so geos are shared
  // across every building with the same tile counts).
  const g = new THREE.BoxGeometry(1, 1, 1);
  const uv = g.attributes.uv;
  const face = (f, su, sv) => { for (let k = 0; k < 4; k++) { const i = f * 4 + k; uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv); } };
  face(0, tz, ty); face(1, tz, ty);   // +x / -x  (depth-facing sides)
  face(4, tx, ty); face(5, tx, ty);   // +z / -z  (width-facing front/back)
  // top (2) + bottom (3) keep 1x1 — hidden by the roof cap / ground anyway.
  uv.needsUpdate = true;
  _buildGeoCache[key] = g;
  return g;
}
function buildBuilding(o) {
  const g = new THREE.Group();
  const shaft = new THREE.Mesh(buildingGeo(o.w, o.h, o.d), _matWindow);
  shaft.scale.set(o.w, o.h, o.d); shaft.position.y = o.h / 2; g.add(shaft);
  // A solid concrete ground floor + roof slab make it read as a structure
  // rather than a glowing slab — the data-center look came from neither.
  const base = new THREE.Mesh(_geo.building, _matBodyDark);
  base.scale.set(o.w * 1.05, 1.5, o.d * 1.05); base.position.y = 0.75; g.add(base);
  const cap = new THREE.Mesh(_geo.building, _matBodyDark);
  cap.scale.set(o.w * 1.02, 0.7, o.d * 1.02); cap.position.y = o.h + 0.1; g.add(cap);
  // Small rooftop unit (tank / AC housing) for skyline texture.
  const roof = new THREE.Mesh(_geo.building, _matBodyDark);
  roof.scale.set(o.w * 0.42, 1.3, o.d * 0.42);
  roof.position.set((Math.random() - 0.5) * o.w * 0.4, o.h + 1.0, (Math.random() - 0.5) * o.d * 0.4);
  g.add(roof);
  // Taller towers sometimes step back into a second, lit upper stage.
  if (o.h > 20 && Math.random() < 0.55) {
    const sw = o.w * 0.62, sd = o.d * 0.62, sh = o.h * (0.28 + Math.random() * 0.22);
    const set = new THREE.Mesh(buildingGeo(sw, sh, sd), _matWindow);
    set.scale.set(sw, sh, sd); set.position.y = o.h + 0.45 + sh / 2; g.add(set);
  }
  return g;
}
function buildStreetlight() {
  const g = new THREE.Group();
  const post = new THREE.Mesh(_geo.post, _matPost);
  post.scale.y = 2.2; post.position.y = 3.3; g.add(post);   // post geo is 3 tall
  const arm = new THREE.Mesh(_geo.lampArm, _matPost);
  arm.position.set(1.0, 6.4, 0); g.add(arm);                // reaches over the road (+x)
  const head = new THREE.Mesh(_geo.lampHead, _matLamp);
  head.position.set(1.9, 6.3, 0); g.add(head);
  return g;
}
// --- Neon Paradise ------------------------------------------------------
function buildNeonBuilding(o) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(_geo.building, _matNeonBody);
  body.scale.set(o.w, o.h, o.d); body.position.y = o.h / 2; g.add(body);
  const neon = _neonMats[o.colorIdx];
  for (const sx of [-1, 1]) {                  // glowing vertical corner edges
    const strip = new THREE.Mesh(_geo.neonBar, neon);
    strip.scale.set(0.2, o.h * 0.92, 0.2);
    strip.position.set(sx * o.w / 2, o.h / 2, o.d / 2);
    g.add(strip);
  }
  const bands = 2 + Math.floor(Math.random() * 2); // horizontal glow bands
  for (let i = 0; i < bands; i++) {
    const band = new THREE.Mesh(_geo.neonBar, _neonMats[(o.colorIdx + 1 + i) % _neonMats.length]);
    band.scale.set(o.w * 1.02, 0.22, 0.12);
    band.position.set(0, o.h * (0.28 + 0.46 * (i + 1) / (bands + 1)), o.d / 2 + 0.06);
    g.add(band);
  }
  return g;
}
function buildNeonSign(o) {
  const g = new THREE.Group();
  const post = new THREE.Mesh(_geo.post, _matNeonBody);
  post.scale.y = 1.3; post.position.y = 2.0; g.add(post);
  const board = new THREE.Mesh(_geo.neonBar, _neonMats[o.colorIdx]);
  board.scale.set(2.6, 1.3, 0.16); board.position.y = 4.2; g.add(board);
  const inner = new THREE.Mesh(_geo.neonBar, _matNeonBody); // dark cut -> framed look
  inner.scale.set(2.1, 0.8, 0.2); inner.position.set(0, 4.2, 0.02); g.add(inner);
  return g;
}
function makeScenery(o) {
  switch (o.type) {
    case "sign":        { const m = buildSign(o.color); m.scale.setScalar(o.sizeVar * 1.5); return m; }
    case "cactus":      { const m = buildCactus();      m.scale.setScalar(o.sizeVar * 1.2); return m; }
    case "rock":        { const m = buildRock();        m.scale.setScalar(o.sizeVar * 1.7); return m; }
    case "building":    return buildBuilding(o);
    case "streetlight": return buildStreetlight();
    case "neonbuild":   return buildNeonBuilding(o);
    case "neonsign":    return buildNeonSign(o);
    default:            { const m = buildTree(); m.scale.setScalar(o.sizeVar * 1.5); return m; }
  }
}

// Asphalt + lane markings baked into a tiling texture that scrolls with travel.
function makeRoadTexture(twoway) {
  const c = document.createElement("canvas"); c.width = 256; c.height = 256;
  const x = c.getContext("2d");
  x.fillStyle = "#3b4048"; x.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1400; i++) { // subtle asphalt grain
    x.fillStyle = `rgba(0,0,0,${Math.random() * 0.06})`;
    x.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  }
  x.fillStyle = "#e8e8e8"; // solid edge lines (lx = ±1 -> u 0 / 1)
  x.fillRect(4, 0, 7, 256); x.fillRect(256 - 11, 0, 7, 256);
  // Dashed lane boundaries. One-way splits into five lanes (incl. the center);
  // two-way has two lanes per side, so the only dashes are mid-way through each
  // half (u 0.25 / 0.75), with the double-yellow centerline between them.
  for (const u of twoway ? [0.25, 0.75] : [0.2, 0.4, 0.6, 0.8]) {
    x.fillStyle = "#f0f0f0";
    x.fillRect(u * 256 - 3, 0, 6, 90); // dash (top) + longer gap (bottom) tiles into dashes
  }
  if (twoway) { // solid double-yellow centerline: everything left of it is oncoming
    x.fillStyle = "#e7b531";
    x.fillRect(128 - 6, 0, 4, 256);
    x.fillRect(128 + 2, 0, 4, 256);
  }
  // One-way leaves the center bare — the middle slot is the gap between the two
  // inner lanes, not a lane of its own.
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, ROAD_REPEAT);
  tex.anisotropy = 8;
  return tex;
}

function initThree() {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  // Render resolution is the main fill-rate lever on Retina/integrated GPUs.
  // The graphics-quality setting picks the cap (High 1.5x, Low 1.0x).
  renderer.setPixelRatio(qualityCap());

  scene = new THREE.Scene();
  // Sky + fog share one persistent Color that the biome engine recolors in place.
  scene.background = _biomeSky;
  scene.fog = new THREE.Fog(_biomeSky, 70, 300);

  camera = new THREE.PerspectiveCamera(CAM_FOV, 16 / 9, 0.3, 400);
  camera.position.set(0, 4.3, 9.5);
  camera.lookAt(0, 1.2, -26);

  hemiLight = new THREE.HemisphereLight(0xbfe3ff, 0x4a6b3a, 1.0);
  scene.add(hemiLight);
  // Doubles as the sun by day and the moon at night (color/intensity blended by
  // the biome engine). Sits high and slightly ahead so the road stays lit.
  sunLight = new THREE.DirectionalLight(0xfff1da, 1.0);
  sunLight.position.set(-30, 90, -10);
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

  roadTexOne = makeRoadTexture(false);
  roadTexTwo = makeRoadTexture(true);
  roadMat = new THREE.MeshStandardMaterial({ roughness: 0.92 });
  applyRoadMode(); // sets roadMat.map + roadTex for the current mode
  const road = new THREE.Mesh(
    new THREE.PlaneGeometry(ROAD_HALF_W * 2, ROAD_LEN),
    roadMat
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
  // Skip ids with no GLB on disk (avoids 404s); fall back to the procedural car.
  if (!cfg || !MODELS_AVAILABLE.has(car.id) || modelCache[car.id]) return;
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

// Like placeOnRoad, but oncoming traffic faces back toward you, and a merging
// car flashes the indicator on its world-facing side.
function placeTraffic(o) {
  o.mesh.position.set(worldX(o.lx), 0, worldZ(o.z - state.position));
  o.mesh.rotation.y = o.dir < 0 ? Math.PI : 0;
  const ud = o.mesh.userData;
  if (ud.blinkR) {
    const sd = o.signalDir || 0;
    // sd is a world side; oncoming cars are rotated 180°, so map to local side.
    const litR = sd !== 0 && _blinkOn && sd * o.dir > 0;
    const litL = sd !== 0 && _blinkOn && sd * o.dir < 0;
    for (const m of ud.blinkR) m.visible = litR;
    for (const m of ud.blinkL) m.visible = litL;
  }
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
let nightFactor = 0;          // 0 day .. 1 night; drives headlight + street-lamp glow
let biomeShown = null;        // label currently named in the HUD (env + time of day)
const smoothstep = (t) => t * t * (3 - 2 * t);

// Map progress through one day (u: 0..1) to a night factor (0 day .. 1 night).
// Night owns the long middle stretch; day is a short window with quick dusk/dawn.
function nightFactorAt(u) {
  const duskA = 0.12, duskB = 0.34, dawnA = 0.80, dawnB = 0.99;
  if (u < duskA) return 0;                                             // day
  if (u < duskB) return smoothstep((u - duskA) / (duskB - duskA));     // dusk -> night
  if (u < dawnA) return 1;                                             // night (long)
  if (u < dawnB) return 1 - smoothstep((u - dawnA) / (dawnB - dawnA)); // dawn -> day
  return 0;
}

// The selected environment owns the whole run, so its prop palette is fixed.
function scapeAt(_km) {
  return getEnv(selectedEnv).scape;
}

// How far through the day we are at distance km, for the selected environment.
// `startNight` shifts the phase half a lap so the run opens after dark.
function dayPhase(km) {
  const env = getEnv(selectedEnv);
  if (env.nightOnly) return 1;
  if (env.dayOnly) return 0;
  const u = km / DAYNIGHT_CYCLE_KM + (env.startNight ? 0.5 : 0);
  return nightFactorAt(((u % 1) + 1) % 1);
}

// Blend the selected environment's day<->night palette at distance km and push
// it onto the scene, lights, grass and shared car/lamp materials.
function applyBiome(km) {
  const env = getEnv(selectedEnv);
  const t = dayPhase(km);
  // Day-only / night-only worlds define just one palette; fall back so both
  // ends of the blend are always valid (mix reads both even when t pins to one).
  const a = env.day || env.night;
  const b = env.night || env.day;
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

  nightFactor = t;
  _matHead.emissiveIntensity = 0.9 + nightFactor * 1.7; // headlights burn brighter after dark
  _matTail.emissiveIntensity = 0.9 + nightFactor * 1.1;
  // City/neon windows + street lamps catch fire as the light fails.
  if (_matWindow) _matWindow.emissiveIntensity = 0.1 + nightFactor * 1.7;
  if (_matLamp)   _matLamp.emissiveIntensity   = 0.25 + nightFactor * 2.4;

  // Name the environment, and (for cycling worlds) the time of day we're in.
  const label = (env.nightOnly || env.dayOnly) ? env.name : `${env.name} · ${t < 0.5 ? "Day" : "Night"}`;
  if (label !== biomeShown) showBiome(label);
}

// Briefly name the environment / time of day, top-center on the HUD.
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
  roadTex.offset.y = -(state.position * Z_SCALE) * (ROAD_REPEAT / ROAD_LEN); // scroll markings

  _blinkOn = Math.floor(performance.now() / 280) % 2 === 0; // ~1.8 Hz signal flash
  reconcile(trafficGroup, traffic, buildVehicle, placeTraffic);
  reconcile(sceneryGroup, scenery, makeScenery, (o) => {
    placeOnRoad(o);
    o.mesh.rotation.y = o.rot;   // per-prop orientation, set at spawn (see spawnScenery)
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
  // A clean pass is mostly a visual flash now; only sideswipes/crashes (state.shake) really jolt the camera.
  const shake = state.flash * 0.07 + state.shake * 0.6 + sf * 0.03;
  camera.position.x = state.playerX * 1.4 + (Math.random() - 0.5) * shake;
  camera.position.y = 4.3 + (Math.random() - 0.5) * shake * 0.5;
  camera.lookAt(state.playerX * 2.2, 1.2, -26);

  renderer.render(scene, camera);
  drawFx(sf);
}

// 2D overlay: hit flash, near-miss flash, score popups.
function drawFx(sf = 0) {
  fxCtx.clearRect(0, 0, fx.width, fx.height);

  if (state.hitFlash > 0.02) { // red on a sideswipe
    fxCtx.fillStyle = `rgba(255,40,40,${state.hitFlash * 0.35})`;
    fxCtx.fillRect(0, 0, fx.width, fx.height);
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
// matchMedia list is created once (it's live), not per physics step.
const _portraitMQ = window.matchMedia("(orientation: portrait)");
function isBlocked() {
  return document.body.classList.contains("touch") && _portraitMQ.matches;
}

// ---- Loop ----
// The simulation is written in per-frame increments tuned for 60 FPS. To keep
// it identical on every device (a 144 Hz monitor would otherwise run 2.4x
// faster than a 60 Hz phone), we advance physics on a fixed 60 Hz timestep and
// run as many steps as real time has accrued — never tied to the refresh rate.
const FIXED_DT = 1000 / 60;   // ms per simulation step
const MAX_STEPS = 5;          // clamp catch-up after a stall (no spiral of death)
let _loopPrev = 0, _accum = 0;
let _loopRunning = false; // guards against stacking parallel rAF chains on restart
let paused = false;       // run is frozen but still on screen behind the pause menu
function loop(now) {
  if (!state.running) { _loopRunning = false; return; }
  if (!_loopPrev) _loopPrev = now;
  if (paused) {           // frozen: the last frame stays on the canvas behind the
    _loopPrev = now;      // overlay, so don't burn GPU re-rendering it. Swallow the
    requestAnimationFrame(loop); // elapsed time so resume doesn't burst catch-up.
    return;
  }
  _accum += now - _loopPrev;
  _loopPrev = now;
  if (_accum > FIXED_DT * MAX_STEPS) _accum = FIXED_DT * MAX_STEPS; // drop backlog
  let steps = 0;
  while (_accum >= FIXED_DT && steps < MAX_STEPS) {
    if (!isBlocked()) update();
    _accum -= FIXED_DT;
    steps++;
    if (!state.running) break;   // update() may end the run mid-step
  }
  // Presentation runs once per frame regardless of how many physics steps ran,
  // so a slow frame can't multiply DOM/audio work and spiral the frame rate.
  if (state.running && !isBlocked()) {
    updateHUD();
    audioEngine(state.speed, state.maxSpeed, input.throttle, true);
  }
  if (state.running) render();
  fpsMeter();
  requestAnimationFrame(loop);
}

// ---- Pause ----
function togglePause() { if (state.running) setPaused(!paused); }
function setPaused(p) {
  if (paused === p || !state.running) return;
  paused = p;
  document.getElementById("pause").classList.toggle("hidden", !p);
  if (p) {
    if (audio) audio.engineGain.gain.setTargetAtTime(0.0001, audio.ac.currentTime, 0.08); // hush the engine
    buildPauseMenu();
  } else {
    _loopPrev = 0; // fresh clock on resume (audioEngine restores the engine sound)
  }
}
function buildPauseMenu() {
  const el = document.getElementById("pause");
  el.innerHTML = `
    <div class="pause-card">
      <h1 class="pause-title">PAUSED</h1>
      <div class="pause-btns">
        <button id="p-resume">Resume</button>
        <button id="p-restart" class="alt">Restart</button>
        <button id="p-home" class="alt">Quit to Home</button>
      </div>
    </div>`;
  document.getElementById("p-resume").addEventListener("click", () => setPaused(false));
  document.getElementById("p-restart").addEventListener("click", () => { setPaused(false); startGame(); });
  document.getElementById("p-home").addEventListener("click", () => { setPaused(false); quitRun(); });
}

// ---- Perf meter (toggle with F) ----
// Shows live fps, average frame time, and the renderer's draw-call + triangle
// counts for the last frame — enough to tell GPU fill-rate from CPU/draw-call
// bottlenecks at a glance. State persists across reloads so it's there when you
// reopen to diagnose. Updates 4x/sec so the numbers are readable.
let fpsOn = localStorage.getItem("fps") === "1";
let _fpsEl = null, _fpsFrames = 0, _fpsLast = 0;
function toggleFps() {
  fpsOn = !fpsOn;
  localStorage.setItem("fps", fpsOn ? "1" : "0");
  _fpsFrames = 0; _fpsLast = 0;
}
function fpsMeter() {
  if (!fpsOn) { if (_fpsEl) _fpsEl.style.display = "none"; return; }
  if (!_fpsEl) {
    _fpsEl = document.createElement("div");
    Object.assign(_fpsEl.style, {
      position: "fixed", top: "8px", left: "8px", zIndex: "9999",
      font: "12px/1.4 ui-monospace, Menlo, Consolas, monospace",
      color: "#9effa8", background: "rgba(0,0,0,0.55)",
      padding: "3px 7px", borderRadius: "6px",
      pointerEvents: "none", whiteSpace: "nowrap", letterSpacing: "0.3px",
    });
    document.body.appendChild(_fpsEl);
  }
  _fpsEl.style.display = "block";
  const now = performance.now();
  if (!_fpsLast) _fpsLast = now;
  _fpsFrames++;
  const dt = now - _fpsLast;
  if (dt >= 250) {
    const fps = Math.round((_fpsFrames * 1000) / dt);
    const ms = (dt / _fpsFrames).toFixed(1);
    const r = renderer ? renderer.info.render : null;
    const calls = r ? r.calls : 0;
    const tris = r ? Math.round(r.triangles / 1000) : 0;
    _fpsEl.textContent = `${fps} fps · ${ms} ms · ${calls} calls · ${tris}k tris`;
    _fpsEl.style.color = fps >= 50 ? "#9effa8" : fps >= 30 ? "#ffd166" : "#ff6b6b";
    _fpsFrames = 0; _fpsLast = now;
  }
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
  fpsMeter();
  idleRAF = requestAnimationFrame(idleLoop);
}

// ---- State transitions ----
function resetRunState() {
  state.score = 0;
  state.position = 0;
  state.speed = 0;
  state.maxSpeed = 60;
  state.playerX = trafficMode === "oneway" ? 0 : START_LANE; // one-way: start center
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
  paused = false;
  state.running = true;
  document.body.classList.add("playing");
  document.getElementById("overlay").classList.add("hidden");
  document.getElementById("results").classList.add("hidden");
  document.getElementById("pause").classList.add("hidden");
  updateHUD();
  _loopPrev = 0; _accum = 0;   // fresh clock so the first frame doesn't burst catch-up
  if (!_loopRunning) { _loopRunning = true; requestAnimationFrame(loop); } // never stack chains
}

function gameOver() { endRun(true); }          // crashed into traffic -> results
function quitRun() { endRun(false, true); }    // chose to stop (Esc) -> straight home

// End the current run: bank credits, record the high score, show results. A
// crash adds the impact SFX + shake and a beat before the card; a voluntary
// stop skips straight to it.
function endRun(crashed, toHome) {
  if (!state.running) return;
  state.running = false;
  if (audio) audio.engineGain.gain.setTargetAtTime(0, audio.ac.currentTime, 0.1);
  if (crashed) {
    audioCrash();
    state.shake = 1.6;
    render(); // one shaken, frozen frame for impact
  }

  // Score is the bragging number; credits earned are a fraction of it.
  lastEarned = Math.round(state.score * CREDIT_RATE);
  bank += lastEarned;
  const isHi = state.score > highScore;
  if (isHi) highScore = state.score;
  goalsJustDone = trackGoals(); // may add goal rewards to the bank too
  saveProgress();

  // Quitting (Esc) banks the run and drops straight to the home menu; a crash
  // still gets the results card with the run breakdown.
  if (toHome) {
    document.getElementById("results").classList.add("hidden");
    showMenu();
    return;
  }
  setTimeout(() => showResults(isHi), crashed ? 550 : 120);
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
        ${stat("Top speed", spd(state.topSpeed) + " " + spdLabel())}
        ${stat("Best ever", fmt(highScore))}
      </div>
      <div class="results-earn">+ <span class="cred">${CRED_ICO}<span class="cred-num" id="earn-num" data-val="0">0</span></span> CR earned</div>
      ${goalsJustDone.length ? `<div class="results-goals">${goalsJustDone.map((it) =>
        `<div class="rgoal">✓ ${goalTmpl(it.id).fmt(it.target)} <b>+${it.reward}</b></div>`).join("")}</div>` : ""}
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
let lastEarned = 0;  // credits granted by the most recent run (shown on results)
let goalsJustDone = []; // daily/weekly goals completed by the most recent run (shown on results)
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

// "UNLOCKED" banner over a showroom when a car / environment is bought.
function celebrate(name, host = document.querySelector(".showroom")) {
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
// Daily + weekly goals as a compact panel for the home screen.
function goalsPanelHTML() {
  ensureGoals();
  const row = (it) => {
    const t = goalTmpl(it.id);
    const pct = Math.round(clamp(it.progress / it.target, 0, 1) * 100);
    return `<div class="goal ${it.done ? "done" : ""}">
      <div class="goal-top"><span class="goal-text">${t.fmt(it.target)}</span>` +
      `<span class="goal-rew">${it.done ? "✓ Done" : CRED_ICO + " " + it.reward}</span></div>
      <div class="goal-bar"><i style="width:${pct}%"></i></div>
      <span class="goal-prog">${t.prog(it.progress, it.target)}</span>
    </div>`;
  };
  const section = (title, items) => `<div class="goals-head">${title}</div>${items.map(row).join("")}`;
  return `<div class="goals">${section("DAILY GOALS", goals.items)}${section("WEEKLY GOALS", weekly.items)}</div>`;
}

function showMenu() {
  const car = getCar(selectedCar);
  const overlay = document.getElementById("overlay");
  overlay.innerHTML = `
    <div class="home-top">
      <h1 class="home-logo">TRAFFIC <span>RACER</span></h1>
      <p class="home-stats">${walletPill("menu-credits")} &nbsp;·&nbsp; <span class="best">🏆 ${fmt(highScore)}</span> &nbsp;·&nbsp; <span class="best">🚗 ${owned.length}/${CARS.length}</span></p>
      ${goalsPanelHTML()}
    </div>
    <div class="home-bottom">
      <p class="home-car">Now driving · <b style="color:${car.color}">${car.name}</b> · <b class="home-env">${getEnv(selectedEnv).name}</b></p>
      <div class="menu-btns">
        <button id="start-btn">Start</button>
        <button id="garage-btn" class="alt">Garage</button>
        <button id="envs-btn" class="alt">Environments</button>
        <button id="settings-btn" class="alt">Settings</button>
      </div>
      <p class="controls">↑/W gas · ↓/S brake · ←→/AD steer · M mute · Esc/P pause</p>
    </div>
  `;
  overlay.classList.remove("hidden");
  document.body.classList.remove("playing");
  document.getElementById("start-btn").addEventListener("click", startGame);
  document.getElementById("garage-btn").addEventListener("click", openGarage);
  document.getElementById("envs-btn").addEventListener("click", openEnvironments);
  document.getElementById("settings-btn").addEventListener("click", showSettings);
  startIdle(); // bring the hero car / road to life behind the menu
}

function setTrafficMode(m) {
  if (m === trafficMode) return;
  trafficMode = m;
  saveProgress();
  applyRoadMode(); // swap the road texture (centerline) to match
}

// Effective pixel-ratio cap for the current quality (never above the device's).
function qualityCap() {
  return Math.min(window.devicePixelRatio || 1, QUALITY_DPR[quality]);
}
function setQuality(q) {
  if (q === quality || !QUALITY_DPR[q]) return;
  quality = q;
  if (renderer) { renderer.setPixelRatio(qualityCap()); onResize(); } // apply live
  saveProgress();
}

// A simple settings screen rendered into the same overlay as the menu. Each
// row is a segmented toggle; changes apply live and persist immediately.
function showSettings() {
  const overlay = document.getElementById("overlay");
  const seg = (id, on, off, onSel) =>
    `<div class="mode-toggle"><button id="${id}-a" class="mode-opt ${onSel ? "on" : ""}">${on}</button>` +
    `<button id="${id}-b" class="mode-opt ${onSel ? "" : "on"}">${off}</button></div>`;
  overlay.innerHTML = `
    <div class="settings-panel">
      <h2>Settings</h2>
      <div class="set-row"><span class="set-label">Speed units</span>${seg("set-unit", "km/h", "mph", speedUnit === "kmh")}</div>
      <div class="set-row"><span class="set-label">Traffic</span>${seg("set-mode", "Two-way", "One-way", trafficMode === "twoway")}</div>
      <div class="set-row"><span class="set-label">Graphics</span>${seg("set-q", "High", "Low", quality === "high")}</div>
      <div class="set-row"><span class="set-label">Sound</span>${seg("set-snd", "On", "Off", !muted)}</div>
      <button id="settings-back">Back</button>
    </div>
  `;
  overlay.classList.remove("hidden");
  document.body.classList.remove("playing");
  const reopen = () => { saveProgress(); showSettings(); };
  document.getElementById("set-unit-a").addEventListener("click", () => { speedUnit = "kmh"; reopen(); });
  document.getElementById("set-unit-b").addEventListener("click", () => { speedUnit = "mph"; reopen(); });
  document.getElementById("set-mode-a").addEventListener("click", () => { setTrafficMode("twoway"); showSettings(); });
  document.getElementById("set-mode-b").addEventListener("click", () => { setTrafficMode("oneway"); showSettings(); });
  document.getElementById("set-q-a").addEventListener("click", () => { setQuality("high"); showSettings(); });
  document.getElementById("set-q-b").addEventListener("click", () => { setQuality("low"); showSettings(); });
  document.getElementById("set-snd-a").addEventListener("click", () => { if (muted) toggleMute(); reopen(); });
  document.getElementById("set-snd-b").addEventListener("click", () => { if (!muted) toggleMute(); reopen(); });
  document.getElementById("settings-back").addEventListener("click", showMenu);
  startIdle(); // keep the hero road alive behind the panel
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
    + bar("SPD", s.maxSpeed, STAT_CEIL.maxSpeed, spd(s.maxSpeed) + " " + spdLabel())
    + bar("BRK", s.braking, STAT_CEIL.braking, r10(s.braking, STAT_CEIL.braking))
    + bar("HND", s.handling, STAT_CEIL.handling, r10(s.handling, STAT_CEIL.handling));
}

function gainText(c, track) {
  if (track.key === "speed") return `+${spd(c.maxSpeed * 0.08)} ${spdLabel()}`;
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

// ---- Environments screen ----
// Mirrors the garage: flip through the worlds, unlock with credits, pick one to
// drive. The preview is a pure-CSS "diorama" built from the environment's own
// palette, so it costs nothing to render and always matches the live look.
let envBuilt = false;
let envIndex = 0;
const hexColor = (n) => "#" + (n >>> 0).toString(16).padStart(6, "0");

// Sky -> ground gradient swatch with a scape icon, previewing an env at a glance.
function envDiorama(env) {
  const p = env.day || env.night;   // headline look (day if it has one, else night)
  const ico = { plains: "🌳", desert: "🌵", city: "🏙️", neon: "🌆" }[env.scape] || "🛣️";
  return `<div class="env-diorama" style="background:linear-gradient(180deg,
      ${hexColor(p.sky)} 0%, ${hexColor(p.sky)} 56%, ${hexColor(p.grass)} 57%, ${hexColor(p.grass)} 100%)">
      <span class="env-ico">${ico}</span>
    </div>`;
}

function openEnvironments() {
  const g = document.getElementById("environments");
  if (!envBuilt) {
    g.innerHTML = `
      <h2>Environments ${walletPill("env-credits")}</h2>
      <div class="showroom env-showroom">
        <button class="arrow" id="env-prev" aria-label="Previous environment">‹</button>
        <div id="env-preview"></div>
        <button class="arrow" id="env-next" aria-label="Next environment">›</button>
      </div>
      <div id="env-info"></div>
      <button id="env-back">Back</button>
    `;
    document.getElementById("env-prev").addEventListener("click", () => navEnv(-1));
    document.getElementById("env-next").addEventListener("click", () => navEnv(1));
    document.getElementById("env-back").addEventListener("click", closeEnvironments);
    envBuilt = true;
  }
  g.classList.remove("hidden");
  envIndex = Math.max(0, ENVIRONMENTS.findIndex((e) => e.id === selectedEnv));
  rollNumber(document.getElementById("env-credits"), bank);
  refreshEnv();
}

function closeEnvironments() {
  document.getElementById("environments").classList.add("hidden");
  showMenu(); // refresh the menu's selected-env line + wallet (idle hero keeps running)
}

function navEnv(dir) {
  envIndex = (envIndex + dir + ENVIRONMENTS.length) % ENVIRONMENTS.length;
  audioTick();
  refreshEnv();
}

function refreshEnv() {
  const e = ENVIRONMENTS[envIndex];
  const isOwned = ownedEnvs.includes(e.id);
  const isSel = selectedEnv === e.id;
  const accent = hexColor((e.day || e.night).sky);

  let action;
  if (isSel) action = `<span class="tag sel">★ Selected</span>`;
  else if (isOwned) action = `<button class="alt env-btn" data-env="${e.id}">Drive here</button>`;
  else action = `<button class="env-btn buy" data-env="${e.id}" ${bank < e.price ? "disabled" : ""}>Unlock ${credCost(e.price)}</button>`;

  const timeBadge = e.nightOnly ? "🌙 Night only"
    : e.dayOnly ? "☀️ Day only"
    : e.startNight ? "🌙 → ☀️ Day & night · opens at night"
    : "☀️ → 🌙 Day & night";

  const sr = document.querySelector(".env-showroom");
  if (sr) { sr.className = `showroom env-showroom${isOwned ? "" : " locked"}`; sr.style.setProperty("--accent", accent); }

  document.getElementById("env-preview").innerHTML = envDiorama(e);
  document.getElementById("env-info").innerHTML = `
    <div class="car-head">
      <span class="rarity" style="--rc:${accent}">${timeBadge}</span>
      <span class="owned-count">${ownedEnvs.length}/${ENVIRONMENTS.length} unlocked</span>
    </div>
    <div class="car-title" style="color:${accent}">${e.name}</div>
    <p class="car-blurb">${e.blurb}</p>
    ${isOwned ? "" : `<p class="locked-note">🔒 Unlock to drive in this world.</p>`}
    <div class="showroom-actions">${action}</div>
  `;
  document.getElementById("env-info").querySelectorAll(".env-btn").forEach((btn) =>
    btn.addEventListener("click", () => handleEnvClick(btn.dataset.env)));
}

function handleEnvClick(id) {
  const e = getEnv(id);
  if (ownedEnvs.includes(id)) {
    selectedEnv = id;
    audioTick();
  } else if (bank >= e.price) {
    const btn = document.querySelector(`.env-btn[data-env="${id}"]`);
    bank -= e.price;
    ownedEnvs.push(id);
    selectedEnv = id;
    audioUnlock();
    floatDelta(btn, `- ${fmt(e.price)}`, "spend");
    celebrate(e.name, document.querySelector(".env-showroom"));
  } else {
    audioDenied();
    return;
  }
  saveProgress();
  rollNumber(document.getElementById("env-credits"), bank);
  refreshEnv();
}

document.getElementById("mute").addEventListener("click", toggleMute);
document.getElementById("pause-btn").addEventListener("click", togglePause);
loadProgress();
initThree();
showMenu();
render();
