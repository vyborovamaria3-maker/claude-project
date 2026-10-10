export type NetworkSignal = {
  entityId: string;
  interactions: number;
  connectedNodes: number;
};

export function calculateViralPotential(signal: NetworkSignal) {
  return Math.min(1, signal.interactions / 100 * 0.6 + signal.connectedNodes / 100 * 0.4);
}
