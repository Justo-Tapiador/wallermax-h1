// Wallermax H1 — renderer abstraction
//
// Wraps two backends:
//   1. Blender (python/build_scene.py) — the "real" 3D renderer.
//   2. Fallback (python/fallback_renderer.py) — a Python+PIL+ffmpeg
//      schematic preview renderer used when Blender is not installed.
//
// The fallback renderer is NOT a substitute for Blender. It produces a
// top-down schematic / look-dev preview that proves the pipeline produces
// an MP4, but it does not honor materials, BRDFs, real physics, or
// camera perspective. It is intentionally conservative: same input →
// same output, no random ops.
//
// Auto-installation:
//   When the fallback renderer is selected, this module verifies that
//   Pillow is importable by the configured Python interpreter. If not,
//   it attempts to `pip install Pillow` automatically (once per process).
//   This makes the first-run experience smoother on machines where the
//   user has Python but not the Pillow package.

import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { PYTHON_DIR } from "./config.js";

export type RendererKind = "blender" | "fallback";

export interface RenderResult {
  kind: RendererKind;
  blendFile?: string;
  renderMp4: string;
  renderPosterPng?: string;
  logs: string[];
  /** True if we *tried* Blender but it was not installed and we fell back. */
  fellBack: boolean;
}

/**
 * Candidate Python interpreters to probe, in order of preference.
 *
 * On Windows, users often have multiple Python installations (python.org,
 * Microsoft Store, Anaconda, …) and the `python` command on PATH may not
 * be the one where they installed Pillow. We therefore probe several
 * well-known launcher names and pick the first one that works.
 *
 * `PYTHON_BIN` (if set in .env) always wins.
 */
function pythonCandidates(): string[] {
  if (process.env.PYTHON_BIN) {
    return [process.env.PYTHON_BIN];
  }
  if (process.platform === "win32") {
    // `python` (python.org or Store), `py -3` (Python Launcher for Windows,
    // which is the most reliable on Windows), `python3` (less common on Win).
    return ["python", "py", "python3"];
  }
  return ["python3", "python"];
}

/** Result of probing a single Python candidate. */
export interface PythonProbe {
  /** The bin name we tried (e.g. "python", "py"). */
  bin: string;
  /** True if the interpreter started at all (could run `python --version`). */
  runnable: boolean;
  /** Full path to the interpreter, e.g. "C:\\Python312\\python.exe". */
  executable?: string;
  /** Python version string, e.g. "3.12.1". */
  version?: string;
  /** True if `import PIL` works. */
  hasPillow: boolean;
  /** True if `import numpy` works (legacy check; we no longer need it). */
  hasNumpy: boolean;
  /** True if `ffmpeg` is on PATH. */
  hasFfmpeg: boolean;
  /** Any error message captured during probing. */
  error?: string;
}

/**
 * Probe a single Python candidate: does it run? what's its path? does it
 * have Pillow? does it have ffmpeg?
 *
 * Returns enough diagnostic info for the user to understand exactly which
 * Python the server is talking to.
 */
/**
 * Run a short Python snippet (`python -c "<code>"`) and return the stdout.
 *
 * On Windows with `shell: true`, the quoting of the `-c` argument is tricky
 * because the shell strips one layer of double quotes. We therefore write
 * the code to a temporary file and pass `python <tmpfile>` instead — this
 * avoids all quoting issues and works reliably across platforms.
 *
 * Returns null if the interpreter failed to run the code.
 */
