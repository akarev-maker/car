// ============================================================
//  store.js — shared mutable state + persistence + progression
//  Other modules import these bindings to READ them (live bindings stay in
//  sync). To WRITE a primitive, call its setter (you can't reassign an imported
//  binding from another module). Arrays/objects are mutated in place anywhere.
// ============================================================

import {
  CARS, getCar, getEnv, ENVIRONMENTS, defaultUpgrades, defaultCareer, SPEED_UNITS,
  BRAKE_BASE, UPG_MAX, TRAFFIC_DENSITY, VIEW_DISTANCE, SPAWN_DZ, DIST_DIV, CREDIT_RATE, QUALITY_DPR,
  CHAL_VERSION, HEAT_KM, START_LANE, clamp, fmt, ico, CRED_ICO, getPaint,
} from "./config.js";
import { audioUnlock, audioHeat } from "./audio.js";
import { applyRoadMode, renderer, onResize } from "./render.js";

// ---- Persistent progress + settings (saved to localStorage) ----
export let bank = 0;
export let owned = ["hatch"];
export let selectedCar = "hatch";
export let ownedEnvs = ["plains"];  // unlocked driving environments (Plains is free)
export let selectedEnv = "plains";  // the environment the next run takes place in
export let challengesDone = [];     // ids of completed progression challenges
export let trafficMode = "twoway";  // "oneway" | "twoway"
export let trafficDensity = "medium"; // "low" | "medium" | "high"
export let viewDist = "far";        // "near" | "normal" | "far" — how far you see + cars spawn
export let gameMode = "heat";       // run mode: "cruise" (flat) | "heat" (escalates) | "pursuit" (cops)
export let pursuit = false;         // derived: gameMode === "pursuit" (kept for existing call sites)
export let speedUnit = "mph";       // "kmh" | "mph" — display only
export let quality = "high";        // "high" | "low"
export let muted = false;
export let highScore = 0;
export let goals = null;            // daily goals { date, items:[...] }
export let weekly = null;           // weekly goals, same shape
export let career = defaultCareer(); // lifetime totals the ladder grinds against
export let upgrades = defaultUpgrades();
export let ownedPaints = ["stock"]; // paint ids unlocked (global; "stock" is always free)
export let carPaint = {};           // carId -> chosen paint id (default "stock")
export let activeCar = CARS[0];
export let activeStats = null;       // active car's upgraded stats, set on start
export let lastEarned = 0;           // credits from the most recent run (shown on results)
export let goalsJustDone = [];       // goals completed by the most recent run

// Setters for the cross-module reassignments (live bindings are read-only abroad).
export const addBank = (n) => { bank += n; };
export const setSelectedCar = (id) => { selectedCar = id; };
export const setSelectedEnv = (id) => { selectedEnv = id; };
export const setHighScore = (n) => { highScore = n; };
export const setSpeedUnit = (u) => { speedUnit = u; };
export const setMuted = (m) => { muted = m; };
export const setActiveCar = (c) => { activeCar = c; };
export const setActiveStats = (s) => { activeStats = s; };
export const setLastEarned = (n) => { lastEarned = n; };
export const setGoalsJustDone = (g) => { goalsJustDone = g; };

// ---- Paint shop ----
export const setGameMode = (m) => {
  gameMode = (m === "cruise" || m === "pursuit") ? m : "heat";
  pursuit = gameMode === "pursuit"; // keep the legacy flag in sync for the Pursuit-only code paths
};
export const addOwnedPaint = (id) => { if (!ownedPaints.includes(id)) ownedPaints.push(id); };
export const setCarPaint = (carId, paintId) => { carPaint[carId] = paintId; };
export const paintIdOf = (carId) => carPaint[carId] || "stock";
export const paintOwned = (id) => id === "stock" || ownedPaints.includes(id);
// Resolve a car's current paint to a { color, finish } spec for rendering.
export const paintSpecOf = (car) => {
  const p = getPaint(paintIdOf(car.id));
  return { color: p.id === "stock" ? car.color : p.hex, finish: p.finish || "gloss" };
};

