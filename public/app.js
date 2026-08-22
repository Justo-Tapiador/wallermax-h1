/* Wallermax H1 — web UI controller (vanilla JS, no framework).
 *
 * Responsibilities:
 *   - Read form state, build a multipart/form-data POST to /api/pipeline.
 *   - Subscribe to /api/jobs/:id/events (SSE) for live progress.
 *   - Render the World Model, reconstruction, final-image analysis, report
 *     and the rendered MP4 in the right-hand tabs.
 *   - Maintain a jobs table the user can re-open later.
 */

(function () {
  "use strict";

  // ─── Element helpers ─────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const el = {
    prompt: $("prompt"),
    refInput: $("referenceImage"),
    finalInput: $("finalImage"),
    dzRef: $("dz-ref"),
    dzFinal: $("dz-final"),
    width: $("width"),
    height: $("height"),
    fps: $("fps"),
    duration: $("duration"),
    engine: $("engine"),
    samples: $("samples"),
    provider: $("provider"),
    skipBlender: $("skipBlender"),
    model: $("model"),
    systemPromptExtra: $("systemPromptExtra"),
    btnRun: $("btn-run"),
    btnAnalyzeFinal: $("btn-analyze-final"),
    btnHealth: $("btn-health"),
    btnPythonCheck: $("btn-python-check"),
    frameCounter: $("frame-counter"),
    progressFill: $("progress-fill"),
    progressStage: $("progress-stage"),
    progressPct: $("progress-pct"),
    worldJson: $("world-json"),
    reconJson: $("recon-json"),
    finalJson: $("final-json"),
    reportMd: $("report-md"),
    logsView: $("logs-view"),
    renderEmpty: $("render-empty"),
    renderVideo: $("render-video"),
    renderLinks: $("render-links"),
    jobsBody: $("jobs-body"),
    providerBadge: $("provider-badge"),
    btnPaste: $("btn-paste"),
    btnClearPrompt: $("btn-clear-prompt"),
    btnClearRef: $("btn-clear-ref"),
    btnClearFinal: $("btn-clear-final"),
  };

  let currentJobId = null;
  let currentJobStatus = null;
  let eventSource = null;

  // ─── Init ──────────────────────────────────────────────────
  async function init() {
    loadDefaultPrompt();
    wireDropzone(el.dzRef, el.refInput);
    wireDropzone(el.dzFinal, el.finalInput);
    wireTabs();
    el.btnRun.addEventListener("click", onRunOrStop);
    el.btnAnalyzeFinal.addEventListener("click", onAnalyzeFinal);
    el.btnHealth.addEventListener("click", onHealth);
    el.btnPythonCheck.addEventListener("click", onPythonCheck);
    // Show/hide the mock warning banner when the provider changes.
    el.provider.addEventListener("change", updateMockWarning);
    el.btnPaste.addEventListener("click", onPaste);
    el.btnClearPrompt.addEventListener("click", onClearPrompt);
    el.btnClearRef.addEventListener("click", onClearRef);
    el.btnClearFinal.addEventListener("click", onClearFinal);


    refreshJobs();
    setInterval(refreshJobs, 4000);
    fetchConfig();
  }

  function updateMockWarning() {
    const isMock = el.provider.value === "mock";
    const banner = document.getElementById("mock-warning");
    if (banner) banner.hidden = !isMock;
  }

  async function fetchConfig() {
    try {
      const r = await fetch("/api/config");
      const c = await r.json();
      el.provider.value = c.provider;
      el.providerBadge.textContent = `provider: ${c.provider}`;
      if (c.skipBlender) el.skipBlender.checked = true;
      if (c.defaultRender) {
        el.width.value = c.defaultRender.width;
        el.height.value = c.defaultRender.height;
        el.fps.value = c.defaultRender.fps;
        el.duration.value = c.defaultRender.duration;
      }
      // Show/hide the mock warning based on the configured provider.
      updateMockWarning();
    } catch (e) {
      console.warn("config fetch failed", e);
    }
  }

  function loadDefaultPrompt() {
    const DEFAULT_PROMPT = `Create a closed cubic room approximately 10 meters on each side. The floor, walls and ceiling are made of a black-and-white checkerboard pattern.

There is a red ball initially near the center of the floor. It should begin moving slowly, accelerate toward the right wall, collide with it, and bounce according to physics.

The room is static. Gravity points downward toward the floor.

Start with a wide establishing shot. Then smoothly follow the ball as it accelerates. Keep the ball clearly visible. After the bounce, make a subtle orbit around the ball.

Be physically plausible. If some information is not observable or explicitly specified, infer only what is necessary and mark those inferences as such. You may propose creative hidden details, but keep them separate from observed and user-defined facts.`;
    if (!el.prompt.value.trim()) el.prompt.value = DEFAULT_PROMPT;
  }

  // ─── Dropzone ─────────────────────────────────────────────
  function wireDropzone(dz, input) {
    dz.addEventListener("click", () => input.click());
    dz.addEventListener("dragover", (e) => {
      e.preventDefault();
      dz.classList.add("drag");
    });
    dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
    dz.addEventListener("drop", (e) => {
      e.preventDefault();
      dz.classList.remove("drag");
      if (e.dataTransfer.files.length) {
        input.files = e.dataTransfer.files;
        updateFilename(dz, input);
      }
    });
    input.addEventListener("change", () => updateFilename(dz, input));
  }
/*
  function updateFilename(dz, input) {
    const fn = dz.querySelector(".filename");
    fn.textContent = input.files && input.files.length ? input.files[0].name : "";
  }*/
   function updateFilename(dz, input) {
    const fn = dz.querySelector(".filename");
    const hasFile = input.files && input.files.length > 0;
    fn.textContent = hasFile ? input.files[0].name : "";
    // Show/hide the clear button.
    if (dz === el.dzRef) {
      el.btnClearRef.hidden = !hasFile;
    } else if (dz === el.dzFinal) {
      el.btnClearFinal.hidden = !hasFile;
    }
  }
  // ─── Tabs ─────────────────────────────────────────────────
  function wireTabs() {
    const tabs = document.querySelectorAll(".tab-btn");
    tabs.forEach((btn) => {
      btn.addEventListener("click", () => {
        tabs.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const target = btn.dataset.tab;
        document.querySelectorAll(".tab-content").forEach((c) => c.classList.add("hidden"));
        const targetEl = document.getElementById(`tab-${target}`);
        if (targetEl) targetEl.classList.remove("hidden");
      });
    });
  }

  // ─── Run/Stop pipeline ───────────────────────────────────
  function onRunOrStop() {
    if (currentJobId && isJobRunning()) {
      onStopPipeline();
    } else {
      onRun();
    }
  }

  function isJobRunning() {
    const job = currentJobStatus;
    return job && ["queued", "analyzing", "compiling", "rendering"].includes(job.status);
  }

  async function onStopPipeline() {
    if (!currentJobId) return;
    el.btnRun.disabled = true;
    el.btnRun.textContent = "Stopping…";
    try {
      const r = await fetch(`/api/jobs/${currentJobId}/abort`, { method: "POST" });
      const j = await r.json();
      if (r.ok) {
        toast(`Pipeline stop requested.`, "ok");
      } else {
        toast(`Stop failed: ${j.error || "unknown"}`, "err");
      }
    } catch (err) {
      toast(`Stop failed: ${err.message}`, "err");
    }
  }

  // ─── Run pipeline ────────────────────────────────────────
  async function onRun() {
    if (!el.prompt.value.trim()) {
      toast("Prompt is required.", "err");
      return;
    }
    el.btnRun.disabled = true;
    setProgress(0.02, "queued", "Submitting…");

    const fd = new FormData();
    fd.append("prompt", el.prompt.value);
    fd.append("width", el.width.value);
    fd.append("height", el.height.value);
    fd.append("fps", el.fps.value);
    fd.append("duration", el.duration.value);
    fd.append("engine", el.engine.value);
    fd.append("samples", el.samples.value);
    fd.append("provider", el.provider.value);
    fd.append("skipBlender", el.skipBlender.checked ? "1" : "0");
    if (el.model.value.trim()) fd.append("model", el.model.value.trim());
    if (el.systemPromptExtra.value.trim()) fd.append("systemPromptExtra", el.systemPromptExtra.value.trim());
    if (el.refInput.files && el.refInput.files[0]) fd.append("referenceImage", el.refInput.files[0]);
    if (el.finalInput.files && el.finalInput.files[0]) fd.append("finalImage", el.finalInput.files[0]);
    // Atlas (v1.1.0) — send userAtlas JSON if present
    const _userAtlasJson = document.getElementById("userAtlasJson")?.value;
    if (_userAtlasJson) fd.append("userAtlas", _userAtlasJson);
    try {
      const r = await fetch("/api/pipeline", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      currentJobId = j.jobId;
      setProgress(0.05, "queued", `Job ${j.jobId} created`);
      toast(`Job ${j.jobId} created.`, "ok");
      subscribeSSE(j.jobId);
      refreshJobs();
    } catch (err) {
      toast(`Failed: ${err.message}`, "err");
      setProgress(0, "error", err.message);
    } finally {
      el.btnRun.disabled = false;
    }
  }

  // ─── Analyze final image ─────────────────────────────────
  async function onAnalyzeFinal() {
    if (!el.finalInput.files || !el.finalInput.files[0]) {
      toast("Pick a final image first.", "err");
      return;
    }
    const fd = new FormData();
    fd.append("image", el.finalInput.files[0]);
    fd.append("provider", el.provider.value);
    if (el.model.value.trim()) fd.append("model", el.model.value.trim());

    el.btnAnalyzeFinal.disabled = true;
    toast("Analyzing final image…");
    try {
      const r = await fetch("/api/analyze", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      el.finalJson.textContent = JSON.stringify(j.json, null, 2);
      // Auto-switch to the Final Image tab.
      document.querySelector('.tab-btn[data-tab="final"]').click();
      toast(`Final-image analysis done (${j.latencyMs} ms, ${j.provider}/${j.model}).`, "ok");
    } catch (err) {
      toast(`Analyze failed: ${err.message}`, "err");
    } finally {
      el.btnAnalyzeFinal.disabled = false;
    }
  }

  // ─── Health ───────────────────────────────────────────────
  async function onHealth() {
    try {
      const r = await fetch("/api/health");
      const j = await r.json();
      toast(`${j.name} v${j.version} · provider=${j.provider} · blender=${j.skipBlender ? "skipped" : j.blenderBin}`, "ok");
    } catch (err) {
      toast(`Health check failed: ${err.message}`, "err");
    }
  }

  // ─── Python check ─────────────────────────────────────────
  // Opens a new browser tab with the raw JSON from /api/python-check.
  // This is the key diagnostic tool when the fallback renderer reports
  // a missing-Pillow error: it shows EXACTLY which Python the server is
  // using, its full path, and whether Pillow is importable there.
  async function onPythonCheck() {
    try {
      const r = await fetch("/api/python-check");
      const j = await r.json();
      const rec = j.recommended;
      if (!rec) {
        toast("No Python interpreter found. Install Python 3.10+ and retry.", "err");
        return;
      }
      const status = rec.hasPillow ? "OK" : "MISSING";
      const ffStatus = rec.hasFfmpeg ? "OK" : "MISSING";
      toast(
        `Python: ${rec.executable} (${rec.version})\n` +
        `Pillow: ${status}  ·  ffmpeg: ${ffStatus}`,
        rec.hasPillow && rec.hasFfmpeg ? "ok" : "err",
      );
      // Also open the full JSON in a new tab for detailed inspection.
      window.open("/api/python-check", "_blank");
    } catch (err) {
      toast(`Python check failed: ${err.message}`, "err");
    }
  }

  // ─── SSE ─────────────────────────────────────────────────
  function subscribeSSE(jobId) {
    if (eventSource) eventSource.close();
    eventSource = new EventSource(`/api/jobs/${jobId}/events`);
    eventSource.addEventListener("progress", (e) => {
      const p = JSON.parse(e.data);
      onProgress(p);
    });
    eventSource.addEventListener("close", () => {
      eventSource.close();
      eventSource = null;
    });
    eventSource.onerror = () => {
      // SSE auto-reconnects; do nothing here.
    };
  }

  function onProgress(p) {
    currentJobStatus = p;
    setProgress(p.progress, p.status, p.stage + (p.message ? ` — ${p.message}` : ""));
    if (p.world) el.worldJson.textContent = JSON.stringify(p.world, null, 2);
    if (p.reconstruction) el.reconJson.textContent = JSON.stringify(p.reconstruction, null, 2);
    if (p.finalImageAnalysis) el.finalJson.textContent = JSON.stringify(p.finalImageAnalysis, null, 2);
    // Update the renderer logs view in real time.
    if (p.logs && Array.isArray(p.logs)) {
      el.logsView.textContent = p.logs.join("\n");
      // Auto-scroll to the bottom so the latest log line is visible.
      el.logsView.scrollTop = el.logsView.scrollHeight;
    }
    // Update the frame counter (e.g. "34/96").
    if (p.currentFrame !== undefined && p.totalFrames !== undefined && p.totalFrames > 0) {
      el.frameCounter.textContent = `${p.currentFrame}/${p.totalFrames}`;
      el.frameCounter.hidden = false;
    } else if (p.status === "queued" || p.status === "analyzing") {
      el.frameCounter.hidden = true;
    }
    // Update the Run/Stop button based on job status.
    if (["queued", "analyzing", "compiling", "rendering"].includes(p.status)) {
      el.btnRun.textContent = "Stop pipeline";
      el.btnRun.disabled = false;
      el.btnRun.classList.add("stop-btn");
    } else {
      el.btnRun.textContent = "Run pipeline";
      el.btnRun.disabled = false;
      el.btnRun.classList.remove("stop-btn");
      el.frameCounter.hidden = true;
    }

    if (p.status === "done") {
      toast("Pipeline done.", "ok");
      loadJobOutputs(p);
    } else if (p.status === "error") {
      const errMsg = p.abortRequested ? "Pipeline stopped by user." : (p.error || "unknown");
      toast(`Pipeline ${p.abortRequested ? "stopped" : "error"}: ${errMsg}`, p.abortRequested ? "ok" : "err");
      // On error, auto-switch to the Logs tab so the user immediately sees
      // what went wrong (especially useful for Blender failures).
      if (!p.abortRequested) {
        document.querySelector('.tab-btn[data-tab="logs"]').click();
      }
    }
    if (p.status === "done" || p.status === "error") {
      refreshJobs();
    }
  }

  async function loadJobOutputs(p) {
    // Report
    try {
      const r = await fetch(`/api/files/${p.jobId}/scene_report.md`);
      if (r.ok) el.reportMd.textContent = await r.text();
    } catch {}
    // Render
    if (p.artifacts && p.artifacts.renderMp4) {
      el.renderEmpty.hidden = true;
      el.renderVideo.hidden = false;
      // Build the URL with a cache-busting query param so the browser
      // always fetches the fresh MP4 (in case the jobId was reused).
      const videoUrl = `/api/files/${p.jobId}/blender/render.mp4?ts=${Date.now()}`;
      el.renderVideo.src = videoUrl;
      // Explicitly trigger a load — sometimes setting .src alone doesn't
      // reload if the URL looks the same (browser cache).
      try { el.renderVideo.load(); } catch {}
      el.renderLinks.innerHTML = "";

      // Show a small badge telling the user which renderer was used.
      if (p.renderEngine) {
        const badge = document.createElement("div");
        badge.className = "renderer-badge " + p.renderEngine;
        badge.textContent =
          p.renderEngine === "blender"
            ? "Rendered with Blender (full 3D)"
            : "Rendered with fallback preview (Blender not installed)";
        el.renderLinks.appendChild(badge);
      }

      const links = [
        { name: "render.mp4", path: "blender/render.mp4" },
      ];
      if (p.artifacts.blendFile) {
        links.push({ name: "world.blend", path: "blender/world.blend" });
      }
      if (p.artifacts.renderPosterPng) {
        links.push({ name: "poster.png", path: "blender/poster.png" });
      }
      links.push({ name: "world.json", path: "world.json" });
      for (const l of links) {
        const a = document.createElement("a");
        a.href = `/api/download/${p.jobId}/${l.path}`;
        a.download = l.name;
        a.textContent = `⤓ ${l.name}`;
        el.renderLinks.appendChild(a);
      }

      // Auto-switch to the Render tab so the user sees the video.
      document.querySelector('.tab-btn[data-tab="render"]').click();
    } else {
      el.renderEmpty.hidden = false;
      el.renderVideo.hidden = true;
      el.renderLinks.innerHTML = "";
      if (p.artifacts && p.artifacts.worldJson) {
        const a = document.createElement("a");
        a.href = `/api/download/${p.jobId}/world.json`;
        a.download = "world.json";
        a.textContent = "⤓ world.json";
        el.renderLinks.appendChild(a);
      }
    }
  }

  // ─── Jobs table ──────────────────────────────────────────
  async function refreshJobs() {
    try {
      const r = await fetch("/api/jobs");
      const list = await r.json();
      el.jobsBody.innerHTML = "";
      for (const j of list.slice(0, 25)) {
        const tr = document.createElement("tr");
        const td = (txt, cls) => {
          const c = document.createElement("td");
          if (cls) c.className = cls;
          c.textContent = txt;
          return c;
        };
        const ts = new Date(j.startedAt).toLocaleTimeString();
        tr.appendChild(td(j.jobId));
        tr.appendChild(td(j.status, `status-pill ${j.status}`));
        tr.appendChild(td(j.stage || ""));
        tr.appendChild(td(ts));
        const actionTd = document.createElement("td");
        const btn = document.createElement("button");
        btn.textContent = "open";
        btn.className = "ghost-btn";
        btn.style.padding = "4px 10px";
        btn.style.fontSize = "11px";
        btn.addEventListener("click", () => openJob(j));
        actionTd.appendChild(btn);
        tr.appendChild(actionTd);
        el.jobsBody.appendChild(tr);
      }
    } catch {}
  }

  function openJob(j) {
    currentJobId = j.jobId;
    if (j.world) el.worldJson.textContent = JSON.stringify(j.world, null, 2);
    if (j.reconstruction) el.reconJson.textContent = JSON.stringify(j.reconstruction, null, 2);
    if (j.finalImageAnalysis) el.finalJson.textContent = JSON.stringify(j.finalImageAnalysis, null, 2);
    if (j.logs && Array.isArray(j.logs)) {
      el.logsView.textContent = j.logs.join("\n");
    }
    setProgress(j.progress || 0, j.status, j.stage || "");
    loadJobOutputs(j);
    if (j.status === "analyzing" || j.status === "compiling" || j.status === "rendering" || j.status === "queued") {
      subscribeSSE(j.jobId);
    }
  }

  // ─── Utilities ───────────────────────────────────────────
  function setProgress(pct, status, stage) {
    el.progressFill.style.width = `${Math.round(pct * 100)}%`;
    el.progressPct.textContent = `${Math.round(pct * 100)}%`;
    el.progressStage.textContent = stage || status || "";
  }

  let toastTimer = null;
  function toast(msg, kind) {
    let t = document.querySelector(".toast");
    if (t) t.remove();
    t = document.createElement("div");
    t.className = `toast ${kind || ""}`;
    t.textContent = msg;
    document.body.appendChild(t);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), 4500);
  }


   // ─── Prompt toolbar ──────────────────────────────────────
  async function onPaste() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        el.prompt.value = text;
        toast("Prompt pasted from clipboard.", "ok");
      } else {
        toast("Clipboard is empty.", "err");
      }
    } catch (err) {
      toast("Cannot read clipboard. Paste manually (Ctrl+V).", "err");
    }
  }

  function onClearPrompt() {
    el.prompt.value = "";
    el.prompt.focus();
    toast("Prompt cleared.");
  }

  // ─── Clear image buttons ─────────────────────────────────
  function onClearRef() {
    el.refInput.value = "";
    updateFilename(el.dzRef, el.refInput);
    el.btnClearRef.hidden = true;
    toast("Reference image removed.");
  }

  function onClearFinal() {
    el.finalInput.value = "";
    updateFilename(el.dzFinal, el.finalInput);
    el.btnClearFinal.hidden = true;
    toast("Final image removed.");
  }


  document.addEventListener("DOMContentLoaded", init);
})();


