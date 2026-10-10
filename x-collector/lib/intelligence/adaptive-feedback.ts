export interface FeedbackSignal {
  component: string;
  previousScore: number;
  newScore: number;
  reason: string;
}

export function createFeedbackSignal(input: {
  component: string;
  previousScore: number;
  newScore: number;
  reason: string;
}): FeedbackSignal {
  return input;
}

export function improveScore(current: number, feedback: FeedbackSignal): number {
  const delta = feedback.newScore - feedback.previousScore;
  return Math.max(0, Math.min(1, current + delta * 0.5));
}
