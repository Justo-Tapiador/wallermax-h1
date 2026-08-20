// Wallermax H1 — ZAI provider
//
// Uses the z-ai-web-dev-sdk available inside the Z.ai sandbox. Falls back
// gracefully when images are not provided (LLM text-only path).
//
// The ZAI SDK does not natively support JSON-schema-strict output, so we
// instruct the model via the prompt and then defensively extract the JSON
// using the shared extractJson helper.

import ZAI from "z-ai-web-dev-sdk";
import process from "node:process";
import type { AnalyzeOptions, AnalyzeResult, LLMProvider } from "./provider.js";
import { bytesToDataUrl, extractJson } from "./provider.js";

export class ZAIProvider implements LLMProvider {
  readonly name = "zai";
  private zai: Awaited<ReturnType<typeof ZAI.create>> | null = null;

  private async getClient() {
    if (!this.zai) {
      // ZAI.create() reads ZAI_API_KEY from the environment when not in sandbox.
      this.zai = await ZAI.create();
    }
    return this.zai;
  }

  async analyze(opts: AnalyzeOptions): Promise<AnalyzeResult> {
    const client = await this.getClient();
    const started = Date.now();

    const schemaHint = JSON.stringify(opts.schema, null, 2);
    const jsonInstruction =
      `Return ONLY a JSON object that strictly conforms to this JSON Schema ` +
      `(do NOT include the schema itself, do NOT wrap in markdown fences, no commentary):\n\n${schemaHint}`;

    // Annotate image filenames so the LLM can reference them by name.
    let promptBase = opts.prompt;
    const imgs = opts.images ?? [];
    if (imgs.length > 0) {
      const nameList = imgs
        .map((img, i) => img.name || `image_${i + 1}`)
        .map((name, i) => `  [Uploaded image #${i + 1}: filename="${name}"]`)
        .join("\n");
      promptBase += `\n\n--- Uploaded images (use these filenames verbatim when emitting material.texture_image / normal_image / roughness_image) ---\n${nameList}`;
    }
    const userText = `${promptBase}\n\n---\n${jsonInstruction}`;

    // Vision vs text-only path.
    if (opts.images && opts.images.length > 0) {
      const content: Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      > = [{ type: "text", text: userText }];
      for (const img of opts.images) {
        content.push({
          type: "image_url",
          image_url: { url: bytesToDataUrl(img.bytes, img.mime) },
        });
      }
      const response = await client.chat.completions.createVision({
        model: "glm-4.5v",
        messages: [
          // ZAI uses 'assistant' role for the system prompt.
          { role: "assistant", content: opts.systemPrompt },
          { role: "user", content },
        ],
        thinking: { type: opts.thinking ? "enabled" : "disabled" },
      } as Parameters<typeof client.chat.completions.createVision>[0]);
      const raw = response.choices[0]?.message?.content ?? "";
      return {
        json: extractJson(raw),
        raw,
        provider: this.name,
        model: "zai-vision",
        latencyMs: Date.now() - started,
      };
    }

    const response = await client.chat.completions.create({
      messages: [
        { role: "assistant", content: opts.systemPrompt },
        { role: "user", content: userText },
      ],
      thinking: { type: opts.thinking ? "enabled" : "disabled" },
    });
    const raw = response.choices[0]?.message?.content ?? "";
    return {
      json: extractJson(raw),
      raw,
      provider: this.name,
      model: "zai-chat",
      latencyMs: Date.now() - started,
    };
  }
}
