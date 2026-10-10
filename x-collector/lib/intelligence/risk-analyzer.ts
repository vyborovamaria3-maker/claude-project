export type RiskInput = {
  entityId: string;
  anomalyScore: number;
  unknownConnections: number;
  activitySpike: number;
};

export function calculateRisk(input: RiskInput) {
  const risk = Math.min(1,
    input.anomalyScore * 0.45 +
    Math.min(input.unknownConnections, 100) / 100 * 0.35 +
    input.activitySpike * 0.2
  );

  return {
    entityId: input.entityId,
    riskScore: risk,
    factors: {
      anomaly: input.anomalyScore,
      unknownConnections: input.unknownConnections,
      activitySpike: input.activitySpike
    }
  };
}
