# HTTP API reference

Base URL: `http://127.0.0.1:4317` (override with `PORT` and `HOST` in `.env`).

---

## `GET /api/health`

Returns server health and current configuration.

```json
{
  "ok": true,
  "name": "wallermax-h1",
  "version": "1.0.0",
  "provider": "mock",
  "blenderBin": "blender",
  "skipBlender": false,
  "workdir": "/abs/path/to/.wallermax",
  "defaults": { "width": 1280, "height": 720, "fps": 30, "duration": 10 }
}
```

---

## `GET /api/config`

Returns the subset of server config that the web UI needs.

```json
{
  "provider": "mock",
  "blenderBin": "blender",
  "skipBlender": false,
  "defaultRender": { "width": 1280, "height": 720, "fps": 30, "duration": 10 },
  "maxUploadBytes": 20971520
}
```

---

## `POST /api/pipeline`

Submit a full pipeline run. Accepts `multipart/form-data` so you can upload
images alongside the prompt.

### Form fields

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `prompt` | string | yes | Natural-language scene description. |
| `referenceImage` | file | no | RGB image to reconstruct from. |
| `finalImage` | file | no | Target / look-dev image. |
| `width` | int | no | Render width in pixels. |
| `height` | int | no | Render height in pixels. |
| `fps` | int | no | Frames per second. |
| `duration` | number | no | Duration in seconds. |
| `engine` | string | no | `BLENDER_EEVEE_NEXT` (default) or `CYCLES`. |
| `samples` | int | no | Cycles samples (ignored for EEVEE). |
| `provider` | string | no | `mock` / `openai` / `zai`. Defaults to server config. |
| `model` | string | no | Model name override. |
| `skipBlender` | `"1"` / `"0"` | no | Skip Blender rendering. |
| `systemPromptExtra` | string | no | Appended to the scene-compiler system prompt. |

### Response (202 Accepted)

```json
{ "jobId": "a1b2c3d4", "status": "queued" }
```

### Example with curl

```bash
curl -X POST http://127.0.0.1:4317/api/pipeline \
  -F "prompt=@prompts/example.txt" \
  -F "width=1280" -F "height=720" -F "fps=30" -F "duration=8" \
  -F "provider=mock" -F "skipBlender=1"
```

---

## `POST /api/pipeline-sync`

Same as `/api/pipeline` but accepts a JSON body and does not support image
uploads. Useful for headless clients that already have a `world.json`-style
prompt and just want the LLM to expand it.

```bash
curl -X POST http://127.0.0.1:4317/api/pipeline-sync \
  -H "Content-Type: application/json" \
  -d '{"prompt":"A red ball bouncing in a checkerboard room","provider":"mock","skipBlender":true}'
```

Returns `202` with the same `{ jobId, status }` body.

---

## `POST /api/analyze`

Analyze a single image with the **final-image analyzer**. Useful for previewing
the extracted look-dev without running the full pipeline.

### Form fields

| Field | Type | Required |
| --- | --- | --- |
| `image` (or `finalImage`) | file | yes |
| `provider` | string | no |
| `model` | string | no |

### Response (200 OK)

```json
{
  "json": { "camera": {…}, "lighting": {…}, "objects": […], "textures": […], "palette": {…}, "style": {…} },
  "raw":   "{\n  \"camera\": …",
  "provider": "mock",
  "model": "mock-1.0",
  "latencyMs": 312
}
```

---

## `GET /api/jobs`

Returns an array of all known jobs, newest first.

```json
[
  { "jobId": "a1b2c3d4", "status": "done", "progress": 1, "stage": "Done",
    "startedAt": 1737000000000, "finishedAt": 1737000012345,
    "artifacts": { "worldJson": "…", "renderMp4": "…" } },
  …
]
```

---

## `GET /api/jobs/:id`

Returns a single job's current snapshot. Same shape as one entry of
`/api/jobs`, but also includes `world`, `reconstruction` and
`finalImageAnalysis` payloads when they have been produced.

---

## `GET /api/jobs/:id/events`

Server-Sent-Events stream of progress updates for a job. Emits:

| Event | Payload | When |
| --- | --- | --- |
| `hello` | `{ jobId }` | Immediately on connect. |
| `progress` | Full `JobProgress` object | On every progress update. |
| `close` | `{ status }` | When the job reaches `done` or `error`. |

### Browser example

```js
const es = new EventSource("/api/jobs/a1b2c3d4/events");
es.addEventListener("progress", (e) => {
  const p = JSON.parse(e.data);
  console.log(p.status, p.progress, p.stage);
});
es.addEventListener("close", () => es.close());
```

---

## `GET /api/files/:jobId/:name`

Download any artifact produced by a job. The path is relative to the job's
working directory, so nested paths are allowed (e.g.
`/api/files/a1b2c3d4/blender/render.mp4`). Path traversal is rejected.

### Common artifacts

| Path | Content-Type |
| --- | --- |
| `world.json` | `application/json` |
| `reconstruction.json` | `application/json` |
| `final_image.json` | `application/json` |
| `scene_report.md` | `text/markdown` |
| `blender/world.blend` | `application/x-blender` |
| `blender/render.mp4` | `video/mp4` |

### Example

```bash
curl -OJ http://127.0.0.1:4317/api/files/a1b2c3d4/blender/render.mp4
```

---

## `GET /api/download/:jobId/:name`

Alias of `/api/files` (same semantics, different URL prefix).

---

## `GET /static/*` and `GET /download/*`

Static file serving for the web UI (`public/`) and the project's `download/`
directory. The root URL `/` is internally rewritten to `/static/index.html`.
