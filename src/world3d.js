// ============================================================
//  world3d.js — the simulation: traffic AI, scenery, and the physics step.
//  Owns the live entity arrays; render.js reads them, main.js resets them.
// ============================================================

import * as THREE from "three";
import {
  ONEWAY_LANES, FWD_LANES, ONC_LANES, VEHICLES, TRAFFIC_COLORS, TRAFFIC_GAP,
  TRAFFIC_MAX_SPEED, TRAFFIC_MIN_FACTOR, SIGNAL_FRAMES, LANE_CHANGE_RATE, SCAPES,
  SIGN_COLORS, ROAD_HALF_W, DIST_DIV, SCENERY_STEP, PLAYER_DZ, LANE_TOLERANCE,
  HARD_TOLERANCE, NEAR_MISS_RANGE, ONCOMING_BONUS, HEAT_CLOSE, HEAT_ONC, HEAT_GAP,
  HEAT_SCORE, COMBO_WINDOW, comboMult, SLOWMO_MS, SLOWMO_CD, SLOWMO_CLOSE,
  SHIELD_GAIN_BASE, SHIELD_GAIN_CLOSE, SHIELD_INVULN, ENGINE_BRAKE, DRAG,
  STEER_ACCEL, STEER_FRICTION, STEER_MAX_V, PLAYER_X_LIMIT, clamp, worldX,
} from "./config.js";
import {
  state, keys, input, activeStats, trafficMode, densityCfg, spawnAhead, heatAt,
  checkGoalsLive, checkChallengesLive, onHeatStage,
} from "./store.js";
import {
  audioWhoosh, audioCombo, audioSlowmo, audioShieldReady, audioScrape, audioShield,
} from "./audio.js";
import { scapeAt, camera, fx } from "./render.js";
import { gameOver } from "./main.js";

// Live entity arrays (reassigned only here, via resetEntities).
export let traffic = [];
export let scenery = [];
export let popups = [];
export let rings = [];
export function resetEntities() { traffic = []; scenery = []; popups = []; rings = []; }
let _liveTick = 0; // throttles the mid-run goal/challenge checks (see update())

// ---- Traffic ----
export function pickKind(dir) {
  const r = Math.random();
  if (dir < 0) return r < 0.10 ? "truck" : r < 0.17 ? "bus" : "car";
  return r < 0.15 ? "truck" : r < 0.26 ? "bus" : "car";
}
// Lanes flowing your way: all four in one-way mode, the right pair in two-way.
export function fwdLanes() { return trafficMode === "oneway" ? ONEWAY_LANES : FWD_LANES; }
// The set of lanes a vehicle can weave within (its own carriageway).
export function laneGroupOf(car) {
  if (car.dir < 0) return ONC_LANES;
  return trafficMode === "oneway" ? ONEWAY_LANES : FWD_LANES;
}
// A random lane immediately adjacent to `lane` within its group (or itself).
export function adjacentLane(lane, group) {
  const i = group.indexOf(lane);
  const opts = [];
  if (i > 0) opts.push(group[i - 1]);
  if (i < group.length - 1) opts.push(group[i + 1]);
  return opts.length ? opts[Math.floor(Math.random() * opts.length)] : lane;
}

export function spawnVehicle(lane, dir) {
  const z = state.position + spawnAhead();
  // Don't drop a vehicle on top of one already heading the same way in this lane.
  for (const c of traffic) {
    if (c.lane === lane && c.dir === dir && Math.abs(c.z - z) < TRAFFIC_GAP * 1.6) return;
  }
  const kind = pickKind(dir);
  const v = VEHICLES[kind];
  // Everyone keeps moving — slowest is still half of top traffic speed. As heat
  // climbs, new traffic closes faster (uncapped) — the main thing that, in time,
  // outruns your reaction and ends the run.
  const base = TRAFFIC_MAX_SPEED * (TRAFFIC_MIN_FACTOR + (1 - TRAFFIC_MIN_FACTOR) * Math.random());
  traffic.push({
    lane, lx: lane, z, dir, kind,
    halfW: v.halfW,
    prevDz: spawnAhead(),
    speed: base * v.speedF * (1 + HEAT_CLOSE * state.heat),
    color: TRAFFIC_COLORS[Math.floor(Math.random() * TRAFFIC_COLORS.length)],
    changeCD: 90 + Math.floor(Math.random() * 180), // frames until it may weave
    signalDir: 0,      // world side it's signaling (-1 left, +1 right, 0 none)
    signalTimer: 0,    // frames of blinker left before the merge commits
    targetLane: null,  // lane it intends to merge into
  });
}

