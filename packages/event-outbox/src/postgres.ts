import { checkClaimOptions, validateOutboxEvent, type ClaimOptions, type ClaimedEvent, type OutboxEvent } from "./contract.js";

export type PgQuery = {
  query(sql: string, params?: readonly unknown[]): Promise<{rows: Record<string, unknown>[];rowCount?: number|null}>;
};
export type PgClient = PgQuery & {release(): void};
export type PgPool = { connect(): Promise<PgClient> };

function databaseTimestampToIso(value: unknown, field: string): string {
  const date = value instanceof Date
    ? value
    : typeof value === "string" && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
      ? new Date(value)
      : null;
  if (!date || !Number.isFinite(date.getTime())) {
    throw new TypeError("Invalid outbox " + field + " timestamp");
  }
  return date.toISOString();
}

function mapRow(row: Record<string, unknown>): ClaimedEvent {
  return {
    id: String(row.id), createdAt: databaseTimestampToIso(row.created_at, "created_at"),
    sourceSystem: String(row.source_system) as OutboxEvent["sourceSystem"],
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
    (source_system,event_kind,event_key,schema_version,payload,created_at)
    VALUES ($1,$2,$3,$4,$5::jsonb,clock_timestamp())
    ON CONFLICT (source_system,event_kind,event_key) DO NOTHING`,
    [event.sourceSystem,event.eventKind,event.eventKey,event.schemaVersion,JSON.stringify(event.payload)]);
}

/** Claims are committed before the consumer handles external writes. */
export async function claimPostgres(pool: PgPool, options: ClaimOptions): Promise<ClaimedEvent[]> {
  const checkedNow=checkClaimOptions(options);
  // The source database owns created_at/next_attempt_at. Use its full-
  // precision statement clock for eligibility so a just-committed row cannot
  // sit idle for the remainder of the current millisecond. Lease timestamps
  // are rounded separately because the fencing token crosses JS Date (ms).
  // Keep an explicit clock override for deterministic tests.
  const explicitNow=options.now===undefined?null:checkedNow.toISOString();
  const claimTime="COALESCE($1::timestamptz, statement_timestamp())";
  const leaseStart=`DATE_TRUNC('milliseconds', ${claimTime})`;
  const client = await pool.connect();
  let open = false;
  try {
    await client.query("BEGIN"); open = true;
    const rows = await client.query(`WITH candidates AS (
      SELECT id FROM outbox_events
      WHERE processed_at IS NULL AND dead_lettered_at IS NULL
        AND next_attempt_at <= ${claimTime}
        AND (lease_until IS NULL OR lease_until <= ${claimTime})
      ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED
    )
    UPDATE outbox_events AS o SET lease_owner=$3,
      lease_until=${leaseStart} + ($4::integer * interval '1 millisecond')
    FROM candidates AS c WHERE o.id=c.id
    RETURNING o.*`, [
      explicitNow, options.batchSize, options.workerId, options.leaseMs,
    ]);
    // Validate every claimed row before COMMIT so malformed source metadata
    // cannot strand a row under a lease that the caller never received.
    const claimed = rows.rows.map(mapRow);
    await client.query("COMMIT"); open = false;
    return claimed;
  } catch (error) {
    if (open) {try{await client.query("ROLLBACK");}catch{ /* preserve cause */ }}
    throw error;
  } finally {client.release();}
}

export async function ackPostgres(client: PgQuery, id: string, owner: string, leaseUntil: string): Promise<boolean> {
  const result = await client.query(`UPDATE outbox_events SET processed_at=clock_timestamp(),
    lease_owner=NULL, lease_until=NULL
    WHERE id=$1 AND lease_owner=$2 AND lease_until=$3::timestamptz AND lease_until>clock_timestamp()
      AND processed_at IS NULL AND dead_lettered_at IS NULL RETURNING id`,[id,owner,leaseUntil]);
  return result.rows.length === 1;
}

export async function failPostgres(
  client: PgQuery, id: string, owner: string, leaseUntil: string, reason: string,
  nextAttemptAt: Date, maxAttempts = 12, retryDelayMs?: number,
): Promise<boolean> {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new RangeError("maxAttempts");
  if (retryDelayMs !== undefined &&
      (!Number.isInteger(retryDelayMs) || retryDelayMs < 1000 || retryDelayMs > 3_600_000)) {
    throw new RangeError("retryDelayMs");
  }
  const result = await client.query(`UPDATE outbox_events SET
    attempts=attempts+1, last_error=$3,
    dead_lettered_at=CASE WHEN attempts+1 >= $5 THEN clock_timestamp() ELSE NULL END,
    next_attempt_at=CASE WHEN $7::integer IS NULL THEN $4::timestamptz
      ELSE DATE_TRUNC('milliseconds', statement_timestamp()) + ($7::integer * interval '1 millisecond') END,
    lease_owner=NULL, lease_until=NULL
    WHERE id=$1 AND lease_owner=$2 AND lease_until=$6::timestamptz AND lease_until>clock_timestamp()
      AND processed_at IS NULL AND dead_lettered_at IS NULL RETURNING id`,
    [id,owner,reason.slice(0,1000),nextAttemptAt.toISOString(),maxAttempts,leaseUntil,retryDelayMs??null]);
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
    SET lease_until=GREATEST(lease_until, DATE_TRUNC('milliseconds', clock_timestamp()) + ($4::integer * interval '1 millisecond'))
    WHERE id=$1 AND lease_owner=$2 AND lease_until=$3::timestamptz
      AND lease_until>clock_timestamp() AND processed_at IS NULL AND dead_lettered_at IS NULL
    RETURNING lease_until`, [id, owner, leaseUntil, leaseMs]);
  const value = result.rows[0]?.lease_until;
  return value === undefined ? null :
    (value instanceof Date ? value : new Date(String(value))).toISOString();
}