// ---- Run state (one object, mutated in place everywhere) ----
export const state = {
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
  kick: 0,          // lateral camera impulse from a near-miss / sideswipe
  flashHue: 0,      // 0 = gold near-miss .. 1 = white-hot (rises with combo tier)
  whiteout: 0,      // crash blowout: white flash + crack lines on the impact frame
  slowmoT: 0,       // ms of bullet-time left after an exceptional pass (real time)
  slowmoCD: 0,      // ms until another slow-mo can trigger
  shield: false,    // a held shield that auto-saves the next fatal hit
  shieldCharge: 0,  // 0..1 progress toward the next shield (from near-misses)
  invuln: 0,        // frames of phase-through after a shield save
  heat: 0,          // intra-run escalation (rises with distance; drives difficulty + score)
  heatStage: 1,     // 1 + floor(heat); the readable stage shown in the HUD / banner
  bust: 0,          // police-pursuit meter 0..1 (only used in Pursuit mode; 1 = busted)
  frames: 0,        // physics steps elapsed this run (used for short grace windows)
  // combo + run stats
  combo: 0,
  comboTimer: 0,    // frames remaining before the combo lapses
  mult: 1,
  maxCombo: 0,
  passed: 0,
  topSpeed: 0,
  runSlowmos: 0,    // exceptional-pass slow-mos this run (for challenges)
  runShields: 0,    // shield saves this run (for challenges)
};

// ---- Input (mutated in place: main sets keys, the sim reads them) ----
export const keys = { left: false, right: false, up: false, down: false };
export const input = { steer: 0, throttle: 0, brake: 0 };

// ---- Derived helpers that read settings ----
export const densityCfg = () => TRAFFIC_DENSITY[trafficDensity] || TRAFFIC_DENSITY.medium;
export const viewCfg = () => VIEW_DISTANCE[viewDist] || VIEW_DISTANCE.normal;
export const viewMul = () => viewCfg().mult; // how far you see, scaled by the View distance setting
export const spawnAhead = () => SPAWN_DZ * densityCfg().sight * viewMul(); // live spawn distance / sightline
export const spd = (internal) => Math.round(internal * SPEED_UNITS[speedUnit].factor);
export const spdLabel = () => SPEED_UNITS[speedUnit].label;
export const heatAt = () => (state.position / DIST_DIV) / HEAT_KM;
export const qualityCap = () => Math.min(window.devicePixelRatio || 1, QUALITY_DPR[quality]);

// A car's stats with its upgrades applied (used in the garage and in play).
export function effStats(c) {
  const u = upgrades[c.id] || { engine: 0, speed: 0, handling: 0 };
  const handling = c.handling * (1 + 0.08 * u.handling);
  return {
    accel: c.accel * (1 + 0.12 * u.engine),
    maxSpeed: c.maxSpeed * (1 + 0.08 * u.speed),
    handling,
    braking: BRAKE_BASE * c.brake * (1 + 0.08 * u.handling),
  };
}
activeStats = effStats(CARS[0]); // initial

export const walletPill = (id) =>
  `<span class="wallet">${CRED_ICO}<span class="cred-num" ${id ? `id="${id}"` : ""} data-val="${bank}">${fmt(bank)}</span><span class="cred-cr">CR</span></span>`;

// ---- Settings mutators (apply live + persist) ----
export function setTrafficMode(m) {
  if (m === trafficMode) return;
  trafficMode = m;
  saveProgress();
  applyRoadMode(); // swap the road texture (centerline) to match
}
export function setTrafficDensity(d) {
  if (d === trafficDensity || !TRAFFIC_DENSITY[d]) return;
  trafficDensity = d;  // takes effect live (spawn rate + sightline read it each frame)
  saveProgress();
}
export function setViewDist(v) {
  if (v === viewDist || !VIEW_DISTANCE[v]) return;
  viewDist = v;  // takes effect live (fog far + spawn distance read it each frame)
  saveProgress();
}
export function setQuality(q) {
  if (q === quality || !QUALITY_DPR[q]) return;
  quality = q;
  if (renderer) { renderer.setPixelRatio(qualityCap()); onResize(); } // apply live
  saveProgress();
}

