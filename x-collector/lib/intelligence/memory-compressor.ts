export interface MemoryRecord {
  id: string;
  content: string;
  importance?: number;
  createdAt?: string;
}

export interface CompressedMemory {
  id: string;
  summary: string;
  sourceCount: number;
}

export function compressMemory(records: MemoryRecord[]): CompressedMemory[] {
  return records
    .filter((record) => (record.importance ?? 0) >= 0)
    .map((record) => ({
      id: record.id,
      summary: record.content.slice(0, 240),
      sourceCount: 1,
    }));
}
