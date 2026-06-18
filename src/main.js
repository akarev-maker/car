// Traffic Racer 3D — entry point: input, HUD, the fixed-step game loop, run
// lifecycle, and all the menu / garage / environment / settings / results UI.
// This module bootstraps the game at the bottom.

import * as THREE from "three";
import { Reflector } from "three/addons/objects/Reflector.js";
import {
  CARS, COMBO_WINDOW, CREDIT_RATE, CRED_ICO, DIST_DIV, ENVIRONMENTS, HEAT_SCORE, PAINTS,
  RARITY_COLOR, SLOWMO_MS, SLOWMO_SCALE, START_LANE, STAT_CEIL, UPG_MAX, UPG_TRACKS, clamp,
  comboMult, credCost, fmt, getCar, getEnv, getPaint, ico, rankFor, upgradeCost
} from "./config.js";
import {
  CHALLENGES, CHAL_FIELDS, ZERO_R, activeCar, addBank, bank, careerRank, chalDesc,
  chalDone, chalValue, checkChallengesLive, commitCareer,
  effStats, goalTmpl, goals, goalsJustDone, goalsPanelHTML, highScore, input, keys, lastEarned,
  loadProgress, muted, owned, ownedEnvs, quality, saveProgress, selectedCar, selectedEnv,
  setActiveCar, setActiveStats, setGoalsJustDone, setHighScore, setLastEarned, setQuality,
  setSelectedCar, setSelectedEnv, setSpeedUnit, setTrafficDensity, setTrafficMode, spd,
  spdLabel, speedUnit, state, tierUnlocked, trackGoals, trafficDensity, trafficMode, upgrades,
  walletPill, pursuit, setPursuit,
  addOwnedPaint, setCarPaint, paintIdOf, paintOwned, paintSpecOf
} from "./store.js";
import {
  audioCoin, audioCrash, audioDenied, audioEngine, audioTick, audioUnlock, ensureAudio,
  hushEngine, setEngineProfile, toggleMute, audioSiren
} from "./audio.js";
import {
  resetEntities, update, updateScenery
} from "./world3d.js";
import {
  _matSilhouette, buildPlayerCar, initThree, loadCarModel, modelCache, playerCarId, ready3d,
  render, renderer, setPlayerCar
} from "./render.js";

