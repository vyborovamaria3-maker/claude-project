export type MemoryRecord = {
  key: string;
  value: unknown;
  createdAt: Date;
};

export class ModelMemory {
  private records = new Map<string, MemoryRecord>();

  set(key: string, value: unknown) {
    const record = { key, value, createdAt: new Date() };
    this.records.set(key, record);
    return record;
  }

  get(key: string) {
    return this.records.get(key);
  }
}
