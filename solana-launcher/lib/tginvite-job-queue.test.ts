import { describe, it, expect, vi } from "vitest";
import { JobQueue } from "./tginvite-job-queue";

describe("JobQueue", () => {
  it("adds and executes jobs", async () => {
    const queue = new JobQueue({ maxRetries: 0 });
    const executed = vi.fn();
    queue.add(async () => executed());
    await new Promise((r) => setTimeout(r, 50));
    expect(executed).toHaveBeenCalledOnce();
  });

  it("supports multiple concurrent jobs", async () => {
    const queue = new JobQueue({ concurrency: 3, maxRetries: 0 });
    let running = 0;
    let maxRunning = 0;
    const execute = async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
    };
    queue.add(execute);
    queue.add(execute);
    queue.add(execute);
    await new Promise((r) => setTimeout(r, 100));
    expect(maxRunning).toBe(3);
  });

  it("retries on failure", async () => {
    const queue = new JobQueue({ maxRetries: 2, baseDelayMs: 10 });
    let attempts = 0;
    queue.add(async () => {
      attempts++;
      if (attempts < 3) throw new Error("fail");
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(attempts).toBe(3);
  });

  it("marks job as failed after max retries", async () => {
    const queue = new JobQueue({ maxRetries: 1, baseDelayMs: 10 });
    queue.add(async () => { throw new Error("always fail"); });
    await new Promise((r) => setTimeout(r, 100));
    const stats = queue.getStats();
    expect(stats.failed).toBe(1);
  });

  it("cancels pending jobs", () => {
    const queue = new JobQueue({ concurrency: 1 });
    queue.add(() => new Promise<void>((r) => { setTimeout(r, 100); }));
    const id2 = queue.add(async () => {});
    queue.cancel(id2);
    const job = queue.getQueue().find((j) => j.id === id2);
    expect(job?.status).toBe("cancelled");
  });

  it("cancels all pending jobs", () => {
    const queue = new JobQueue();
    queue.add(async () => {});
    queue.add(async () => {});
    queue.cancelAll();
    const stats = queue.getStats();
    expect(stats.pending).toBe(0);
  });

  it("returns stats", () => {
    const queue = new JobQueue();
    const stats = queue.getStats();
    expect(stats).toHaveProperty("pending");
    expect(stats).toHaveProperty("running");
    expect(stats).toHaveProperty("completed");
    expect(stats).toHaveProperty("failed");
    expect(stats).toHaveProperty("cancelled");
  });

  it("tracks active count", async () => {
    const queue = new JobQueue({ concurrency: 2 });
    let resolve1: () => void;
    let resolve2: () => void;
    queue.add(() => new Promise<void>((r) => { resolve1 = r; }));
    queue.add(() => new Promise<void>((r) => { resolve2 = r; }));
    await new Promise((r) => setTimeout(r, 20));
    expect(queue.getActiveCount()).toBe(2);
    resolve1!();
    resolve2!();
    await new Promise((r) => setTimeout(r, 50));
    expect(queue.getActiveCount()).toBe(0);
  });
});