// ─────────────────────────────────────────────────────────────────────────────
// Texture Atlas Builder (v1.1.0)
// ─────────────────────────────────────────────────────────────────────────────

const ATLAS_GRID_SIZE = 10;
const ATLAS_TILE_PX = 102;
let atlasState = {
  availableAtlases: [],
  currentAtlas: null,
  userAtlas: {},  // { "row,col": { source_atlas, source_row, source_col } }
};

// ── Open/close modal ─────────────────────────────────────────────────────────
const btnAtlas = document.getElementById("btn-atlas");
const atlasModal = document.getElementById("atlas-modal");
const btnAtlasClose = document.getElementById("btn-atlas-close");

if (btnAtlas) btnAtlas.addEventListener("click", () => {
  atlasModal.hidden = false;
  if (atlasState.availableAtlases.length === 0) {
    loadAtlasList();
  }
});
if (btnAtlasClose) btnAtlasClose.addEventListener("click", () => {
  atlasModal.hidden = true;
});

// ── Load atlas list from /api/atlases ────────────────────────────────────────
async function loadAtlasList() {
  const listEl = document.getElementById("atlas-list");
  listEl.innerHTML = '<p class="atlas-loading">Loading…</p>';
  try {
    const res = await fetch("/api/atlases");
    const data = await res.json();
    atlasState.availableAtlases = data.atlases || [];
    renderAtlasList();
    if (atlasState.availableAtlases.length > 0) {
      selectAtlas(atlasState.availableAtlases[0].name);
    }
  } catch (err) {
    listEl.innerHTML = `<p class="atlas-loading">Failed to load: ${err.message}</p>`;
  }
}

