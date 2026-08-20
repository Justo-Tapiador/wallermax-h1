// Wallermax H1 — DeepSeek provider
//
// DeepSeek uses an OpenAI-compatible API, but the 'deepseek-chat' model
// is TEXT-ONLY — it does not accept image_url content in messages.
// When images are provided, we skip them and send only the text prompt.
// This means the reconstruction and final-image analyzers won't work
// with DeepSeek, but the scene compiler (the most important call) will.

import process from "node:process";
import type { AnalyzeOptions, AnalyzeResult, LLMProvider } from "./provider.js";
import { extractJson } from "./provider.js";
import OpenAI from "openai";

export class DeepSeekProvider implements LLMProvider {
  readonly name = "deepseek";
  private client: OpenAI;

  constructor() {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error(
        "DEEPSEEK_API_KEY is not set. Either set it in .env or switch LLM_PROVIDER to 'mock' or 'openai'.",
      );
    }
    this.client = new OpenAI({
      apiKey,
      baseURL: "https://api.deepseek.com",
    });
  }

  async analyze(opts: AnalyzeOptions): Promise<AnalyzeResult> {
    const model = opts.model || process.env.DEEPSEEK_MODEL || "deepseek-chat";
    const started = Date.now();

    // DeepSeek 'deepseek-chat' is TEXT-ONLY — it does not accept image_url
    // content. If images are provided, we skip them and send only the text
    // prompt. This means image reconstruction/final-image analysis won't
    // work with DeepSeek, but the scene compiler (which is the call that
    // generates the World Model from the prompt) will work fine.
    const hasImages = opts.images && opts.images.length > 0;
    if (hasImages) {
      console.warn("[deepseek] Images were provided but will be SKIPPED — " +
        "deepseek-chat is a text-only model. Use 'openai' provider for " +
        "image-based reconstruction and final-image analysis.");
    }

    const schemaHint = JSON.stringify(opts.schema, null, 2);
    const jsonInstruction =
      `Return ONLY a JSON object that strictly conforms to this JSON Schema ` +
      `(do NOT include the schema itself, do NOT wrap in markdown fences, no commentary):\n\n${schemaHint}`;

    // Send only text content (no images).
    const completion = await this.client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: opts.systemPrompt },
        { role: "system", content: jsonInstruction },
        { role: "user", content: opts.prompt },
      ],
      temperature: 0.2,
      response_format: { type: "json_object" },
    });

    const raw = completion.choices[0]?.message?.content ?? "";
    return {
      json: extractJson(raw),
      raw,
      provider: this.name,
      model,
      latencyMs: Date.now() - started,
    };
  }
}