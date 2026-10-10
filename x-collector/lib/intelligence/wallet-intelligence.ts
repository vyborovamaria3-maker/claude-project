import type { Pool } from 'pg';

export type WalletProfileInput = {
  entityId: string;
  walletAgeDays?: number;
  firstSeenAt?: Date;
  lastActivityAt?: Date;
  fundingSources?: Record<string, unknown>;
  tokenExposure?: Record<string, unknown>;
  counterparties?: Record<string, unknown>;
  riskScore?: number;
  metadata?: Record<string, unknown>;
};

/**
 * Stores analytical wallet profiles linked to graph entities.
 * Blockchain ingestion should remain responsible for collecting raw transfers;
 * this service enriches already resolved wallet entities.
 */
export class WalletIntelligenceService {
  constructor(private readonly db: Pool) {}

  async upsertProfile(input: WalletProfileInput) {
    await this.db.query(
      `INSERT INTO ip_wallet_profiles
       (entity_id, wallet_age_days, first_seen_at, last_activity_at,
        funding_sources, token_exposure, counterparties, risk_score, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (entity_id) DO UPDATE SET
        wallet_age_days = EXCLUDED.wallet_age_days,
        first_seen_at = EXCLUDED.first_seen_at,
        last_activity_at = EXCLUDED.last_activity_at,
        funding_sources = EXCLUDED.funding_sources,
        token_exposure = EXCLUDED.token_exposure,
        counterparties = EXCLUDED.counterparties,
        risk_score = EXCLUDED.risk_score,
        metadata = EXCLUDED.metadata,
        updated_at = now()`,
      [
        input.entityId,
        input.walletAgeDays ?? null,
        input.firstSeenAt ?? null,
        input.lastActivityAt ?? null,
        JSON.stringify(input.fundingSources ?? {}),
        JSON.stringify(input.tokenExposure ?? {}),
        JSON.stringify(input.counterparties ?? {}),
        input.riskScore ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
  }

  async getProfile(entityId: string) {
    const result = await this.db.query(
      `SELECT * FROM ip_wallet_profiles WHERE entity_id = $1`,
      [entityId],
    );

    return result.rows[0] ?? null;
  }
}
