export type CascadeEvent = {
  from: string;
  to: string;
  strength: number;
};

export function analyzeCascade(events: CascadeEvent[]) {
  const strength = events.reduce((sum, e) => sum + e.strength, 0);
  return {
    eventCount: events.length,
    averageStrength: events.length ? strength / events.length : 0,
  };
}
