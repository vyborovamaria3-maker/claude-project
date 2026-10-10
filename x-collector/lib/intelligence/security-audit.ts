export interface SecurityAuditEvent {
  actorId: string;
  action: string;
  resource: string;
  timestamp: Date;
}

const events: SecurityAuditEvent[] = [];

export function recordSecurityEvent(event: SecurityAuditEvent): void {
  events.push(event);
}

export function getSecurityEvents(): SecurityAuditEvent[] {
  return [...events];
}
