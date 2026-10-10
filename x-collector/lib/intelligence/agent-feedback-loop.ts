export type AgentFeedback = {
  taskId: string;
  outcome: 'success' | 'failed';
  confidence: number;
};

export class AgentFeedbackLoop {
  private history: AgentFeedback[] = [];

  record(feedback: AgentFeedback) {
    this.history.push(feedback);
  }

  getPerformance() {
    if (!this.history.length) return 0;

    const score = this.history.reduce((sum, item) => {
      return sum + (item.outcome === 'success' ? item.confidence : 0);
    }, 0);

    return score / this.history.length;
  }
}
