// Wallermax H1 — pipeline orchestrator
//
// Drives a single job through the stages:
//   queued → analyzing → compiling → rendering → done | error
//
// Each stage updates the JobProgress in the store. Long-running stages
// (analyzing, rendering) emit multiple progress updates so the web UI's
// progress bar stays alive.

import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { jobStore } from "./jobs.js";
import { analyzeScene } from "./analyzers/scene.js";
import { render as renderScene } from "./renderer.js";
import type { PipelineRequest, JobProgress } from "./types.js";

function jobDir(workdir: string, jobId: string): string {
  return join(workdir, jobId);
}

async function ensureDir(p: string): Promise<void> {
  await mkdir(p, { recursive: true });
}

function buildReport(req: PipelineRequest, progress: JobProgress): string {
  const w = progress.world;
  const lines: string[] = [];
  lines.push("# Wallermax H1 — Scene Report\n");
  lines.push(`- Job: \`${progress.jobId}\``);
  lines.push(`- Provider: \`${req.provider}\``);
  if (req.model) lines.push(`- Model: \`${req.model}\``);
  if (req.referenceImage) lines.push(`- Reference image: \`${req.referenceImage.name}\``);
  if (req.finalImage) lines.push(`- Final image: \`${req.finalImage.name}\``);
  lines.push(`- Render: ${req.render.width}×${req.render.height} @ ${req.render.fps}fps × ${req.render.duration}s`);
  if (req.skipBlender) lines.push("- Blender: **skipped**");
  lines.push("");

  if (w) {
    lines.push(`## World Model — version \`${w.version}\`\n`);
    lines.push(`**Entities (${w.entities.length}):**\n`);
    for (const e of w.entities) {
      lines.push(
        `- **${e.id}** — \`${e.type}\` — provenance=\`${e.provenance}\`, confidence=${e.confidence.toFixed(2)}` +
          (e.name ? ` — ${e.name}` : ""),
      );
    }
    lines.push(`\n**Relationships:** ${w.relationships.length}`);
    lines.push(`**Events:** ${w.events.length}`);
    if (w.world.aesthetic) {
      lines.push("\n## Aesthetic (from final image)\n");
      lines.push("```json");
      lines.push(JSON.stringify(w.world.aesthetic, null, 2));
      lines.push("```");
    }
  }

  if (progress.reconstruction) {
    lines.push("\n## Reconstruction\n");
    lines.push("```json");
    lines.push(JSON.stringify(progress.reconstruction, null, 2));
    lines.push("```");
  }

  if (progress.finalImageAnalysis) {
    lines.push("\n## Final-Image Analysis\n");
    lines.push("```json");
    lines.push(JSON.stringify(progress.finalImageAnalysis, null, 2));
    lines.push("```");
  }

  return lines.join("\n");
}

