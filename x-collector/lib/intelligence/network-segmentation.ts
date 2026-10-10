export type NetworkSegment = {
  name: string;
  entities: string[];
};

export function segmentNetwork(entities: string[][]): NetworkSegment[] {
  return entities.map((items, index) => ({
    name: `segment-${index}`,
    entities: items,
  }));
}
