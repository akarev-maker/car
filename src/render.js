// Traffic Racer 3D — 3D rendering layer (Three.js / WebGL).
// Scene + camera + renderer setup, all mesh/geometry builders, the day/night
// biome engine, the per-frame WebGL render(), and the 2D FX-canvas overlay.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  CARS, DAYNIGHT_CYCLE_KM, DIST_DIV, HEAT_FOG, PAINT_FINISH, RARITY_COLOR, ROAD_HALF_W, ROAD_LEN,
  ROAD_REPEAT, SLOWMO_MS, Z_SCALE, clamp, getCar, getEnv, smoothstep, worldX, worldZ
} from "./config.js";
import {
  densityCfg, input, paintSpecOf, quality, qualityCap, selectedCar, selectedEnv, spd, state, trafficMode
} from "./store.js";
import {
  popups, rings, scenery, traffic
} from "./world3d.js";
import {
  garageIndex, garageOpen, setPreviewCar
} from "./main.js";

// ============================================================
//  3D rendering (Three.js / WebGL)
// ============================================================
const canvas = document.getElementById("game"); // the WebGL <canvas> (see index.html)
export let scene, camera, renderer, fx, fxCtx, roadTex;
let roadTexOne, roadTexTwo, roadMat; // one-way / two-way road textures + shared material
let _blinkOn = true; // shared on/off phase so all active turn signals flash in sync

// Point the road at the texture for the current traffic mode.
export function applyRoadMode() {
  if (!roadMat) return;
  roadTex = trafficMode === "twoway" ? roadTexTwo : roadTexOne;
  roadMat.map = roadTex;
  roadMat.needsUpdate = true;
}
export let trafficGroup, sceneryGroup, playerMesh = null, playerCarId = null;
let hemiLight, sunLight, grassMat;   // updated each frame by the biome engine
let playerLight;                     // single spotlight: the player's own headlights at night
export let ready3d = false;
const CAM_FOV = 55; // base camera FOV (widens with speed)

// ---- Real car models (GLB). Drop files in models/<id>.glb — see models/README.md.
// The game falls back to the detailed procedural car below, so to avoid 404s for
// files that aren't there we only fetch ids listed in MODELS_AVAILABLE. Add an id
// here once you've dropped its models/<id>.glb in.
const MODELS_AVAILABLE = new Set([]);
const gltfLoader = new GLTFLoader();
export const modelCache = {}; // id -> { mesh } | "loading" | "failed"
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
export let _matGlass, _matTire, _matHead, _matTail, _matPlayerTail, _matShadow, _matTrunk, _matLeaf, _matPost, _matSilhouette, _matTrailer;
let _matBodyDark, _matChrome; // rocker/bumper cladding + chrome trim (grille, hubs)
// Region scenery: cactus/rock (desert), building + glowing windows (city),
// street lamp head (city/neon), dark neon-district body, and a small palette of
// MeshBasic neon colours (unlit + fogged, so they read as pure glow in the dark).
let _matCactus, _matRock, _matWindow, _matLamp, _matNeonBody;
let _neonMats = [];
const _matBlinker = new THREE.MeshBasicMaterial({ color: 0xffae2b }); // bright amber, blinks via visibility

// ---- Per-car silhouettes -------------------------------------------------
// A car's body is composed from the shared base slabs at positions/scales given
// by a "profile" (proportions: length, ride height, greenhouse shape, where the
// cabin sits, hood vs deck split, stance width). Traffic shares DEFAULT_PROFILE,
// baked once and cheap. The player + showroom car build their own per id, so the
// roster reads as distinct shapes — a tall upright hatch, a long-hood fastback
// muscle car, a cab-forward mid-engine hypercar — instead of one body in six
// paints. Only ever one player + one showroom car exist, so the extra baked
// geometry is essentially free (the same reasoning the tier aero already uses).
const _gm4 = new THREE.Matrix4(), _gq = new THREE.Quaternion(), _ge = new THREE.Euler();
const _gv = new THREE.Vector3(), _gsc = new THREE.Vector3();
function _at(geo, pos = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1]) {
  const c = geo.clone();
  _ge.set(rot[0], rot[1], rot[2]); _gq.setFromEuler(_ge);
  _gm4.compose(_gv.set(pos[0], pos[1], pos[2]), _gq, _gsc.set(scale[0], scale[1], scale[2]));
  return c.applyMatrix4(_gm4);
}
const _RZ = [0, 0, Math.PI / 2]; // wheels lie on their side

