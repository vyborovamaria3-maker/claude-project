import type { CollectorJob } from "../jobs/types";
export type WorkerStatus = "STARTING" | "READY" | "RUNNING" | "DEGRADED" | "STOPPING" | "STOPPED" | "FAILED";

/** Lifecycle of the existing single-consumer worker. Errors remain errors. */
export class WorkerRuntime {
  readonly startedAt = new Date().toISOString();
  private status: WorkerStatus = "STARTING";
  private currentJob: { id: number; kind: string; attempt: number } | null = null;
  private completedJobs = 0;
  private failedJobs = 0;
  private active: Promise<unknown> | null = null;
  constructor(readonly workerId: string) {}
  ready() { if (this.status !== "STOPPING" && this.status !== "STOPPED") this.status = "READY"; }
  degraded() { if (this.status !== "STOPPING" && this.status !== "STOPPED") this.status = "DEGRADED"; }
  requestStop() { if (this.status !== "STOPPED") this.status = "STOPPING"; }
  snapshot() {
    return { workerId: this.workerId, type: "collector", status: this.status, startedAt: this.startedAt,
      currentJob: this.currentJob, completedJobs: this.completedJobs, failedJobs: this.failedJobs,
      timestamp: new Date().toISOString(), ready: this.status === "READY" || this.status === "RUNNING" };
  }
  async runJob<T>(job: CollectorJob, handler: (job: CollectorJob) => Promise<T>): Promise<T> {
    if (this.active || this.status !== "READY") throw new Error("worker is not accepting jobs");
    this.status = "RUNNING"; this.currentJob = { id: job.id, kind: job.kind, attempt: job.attempts };
    const operation = Promise.resolve().then(() => handler(job));
    this.active = operation;
    try {
      const result = await operation;
      if (result === "done") this.completedJobs++;
      else if (result === "failed" || result === "invalid-payload" || result === "pick-failed") this.failedJobs++;
      return result;
    } catch (error) { this.failedJobs++; throw error; }
    finally {
      this.active = null; this.currentJob = null;
      if (this.status === "RUNNING") this.status = "READY";
    }
  }
  async stop() { this.requestStop(); await this.active?.catch(() => {}); this.status = "STOPPED"; }
}
