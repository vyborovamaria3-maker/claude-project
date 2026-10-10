export type DiscoveredEntity = {
  id: string;
  source: string;
  confidence: number;
};

export function discoverEntities(input: Array<{ id: string; source: string }>): DiscoveredEntity[] {
  return input.map((item) => ({
    id: item.id,
    source: item.source,
    confidence: 0.5,
  }));
}
