// Wallermax H1 — minimal HTTP router

import { IncomingMessage, ServerResponse } from "node:http";
import { config } from "./config.js";
import { sendJson } from "./util.js";
import {
  getHealth,
  getPythonCheck,
  getConfig,
  listJobs,
  getJob,
  jobEvents,
  abortJob,
  getFile,
  postAnalyze,
  postPipeline,
  postPipelineSync,
  serveStatic,
} from "./handlers/index.js";

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => void | Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: Handler;
}

function makeRoute(method: string, pattern: string, handler: Handler): Route {
  const paramNames: string[] = [];
  // Tokenize the pattern: split by `/` and process each segment. This avoids
  // the regex-quantifier ambiguity of `*name` patterns.
  //
  // Two param flavors are supported inside a segment:
  //   :name   → matches a single segment (no slashes)
  //   *name   → matches the rest of the URL (including slashes), greedy.
  //
  // Example: `/api/files/:jobId/*name` becomes /^\/api\/files\/([^/]+)\/(.+)\/?$/.
  const segments = pattern.split("/").map((seg) => {
    if (seg.startsWith("*")) {
      const n = seg.slice(1);
      paramNames.push(n);
      return "(.+)";
    }
    if (seg.startsWith(":")) {
      const n = seg.slice(1);
      paramNames.push(n);
      return "([^/]+)";
    }
    // Escape regex metacharacters in literal segments.
    return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  const re = new RegExp("^" + segments.join("/") + "/?$");
  return { method, pattern: re, paramNames, handler };
}

const routes: Route[] = [
  makeRoute("GET", "/api/health", getHealth),
  makeRoute("GET", "/api/python-check", getPythonCheck),
  makeRoute("GET", "/api/config", getConfig),
  makeRoute("GET", "/api/jobs", listJobs),
  makeRoute("GET", "/api/jobs/:id", getJob),
  makeRoute("GET", "/api/jobs/:id/events", jobEvents),
  makeRoute("POST", "/api/jobs/:id/abort", abortJob),
  // Use `*name` so paths like /api/files/<jobId>/blender/render.mp4 work.
  makeRoute("GET", "/api/files/:jobId/*name", getFile),
  makeRoute("GET", "/api/download/:jobId/*name", getFile),
  makeRoute("POST", "/api/analyze", postAnalyze),
  makeRoute("POST", "/api/pipeline", postPipeline),
  makeRoute("POST", "/api/pipeline-sync", postPipelineSync),

  // Static assets under public/. /static/*path captures nested paths too.
  makeRoute("GET", "/static/*path", serveStatic),
  // Files under the project download/ directory.
  makeRoute("GET", "/download/*path", (req, res, p) => {
    p.root = "download";
    return serveStatic(req, res, p);
  }),

  // Root index
  makeRoute("GET", "/", (_req, res) => {
    serveStatic({} as IncomingMessage, res, { path: "index.html" });
  }),
];

export async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Basic auth (if configured).
  if (config.basicAuth) {
    const auth = req.headers.authorization;
    if (!auth || !checkBasicAuth(auth, config.basicAuth.user, config.basicAuth.pass)) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="wallermax"' });
      res.end("Auth required");
      return;
    }
  }

  const url = (req.url || "/").split("?")[0]!;
  const method = (req.method || "GET").toUpperCase();

  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.pattern.exec(url);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.paramNames.forEach((n, i) => {
      params[n] = decodeURIComponent(m[i + 1]!);
    });
    try {
      await r.handler(req, res, params);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        sendJson(res, 500, { error: msg });
      } else {
        res.end();
      }
    }
    return;
  }

  sendJson(res, 404, { error: "Not found", path: url });
}

function checkBasicAuth(header: string, user: string, pass: string): boolean {
  const parts = header.split(" ");
  if (parts.length !== 2 || parts[0] !== "Basic") return false;
  try {
    const decoded = Buffer.from(parts[1]!, "base64").toString("utf-8");
    const idx = decoded.indexOf(":");
    if (idx < 0) return false;
    const u = decoded.slice(0, idx);
    const p = decoded.slice(idx + 1);
    return u === user && p === pass;
  } catch {
    return false;
  }
}
