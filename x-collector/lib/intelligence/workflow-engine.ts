export interface WorkflowContext {
  workflowId: string;
  data: Record<string, unknown>;
}

export interface WorkflowResult {
  workflowId: string;
  success: boolean;
  output?: unknown;
}

export class IntelligenceWorkflowEngine {
  async run(context: WorkflowContext, steps: Array<(ctx: WorkflowContext) => Promise<unknown>>): Promise<WorkflowResult> {
    let output: unknown = context.data;
    try {
      for (const step of steps) {
        output = await step({ ...context, data: { output } });
      }
      return { workflowId: context.workflowId, success: true, output };
    } catch (error) {
      return { workflowId: context.workflowId, success: false, output: error instanceof Error ? error.message : error };
    }
  }
}
