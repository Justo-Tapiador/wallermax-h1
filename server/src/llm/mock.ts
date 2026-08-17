// Wallermax H1 — Mock LLM provider
//
// Returns canned but realistic World Model / Reconstruction / Final-Image
// payloads so the entire pipeline (and the web UI) can be exercised without
// an API key. Useful for development, demos, and CI smoke tests.
//
// The mock is NOT random: same inputs always produce the same outputs, which
// makes the resulting Blender render reproducible.

import process from "node:process";
import type { AnalyzeOptions, AnalyzeResult, LLMProvider } from "./provider.js";
import { extractJson } from "./provider.js";

// ── Sample payloads ────────────────────────────────────────────────────

const SAMPLE_WORLD = {
  version: "1.0-mock",
  world: {
    units: "meters",
    coordinate_system: "Z-up, right-handed",
    environment: {
      gravity: [0, 0, -9.81],
      ambient_color: [0.04, 0.04, 0.05],
      ambient_intensity: 1.0,
    },
    render: { width: 960, height: 540, fps: 30, duration: 4, engine: "BLENDER_EEVEE_NEXT" },
    aesthetic: {
      palette: [[0.85, 0.35, 0.35], [0.92, 0.92, 0.92], [0.08, 0.08, 0.1]],
      color_temperature_k: 5200,
      mood: "neutral",
      style_tags: ["cinematic", "studio"],
      vignette: 0.35,
      bloom: 0.2,
      exposure_ev: 0.1,
    },
  },
  entities: [
    {
      id: "room_main",
      type: "room",
      provenance: "user_defined",
      confidence: 1.0,
      geometry: { shape: "room", dimensions: [10, 10, 3] },
      metadata: { checker_tile_size: 0.25, wall_thickness: 0.15 },
    },
    {
      id: "ball_hero",
      type: "ball",
      name: "Hero Ball",
      provenance: "user_defined",
      confidence: 1.0,
      transform: { position: [-1, 0, 0.5] },
      geometry: { shape: "sphere", radius: 0.5 },
      material: {
        base_color: [0.85, 0.18, 0.18],
        roughness: 0.25,
        metallic: 0.0,
      },
      physics: {
        rigid_body: { mass: 0.5, restitution: 0.75, friction: 0.4, type: "ACTIVE" },
      },
      behavior: { type: "static" },
    },
    {
      id: "box_obstacle",
      type: "box",
      name: "Obstacle",
      provenance: "inferred",
      confidence: 0.6,
      transform: { position: [1.5, 1.0, 0.4], rotation: [0, 0, 15] },
      geometry: { shape: "box", dimensions: [0.8, 0.8, 0.8] },
      material: {
        base_color: [0.2, 0.4, 0.8],
        roughness: 0.5,
        metallic: 0.0,
      },
      physics: { rigid_body: { mass: 2.0, restitution: 0.3, friction: 0.7, type: "PASSIVE" } },
    },
    {
      id: "light_key",
      type: "light",
      provenance: "inferred",
      confidence: 0.7,
      transform: { position: [-2, -3, 2.7] },
      light: {
        type: "AREA",
        power: 800,
        color_temperature_k: 5200,
        size: 1.2,
        shape: "RECTANGLE",
      },
    },
    {
      id: "light_fill",
      type: "light",
      provenance: "inferred",
      confidence: 0.5,
      transform: { position: [3, -2, 2.5] },
      light: {
        type: "AREA",
        power: 250,
        color: [1.0, 0.85, 0.7],
        size: 1.8,
        shape: "DISK",
      },
    },
    {
      id: "light_rim",
      type: "light",
      provenance: "creative",
      confidence: 0.4,
      transform: { position: [0, 4, 2.2] },
      light: { type: "SPOT", power: 400, color: [0.7, 0.85, 1.0], beam_angle: 35, softness: 0.4 },
    },
    {
      id: "camera_main",
      type: "camera",
      provenance: "user_defined",
      confidence: 1.0,
      transform: { position: [0, -5, 1.8] },
      camera: {
        lens: 35,
        sensor_width: 36,
        projection: "perspective",
        target: "ball_hero",
        dof_focus_distance: 5,
        dof_fstop: 2.8,
      },
      behavior: { type: "orbit", target: "ball_hero", duration: 4, angle: 90 },
    },
  ],
  relationships: [
    { from: "light_key", to: "ball_hero", type: "illuminates", weight: 1.0 },
    { from: "camera_main", to: "ball_hero", type: "tracks", weight: 1.0 },
  ],
  constraints: [],
  events: [
    {
      time: 0.5,
      target: "light_rim",
      action: { power: 600 },
    },
    {
      time: 2.0,
      target: "light_rim",
      action: { power: 200 },
    },
    {
      time: 3.0,
      target: "ball_hero",
      action: { position: [0.8, 0.3, 0.5] },
    },
  ],
};