// Defaults reproduce the original shared body exactly, so traffic is unchanged.
const DEFAULT_PROFILE = {
  width: 1, lenZ: 1, bodyY: 0.62,
  hoodZ: -1.42, hoodLen: 1, deckZ: 1.62, deckLen: 1,
  cabinZ: 0.12, cabinLen: 1, roofY: 1.32, roofZ: 0.18, roofLen: 1,
  bumperF: -2.12, bumperR: 2.12, wheelZ: 1.4,
};
// Only the silhouette-defining knobs are overridden per car (rest inherit).
const CAR_PROFILES = {
  // Short, tall, upright — stubby hatchback with a big greenhouse, tiny tail.
  hatch:  { width: 0.95, lenZ: 0.86, hoodZ: -1.18, hoodLen: 0.78, deckZ: 1.34, deckLen: 0.55,
            cabinZ: 0.30, cabinLen: 1.05, roofY: 1.40, roofZ: 0.34,
            bumperF: -1.86, bumperR: 1.90, wheelZ: 1.24 },
  // Balanced three-box sedan with a proper trunk — the all-rounder baseline.
  sedan:  { lenZ: 1.0, deckZ: 1.66, deckLen: 1.05, roofY: 1.33, cabinZ: 0.20,
            bumperF: -2.14, bumperR: 2.16, wheelZ: 1.42 },
  // Long hood, cabin pushed back into a fastback, wide stance, low roof.
  muscle: { width: 1.06, lenZ: 1.08, bodyY: 0.57, hoodZ: -1.64, hoodLen: 1.28, deckZ: 1.54, deckLen: 0.78,
            cabinZ: 0.46, cabinLen: 0.96, roofY: 1.26, roofZ: 0.50, roofLen: 0.92,
            bumperF: -2.36, bumperR: 2.18, wheelZ: 1.50 },
  // Sleek, long, low grand tourer with a sweeping full-length greenhouse.
  gt:     { width: 1.02, lenZ: 1.06, bodyY: 0.56, hoodZ: -1.54, hoodLen: 1.08, deckZ: 1.66, deckLen: 0.95,
            cabinZ: 0.16, cabinLen: 1.12, roofY: 1.22, roofZ: 0.20, roofLen: 1.16,
            bumperF: -2.22, bumperR: 2.22, wheelZ: 1.46 },
  // Mid-engine wedge: cab-forward, short nose, long rear engine deck, low + wide.
  super:  { width: 1.10, lenZ: 1.0, bodyY: 0.50, hoodZ: -1.30, hoodLen: 0.74, deckZ: 1.48, deckLen: 1.16,
            cabinZ: -0.30, cabinLen: 0.84, roofY: 1.12, roofZ: -0.26, roofLen: 0.94,
            bumperF: -2.12, bumperR: 2.24, wheelZ: 1.50 },
  // Apex hypercar — the wedge taken to the extreme: longest, lowest, most raked.
  velox:  { width: 1.12, lenZ: 1.04, bodyY: 0.46, hoodZ: -1.34, hoodLen: 0.72, deckZ: 1.54, deckLen: 1.24,
            cabinZ: -0.42, cabinLen: 0.80, roofY: 1.06, roofZ: -0.36, roofLen: 0.92,
            bumperF: -2.30, bumperR: 2.32, wheelZ: 1.54 },
};
const carProfile = (id) => Object.assign({}, DEFAULT_PROFILE, CAR_PROFILES[id]);

