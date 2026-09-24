# Wallermax H1 — Python renderer backends

This folder contains the **two** Python renderer backends used by
Wallermax H1. Both are pure Python and use only the standard library
plus their respective dependencies — they do not need any of the
TypeScript project's npm packages.

## Files

| File | Purpose | Dependencies |
| --- | --- | --- |
| `build_scene.py` | Full Blender compiler. Produces `.blend` + MP4 with PBR materials, real physics, perspective camera, cinematic quality presets, HDRI/sky lighting, spline camera flights, aesthetic compositor. | Blender 3.6+ (uses `bpy`, `mathutils`) |
| `fallback_renderer.py` | Preview renderer. Produces an MP4 + PNG poster using only Pillow + numpy + ffmpeg. Used automatically when Blender is not installed. | Python 3.10+, Pillow, numpy, ffmpeg |

The Node.js server picks one of them at runtime via the
`server/src/renderer.ts` module: Blender first, fallback second.

---

## Cinematic quality features (v1.2.0)

All of the following are driven by the World Model JSON — no extra CLI
arguments, fully LLM-controllable.

### `world.render.quality` — preview | standard | cinematic

| Setting | preview | standard | cinematic |
|---|---|---|---|
| EEVEE TAA render samples | 16 | 64 | 128 |
| Soft shadows / SSR | off | on | on |
| Raytracing + GTAO (EEVEE Next) | off | off | on |
| Motion blur (180° shutter) | off | off | **on** |
| Cycles samples (floor) | as requested | ≥48 | **≥128 + OIDN denoise** |
| H.264 CRF | MEDIUM | MEDIUM | HIGH |

`world.render.shutter` tunes the motion-blur shutter (default 0.5 = 180°,
like a film camera). Cinematic is the single highest-impact setting for
realistic output; combine with `engine: "CYCLES"` for maximum fidelity.

### `world.environment.sky` — physical Nishita sky

```jsonc
"environment": { "sky": { "sun_elevation": 15, "sun_rotation": 135 } }
```

Elevation 10-20° = golden hour (the most cinematic light there is). In
EEVEE a matching warm SUN light is auto-created; in Cycles the sky itself
casts the sunlight.

### `world.environment.hdri` — HDRI environment lighting

```jsonc
"environment": { "hdri": { "path": "studio.hdr", "rotation_z": 90 } }
```

Files resolve like textures (absolute path, upload dir, recursive walk).

### Camera: `spline_path`, `zoom_in/out`, `dof_autofocus`

```jsonc
"behavior": {
  "type": "spline_path",
  "duration": 8,
  "easing": "ease_in_out",
  "path": [[-2.2,-1.6,1.6], [-1.0,-1.4,1.7], [1.2,-0.8,1.5], [2.0,0.6,1.4]]
}
```

Waypoints become a smooth Bezier curve (auto handles ≈ Catmull-Rom).
Pair with `camera.target`/`camera.look_at` so the subject stays framed;
`camera.dof_autofocus: true` keeps it sharp while flying. `zoom_in` /
`zoom_out` animate the focal length (`lens_start` → `lens_end`).

### Model import — `type: "model"` + `geometry.file`

Imports `.glb/.gltf/.obj/.fbx/.ply`. Multi-object imports are parented
under one Empty root, so the entity's `transform` moves the whole asset.
Provide a `material` block to override the imported materials, or omit it
to keep them.

### Compositor finishing stages

Driven by `world.aesthetic`: `vignette` (now actually applied), `grain`
(seeded, animated, deterministic), `chromatic_aberration` (subtle default
in cinematic), `bloom` (Glare node — works in EEVEE Next), and a
color-temperature grade from `color_temperature_k`. Exposure is applied
pre-tonemap via AgX/Filmic view settings.

### Optional MP4 finalize pass

`world.render.postprocess: true` runs a conservative ffmpeg pass
(unsharp + micro contrast/saturation lift) on the final MP4.

---

## `build_scene.py` — Blender compiler

### Usage

