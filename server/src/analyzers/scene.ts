// Wallermax H1 — scene analyzer
//
// Calls the LLM to produce a World Model from:
//   - a natural-language prompt (required)
//   - an optional reference image (single RGB image to reconstruct from)
//   - an optional final / target image (aesthetic / look-dev reference)
//
// This module unifies what World Compiler v2 called "scene_analyzer" and what
// v3 called "reconstruction_analyzer". The two paths are kept distinct at
// the schema level (we run them as separate LLM calls when a reference
// image is supplied), but their outputs are merged into a single World
// Model that the Blender compiler consumes.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { getProvider } from "../llm/index.js";
import {
  RECONSTRUCTION_SYSTEM_PROMPT,
  FINAL_IMAGE_SYSTEM_PROMPT,
  getSceneCompilerSystemPrompt,
} from "../llm/prompts.js";
import type { AnalyzeResult } from "../llm/provider.js";
import { loadSchema } from "./schemas.js";
import type { PipelineRequest, WorldModel } from "../types.js";

function mimeFromExt(p: string): string {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".bmp") return "image/bmp";
  return "image/jpeg";
}

async function readImage(ref?: { path: string; mime?: string; name?: string }): Promise<
  { bytes: Buffer; mime: string; name: string } | undefined
> {
  if (!ref || !ref.path) return undefined;
  const bytes = await readFile(ref.path);
  return {
    bytes,
    mime: ref.mime || mimeFromExt(ref.path),
    name: ref.name || path.basename(ref.path),
  };
}

export interface AnalysisBundle {
  world: WorldModel;
  reconstruction?: unknown;
  reconstructionMeta?: AnalyzeResult;
  finalImageAnalysis?: unknown;
  finalImageMeta?: AnalyzeResult;
  worldMeta: AnalyzeResult;
}