// ---- Persistence ----
export function loadProgress() {
  try {
    bank = parseInt(localStorage.getItem("tr_bank")) || 0;
    owned = JSON.parse(localStorage.getItem("tr_owned")) || ["hatch"];
    selectedCar = localStorage.getItem("tr_selected") || "hatch";
    ownedEnvs = JSON.parse(localStorage.getItem("tr_envs")) || ["plains"];
    selectedEnv = localStorage.getItem("tr_env") || "plains";
    challengesDone = JSON.parse(localStorage.getItem("tr_chal")) || [];
    trafficMode = localStorage.getItem("tr_mode") === "oneway" ? "oneway" : "twoway";
    // Migrate the old on/off Pursuit toggle: on -> "pursuit", off -> "heat" (the prior always-on default).
    gameMode = localStorage.getItem("tr_gamemode") ||
      (localStorage.getItem("tr_pursuit") === "1" ? "pursuit" : "heat");
    if (gameMode !== "cruise" && gameMode !== "pursuit") gameMode = "heat";
    pursuit = gameMode === "pursuit";
    trafficDensity = TRAFFIC_DENSITY[localStorage.getItem("tr_density")] ? localStorage.getItem("tr_density") : "medium";
    viewDist = VIEW_DISTANCE[localStorage.getItem("tr_view")] ? localStorage.getItem("tr_view") : "far";
    speedUnit = localStorage.getItem("tr_unit") === "kmh" ? "kmh" : "mph"; // default mph for new players
    quality = localStorage.getItem("tr_quality") === "low" ? "low" : "high";
    muted = localStorage.getItem("tr_muted") === "1";
    highScore = parseInt(localStorage.getItem("tr_hi")) || 0;
    upgrades = JSON.parse(localStorage.getItem("tr_upg")) || {};
    ownedPaints = JSON.parse(localStorage.getItem("tr_paints")) || ["stock"];
    carPaint = JSON.parse(localStorage.getItem("tr_carpaint")) || {};
    goals = JSON.parse(localStorage.getItem("tr_goals")) || null;
    weekly = JSON.parse(localStorage.getItem("tr_weekly")) || null;
    career = Object.assign(defaultCareer(), JSON.parse(localStorage.getItem("tr_career")) || {});
    // The ladder was redesigned; old completions no longer map to the new tiers,
    // so wipe them once when the version changes (career totals carry forward).
    if (parseInt(localStorage.getItem("tr_chalver")) !== CHAL_VERSION) challengesDone = [];
  } catch (e) { /* use defaults */ }
  ensureGoals(); // (re)generate today's / this week's sets if missing or stale
  if (!owned.includes("hatch")) owned.push("hatch");
  if (!owned.includes(selectedCar)) selectedCar = "hatch";
  ownedEnvs = ownedEnvs.filter((id) => ENVIRONMENTS.some((e) => e.id === id));
  if (!ownedEnvs.includes("plains")) ownedEnvs.push("plains");
  if (!ownedEnvs.includes(selectedEnv)) selectedEnv = "plains";
  if (!Array.isArray(ownedPaints)) ownedPaints = ["stock"];
  if (!ownedPaints.includes("stock")) ownedPaints.push("stock");
  if (!carPaint || typeof carPaint !== "object") carPaint = {};
  // Backfill any missing cars/tracks and clamp saved levels.
  const def = defaultUpgrades();
  for (const id in def) {
    const saved = upgrades[id] || {};
    for (const k in def[id]) def[id][k] = clamp(parseInt(saved[k]) || 0, 0, UPG_MAX);
  }
  upgrades = def;
}
export function saveProgress() {
  try {
    localStorage.setItem("tr_bank", bank);
    localStorage.setItem("tr_owned", JSON.stringify(owned));
    localStorage.setItem("tr_selected", selectedCar);
    localStorage.setItem("tr_envs", JSON.stringify(ownedEnvs));
    localStorage.setItem("tr_env", selectedEnv);
    localStorage.setItem("tr_chal", JSON.stringify(challengesDone));
    localStorage.setItem("tr_mode", trafficMode);
    localStorage.setItem("tr_gamemode", gameMode);
    localStorage.setItem("tr_density", trafficDensity);
    localStorage.setItem("tr_view", viewDist);
    localStorage.setItem("tr_unit", speedUnit);
    localStorage.setItem("tr_quality", quality);
    localStorage.setItem("tr_muted", muted ? "1" : "0");
    localStorage.setItem("tr_hi", highScore);
    localStorage.setItem("tr_upg", JSON.stringify(upgrades));
    localStorage.setItem("tr_paints", JSON.stringify(ownedPaints));
    localStorage.setItem("tr_carpaint", JSON.stringify(carPaint));
    localStorage.setItem("tr_goals", JSON.stringify(goals));
    localStorage.setItem("tr_weekly", JSON.stringify(weekly));
    localStorage.setItem("tr_career", JSON.stringify(career));
    localStorage.setItem("tr_chalver", CHAL_VERSION);
  } catch (e) { /* ignore */ }
}