function renderAtlasList() {
  const listEl = document.getElementById("atlas-list");
  listEl.innerHTML = "";
  atlasState.availableAtlases.forEach(atlas => {
    const item = document.createElement("div");
    item.className = "atlas-item";
    item.dataset.name = atlas.name;
    item.innerHTML = `
      <div class="atlas-thumb" style="background-image: url('/api/atlases/${atlas.name}/image');"></div>
      <div class="atlas-info">
        <div class="atlas-name">${atlas.name}</div>
        <div class="atlas-meta">${atlas.tile_count} tiles</div>
      </div>
    `;
    item.addEventListener("click", () => selectAtlas(atlas.name));
    listEl.appendChild(item);
  });
}

function selectAtlas(name) {
  atlasState.currentAtlas = name;
  // Update active state in list
  document.querySelectorAll(".atlas-item").forEach(el => {
    el.classList.toggle("active", el.dataset.name === name);
  });
  // Update source title
  document.getElementById("atlas-source-title").textContent = `Source Atlas — ${name}`;
  // Load image
  const img = document.getElementById("atlas-img");
  img.src = `/api/atlases/${name}/image`;
  img.hidden = false;
  // Build grid overlay
  buildAtlasGrid();
}

function buildAtlasGrid() {
  const grid = document.getElementById("atlas-grid");
  grid.innerHTML = "";
  const cellSize = 40; // 400 / 10
  for (let row = 0; row < ATLAS_GRID_SIZE; row++) {
    for (let col = 0; col < ATLAS_GRID_SIZE; col++) {
      const cell = document.createElement("div");
      cell.className = "atlas-grid-cell";
      cell.style.left = `${col * cellSize}px`;
      cell.style.top = `${row * cellSize}px`;
      cell.style.width = `${cellSize}px`;
      cell.style.height = `${cellSize}px`;
      cell.dataset.row = row;
      cell.dataset.col = col;
      grid.appendChild(cell);
    }
  }
}

