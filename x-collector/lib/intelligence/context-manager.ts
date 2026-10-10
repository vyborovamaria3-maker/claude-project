export interface ContextEntry {
  key: string;
  value: unknown;
  createdAt: number;
}

export class ContextManager {
  private context = new Map<string, ContextEntry>();

  set(key: string, value: unknown): ContextEntry {
    const entry = { key, value, createdAt: Date.now() };
    this.context.set(key, entry);
    return entry;
  }

  get(key: string): ContextEntry | undefined {
    return this.context.get(key);
  }

  clear(): void {
    this.context.clear();
  }
}
