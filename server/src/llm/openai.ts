// Wallermax H1 — OpenAI provider
//
// Uses the OpenAI Chat Completions API with JSON-mode response_format.
// The original World Compiler v2/v3 used the Responses API with json_schema
// strict output, but the Chat Completions API + JSON mode is more portable
// across OpenAI-compatible endpoints (Together AI, Groq, local Llama, …).

import OpenAI from "openai";
import process from "node:process";
import type { AnalyzeOptions, AnalyzeResult, LLMProvider } from "./provider.js";
import { extractJson, bytesToDataUrl } from "./provider.js";

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  private client: OpenAI;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY is not set. Either set it in .env or switch LLM_PROVIDER to 'mock' or 'zai'.",
      );
    }
    this.client = new OpenAI({ apiKey });
  }

  async analyze(opts: AnalyzeOptions): Promise<AnalyzeResult> {
    const model = opts.model || process.env.OPENAI_MODEL || "gpt-4o-mini";
    const started = Date.now();

    const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
    userContent.push({ type: "text", text: opts.prompt });
    for (const img of opts.images ?? []) {
      userContent.push({
        type: "image_url",
        image_url: { url: bytesToDataUrl(img.bytes, img.mime) },
      });
    }

    const schemaHint = JSON.stringify(opts.schema, null, 2);
    const jsonInstruction =
      `Return ONLY a JSON object that strictly conforms to this JSON Schema ` +
      `(do NOT include the schema itself, do NOT wrap in markdown fences, no commentary):\n\n${schemaHint}`;

    const completion = await this.client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: opts.systemPrompt },
        { role: "system", content: jsonInstruction },
        { role: "user", content: userContent },
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
