import { RawMember, ActivityScore, FilterConfig, DEFAULT_FILTER_CONFIG, scoreActivity, filterMembers } from "./tginvite-filter";

export interface WorkerRequest {
  id: string;
  type: "parse" | "filter" | "score";
  payload: unknown;
}

export interface WorkerResponse {
  id: string;
  type: "parse" | "filter" | "score";
  result: unknown;
  error?: string;
}

function handleParse(members: RawMember[]): { members: RawMember[]; scores: ActivityScore[] } {
  const scores = members.map((m) => scoreActivity(m));
  return { members, scores };
}

function handleFilter(members: RawMember[], config?: FilterConfig) {
  return filterMembers(members, config ?? DEFAULT_FILTER_CONFIG);
}

function handleScore(members: RawMember[]) {
  return members.map((m) => scoreActivity(m));
}

if (typeof self !== "undefined") {
  self.onmessage = (event: MessageEvent<WorkerRequest>) => {
    const { id, type, payload } = event.data;
    try {
      let result: unknown;
      switch (type) {
        case "parse":
          result = handleParse(payload as RawMember[]);
          break;
        case "filter": {
          const data = payload as { members: RawMember[]; config?: FilterConfig };
          result = handleFilter(data.members, data.config);
          break;
        }
        case "score":
          result = handleScore(payload as RawMember[]);
          break;
        default:
          throw new Error(`Unknown worker task type: ${type}`);
      }
      self.postMessage({ id, type, result } as WorkerResponse);
    } catch (err: unknown) {
      self.postMessage({ id, type, result: null, error: (err as Error).message } as WorkerResponse);
    }
  };
}

export class TgInviteWorker {
  private worker: Worker | null = null;
  private pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private idCounter = 0;

  constructor() {
    this.initWorker();
  }

  private initWorker(): void {
    if (typeof window === "undefined") return;
    try {
      this.worker = new Worker(
        new URL("./tginvite-worker-exec.ts", import.meta.url),
        { type: "module" }
      );
      this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const { id, result, error } = event.data;
        const entry = this.pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timeout);
        this.pending.delete(id);
        if (error) {
          entry.reject(new Error(error));
        } else {
          entry.resolve(result);
        }
      };
      this.worker.onerror = (event) => {
        console.error("TgInviteWorker error:", event.message);
      };
    } catch {
      console.warn("Web Worker not available, falling back to main thread");
    }
  }

  async parse(members: RawMember[], timeoutMs = 30000): Promise<{ members: RawMember[]; scores: ActivityScore[] }> {
    return this.runTask("parse", members, timeoutMs) as Promise<{ members: RawMember[]; scores: ActivityScore[] }>;
  }

  async filter(members: RawMember[], config?: FilterConfig, timeoutMs = 30000) {
    return this.runTask("filter", { members, config }, timeoutMs);
  }

  async score(members: RawMember[], timeoutMs = 30000): Promise<ActivityScore[]> {
    return this.runTask("score", members, timeoutMs) as Promise<ActivityScore[]>;
  }

  private runTask(type: string, payload: unknown, timeoutMs: number): Promise<unknown> {
    if (!this.worker) {
      return this.fallbackTask(type, payload);
    }

    const id = `task_${++this.idCounter}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Worker task timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timeout });
      this.worker!.postMessage({ id, type, payload });
    });
  }

  private fallbackTask(type: string, payload: unknown): Promise<unknown> {
    switch (type) {
      case "parse":
        return Promise.resolve(handleParse(payload as RawMember[]));
      case "filter": {
        const data = payload as { members: RawMember[]; config?: FilterConfig };
        return Promise.resolve(handleFilter(data.members, data.config));
      }
      case "score":
        return Promise.resolve(handleScore(payload as RawMember[]));
      default:
        return Promise.reject(new Error(`Unknown task: ${type}`));
    }
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timeout);
      entry.reject(new Error("Worker terminated"));
    }
    this.pending.clear();
  }
}

let instance: TgInviteWorker | null = null;

export function getTgInviteWorker(): TgInviteWorker {
  if (!instance) {
    instance = new TgInviteWorker();
  }
  return instance;
}
