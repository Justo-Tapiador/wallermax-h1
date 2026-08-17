// Wallermax H1 — small utilities

import { mkdir } from "node:fs/promises";
import { resolve as pathResolve, relative as pathRelative, isAbsolute } from "node:path";

export async function ensureDir(p: string): Promise<void> {
  await mkdir(p, { recursive: true });
}

/**
 * Joins `base` with `segments` and verifies the result is still inside `base`.
 * Throws `Error("Path traversal detected")` otherwise.
 *
 * Cross-platform: works on both POSIX and Windows because it uses
 * `path.relative` instead of brittle string-prefix checks. A naive
 * `resolved.startsWith(base + "/")` check fails on Windows (where paths
 * use `\` as separator) and on edge cases where `base` ends with a slash.
 *
 * `path.relative(base, resolved)` returns:
 *   - "" if `resolved === base`
 *   - "foo/bar" if `resolved` is inside `base`
 *   - "../something" if `resolved` is outside `base`
 *   - An absolute path on Windows if `resolved` is on a different drive.
 */
export function safeJoin(base: string, ...segments: string[]): string {
  const resolved = pathResolve(base, ...segments);
  const baseResolved = pathResolve(base);
  const rel = pathRelative(baseResolved, resolved);
  // "" or a relative path not starting with ".." means we are inside base.
  // On Windows, `path.relative` across drives returns an absolute path,
  // which we must reject.
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return resolved;
  }
  throw new Error("Path traversal detected");
}

export function mimeFromExt(ext: string): string {
  const e = ext.toLowerCase();
  switch (e) {
    case ".html":
    case ".htm":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    case ".mp4":
      return "video/mp4";
    case ".blend":
      return "application/x-blender";
    case ".md":
      return "text/markdown; charset=utf-8";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

export function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

export function readBodyAsString(req: import("node:http").IncomingMessage, maxBytes = 4 * 1024 * 1024): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
