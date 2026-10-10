export type TimelineEvent = {
  entityId: string;
  timestamp: number;
  type: string;
  data: Record<string, unknown>;
};

export function buildTimeline(events: TimelineEvent[]) {
  return [...events].sort((a, b) => a.timestamp - b.timestamp);
}