// ---- Keyboard ----
window.addEventListener("keydown", (e) => {
  switch (e.key) {
    case "ArrowLeft": case "a": case "A": keys.left = true; break;
    case "ArrowRight": case "d": case "D": keys.right = true; break;
    case "ArrowUp": case "w": case "W": keys.up = true; break;
    case "ArrowDown": case "s": case "S": keys.down = true; break;
    case "m": case "M": toggleMute(); break;
    case "f": case "F": toggleFps(); break; // perf overlay (fps / frame time / draw calls)
    case "p": case "P": case "Escape": togglePause(); break; // pause / resume (Quit to Home lives in the menu)
    case "r": case "R": if (state.running) startGame(); break; // restart the current run from scratch
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
// Releasing focus (alt-tab, clicking away) never fires keyup, which would leave
// a held key "stuck on". Clear all inputs whenever the window loses focus.
window.addEventListener("blur", () => { keys.left = keys.right = keys.up = keys.down = false; });

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
    shield: document.getElementById("shield"),
    shieldFill: document.getElementById("shield-fill"),
    heat: document.getElementById("heat-hud"),
    heatStage: document.getElementById("heat-stage"),
    heatMult: document.getElementById("heat-mult"),
    bust: document.getElementById("bust-hud"),
    bustFill: document.getElementById("bust-fill"),
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
  if (hud.shield) {
    hud.shield.classList.toggle("armed", state.shield);
    hud.shieldFill.style.width = (state.shield ? 100 : state.shieldCharge * 100) + "%";
  }
  if (hud.heat) {
    // Show the readout once the road starts heating up (past the stage-1 warmup).
    hud.heat.classList.toggle("on", state.heatStage > 1);
    hud.heatStage.textContent = "HEAT " + state.heatStage;
    hud.heatMult.textContent = "x" + (1 + HEAT_SCORE * state.heat).toFixed(1);
  }
  if (hud.bust) {
    hud.bust.classList.toggle("on", pursuit);            // only shown in Pursuit mode
    if (pursuit) {
      hud.bustFill.style.width = state.bust * 100 + "%";
      hud.bust.classList.toggle("hot", state.bust > 0.66); // flashing red near the bust
    }
  }
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
let _lastSiren = 0;       // last siren wail timestamp (Pursuit), for rate-limiting
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
  const dtReal = now - _loopPrev;
  _loopPrev = now;
  // Exceptional-pass slow-mo: scale how much real time feeds the fixed-step sim,
  // so fewer physics steps run while the dip is active. Timers run in real time;
  // the dip snaps in then eases back to normal as it drains.
  if (state.slowmoCD > 0) state.slowmoCD = Math.max(0, state.slowmoCD - dtReal);
  let timeScale = 1;
  if (state.slowmoT > 0) {
    state.slowmoT = Math.max(0, state.slowmoT - dtReal);
    timeScale = SLOWMO_SCALE + (1 - SLOWMO_SCALE) * (1 - state.slowmoT / SLOWMO_MS);
  }
  _accum += dtReal * timeScale;
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
    // Pursuit: loop the siren while the bust meter is hot (rate-limited; louder near the bust).
    if (pursuit && state.bust > 0.5 && now - _lastSiren > 820) {
      _lastSiren = now;
      audioSiren(0.6 + state.bust * 0.6);
    }
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
    hushEngine(0.0001, 0.08); // hush the engine
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
  state.runSlowmos = 0; state.runShields = 0;
  state.kick = 0; state.flashHue = 0; state.whiteout = 0;
  state.slowmoT = 0; state.slowmoCD = 0;
  state.shield = false; state.shieldCharge = 0; state.invuln = 0;
  state.heat = 0; state.heatStage = 1;
  state.bust = 0; state.frames = 0;
  resetEntities(); // clears traffic/scenery/popups/rings (owned by world3d)
}

function startGame() {
  ensureAudio();
  stopIdle();
  setActiveCar(getCar(selectedCar));
  setActiveStats(effStats(activeCar));
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

export function gameOver() { endRun(true); }          // crashed into traffic -> results
export function getBusted() { endRun(true, false, true); } // bust meter filled (Pursuit) -> results
function quitRun() { endRun(false, true); }    // chose to stop (Esc) -> straight home

// End the current run: bank credits, record the high score, show results. A
// crash adds the impact SFX + shake and a beat before the card; a voluntary
// stop skips straight to it.
let _bustedRun = false; // set when the last run ended on the bust meter (Pursuit), for the results header
function endRun(crashed, toHome, busted = false) {
  if (!state.running) return;
  state.running = false;
  _bustedRun = busted;
  hushEngine(0, 0.1);
  if (crashed) {
    audioCrash();
    state.shake = 1.6;
    state.whiteout = 1; state.hitFlash = 1; // blowout flash + cracks on the frozen frame
    render(); // one shaken, frozen frame for impact
  }

  // Score is the bragging number; credits earned are a fraction of it.
  setLastEarned(Math.round(state.score * CREDIT_RATE));
  addBank(lastEarned);
  const isHi = state.score > highScore;
  if (isHi) setHighScore(state.score);
  // Roll this run into the lifetime career totals (the ladder grinds against
  // these), then do a final authoritative goal + challenge check. The per-step
  // live checks are throttled and the fatal frame skips its own check on a crash,
  // so this is what reliably awards end-of-run and run-based challenges.
  commitCareer();
  setGoalsJustDone(trackGoals()); // may add goal rewards to the bank too
  checkChallengesLive();          // catches challenges completed on the final frame
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


function showResults(isHi) {
  const r = rankFor(state.score);
  const el = document.getElementById("results");
  const stat = (k, v) => `<div class="rstat"><span>${k}</span><b>${v}</b></div>`;
  el.innerHTML = `
    <div class="results-card${_bustedRun ? " busted" : ""}">
      <div class="results-rank rank-${r.label.toLowerCase()}">${_bustedRun ? ico("ico-shield") : r.label}</div>
      <h1 class="results-title">${_bustedRun ? "BUSTED!" : isHi ? "NEW BEST!" : "Run Complete"}</h1>
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
        `<div class="rgoal"><span class="rgoal-l">${ico("ico-check")} ${goalTmpl(it.id).fmt(it.target)}</span> <b>+${it.reward}</b></div>`).join("")}</div>` : ""}
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

// Animate an element's number from its last value up/down to `to`.
function rollNumber(el, to, dur = 650) {
  if (!el) return;
  const from = Number(el.dataset.val || 0);
  el.dataset.val = to;
  if (el._rollRAF) cancelAnimationFrame(el._rollRAF); // don't stack chains on rapid updates
  if (from === to) { el.textContent = fmt(to); return; }
  const start = performance.now();
  (function step(now) {
    const k = Math.min(1, (now - start) / dur);
    const e = 1 - Math.pow(1 - k, 3); // easeOutCubic
    el.textContent = fmt(from + (to - from) * e);
    if (k < 1) el._rollRAF = requestAnimationFrame(step);
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

function showMenu() {
  const car = getCar(selectedCar);
  const overlay = document.getElementById("overlay");
  overlay.innerHTML = `
    <div class="home-top">
      <h1 class="home-logo">TRAFFIC <span>RACER</span></h1>
      <p class="home-stats">${walletPill("menu-credits")} &nbsp;·&nbsp; <span class="best">${ico("ico-trophy")} ${fmt(highScore)}</span> &nbsp;·&nbsp; <span class="best">${ico("ico-car")} ${owned.length}/${CARS.length}</span> &nbsp;·&nbsp; <span class="best">${careerRank()}</span></p>
      ${goalsPanelHTML()}
    </div>
    <div class="home-bottom">
      <p class="home-car">Now driving · <b style="color:${car.color}">${car.name}</b> · <b class="home-env">${getEnv(selectedEnv).name}</b></p>
      <div class="menu-btns">
        <button id="start-btn">Start</button>
        <button id="garage-btn" class="alt">Garage</button>
        <button id="envs-btn" class="alt">Environments</button>
        <button id="chal-btn" class="alt">Challenges</button>
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
  document.getElementById("chal-btn").addEventListener("click", openChallenges);
  document.getElementById("settings-btn").addEventListener("click", showSettings);
  startIdle(); // bring the hero car / road to life behind the menu
}

// The progression ladder, rendered into the menu overlay. Tiers unlock in order;
// each unlocked, unfinished row shows a live progress bar (best run for skill
// feats, lifetime total for grind goals), its reward, or a check once cleared.
function openChallenges() {
  const overlay = document.getElementById("overlay");
  const tiers = CHALLENGES.map((tier, i) => {
    const unlocked = tierUnlocked(i);
    const rows = tier.items.map((it) => {
      const done = chalDone(it.id);
      const icon = done ? ico("ico-check") : unlocked ? ico("ico-trophy") : ico("ico-lock");
      const rew = done ? `${ico("ico-check")} Done` : `${CRED_ICO} ${fmt(it.reward)}`;
      // Progress only matters for an unlocked, not-yet-cleared challenge.
      let prog = "";
      if (unlocked && !done) {
        const f = CHAL_FIELDS[it.field];
        const val = chalValue(it.field, ZERO_R);
        const pct = Math.round(clamp(val / it.target, 0, 1) * 100);
        prog = `<div class="chal-bar"><i style="width:${pct}%"></i></div>
          <span class="chal-prog">${f.fmt(Math.min(val, it.target))} / ${f.fmt(it.target)}</span>`;
      }
      return `<div class="chal ${done ? "done" : ""}${unlocked ? "" : " locked"}">
        <span class="chal-ico">${icon}</span>
        <div class="chal-main"><span class="chal-desc">${chalDesc(it)}</span>${prog}</div>
        <span class="chal-rew">${rew}</span>
      </div>`;
    }).join("");
    const cleared = tier.items.filter((it) => chalDone(it.id)).length;
    return `<div class="chal-tier${unlocked ? "" : " locked"}">
      <div class="chal-tier-head"><span>${tier.tier}</span><span class="chal-count">${cleared}/${tier.items.length}</span></div>
      ${rows}
    </div>`;
  }).join("");
  overlay.innerHTML = `
    <div class="chal-screen">
      <h2>Challenges <span class="chal-rank">${ico("ico-trophy")} ${careerRank()}</span></h2>
      <div class="chal-list">${tiers}</div>
      <button id="chal-back">Back</button>
    </div>`;
  overlay.classList.remove("hidden");
  document.body.classList.remove("playing");
  document.getElementById("chal-back").addEventListener("click", showMenu);
  startIdle(); // keep the hero road alive behind the panel
}

// A simple settings screen rendered into the same overlay as the menu. Each
// row is a segmented toggle; changes apply live and persist immediately.
function showSettings() {
  const overlay = document.getElementById("overlay");
  const seg = (id, on, off, onSel) =>
    `<div class="mode-toggle"><button id="${id}-a" class="mode-opt ${onSel ? "on" : ""}">${on}</button>` +
    `<button id="${id}-b" class="mode-opt ${onSel ? "" : "on"}">${off}</button></div>`;
  // Segmented control with N options; each button id is `${id}-${value}`.
  const segN = (id, opts, cur) =>
    `<div class="mode-toggle">${opts.map(([val, label]) =>
      `<button id="${id}-${val}" class="mode-opt ${val === cur ? "on" : ""}">${label}</button>`).join("")}</div>`;
  overlay.innerHTML = `
    <div class="settings-panel">
      <h2>Settings</h2>
      <div class="set-row"><span class="set-label">Speed units</span>${seg("set-unit", "km/h", "mph", speedUnit === "kmh")}</div>
      <div class="set-row"><span class="set-label">Traffic</span>${seg("set-mode", "Two-way", "One-way", trafficMode === "twoway")}</div>
      <div class="set-row"><span class="set-label">Traffic density</span>${segN("set-dens", [["low", "Low"], ["medium", "Med"], ["high", "High"]], trafficDensity)}</div>
      <div class="set-row"><span class="set-label">Police pursuit</span>${seg("set-pursuit", "On", "Off", pursuit)}</div>
      <div class="set-row"><span class="set-label">Graphics</span>${seg("set-q", "High", "Low", quality === "high")}</div>
      <div class="set-row"><span class="set-label">Sound</span>${seg("set-snd", "On", "Off", !muted)}</div>
      <button id="settings-back">Back</button>
    </div>
  `;
  overlay.classList.remove("hidden");
  document.body.classList.remove("playing");
  const reopen = () => { saveProgress(); showSettings(); };
  document.getElementById("set-unit-a").addEventListener("click", () => { setSpeedUnit("kmh"); reopen(); });
  document.getElementById("set-unit-b").addEventListener("click", () => { setSpeedUnit("mph"); reopen(); });
  document.getElementById("set-mode-a").addEventListener("click", () => { setTrafficMode("twoway"); showSettings(); });
  document.getElementById("set-mode-b").addEventListener("click", () => { setTrafficMode("oneway"); showSettings(); });
  for (const d of ["low", "medium", "high"])
    document.getElementById(`set-dens-${d}`).addEventListener("click", () => { setTrafficDensity(d); showSettings(); });
  document.getElementById("set-pursuit-a").addEventListener("click", () => { setPursuit(true); reopen(); });
  document.getElementById("set-pursuit-b").addEventListener("click", () => { setPursuit(false); reopen(); });
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
export let garageOpen = false;
let garageBuilt = false;
export let garageIndex = 0;
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
  pvSpot.intensity = lux ? 6 : 3.2; // every tier gets a key light so paint colour/finish reads true
  pvHemi.intensity = lux ? 0.5 : 1.0;
  pvRing.material.color.set(paintSpecOf(car).color); // accent ring follows the car's paint
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

export function setPreviewCar(car) {
  if (pvCar) { pvScene.remove(pvCar); pvCar = null; }
  const cached = modelCache[car.id];
  if (cached && cached !== "loading" && cached !== "failed") pvCar = cached.mesh.clone(true);
  else { pvCar = buildPlayerCar(car); loadCarModel(car); }
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
  if (isSel) action = `<span class="tag sel">${ico("ico-check")} Selected</span>`;
  else if (isOwned) action = `<button class="alt car-btn" data-car="${c.id}">Select</button>`;
  else action = `<button class="car-btn buy" data-car="${c.id}" ${bank < c.price ? "disabled" : ""}>Buy ${credCost(c.price)}</button>`;

  const upg = isOwned
    ? `<div class="upgrades">${UPG_TRACKS.map((t) => upgradeRowHTML(c, t)).join("")}</div>`
    : `<p class="locked-note">${ico("ico-lock")} Purchase to unlock tuning.</p>`;

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
    ${paintRowHTML(c)}
    <div class="showroom-actions">${action}</div>
  `;

  const info = document.getElementById("showroom-info");
  info.querySelectorAll(".car-btn").forEach((btn) =>
    btn.addEventListener("click", () => handleCarClick(btn.dataset.car)));
  info.querySelectorAll(".upg-btn").forEach((btn) =>
    btn.addEventListener("click", () => buyUpgrade(btn.dataset.car, btn.dataset.track)));
  info.querySelectorAll(".paint-sw").forEach((btn) =>
    btn.addEventListener("click", () => handlePaintClick(c.id, btn.dataset.paint)));
}

// The paint shop: a swatch per palette colour, shown only for cars you own.
// Owned paints select instantly (live preview); locked ones show their price
// and buy on click. "stock" is the car's own factory colour, always free.
function paintRowHTML(car) {
  if (!owned.includes(car.id)) return "";
  const sel = paintIdOf(car.id);
  const swatch = (p) => {
    const have = paintOwned(p.id);
    const col = p.id === "stock" ? car.color : p.hex;
    const cls = `paint-sw fin-${p.finish}${p.id === sel ? " on" : ""}${have ? "" : " locked"}`;
    const label = have ? p.name : `${p.name} — ${fmt(p.price)} CR`;
    const badge = p.id === sel ? ico("ico-check") : (have ? "" : ico("ico-lock"));
    return `<button class="${cls}" data-paint="${p.id}" style="--sw:${col}" title="${label}" aria-label="${label}">${badge}</button>`;
  };
  const selName = getPaint(sel).name + (sel === "stock" ? "" : " · " + getPaint(sel).finish);
  return `<div class="paint-shop">
    <div class="paint-head"><span>PAINT</span><span class="paint-name">${selName}</span></div>
    <div class="paint-swatches">${PAINTS.map(swatch).join("")}</div>
  </div>`;
}

function handlePaintClick(carId, paintId) {
  const p = getPaint(paintId);
  if (paintOwned(paintId)) {
    setCarPaint(carId, paintId);
    audioTick();
  } else if (bank >= p.price) {
    const btn = document.querySelector(`.paint-sw[data-paint="${paintId}"]`);
    addBank(-p.price);
    addOwnedPaint(paintId);
    setCarPaint(carId, paintId);
    audioUnlock();
    floatDelta(btn, `- ${fmt(p.price)}`, "spend");
  } else {
    audioDenied();
    return;
  }
  saveProgress();
  updateGarageBank();
  refreshShowroom(); // re-render swatches + rebuild the preview in the new paint
  showMenu();        // refresh the wallet on the menu behind
}

function buyUpgrade(carId, trackKey) {
  const c = getCar(carId);
  const lvl = upgrades[carId][trackKey];
  if (lvl >= UPG_MAX) { audioDenied(); return; }
  const cost = upgradeCost(c, lvl);
  const btn = document.querySelector(`.upg-btn[data-car="${carId}"][data-track="${trackKey}"]`);
  if (bank < cost) { audioDenied(); return; }
  addBank(-cost);
  upgrades[carId][trackKey] = lvl + 1;
  if (carId === selectedCar) setActiveStats(effStats(c)); // reflect immediately
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
    setSelectedCar(id);
    audioTick();
  } else if (bank >= c.price) {
    const btn = document.querySelector(`.car-btn[data-car="${id}"]`);
    addBank(-c.price);
    owned.push(id);
    setSelectedCar(id);
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
  const glyph = { plains: "ico-leaf", desert: "ico-cactus", city: "ico-building", neon: "ico-spark" }[env.scape] || "ico-leaf";
  return `<div class="env-diorama" style="background:linear-gradient(180deg,
      ${hexColor(p.sky)} 0%, ${hexColor(p.sky)} 56%, ${hexColor(p.grass)} 57%, ${hexColor(p.grass)} 100%)">
      ${ico(glyph, "env-ico")}
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
  if (isSel) action = `<span class="tag sel">${ico("ico-check")} Selected</span>`;
  else if (isOwned) action = `<button class="alt env-btn" data-env="${e.id}">Drive here</button>`;
  else action = `<button class="env-btn buy" data-env="${e.id}" ${bank < e.price ? "disabled" : ""}>Unlock ${credCost(e.price)}</button>`;

  const sun = ico("ico-sun", "badge-ico"), moon = ico("ico-moon", "badge-ico");
  const timeBadge = e.nightOnly ? `${moon} Night only`
    : e.dayOnly ? `${sun} Day only`
    : e.startNight ? `${moon} Day &amp; night · opens at night`
    : `${sun} Day &amp; night`;

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
    ${isOwned ? "" : `<p class="locked-note">${ico("ico-lock")} Unlock to drive in this world.</p>`}
    <div class="showroom-actions">${action}</div>
  `;
  document.getElementById("env-info").querySelectorAll(".env-btn").forEach((btn) =>
    btn.addEventListener("click", () => handleEnvClick(btn.dataset.env)));
}

function handleEnvClick(id) {
  const e = getEnv(id);
  if (ownedEnvs.includes(id)) {
    setSelectedEnv(id);
    audioTick();
  } else if (bank >= e.price) {
    const btn = document.querySelector(`.env-btn[data-env="${id}"]`);
    addBank(-e.price);
    ownedEnvs.push(id);
    setSelectedEnv(id);
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

// Bootstrap. Deferred to DOMContentLoaded so the whole ES-module graph (this
// file imports store/render, which import back into this one — a cycle) has
// fully evaluated before any module-level state is touched. Module scripts always
// finish evaluating before DOMContentLoaded fires, so store's bindings are ready.
function boot() {
  document.getElementById("mute").addEventListener("click", toggleMute);
  document.getElementById("pause-btn").addEventListener("click", togglePause);
  loadProgress();
  // Set the mute icon AFTER loading saved state, so a muted player sees the muted
  // icon on reload (this line used to run before loadProgress and showed the wrong one).
  document.getElementById("mute").innerHTML = ico(muted ? "ico-vol-off" : "ico-vol-on");
  initThree();
  showMenu();
  render();
}
// NB: never call boot() synchronously here. Module scripts are deferred, so at
// this point the cyclic graph (store ⇄ render ⇄ main) is still mid-evaluation and
// store's bindings aren't initialized yet. DOMContentLoaded (or a deferred tick)
// runs boot only once every module body has finished.
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else setTimeout(boot, 0);
