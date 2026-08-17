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

  function updateFilename(dz, input) {
    const fn = dz.querySelector(".filename");
    fn.textContent = input.files && input.files.length ? input.files[0].name : "";
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

  document.addEventListener("DOMContentLoaded", init);
})();
