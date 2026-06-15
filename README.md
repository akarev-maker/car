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
| Accelerate   | `↑` / `W`         | Push the joystick up           |
| Brake        | `↓` / `S`         | Pull the joystick down         |
| Steer        | `←` `→` / `A` `D` | Push the joystick left / right |
| Mute         | `M`               | 🔊 button (top-right)          |

Mobile is landscape-only; a prompt asks players to rotate from portrait.

## Project layout

| File / folder   | What it is                                                        |
|-----------------|-------------------------------------------------------------------|
| `index.html`    | Page shell, canvases, HUD markup, and the Three.js import map.     |
| `game.js`       | The whole game: physics, traffic, scoring, garage, rendering.     |
| `style.css`     | HUD, menus, garage, and biome-label styling.                      |
| `models/`       | Optional `.glb` car models (procedural cars are used as fallback). |

## Biome engine

The environment is driven by distance, not a timer. `BIOMES` (near the top of
`game.js`) is an ordered **ring** of biomes; each entry is a full set of
environment params (sky/fog color, fog distances, hemisphere + sun lighting,
grass tint, and a `night` factor that drives headlight glow). Every frame
`applyBiome(km)` finds the two neighbouring biomes, holds on the current one,
then smoothsteps into the next.

Two tuning knobs:

- `BIOME_CYCLE_KM` — distance for one full lap around the ring (default `8`).
- `BIOME_BLEND` — fraction of each biome's span spent crossfading (default `0.4`).

Adding a biome is just another entry in the `BIOMES` array — it slots into the
rotation automatically and gets evenly spaced around the ring.

## Car models

Drop CC0 `.glb` files into `models/` to replace the procedural cars. See
[`models/README.md`](models/README.md) for file names, sources, and how to fit a
model with `MODEL_CFG`.
