// Wallermax H1 — HTTP server entry point

import { createServer } from "node:http";
import { config } from "./config.js";
import { route } from "./router.js";
import { ensureDir } from "./util.js";
import { DOWNLOAD_DIR } from "./config.js";

async function main(): Promise<void> {
  await ensureDir(config.workdir);
  await ensureDir(DOWNLOAD_DIR);

  const server = createServer((req, res) => {
    // CORS for local dev convenience (the UI is served from the same origin,
    // but we still want to allow CLI clients to talk to the API).
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    route(req, res).catch((err) => {
      console.error("[route] uncaught", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal error" }));
      }
    });
  });

  server.listen(config.port, config.host, () => {
    const banner = [
      "",
      "╔════════════════════════════════════════════════════════════╗",
      "║            Wallermax H1 — procedural 3D scene compiler      ║",
      "╠════════════════════════════════════════════════════════════╣",
      `║  Web UI:    http://${config.host}:${config.port}/`,
      `║  Provider:  ${config.provider.padEnd(46)}║`,
      `║  Blender:   ${(config.skipBlender ? "skipped" : config.blenderBin).padEnd(46)}║`,
      `║  Workdir:   ${config.workdir.padEnd(46)}║`,
      "╚════════════════════════════════════════════════════════════╝",
      "",
    ].join("\n");
    console.log(banner);
  });

  // Graceful shutdown.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      console.log(`\n[wallermax] received ${sig}, shutting down…`);
      server.close(() => process.exit(0));
    });
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