const SAMPLE_RECONSTRUCTION = {
  image_observations: {
    description: "A studio scene with a red ball and a blue checkered box on a checkerboard floor.",
    visible_regions: ["floor", "back_wall", "ball", "box", "key_light_visible"],
    shadow_observations: [
      { caster: "ball_hero", direction: [0.6, 0.5, -0.6], softness: 0.5, length_hint_m: 0.7 },
      { caster: "box_obstacle", direction: [0.6, 0.5, -0.6], softness: 0.45, length_hint_m: 0.8 },
    ],
    reflection_observations: [
      { surface: "ball_hero", reflects: "light_key" },
    ],
    occlusions: [
      { occluded: "wall_back", occluder: "box_obstacle", partial: true },
    ],
  },
  camera_hypothesis: {
    projection: "perspective",
    position: [0, -5, 1.8],
    look_at: [0, 0, 0.5],
    focal_length_mm: 35,
    sensor_width_mm: 36,
    fov_deg: 54,
    roll_deg: 0,
    confidence: 0.7,
  },
  entities: [
    {
      id: "room_main",
      type: "room",
      provenance: "inferred",
      confidence: 0.75,
      geometry: { shape: "room", dimensions: [10, 10, 3] },
      material: { pattern: "checker", pattern_scale: 0.6 },
    },
    {
      id: "ball_hero",
      type: "sphere",
      name: "Red Hero Ball",
      provenance: "observed",
      confidence: 0.95,
      transform: { position: [-1, 0, 0.5] },
      geometry: { shape: "sphere", radius: 0.5 },
      material: { base_color: [0.85, 0.18, 0.18], roughness: 0.25 },
    },
    {
      id: "box_obstacle",
      type: "box",
      name: "Blue Checkered Box",
      provenance: "observed",
      confidence: 0.9,
      transform: { position: [1.5, 1.0, 0.4], rotation: [0, 0, 15] },
      geometry: { shape: "box", dimensions: [0.8, 0.8, 0.8] },
      material: { base_color: [0.2, 0.4, 0.8], roughness: 0.5, pattern: "checker", pattern_scale: 6 },
    },
  ],
  lighting: {
    global_illumination: {
      ambient_color: [0.04, 0.04, 0.05],
      ambient_intensity: 0.3,
      color_temperature_k: 5200,
    },
    sources: [
      {
        type: "area",
        position: [-2, -3, 2.7],
        direction: [0.3, 0.4, -0.8],
        relative_intensity: 1.0,
        color_temperature_k: 5200,
        apparent_size: 1.2,
        shadow_softness: 0.5,
        visible: false,
      },
      {
        type: "area",
        position: [3, -2, 2.5],
        direction: [-0.4, 0.3, -0.7],
        relative_intensity: 0.4,
        color: [1.0, 0.85, 0.7],
        apparent_size: 1.8,
        shadow_softness: 0.7,
        visible: false,
      },
    ],
    relationships: [],
  },
  ambiguities: [
    {
      topic: "absolute_scale",
      description: "Single image cannot disambiguate absolute metric scale.",
      candidate_hypotheses: [],
    },
  ],
};

