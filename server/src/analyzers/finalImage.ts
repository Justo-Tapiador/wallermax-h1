// Wallermax H1 — final-image analyzer (standalone endpoint)
//
// This is a thin wrapper around the LLM call that returns the final-image
// aesthetic analysis JSON. Used by the web UI's "Analyze final image" button
// so the user can preview the extracted look-dev before running the full
// pipeline.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { getProvider } from "../llm/index.js";
import { FINAL_IMAGE_SYSTEM_PROMPT } from "../llm/prompts.js";
import { loadSchema } from "./schemas.js";

function mimeFromExt(p: string): string {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".bmp") return "image/bmp";
  return "image/jpeg";
}

export async function analyzeFinalImage(
  imagePath: string,
  provider: "openai" | "zai" | "mock",
  model?: string,
): Promise<{ json: unknown; raw: string; provider: string; model: string; latencyMs: number }> {
  const p = getProvider(provider);
  const bytes = await readFile(imagePath);
  const result = await p.analyze({
    prompt:
      "Analyze this target / final image and extract its aesthetic look-dev: " +
      "camera language, lighting mood, palette, object roles and textures.",
    systemPrompt: FINAL_IMAGE_SYSTEM_PROMPT,
    schema: loadSchema("final_image"),
    images: [{ bytes, mime: mimeFromExt(imagePath), name: path.basename(imagePath) }],
    model,
  });
  return {
    json: result.json,
    raw: result.raw,
    provider: result.provider,
    model: result.model,
    latencyMs: result.latencyMs,
  };
}
