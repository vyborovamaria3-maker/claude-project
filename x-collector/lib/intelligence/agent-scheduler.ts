import type { AgentTask } from './agent-runtime';

export class AgentScheduler {
  private queue: AgentTask[] = [];

  add(task: AgentTask) {
    this.queue.push(task);
    this.queue.sort((a, b) => b.priority - a.priority);
  }

  next() {
    return this.queue.shift();
  }

  size() {
    return this.queue.length;
  }
}
