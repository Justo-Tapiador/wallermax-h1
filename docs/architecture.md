# Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                           Browser (vanilla JS)                          │
│  public/index.html  ·  public/styles.css  ·  public/app.js              │
└──────────────────────────────┬─────────────────────────────────────────┘
                               │ multipart/form-data + SSE
                               ▼
┌────────────────────────────────────────────────────────────────────────┐
│                          Node.js + TypeScript server                   │
│  server/src/index.ts  →  router.ts  →  handlers/*                       │
│                                                                         │
│   ┌───────────────┐   ┌────────────────────┐   ┌──────────────────┐    │
│   │  multipart    │ → │   pipeline.ts      │ → │   jobs.ts (SSE)  │    │
│   │  (formidable) │   │   runPipeline()    │   │   in-memory      │    │
│   └───────────────┘   └─────────┬──────────┘   └──────────────────┘    │
│                                  │                                       │
│                                  ▼                                       │
│                       ┌────────────────────┐                            │
│                       │  analyzers/scene   │                            │
│                       │  1. reconstruction  │ (if reference image)      │
│                       │  2. final image     │ (if final image)          │
│                       │  3. scene compiler  │ (always)                  │
│                       └─────────┬──────────┘                            │
│                                  │                                       │
│                                  ▼                                       │
│                       ┌────────────────────┐                            │
│                       │  llm/              │                            │
│                       │  · openai.ts       │                            │
│                       │  · zai.ts          │                            │
│                       │  · mock.ts         │                            │
│                       │  + extractJson()   │                            │
│                       └─────────┬──────────┘                            │
└──────────────────────────────────┼───────────────────────────────────────┘
                                   │
                                   ▼
                       ┌────────────────────┐
                       │  world.json        │  ← declarative scene model
                       └─────────┬──────────┘
                                  │  subprocess
                                  ▼
                       ┌────────────────────────────┐
                       │  blender -b --python        │
                       │  python/build_scene.py --   │
                       │  world.json output_dir      │
                       └─────────┬──────────────────┘
                                  │
                                  ▼
                       ┌────────────────────────────┐
                       │  world.blend  +  render.mp4 │
                       └────────────────────────────┘
```

## Three LLM calls, one World Model

When the user supplies **prompt + reference image + final image**, the pipeline
issues **three** LLM calls in sequence, then a Blender subprocess:

1. **Reconstruction** — feeds the reference image to the LLM with the
   `reconstruction.schema.json` schema. Produces a structured hypothesis
   of the visible 3D scene (entities, lighting, camera, ambiguities).
2. **Final-image analysis** — feeds the final image to the LLM with the
   `final_image.schema.json` schema. Produces an aesthetic / look-dev
   description (camera language, lighting mood, palette, objects, textures).
3. **Scene compiler** — feeds the prompt + reconstruction JSON + final-image
   JSON to the LLM with the `world_model.schema.json` schema. Produces the
   single World Model that Blender consumes. This is the only call that
   always runs, even when no images are supplied.

The reconstruction and final-image analyses are kept as separate JSON files
(`reconstruction.json`, `final_image.json`) so the user can inspect them in
the web UI's tabs.

## Why three calls instead of one?

Because they have different jobs:
- The reconstruction needs to be **conservative** (preserve confidence,
  flag ambiguities). Letting it leak into the scene compiler would blur
  provenance.
- The final-image analysis is **aesthetic**, not geometric. Folding it into
  the scene compiler would risk the model "copying" geometry from the
  target image.
- Keeping them separate lets the user override either one independently
  (e.g. feed a reconstruction without a final image, or vice versa).

## Provenance flow

Every entity in the World Model carries `provenance` ∈
{`observed`, `user_defined`, `inferred`, `creative`} and a `confidence`
float. The Blender compiler preserves these as Blender custom properties on
each object, so they survive into the `.blend` file and can be inspected in
Blender's UI.

## Provider abstraction

`server/src/llm/provider.ts` defines a minimal interface:

```ts
interface LLMProvider {
  readonly name: string;
  analyze(options: AnalyzeOptions): Promise<AnalyzeResult>;
}
```

Adding a new provider (Anthropic, a local Llama, …) means implementing
that interface and adding a case to the factory in `llm/index.ts`. The
shared `extractJson()` helper tolerates fenced JSON, leading prose and
unbalanced-fence responses, so providers that don't natively support
JSON-schema-strict output still work.

## Mock provider

The `MockProvider` returns canned but realistic payloads for all three
schemas. It is **deterministic** (same inputs → same outputs) so the
resulting Blender render is reproducible. It lets you exercise the entire
pipeline (and the web UI) without an API key — perfect for demos and CI.

## Job system

Jobs are in-memory (`server/src/jobs.ts`). Each job has a status
(`queued` → `analyzing` → `compiling` → `rendering` → `done` | `error`)
and emits progress updates to SSE subscribers. The web UI's right-hand
panel subscribes to `/api/jobs/:id/events` and renders updates live.

Jobs are **not** persisted to disk. Restarting the server clears them.
Artifacts (world.json, render.mp4, …) live under
`.wallermax/<jobId>/` and survive until the workdir is cleaned.
