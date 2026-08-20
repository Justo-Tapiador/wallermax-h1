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
  SCENE_COMPILER_SYSTEM_PROMPT,
  RECONSTRUCTION_SYSTEM_PROMPT,
  FINAL_IMAGE_SYSTEM_PROMPT,
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
    systemPrompt: SCENE_COMPILER_SYSTEM_PROMPT + (req.systemPromptExtra ?? ""),
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
      const uBase = u.name.split("/").pop()!.split("\\").pop()!;
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
  for (const e of world.entities) {
    if (e.material) {
      if (e.material.texture_image) {
        const resolved = resolveTextureName(e.material.texture_image);
        if (resolved) e.material.texture_image = resolved;
      }
      if (e.material.normal_image) {
        const resolved = resolveTextureName(e.material.normal_image);
        if (resolved) e.material.normal_image = resolved;
      }
      if (e.material.roughness_image) {
        const resolved = resolveTextureName(e.material.roughness_image);
        if (resolved) e.material.roughness_image = resolved;
      }
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
