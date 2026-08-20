# Scene Compiler Skills — Wallermax H1 v1.0.1

> This document is appended to the `SCENE_COMPILER_SYSTEM_PROMPT` when calling the LLM.
> It contains patterns, anti-patterns, recipes, and concrete examples for generating
> high-quality World Model JSON that produces visually pleasing renders in Blender.
>
> **Read this carefully before emitting any World Model JSON.** Most failures are due
> to violations of the anti-patterns listed below.

---

## 0. Mental model

Wallermax H1 is **NOT** a general-purpose 3D modeler. It is a **procedural scene
compiler** that turns a declarative JSON into a Blender scene using only primitive
shapes (`box`, `sphere`, `cylinder`, `plane`, `room`, `light`, `camera`, `empty`).

**What you CAN do:**
- Compose scenes from primitives (a bed = 6 boxes)
- Apply PBR textures (`texture_image`, `normal_image`, `roughness_image`)
- Animate camera with behaviors (`orbit`, `dolly_in`, `pan`, `tilt`, `crane_up`)
- Animate lights and objects with events (keyframes on `position`, `energy`, `color`)
- Use 4 render engines (EEVEE, EEVEE_NEXT, Cycles, fallback)

**What you CANNOT do:**
- Import external 3D models (`.glb`, `.obj`, `.fbx`) — not supported
- Boolean operations on geometry (no "subtracted" holes in walls)
- Cloth simulation, hair, particles
- Geometry Nodes or custom shaders (only Principled BSDF)
- Volumetric lighting (no god rays, no fog volumes)
- Custom mesh vertices (only procedural primitives)

**Embrace the constraints.** A great wallermax scene composes 20-50 primitives
cleverly positioned, with good lighting and tasteful camera motion. It does NOT
try to be photorealistic — it aims for **stylized realism** (low-poly architectural
visualization quality).

---

## 1. CRITICAL anti-patterns (NEVER do these)

These are the most common mistakes. Violating any of them produces broken or
visually broken renders.

### 1.1 NEVER put the camera outside a closed room

**Symptom:** The render shows a uniform gray/blue wall with no scene visible.
**Cause:** The room is a closed box. If the camera is outside it, it sees only
the outer face of one wall (backface culling makes the rest invisible).

```jsonc
// ❌ BAD — camera at [0, -6, 2.5] outside a 6×4×3 room centered at origin
{
  "id": "camera",
  "transform": { "position": [0, -6, 2.5] },
  "camera": { "look_at": [0, 0, 1] }
}

// ✅ GOOD — camera at [0, -1.5, 1.7] INSIDE the same room
{
  "id": "camera",
  "transform": { "position": [0, -1.5, 1.7] },
  "camera": { "look_at": [0, 1.5, 1.0] }
}
```

**Rule:** For a room of dimensions `[W, D, H]` centered at `[cx, cy, cz]`, the
camera's X position must be within `[cx - W/2 + 0.5, cx + W/2 - 0.5]` and the
Y position within `[cy - D/2 + 0.5, cy + D/2 - 0.5]`.

If you want an exterior view, **omit the room entity** and just place primitives
in open space (no surrounding walls).

### 1.2 NEVER use `mood: "melancholic"` or `mood: "noir"` by default

**Symptom:** The render is too dark to see anything.
**Cause:** These moods force `ambient_color: [0.01, 0.01, 0.03]` (almost black)
and `exposure_ev: -0.5` (underexposed). Combined with weak lights, the scene
is invisible.

```jsonc
// ❌ BAD — default melancholic
{
  "aesthetic": {
    "mood": "melancholic",
    "exposure_ev": -0.5,
    "style_tags": ["cinematic", "noir", "dystopian"]
  },
  "world": {
    "environment": { "ambient_color": [0.01, 0.01, 0.03] }
  }
}

// ✅ GOOD — bright daylight
{
  "aesthetic": {
    "mood": "bright",
    "exposure_ev": 0.0,
    "style_tags": ["daylight", "warm", "natural"]
  },
  "world": {
    "environment": { "ambient_color": [0.5, 0.5, 0.55], "ambient_intensity": 1.0 }
  }
}
```

