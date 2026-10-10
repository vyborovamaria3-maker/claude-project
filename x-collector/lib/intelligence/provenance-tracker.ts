export interface ProvenanceRecord {
  id: string;
  source: string;
  createdAt: number;
  transformations: string[];
  confidence?: number;
}

const records = new Map<string, ProvenanceRecord>();

export function trackProvenance(record: ProvenanceRecord): void {
  records.set(record.id, record);
}

export function getProvenance(id: string): ProvenanceRecord | undefined {
  return records.get(id);
}

export function listProvenance(): ProvenanceRecord[] {
  return [...records.values()];
}