const SAMPLE_FINAL_IMAGE = {
  source_image: "mock",
  summary:
    "A cinematic medium shot with warm key light from camera-left and cool rim light from behind, " +
    "shallow depth of field, gentle vignette and faint film grain.",
  camera: {
    shot_type: "medium",
    lens_mm_approx: 50,
    height_m: 1.6,
    angle_deg: 0,
    fov_deg: 40,
    dof_focus_distance_m: 4,
    dof_fstop: 2.0,
    motion: "slow_pan",
    notes: "Subject kept on left third, gentle negative space on the right.",
  },
  lighting: {
    key_direction: "front_left",
    intensity: "medium",
    contrast: "high",
    color_temperature_k: 3200,
    color_temperature_balance: "mixed_warm_cool",
    mood: "dramatic",
    shadows: "soft",
    highlight_specularity: "glossy",
    ambient_contribution: "low",
    visible_sources: ["practical_lamp_right", "window_back_left"],
    notes: "Key is warm 3200K, rim is cool 6500K from a back-left window.",
  },
  objects: [
    { name: "hero_subject", role: "hero", approx_position: "left_third", approx_scale: "hero", color_hint: "warm red" },
    { name: "background_wall", role: "background", approx_position: "background", approx_scale: "large", color_hint: "neutral grey" },
    { name: "practical_lamp", role: "atmosphere", approx_position: "right_third", approx_scale: "small", color_hint: "warm amber" },
  ],
  textures: [
    { name: "matte_paint", base_color: [0.6, 0.6, 0.6], roughness: 0.8, metallic: 0.0, pattern: "solid", feeling: "matte" },
    { name: "glossy_plastic", base_color: [0.85, 0.18, 0.18], roughness: 0.25, metallic: 0.0, pattern: "solid", feeling: "glossy" },
    { name: "metal_lamp", base_color: [0.9, 0.85, 0.7], roughness: 0.3, metallic: 0.9, pattern: "solid", feeling: "metallic" },
  ],
  palette: {
    dominant: [[0.85, 0.18, 0.18], [0.6, 0.6, 0.6], [0.9, 0.85, 0.7]],
    accent: [[0.2, 0.4, 0.8]],
    overall: "complementary",
  },
  style: {
    tags: ["cinematic", "warm_key_cool_rim", "shallow_dof"],
    era_or_genre: "modern_drama",
    grain: 0.15,
    vignette: 0.4,
    bloom: 0.25,
    exposure_ev: 0.0,
    post_processing: ["film_grain", "vignette", "subtle_bloom", "warm_shadows"],
  },
  confidence: 0.75,
};

// ── Prompt parsing helpers ─────────────────────────────────────────────
// Map of English color words to linear RGB (0-1) for the base_color field.
const COLOR_MAP: Record<string, [number, number, number]> = {
  red: [0.85, 0.18, 0.18],
  green: [0.2, 0.7, 0.25],
  blue: [0.2, 0.4, 0.85],
  yellow: [0.95, 0.85, 0.2],
  orange: [0.95, 0.55, 0.15],
  purple: [0.6, 0.25, 0.85],
  pink: [0.95, 0.55, 0.75],
  cyan: [0.2, 0.85, 0.9],
  magenta: [0.85, 0.2, 0.85],
  white: [0.95, 0.95, 0.95],
  black: [0.05, 0.05, 0.05],
  gray: [0.5, 0.5, 0.5],
  grey: [0.5, 0.5, 0.5],
  brown: [0.45, 0.3, 0.15],
  teal: [0.15, 0.65, 0.65],
  navy: [0.1, 0.2, 0.5],
  lime: [0.55, 0.9, 0.2],
  gold: [0.9, 0.75, 0.15],
  silver: [0.75, 0.75, 0.78],
};

/**
 * Apply simple prompt-driven tweaks to the mock World Model so the user
 * sees the prompt having an effect even without a real LLM.
 *
 * This is intentionally simple — it just scans the prompt for color words
 * and applies them to the hero ball / box. The real LLM (openai/zai) does
 * a much better job; this is just a stand-in for testing.
 */
