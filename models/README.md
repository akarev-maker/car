# Car models (`.glb`)

The game loads a real 3D model for each car from this folder. Until a file
exists, it falls back to a detailed **procedural** car automatically — so the
game works right now with zero downloads. Drop a file in and it's used on the
next run (the selected car even hot-swaps mid-game once loaded).

## File names

Put GLB files here using the car's id as the filename:

| Car          | id       | file                |
|--------------|----------|---------------------|
| City Hatch   | `hatch`  | `models/hatch.glb`  |
| Sport Sedan  | `sedan`  | `models/sedan.glb`  |
| Muscle       | `muscle` | `models/muscle.glb` |
| GT Coupe     | `gt`     | `models/gt.glb`     |
| Hypercar     | `super`  | `models/super.glb`  |

Only `.glb` (binary glTF) is wired up. If you have `.gltf` + textures, export/
convert to a single `.glb` first.

## Where to get license-clean (CC0) models

These are free for any use, including commercial, no attribution required:

- **Kenney – Car Kit**: https://kenney.nl/assets/car-kit (low-poly, stylized)
- **Quaternius – Ultimate Vehicles / Cars**: https://quaternius.com/ (CC0)
- **Poly Pizza**: https://poly.pizza/ (filter by CC0)

Avoid Sketchfab/CGTrader models unless the license explicitly allows web/game
use — many are "personal use only".

## Fitting a model to the game

Models come in different sizes, orientations, and origins. Tune each car in
`game.js` → `MODEL_CFG`:

```js
const MODEL_CFG = {
  hatch: { url: "models/hatch.glb", scale: 1, yaw: Math.PI, y: 0 },
  // ...
};
```

- `scale` — the car should be roughly **2 units wide / ~4.5 long**. Increase or
  decrease `scale` until it looks right next to traffic.
- `yaw` — rotation about the vertical axis (radians). The car must face **−Z**
  (away from the camera). If it faces you, use `Math.PI`; if sideways, `±Math.PI/2`.
- `y` — vertical offset so the wheels sit on the road (y = 0 is the road surface).

## Serving the game

ES modules + the Three.js import map require the page to be served over HTTP
(not opened as a `file://`). Any static server works, e.g. from the project root:

```
python3 -m http.server 8000
# then open http://localhost:8000
```
