// ============================================================
//  config.js — constants, data tables, and pure helpers
//  No mutable state, no DOM, no Three.js. Everything here is safe to
//  import anywhere; it never changes at runtime.
// ============================================================

// ---- World layout (real 3D, Three.js) ----
// 4 lanes across the carriageway (±1 = road edges); split into your direction
// and oncoming further down (see FWD_LANES / ONC_LANES).
export const START_LANE = 0.25; // you begin in an inner lane, clear of oncoming traffic
export const SPAWN_DZ = 6000;   // how far ahead (game-z units) traffic appears (deep enough to fade in behind the fog)
export const ROAD_HALF_W = 9;   // world half-width of the asphalt (lx = ±1)
export const ROAD_LEN = 660;    // world length of the road / ground meshes
export const Z_SCALE = 0.055;   // world units per game-z unit (depth compression)
export const ROAD_REPEAT = 50;  // lane-dash cycles down the road (lower = more spaced-out dashes)
export const PLAYER_DZ = 138;   // game-z plane where you sit; passes/crashes register here

// game coords -> Three world coords
export const worldX = (lx) => lx * ROAD_HALF_W;
export const worldZ = (dz) => -(dz - PLAYER_DZ) * Z_SCALE; // your plane at z=0, ahead is -Z

export const TRAFFIC_COLORS = ["#ef476f", "#06d6a0", "#118ab2", "#ffd166", "#9b5de5", "#f78c6b"];

// ---- Roadside scenery ----
export const SIGN_COLORS = ["#2e7d32", "#1565c0", "#f9a825"]; // highway / info / warning
export const SCENERY_STEP = 280; // average spacing between roadside objects (world units)

// ---- Driving feel ----
export const ACCEL = 1.3;
export const ENGINE_BRAKE = 0.5;
export const BRAKE_BASE = 0.9; // brake decel per unit of a car's brake spec — better cars stop harder (see effStats)
export const DRAG = 0.0015; // light; the accel taper is what sets top speed now
export const STEER_ACCEL = 0.0048;
export const STEER_FRICTION = 0.84;
export const STEER_MAX_V = 0.036;
export const PLAYER_X_LIMIT = 0.86; // how far onto the shoulder you can go

// ---- Scoring / collision (lateral units) ----
export const LANE_TOLERANCE = 0.3; // overlap closer than this = contact
export const HARD_TOLERANCE = 0.17; // near head-on contact = crash (ends the run)
export const NEAR_MISS_RANGE = 0.58; // within this (but safe) = bonus
export const TRAFFIC_MAX_SPEED = 30; // absolute traffic speed (so better cars overtake more)
export const TRAFFIC_MIN_FACTOR = 0.5; // slowest traffic is half top speed (nobody parks on the highway)
export const TRAFFIC_GAP = 700; // min world gap between cars in a lane (they queue, not overlap)

// ---- Traffic density ----
// How busy the road is, picked in Settings. `gap` scales the distance between
// spawn waves (higher = sparser); `onc` scales the oncoming / extra-car odds;
// `sight` scales how far you see + how far ahead cars appear.
export const TRAFFIC_DENSITY = {
  low:    { label: "Low",    gap: 1.9,  onc: 0.55, sight: 1.4 },
  medium: { label: "Medium", gap: 1.0,  onc: 1.0,  sight: 1.0 },
  high:   { label: "High",   gap: 0.58, onc: 1.4,  sight: 1.0 },
};

// ---- View distance ----
// Player-chosen multiplier on how far you see (fog far + camera far plane) and
// how far ahead traffic spawns. Independent of density's own `sight` scaling.
export const VIEW_DISTANCE = {
  near:   { label: "Near",   mult: 0.85 },
  normal: { label: "Normal", mult: 1.0 },
  far:    { label: "Far",    mult: 1.45 },
};

// ---- Traffic modes ----
export const ONEWAY_LANES = [-0.8, -0.4, 0, 0.4, 0.8]; // sorted left -> right, center filled
export const FWD_LANES = [0.25, 0.75];    // two-way: your direction (right side)
export const ONC_LANES = [-0.25, -0.75];  // two-way: oncoming (left side)
export const ONCOMING_BONUS = 1.8;      // near-miss score multiplier vs oncoming traffic
export const LANE_CHANGE_RATE = 0.007;  // how fast a weaving car slides between its lanes
export const SIGNAL_FRAMES = 95;        // blinker flashes this long before the merge starts
// Per-kind traffic: heavies are slower and a touch wider.
export const VEHICLES = {
  car:   { speedF: 1.00, halfW: 0.00 },
  truck: { speedF: 0.60, halfW: 0.05 },
  bus:   { speedF: 0.70, halfW: 0.04 },
};

