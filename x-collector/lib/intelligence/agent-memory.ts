export type AgentMemoryRecord = {
  key: string;
  value: unknown;
  createdAt: Date;
};

export class AgentMemory {
  private memory = new Map<string, AgentMemoryRecord>();

  remember(key: string, value: unknown) {
    this.memory.set(key, { key, value, createdAt: new Date() });
  }

  recall(key: string) {
    return this.memory.get(key);
  }
}
