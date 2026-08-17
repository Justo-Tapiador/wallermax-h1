// Wallermax H1 — server configuration & env loading

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import type { ServerConfig } from "./types.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
export const PROJECT_ROOT = resolve(__dirname, "..", "..");
export const SCHEMAS_DIR = join(PROJECT_ROOT, "schemas");
export const PUBLIC_DIR = join(PROJECT_ROOT, "public");
export const PYTHON_DIR = join(PROJECT_ROOT, "python");
export const DOWNLOAD_DIR = join(PROJECT_ROOT, "download");

function envInt(key: string, def: number): number {
  const v = process.env[key];
  if (!v) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function envBool(key: string, def: boolean): boolean {
  const v = (process.env[key] ?? "").toLowerCase();
  if (v === "") return def;
  return v === "1" || v === "true" || v === "yes";
}

function loadEnvFile(): void {
  const envPath = join(PROJECT_ROOT, ".env");
  if (!existsSync(envPath)) return;
  const txt = readFileSync(envPath, "utf-8");
  for (const rawLine of txt.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

loadEnvFile();

export function loadConfig(): ServerConfig {
  const provider = (process.env.LLM_PROVIDER ?? "mock") as
    | "openai"
    | "zai"
    | "mock";

  const user = process.env.WALLERMAX_USER ?? "";
  const pass = process.env.WALLERMAX_PASS ?? "";

  return {
    port: envInt("PORT", 4317),
    host: process.env.HOST ?? "127.0.0.1",
    workdir: resolve(PROJECT_ROOT, process.env.WALLERMAX_WORKDIR ?? "./.wallermax"),
    blenderBin: process.env.BLENDER_BIN ?? "blender",
    skipBlender: envBool("SKIP_BLENDER", false),
    defaultRender: {
      // Defaults tuned for fast preview renders. Users can bump these up
      // in the web UI or via .env once they confirm the pipeline works.
      width: envInt("DEFAULT_RENDER_WIDTH", 640),
      height: envInt("DEFAULT_RENDER_HEIGHT", 360),
      fps: envInt("DEFAULT_RENDER_FPS", 24),
      duration: envInt("DEFAULT_RENDER_DURATION", 2),
    },
    maxUploadBytes: envInt("MAX_UPLOAD_BYTES", 20 * 1024 * 1024),
    provider,
    basicAuth: user && pass ? { user, pass } : undefined,
  };
}

// Singleton configuration loaded once at startup.
export const config: ServerConfig = loadConfig();

