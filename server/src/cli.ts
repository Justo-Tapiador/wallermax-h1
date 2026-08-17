// Wallermax H1 — CLI entry point
//
// Usage:
//   npm run cli -- --prompt prompts/example.txt
//   npm run cli -- --prompt prompts/example.txt --image ref.png --final final.png
//   npm run cli -- --prompt prompts/example.txt --skip-blender
//
// This is the TypeScript equivalent of v2/v3's `main.py` and `reconstruction_pipeline.py`.
// It runs the same pipeline as the web server, just without the HTTP layer.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { config, PROJECT_ROOT } from "./config.js";
import { analyzeScene } from "./analyzers/scene.js";
import { buildReport } from "./cli/report.js";

interface CliArgs {
  prompt: string;
  image?: string;
  finalImage?: string;
  provider?: "openai" | "zai" | "mock";
  model?: string;
  outDir: string;
  skipBlender: boolean;
  width: number;
  height: number;
  fps: number;
  duration: number;
  engine: "BLENDER_EEVEE_NEXT" | "CYCLES";
  samples: number;
}

function parseArgs(argv: string[]): CliArgs {
  const out: Partial<CliArgs> = {
    outDir: join(PROJECT_ROOT, "output"),
    skipBlender: config.skipBlender,
    width: config.defaultRender.width,
    height: config.defaultRender.height,
    fps: config.defaultRender.fps,
    duration: config.defaultRender.duration,
    engine: "BLENDER_EEVEE_NEXT",
    samples: 64,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => argv[++i];
    switch (a) {
      case "--prompt": out.prompt = next(); break;
      case "--image": out.image = next(); break;
      case "--final":
      case "--final-image": out.finalImage = next(); break;
      case "--provider": out.provider = next() as "openai" | "zai" | "mock"; break;
      case "--model": out.model = next(); break;
      case "--out": out.outDir = next()!; break;
      case "--skip-blender": out.skipBlender = true; break;
      case "--width": out.width = Number(next()); break;
      case "--height": out.height = Number(next()); break;
      case "--fps": out.fps = Number(next()); break;
      case "--duration": out.duration = Number(next()); break;
      case "--engine": out.engine = next() as "BLENDER_EEVEE_NEXT" | "CYCLES"; break;
      case "--samples": out.samples = Number(next()); break;
      case "--help":
      case "-h":
        console.log(USAGE);
        process.exit(0);
    }
  }
  if (!out.prompt) {
    console.error("Missing --prompt");
    console.log(USAGE);
    process.exit(2);
  }
  return out as CliArgs;
}

const USAGE = `Wallermax H1 — CLI

Usage:
  tsx server/src/cli.ts --prompt <file> [--image <file>] [--final <file>]
                         [--provider mock|openai|zai] [--model <name>]
                         [--skip-blender] [--out <dir>]
                         [--width 1280] [--height 720] [--fps 30] [--duration 10]
                         [--engine BLENDER_EEVEE_NEXT|CYCLES] [--samples 64]

Examples:
  # Mock-only (no API key needed):
  tsx server/src/cli.ts --prompt prompts/example.txt --provider mock --skip-blender

  # Full pipeline with OpenAI:
  tsx server/src/cli.ts --prompt prompts/example.txt --provider openai \\
    --image reference.png --final target.jpg
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const promptText = await readFile(args.prompt, "utf-8");

  const req = {
    prompt: promptText,
    provider: args.provider || config.provider,
    model: args.model,
    referenceImage: args.image ? { name: args.image, path: resolve(args.image), mime: "" } : undefined,
    finalImage: args.finalImage ? { name: args.finalImage, path: resolve(args.finalImage), mime: "" } : undefined,
    render: {
      width: args.width,
      height: args.height,
      fps: args.fps,
      duration: args.duration,
      engine: args.engine,
      samples: args.samples,
    },
    skipBlender: args.skipBlender,
  };

  await mkdir(args.outDir, { recursive: true });

  console.log(`[wallermax] provider=${req.provider} skipBlender=${req.skipBlender}`);
  console.log(`[wallermax] analyzing…`);
  const bundle = await analyzeScene(req);

  await writeFile(join(args.outDir, "world.json"), JSON.stringify(bundle.world, null, 2), "utf-8");
  if (bundle.reconstruction) {
    await writeFile(join(args.outDir, "reconstruction.json"), JSON.stringify(bundle.reconstruction, null, 2), "utf-8");
  }
  if (bundle.finalImageAnalysis) {
    await writeFile(join(args.outDir, "final_image.json"), JSON.stringify(bundle.finalImageAnalysis, null, 2), "utf-8");
  }
  await writeFile(join(args.outDir, "scene_report.md"), buildReport(req, bundle), "utf-8");

  console.log(`[wallermax] world.json   -> ${join(args.outDir, "world.json")}`);
  console.log(`[wallermax] scene_report.md -> ${join(args.outDir, "scene_report.md")}`);

  if (args.skipBlender) {
    console.log(`[wallermax] --skip-blender set, producing World Model only.`);
    return;
  }

  // Render. Uses the same renderer module as the web server: tries Blender
  // first, automatically falls back to the preview renderer if Blender is
  // not installed.
  const { render: renderScene } = await import("./renderer.js");
  const worldJsonPath = resolve(join(args.outDir, "world.json"));
  const renderOut = resolve(args.outDir);

  console.log(`[wallermax] rendering → ${renderOut}`);
  const result = await renderScene({
    worldJsonPath,
    outDir: renderOut,
    blenderBin: config.blenderBin,
    width: args.width,
    height: args.height,
    fps: args.fps,
    duration: args.duration,
    onLog: (line) => console.log(`  ${line}`),
  });

  if (result.kind === "blender") {
    console.log(`[wallermax] Blender render OK -> ${result.renderMp4}`);
    console.log(`[wallermax] .blend saved      -> ${result.blendFile}`);
  } else {
    console.log(`[wallermax] fallback preview render OK -> ${result.renderMp4}`);
    console.log(`[wallermax] poster saved              -> ${result.renderPosterPng}`);
    console.log(`[wallermax] NOTE: install Blender to get the full 3D render.`);
  }
  console.log(`[wallermax] done.`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