// ---- Cars you can unlock (the first one is intentionally weak) ----
export const CARS = [
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
export const getCar = (id) => CARS.find((c) => c.id === id) || CARS[0];

// ---- Per-car upgrades (bought in the garage, saved to localStorage) ----
export const UPG_MAX = 4; // levels per track
export const UPG_TRACKS = [
  { key: "engine",   label: "Engine",    per: 0.12 }, // boosts accel
  { key: "speed",    label: "Top Speed", per: 0.08 }, // boosts max speed
  { key: "handling", label: "Handling",  per: 0.08 }, // boosts handling
];
export const upgradeCost = (c, level) => Math.round((c.price * 0.14 + 450) * (level + 1));

// Bar scale: a fully-upgraded top car reads as a full bar.
export const STAT_CEIL = {
  accel: Math.max(...CARS.map((c) => c.accel)) * (1 + 0.12 * UPG_MAX),
  maxSpeed: Math.max(...CARS.map((c) => c.maxSpeed)) * (1 + 0.08 * UPG_MAX),
  handling: Math.max(...CARS.map((c) => c.handling)) * (1 + 0.08 * UPG_MAX),
};
STAT_CEIL.braking = BRAKE_BASE * Math.max(...CARS.map((c) => c.brake)) * (1 + 0.08 * UPG_MAX);
// Rarity accent per tier (clean -> rich as cars improve).
export const RARITY_COLOR = ["#9aa0a6", "#3aa0ff", "#ef476f", "#ffd166", "#06d6a0", "#e8d8a0"];

// ---- Paint shop ----
// A shared palette you unlock once and can apply to any owned car. "stock" is
// always owned and uses each car's own factory colour. Finishes change the
// material (matte/pearl/chrome), so paint is more than a hue swap. Buying a
// paint unlocks it globally; the chosen paint is remembered per car.
// NOTE: the scene has no environment map, so a pure metal (metalness 1) renders
// black (nothing to reflect). Metalness is capped so the base colour always
// reads, and clearcoat carries the "shine" — looks right in this stylised light.
export const PAINT_FINISH = {
  gloss:    { metalness: 0.50, roughness: 0.30, clearcoat: 1.0, clearcoatRoughness: 0.14 },
  matte:    { metalness: 0.0,  roughness: 0.85, clearcoat: 0.0, clearcoatRoughness: 1.0 },
  pearl:    { metalness: 0.30, roughness: 0.24, clearcoat: 1.0, clearcoatRoughness: 0.06 },
  metallic: { metalness: 0.60, roughness: 0.34, clearcoat: 0.6, clearcoatRoughness: 0.2 },
  chrome:   { metalness: 0.25, roughness: 0.08, clearcoat: 1.0, clearcoatRoughness: 0.03 },
};
export const PAINTS = [
  { id: "stock",    name: "Stock",         price: 0,    finish: "gloss" }, // uses the car's own colour
  { id: "red",      name: "Racing Red",    hex: "#e63946", price: 700,  finish: "gloss" },
  { id: "blue",     name: "Electric Blue", hex: "#2a9df4", price: 700,  finish: "gloss" },
  { id: "green",    name: "Track Green",   hex: "#2fbf71", price: 700,  finish: "gloss" },
  { id: "orange",   name: "Sunset Orange", hex: "#ff7b29", price: 900,  finish: "gloss" },
  { id: "violet",   name: "Ultraviolet",   hex: "#8a5cff", price: 900,  finish: "gloss" },
  { id: "stealth",  name: "Stealth",       hex: "#1a1c22", price: 2500, finish: "matte" },
  { id: "gunmetal", name: "Gunmetal",      hex: "#5a6470", price: 2500, finish: "matte" },
  { id: "pearl",    name: "Pearl White",   hex: "#eef2f7", price: 3500, finish: "pearl" },
  { id: "gold",     name: "Gold Leaf",     hex: "#d9a441", price: 6000, finish: "metallic" },
  { id: "chrome",   name: "Liquid Chrome", hex: "#eaf0f6", price: 8000, finish: "chrome" },
];
export const getPaint = (id) => PAINTS.find((p) => p.id === id) || PAINTS[0];

export const defaultUpgrades = () => {
  const u = {};
  for (const c of CARS) u[c.id] = { engine: 0, speed: 0, handling: 0 };
  return u;
};

export const QUALITY_DPR = { high: 1.5, low: 1.0 }; // pixel-ratio cap per quality (fill-rate lever)
export const CHAL_VERSION = 2; // bump when the ladder changes to reset old (now-invalid) completions

// Internal speed -> display number. 1 internal unit = 3 km/h; mph = km/h × 0.621371.
export const SPEED_UNITS = { kmh: { factor: 3, label: "km/h" }, mph: { factor: 1.864113, label: "mph" } };

// Lifetime career totals default (see store).
export function defaultCareer() {
  return { runs: 0, dist: 0, passed: 0, scoreTotal: 0, slowmos: 0, shields: 0,
           bestScore: 0, bestPassed: 0, bestDist: 0, bestCombo: 0, bestSpeed: 0, bestSlowmos: 0 };
}

export const COMBO_WINDOW = 150;   // frames (~2.5s) to land the next near-miss
export const comboMult = (combo) => Math.min(8, 1 + Math.floor(combo / 2)); // x1..x8

// ---- Heat: intra-run difficulty escalation ----
export const HEAT_KM = 2;          // km of survival per heat stage
export const HEAT_CLOSE = 0.06;    // +6% traffic closing speed per stage (the run-ender)
export const HEAT_GAP = 0.05;      // spawn-gap tightening per stage (denser waves), floored
export const HEAT_ONC = 0.05;      // oncoming-share ramp per stage
export const HEAT_FOG = 0.03;      // sightline pull-in per stage, floored at 0.5
export const HEAT_SCORE = 0.12;    // +0.12x score per stage (reward for pushing deeper)

// ---- Exceptional-pass slow-mo ----
export const SLOWMO_MS = 320;      // how long the dip lasts
export const SLOWMO_CD = 1500;     // minimum gap between slow-mos
export const SLOWMO_SCALE = 0.38;  // time scale at the peak of the dip (0 = frozen)
export const SLOWMO_CLOSE = 0.9;   // closeness above this counts as "exceptional"

// ---- Shield ----
export const SHIELD_GAIN_BASE = 0.03;   // charge per near-miss, regardless of closeness
export const SHIELD_GAIN_CLOSE = 0.07;  // extra charge scaled by how close it was
export const SHIELD_INVULN = 90;        // frames (~1.5s) of phasing after a save

export const DIST_DIV = 16000;     // game-units per displayed "km"
export const CREDIT_RATE = 0.125;  // credits earned = score x this

// ---- Police Pursuit (optional mode) ----
// A bust meter (0..1) is the "behind you" pressure. It fills over time (faster
// the deeper you are), faster still when you crawl; high speed + clean near-miss
// evasion drain it. Clip traffic and it spikes; clip a cop and it spikes hard.
// Fill it and you're BUSTED. Cop cars are the visible hazard you must thread.
export const BUST_RISE = 0.0013;       // base fill / frame — climbs even flat-out, so you
                                       // must actively thread traffic (near-misses) to survive
export const BUST_HEAT = 0.09;         // extra fill per heat unit (cops escalate with you)
export const BUST_SLOW = 0.0019;       // extra fill / frame when crawling (< 40% top speed)
export const BUST_FAST_DRAIN = 0.0006; // partial drain at high speed (> 80% top speed)
export const BUST_NEARMISS = 0.045;    // drain per near-miss (evasion cools the chase)
export const BUST_SIDESWIPE = 0.22;    // spike when you clip traffic
export const BUST_COPHIT = 0.45;       // spike when you clip a cop
export const BUST_GRACE = 150;         // frames at run start with no base fill (~2.5s)
export const COP_BODY = "#13161d";     // cop car body (dark; gets a roof light bar)
export const COP_BASE_ODDS = 0.12;     // base chance a forward spawn is a cop
export const COP_BUST_ODDS = 0.5;      // extra cop chance scaled by the bust meter

// ---- Environments ----
export const DAYNIGHT_CYCLE_KM = 12;   // distance for one full day->night->day lap
export const ENVIRONMENTS = [
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
export const getEnv = (id) => ENVIRONMENTS.find((e) => e.id === id) || ENVIRONMENTS[0];

// Each region's roadside palette: prop types with relative weights.
export const SCAPES = {
  plains: [["tree", 78], ["sign", 22]],
  desert: [["cactus", 60], ["rock", 28], ["sign", 12]],
  city:   [["building", 56], ["streetlight", 30], ["sign", 14]],
  neon:   [["neonbuild", 54], ["streetlight", 26], ["neonsign", 20]],
};

// ---- End-of-run rank ----
export const RANKS = [
  { min: 12000, label: "S" }, { min: 7000, label: "A" },
  { min: 3500, label: "B" }, { min: 1500, label: "C" }, { min: 0, label: "D" },
];
export const rankFor = (score) => RANKS.find((r) => score >= r.min);

// ---- Pure helpers ----
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const smoothstep = (t) => t * t * (3 - 2 * t);
export const fmt = (n) => Math.round(n).toLocaleString();

// Inline SVG icon by symbol id (see index.html defs); inherits text color.
export const ico = (id, cls = "ico") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><use href="#${id}"/></svg>`;
export const CRED_ICO = '<svg class="cred-ico" viewBox="0 0 24 24" aria-hidden="true"><use href="#cred-coin"/></svg>';
export const credCost = (n) => `<span class="cred">${CRED_ICO}<span class="cred-num">${fmt(n)}</span></span>`;