async function runPythonCode(
  pyBin: string,
  code: string,
): Promise<string | null> {
  const { writeFile, mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const tmpDir = await mkdtemp(join(tmpdir(), "wallermax-py-"));
  const scriptPath = join(tmpDir, "probe.py");
  try {
    await writeFile(scriptPath, code, "utf-8");
    // Use forward slashes even on Windows — Python accepts them and they
    // avoid backslash escaping issues when going through `shell: true`.
    const scriptPathForward = scriptPath.replace(/\\/g, "/");
    const result = await runProcessQuiet([pyBin, scriptPathForward]);
    if (result.code !== 0) return null;
    return result.stdout;
  } catch {
    return null;
  } finally {
    try { await rm(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

async function probePython(bin: string): Promise<PythonProbe> {
  const probe: PythonProbe = { bin, runnable: false, hasPillow: false, hasNumpy: false, hasFfmpeg: false };

  // 1. `python --version` — verifies the interpreter starts.
  //    On Windows, the Microsoft Store stub prints nothing and exits 9009
  //    when not installed; we treat that as "not runnable".
  const versionResult = await runProcessQuiet([bin, "--version"]);
  if (versionResult.code !== 0) {
    probe.error = `'${bin} --version' exited with code ${versionResult.code}`;
    return probe;
  }
  probe.runnable = true;
  probe.version = (versionResult.stdout || versionResult.stderr).trim();

  // 2. Get the full path of the interpreter AND check Pillow / numpy / ffmpeg
  //    in a single Python invocation (more efficient and avoids the
  //    Windows quoting issues of `python -c "..."`).
  const probeCode = [
    "import sys",
    "import shutil",
    "print('EXEC:' + sys.executable)",
    "try:",
    "    import PIL",
    "    print('PIL:1')",
    "except ImportError:",
    "    print('PIL:0')",
    "try:",
    "    import numpy",
    "    print('NUMPY:1')",
    "except ImportError:",
    "    print('NUMPY:0')",
    "ff = shutil.which('ffmpeg')",
    "print('FF:' + (ff or ''))",
  ].join("\n");
  const out = await runPythonCode(bin, probeCode);
  if (out !== null) {
    for (const line of out.split(/\r?\n/)) {
      if (line.startsWith("EXEC:")) probe.executable = line.slice(5).trim();
      else if (line === "PIL:1") probe.hasPillow = true;
      else if (line === "NUMPY:1") probe.hasNumpy = true;
      else if (line.startsWith("FF:") && line.slice(3).trim().length > 0) probe.hasFfmpeg = true;
    }
  }

  return probe;
}

/** Like runProcess but silent (no onLog callback). Used for probing. */
async function runProcessQuiet(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return runProcess(args, () => {});
}

async function isExecutableOnPath(bin: string): Promise<boolean> {
  // If the path contains a separator, treat it as a direct path; otherwise
  // look it up on PATH using `which`/`where`.
  if (bin.includes("/") || bin.includes("\\")) {
    try {
      await access(bin, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  return new Promise((resolvePromise) => {
    const cmd = process.platform === "win32" ? "where" : "which";
    const child = spawn(cmd, [bin], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", () => resolvePromise(false));
    child.on("close", (code) => resolvePromise(code === 0 && out.trim().length > 0));
  });
}

async function runProcess(
  args: string[],
  onLog: (line: string) => void,
  onSpawn?: (child: import("node:child_process").ChildProcess) => void,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const useShell = process.platform === "win32";
    const child = spawn(args[0]!, args.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
      shell: useShell,
      env: { ...process.env },
    });
    // Notify the caller that the child process was spawned, so they can
    // register it for abort support.
    if (onSpawn) onSpawn(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      const s = d.toString();
      stdout += s;
      for (const line of s.split(/\r?\n/)) {
        if (line.trim()) onLog(line);
      }
    });
    child.stderr.on("data", (d) => {
      const s = d.toString();
      stderr += s;
      for (const line of s.split(/\r?\n/)) {
        if (line.trim()) onLog(`[stderr] ${line}`);
      }
    });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

/** Returns true if the Python interpreter can `import <module>`. */
async function pythonCanImport(pyBin: string, module: string): Promise<boolean> {
  // Use a temp file instead of `python -c "..."` to avoid Windows quoting
  // issues when the process is spawned with shell:true.
  const out = await runPythonCode(pyBin, `import ${module}\nprint("ok")`);
  return out !== null && out.includes("ok");
}

/** Attempt `pip install <pkg>` using the given Python interpreter. */
async function pipInstall(
  pyBin: string,
  pkg: string,
  onLog: (line: string) => void,
): Promise<boolean> {
  // Prefer `python -m pip install …` over the bare `pip` command, because
  // it guarantees we install into the same environment as the interpreter.
  onLog(`[wallermax] installing Python dependency '${pkg}' via 'python -m pip' (one-time setup)…`);
  const result = await runProcess([pyBin, "-m", "pip", "install", pkg], (line) => {
    onLog(`[pip] ${line.slice(0, 160)}`);
  });
  if (result.code !== 0) {
    onLog(`[wallermax] pip install failed (exit ${result.code}).`);
    return false;
  }
  // Verify the package is now importable.
  return pythonCanImport(pyBin, pkg === "Pillow" ? "PIL" : pkg);
}

async function renderWithBlender(
  worldJsonPath: string,
  outDir: string,
  blenderBin: string,
  onLog: (line: string) => void,
  onSpawn?: (child: import("node:child_process").ChildProcess) => void,
): Promise<void> {
  const script = join(PYTHON_DIR, "build_scene.py");
  // Use forward slashes for the script path even on Windows — Blender's
  // internal Python handles them correctly and they avoid the backslash
  // escaping issues that plague `shell:true` invocations.
  const scriptPath = script.replace(/\\/g, "/");
  const worldPath = worldJsonPath.replace(/\\/g, "/");
  const outPath = outDir.replace(/\\/g, "/");
  const args = [blenderBin, "-b", "--python", scriptPath, "--", worldPath, outPath];
  onLog(`[wallermax] launching Blender: ${args.join(" ")}`);
  const result = await runProcess(args, (line) => {
    // Filter Blender's per-frame noise so the UI log stays readable.
    if (line.startsWith("Fra:") || line.startsWith("Sample ")) return;
    onLog(`[blender] ${line.slice(0, 200)}`);
  }, onSpawn);
  if (result.code !== 0) {
    throw new Error(
      `Blender exited with code ${result.code}\n${result.stderr.slice(-2000)}`,
    );
  }
  // Verify the expected output files actually exist. Blender can exit with
  // code 0 even when the render silently failed (e.g. when the Python
  // script raises but Blender catches it, or when the output path is
  // unwritable).
  const expectedMp4 = join(outDir, "render.mp4");
  const expectedBlend = join(outDir, "world.blend");
  const { existsSync } = await import("node:fs");
  if (!existsSync(expectedMp4)) {
    // Collect the last ~30 lines of stdout/stderr for diagnosis.
    const tail = (result.stdout + "\n" + result.stderr).split("\n").filter(Boolean).slice(-30).join("\n");
    throw new Error(
      `Blender exited cleanly (code 0) but render.mp4 was not produced.\n` +
        `Expected at: ${expectedMp4}\n\n` +
        `Last Blender output:\n${tail}`,
    );
  }
  onLog(`[wallermax] Blender produced: ${expectedMp4}`);
  if (existsSync(expectedBlend)) {
    onLog(`[wallermax] Blender saved .blend: ${expectedBlend}`);
  }
}

async function renderWithFallback(
  worldJsonPath: string,
  outDir: string,
  width: number,
  height: number,
  fps: number,
  duration: number,
  onLog: (line: string) => void,
  onSpawn?: (child: import("node:child_process").ChildProcess) => void,
): Promise<void> {
  const script = join(PYTHON_DIR, "fallback_renderer.py");

  // ── Probe candidate Python interpreters ──────────────────────────────
  // We try `python`, `py` (Windows launcher), and `python3` in order. For
  // each one, we record whether it runs and whether it has Pillow. We then
  // pick the first candidate that already has Pillow. If none has Pillow,
  // we pick the first runnable one and try to auto-install Pillow into it.
  const candidates = pythonCandidates();
  onLog(`[wallermax] probing Python interpreters: ${candidates.join(", ")}`);
  const probes: PythonProbe[] = [];
  for (const bin of candidates) {
    const probe = await probePython(bin);
    probes.push(probe);
    if (probe.runnable) {
      onLog(
        `[wallermax]   ✓ ${bin}: ${probe.version} at ${probe.executable}` +
          `  [Pillow=${probe.hasPillow ? "yes" : "no"}, ffmpeg=${probe.hasFfmpeg ? "yes" : "no"}]`,
      );
    } else {
      onLog(`[wallermax]   ✗ ${bin}: ${probe.error || "not runnable"}`);
    }
  }

  // Strategy:
  //   1. Use the first candidate that already has Pillow.
  //   2. Otherwise, use the first runnable candidate and try to auto-install.
  //   3. Otherwise, fail with a detailed error.
  let chosen = probes.find((p) => p.runnable && p.hasPillow);
  if (!chosen) {
    chosen = probes.find((p) => p.runnable);
  }
  if (!chosen) {
    throw new Error(buildNoPythonError(probes));
  }

  const py = chosen.bin;
  onLog(`[wallermax] selected Python: ${py} → ${chosen.executable}`);

  // If the chosen interpreter doesn't have Pillow, try to install it.
  if (!chosen.hasPillow) {
    onLog(`[wallermax] Pillow is not installed for this Python. Attempting auto-install…`);
    const installed = await pipInstall(py, "Pillow", onLog);
    if (!installed) {
      throw new Error(buildPillowInstallError(chosen));
    }
    onLog(`[wallermax] Pillow installed successfully into ${chosen.executable}.`);
  }

  // Warn (but don't fail) if ffmpeg is missing — the renderer will fail
  // later with a clearer message, but the user gets an early warning here.
  if (!chosen.hasFfmpeg) {
    onLog(`[wallermax] WARNING: ffmpeg not found on PATH. The MP4 encoding step will fail.`);
    onLog(`[wallermax]          Install ffmpeg from https://ffmpeg.org/download.html`);
  }

  // Use forward slashes for all paths even on Windows — Python accepts
  // them and they avoid backslash escaping issues when going through
  // `shell: true` on Windows.
  const scriptPath = script.replace(/\\/g, "/");
  const worldPath = worldJsonPath.replace(/\\/g, "/");
  const outPath = outDir.replace(/\\/g, "/");
  const args = [
    py,
    scriptPath,
    worldPath,
    outPath,
    String(width),
    String(height),
    String(fps),
    String(duration),
  ];
  onLog(`[wallermax] launching fallback renderer: ${args.join(" ")}`);
  const result = await runProcess(args, (line) => {
    onLog(`[fallback] ${line.slice(0, 160)}`);
  }, onSpawn);
  if (result.code !== 0) {
    // Build a helpful error message that includes the install hint.
    const stderr = result.stderr || "";
    let hint = "";
    if (stderr.includes("No module named 'PIL'") || stderr.includes("No module named 'numpy'")) {
      hint =
        `\nHint: install missing Python packages with:\n` +
        `    ${py} -m pip install Pillow\n` +
        `(full Python path: ${chosen.executable})\n`;
    }
    if (stderr.includes("ffmpeg") || stderr.includes("FileNotFoundError")) {
      hint +=
        `\nHint: ffmpeg is required to encode the MP4. Install it from:\n` +
        `    https://ffmpeg.org/download.html\n` +
        `and make sure the 'ffmpeg' command is on PATH.\n`;
    }
    throw new Error(
      `Fallback renderer exited with code ${result.code}\n${stderr.slice(-1500)}${hint}`,
    );
  }
  // Verify the MP4 was actually produced (same as we do for Blender).
  // The fallback renderer can exit 0 even when ffmpeg silently failed.
  const { existsSync } = await import("node:fs");
  const expectedMp4 = join(outDir, "render.mp4");
  if (!existsSync(expectedMp4)) {
    const tail = (result.stdout + "\n" + result.stderr).split("\n").filter(Boolean).slice(-30).join("\n");
    throw new Error(
      `Fallback renderer exited cleanly (code 0) but render.mp4 was not produced.\n` +
        `Expected at: ${expectedMp4}\n\n` +
        `Last fallback output:\n${tail}`,
    );
  }
  onLog(`[wallermax] fallback produced: ${expectedMp4}`);
}

/** Build a clear error message when no Python interpreter was found at all. */
function buildNoPythonError(probes: PythonProbe[]): string {
  const lines: string[] = [
    "No runnable Python interpreter was found on PATH.",
    "",
    "The fallback renderer needs Python 3.10+ with the Pillow package.",
    "",
    "I tried these interpreters:",
  ];
  for (const p of probes) {
    lines.push(`  • ${p.bin}: ${p.error || "not runnable"}`);
  }
  lines.push("");
  lines.push("To fix this, do ONE of the following:");
  lines.push("");
  lines.push("  (a) Install Python from https://www.python.org/downloads/");
  lines.push("      (on Windows, make sure to check 'Add Python to PATH' during install)");
  lines.push("");
  lines.push("  (b) Set PYTHON_BIN in .env to the absolute path of your python");
  lines.push("      executable, e.g.:");
  lines.push("      PYTHON_BIN=C:\\Python312\\python.exe");
  lines.push("");
  lines.push("  (c) Install Blender (https://www.blender.org/download/) to use");
  lines.push("      the full 3D renderer instead of the fallback.");
  return lines.join("\n");
}

/** Build a clear error message when Pillow could not be installed. */
function buildPillowInstallError(chosen: PythonProbe): string {
  const lines: string[] = [
    "Pillow could not be auto-installed for the selected Python interpreter.",
    "",
    `The server is using this Python:`,
    `  ${chosen.executable || chosen.bin}  (version ${chosen.version || "unknown"})`,
    "",
    "If you already ran 'python -m pip install Pillow' in your terminal,",
    "you probably installed it into a DIFFERENT Python than the one the",
    "server is using (this is very common on Windows).",
    "",
    "To fix this, do ONE of the following:",
    "",
    "  (a) Run the install command using the EXACT same Python the server uses:",
    `      "${chosen.executable || chosen.bin}" -m pip install Pillow`,
    "",
    "  (b) Set PYTHON_BIN in .env to the absolute path of the Python where",
    "      you already installed Pillow, then restart the server:",
    "      PYTHON_BIN=<full-path-to-your-python.exe>",
    "",
    "  (c) Install Blender (https://www.blender.org/download/) to skip the",
    "      fallback renderer entirely.",
    "",
    "The fallback renderer also requires 'ffmpeg' on PATH to encode the MP4.",
  ];
  return lines.join("\n");
}

/** Export the probe results so the /api/python-check endpoint can show them. */
export async function probeAllPythons(): Promise<PythonProbe[]> {
  const candidates = pythonCandidates();
  const probes: PythonProbe[] = [];
  for (const bin of candidates) {
    probes.push(await probePython(bin));
  }
  return probes;
}

export interface RenderOptions {
  worldJsonPath: string;
  outDir: string;
  blenderBin: string;
  /** When true, skip Blender entirely and use the fallback renderer. */
  forceFallback?: boolean;
  /** Render settings used by the fallback renderer. */
  width: number;
  height: number;
  fps: number;
  duration: number;
  onLog: (line: string) => void;
  /** Called when the child process (Blender/Python) is spawned.
   *  The caller can use this to register the process for abort support. */
  onSpawn?: (child: import("node:child_process").ChildProcess) => void;
}

/**
 * Tries Blender first. If Blender is not installed (or the user forced the
 * fallback), uses the fallback renderer instead. Never throws on
 * "Blender not found" — that's the whole point of the fallback.
 */
export async function render(opts: RenderOptions): Promise<RenderResult> {
  const logs: string[] = [];
  const log = (line: string) => {
    logs.push(line);
    opts.onLog(line);
  };

  // Force fallback? (used by the UI's "Skip Blender" toggle when the user
  // explicitly wants the preview renderer).
  if (!opts.forceFallback) {
    const blenderAvailable = await isExecutableOnPath(opts.blenderBin);
    if (blenderAvailable) {
      try {
        await renderWithBlender(opts.worldJsonPath, opts.outDir, opts.blenderBin, log, opts.onSpawn);
        return {
          kind: "blender",
          blendFile: join(opts.outDir, "world.blend"),
          renderMp4: join(opts.outDir, "render.mp4"),
          logs,
          fellBack: false,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`[wallermax] Blender failed: ${msg.slice(0, 200)}`);
        log(`[wallermax] Falling back to preview renderer.`);
        // Fall through to fallback renderer.
      }
    } else {
      log(`[wallermax] Blender not found at "${opts.blenderBin}" — using fallback preview renderer.`);
    }
  } else {
    log(`[wallermax] Blender skipped by user — using fallback preview renderer.`);
  }

  // Fallback path.
  await renderWithFallback(
    opts.worldJsonPath,
    opts.outDir,
    opts.width,
    opts.height,
    opts.fps,
    opts.duration,
    log,
    opts.onSpawn,
  );
  return {
    kind: "fallback",
    renderMp4: join(opts.outDir, "render.mp4"),
    renderPosterPng: join(opts.outDir, "poster.png"),
    logs,
    fellBack: !opts.forceFallback,
  };
}
