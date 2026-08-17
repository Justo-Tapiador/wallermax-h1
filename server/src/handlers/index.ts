// Wallermax H1 — HTTP route handlers

import { ServerResponse, IncomingMessage } from "node:http";
import { createReadStream, statSync, existsSync } from "node:fs";
import { extname, basename, join, resolve } from "node:path";
import { config, PUBLIC_DIR, DOWNLOAD_DIR } from "../config.js";
import { jobStore } from "../jobs.js";
import { runPipeline } from "../pipeline.js";
import { analyzeFinalImage } from "../analyzers/finalImage.js";
import { probeAllPythons } from "../renderer.js";
import { parseMultipart } from "./multipart.js";
import { mimeFromExt, readBodyAsString, safeJoin, sendJson } from "../util.js";
import type { PipelineRequest, JobProgress } from "../types.js";

// ── GET /api/health ────────────────────────────────────────────────────
export function getHealth(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, {
    ok: true,
    name: "wallermax-h1",
    version: "1.0.0",
    provider: config.provider,
    blenderBin: config.blenderBin,
    skipBlender: config.skipBlender,
    workdir: config.workdir,
    defaults: config.defaultRender,
  });
}

// ── GET /api/python-check ────────────────────────────────────────────────
// Returns diagnostic info about which Python interpreters the server can
// find on PATH, their full paths, and whether each has Pillow / ffmpeg.
// Useful when the fallback renderer reports a missing-Pillow error and
// the user wants to understand which Python the server is actually using.
export async function getPythonCheck(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const probes = await probeAllPythons();
    const recommended = probes.find((p) => p.runnable && p.hasPillow) || probes.find((p) => p.runnable);
    sendJson(res, 200, {
      platform: process.platform,
      pythonBinEnv: process.env.PYTHON_BIN || null,
      candidatesTried: probes.map((p) => p.bin),
      recommended: recommended
        ? {
            bin: recommended.bin,
            executable: recommended.executable,
            version: recommended.version,
            hasPillow: recommended.hasPillow,
            hasFfmpeg: recommended.hasFfmpeg,
          }
        : null,
      probes,
      fixHint:
        "If your recommended Python has hasPillow=false but you ran 'pip install Pillow', " +
        "you installed it into a DIFFERENT Python than the one the server uses. " +
        "Set PYTHON_BIN in .env to the absolute path of the Python where you installed Pillow, " +
        "then restart the server.",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: msg });
  }
}

// ── GET /api/config ────────────────────────────────────────────────────
export function getConfig(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, {
    provider: config.provider,
    blenderBin: config.blenderBin,
    skipBlender: config.skipBlender,
    defaultRender: config.defaultRender,
    maxUploadBytes: config.maxUploadBytes,
  });
}

// ── GET /api/jobs ─────────────────────────────────────────────────────
export function listJobs(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, jobStore.list());
}

// ── GET /api/jobs/:id ─────────────────────────────────────────────────
export function getJob(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): void {
  const job = jobStore.get(params.id!);
  if (!job) {
    sendJson(res, 404, { error: "Job not found" });
    return;
  }
  sendJson(res, 200, job);
}

