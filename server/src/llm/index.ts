// Wallermax H1 — LLM provider factory

import process from "node:process";
import type { LLMProvider } from "./provider.js";
import { MockProvider } from "./mock.js";
import { OpenAIProvider } from "./openai.js";
import { ZAIProvider } from "./zai.js";

export type ProviderName = "openai" | "zai" | "mock";

const cache = new Map<ProviderName, LLMProvider>();

export function getProvider(name?: ProviderName): LLMProvider {
  const want: ProviderName =
    (name as ProviderName) ||
    (process.env.LLM_PROVIDER as ProviderName) ||
    "mock";

  if (cache.has(want)) return cache.get(want)!;

  let provider: LLMProvider;
  switch (want) {
    case "openai":
      provider = new OpenAIProvider();
      break;
    case "zai":
      provider = new ZAIProvider();
      break;
    case "mock":
    default:
      provider = new MockProvider();
  }
  cache.set(want, provider);
  return provider;
}

export { type LLMProvider, type AnalyzeOptions, type AnalyzeResult } from "./provider.js";
export {
  SCENE_COMPILER_SYSTEM_PROMPT,
  RECONSTRUCTION_SYSTEM_PROMPT,
  FINAL_IMAGE_SYSTEM_PROMPT,
} from "./prompts.js";
