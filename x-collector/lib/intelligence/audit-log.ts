export type AuditEntry = {
  action: string;
  entityId?: string;
  details?: Record<string, unknown>;
  createdAt: string;
};

const entries: AuditEntry[] = [];

export function addAuditEntry(entry: Omit<AuditEntry, 'createdAt'>) {
  entries.push({ ...entry, createdAt: new Date().toISOString() });
}

export function getAuditLog() {
  return [...entries];
}
