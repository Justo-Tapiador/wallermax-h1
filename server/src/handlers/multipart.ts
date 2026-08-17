// Wallermax H1 — multipart form parser using formidable
//
// We use formidable (lightweight, no Express dependency) to parse
// multipart/form-data uploads. Returns typed fields and saved files.

import formidable from "formidable";
import { ensureDir } from "../util.js";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";

export interface ParsedFile {
  name: string;
  path: string;
  mime: string;
  size: number;
}

export interface ParsedForm {
  fields: Record<string, string>;
  files: Record<string, ParsedFile>;
}

export async function parseMultipart(
  req: IncomingMessage,
  uploadDir: string,
  maxBytes: number,
): Promise<ParsedForm> {
  await ensureDir(uploadDir);

  const form = formidable({
    uploadDir,
    keepExtensions: true,
    maxFileSize: maxBytes,
    maxTotalFileSize: maxBytes * 4,
    multiples: false,
    filename: (origName: string) => {
      // Sanitize the original filename and prepend a timestamp to avoid collisions.
      const safe = (origName || "upload.bin")
        .replace(/[^A-Za-z0-9._-]/g, "_")
        .slice(0, 64);
      return `${Date.now()}-${safe}`;
    },
  });

  return new Promise<ParsedForm>((resolvePromise, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) {
        reject(err);
        return;
      }
      const flatFields: Record<string, string> = {};
      for (const [k, v] of Object.entries(fields)) {
        const val = Array.isArray(v) ? v[0] : v;
        if (typeof val === "string") flatFields[k] = val;
      }
      const flatFiles: Record<string, ParsedFile> = {};
      for (const [k, v] of Object.entries(files)) {
        const f = Array.isArray(v) ? v[0] : v;
        if (!f) continue;
        flatFiles[k] = {
          name: f.originalFilename || "upload.bin",
          path: f.filepath,
          mime: f.mimetype || "application/octet-stream",
          size: f.size,
        };
      }
      resolvePromise({ fields: flatFields, files: flatFiles });
    });
  });
}

export { join };
