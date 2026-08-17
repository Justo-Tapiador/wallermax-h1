// Wallermax H1 — schema loader

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEMAS_DIR } from "../config.js";

const cache = new Map<string, object>();

export function loadSchema(name: "world_model" | "reconstruction" | "final_image"): object {
  if (cache.has(name)) return cache.get(name)!;
  const path = join(SCHEMAS_DIR, `${name}.schema.json`);
  const obj = JSON.parse(readFileSync(path, "utf-8"));
  cache.set(name, obj);
  return obj;
}
