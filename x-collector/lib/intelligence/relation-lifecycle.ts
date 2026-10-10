export type RelationLifecycleState = 'ACTIVE' | 'WEAKENED' | 'REMOVED';

export interface RelationLifecycleRecord {
  relationId: string;
  state: RelationLifecycleState;
  changedAt: number;
  confidence?: number;
}

export class RelationLifecycleTracker {
  private records: RelationLifecycleRecord[] = [];

  update(record: RelationLifecycleRecord) {
    this.records.push(record);
    return record;
  }

  getHistory(relationId: string) {
    return this.records.filter((record) => record.relationId === relationId);
  }
}
