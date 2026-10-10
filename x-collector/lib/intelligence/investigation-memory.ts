export type InvestigationRecord = {
  entityId: string;
  timestamp: number;
  result: unknown;
};

export class InvestigationMemory {
  private records: InvestigationRecord[] = [];

  save(record: InvestigationRecord) {
    this.records.push(record);
  }

  get(entityId: string) {
    return this.records.filter((record) => record.entityId === entityId);
  }
}
