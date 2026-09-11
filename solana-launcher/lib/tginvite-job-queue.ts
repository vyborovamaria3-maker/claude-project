interface QueueJob {
  id: string;
  execute: () => Promise<void>;
  retryCount: number;
  maxRetries: number;
  baseDelayMs: number;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  error?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

export class JobQueue {
  private queue: QueueJob[] = [];
  private running = false;
  private concurrency: number;
  private maxRetries: number;
  private baseDelayMs: number;
  private activeCount = 0;
  private rateLimits = new Map<string, RateLimitEntry>();
  private rateLimitWindowMs: number;
  private rateLimitMaxHits: number;
  private onProgress: ((job: QueueJob) => void) | null = null;

  constructor(options: {
    concurrency?: number;
    maxRetries?: number;
    baseDelayMs?: number;
    rateLimitMaxHits?: number;
    rateLimitWindowMs?: number;
    onProgress?: (job: QueueJob) => void;
  } = {}) {
    this.concurrency = options.concurrency ?? 3;
    this.maxRetries = options.maxRetries ?? 5;
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.rateLimitMaxHits = options.rateLimitMaxHits ?? 30;
    this.rateLimitWindowMs = options.rateLimitWindowMs ?? 60000;
    this.onProgress = options.onProgress ?? null;
  }

  add(execute: () => Promise<void>, id?: string): string {
    const jobId = id ?? `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const job: QueueJob = {
      id: jobId,
      execute,
      retryCount: 0,
      maxRetries: this.maxRetries,
      baseDelayMs: this.baseDelayMs,
      status: "pending",
      createdAt: Date.now(),
    };
    this.queue.push(job);
    this.processNext();
    return jobId;
  }

  async addWithRetry(execute: () => Promise<void>, id?: string): Promise<void> {
    const jobId = this.add(execute, id);
    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(() => {
        const job = this.queue.find((j) => j.id === jobId);
        if (!job) { clearInterval(checkInterval); return; }
        if (job.status === "completed") { clearInterval(checkInterval); resolve(); }
        if (job.status === "failed" || job.status === "cancelled") {
          clearInterval(checkInterval); reject(new Error(job.error ?? "Job failed"));
        }
      }, 200);
    });
  }

  cancel(jobId: string): void {
    const job = this.queue.find((j) => j.id === jobId);
    if (job && job.status === "pending") {
      job.status = "cancelled";
      job.completedAt = Date.now();
    }
  }

  cancelAll(): void {
    this.queue.forEach((j) => {
      if (j.status === "pending") {
        j.status = "cancelled";
        j.completedAt = Date.now();
      }
    });
    this.queue = [];
  }

  getQueue(): readonly QueueJob[] {
    return [...this.queue];
  }

  getActiveCount(): number {
    return this.activeCount;
  }

  isRunning(): boolean {
    return this.running;
  }

  setRateLimit(maxHits: number, windowMs: number): void {
    this.rateLimitMaxHits = maxHits;
    this.rateLimitWindowMs = windowMs;
  }

  checkRateLimit(key: string): boolean {
    const now = Date.now();
    let entry = this.rateLimits.get(key);
    if (!entry || now - entry.windowStart > this.rateLimitWindowMs) {
      entry = { count: 1, windowStart: now };
      this.rateLimits.set(key, entry);
      return true;
    }
    entry.count++;
    if (entry.count > this.rateLimitMaxHits) {
      return false;
    }
    return true;
  }

  getRateLimitRemaining(key: string): number {
    const now = Date.now();
    const entry = this.rateLimits.get(key);
    if (!entry || now - entry.windowStart > this.rateLimitWindowMs) return this.rateLimitMaxHits;
    return Math.max(0, this.rateLimitMaxHits - entry.count);
  }

  getStats(): { pending: number; running: number; completed: number; failed: number; cancelled: number } {
    return {
      pending: this.queue.filter((j) => j.status === "pending").length,
      running: this.activeCount,
      completed: this.queue.filter((j) => j.status === "completed").length,
      failed: this.queue.filter((j) => j.status === "failed").length,
      cancelled: this.queue.filter((j) => j.status === "cancelled").length,
    };
  }

  private async processNext(): Promise<void> {
    if (this.running) return;
    this.running = true;

    while (this.queue.length > 0 && this.activeCount < this.concurrency) {
      const pendingIdx = this.queue.findIndex((j) => j.status === "pending");
      if (pendingIdx === -1) break;
      const job = this.queue[pendingIdx];
      job.status = "running";
      job.startedAt = Date.now();
      this.activeCount++;

      this.executeWithRetry(job).finally(() => {
        this.activeCount--;
        this.running = false;
        this.onProgress?.(job);
        this.processNext();
      });
    }

    this.running = false;
  }

  private async executeWithRetry(job: QueueJob): Promise<void> {
    let lastError: string | undefined;

    for (let attempt = 0; attempt <= job.maxRetries; attempt++) {
      try {
        await job.execute();
        job.status = "completed";
        job.completedAt = Date.now();
        return;
      } catch (err: unknown) {
        lastError = err as string;
        const isRateLimit = (err as { isRateLimit?: boolean })?.isRateLimit ?? false;
        const isFloodWait = (err as { isFloodWait?: boolean })?.isFloodWait ?? false;

        if (isRateLimit || isFloodWait) {
          const waitMs = isFloodWait
            ? this.baseDelayMs * 10
            : this.getExponentialBackoff(attempt);
          await this.sleep(waitMs);
          continue;
        }

        if (attempt < job.maxRetries) {
          const backoffMs = this.getExponentialBackoff(attempt);
          await this.sleep(backoffMs);
        }
      }
    }

    job.status = "failed";
    job.error = lastError ?? "Unknown error";
    job.completedAt = Date.now();
  }

  private getExponentialBackoff(attempt: number): number {
    return this.baseDelayMs * Math.pow(2, attempt) * (0.5 + Math.random() * 0.5);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const tginviteQueue = new JobQueue({
  concurrency: 3,
  maxRetries: 5,
  baseDelayMs: 1000,
  rateLimitMaxHits: 30,
  rateLimitWindowMs: 60000,
});