// ── Hover on source atlas ────────────────────────────────────────────────────
const atlasCanvas = document.getElementById("atlas-canvas");
const atlasTooltip = document.getElementById("atlas-tooltip");
const atlasHovered = document.getElementById("atlas-hovered");

if (atlasCanvas) atlasCanvas.addEventListener("mousemove", (e) => {
  const rect = atlasCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const cellSize = rect.width / ATLAS_GRID_SIZE;
  const col = Math.floor(x / cellSize);
  const row = Math.floor(y / cellSize);
  if (col < 0 || col >= ATLAS_GRID_SIZE || row < 0 || row >= ATLAS_GRID_SIZE) return;

  // Highlight cell
  document.querySelectorAll(".atlas-grid-cell.hover").forEach(c => c.classList.remove("hover"));
  const grid = document.getElementById("atlas-grid");
  const hoveredCell = grid.children[row * ATLAS_GRID_SIZE + col];
  if (hoveredCell) hoveredCell.classList.add("hover");

  // Tooltip
  atlasTooltip.style.left = `${x + 12}px`;
  atlasTooltip.style.top = `${y - 30}px`;
  atlasTooltip.textContent = `${atlasState.currentAtlas}:${row},${col}`;
  atlasTooltip.classList.add("show");

  atlasHovered.textContent = `${atlasState.currentAtlas}:${row},${col}`;
});