// Bake one car's merged geometry set from a profile. Geometry tracks the profile
// so every derived part (glass on the cabin, lamps on the bumpers, wheels on the
// wheelbase) stays attached as proportions change. Returns one geometry per
// material, exactly like the original shared set, so draw-call count is identical.
function buildCarGeoSet(p) {
  const W = p.width, merge = (parts) => mergeGeometries(parts, false);
  const paint = merge([
    _at(_geo.body,  [0, p.bodyY, 0],              [0, 0, 0], [W, 1, p.lenZ]),
    _at(_geo.hood,  [0, p.bodyY + 0.18, p.hoodZ], [0, 0, 0], [W, 1, p.hoodLen]),
    _at(_geo.deck,  [0, p.bodyY + 0.20, p.deckZ], [0, 0, 0], [W, 1, p.deckLen]),
    _at(_geo.cabin, [0, p.bodyY + 0.42, p.cabinZ],[0, 0, 0], [W, 1, p.cabinLen]),
    _at(_geo.roof,  [0, p.roofY, p.roofZ],        [0, 0, 0], [W, 1, p.roofLen]),
  ]);
  const dark = merge([
    _at(_geo.skirt,   [0, 0.34, 0],            [0, 0, 0], [W, 1, p.lenZ]),
    _at(_geo.bumper,  [0, 0.48, p.bumperF],    [0, 0, 0], [W, 1, 1]),
    _at(_geo.bumper,  [0, 0.48, p.bumperR],    [0, 0, 0], [W, 1, 1]),
    _at(_geo.spoiler, [0, 0.98, p.deckZ + 0.54]),
    // Wing mirrors (stalk + housing) at the front of the doors, both sides.
    _at(_geo.mstalk, [ 1.06 * W, p.bodyY + 0.50, p.cabinZ - 0.78 * p.cabinLen]),
    _at(_geo.mstalk, [-1.06 * W, p.bodyY + 0.50, p.cabinZ - 0.78 * p.cabinLen]),
    _at(_geo.mirror, [ 1.18 * W, p.bodyY + 0.52, p.cabinZ - 0.82 * p.cabinLen]),
    _at(_geo.mirror, [-1.18 * W, p.bodyY + 0.52, p.cabinZ - 0.82 * p.cabinLen]),
    // Hood vent + B-pillars (break up the greenhouse so the glass reads as windows).
    _at(_geo.hvent,  [0, p.bodyY + 0.33, p.hoodZ]),
    _at(_geo.pillar, [ 0.83 * W, p.roofY - 0.16, p.cabinZ + 0.08]),
    _at(_geo.pillar, [-0.83 * W, p.roofY - 0.16, p.cabinZ + 0.08]),
    // Rear diffuser: a row of fins under the back bumper.
    ...[-0.46, -0.155, 0.155, 0.46].map((fx) => _at(_geo.diffin, [fx * W, 0.33, p.bumperR + 0.05])),
  ]);
  const glass = merge([
    _at(_geo.glassF, [0, p.roofY - 0.16, p.cabinZ - 0.98 * p.cabinLen], [0.62, 0, 0],  [W, 1, 1]),
    _at(_geo.glassR, [0, p.roofY - 0.14, p.cabinZ + 1.0 * p.cabinLen],  [-0.66, 0, 0], [W, 1, 1]),
    _at(_geo.glassS, [ 0.81 * W, p.roofY - 0.20, p.cabinZ + 0.06], [0, 0, 0], [1, 1, p.cabinLen]),
    _at(_geo.glassS, [-0.81 * W, p.roofY - 0.20, p.cabinZ + 0.06], [0, 0, 0], [1, 1, p.cabinLen]),
  ]);
  const wheelPts = [[0.94 * W, p.wheelZ], [-0.94 * W, p.wheelZ], [0.94 * W, -p.wheelZ], [-0.94 * W, -p.wheelZ]];
  const wheels = [], hubs = [];
  for (const [x, z] of wheelPts) {
    wheels.push(_at(_geo.wheel, [x, 0.42, z], _RZ));
    hubs.push(_at(_geo.hub, [x, 0.42, z], _RZ));
  }
  return {
    profile: p,
    paint, dark, glass,
    wheels: merge(wheels),
    chrome: merge([...hubs, _at(_geo.grille, [0, 0.66, p.bumperF - 0.12]),
      _at(_geo.exhaust, [ 0.6 * W, 0.4, p.bumperR + 0.2], [Math.PI / 2, 0, 0]),   // twin tailpipes
      _at(_geo.exhaust, [-0.6 * W, 0.4, p.bumperR + 0.2], [Math.PI / 2, 0, 0])]),
    head:   merge([_at(_geo.light, [0.64 * W, 0.68, p.bumperF - 0.10]), _at(_geo.light, [-0.64 * W, 0.68, p.bumperF - 0.10])]),
    tail:   merge([_at(_geo.light, [0.64 * W, 0.74, p.bumperR + 0.10]), _at(_geo.light, [-0.64 * W, 0.74, p.bumperR + 0.10])]),
    blinkR: merge([_at(_geo.blinker, [0.95 * W, 0.74, p.bumperF + 0.12]), _at(_geo.blinker, [0.95 * W, 0.74, p.bumperR - 0.12])]),
    blinkL: merge([_at(_geo.blinker, [-0.95 * W, 0.74, p.bumperF + 0.12]), _at(_geo.blinker, [-0.95 * W, 0.74, p.bumperR - 0.12])]),
  };
}
let _defaultCarGeo = null;          // traffic body (DEFAULT_PROFILE), baked in initSharedAssets
const _carGeoCache = {};            // id -> baked geo set for the player/showroom car
const carGeoSet = (id) => _carGeoCache[id] || (_carGeoCache[id] = buildCarGeoSet(carProfile(id)));

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
  _geo.mirror  = new THREE.BoxGeometry(0.2, 0.13, 0.16);   // wing mirror housing
  _geo.mstalk  = new THREE.BoxGeometry(0.12, 0.05, 0.07);  // mirror stalk to the door
  // Body detail (merged per car; cheap, applies to player + traffic alike).
  _geo.exhaust = new THREE.CylinderGeometry(0.085, 0.095, 0.22, 10); // tailpipe tip
  _geo.diffin  = new THREE.BoxGeometry(0.055, 0.26, 0.3);  // one rear-diffuser fin
  _geo.hvent   = new THREE.BoxGeometry(0.46, 0.07, 0.52);  // hood vent panel
  _geo.pillar  = new THREE.BoxGeometry(0.06, 0.42, 0.1);   // B-pillar between the side windows
  // Tier-scaling aero for player cars (added per-instance in buildPlayerCar; only
  // ever one player + one showroom car, so the extra parts are essentially free).
  _geo.rocker   = new THREE.BoxGeometry(0.07, 0.11, 2.7);  // side accent blade
  _geo.splitter = new THREE.BoxGeometry(2.08, 0.06, 0.42); // front lip / splitter
  _geo.wingUp   = new THREE.BoxGeometry(0.1, 0.52, 0.3);   // rear-wing upright
  _geo.wingPln  = new THREE.BoxGeometry(1.72, 0.08, 0.52); // rear-wing plane
  _geo.rimRing  = new THREE.CylinderGeometry(0.3, 0.3, 0.38, 16); // accent rim disc
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

  _matGlass  = new THREE.MeshStandardMaterial({ color: 0x0a0d14, metalness: 0.45, roughness: 0.07 });
  _matTire   = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.85 });
  _matHead   = new THREE.MeshStandardMaterial({ color: 0xfff4cc, emissive: 0xffe9a0, emissiveIntensity: 0.9, roughness: 0.4 });
  _matTail   = new THREE.MeshStandardMaterial({ color: 0x5a0000, emissive: 0xff2b2b, emissiveIntensity: 0.9, roughness: 0.4 });
  // The player's own tail lights get a dedicated material so braking can flare
  // them (a feedback channel from the chase cam) without touching traffic.
  _matPlayerTail = new THREE.MeshStandardMaterial({ color: 0x5a0000, emissive: 0xff2b2b, emissiveIntensity: 0.9, roughness: 0.4 });
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
    map: winTex, emissiveMap: winTex, emissive: 0xe8f1ff, emissiveIntensity: 0.1,
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

  // Traffic cars all share one body, baked from the default profile. The player
  // and showroom car bake their own per-id silhouette on demand (see carGeoSet).
  _defaultCarGeo = buildCarGeoSet(DEFAULT_PROFILE);

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
    _paintMats.set(color, new THREE.MeshStandardMaterial({ color, metalness: 0.62, roughness: 0.3 }));
  return _paintMats.get(color);
}
// Glossy show-car finish reserved for the player's car (clearcoat is a touch
// heavier, but only one player + one showroom car ever use it).
const _playerPaintMats = new Map();
function playerPaintMat(color, finish = "gloss") {
  const key = color + "|" + finish;
  if (!_playerPaintMats.has(key)) {
    const f = PAINT_FINISH[finish] || PAINT_FINISH.gloss;
    _playerPaintMats.set(key, new THREE.MeshPhysicalMaterial({ color, ...f }));
  }
  return _playerPaintMats.get(key);
}
// Tier accent (rocker blades, wing, brake rims) — drawn in the car's rarity color.
const _accentMats = new Map();
function accentMat(color) {
  if (!_accentMats.has(color))
    _accentMats.set(color, new THREE.MeshStandardMaterial({ color, metalness: 0.5, roughness: 0.4 }));
  return _accentMats.get(color);
}

