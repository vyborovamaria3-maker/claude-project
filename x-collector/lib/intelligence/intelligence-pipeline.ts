export interface PipelineStep {
  name: string;
  execute(context: unknown): Promise<unknown>;
}

export class IntelligencePipeline {
  constructor(private readonly steps: PipelineStep[]) {}

  async run(context: unknown): Promise<unknown> {
    let result = context;

    for (const step of this.steps) {
      result = await step.execute(result);
    }

    return result;
  }
}
