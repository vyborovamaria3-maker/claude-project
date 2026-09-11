type EventHandler<T = unknown> = (data: T) => void;

interface ListenerEntry {
  handler: EventHandler;
  once: boolean;
}

export class EventEmitter {
  private listeners = new Map<string, Set<ListenerEntry>>();

  on<T = unknown>(event: string, handler: EventHandler<T>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    const entry: ListenerEntry = { handler: handler as EventHandler, once: false };
    this.listeners.get(event)!.add(entry);
    return () => this.off(event, entry);
  }

  once<T = unknown>(event: string, handler: EventHandler<T>): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add({ handler: handler as EventHandler, once: true });
  }

  off(event: string, entry: ListenerEntry): void {
    this.listeners.get(event)?.delete(entry);
    if (this.listeners.get(event)?.size === 0) {
      this.listeners.delete(event);
    }
  }

  emit<T = unknown>(event: string, data: T): void {
    const entries = this.listeners.get(event);
    if (!entries) return;
    const toRemove: ListenerEntry[] = [];
    for (const entry of entries) {
      try {
        entry.handler(data);
      } catch (err) {
        console.error(`EventEmitter error in "${event}":`, err);
      }
      if (entry.once) toRemove.push(entry);
    }
    for (const entry of toRemove) {
      entries.delete(entry);
    }
  }

  removeAllListeners(event?: string): void {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

export const tginviteEvents = new EventEmitter();

export enum TGEvent {
  IMPORT_START = "import:start",
  IMPORT_PROGRESS = "import:progress",
  IMPORT_PAUSE = "import:pause",
  IMPORT_RESUME = "import:resume",
  IMPORT_COMPLETE = "import:complete",
  IMPORT_ERROR = "import:error",
  IMPORT_CANCEL = "import:cancel",
  MEMBERS_PARSED = "members:parsed",
  MEMBERS_FILTERED = "members:filtered",
  JOB_ADDED = "job:added",
  JOB_UPDATED = "job:updated",
  RATE_LIMITED = "rate:limited",
  FLOOD_WAIT = "flood:wait",
}