function _applyPromptTweaks(world: Record<string, unknown>, prompt: string): void {
  const lower = prompt.toLowerCase();
  const entities = (world.entities as Array<Record<string, unknown>>) || [];
  // Find the hero ball entity.
  const ball = entities.find((e) => e.type === "ball" || e.type === "sphere");
  if (ball) {
    // Scan the prompt for "<color> ball" or "<color> sphere".
    for (const [colorName, rgb] of Object.entries(COLOR_MAP)) {
      const re = new RegExp(`\\b${colorName}\\b\\s+(?:ball|sphere)`, "i");
      if (re.test(lower) || lower.includes(`${colorName} ball`) || lower.includes(`${colorName} sphere`)) {
        // Override the material base_color.
        const mat = (ball.material as Record<string, unknown>) || {};
        mat.base_color = rgb;
        ball.material = mat;
        ball.name = `${colorName} ball`;
        console.log(`[mock] prompt-driven color override: ball → ${colorName} ${JSON.stringify(rgb)}`);
        break;
      }
    }
  }
  // Find the box entity and apply color overrides for "box" / "cube".
  const box = entities.find((e) => e.type === "box" || e.type === "cube");
  if (box) {
    for (const [colorName, rgb] of Object.entries(COLOR_MAP)) {
      const re = new RegExp(`\\b${colorName}\\b\\s+(?:box|cube)`, "i");
      if (re.test(lower) || lower.includes(`${colorName} box`) || lower.includes(`${colorName} cube`)) {
        const mat = (box.material as Record<string, unknown>) || {};
        mat.base_color = rgb;
        box.material = mat;
        box.name = `${colorName} box`;
        console.log(`[mock] prompt-driven color override: box → ${colorName} ${JSON.stringify(rgb)}`);
        break;
      }
    }
  }
}

// ── Provider ───────────────────────────────────────────────────────────

export class MockProvider implements LLMProvider {
  readonly name = "mock";

  async analyze(opts: AnalyzeOptions): Promise<AnalyzeResult> {
    const started = Date.now();

    // IMPORTANT: The mock provider IGNORES the user's prompt and images.
    // It always returns a canned World Model (ball in a checkerboard room),
    // with only basic color overrides (e.g. "green ball" → green ball).
    // To actually use the prompt and reference image, switch to the "openai"
    // or "zai" provider in .env (LLM_PROVIDER=openai or LLM_PROVIDER=zai).
    console.warn("[mock] WARNING: mock provider is active — the user's prompt and images are being IGNORED.");
    console.warn("[mock] The mock always returns a ball-in-checkerboard-room scene.");
    console.warn("[mock] To use the real prompt, set LLM_PROVIDER=openai (with OPENAI_API_KEY) or LLM_PROVIDER=zai in .env.");

    // Simulate latency so the UI progress bar feels alive.
    await new Promise((r) => setTimeout(r, 250 + Math.random() * 350));

    const schemaStr = JSON.stringify(opts.schema);
    let payload: unknown;

    if (opts.systemPrompt.includes("look-dev / aesthetic analyzer")) {
      payload = JSON.parse(JSON.stringify(SAMPLE_FINAL_IMAGE));  // deep clone
    } else if (opts.systemPrompt.includes("vision/reconstruction stage")) {
      payload = JSON.parse(JSON.stringify(SAMPLE_RECONSTRUCTION));  // deep clone
    } else {
      // Deep clone the sample world so we can mutate it per-prompt.
      payload = JSON.parse(JSON.stringify(SAMPLE_WORLD));
      // Apply simple prompt-driven tweaks so the user sees the prompt
      // having an effect even with the mock provider.
      _applyPromptTweaks(payload as Record<string, unknown>, opts.prompt || "");
    }

    // Defensive: if the prompt is unusually long, fold a hint into the mock.
    if (opts.prompt && opts.prompt.length > 1200) {
      const summary = `${opts.prompt.slice(0, 80)}…`;
      if (payload && typeof payload === "object" && "world" in payload) {
        (payload as Record<string, unknown>).__mock_prompt_summary = summary;
      }
    }

    const raw = JSON.stringify(payload, null, 2);
    return {
      json: extractJson(raw),
      raw,
      provider: this.name,
      model: process.env.MOCK_LLM_MODEL ?? "mock-1.0",
      latencyMs: Date.now() - started,
    };
  }
}