// The player's car: the shared procedural body, upgraded to a glossy finish and
// dressed with tier-scaling aero so each purchase visibly gets meaner. Bots keep
// the plain merged body for performance — only the player/showroom car gets this.
export function buildPlayerCar(car) {
  const set = carGeoSet(car.id);     // this car's own silhouette
  const p = set.profile;
  const W = p.width;
  const g = buildProceduralCar(car.color, set);
  const tier = car.tier || 0;
  const acc = accentMat(RARITY_COLOR[tier] || car.color);
  const paint = paintSpecOf(car); // selected paint colour + finish (defaults to the car's stock)
  g.getObjectByName("paint").material = playerPaintMat(paint.color, paint.finish);
  g.getObjectByName("tail").material = _matPlayerTail; // brake lights flare on braking (see render)

  // Aero is placed relative to the silhouette (nose, deck, wheelbase, stance) so
  // it stays glued to each body shape instead of floating off a short/long car.
  // Tier 1+: accent blades along the rockers.
  if (tier >= 1) for (const sx of [1, -1]) {
    const blade = new THREE.Mesh(_geo.rocker, acc);
    blade.position.set(sx * 1.02 * W, 0.52, 0.1); g.add(blade);
  }
  // Tier 2+: a front splitter slung low under the nose.
  if (tier >= 2) {
    const sp = new THREE.Mesh(_geo.splitter, _matBodyDark);
    sp.position.set(0, 0.33, p.bumperF - 0.2); g.add(sp);
  }
  // Tier 3+: a raised rear wing (uprights + accent plane).
  if (tier >= 3) {
    for (const sx of [0.62, -0.62]) {
      const up = new THREE.Mesh(_geo.wingUp, _matBodyDark);
      up.position.set(sx, 1.06, p.deckZ + 0.56); g.add(up);
    }
    const wing = new THREE.Mesh(_geo.wingPln, acc);
    wing.position.set(0, 1.34, p.deckZ + 0.62); wing.rotation.x = -0.12; g.add(wing);
  }
  // Tier 4+: accent brake-disc rims behind the wheels.
  if (tier >= 4) for (const [x, z] of [[0.94 * W, p.wheelZ], [-0.94 * W, p.wheelZ], [0.94 * W, -p.wheelZ], [-0.94 * W, -p.wheelZ]]) {
    const ring = new THREE.Mesh(_geo.rimRing, acc);
    ring.position.set(x, 0.42, z); ring.rotation.z = Math.PI / 2; g.add(ring);
  }
  return g;
}
function signMat(color) {
  if (!_signMats.has(color)) _signMats.set(color, new THREE.MeshStandardMaterial({ color, roughness: 0.8 }));
  return _signMats.get(color);
}

