// Wallermax H1 — CLI report builder

import type { AnalysisBundle } from "../analyzers/scene.js";
import type { PipelineRequest } from "../types.js";

export function buildReport(req: PipelineRequest, bundle: AnalysisBundle): string {
  const lines: string[] = [];
  lines.push("# Wallermax H1 — Scene Report\n");
  lines.push(`- Provider: \`${req.provider}\``);
  if (req.model) lines.push(`- Model: \`${req.model}\``);
  if (req.referenceImage) lines.push(`- Reference image: \`${req.referenceImage.name}\``);
  if (req.finalImage) lines.push(`- Final image: \`${req.finalImage.name}\``);
  lines.push(`- Render: ${req.render.width}×${req.render.height} @ ${req.render.fps}fps × ${req.render.duration}s`);
  if (req.skipBlender) lines.push("- Blender: **skipped**");
  lines.push("");
  lines.push(`## World Model — version \`${bundle.world.version}\`\n`);
  lines.push(`**Entities (${bundle.world.entities.length}):**\n`);
  for (const e of bundle.world.entities) {
    lines.push(
      `- **${e.id}** — \`${e.type}\` — provenance=\`${e.provenance}\`, confidence=${e.confidence.toFixed(2)}` +
        (e.name ? ` — ${e.name}` : ""),
    );
  }
  if (bundle.world.world.aesthetic) {
    lines.push("\n## Aesthetic (from final image)\n");
    lines.push("```json");
    lines.push(JSON.stringify(bundle.world.world.aesthetic, null, 2));
    lines.push("```");
  }
  if (bundle.reconstruction) {
    lines.push("\n## Reconstruction\n");
    lines.push("```json");
    lines.push(JSON.stringify(bundle.reconstruction, null, 2));
    lines.push("```");
  }
  if (bundle.finalImageAnalysis) {
    lines.push("\n## Final-Image Analysis\n");
    lines.push("```json");
    lines.push(JSON.stringify(bundle.finalImageAnalysis, null, 2));
    lines.push("```");
  }
  return lines.join("\n");
}
