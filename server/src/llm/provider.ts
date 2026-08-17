// Wallermax H1 — LLM provider interface and helpers

export interface AnalyzeOptions {
  prompt: string;
  systemPrompt: string;
  schema: object;
  /** Images to send to the model. Each entry is raw bytes. */
  images?: { bytes: Buffer; mime: string; name?: string }[];
  model?: string;
  /** Hint for the model to enable extended reasoning (provider-specific). */
  thinking?: boolean;
}

export interface AnalyzeResult {
  /** The parsed JSON object returned by the model. */
  json: unknown;
  /** The raw text returned by the model, for debugging. */
  raw: string;
  /** Provider that produced the result. */
  provider: string;
  /** Model identifier that was actually used. */
  model: string;
  /** Approximate latency in milliseconds. */
  latencyMs: number;
}

export interface LLMProvider {
  readonly name: string;
  analyze(options: AnalyzeOptions): Promise<AnalyzeResult>;
}

// ── JSON extraction helpers ───────────────────────────────────────────
/**
 * Extracts a JSON object from a model's free-form text response.
 * Handles: pure JSON, fenced JSON, leading/trailing prose, multiple JSON blocks.
 * Throws on failure.
 */
export function extractJson(text: string): unknown {
  if (!text || !text.trim()) {
    throw new Error("LLM returned empty content");
  }
  const trimmed = text.trim();

  // Try direct parse first.
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }

  // Strip ```json ... ``` fences.
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch && fenceMatch[1]) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      /* fall through */
    }
  }

  // Find the first balanced { ... } or [ ... ] block.
  const start = trimmed.search(/[[{]/);
  if (start >= 0) {
    const openCh = trimmed[start];
    const closeCh = openCh === "{" ? "}" : "]";
    let depth = 0;
    let inStr = false;
    let escape = false;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inStr = !inStr;
      if (inStr) continue;
      if (ch === openCh) depth++;
      else if (ch === closeCh) {
        depth--;
        if (depth === 0) {
          const slice = trimmed.slice(start, i + 1);
          return JSON.parse(slice);
        }
      }
    }
  }

  throw new Error(`Could not extract JSON from LLM response: ${trimmed.slice(0, 200)}…`);
}

export function bytesToDataUrl(bytes: Buffer, mime: string): string {
  return `data:${mime};base64,${bytes.toString("base64")}`;
}
