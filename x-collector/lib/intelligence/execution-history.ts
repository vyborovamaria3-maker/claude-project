export interface ExecutionRecord {
  taskId: string;
  startedAt: string;
  finishedAt?: string;
  success: boolean;
}

export class ExecutionHistory {
  private records: ExecutionRecord[] = [];

  add(record: ExecutionRecord) {
    this.records.push(record);
  }

  list() {
    return [...this.records];
  }
}
