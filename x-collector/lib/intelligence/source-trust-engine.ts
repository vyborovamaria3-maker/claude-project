export type SourceProfile = {
  source: string;
  reliability: number;
  historicalAccuracy: number;
};

export function calculateSourceTrust(source: SourceProfile) {
  return Math.min(1, source.reliability * 0.6 + source.historicalAccuracy * 0.4);
}