if (atlasCanvas) atlasCanvas.addEventListener("mouseleave", () => {
  document.querySelectorAll(".atlas-grid-cell.hover").forEach(c => c.classList.remove("hover"));
  atlasTooltip.classList.remove("show");
  atlasHovered.textContent = "—";
});

// ── Click to add tile to user atlas ──────────────────────────────────────────
if (atlasCanvas) atlasCanvas.addEventListener("click", (e) => {
  const rect = atlasCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const cellSize = rect.width / ATLAS_GRID_SIZE;
  const col = Math.floor(x / cellSize);
  const row = Math.floor(y / cellSize);
  if (col < 0 || col >= ATLAS_GRID_SIZE || row < 0 || row >= ATLAS_GRID_SIZE) return;

  const nextSlot = getNextUserSlot();
  if (!nextSlot) {
    alert("User atlas is full (100/100 tiles). Remove some tiles first.");
    return;
  }
  const [uRow, uCol] = nextSlot.split(",").map(Number);
  atlasState.userAtlas[nextSlot] = {
    source_atlas: atlasState.currentAtlas,
    source_row: row,
    source_col: col,
  };
  // Add background-image to the user cell
  const userGrid = document.getElementById("atlas-user-grid");
  const cell = userGrid.children[uRow * ATLAS_GRID_SIZE + uCol];
  if (cell) {
    cell.classList.add("filled");
    cell.style.backgroundImage = `url('/api/atlases/${atlasState.currentAtlas}/image')`;
    cell.style.backgroundPosition = `-${col * 32}px -${row * 32}px`;
    cell.style.backgroundSize = "320px 320px";
    cell.dataset.coord = nextSlot;
  }
  updateUserStats();
  updateSelectedList();
});