**Rule:** Only use `mood: "melancholic"` or `mood: "noir"` if the user
**explicitly** requests a dark/cinematic atmosphere in the prompt. Default
to `mood: "bright"` with `ambient_color: [0.5, 0.5, 0.55]` and
`exposure_ev: 0.0`.

### 1.3 NEVER center the room at `[3, 1.5, 3]`

**Symptom:** Camera and object positions don't match the user's mental model.
**Cause:** DeepSeek tends to put the room origin at half its dimensions, which
is wrong — the origin should be the room's center, not its corner.

```jsonc
// ❌ BAD — room offset to fit corner at origin
{
  "id": "room",
  "transform": { "position": [3, 1.5, 3] },
  "geometry": { "dimensions": [6, 3, 6] }
}

// ✅ GOOD — room centered at origin
{
  "id": "room",
  "transform": { "position": [0, 0, 0] },
  "geometry": { "dimensions": [6, 3, 6] }
}
```

**Rule:** Always center the room at `[0, 0, 0]`. Adjust object positions
relative to the room's center, not its corner.

### 1.4 NEVER use `behavior.type: "dolly"` or `"crane"` (generic)

**Symptom:** The camera doesn't move.
**Cause:** The schema enum and the Python compiler expect `dolly_in`, `dolly_out`,
`crane_up`, `crane_down` — not the generic `dolly` or `crane`.

```jsonc
// ❌ BAD
{ "behavior": { "type": "dolly", "distance": 3.0 } }
{ "behavior": { "type": "crane", "distance": 1.5 } }

// ✅ GOOD
{ "behavior": { "type": "dolly_in", "distance": 3.0 } }
{ "behavior": { "type": "crane_up", "distance": 1.5 } }
```

### 1.5 NEVER emit `material` as a string

**Symptom:** The compiler crashes with `AttributeError: 'str' object has no attribute 'get'`.
**Cause:** Some LLMs occasionally emit `"material": "wood.jpg"` instead of
`"material": {"texture_image": "wood.jpg"}`. The compiler now coerces strings
to dicts (defensive patch A6), but it's still better to emit a proper dict.

```jsonc
// ❌ BAD
{ "material": "wood.jpg" }

// ✅ GOOD
{ "material": { "texture_image": "wood.jpg", "pattern_scale": 3.0 } }
```

### 1.6 NEVER use SUN light with `power < 3.0`

**Symptom:** The scene is dark even with SUN light.
**Cause:** In Blender, SUN light `power` is in W/m² and values below 3.0 produce
very dim lighting. Cycles especially needs at least 5.0.

```jsonc
// ❌ BAD
{ "light": { "type": "SUN", "power": 1.0 } }

// ✅ GOOD
{ "light": { "type": "SUN", "power": 5.0, "color": [1.0, 0.95, 0.85], "color_temperature_k": 5500 } }
```

**Recommended ranges:**
- EEVEE_NEXT: SUN power 3.0–8.0
- Cycles: SUN power 5.0–15.0
- POINT light (room scale 6m): power 50–200 W
- AREA light (room scale 6m): power 100–500 W

### 1.7 NEVER target the room with `behavior.target: "room"` and expect orbit to work

**Symptom:** Camera doesn't orbit.
**Cause:** Although v1.0.1 registers a `room_anchor` empty at the room's
center, the orbit may still fail if the camera has a `camera.target: "room"`
constraint that conflicts with the orbit pivot.

**Workaround:** Always create an explicit `empty` entity as the orbit target:

```jsonc
// ✅ GOOD — explicit orbit target
{
  "id": "orbit_target",
  "type": "empty",
  "transform": { "position": [0, 0, 1.2] },
  "geometry": {}
},
{
  "id": "camera",
  "type": "camera",
  "transform": { "position": [0, -3, 1.7] },
  "camera": { "lens": 35, "look_at": [0, 0, 1.2] },
  "behavior": {
    "type": "orbit",
    "target": "orbit_target",
    "angle": 90,
    "duration": 4
  }
}
```

### 1.8 NEVER emit `painting3.jpg` if the user only uploaded 2 images

**Symptom:** The third texture fails to load (`WALLERMAX_TEXTURE_RESOLVE_FAIL`).
**Cause:** The UI only accepts 2 image uploads (`referenceImage` and `finalImage`).