// A sculpted 3D car: layered body slabs, a tapered greenhouse with raked glass,
// chrome trim, hub-capped wheels and a subtle lip — front faces -Z. `set` is the
// baked geometry set for this car's silhouette (traffic uses the default body).
function buildProceduralCar(color, set = _defaultCarGeo, shadow = true) {
  const g = new THREE.Group();
  // One mesh per material (panels pre-merged per silhouette), so the whole car
  // is ~9 draw calls whatever its shape. Front faces -Z.
  const paint = new THREE.Mesh(set.paint, paintMat(color));
  paint.name = "paint"; // buildPlayerCar swaps this for a glossy clearcoat finish
  g.add(paint);
  g.add(new THREE.Mesh(set.dark, _matBodyDark));
  g.add(new THREE.Mesh(set.glass, _matGlass));
  g.add(new THREE.Mesh(set.wheels, _matTire));
  g.add(new THREE.Mesh(set.chrome, _matChrome));
  g.add(new THREE.Mesh(set.head, _matHead));
  const tail = new THREE.Mesh(set.tail, _matTail);
  tail.name = "tail"; // buildPlayerCar swaps this for the brake-reactive material
  g.add(tail);

  if (shadow) { // player keeps a contact shadow; traffic skips it (the disc reads as an ugly halo)
    const sh = new THREE.Mesh(_geo.shadow, _matShadow);
    sh.rotation.x = -Math.PI / 2; sh.position.y = 0.02;
    sh.scale.set(set.profile.width, set.profile.lenZ, 1); // shadow tracks the footprint
    g.add(sh);
  }

  // Turn indicators (both corners per side merged into one mesh), hidden until a
  // merge. placeTraffic flips them on by world side, blinking; the player leaves
  // them dark. Kept in arrays so the existing toggle code is unchanged.
  const blinkR = new THREE.Mesh(set.blinkR, _matBlinker); blinkR.visible = false; g.add(blinkR);
  const blinkL = new THREE.Mesh(set.blinkL, _matBlinker); blinkL.visible = false; g.add(blinkL);
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
  return g;
}
function buildBus(color) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(_geo.busBody, paintMat(color)); body.position.set(0, 1.5, 0); g.add(body);
  const stripe = new THREE.Mesh(_geo.busStripe, _matGlass); stripe.position.set(0, 1.95, 0.2); g.add(stripe);
  g.add(new THREE.Mesh(_geo.busWheels, _matTire));
  g.add(new THREE.Mesh(_geo.busHead, _matHead));
  g.add(new THREE.Mesh(_geo.busTail, _matTail));
  return g;
}
function buildVehicle(o) {
  if (o.kind === "truck") return buildTruck(o.color);
  if (o.kind === "bus") return buildBus(o.color);
  return buildProceduralCar(o.color, _defaultCarGeo, false); // traffic: no contact-shadow disc
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
  const lit  = ["#dfeeff", "#bcd4ff", "#eef6ff", "#9fc6ff"];    // lights-on (cool white/blue glass)
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

export function initThree() {
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

  // The player's headlights: ONE spotlight (no shadow map) aimed down the road
  // from just above/behind the car. Intensity is 0 by day and ramps up at night,
  // so by day it costs only its (small) shader slot and emits nothing. Added once
  // here — never added/removed — so it never triggers a shader recompile hitch.
  playerLight = new THREE.SpotLight(0xfff2d0, 0, 80, Math.PI / 7, 0.55, 1.0);
  playerLight.position.set(0, 4.5, 4);
  playerLight.target.position.set(0, 0, -34);
  scene.add(playerLight);
  scene.add(playerLight.target);

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

export function onResize() {
  const w = canvas.clientWidth || 960, h = canvas.clientHeight || 540;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  fx.width = w; fx.height = h;
}

// Use a real GLB model when present; otherwise keep the procedural car.
export function loadCarModel(car) {
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

export function setPlayerCar(car) {
  if (playerMesh) { scene.remove(playerMesh); playerMesh = null; }
  playerCarId = car.id;
  const cached = modelCache[car.id];
  if (cached && cached !== "loading" && cached !== "failed") {
    playerMesh = cached.mesh.clone(true);
  } else {
    playerMesh = buildPlayerCar(car);
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
// The membership set is reused across calls so the per-frame reconcile (run for
// both traffic and scenery, every frame) allocates nothing on the hot path.
const _reconcilePresent = new Set();
function reconcile(group, list, make, place) {
  const present = _reconcilePresent;
  present.clear();
  for (const o of list) present.add(o);
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
export function scapeAt(_km) {
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
  // Quieter road sees further; high heat pulls the horizon in (less reaction time).
  const heatSight = state.running ? Math.max(0.5, 1 - HEAT_FOG * state.heat) : 1;
  scene.fog.far  = mix(a.fogFar,  b.fogFar) * densityCfg().sight * heatSight;

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

export function render() {
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
    // Blink while phasing through traffic after a shield save.
    playerMesh.visible = state.invuln > 0 ? Math.floor(performance.now() / 70) % 2 === 0 : true;
    // Brake lights: flare the player's dedicated tail material when braking. The
    // chase cam faces the car's rear, so this reads as a clear feedback channel.
    // Eased so the glow swells/fades rather than snapping. nightFactor sets the
    // resting brightness (applyBiome ramps traffic tails the same way).
    if (_matPlayerTail) {
      const tailBase = 0.9 + nightFactor * 1.1;
      const tailTarget = input.brake > 0 ? tailBase * 3.4 : tailBase;
      _matPlayerTail.emissiveIntensity += (tailTarget - _matPlayerTail.emissiveIntensity) * 0.4;
    }
  }
  // Player headlights: track the car's lane and burn brighter the darker it gets.
  if (playerLight) {
    const px = worldX(state.playerX);
    playerLight.position.x = px;
    playerLight.target.position.x = px;
    playerLight.intensity = nightFactor * 14;   // 0 by day, full beam at deep night
  }

  // Speed sells itself: FOV widens with pace, the camera shakes a touch at
  // speed, and jolts on a near-miss / sideswipe.
  const sf = clamp(state.speed / state.maxSpeed, 0, 1);
  camera.fov += (CAM_FOV + sf * 10 - camera.fov) * 0.1;
  camera.updateProjectionMatrix();
  // A clean pass is mostly a visual flash now; only sideswipes/crashes (state.shake) really jolt the camera.
  const shake = state.flash * 0.07 + state.shake * 0.6 + sf * 0.03;
  camera.position.x = state.playerX * 1.4 + state.kick * 0.7 + (Math.random() - 0.5) * shake;
  camera.position.y = 4.3 + (Math.random() - 0.5) * shake * 0.5;
  camera.lookAt(state.playerX * 2.2, 1.2, -26);

  renderer.render(scene, camera);
  drawFx(sf);
}

// Stable set of radial speed-streak rays (angle + per-ray length/phase jitter),
// computed once. Biased toward the sides so streaks frame the road, not the sky.
const _rays = Array.from({ length: 56 }, () => {
  const a = Math.random() * Math.PI * 2;
  const side = Math.cos(a);                 // emphasise rays pointing left/right
  return { ang: a, len: 0.5 + Math.random() * 0.9, phase: Math.random(), w: 0.4 + Math.abs(side) * 0.6 };
});

// Radial motion streaks + a peripheral vignette that grow with pace, so high
// speed reads as speed even on a straight road. Center stays clear.
function drawSpeedFx(W, H, spd) {
  const cx = W / 2, cy = H * 0.42, R = Math.hypot(W, H) * 0.5;
  const inner = R * 0.34;                    // keep the focal center streak-free
  const ph = (performance.now() / 750) % 1;  // streams the rays outward over time
  fxCtx.save();
  fxCtx.strokeStyle = `rgba(226,243,255,${0.13 * spd})`;
  fxCtx.lineCap = "round";
  fxCtx.beginPath();
  for (const ray of _rays) {
    const t = (ray.phase + ph) % 1;
    const r1 = inner + t * R * 0.55;
    const r2 = r1 + (34 + 150 * spd) * ray.len;
    const c = Math.cos(ray.ang), s = Math.sin(ray.ang);
    fxCtx.lineWidth = ray.w * (1.4 + 2 * spd);
    fxCtx.moveTo(cx + c * r1, cy + s * r1);
    fxCtx.lineTo(cx + c * r2, cy + s * r2);
  }
  fxCtx.stroke();
  fxCtx.restore();
  const vig = fxCtx.createRadialGradient(cx, H / 2, H * 0.28, cx, H / 2, H * 0.8);
  vig.addColorStop(0, "rgba(0,0,0,0)");
  vig.addColorStop(1, `rgba(0,0,0,${0.3 * spd})`);
  fxCtx.fillStyle = vig;
  fxCtx.fillRect(0, 0, W, H);
}

// 2D overlay: speed streaks, hit/near-miss flashes, shockwave rings, popups.
function drawFx(sf = 0) {
  const W = fx.width, H = fx.height;
  fxCtx.clearRect(0, 0, W, H);

  const spd = clamp((sf - 0.5) / 0.5, 0, 1);   // streaks fade in past half speed
  if (spd > 0.01 && quality === "high") drawSpeedFx(W, H, spd); // skip eye-candy on Low

  if (state.slowmoT > 0) {                      // bullet-time: cyan time-bend vignette
    const k = state.slowmoT / SLOWMO_MS;
    const g = fxCtx.createRadialGradient(W / 2, H / 2, H * 0.18, W / 2, H / 2, H * 0.85);
    g.addColorStop(0, "rgba(56,225,255,0)");
    g.addColorStop(1, `rgba(56,225,255,${0.24 * k})`);
    fxCtx.fillStyle = g;
    fxCtx.fillRect(0, 0, W, H);
  }

  if (state.hitFlash > 0.02) {                 // red impact wash (sideswipe / crash)
    fxCtx.fillStyle = `rgba(255,46,46,${state.hitFlash * 0.4})`;
    fxCtx.fillRect(0, 0, W, H);
  }
  if (state.whiteout > 0.02) drawCrash(W, H, state.whiteout); // crash blowout + cracks

  if (state.flash > 0.02) {                    // near-miss edge pulse, gold -> white-hot
    const h = state.flashHue;
    const g = Math.round(209 + (255 - 209) * h), b = Math.round(102 + (255 - 102) * h);
    fxCtx.strokeStyle = `rgba(255,${g},${b},${state.flash * 0.72})`;
    fxCtx.lineWidth = 8 + state.flash * 10;
    fxCtx.strokeRect(5, 5, W - 10, H - 10);
  }

  for (const r of rings) {                     // expanding shockwave rings
    fxCtx.strokeStyle = `rgba(${r.color},${clamp(r.life, 0, 1) * 0.85})`;
    fxCtx.lineWidth = r.w;
    fxCtx.beginPath();
    fxCtx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
    fxCtx.stroke();
  }

  fxCtx.textAlign = "center";
  fxCtx.lineJoin = "round";
  for (const pop of popups) {
    const grow = clamp((1 - pop.life) / 0.16, 0, 1);            // pop-in over first 16%
    const size = Math.round((pop.big ? 23 : 18) * ((pop.big ? 1.45 : 1.2) - (pop.big ? 0.45 : 0.2) * grow));
    fxCtx.globalAlpha = clamp(pop.life, 0, 1);
    fxCtx.font = `800 ${size}px Sora, system-ui, sans-serif`;
    fxCtx.lineWidth = 3.5;
    fxCtx.strokeStyle = "rgba(0,0,0,0.6)";
    fxCtx.strokeText(pop.text, pop.x, pop.y);
    fxCtx.fillStyle = pop.color;
    fxCtx.fillText(pop.text, pop.x, pop.y);
  }
  fxCtx.globalAlpha = 1;
}

// Crash impact frame: a white blowout that fades, plus jagged crack lines
// radiating from center — sells the hit on the frozen frame before results.
function drawCrash(W, H, k) {
  fxCtx.fillStyle = `rgba(255,255,255,${k * 0.5})`;
  fxCtx.fillRect(0, 0, W, H);
  const cx = W / 2, cy = H * 0.5;
  fxCtx.strokeStyle = `rgba(255,255,255,${k * 0.8})`;
  fxCtx.lineWidth = 2;
  fxCtx.beginPath();
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + i * 0.7;
    const len = (0.3 + (i % 3) * 0.16) * Math.hypot(W, H);
    fxCtx.moveTo(cx, cy);
    fxCtx.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len * 0.8);
  }
  fxCtx.stroke();
}
