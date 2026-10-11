import type {PoolClient} from 'pg';

type Client = Pick<PoolClient, 'query'>;

export type EntityScoreInput = {
  entityId: string;
  influence: number;
  authority: number;
  trust: number;
  risk: number;
  activity: number;
  metadata?: Record<string, unknown>;
};

function clamp(value: number) {
  return Math.max(0, Math.min(1, value));
}

export async function saveEntityScore(client: Client, input: EntityScoreInput) {
  await client.query(
    `INSERT INTO ip_entity_scores
      (id, entity_id, influence_score, authority_score, trust_score, risk_score, activity_score, metadata)
     VALUES
      (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT(entity_id, calculation_version)
     DO UPDATE SET
       influence_score=EXCLUDED.influence_score,
       authority_score=EXCLUDED.authority_score,
       trust_score=EXCLUDED.trust_score,
       risk_score=EXCLUDED.risk_score,
       activity_score=EXCLUDED.activity_score,
       metadata=EXCLUDED.metadata,
       calculated_at=now()`,
    [
      input.entityId,
      clamp(input.influence),
      clamp(input.authority),
      clamp(input.trust),
      clamp(input.risk),
      clamp(input.activity),
      JSON.stringify(input.metadata ?? {}),
    ],
  );
}

export function calculateInfluenceScore(input: {
  graphCentrality: number;
  engagement: number;
  activity: number;
  clusterPosition: number;
}) {
  return clamp(
    input.graphCentrality * 0.35 +
      input.engagement * 0.3 +
      input.activity * 0.2 +
      input.clusterPosition * 0.15,
  );
}
