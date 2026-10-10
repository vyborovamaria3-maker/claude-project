export interface WorkflowStep {
  id: string;
  name: string;
}

export interface WorkflowDefinition {
  id: string;
  steps: WorkflowStep[];
}

export class WorkflowBuilder {
  create(id: string, steps: WorkflowStep[]): WorkflowDefinition {
    return { id, steps };
  }
}
