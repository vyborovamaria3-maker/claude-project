export type ProfileResult = { durationMs: number; heapDeltaBytes: number; rssDeltaBytes: number };
export class Profiler {
  private starts = new Map<string, { time: number; heap: number; rss: number }>();
  private results: Record<string, ProfileResult> = {};
  start(name: string) {
    const memory = process.memoryUsage();
    this.starts.set(name, { time: performance.now(), heap: memory.heapUsed, rss: memory.rss });
  }
  end(name: string): ProfileResult | null {
    const start = this.starts.get(name); if (!start) return null;
    const memory = process.memoryUsage();
    const result = { durationMs: performance.now() - start.time, heapDeltaBytes: memory.heapUsed - start.heap, rssDeltaBytes: memory.rss - start.rss };
    this.results[name] = result; this.starts.delete(name); return result;
  }
  report() { return { ...this.results }; }
}