export async function runPipeline(
  workdir: string,
  blenderBin: string,
  skipBlender: boolean,
  req: PipelineRequest,
  jobId: string,
): Promise<void> {
  const dir = jobDir(workdir, jobId);
  await ensureDir(dir);

  try {
    // ── Analyze ────────────────────────────────────────────────────────
    jobStore.update(jobId, {
      status: "analyzing",
      progress: 0.05,
      stage: "Analyzing scene (LLM call)",
      message: req.referenceImage ? "Reconstructing from reference image" : "Text-only analysis",
    });

    const bundle = await analyzeScene(req);

    jobStore.update(jobId, {
      progress: 0.5,
      stage: "Analysis complete",
      world: bundle.world,
      reconstruction: bundle.reconstruction,
      finalImageAnalysis: bundle.finalImageAnalysis,
    });

    // ── Persist artifacts ───────────────────────────────────────────────
    const worldJsonPath = join(dir, "world.json");
    await writeFile(worldJsonPath, JSON.stringify(bundle.world, null, 2), "utf-8");

    const sceneReportPath = join(dir, "scene_report.md");
    await writeFile(
      sceneReportPath,
      buildReport(req, jobStore.get(jobId)!),
      "utf-8",
    );

    if (bundle.reconstruction) {
      await writeFile(
        join(dir, "reconstruction.json"),
        JSON.stringify(bundle.reconstruction, null, 2),
        "utf-8",
      );
    }
    if (bundle.finalImageAnalysis) {
      await writeFile(
        join(dir, "final_image.json"),
        JSON.stringify(bundle.finalImageAnalysis, null, 2),
        "utf-8",
      );
    }

    const artifacts: JobProgress["artifacts"] = {
      worldJson: worldJsonPath,
      sceneReportMd: sceneReportPath,
      reconstructionJson: bundle.reconstruction ? join(dir, "reconstruction.json") : undefined,
      finalImageJson: bundle.finalImageAnalysis ? join(dir, "final_image.json") : undefined,
    };

    // ── Render ────────────────────────────────────────────────────────────
    //
    // Three possible outcomes:
    //   1. skipBlender=true  → mark job done, no render (the user only wants
    //                          the World Model JSON).
    //   2. Blender available → full 3D render via python/build_scene.py.
    //   3. Blender missing   → automatic fallback to python/fallback_renderer.py,
    //                          which produces a top-down schematic MP4 preview
    //                          using only PIL + ffmpeg. The job is still marked
    //                          "done" but with renderEngine="fallback" so the
    //                          UI can clearly tell the user what happened.
    if (skipBlender) {
      jobStore.update(jobId, {
        status: "done",
        progress: 1,
        stage: "Done (Blender skipped — World Model only)",
        artifacts,
      });
      return;
    }

    jobStore.update(jobId, {
      status: "compiling",
      progress: 0.6,
      stage: "Rendering scene",
      artifacts,
    });

    const renderOutDir = join(dir, "blender");
    await ensureDir(renderOutDir);

    // Accumulate renderer log lines so the UI can show them in a dedicated
    // "Logs" view. This is critical for debugging Blender failures.
    const renderLogs: string[] = [];
    // Calculate total frames for progress display.
    const totalFrames = Math.ceil(req.render.duration * req.render.fps);
    jobStore.update(jobId, { totalFrames });
    const renderResult = await renderScene({
      worldJsonPath: resolve(worldJsonPath),
      outDir: renderOutDir,
      blenderBin,
      width: req.render.width,
      height: req.render.height,
      fps: req.render.fps,
      duration: req.render.duration,
      onLog: (line) => {
        renderLogs.push(line);
        // Parse Blender's frame log to extract the current frame number.
        // Blender prints lines like:
        //   "00:23.531  render           | Saved: '.../frame_0001.png'"
        //   "Fra:34 Mem:..." (older format)
        let currentFrame: number | undefined;
        // Match "render0001.png" or "frame_0001.png" or "frame0001.png"
        const frameMatch = line.match(/(?:frame_|frame|render)(\d+)\.png/);
        if (frameMatch && frameMatch[1]) {
          currentFrame = parseInt(frameMatch[1], 10);
        }
        // Also match Blender's "Fra:34" format
        const fraMatch = line.match(/Fra:(\d+)/);
        if (fraMatch && fraMatch[1]) {
          currentFrame = parseInt(fraMatch[1], 10);
        }
        // Update the job with the current frame (if found) and logs.
        const patch: Partial<JobProgress> = {
          stage: line.slice(0, 140),
          logs: renderLogs.slice(-200),
        };
        if (currentFrame !== undefined) {
          patch.currentFrame = currentFrame;
          // Update progress based on frame number.
          if (totalFrames > 0) {
            patch.progress = Math.min(0.95, 0.05 + (currentFrame / totalFrames) * 0.9);
          }
        }
        jobStore.update(jobId, patch);
      },
      onSpawn: (child) => {
        // Register the child process so the user can abort it.
        jobStore.setProcess(jobId, child);
      },
    });

    if (renderResult.blendFile) artifacts.blendFile = renderResult.blendFile;
    if (renderResult.renderMp4) artifacts.renderMp4 = renderResult.renderMp4;
    if (renderResult.renderPosterPng) artifacts.renderPosterPng = renderResult.renderPosterPng;

    const stageLabel =
      renderResult.kind === "blender"
        ? "Done (rendered with Blender)"
        : "Done (Blender not installed — used fallback preview renderer)";

    jobStore.update(jobId, {
      status: "rendering",
      progress: 0.95,
      stage: "Render finalized",
      artifacts,
      renderEngine: renderResult.kind,
    });

    jobStore.update(jobId, {
      status: "done",
      progress: 1,
      stage: stageLabel,
      artifacts,
      renderEngine: renderResult.kind,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    jobStore.update(jobId, {
      status: "error",
      stage: "Error",
      error,
      // Preserve the logs so the user can see what Blender actually said.
      logs: jobStore.get(jobId)?.logs,
    });
    // Clean up partial output dir? Keep it for debugging.
    process.stderr.write(`[pipeline ${jobId}] error: ${error}\n`);
  }
}
