export interface ReasonTraceStep {
  module: string;
  action: string;
  result: string;
}

export interface ReasonTrace {
  steps: ReasonTraceStep[];
}

export function createReasonTrace(steps: ReasonTraceStep[]): ReasonTrace {
  return { steps };
}
