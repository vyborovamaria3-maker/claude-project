export type BlockchainRiskSignal = {
  wallet: string;
  score: number;
  factors: string[];
};

export function calculateBlockchainRisk(input: {
  wallet: string;
  anomalyScore?: number;
  unknownCounterparties?: number;
}): BlockchainRiskSignal {
  const anomaly = input.anomalyScore ?? 0;
  const counterparties = Math.min((input.unknownCounterparties ?? 0) / 100, 1);
  const score = Number(Math.min(anomaly * 0.7 + counterparties * 0.3, 1).toFixed(2));

  return {
    wallet: input.wallet,
    score,
    factors: [
      ...(anomaly > 0.5 ? ['high_activity_anomaly'] : []),
      ...(counterparties > 0.5 ? ['unknown_counterparties'] : [])
    ]
  };
}