**Rule:** If the user uploaded 2 images, only reference those 2 filenames in
`texture_image` fields. For additional textured surfaces, use procedural patterns
(`checker`, `noise`, `gradient`, `brick`) or solid `base_color` values.

---

## 2. Scene composition patterns

### 2.1 Room entity

The `room` entity is special — it generates floor + ceiling + 4 walls automatically.
Its `transform.position` is the **center** of the room (not a corner).

```jsonc
{
  "id": "room",
  "type": "room",
  "transform": { "position": [0, 0, 0] },
  "geometry": { "dimensions": [6, 4, 3] },  // width, depth, height (meters)
  "metadata": {
    "floor_material": {
      "base_color": [0.5, 0.35, 0.2],
      "roughness": 0.6,
      "pattern": "checker",
      "pattern_scale": 8.0
    },
    "wall_material": {
      "base_color": [0.9, 0.88, 0.85],
      "roughness": 0.9
    },
    "checker_tile_size": 0.25,
    "wall_thickness": 0.15
  }
}
```

For a room of dimensions `[W, D, H]` centered at `[0, 0, 0]`:
- Floor is at `z = 0`
- Ceiling is at `z = H`
- Wall positions (centers):
  - Wall north (+Y): `[0, D/2, H/2]`, dimensions `[W, wall_thickness, H]`
  - Wall south (-Y): `[0, -D/2, H/2]`, dimensions `[W, wall_thickness, H]`
  - Wall east (+X): `[W/2, 0, H/2]`, dimensions `[wall_thickness, D, H]`
  - Wall west (-X): `[-W/2, 0, H/2]`, dimensions `[wall_thickness, D, H]`

### 2.2 Decomposing furniture into primitives

#### Bed (king size, 2.0 × 1.8 × 0.6 m)

A bed is 6-7 primitives. Place against a wall (typically north):

```jsonc
// Bed frame (wood)
{
  "id": "bed_frame",
  "type": "box",
  "transform": { "position": [0, 1.4, 0.2] },
  "geometry": { "dimensions": [2.2, 1.8, 0.3] },
  "material": { "base_color": [0.35, 0.22, 0.12], "roughness": 0.6 }
},
// Mattress (white)
{
  "id": "mattress",
  "type": "box",
  "transform": { "position": [0, 1.4, 0.5] },
  "geometry": { "dimensions": [2.0, 1.8, 0.25] },
  "material": { "base_color": [0.95, 0.95, 0.92], "roughness": 0.85 }
},
// Pillows (2)
{
  "id": "pillow_left",
  "type": "box",
  "transform": { "position": [-0.5, 2.0, 0.7] },
  "geometry": { "dimensions": [0.45, 0.35, 0.12] },
  "material": { "base_color": [0.98, 0.98, 0.95], "roughness": 0.9 }
},
{
  "id": "pillow_right",
  "type": "box",
  "transform": { "position": [0.5, 2.0, 0.7] },
  "geometry": { "dimensions": [0.45, 0.35, 0.12] },
  "material": { "base_color": [0.98, 0.98, 0.95], "roughness": 0.9 }
},
// Blanket (colored)
{
  "id": "blanket",
  "type": "plane",
  "transform": { "position": [0, 0.9, 0.64], "rotation": [0, 0, 0] },
  "geometry": { "dimensions": [2.0, 1.0] },
  "material": { "base_color": [0.45, 0.32, 0.28], "roughness": 0.85 }
},
// Headboard (against north wall)
{
  "id": "headboard",
  "type": "box",
  "transform": { "position": [0, 2.25, 0.7] },
  "geometry": { "dimensions": [2.2, 0.1, 1.0] },
  "material": { "base_color": [0.35, 0.22, 0.12], "roughness": 0.6 }
}
```

#### Chair (0.5 × 0.5 × 0.9 m)