export async function analyzeScene(req: PipelineRequest): Promise<AnalysisBundle> {
  const provider = getProvider(req.provider);
  const refImg = await readImage(req.referenceImage);
  const finalImg = await readImage(req.finalImage);

  // ── 1. Reconstruction (only when a reference image is supplied) ─────
  let reconstruction: unknown;
  let reconstructionMeta: AnalyzeResult | undefined;
  if (refImg) {
    reconstructionMeta = await provider.analyze({
      prompt: req.prompt,
      systemPrompt: RECONSTRUCTION_SYSTEM_PROMPT,
      schema: loadSchema("reconstruction"),
      images: [refImg],
      model: req.model,
    });
    reconstruction = reconstructionMeta.json;
  }

  // ── 2. Final-image aesthetic analysis ───────────────────────────────
  let finalImageAnalysis: unknown;
  let finalImageMeta: AnalyzeResult | undefined;
  if (finalImg) {
    finalImageMeta = await provider.analyze({
      prompt:
        "Analyze this target / final image and extract its aesthetic look-dev: " +
        "camera language, lighting mood, palette, object roles and textures.",
      systemPrompt: FINAL_IMAGE_SYSTEM_PROMPT,
      schema: loadSchema("final_image"),
      images: [finalImg],
      model: req.model,
    });
    finalImageAnalysis = finalImageMeta.json;
  }

  // ── 3. Build the World Model ─────────────────────────────────────────
  //
  // We pass BOTH the reconstruction (if any) and the final-image analysis
  // (if any) to the scene compiler as additional context. The scene compiler
  // is the LLM call that returns a World Model.
  const augmentedPrompt = buildAugmentedPrompt(req.prompt, reconstruction, finalImageAnalysis);

  const images = [refImg, finalImg].filter(Boolean) as { bytes: Buffer; mime: string; name?: string }[];

  const worldMeta = await provider.analyze({
    prompt: augmentedPrompt,
    systemPrompt: getSceneCompilerSystemPrompt(req.systemPromptExtra),
    schema: loadSchema("world_model"),
    images,
    model: req.model,
  });

  const world = worldMeta.json as WorldModel;

  // ── 3b. Resolve texture_image / normal_image / roughness_image ──────
  // The LLM may emit bare filenames (e.g. "wood.png") that don't match the
  // actual filename on disk (the server prefixes a timestamp: e.g.
  // "1787225305385-wood.jpg"). We try multiple match strategies:
  //   1. Exact match on upload name
  //   2. Basename match (LLM may strip the dir)
  //   3. Suffix match: upload name ENDS WITH the LLM-emitted name
  //      (this covers "1787225305385-wood.jpg" matching LLM's "wood.jpg")
  //   4. If LLM emitted an absolute path or URL, leave as is
  const uploads: Array<{ name: string; path: string }> = [];
  if (req.referenceImage) uploads.push({ name: req.referenceImage.name, path: req.referenceImage.path });
  if (req.finalImage) uploads.push({ name: req.finalImage.name, path: req.finalImage.path });

  function resolveTextureName(name: unknown): string | undefined {
    if (typeof name !== "string" || !name) return undefined;
    // Already absolute path or URL — leave as is
    if (name.startsWith("/") || name.startsWith("http") || /^[A-Za-z]:[\\/]/.test(name)) return name;
    // Strategy 1+2: exact match or basename match
    for (const u of uploads) {
      if (u.name === name) return u.path;
      //const uBase = u.name.split("/").pop()!.split("\\").pop()!;
      //  const uBase: string = u.name.split("/").pop()!.split("\\").pop()!;
        const uBase: string = u.name.split("/").pop()!.split("\\").pop()! ?? "";
      if (uBase === name) return u.path;
    }
    // Strategy 3: suffix match (upload name ENDS WITH LLM name)
    // E.g. upload="1787225305385-wood.jpg", LLM emits "wood.jpg"
    for (const u of uploads) {
      if (u.name.endsWith(name)) return u.path;
      // Also try with normalized separators
      const uNorm = u.name.replace(/\\/g, "/");
      if (uNorm.endsWith(name)) return u.path;
    }
    // Strategy 4: case-insensitive suffix match (Windows case-insensitive fs)
    const nameLower = name.toLowerCase();
    for (const u of uploads) {
      if (u.name.toLowerCase().endsWith(nameLower)) return u.path;
    }
    // Could not resolve — return the original (Blender will log a clear error)
    console.warn(`[scene] could not resolve texture name "${name}" against uploads: ${uploads.map(u => u.name).join(", ")}`);
    return name;
  }
  // Helper: resolve texture names inside a material spec that may be a
  // string (coerce to {"texture_image": <resolved>}) or a dict.
  function resolveMaterialSpec(spec: unknown): unknown {
    if (typeof spec === "string") {
      const resolved = resolveTextureName(spec);
      return resolved ? { texture_image: resolved } : { texture_image: spec };
    }
    if (spec && typeof spec === "object") {
      const s = spec as Record<string, unknown>;
      if (typeof s.texture_image === "string") {
        const resolved = resolveTextureName(s.texture_image);
        if (resolved) s.texture_image = resolved;
      }
      if (typeof s.normal_image === "string") {
        const resolved = resolveTextureName(s.normal_image);
        if (resolved) s.normal_image = resolved;
      }
      if (typeof s.roughness_image === "string") {
        const resolved = resolveTextureName(s.roughness_image);
        if (resolved) s.roughness_image = resolved;
      }
    }
    return spec;
  }

  for (const e of world.entities) {
    // 1. Resolve textures inside entity.material (top-level)
    if (e.material) {
      e.material = resolveMaterialSpec(e.material) as typeof e.material;
    }
    // 2. Resolve textures inside entity.metadata.floor_material and
    //    entity.metadata.wall_material (used by build_room via T2 patch).
    //    These may be strings or dicts; resolveMaterialSpec handles both.
    if (e.metadata) {
      const md = e.metadata as Record<string, unknown>;
      if (md.floor_material !== undefined) {
        md.floor_material = resolveMaterialSpec(md.floor_material);
      }
      if (md.wall_material !== undefined) {
        md.wall_material = resolveMaterialSpec(md.wall_material);
      }
    }
  }

  // ── 3c. Post-process: enforce bright lighting if LLM emitted dark values ──
  // Despite the skills markdown guidance, DeepSeek often emits:
  //   ambient_color: [0.005, 0.01, 0.02]  (near-black)
  //   mood: "melancholic"
  //   exposure_ev: -0.5
  //   style_tags with "noir", "cyberpunk", "dystopian"
  // These produce a near-black render. Override them to bright defaults
  // UNLESS the user explicitly requested a dark mood in their prompt.
  {
    const userPrompt = (req.prompt || "");
    const userPromptLower = userPrompt.toLowerCase();

    // v2: Smarter dark-mood detection with negation handling.
    // The original T9 detected keywords like "noir", "melancholic", "night", etc.
    // But it failed when the user wrote "NO uses melancholic" (negation) — it
    // detected the keyword and decided NOT to apply the override, even though
    // the user clearly wanted bright.
    //
    // v2 strategy:
    //   1. Find all keyword occurrences.
    //   2. Skip occurrences that appear in a negation context (within ~30 chars
    //      of "no ", "sin ", "don't ", "avoid ", "without ", "not ").
    //   3. If any keyword survives the negation filter → user wants dark.
    //   4. Also: if user explicitly asks for "bright", "daylight", "luz brillante",
    //      "iluminación brillante", etc., force bright regardless.
    const darkKeywords = [
      "noir", "melancholic", "cyberpunk", "dystopian",
      "noche", "night", "oscuro", "dark", "moody", "dramatic"
    ];
    const negationPatterns = [
      /\bno\s+([a-záéíóúñ\s]{0,30}?)\b(noir|melancholic|cyberpunk|dystopian|noche|night|oscuro|dark|moody|dramatic)\b/i,
      /\bsin\s+([a-záéíóúñ\s]{0,30}?)\b(noir|melancholic|cyberpunk|dystopian|noche|night|oscuro|dark|moody|dramatic)\b/i,
      /\bdon'?t\s+([a-z\s]{0,30}?)\b(noir|melancholic|cyberpunk|dystopian|noche|night|oscuro|dark|moody|dramatic)\b/i,
      /\bavoid\s+([a-z\s]{0,30}?)\b(noir|melancholic|cyberpunk|dystopian|noche|night|oscuro|dark|moody|dramatic)\b/i,
      /\bwithout\s+([a-z\s]{0,30}?)\b(noir|melancholic|cyberpunk|dystopian|noche|night|oscuro|dark|moody|dramatic)\b/i,
      /\bnot\s+([a-z\s]{0,30}?)\b(noir|melancholic|cyberpunk|dystopian|noche|night|oscuro|dark|moody|dramatic)\b/i,
    ];

    // Strip negated occurrences from the prompt before checking for keywords
    let sanitizedPrompt = userPromptLower;
    for (const pattern of negationPatterns) {
      sanitizedPrompt = sanitizedPrompt.replace(pattern, "");
    }

    // Special case: "nightstand" contains "night" — strip it before detection
    sanitizedPrompt = sanitizedPrompt.replace(/\bnightstand\b/gi, "x".repeat(10));

    // Check if any dark keyword appears in the sanitized prompt (non-negated context)
    let userWantsDark = darkKeywords.some(kw => sanitizedPrompt.includes(kw));

    // Override: if user explicitly asks for bright, force bright
    const brightPhrases = [
      "bright", "daylight", "luz brillante", "iluminación brillante",
      "iluminacion brillante", "ambiente brillante", "mood: bright",
      "mood bright", "día brillante", "dia brillante"
    ];
    const userWantsBright = brightPhrases.some(phrase => sanitizedPrompt.includes(phrase));
    if (userWantsBright) {
      userWantsDark = false;
    }

    if (!userWantsDark) {
      // 1. Force bright ambient_color if LLM emitted dark values
      const env = world.world.environment || (world.world.environment = {});
      const amb = env.ambient_color;
      const isDark = amb && Array.isArray(amb) && amb.length >= 3 &&
                     amb.every(c => typeof c === "number" && c < 0.1);
      if (isDark) {
        console.warn(`[scene] LLM emitted dark ambient_color [${amb?.map((c: number) => c.toFixed(3)).join(", ")}] — forcing bright [0.5, 0.5, 0.55]`);
        env.ambient_color = [0.5, 0.5, 0.55];
        env.ambient_intensity = 1.0;
      }

      // 2. Force mood to "bright" if LLM emitted dark mood
      const aest = world.world.aesthetic || (world.world.aesthetic = {});
      const darkMoods = ["melancholic", "noir", "cyberpunk", "dystopian", "moody", "dark"];
      if (typeof aest.mood === "string" && darkMoods.includes(aest.mood.toLowerCase())) {
        console.warn(`[scene] LLM emitted mood "${aest.mood}" — forcing "bright"`);
        aest.mood = "bright";
      }

      // 3. Force exposure_ev to 0.0 if LLM emitted negative value
      if (typeof aest.exposure_ev === "number" && aest.exposure_ev < -0.1) {
        console.warn(`[scene] LLM emitted exposure_ev ${aest.exposure_ev} — forcing 0.0`);
        aest.exposure_ev = 0.0;
      }

      // 4. Sanitize style_tags — remove dark-themed tags
      if (Array.isArray(aest.style_tags)) {
        const darkTags = ["noir", "cyberpunk", "dystopian", "melancholic", "moody", "dark"];
        const filtered = aest.style_tags.filter(
          (t: unknown) => typeof t === "string" && !darkTags.includes(t.toLowerCase())
        );
        if (filtered.length !== aest.style_tags.length) {
          console.warn(`[scene] LLM emitted dark style_tags [${aest.style_tags.join(", ")}] — sanitized to [${filtered.join(", ")}]`);
          // Ensure at least one bright tag
          if (filtered.length === 0 || !filtered.some(t => ["bright", "daylight", "natural", "warm"].includes(String(t).toLowerCase()))) {
            filtered.push("daylight");
          }
          aest.style_tags = filtered;
        }
      }

      // 5. Boost SUN light power if it's too low for Cycles
      const engine = world.world.render?.engine ?? "BLENDER_EEVEE_NEXT";
      const sun = world.entities.find(e => e.type === "light" && e.light?.type === "SUN");
      if (sun?.light && typeof sun.light.power === "number") {
        const minSunPower = engine === "CYCLES" ? 8.0 : 3.0;
        if (sun.light.power < minSunPower) {
          console.warn(`[scene] LLM emitted SUN power ${sun.light.power} — boosting to ${minSunPower} for ${engine}`);
          sun.light.power = minSunPower;
        }
      }

      // 6. Boost POINT lights if they're too weak for the room
      const room = world.entities.find(e => e.type === "room");
      const roomDims = room?.geometry?.dimensions;
      if (roomDims && Array.isArray(roomDims)) {
        const roomArea = (roomDims[0] ?? 6) * (roomDims[1] ?? 4);
        const minPointPower = Math.max(40, roomArea * 10);  // 10W per m² of floor, min 40W
        for (const e of world.entities) {
          if (e.type === "light" && e.light?.type === "POINT" && typeof e.light.power === "number") {
            if (e.light.power < minPointPower) {
              console.warn(`[scene] LLM emitted POINT light "${e.id}" power ${e.light.power} — boosting to ${minPointPower}`);
              e.light.power = minPointPower;
            }
          }
        }
      }
    } else {
      console.log(`[scene] user prompt indicates dark mood — keeping LLM's aesthetic choices`);
    }
  }

  // ── 4. Merge render settings from the request ──────────────────────
  // The user-specified render settings always win over what the LLM proposes.
  world.world = world.world || ({} as WorldModel["world"]);
  // Capture the LLM's proposed duration so we can rescale events if needed.
  const llmDuration = world.world.render?.duration ?? req.render.duration;
  world.world.render = {
    width: req.render.width,
    height: req.render.height,
    fps: req.render.fps,
    duration: req.render.duration,
    engine: req.render.engine ?? "BLENDER_EEVEE_NEXT",
    samples: req.render.samples ?? 64,
  };

  // If the request duration differs from the LLM's proposed duration,
  // rescale all event times and behavior durations so the animation
  // still fits within the render range. This prevents events that fall
  // outside the render range (e.g. an event at t=5s when duration=2s).
  if (llmDuration > 0 && Math.abs(llmDuration - req.render.duration) > 0.01) {
    const scale = req.render.duration / llmDuration;
    console.log(`[scene] rescaling events/behaviors: llmDuration=${llmDuration}s → reqDuration=${req.render.duration}s (scale=${scale.toFixed(3)})`);
    for (const ev of world.events as Array<Record<string, unknown>>) {
      if (typeof ev.time === "number") {
        ev.time = Math.max(0, ev.time * scale);
      }
    }
    for (const e of world.entities) {
      if (e.behavior && typeof e.behavior.duration === "number") {
        e.behavior.duration = e.behavior.duration * scale;
      }
    }
  }

  // ── 5. If a final-image analysis exists, fold the aesthetic block in ──
  if (finalImageAnalysis && typeof finalImageAnalysis === "object") {
    const fa = finalImageAnalysis as Record<string, unknown>;
    const palette = fa.palette as { dominant?: number[][]; accent?: number[][] } | undefined;
    const style = fa.style as Record<string, unknown> | undefined;
    const lighting = fa.lighting as Record<string, unknown> | undefined;
    const camera = fa.camera as Record<string, unknown> | undefined;

    world.world.aesthetic = {
      source_image: req.finalImage?.name,
      palette: palette?.dominant ?? [],
      color_temperature_k: typeof lighting?.color_temperature_k === "number"
        ? (lighting.color_temperature_k as number)
        : undefined,
      mood: typeof lighting?.mood === "string" ? (lighting.mood as string) : undefined,
      style_tags: Array.isArray(style?.tags) ? (style!.tags as string[]) : undefined,
      grain: typeof style?.grain === "number" ? (style.grain as number) : undefined,
      vignette: typeof style?.vignette === "number" ? (style.vignette as number) : undefined,
      bloom: typeof style?.bloom === "number" ? (style.bloom as number) : undefined,
      exposure_ev: typeof style?.exposure_ev === "number" ? (style.exposure_ev as number) : undefined,
    };

    // Drive the ambient color from the dominant palette color (if present).
    if (palette?.dominant && palette.dominant.length > 0) {
      const c = palette.dominant[0];
      if (c && c.length >= 3 && c[0] !== undefined && c[1] !== undefined && c[2] !== undefined) {
        world.world.environment = world.world.environment || {};
        world.world.environment.ambient_color = [c[0] * 0.1, c[1] * 0.1, c[2] * 0.1];
        world.world.environment.ambient_intensity = 1.0;
      }
    }

    // If the camera entity exists, optionally nudge its lens toward the
    // final-image lens hint when the LLM did not specify one.
    if (camera && typeof camera.lens_mm_approx === "number") {
      for (const e of world.entities) {
        if (e.type === "camera" && !e.camera?.lens) {
          e.camera = { ...(e.camera ?? {}), lens: camera.lens_mm_approx as number };
        }
      }
    }
  }

  return {
    world,
    reconstruction,
    reconstructionMeta,
    finalImageAnalysis,
    finalImageMeta,
    worldMeta,
  };
}

function buildAugmentedPrompt(
  basePrompt: string,
  reconstruction: unknown,
  finalImageAnalysis: unknown,
): string {
  const parts: string[] = [basePrompt.trim()];
  if (reconstruction) {
    parts.push(
      "\n\n--- Visual reconstruction of the reference image (use as evidence) ---\n" +
        JSON.stringify(reconstruction, null, 2),
    );
  }
  if (finalImageAnalysis) {
    parts.push(
      "\n\n--- Aesthetic / look-dev target (apply as world.aesthetic, camera & light hints) ---\n" +
        JSON.stringify(finalImageAnalysis, null, 2),
    );
  }
  return parts.join("");
}
