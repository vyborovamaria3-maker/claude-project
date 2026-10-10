import type { IntelligenceTask } from './agent-core';

export class TaskOrchestrator {
  private queue: IntelligenceTask[] = [];

  enqueue(task: IntelligenceTask) {
    this.queue.push(task);
  }

  next(): IntelligenceTask | undefined {
    return this.queue
      .sort((a, b) => b.priority - a.priority)
      .shift();
  }

  size() {
    return this.queue.length;
  }
}