// ============================================================
//  Daily & weekly goals
// ============================================================
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
export const goalTmpl = (id) => ALL_GOAL_TMPL.find((g) => g.id === id);

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
function _todayStr() { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }
function _weekStr() {
  const d = new Date();
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const week = Math.floor(((d - jan1) / 86400000 + jan1.getDay()) / 7);
  return `${d.getFullYear()}-W${week}`;
}
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
export function ensureGoals() {
  const today = _todayStr();
  if (!goals || goals.date !== today || !Array.isArray(goals.items)) goals = genGoalSet(today, DAILY_POOL, 3);
  const wk = _weekStr();
  if (!weekly || weekly.date !== wk || !Array.isArray(weekly.items)) weekly = genGoalSet(wk, WEEKLY_POOL, 3);
}
export const allGoalItems = () => { ensureGoals(); return [...goals.items, ...weekly.items]; };

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
export function checkGoalsLive() {
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
export function trackGoals() {
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

// ---- Goals home-screen panel (markup) ----
export function goalsPanelHTML() {
  ensureGoals();
  const row = (it) => {
    const t = goalTmpl(it.id);
    if (!t) return ""; // a saved goal whose template no longer exists (skip, don't crash)
    const pct = Math.round(clamp(it.progress / it.target, 0, 1) * 100);
    return `<div class="goal ${it.done ? "done" : ""}">
      <div class="goal-top"><span class="goal-text">${t.fmt(it.target)}</span>` +
      `<span class="goal-rew">${it.done ? ico("ico-check") + " Done" : CRED_ICO + " " + it.reward}</span></div>
      <div class="goal-bar"><i style="width:${pct}%"></i></div>
      <span class="goal-prog">${t.prog(it.progress, it.target)}</span>
    </div>`;
  };
  const section = (title, items) => `<div class="goals-head">${title}</div>${items.map(row).join("")}`;
  return `<div class="goals">${section("DAILY GOALS", goals.items)}${section("WEEKLY GOALS", weekly.items)}</div>`;
}

// ============================================================
//  Toasts (transient top-center cards)
// ============================================================
export function showToast(inner, cls = "") {
  const wrap = document.getElementById("toasts");
  if (!wrap) return;
  const el = document.createElement("div");
  el.className = "toast " + cls;
  el.innerHTML = inner;
  wrap.appendChild(el);
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 400); }, 2600);
}
export function goalToast(it) {
  const t = goalTmpl(it.id);
  if (!t) return;
  showToast(
    `<span class="toast-ico">${ico("ico-check")}</span>` +
    `<div class="toast-body"><b>Goal complete</b><span>${t.fmt(it.target)}</span></div>` +
    `<span class="toast-rew">${CRED_ICO}${it.reward}</span>`,
    "goal"
  );
  audioUnlock();
}
export function challengeToast(it) {
  showToast(
    `<span class="toast-ico evt">${ico("ico-trophy")}</span>` +
    `<div class="toast-body"><b>Challenge complete</b><span>${chalDesc(it)}</span></div>` +
    `<span class="toast-rew">${CRED_ICO}${it.reward}</span>`, "event");
  audioUnlock();
}
export function onHeatStage(stage) {
  showToast(
    `<span class="toast-ico heat">${ico("ico-fire")}</span>` +
    `<div class="toast-body"><b>Heat ${stage}</b><span>Faster traffic · bigger score</span></div>`,
    "heat");
  audioHeat(stage);
}