The compiler is launched by the Node.js server as a subprocess:

```bash
blender -b --python python/build_scene.py -- /path/to/world.json /path/to/output_dir
```

Outputs:

- `output_dir/world.blend` — the saved Blender scene
- `output_dir/render.mp4` — the rendered MP4 (H.264)

### What changed vs. World Compiler v2 / v3

| Area | v2/v3 | Wallermax H1 |
|------|-------|--------------|
| Materials | Solid + checker only | Solid, checker, noise, gradient, brick; emission; alpha; IOR; optional texture maps |
| Lights | Color only | Color **or** color temperature (Kelvin → sRGB) |
| Camera | Static or look_at | look_at, follow, orbit, dolly_in/out, crane_up/down, pan, tilt + DoF |
| Events | energy / position / rotation | + color, visibility, keyframe-clean |
| Aesthetic | — | New `world.aesthetic` block drives ambient, bloom, exposure, vignette |
| Render engine | EEVEE_NEXT only | EEVEE_NEXT **or** Cycles (with samples) |
| Metadata | — | Provenance & confidence preserved as custom properties on every object |
| Robustness | Crashes on missing fields | Defensive `get(..., default)` everywhere |

### Why Python is still here

Blender's Python API (`bpy`) is the only stable way to script scene
construction. The Node.js server therefore orchestrates: it builds the
World Model in TypeScript, then shells out to Blender for the heavy 3D
work. This keeps the *creative* layer (LLM, schema, UI) in TypeScript and
the *mechanical* layer (Blender) in Python — the best of both worlds.

---

## `fallback_renderer.py` — Preview renderer

### Purpose

The fallback renderer exists so the pipeline can produce an MP4 **even
when Blender is not installed**. It is invoked automatically by the
TypeScript orchestrator (`server/src/renderer.ts`) when:

- Blender is not on PATH (or at the path pointed to by `BLENDER_BIN`), or
- Blender fails to start (e.g. missing libraries, GPU issues), or
- The user explicitly sets `SKIP_BLENDER=1` (in which case neither
  renderer runs — only the World Model JSON is produced).

### What it renders

A top-down schematic / look-dev preview:

- The room as a checkerboard floor + walls outline (top-down view).
- Each entity as a colored 2D disk / box / cylinder icon at its X, Y
  position (Z is used only for draw ordering).
- Lights as colored radial glows (size and brightness derived from the
  `power` field; color derived from `color` or `color_temperature_k`).
- The camera as a small triangle.
- Animated events: position changes, energy changes, color changes are
  all keyframed over time.
- The aesthetic block: vignette, film grain, exposure EV are applied as
  a final compositor pass.
- A small HUD overlay with timecode, frame counter and entity count.

### What it does NOT render

The fallback is intentionally **not** a substitute for Blender. It does
not honor:

- Real PBR materials (BRDFs, roughness, metallic, IOR).
- Real rigid-body physics.
- Perspective camera projection (it uses an orthographic top-down view).
- Real shadows, reflections, ambient occlusion or global illumination.
- Texture maps (`texture_image`, `normal_image`, etc.).

For all of the above, install Blender and let the pipeline use
`build_scene.py` instead.

### Usage

The compiler is launched by the Node.js server as a subprocess:

```bash
python3 python/fallback_renderer.py /path/to/world.json /path/to/output_dir [width] [height] [fps] [duration]
```

Defaults for `width`, `height`, `fps`, `duration` come from the World
Model's `world.render` block.

Outputs:

- `output_dir/render.mp4` — H.264 MP4 (same codec as Blender's output).
- `output_dir/poster.png` — the first frame, useful as a static thumbnail.

### Requirements

- Python 3.10+
- Pillow: `pip install Pillow`
- numpy: `pip install numpy`
- ffmpeg on PATH (used to encode the MP4 from raw frames).

### Determinism

The fallback renderer is **deterministic**: same inputs always produce
the same outputs. There are no random operations. This makes the
resulting render reproducible, which is important for tests and demos.
