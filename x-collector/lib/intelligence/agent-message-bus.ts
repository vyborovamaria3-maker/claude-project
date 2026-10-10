export type AgentMessageType =
  | 'FACT_DISCOVERED'
  | 'RELATION_FOUND'
  | 'RISK_SIGNAL'
  | 'ANALYSIS_REQUEST'
  | 'CONTEXT_UPDATE';

export interface AgentMessage {
  type: AgentMessageType;
  source: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export class AgentMessageBus {
  private messages: AgentMessage[] = [];

  publish(message: AgentMessage) {
    this.messages.push(message);
    return message;
  }

  consume(type?: AgentMessageType) {
    return type ? this.messages.filter((m) => m.type === type) : [...this.messages];
  }
}