// ============================================================
//  Progression ladder (career ranks)
// ============================================================
// "max" fields track your best single run; "sum" fields accumulate forever.
// chalValue() blends the committed career total with the run in progress.
export const CHAL_FIELDS = {
  runScore:   { agg: "max", career: "bestScore",   run: (r) => r.score,    fmt: (v) => fmt(v) },
  runPassed:  { agg: "max", career: "bestPassed",  run: (r) => r.passed,   fmt: (v) => fmt(v) },
  runDist:    { agg: "max", career: "bestDist",    run: (r) => r.distKm,   fmt: (v) => v.toFixed(1) + " km" },
  runCombo:   { agg: "max", career: "bestCombo",   run: (r) => r.maxCombo, fmt: (v) => fmt(v) },
  runSpeed:   { agg: "max", career: "bestSpeed",   run: (r) => r.topSpeed, fmt: (v) => spd(v) + " " + spdLabel() },
  runSlowmos: { agg: "max", career: "bestSlowmos", run: (r) => r.slowmos,  fmt: (v) => fmt(v) },
  totRuns:    { agg: "sum", career: "runs",        run: ()  => 0, fmt: (v) => fmt(v) }, // career.runs already counts the run; endRun commits then re-checks
  totDist:    { agg: "sum", career: "dist",        run: (r) => r.distKm,   fmt: (v) => fmt(Math.floor(v)) + " km" },
  totPassed:  { agg: "sum", career: "passed",      run: (r) => r.passed,   fmt: (v) => fmt(v) },
  totScore:   { agg: "sum", career: "scoreTotal",  run: (r) => r.score,    fmt: (v) => fmt(v) },
  totSlowmos: { agg: "sum", career: "slowmos",     run: (r) => r.slowmos,  fmt: (v) => fmt(v) },
  totShields: { agg: "sum", career: "shields",     run: (r) => r.shields,  fmt: (v) => fmt(v) },
};
export function chalValue(field, r) {
  const f = CHAL_FIELDS[field];
  const rv = f.run(r) || 0;
  return f.agg === "max" ? Math.max(career[f.career] || 0, rv) : (career[f.career] || 0) + rv;
}
export const ZERO_R = { distKm: 0, score: 0, passed: 0, maxCombo: 0, topSpeed: 0, slowmos: 0, shields: 0 };