// ── GET /api/jobs/:id/events (SSE) ─────────────────────────────────────
export function jobEvents(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): void {
  const jobId = params.id!;
  const job = jobStore.get(jobId);
  if (!job) {
    sendJson(res, 404, { error: "Job not found" });
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ jobId })}\n\n`);
  res.write(`event: progress\ndata: ${JSON.stringify(job)}\n\n`);
  const unsub = jobStore.subscribe(jobId, (p: JobProgress) => {
    res.write(`event: progress\ndata: ${JSON.stringify(p)}\n\n`);
    if (p.status === "done" || p.status === "error") {
      res.write(`event: close\ndata: ${JSON.stringify({ status: p.status })}\n\n`);
      res.end();
    }
  });
  req.on("close", () => {
    unsub();
  });
}

// ── POST /api/jobs/:id/abort ──────────────────────────────────────────
export async function abortJob(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
  const jobId = params.id!;
  const job = jobStore.get(jobId);
  if (!job) {
    sendJson(res, 404, { error: "Job not found" });
    return;
  }
  if (job.status === "done" || job.status === "error") {
    sendJson(res, 409, { error: "Job is already finished", status: job.status });
    return;
  }
  const ok = jobStore.abort(jobId);
  if (ok) {
    sendJson(res, 200, { ok: true, jobId, message: "Abort signal sent" });
  } else {
    sendJson(res, 409, { error: "No running process found for this job" });
  }
}

// ── GET /api/files/:jobId/* (serves nested paths like blender/render.mp4) ─
export function getFile(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): void {
  const jobId = params.jobId!;
  // `name` may contain slashes (e.g. "blender/render.mp4"). The route
  // pattern captures everything after /api/files/:jobId/ as `name`.
  const name = params.name!;
  if (!name || name.includes("..")) {
    sendJson(res, 400, { error: "Invalid file path" });
    return;
  }
  let relativePath: string;
  try {
    relativePath = safeJoin(config.workdir, jobId, name);
  } catch {
    sendJson(res, 400, { error: "Invalid file path" });
    return;
  }
  if (!existsSync(relativePath)) {
    sendJson(res, 404, { error: "File not found", path: relativePath });
    return;
  }
  const stat = statSync(relativePath);
  if (stat.isDirectory()) {
    sendJson(res, 403, { error: "Path is a directory" });
    return;
  }
  // For video/audio files, support HTTP range requests so the browser can
  // stream and seek. Without this, the <video> element won't load large
  // MP4s because the server sends the whole file in one shot.
  const ext = extname(relativePath).toLowerCase();
  const isStreamable = ext === ".mp4" || ext === ".webm" || ext === ".ogg" || ext === ".mov" || ext === ".mkv" || ext === ".mp3" || ext === ".wav";
  if (isStreamable) {
    serveMediaFile(req, res, relativePath, stat);
    return;
  }
  // For other files, send the whole thing with a download disposition.
  res.writeHead(200, {
    "Content-Type": mimeFromExt(ext),
    "Content-Length": stat.size,
    "Content-Disposition": `attachment; filename="${basename(relativePath)}"`,
  });
  createReadStream(relativePath).pipe(res);
}

/**
 * Serve a media file (MP4, etc.) with HTTP Range Request support.
 *
 * Browsers need Range requests to:
 *   - Stream large videos without downloading them entirely first.
 *   - Seek to arbitrary positions in the video.
 *   - Display a video thumbnail / poster frame.
 *
 * Without Range support, the <video> element may refuse to load the file
 * (especially on Chrome, which sends `Range: bytes=0-` on every media load).
 */
function serveMediaFile(req: IncomingMessage, res: ServerResponse, filePath: string, stat: ReturnType<typeof statSync>): void {
  const fileSize = Number(stat?.size ?? 0);
  const range = req.headers.range;
  const contentType = mimeFromExt(extname(filePath));

  if (range) {
    // Parse "bytes=start-end" or "bytes=start-"
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match) {
      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
      const chunkSize = end - start + 1;
      if (start >= fileSize || end >= fileSize || start > end) {
        res.writeHead(416, {
          "Content-Range": `bytes */${fileSize}`,
          "Content-Type": contentType,
        });
        res.end();
        return;
      }
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": contentType,
        // IMPORTANT: no Content-Disposition: attachment — that would force
        // the browser to download the file instead of playing it inline.
      });
      createReadStream(filePath, { start, end }).pipe(res);
      return;
    }
  }
  // No Range header — send the whole file.
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": fileSize,
    "Accept-Ranges": "bytes",
    // No Content-Disposition: attachment → browser plays it inline.
  });
  createReadStream(filePath).pipe(res);
}

// ── GET /api/download/:jobId/:name (alias that mirrors /api/files) ─────
export const downloadFile = getFile;

// ── POST /api/analyze (final-image only) ──────────────────────────────
export async function postAnalyze(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const form = await parseMultipart(req, join(config.workdir, "_uploads"), config.maxUploadBytes);
  const file = form.files.image || form.files.finalImage;
  if (!file) {
    sendJson(res, 400, { error: "Missing 'image' file in form data" });
    return;
  }
  const provider = (form.fields.provider as "openai" | "zai" | "mock") || config.provider;
  const model = form.fields.model || undefined;
  try {
    const result = await analyzeFinalImage(file.path, provider, model);
    sendJson(res, 200, result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: msg });
  }
}

// ── POST /api/pipeline (full pipeline) ────────────────────────────────
export async function postPipeline(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const form = await parseMultipart(req, join(config.workdir, "_uploads"), config.maxUploadBytes);

  const prompt = form.fields.prompt;
  if (!prompt) {
    sendJson(res, 400, { error: "Missing 'prompt' field" });
    return;
  }

  const pReq: PipelineRequest = {
    prompt,
    systemPromptExtra: form.fields.systemPromptExtra,
    provider: ((form.fields.provider as "openai" | "zai" | "mock") || config.provider),
    model: form.fields.model || undefined,
    referenceImage: form.files.referenceImage
      ? {
          name: form.files.referenceImage.name,
          path: form.files.referenceImage.path,
          mime: form.files.referenceImage.mime,
        }
      : undefined,
    finalImage: form.files.finalImage
      ? {
          name: form.files.finalImage.name,
          path: form.files.finalImage.path,
          mime: form.files.finalImage.mime,
        }
      : undefined,
    render: {
      width: Number(form.fields.width) || config.defaultRender.width,
      height: Number(form.fields.height) || config.defaultRender.height,
      fps: Number(form.fields.fps) || config.defaultRender.fps,
      duration: Number(form.fields.duration) || config.defaultRender.duration,
      engine: (form.fields.engine as "BLENDER_EEVEE_NEXT" | "CYCLES") || "BLENDER_EEVEE_NEXT",
      samples: Number(form.fields.samples) || 16,
    },
    skipBlender:
      form.fields.skipBlender === "1" ||
      form.fields.skipBlender === "true" ||
      config.skipBlender,
    depthBackend: "none",
    depthModel: form.fields.depthModel,
  };

  const job = jobStore.create();
  sendJson(res, 202, { jobId: job.jobId, status: job.status });

  // Fire and forget — the client polls /events.
  runPipeline(config.workdir, config.blenderBin, pReq.skipBlender ?? false, pReq, job.jobId).catch(
    (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      jobStore.update(job.jobId, { status: "error", error: msg, stage: "Error" });
    },
  );
}

// ── POST /api/pipeline-sync (synchronous; awaits result) ───────────────
export async function postPipelineSync(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBodyAsString(req, 256 * 1024);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body" });
    return;
  }
  const prompt = parsed.prompt;
  if (typeof prompt !== "string" || !prompt.trim()) {
    sendJson(res, 400, { error: "Missing 'prompt' string field" });
    return;
  }
  const pReq: PipelineRequest = {
    prompt,
    provider: ((parsed.provider as "openai" | "zai" | "mock") || config.provider),
    model: parsed.model as string | undefined,
    render: {
      width: (parsed.width as number) || config.defaultRender.width,
      height: (parsed.height as number) || config.defaultRender.height,
      fps: (parsed.fps as number) || config.defaultRender.fps,
      duration: (parsed.duration as number) || config.defaultRender.duration,
      engine: (parsed.engine as "BLENDER_EEVEE_NEXT" | "CYCLES") || "BLENDER_EEVEE_NEXT",
      samples: (parsed.samples as number) || 16,
    },
    skipBlender: parsed.skipBlender === true || config.skipBlender,
  };
  const job = jobStore.create();
  sendJson(res, 202, { jobId: job.jobId, status: job.status });
  runPipeline(config.workdir, config.blenderBin, pReq.skipBlender ?? false, pReq, job.jobId).catch(
    (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      jobStore.update(job.jobId, { status: "error", error: msg, stage: "Error" });
    },
  );
}

// ── Static file serving (public/ and download/) ────────────────────────
export function serveStatic(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): void {
  // Two roots are exposed: /static/* -> public/, /download/* -> download/
  const root = params.root === "download" ? DOWNLOAD_DIR : PUBLIC_DIR;
  const urlPath = decodeURIComponent(params.path || "").replace(/\.\./g, "");
  let filePath: string;
  try {
    filePath = resolve(safeJoin(root, urlPath.replace(/^\/+/, "")));
  } catch {
    // Path traversal attempt (or empty path). Return 404 instead of 500
    // so the browser sees a clean error.
    sendJson(res, 404, { error: "Not found" });
    return;
  }
  if (!existsSync(filePath)) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }
  const stat = statSync(filePath);
  if (stat.isDirectory()) {
    const idx = join(filePath, "index.html");
    if (existsSync(idx)) {
      serveFile(res, idx);
      return;
    }
    sendJson(res, 403, { error: "Directory listing forbidden" });
    return;
  }
  serveFile(res, filePath);
}

function serveFile(res: ServerResponse, filePath: string): void {
  const stat = statSync(filePath);
  res.writeHead(200, {
    "Content-Type": mimeFromExt(extname(filePath)),
    "Content-Length": stat.size,
  });
  createReadStream(filePath).pipe(res);
}
