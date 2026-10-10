export type AgentEvent =
  | 'AGENT_STARTED'
  | 'TASK_ASSIGNED'
  | 'TASK_COMPLETED'
  | 'KNOWLEDGE_UPDATED'
  | 'ALERT_CREATED';

export interface IntelligenceEvent {
  event: AgentEvent;
  agent: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export function createAgentEvent(
  event: AgentEvent,
  agent: string,
  metadata?: Record<string, unknown>
): IntelligenceEvent {
  return {
    event,
    agent,
    timestamp: new Date(),
    metadata,
  };
}
