export type RelationshipSignal = {
  from: string;
  to: string;
  signals: number;
};

export function inferRelationshipStrength(signal: RelationshipSignal) {
  return Math.min(1, Number((signal.signals / 100).toFixed(2)));
}
