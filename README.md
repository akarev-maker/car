# Traffic Racer 3D

An arcade lane-weaving racer built with [Three.js](https://threejs.org/). Dodge
traffic, chain near-misses for a score multiplier, bank credits, and unlock
faster cars in the garage. The world runs a **biome engine** that cycles the
environment by distance — Day↔Night with smooth crossfades (and the engine is
built to take more biomes than that).

## Run it

The game uses ES modules and an import map (Three.js is pulled from a CDN), so it
must be served over HTTP — opening `index.html` from the file system won't work.

```bash
# Option A — Node (no install needed)
npm start                     # serves on http://localhost:8000

# Option B — Python 3
python3 -m http.server 8000   # then open http://localhost:8000
```

Then open <http://localhost:8000> in a modern browser.

## Controls

| Action       | Keyboard          | Mobile                         |
|--------------|-------------------|--------------------------------|
| Accelerate   | `↑` / `W`         | Hold **GAS** (bottom-right)    |
| Brake        | `↓` / `S`         | Hold **BRAKE** (bottom-right)  |
| Steer        | `←` `→` / `A` `D` | Hold **◀ / ▶** (bottom-left)   |
| Pause        | `P` / `Esc`       | ⏸ button (top-right)           |
| Mute         | `M`               | 🔊 button (top-right)          |

Mobile is landscape-only; a prompt asks players to rotate from portrait.

## Project layout

| File / folder    | What it is                                                        |
|------------------|-------------------------------------------------------------------|
| `index.html`     | Page shell, canvases, HUD markup, and the Three.js import map.     |
| `src/config.js`  | Tuning constants, car/vehicle data, and shared helpers.           |
| `src/store.js`   | Shared mutable state, persistence, goals, challenges, career.     |
| `src/audio.js`   | The WebAudio engine sound + all UI/event SFX.                      |
| `src/world3d.js` | Entity arrays, traffic/scenery spawning, the physics `update()`.  |
| `src/render.js`  | Three.js scene, mesh builders, day/night biome, the render loop.  |
| `src/main.js`    | Entry point: input, HUD, game loop, run lifecycle, and all UI.    |
| `style.css`      | HUD, menus, garage, and biome-label styling.                      |
| `models/`        | Optional `.glb` car models (procedural cars are used as fallback). |

## Biome engine

The environment is driven by distance, not a timer. The biome ring lives in
`src/config.js`; each entry is a full set of environment params (sky/fog color,
fog distances, hemisphere + sun lighting, grass tint, and a `night` factor that
drives headlight glow). Every frame `applyBiome(km)` (in `src/render.js`) finds
the two neighbouring biomes, holds on the current one, then smoothsteps into the
next.

Two tuning knobs:

- `BIOME_CYCLE_KM` — distance for one full lap around the ring (default `8`).
- `BIOME_BLEND` — fraction of each biome's span spent crossfading (default `0.4`).

Adding a biome is just another entry in the `BIOMES` array — it slots into the
rotation automatically and gets evenly spaced around the ring.

## Car models

Drop CC0 `.glb` files into `models/` to replace the procedural cars. See
[`models/README.md`](models/README.md) for file names, sources, and how to fit a
model with `MODEL_CFG`.
