import { checkClaimOptions, validateOutboxEvent, type ClaimOptions, type ClaimedEvent, type OutboxEvent } from "./contract.js";

export type PgQuery = {
  query(sql: string, params?: readonly unknown[]): Promise<{rows: Record<string, unknown>[];rowCount?: number|null}>;
};
export type PgClient = PgQuery & {release(): void};
export type PgPool = { connect(): Promise<PgClient> };

function mapRow(row: Record<string, unknown>): ClaimedEvent {
  return {
    id: String(row.id), sourceSystem: String(row.source_system) as OutboxEvent["sourceSystem"],
    eventKind: String(row.event_kind), eventKey: String(row.event_key),
    schemaVersion: String(row.schema_version),
    payload: row.payload as Record<string, unknown>,
    attempts: Number(row.attempts), leaseOwner: String(row.lease_owner),
    leaseUntil: (row.lease_until instanceof Date ? row.lease_until : new Date(String(row.lease_until))).toISOString(),
  };
}

/** Call within SAME transaction/connection as primary write. Never independently commit. */
export async function emitPostgres(client: PgQuery, event: OutboxEvent): Promise<void> {
  validateOutboxEvent(event);
  await client.query(`INSERT INTO outbox_events
    (source_system,event_kind,event_key,schema_version,payload)
    VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (source_system,event_kind,event_key) DO NOTHING`,
    [event.sourceSystem,event.eventKind,event.eventKey,event.schemaVersion,JSON.stringify(event.payload)]);
}

/** Claims are committed before the consumer handles external writes. */
export async function claimPostgres(pool: PgPool, options: ClaimOptions): Promise<ClaimedEvent[]> {
  const now = checkClaimOptions(options), client = await pool.connect();
  let open = false;
  try {
    await client.query("BEGIN"); open = true;
    const rows = await client.query(`WITH candidates AS (
      SELECT id FROM outbox_events
      WHERE processed_at IS NULL AND dead_lettered_at IS NULL
        AND next_attempt_at <= $1
        AND (lease_until IS NULL OR lease_until <= $1)
      ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED
    )
    UPDATE outbox_events AS o SET lease_owner=$3, lease_until=$4
    FROM candidates AS c WHERE o.id=c.id
    RETURNING o.*`, [
      now.toISOString(), options.batchSize, options.workerId,
      new Date(now.getTime()+options.leaseMs).toISOString(),
    ]);
    await client.query("COMMIT"); open = false;
    return rows.rows.map(mapRow);
  } catch (error) {
    if (open) {try{await client.query("ROLLBACK");}catch{ /* preserve cause */ }}
    throw error;
  } finally {client.release();}
}

export async function ackPostgres(client: PgQuery, id: string, owner: string, leaseUntil: string): Promise<boolean> {
  const result = await client.query(`UPDATE outbox_events SET processed_at=NOW(),
    lease_owner=NULL, lease_until=NULL
    WHERE id=$1 AND lease_owner=$2 AND lease_until=$3::timestamptz AND lease_until>NOW()
      AND processed_at IS NULL AND dead_lettered_at IS NULL RETURNING id`,[id,owner,leaseUntil]);
  return result.rows.length === 1;
}

export async function failPostgres(
  client: PgQuery, id: string, owner: string, leaseUntil: string, reason: string,
  nextAttemptAt: Date, maxAttempts = 12,
): Promise<boolean> {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new RangeError("maxAttempts");
  const result = await client.query(`UPDATE outbox_events SET
    attempts=attempts+1, last_error=$3,
    dead_lettered_at=CASE WHEN attempts+1 >= $5 THEN NOW() ELSE NULL END,
    next_attempt_at=$4, lease_owner=NULL, lease_until=NULL
    WHERE id=$1 AND lease_owner=$2 AND lease_until=$6::timestamptz AND lease_until>NOW()
      AND processed_at IS NULL AND dead_lettered_at IS NULL RETURNING id`,
    [id,owner,reason.slice(0,1000),nextAttemptAt.toISOString(),maxAttempts,leaseUntil]);
  return result.rows.length === 1;
}


/**
 * Renew only the exact still-active claim. The returned database timestamp
 * becomes the next fencing token for ACK/NACK/renew; never reuse the old one.
 * Keeping this operation in the source database avoids cross-DB locks.
 */
export async function renewPostgres(
  client: PgQuery, id: string, owner: string, leaseUntil: string, leaseMs: number,
): Promise<string | null> {
  if (!Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 3_600_000) {
    throw new RangeError("Invalid leaseMs");
  }
  const result = await client.query(`UPDATE outbox_events
    SET lease_until=GREATEST(lease_until, NOW() + ($4::integer * interval '1 millisecond'))
    WHERE id=$1 AND lease_owner=$2 AND lease_until=$3::timestamptz
      AND lease_until>NOW() AND processed_at IS NULL AND dead_lettered_at IS NULL
    RETURNING lease_until`, [id, owner, leaseUntil, leaseMs]);
  const value = result.rows[0]?.lease_until;
  return value === undefined ? null :
    (value instanceof Date ? value : new Date(String(value))).toISOString();
}