function getNextUserSlot() {
  for (let row = 0; row < ATLAS_GRID_SIZE; row++) {
    for (let col = 0; col < ATLAS_GRID_SIZE; col++) {
      if (!atlasState.userAtlas[`${row},${col}`]) return `${row},${col}`;
    }
  }
  return null;
}

// ── Build user grid (10x10) ──────────────────────────────────────────────────
function buildUserGrid() {
  const grid = document.getElementById("atlas-user-grid");
  grid.innerHTML = "";
  for (let row = 0; row < ATLAS_GRID_SIZE; row++) {
    for (let col = 0; col < ATLAS_GRID_SIZE; col++) {
      const cell = document.createElement("div");
      cell.className = "atlas-user-cell";
      cell.dataset.coord = `${row},${col}`;
      cell.addEventListener("click", () => removeUserTile(row, col));
      grid.appendChild(cell);
    }
  }
}

function removeUserTile(row, col) {
  const key = `${row},${col}`;
  if (!atlasState.userAtlas[key]) return;
  delete atlasState.userAtlas[key];
  const grid = document.getElementById("atlas-user-grid");
  const cell = grid.children[row * ATLAS_GRID_SIZE + col];
  if (cell) {
    cell.classList.remove("filled");
    cell.style.backgroundImage = "";
  }
  updateUserStats();
  updateSelectedList();
}