export function spawnWave() {
  const fl = fwdLanes();
  const onc = densityCfg().onc; // extra-car / oncoming odds scale with density
  if (trafficMode === "oneway") {
    // Classic: 1–3 cars across the four lanes, always leaving a gap to thread.
    const lanes = [...fl];
    let count = 1;
    if (Math.random() < Math.min(0.6, state.heat * 0.18) * onc) count++;
    if (Math.random() < Math.min(0.4, state.heat * 0.10) * onc) count++;
    count = Math.min(count, fl.length - 2);
    for (let n = 0; n < count; n++)
      spawnVehicle(lanes.splice(Math.floor(Math.random() * lanes.length), 1)[0], 1);
    return;
  }
  // Two-way: one forward vehicle (so a forward lane is always threadable), plus
  // a chance of oncoming whose density ramps with distance.
  spawnVehicle(fl[Math.floor(Math.random() * fl.length)], 1);
  const oncChance = Math.min(0.92, (0.25 + HEAT_ONC * state.heat) * onc);
  if (Math.random() < oncChance)
    spawnVehicle(ONC_LANES[Math.floor(Math.random() * ONC_LANES.length)], -1);
}


export function addPopup(x, y, text, color, big = false) {
  popups.push({ x, y, text, color, life: 1, big });
}
// A shockwave ring that bursts out from a near-miss point and fades.
export function addRing(x, y, closeness, color) {
  rings.push({ x, y, r: 8, max: 26 + closeness * 70, life: 1, color, w: 2 + closeness * 4 });
}