```jsonc
// Seat
{
  "id": "chair_seat",
  "type": "box",
  "transform": { "position": [2.5, -1.5, 0.45] },
  "geometry": { "dimensions": [0.5, 0.5, 0.05] },
  "material": { "base_color": [0.4, 0.3, 0.2] }
},
// Back
{
  "id": "chair_back",
  "type": "box",
  "transform": { "position": [2.5, -1.75, 0.7] },
  "geometry": { "dimensions": [0.5, 0.05, 0.5] },
  "material": { "base_color": [0.4, 0.3, 0.2] }
},
// Legs (4 cylinders)
{
  "id": "chair_leg_fl",
  "type": "cylinder",
  "transform": { "position": [2.7, -1.3, 0.2] },
  "geometry": { "radius": 0.03, "depth": 0.4 },
  "material": { "base_color": [0.2, 0.15, 0.1] }
}
// ... (3 more legs)
```

#### Window (against a wall)

Windows are tricky because the schema doesn't support boolean operations
(you can't "cut" a hole in a wall). Two approaches:

**Approach A — Window floating on wall (recommended for interior views)**

Place a transparent `plane` on the inner face of the wall. The wall stays solid
behind, but from the interior you see the "window" as a translucent rectangle
(letting light through conceptually):

```jsonc
{
  "id": "window_glass",
  "type": "plane",
  "transform": { "position": [0, 1.94, 1.6], "rotation": [90, 0, 0] },
  "geometry": { "dimensions": [1.5, 1.2] },
  "material": {
    "base_color": [0.9, 0.95, 1.0],
    "alpha": 0.3,
    "ior": 1.45,
    "roughness": 0.05
  }
}
```

**Approach B — No wall (open scene)**

If the user wants an exterior view, omit the room and use only the floor and
2-3 walls (not all 4). This way the camera can see "outside".

### 2.3 Lighting setup

For a 6×4×3 m room with Cycles engine, use this baseline:

```jsonc
// Key light: SUN through the "window"
{
  "id": "sun_light",
  "type": "light",
  "transform": {
    "position": [4, 4, 6],
    "rotation": [-35, 0, 45]    // points down-and-toward-room-center
  },
  "light": {
    "type": "SUN",
    "power": 8.0,                // strong for Cycles
    "color": [1.0, 0.95, 0.85],  // warm daylight
    "color_temperature_k": 5500,
    "size": 0.5,
    "softness": 0.2
  }
},
// Fill light: POINT inside the room (simulates bounce/ambient)
{
  "id": "fill_light",
  "type": "light",
  "transform": { "position": [0, 0, 2.5] },
  "light": {
    "type": "POINT",
    "power": 80,                 // 80W for room scale
    "color": [1.0, 0.95, 0.9],
    "color_temperature_k": 4500
  }
},
// Accent light: AREA near a painting (warm glow)
{
  "id": "painting_light",
  "type": "light",
  "transform": { "position": [-1, -1.7, 2.0], "rotation": [90, 0, 0] },
  "light": {
    "type": "SPOT",
    "power": 30,
    "color": [1.0, 0.85, 0.65],
    "beam_angle": 30,
    "color_temperature_k": 3000
  }
}
```

**Always set ambient_color in the world block:**

```jsonc
"world": {
  "environment": {
    "ambient_color": [0.5, 0.5, 0.55],
    "ambient_intensity": 1.0
  }
}
```

### 2.4 PBR textures

When the user uploads images as textures:

```jsonc
// Albedo only (color)
{
  "material": {
    "texture_image": "wood.jpg",
    "base_color": [1, 1, 1, 1],   // white multiplier
    "pattern_scale": 3.0           // repeat 3×3 across the surface
  }
}

// Full PBR (albedo + normal + roughness)
{
  "material": {
    "texture_image": "stone_albedo.jpg",
    "normal_image": "stone_normal.jpg",
    "roughness_image": "stone_roughness.jpg",
    "normal_strength": 1.0,
    "base_color": [1, 1, 1, 1],
    "pattern_scale": 2.0
  }
}
```

**Color space rules** (handled automatically by the compiler):
- `texture_image` → sRGB (visible color)
- `normal_image` → Non-Color (data map)
- `roughness_image` → Non-Color (grayscale data)

---

## 3. Camera behavior patterns

### 3.1 When to use each behavior

| Behavior | Use when | Key parameters |
|---|---|---|
| `static` | Default, when no motion is requested | (none) |
| `look_at` | Camera should track a moving target | `target: "<entity_id>"` |
| `follow` | Same as look_at (synonym) | `target: "<entity_id>"` |
| `orbit` | Circular camera move around a point of interest | `target`, `angle`, `duration` |
| `dolly_in` | Camera moves forward toward look_at | `distance`, `duration` |
| `dolly_out` | Camera moves backward away from look_at | `distance`, `duration` |
| `crane_up` | Camera rises vertically (world Z) | `distance`, `duration` |
| `crane_down` | Camera descends vertically (world Z) | `distance`, `duration` |
| `pan` | Camera rotates around its own Z axis (left/right) | `angle`, `duration` |
| `tilt` | Camera rotates around its own X axis (up/down) | `angle`, `duration` |

### 3.2 Orbit pattern (most common cinematic move)

For a 90° orbit around a room center over 4 seconds:

```jsonc
// Step 1: Create an empty as orbit target
{
  "id": "orbit_target",
  "type": "empty",
  "transform": { "position": [0, 0, 1.2] },
  "geometry": {}
},
// Step 2: Camera with orbit behavior targeting the empty
{
  "id": "camera",
  "type": "camera",
  "transform": {
    "position": [3, -3, 1.7],     // start position (3m from center)
    "rotation": [0, 0, 0]
  },
  "camera": {
    "lens": 35,
    "sensor_width": 36,
    "look_at": [0, 0, 1.2]         // initial look direction
  },
  "behavior": {
    "type": "orbit",
    "target": "orbit_target",
    "angle": 90,                    // degrees
    "duration": 4                    // seconds
  }
}
```

### 3.3 Dolly-in pattern (reveal)

For a slow push-in toward a hero object:

```jsonc
{
  "id": "camera",
  "type": "camera",
  "transform": {
    "position": [0, -5, 1.7]        // start 5m from hero
  },
  "camera": {
    "lens": 50,                      // slightly longer lens for compression
    "look_at": [0, 0, 1.0]          // focus on hero at origin
  },
  "behavior": {
    "type": "dolly_in",
    "distance": 3.5,                 // move 3.5m forward (ends 1.5m from hero)
    "duration": 5
  }
}
```

### 3.4 Crane-up pattern (vertical reveal)

For a "rising" shot that reveals a scene from low to high:

```jsonc
{
  "id": "camera",
  "type": "camera",
  "transform": { "position": [0, -4, 0.5] },   // start low
  "camera": { "lens": 24, "look_at": [0, 0, 1.5] },  // wide angle
  "behavior": {
    "type": "crane_up",
    "distance": 2.0,                 // rise 2m
    "duration": 4
  }
}
```

### 3.5 Multi-shot sequences

For a cinematic sequence, **use multiple cameras with different behaviors**:

```jsonc
// Shot 1: Wide establishing orbit (0-3s)
{
  "id": "cam_wide",
  "type": "camera",
  "transform": { "position": [4, -4, 2.5] },
  "camera": { "lens": 24, "look_at": [0, 0, 1] },
  "behavior": {
    "type": "orbit",
    "target": "orbit_target",
    "angle": 45,
    "duration": 3
  }
},
// Shot 2: Close-up dolly-in on hero (3-6s)
// (use events to switch active camera at t=3s)
```

To switch active camera mid-animation, use an `event`:

```jsonc
"events": [
  {
    "time": 3.0,
    "target": "cam_closeup",
    "action": { "type": "set_active_camera" }
  }
]
```

(Note: `set_active_camera` event support depends on compiler version. If
unavailable, render the shots as separate jobs and concatenate the MP4s.)

---

## 4. Aesthetic block rules

The `aesthetic` block drives the compositor pass (vignette, grain, bloom,
exposure). It's optional but strongly recommended.

### 4.1 Default aesthetic (bright daylight)

Use this unless the user explicitly asks for a different mood:

```jsonc
"aesthetic": {
  "palette": [[0.7, 0.7, 0.7], [0.5, 0.5, 0.5]],
  "color_temperature_k": 5500,
  "mood": "bright",
  "style_tags": ["daylight", "natural", "clean"],
  "grain": 0.0,
  "vignette": 0.1,
  "bloom": 0.0,
  "exposure_ev": 0.0
}
```

### 4.2 Cinematic dusk (only if user requests)

```jsonc
"aesthetic": {
  "palette": [[0.8, 0.4, 0.2], [0.2, 0.3, 0.5]],
  "color_temperature_k": 3200,
  "mood": "golden_hour",
  "style_tags": ["cinematic", "warm", "dramatic"],
  "grain": 0.15,
  "vignette": 0.3,
  "bloom": 0.4,
  "exposure_ev": 0.3
}
```

### 4.3 Mood cheat sheet

| Mood | When to use | ambient_color | exposure_ev | style_tags |
|---|---|---|---|---|
| `bright` | Default, indoor, office, hotel | `[0.5, 0.5, 0.55]` | `0.0` | `["daylight", "natural"]` |
| `golden_hour` | Sunset exterior | `[0.3, 0.2, 0.15]` | `0.3` | `["warm", "cinematic"]` |
| `night` | Night exterior, city | `[0.05, 0.05, 0.1]` | `-0.5` | `["noir", "moody"]` |
| `studio` | Product shot, neutral | `[0.7, 0.7, 0.7]` | `0.0` | `["clean", "neutral"]` |
| `melancholic` | ONLY if user asks | `[0.05, 0.05, 0.08]` | `-0.5` | `["moody", "dramatic"]` |

---

## 5. Common scene recipes

### 5.1 Hotel room (interior)

```text
Room: 6×4×3 m centered at origin.
Bed: against north wall (Y=+1.5), 2.0×1.8 m, 5 primitives (frame, mattress, 2 pillows, blanket).
Window: south wall (Y=-2), 1.5×1.2 m transparent plane at Z=1.5.
Paintings: 2 on west wall (X=-3), 0.6×0.4 m, at Z=1.6.
Lamps: 2 nightstands with POINT lights, power 50 W each.
Sun: outside window, power 8.0, color [1.0, 0.95, 0.85].
Camera: inside room, [0, -1.5, 1.7], orbit 45° around [0, 0, 1.0] over 4s.
```

### 5.2 Office desk (close-up)

```text
No room — open scene.
Desk: 1.6×0.8×0.05 m box at Z=0.7, wood texture.
Chair: 5 primitives (seat, back, 4 legs).
Monitor: 0.5×0.3×0.02 m box at Z=1.0, base_color [0.05, 0.05, 0.1] (off screen).
Keyboard: 0.4×0.15×0.02 m box at Z=0.74, base_color [0.1, 0.1, 0.1].
Mug: cylinder at [0.3, 0, 0.78], radius 0.04, depth 0.1.
Lighting: AREA light above desk, power 100, plus fill POINT.
Camera: [0, -1.5, 1.3], look_at [0, 0, 0.9], dolly_in 0.5m over 3s.
```

### 5.3 Living room (interior, wider)

```text
Room: 8×6×3 m.
Sofa: 3-seat, 2.4×0.9×0.7 m, decomposed into 5 boxes (base, 3 backs, 2 arms).
Coffee table: 1.2×0.6×0.4 m, glass top (alpha 0.3).
TV: 1.2×0.7×0.05 m box against north wall at Z=1.5.
Bookshelf: 1.5×0.3×2.0 m against east wall, decomposed into 4 shelves × 5 books = 20 small boxes.
Carpet: 3×2 m plane at Z=0.005 with pattern: noise, pattern_scale 5.
Lighting: SUN power 6 through window + AREA power 80 above sofa.
Camera: orbit 60° around room center over 5s.
```

### 5.4 Exterior (open scene, no room)

```text
No room entity — just floor and primitives.
Ground: 20×20 m plane at Z=0, grass color [0.2, 0.4, 0.15].
Trees: 5-8 instances, each = cylinder (trunk) + sphere (foliage).
Path: 1×5 m plane, stone color [0.5, 0.5, 0.45].
Sky: ambient_color [0.4, 0.6, 0.8], ambient_intensity 1.5.
Lighting: SUN power 12, color [1.0, 0.95, 0.85].
Camera: crane_up 3m from [0, -8, 1] looking at [0, 0, 1.5].
```

---

## 6. Render engine choice

| Engine | When to use | Samples | Speed |
|---|---|---|---|
| `BLENDER_EEVEE_NEXT` | Default, fast preview, interior scenes | 16-32 | Fast (5-30s/frame) |
| `CYCLES` | Photorealistic, GI/reflections/refraction | 64-256 | Slow (10-60s/frame) |

**Rules:**
- Use `BLENDER_EEVEE_NEXT` for iteration and quick previews.
- Use `CYCLES` for the final render, especially if the scene has:
  - Glass materials (windows with alpha < 0.5)
  - Reflective surfaces (metallic > 0.5)
  - Indirect lighting (light bouncing off colored walls)
  - Soft shadows

For Cycles, set `samples: 64` minimum (128 for production quality).

---

## 7. Quality checklist before emitting JSON

Before returning the World Model JSON, verify:

- [ ] Room is centered at `[0, 0, 0]` (not `[3, 1.5, 3]`)
- [ ] Camera is INSIDE the room (X within ±W/2, Y within ±D/2)
- [ ] `ambient_color` is at least `[0.3, 0.3, 0.3]` (no near-black)
- [ ] `mood` is NOT `melancholic` unless explicitly requested
- [ ] `exposure_ev` is `0.0` or positive (no underexposure)
- [ ] SUN light `power` is at least `3.0` (EEVEE) or `5.0` (Cycles)
- [ ] All `behavior.type` values are from the allowed enum (no `dolly`/`crane` generic)
- [ ] All `material` values are objects (not strings)
- [ ] All `texture_image` references match filenames the user uploaded
- [ ] Camera `behavior.target` references an existing entity id (or `orbit_target`)
- [ ] No entity has `transform.position` with values > 100 (suspicious — probably unit error)
- [ ] All `dimensions` are in meters (not cm or mm)
- [ ] The `render.duration` matches the user's request
- [ ] The `render.engine` matches the user's request (default `BLENDER_EEVEE_NEXT`)

If any check fails, fix it before emitting the JSON. Do not emit a World Model
that you know will produce a broken render.

---

## 8. Failure modes and how to avoid them

### 8.1 "All frames are the same color"

**Cause:** Camera is outside a closed room, or scene is too dark.
**Fix:**
- Move camera inside the room
- Increase `ambient_color` to `[0.5, 0.5, 0.55]`
- Increase SUN `power` to at least `5.0`
- Set `exposure_ev: 0.0`

### 8.2 "Texture not applied"

**Cause:** `texture_image` filename doesn't match the uploaded image's name.
**Fix:**
- Use the exact filename the user mentioned in the prompt
- The compiler resolves suffix-matches (e.g. `"wood.jpg"` matches upload `"1787229211108-wood.jpg"`)
- If unsure, emit the absolute path that was annotated in the prompt

### 8.3 "Camera doesn't move"

**Cause:** `behavior.target` references a non-existent entity, or `behavior.duration` is 0.
**Fix:**
- Create an explicit `empty` entity as orbit target
- Ensure `behavior.duration` > 0 and matches `render.duration`
- Use the correct enum values (`dolly_in`, not `dolly`)

### 8.4 "Crash with AttributeError"

**Cause:** A `material` field was emitted as a string instead of an object.
**Fix:**
- Always emit `material` as an object: `{ "texture_image": "..." }` not `"wood.jpg"`
- If you only need a color: `{ "base_color": [0.5, 0.5, 0.5] }`

---

## 9. Examples of well-formed entities

### 9.1 Sphere with PBR texture

```jsonc
{
  "id": "ball_hero",
  "type": "sphere",
  "provenance": "user_defined",
  "confidence": 1,
  "transform": { "position": [0, 0, 0.5], "rotation": [0, 0, 0], "scale": [1, 1, 1] },
  "geometry": { "shape": "sphere", "radius": 0.5 },
  "material": {
    "base_color": [1, 1, 1, 1],
    "texture_image": "ball_texture.jpg",
    "roughness": 0.4,
    "metallic": 0.0
  }
}
```

### 9.2 Light with color temperature

```jsonc
{
  "id": "warm_lamp",
  "type": "light",
  "provenance": "user_defined",
  "confidence": 1,
  "transform": { "position": [2, 1, 2.5], "rotation": [0, 0, 0], "scale": [1, 1, 1] },
  "light": {
    "type": "POINT",
    "power": 60,
    "color": [1.0, 0.85, 0.65],
    "color_temperature_k": 3000,
    "size": 0.1,
    "softness": 0.5
  }
}
```

### 9.3 Camera with orbit

```jsonc
{
  "id": "camera",
  "type": "camera",
  "provenance": "user_defined",
  "confidence": 1,
  "transform": { "position": [3, -3, 1.7], "rotation": [0, 0, 0], "scale": [1, 1, 1] },
  "camera": {
    "lens": 35,
    "sensor_width": 36,
    "projection": "perspective",
    "look_at": [0, 0, 1.0],
    "fov_deg": 54.43,
    "dof_focus_distance": 4.5,
    "dof_fstop": 2.8
  },
  "behavior": {
    "type": "orbit",
    "target": "orbit_target",
    "duration": 4,
    "angle": 90
  }
}
```

### 9.4 Complete minimal scene

```jsonc
{
  "version": "1.0",
  "world": {
    "units": "meters",
    "coordinate_system": "Z-up, right-handed",
    "environment": {
      "gravity": [0, 0, -9.81],
      "ambient_color": [0.5, 0.5, 0.55],
      "ambient_intensity": 1.0
    },
    "render": {
      "width": 1280, "height": 720, "fps": 24, "duration": 4,
      "engine": "BLENDER_EEVEE_NEXT", "samples": 32
    },
    "aesthetic": {
      "mood": "bright",
      "color_temperature_k": 5500,
      "style_tags": ["daylight", "natural"],
      "exposure_ev": 0.0,
      "grain": 0.0,
      "vignette": 0.1
    }
  },
  "entities": [
    {
      "id": "room",
      "type": "room",
      "provenance": "user_defined",
      "confidence": 1,
      "transform": { "position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1] },
      "geometry": { "shape": "room", "dimensions": [6, 4, 3] },
      "metadata": {
        "floor_material": { "base_color": [0.5, 0.35, 0.2], "roughness": 0.6 },
        "wall_material": { "base_color": [0.9, 0.88, 0.85], "roughness": 0.9 },
        "checker_tile_size": 0.25,
        "wall_thickness": 0.15
      }
    },
    {
      "id": "hero_ball",
      "type": "sphere",
      "provenance": "user_defined",
      "confidence": 1,
      "transform": { "position": [0, 0, 0.5], "rotation": [0, 0, 0], "scale": [1, 1, 1] },
      "geometry": { "shape": "sphere", "radius": 0.5 },
      "material": { "base_color": [0.85, 0.2,0.2], "roughness": 0.3 }
    },
    {
      "id": "orbit_target",
      "type": "empty",
      "provenance": "user_defined",
      "confidence": 1,
      "transform": { "position": [0, 0, 0.5] },
      "geometry": {}
    },
    {
      "id": "sun_light",
      "type": "light",
      "provenance": "user_defined",
      "confidence": 1,
      "transform": { "position": [5, 5, 8], "rotation": [-35, 0, 45], "scale": [1, 1, 1] },
      "light": { "type": "SUN", "power": 5.0, "color": [1.0, 0.95, 0.85], "color_temperature_k": 5500 }
    },
    {
      "id": "camera",
      "type": "camera",
      "provenance": "user_defined",
      "confidence": 1,
      "transform": { "position": [3, -3, 1.7], "rotation": [0, 0, 0], "scale": [1, 1, 1] },
      "camera": { "lens": 35, "look_at": [0, 0, 0.5] },
      "behavior": { "type": "orbit", "target": "orbit_target", "angle": 90, "duration": 4 }
    }
  ],
  "relationships": [],
  "constraints": [],
  "events": []
}
```

---

## 10. Final reminders

1. **Be explicit.** Do not rely on defaults for camera position, ambient_color,
   or mood — always emit explicit values.
2. **Embrace constraints.** Don't try to make photorealistic scenes. Aim for
   clean, well-lit, stylized scenes with good composition.
3. **Use provenance honestly.** Mark every entity with `user_defined`,
   `observed`, `inferred`, or `creative` and a realistic `confidence` (0-1).
4. **Validate before emitting.** Run through the checklist in section 7.
5. **When in doubt, simplify.** A simple scene that renders well is better
   than a complex scene that renders poorly.

Now emit the World Model JSON.