function updateUserStats() {
  const count = Object.keys(atlasState.userAtlas).length;
  document.getElementById("atlas-tile-count").textContent = count;
  const next = getNextUserSlot();
  document.getElementById("atlas-next-slot").textContent = next ? `atlas_user:${next}` : "FULL";
}

function updateSelectedList() {
  const list = document.getElementById("atlas-selected-list");
  list.innerHTML = "";
  Object.entries(atlasState.userAtlas).forEach(([coord, info]) => {
    const item = document.createElement("div");
    item.className = "atlas-selected-item";
    item.innerHTML = `
      <span class="atlas-selected-coord">${coord}</span>
      <span class="atlas-selected-source">← ${info.source_atlas}:${info.source_row},${info.source_col}</span>
      <span class="atlas-selected-remove" title="Remove">×</span>
    `;
    item.querySelector(".atlas-selected-remove").addEventListener("click", (ev) => {
      ev.stopPropagation();
      const [r, c] = coord.split(",").map(Number);
      removeUserTile(r, c);
    });
    list.appendChild(item);
  });
}

// ── Clear all ────────────────────────────────────────────────────────────────
document.getElementById("btn-atlas-clear")?.addEventListener("click", () => {
  if (!confirm("Clear all tiles from your custom atlas?")) return;
  Object.keys(atlasState.userAtlas).forEach(key => {
    const [r, c] = key.split(",").map(Number);
    removeUserTile(r, c);
  });
});

// ── Done button — serialize and store ───────────────────────────────────────
document.getElementById("btn-atlas-done")?.addEventListener("click", () => {
  const count = Object.keys(atlasState.userAtlas).length;
  if (count === 0) {
    alert("Your atlas is empty. Add at least 1 tile before continuing.");
    return;
  }
  // Serialize to JSON
  const tiles = Object.entries(atlasState.userAtlas).map(([coord, info]) => {
    const [dest_row, dest_col] = coord.split(",").map(Number);
    return {
      dest_row,
      dest_col,
      source_atlas: info.source_atlas,
      source_row: info.source_row,
      source_col: info.source_col,
    };
  });
  const userAtlasJson = JSON.stringify({
    version: "1.0",
    grid_cols: ATLAS_GRID_SIZE,
    grid_rows: ATLAS_GRID_SIZE,
    tile_size: ATLAS_TILE_PX,
    tiles,
  });
  // Store in hidden input
  document.getElementById("userAtlasJson").value = userAtlasJson;
  // Close modal
  atlasModal.hidden = true;
  console.log(`[atlas] userAtlas serialized with ${count} tiles`);
});

// Initialize user grid on page load
buildUserGrid();