export const CHALLENGES = [
  { tier: "Rookie", items: [
    { id: "rk-pass",  field: "runPassed",  target: 40,    reward: 200, desc: "Pass 40 cars in a single run" },
    { id: "rk-dist",  field: "runDist",    target: 3,     reward: 200, desc: "Drive 3 km in a single run" },
    { id: "rk-spd",   field: "runSpeed",   target: 36,    reward: 200, desc: () => `Hit ${spd(36)} ${spdLabel()}` },
    { id: "rk-combo", field: "runCombo",   target: 6,     reward: 200, desc: "Chain a 6-pass near-miss combo" },
  ]},
  { tier: "Pro", items: [
    { id: "pr-score", field: "runScore",   target: 12000, reward: 450, desc: "Score 12,000 in a single run" },
    { id: "pr-combo", field: "runCombo",   target: 12,    reward: 450, desc: "Chain a 12-pass near-miss combo" },
    { id: "pr-slow",  field: "runSlowmos", target: 1,     reward: 450, desc: "Trigger a slow-mo with a razor-close pass" },
    { id: "pr-runs",  field: "totRuns",    target: 5,     reward: 450, desc: "Complete 5 runs" },
  ]},
  { tier: "Ace", items: [
    { id: "ac-pass",  field: "runPassed",  target: 150,   reward: 750, desc: "Pass 150 cars in a single run" },
    { id: "ac-dist",  field: "runDist",    target: 10,    reward: 750, desc: "Drive 10 km in a single run" },
    { id: "ac-runs",  field: "totRuns",    target: 15,    reward: 750, desc: "Complete 15 runs" },
    { id: "ac-tpass", field: "totPassed",  target: 1500,  reward: 750, desc: "Pass 1,500 cars all-time" },
    { id: "ac-shld",  field: "totShields", target: 10,    reward: 750, desc: "Use 10 shields all-time" },
  ]},
  { tier: "Veteran", items: [
    { id: "vt-score", field: "runScore",   target: 45000,  reward: 1300, desc: "Score 45,000 in a single run" },
    { id: "vt-combo", field: "runCombo",   target: 30,     reward: 1300, desc: "Chain a 30-pass near-miss combo" },
    { id: "vt-slow",  field: "runSlowmos", target: 6,      reward: 1300, desc: "Trigger 6 slow-mos in one run" },
    { id: "vt-tdist", field: "totDist",    target: 250,    reward: 1300, desc: "Drive 250 km all-time" },
    { id: "vt-tscr",  field: "totScore",   target: 300000, reward: 1300, desc: "Bank 300,000 total score all-time" },
  ]},
  { tier: "Master", items: [
    { id: "ms-score", field: "runScore",   target: 75000,  reward: 2500, desc: "Score 75,000 in a single run" },
    { id: "ms-pass",  field: "runPassed",  target: 350,    reward: 2500, desc: "Pass 350 cars in a single run" },
    { id: "ms-spd",   field: "runSpeed",   target: 95,     reward: 2500, desc: () => `Hit ${spd(95)} ${spdLabel()}` },
    { id: "ms-runs",  field: "totRuns",    target: 70,     reward: 2500, desc: "Complete 70 runs" },
    { id: "ms-tdist", field: "totDist",    target: 600,    reward: 2500, desc: "Drive 600 km all-time" },
    { id: "ms-tslow", field: "totSlowmos", target: 120,    reward: 2500, desc: "Trigger 120 slow-mos all-time" },
  ]},
  { tier: "Legend", items: [
    { id: "lg-score", field: "runScore",   target: 120000,  reward: 5000, desc: "Score 120,000 in a single run" },
    { id: "lg-combo", field: "runCombo",   target: 60,      reward: 5000, desc: "Chain a 60-pass near-miss combo" },
    { id: "lg-pass",  field: "runPassed",  target: 500,     reward: 5000, desc: "Pass 500 cars in a single run" },
    { id: "lg-runs",  field: "totRuns",    target: 150,     reward: 5000, desc: "Complete 150 runs" },
    { id: "lg-tpass", field: "totPassed",  target: 50000,   reward: 5000, desc: "Pass 50,000 cars all-time" },
    { id: "lg-tscr",  field: "totScore",   target: 6000000, reward: 5000, desc: "Bank 6,000,000 total score all-time" },
  ]},
];
export const chalDesc = (it) => (typeof it.desc === "function" ? it.desc() : it.desc);
export const chalDone = (id) => challengesDone.includes(id);
export const tierUnlocked = (i) => i === 0 || CHALLENGES[i - 1].items.every((it) => chalDone(it.id));
export function careerRank() {
  let rank = "Unranked";
  for (const tier of CHALLENGES) if (tier.items.every((it) => chalDone(it.id))) rank = tier.tier;
  return rank;
}
export function runStatsNow() {
  return {
    distKm: state.position / DIST_DIV, score: state.score, passed: state.passed,
    maxCombo: state.maxCombo, topSpeed: state.topSpeed,
    slowmos: state.runSlowmos, shields: state.runShields,
  };
}
function checkChallenges(r) {
  const done = [];
  CHALLENGES.forEach((tier, i) => {
    if (!tierUnlocked(i)) return;
    for (const it of tier.items) {
      if (chalDone(it.id)) continue;
      if (chalValue(it.field, r) >= it.target) { challengesDone.push(it.id); bank += it.reward; done.push(it); }
    }
  });
  return done;
}
export function checkChallengesLive() {
  const done = checkChallenges(runStatsNow());
  if (done.length) { saveProgress(); for (const it of done) challengeToast(it); }
}

// Roll a finished run into the lifetime career totals (called by endRun).
export function commitCareer() {
  career.runs += 1;
  career.dist += state.position / DIST_DIV;
  career.passed += state.passed;
  career.scoreTotal += state.score;
  career.slowmos += state.runSlowmos;
  career.shields += state.runShields;
  career.bestScore = Math.max(career.bestScore, state.score);
  career.bestPassed = Math.max(career.bestPassed, state.passed);
  career.bestDist = Math.max(career.bestDist, state.position / DIST_DIV);
  career.bestCombo = Math.max(career.bestCombo, state.maxCombo);
  career.bestSpeed = Math.max(career.bestSpeed, state.topSpeed);
  career.bestSlowmos = Math.max(career.bestSlowmos, state.runSlowmos);
}
