// Wallermax H1 — in-memory job store with progress callbacks

import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type { JobProgress } from "./types.js";

type Listener = (progress: JobProgress) => void;

class JobStore {
  private jobs = new Map<string, JobProgress>();
  private listeners = new Map<string, Set<Listener>>();
  /** Map of jobId → child process (Blender or Python) for abort support. */
  private processes = new Map<string, ChildProcess>();

  create(): JobProgress {
    const jobId = randomUUID().slice(0, 8);
    const progress: JobProgress = {
      jobId,
      status: "queued",
      progress: 0,
      stage: "queued",
      startedAt: Date.now(),
    };
    this.jobs.set(jobId, progress);
    return progress;
  }

  get(jobId: string): JobProgress | undefined {
    return this.jobs.get(jobId);
  }

  list(): JobProgress[] {
    return Array.from(this.jobs.values()).sort((a, b) => b.startedAt - a.startedAt);
  }

  update(jobId: string, patch: Partial<JobProgress>): JobProgress {
    const cur = this.jobs.get(jobId);
    if (!cur) throw new Error(`Job not found: ${jobId}`);
    const updated: JobProgress = { ...cur, ...patch };
    if (patch.status === "done" || patch.status === "error") {
      updated.finishedAt = Date.now();
    }
    this.jobs.set(jobId, updated);
    this.notify(updated);
    return updated;
  }

  /** Register a child process (Blender/Python) for a job so it can be aborted. */
  setProcess(jobId: string, proc: ChildProcess): void {
    this.processes.set(jobId, proc);
    proc.on("exit", () => {
      this.processes.delete(jobId);
    });
  }

  /** Abort a running job by killing its child process. */
  abort(jobId: string): boolean {
    const proc = this.processes.get(jobId);
    if (!proc) return false;
    try {
      proc.kill("SIGTERM");
      // Give it 2 seconds, then SIGKILL.
      setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch {}
      }, 2000);
    } catch {
      try { proc.kill("SIGKILL"); } catch {}
    }
    this.update(jobId, {
      status: "error",
      stage: "Aborted by user",
      abortRequested: true,
    });
    this.processes.delete(jobId);
    return true;
  }

  subscribe(jobId: string, fn: Listener): () => void {
    let set = this.listeners.get(jobId);
    if (!set) {
      set = new Set();
      this.listeners.set(jobId, set);
    }
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.listeners.delete(jobId);
    };
  }

  private notify(progress: JobProgress) {
    const set = this.listeners.get(progress.jobId);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(progress);
      } catch {
        // listeners should never throw; ignore.
      }
    }
  }
}

export const jobStore = new JobStore();