// Car-following: within each lane, a faster car can't drive through the car
// ahead. It closes the gap, then matches the leader's speed (like real traffic).
const _followGroups = new Map(); // key -> car list; reused each frame (arrays kept, just cleared)
export function resolveTrafficFollowing() {
  for (const list of _followGroups.values()) list.length = 0; // clear without freeing the arrays
  for (const car of traffic) {
    const key = car.dir + ":" + car.lane; // each carriageway lane queues on its own
    let list = _followGroups.get(key);
    if (!list) { list = []; _followGroups.set(key, list); }
    list.push(car);
  }
  for (const list of _followGroups.values()) {
    if (list.length < 2) continue;
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
export function laneClearForMerge(car, lane) {
  for (const c of traffic) {
    if (c === car || c.dir !== car.dir) continue;
    const occupies = c.lane === lane || Math.abs(c.lx - lane) < 0.2;
    if (occupies && Math.abs(c.z - car.z) < TRAFFIC_GAP * 1.3) return false;
  }
  return true;
}

export function updateLaneChange(car) {
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
export function pickType(scape) {
  const table = SCAPES[scape] || SCAPES.plains;
  let total = 0; for (const e of table) total += e[1];
  let r = Math.random() * total;
  for (const [type, w] of table) { if ((r -= w) < 0) return type; }
  return table[0][0];
}

export function spawnScenery(z) {
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
export function updateScenery() {
  while (state.nextSceneryZ < state.position + spawnAhead() + 1500) {
    spawnScenery(state.nextSceneryZ);
    state.nextSceneryZ += SCENERY_STEP * (0.6 + Math.random() * 0.8);
  }
  for (let i = scenery.length - 1; i >= 0; i--) {
    if (scenery[i].z - state.position < -200) scenery.splice(i, 1);
  }
}

// Project a 3D world point to 2D overlay (fx canvas) pixels, for score popups.
const _projV = new THREE.Vector3();
export function worldToScreen(x, y, z) {
  _projV.set(x, y, z).project(camera);
  return { x: (_projV.x * 0.5 + 0.5) * fx.width, y: (-_projV.y * 0.5 + 0.5) * fx.height };
}

// ---- Update (physics step) ----
// ---- Update ----
export function update() {
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

  // Heat climbs with distance survived. Crossing into a new stage fires a banner.
  state.heat = heatAt();
  const stage = 1 + Math.floor(state.heat);
  if (stage > state.heatStage) { state.heatStage = stage; onHeatStage(stage); }

  // Steering (handling scales with the car; grip firms up with speed)
  const grip = 0.25 + 0.75 * (state.speed / state.maxSpeed);
  state.playerVX += input.steer * STEER_ACCEL * activeStats.handling * grip;
  if (input.steer === 0) state.playerVX *= STEER_FRICTION;
  state.playerVX = clamp(state.playerVX, -STEER_MAX_V * activeStats.handling, STEER_MAX_V * activeStats.handling);
  state.playerX += state.playerVX;
  if (state.playerX < -PLAYER_X_LIMIT) { state.playerX = -PLAYER_X_LIMIT; state.playerVX = 0; }
  if (state.playerX > PLAYER_X_LIMIT) { state.playerX = PLAYER_X_LIMIT; state.playerVX = 0; }

  // Spawn traffic by distance, packed tighter as heat climbs, scaled by density.
  const heatGap = Math.max(0.4, 1 - HEAT_GAP * state.heat);
  const spawnGap = Math.max(1000, 3000 * heatGap) * densityCfg().gap;
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
  if (state.invuln > 0) state.invuln--; // post-shield phase-through winds down

  // Passes/crashes happen at YOUR plane (where you see them alongside).
  const speedFactor = state.speed / state.maxSpeed;
  const heatMult = 1 + HEAT_SCORE * state.heat; // deeper into the run pays more
  for (let i = traffic.length - 1; i >= 0; i--) {
    const car = traffic[i];
    const dz = car.z - state.position;

    if (car.prevDz > PLAYER_DZ && dz <= PLAYER_DZ) {
      const lateral = Math.abs(state.playerX - car.lx);
      const sp = worldToScreen(worldX(car.lx), 1.8, 0);
      const pan = clamp(car.lx - state.playerX, -1, 1);

      const tol = car.halfW;                    // heavies are wider, so contact sooner
      if (state.invuln > 0 && lateral < LANE_TOLERANCE + tol) {
        // Phasing through traffic during post-shield invulnerability: no contact.
      } else if (lateral < HARD_TOLERANCE + tol) { // near head-on
        if (state.shield) { shieldSave(pan); }  // a held shield eats the hit
        else { gameOver(); return; }            // otherwise the run ends
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
          const pts = Math.round((40 + closeness * 200) * (0.35 + 0.65 * speedFactor) * onc * heatMult) * state.mult;
          state.score += pts;
          const tag = state.mult > 1 ? `x${state.mult} +${pts}` : `+${pts}`;
          // Juice: the edge pulse runs hotter (gold -> white) with the combo
          // tier; the camera kicks away from the car; a ring bursts at the pass.
          state.flashHue = clamp((state.mult - 1) / 7, 0, 1);
          state.kick += pan * (0.3 + closeness * 0.7);
          audioCombo(state.mult);
          // A genuinely close pass at speed bends time for a beat (rate-limited).
          const exceptional = closeness > SLOWMO_CLOSE && speedFactor > 0.7;
          if (exceptional && state.slowmoCD <= 0) {
            state.slowmoT = SLOWMO_MS; state.slowmoCD = SLOWMO_CD;
            state.runSlowmos++;
            audioSlowmo();
          }
          // Near-misses charge a shield (closer = more); fills to one held shield
          // that auto-saves you from the next fatal hit. Hold one at a time.
          if (!state.shield) {
            state.shieldCharge += SHIELD_GAIN_BASE + closeness * SHIELD_GAIN_CLOSE;
            if (state.shieldCharge >= 1) {
              state.shieldCharge = 0; state.shield = true;
              addPopup(sp.x, sp.y - 26, "SHIELD READY", "#38e1ff", true);
              audioShieldReady();
            }
          }
          if (car.dir < 0 && closeness > 0.4) {
            addPopup(sp.x, sp.y, (exceptional ? "SO CLOSE! " : "ONCOMING! ") + tag, "#ff6b6b", true);
            state.flash = Math.max(state.flash, Math.max(closeness, 0.6));
            addRing(sp.x, sp.y, closeness, "255,107,107");
          } else if (closeness > 0.6 && speedFactor > 0.6) {
            addPopup(sp.x, sp.y, (exceptional ? "SO CLOSE! " : "NEAR MISS ") + tag, "#ffe07a", true);
            state.flash = Math.max(state.flash, closeness);
            addRing(sp.x, sp.y, closeness, "255,224,122");
          } else {
            addPopup(sp.x, sp.y, tag, "#54e08a");
            if (closeness > 0.3) addRing(sp.x, sp.y, closeness, "84,224,138");
          }
        } else {
          state.score += Math.round(8 * (0.5 + 0.5 * speedFactor) * heatMult) * state.mult;
        }
        audioWhoosh(pan, (0.25 + 0.75 * closeness) * (0.4 + 0.6 * speedFactor));
      }
    }
    car.prevDz = dz;

    if (dz < -300 || dz > spawnAhead() + 4000) traffic.splice(i, 1);
  }

  for (let i = popups.length - 1; i >= 0; i--) {
    popups[i].life -= 0.02;
    popups[i].y -= 0.6;
    if (popups[i].life <= 0) popups.splice(i, 1);
  }
  for (let i = rings.length - 1; i >= 0; i--) {
    const r = rings[i];
    r.r += (r.max - r.r) * 0.28; // ease outward
    r.life -= 0.06;
    if (r.life <= 0) rings.splice(i, 1);
  }
  state.flash *= 0.9;
  state.hitFlash *= 0.88;
  state.shake *= 0.85;
  state.kick *= 0.8;
  state.whiteout *= 0.85;
  // Mid-run celebration toasts only — a few frames' latency is imperceptible, so
  // keep these off the per-step hot path (update can run up to 5x per frame).
  // endRun does a final authoritative check, so nothing is missed at the finish.
  if (++_liveTick % 12 === 0) { checkGoalsLive(); checkChallengesLive(); }
  // NOTE: HUD + engine audio are presentation, not physics. They run once per
  // rendered frame from loop(), never inside this (possibly multi-step) update.
}

// Glancing contact: heavy speed loss, lost combo, red flash + scrape — but you
// keep driving. Only near head-on contact (HARD_TOLERANCE) ends the run.
export function sideswipe(pan) {
  state.speed *= 0.5;
  state.combo = 0; state.mult = 1; state.comboTimer = 0;
  state.hitFlash = 1;
  state.shake = Math.max(state.shake, 1);
  state.kick += pan * 1.2;
  audioScrape(pan);
}

// A held shield eats an otherwise-fatal hit: you survive, but pay for it
// (speed dump + combo reset) and phase through traffic for ~1.5s while the
// shield "reforms". Sold with bullet-time, a cyan burst, shake and a chime.
export function shieldSave(pan) {
  state.shield = false;
  state.runShields++;
  state.invuln = SHIELD_INVULN;
  state.speed *= 0.55;
  state.combo = 0; state.mult = 1; state.comboTimer = 0;
  state.shake = Math.max(state.shake, 1.3);
  state.kick += pan * 1.4;
  state.slowmoT = SLOWMO_MS; state.slowmoCD = SLOWMO_CD; // dramatic beat (cyan time-bend)
  const c = worldToScreen(worldX(state.playerX), 1.4, 0);
  addPopup(c.x, c.y - 20, "SHIELD!", "#38e1ff", true);
  addRing(c.x, c.y, 1, "56,225,255");
  audioShield();
}
