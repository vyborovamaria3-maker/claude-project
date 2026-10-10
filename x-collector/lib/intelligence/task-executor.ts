export interface ExecutionResult {
  taskId: string;
  success: boolean;
  output?: unknown;
}

export class IntelligenceTaskExecutor {
  async execute(taskId: string, handler: () => Promise<unknown>): Promise<ExecutionResult> {
    try {
      return { taskId, success: true, output: await handler() };
    } catch (error) {
      return { taskId, success: false, output: error instanceof Error ? error.message : error };
    }
  }
}
