// Wallermax H1 — Texture Atlas handler
//
// Provides endpoints to list and serve predefined texture atlases from
// the assets/texture_atlas/ directory.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { sendJson } from "../util.js";

export interface AtlasInfo {
  name: string;
  filename: string;
  description: string;
  width: number;
  height: number;
  grid_cols: number;
  grid_rows: number;
  tile_size: number;
  tile_count: number;
}

export interface AtlasIndex {
  version: string;
  description: string;
  atlases: AtlasInfo[];
}

let _cachedIndex: AtlasIndex | null = null;

/**
 * Get the project root directory.
 * Uses process.cwd() — the server should be started from the project root.
 */
function getProjectRoot(): string {
  return process.cwd();
}

/**
 * Get the path to the assets directory.
 */
function getAssetsDir(): string {
  return join(getProjectRoot(), "assets", "texture_atlas");
}

/**
 * Load and cache the atlas index from assets/texture_atlas_index.json.
 */
export function getAtlasIndex(): AtlasIndex {
  if (_cachedIndex) return _cachedIndex;
  const indexPath = join(getProjectRoot(), "assets", "texture_atlas_index.json");
  try {
    const raw = readFileSync(indexPath, "utf-8");
    _cachedIndex = JSON.parse(raw) as AtlasIndex;
    console.log(`[atlases] loaded index with ${_cachedIndex.atlases.length} atlases`);
  } catch (err) {
    console.warn(`[atlases] could not load index from ${indexPath}: ${err}`);
    _cachedIndex = { version: "1.0", description: "", atlases: [] };
  }
  return _cachedIndex;
}

/**
 * GET /api/atlases — list all available texture atlases.
 */
export async function listAtlases(res: ServerResponse): Promise<void> {
  const index = getAtlasIndex();
  sendJson(res, 200, index);
}

/**
 * GET /api/atlases/:name/image — serve the PNG file for a specific atlas.
 */
export async function getAtlasImage(
  res: ServerResponse,
  name: string,
): Promise<void> {
  const index = getAtlasIndex();
  const atlas = index.atlases.find((a) => a.name === name);
  if (!atlas) {
    sendJson(res, 404, { error: `Atlas '${name}' not found` });
    return;
  }
  const imgPath = join(getAssetsDir(), atlas.filename);
  if (!existsSync(imgPath)) {
    sendJson(res, 404, { error: `Atlas file '${atlas.filename}' not found on disk` });
    return;
  }
  try {
    const data = readFileSync(imgPath);
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Content-Length": data.length,
      "Cache-Control": "public, max-age=3600",
    });
    res.end(data);
  } catch (err) {
    sendJson(res, 500, { error: `Failed to read atlas file: ${err}` });
  }
}

/**
 * Find an atlas by name. Returns undefined if not found.
 */
export function findAtlas(name: string): AtlasInfo | undefined {
  return getAtlasIndex().atlases.find((a) => a.name === name);
}

/**
 * Get the absolute path to an atlas PNG file.
 */
export function getAtlasPath(name: string): string | null {
  const atlas = findAtlas(name);
  if (!atlas) return null;
  return join(getAssetsDir(), atlas.filename);
}
