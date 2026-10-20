import { checkClaimOptions, validateOutboxEvent, type ClaimOptions, type ClaimedEvent, type OutboxEvent } from "./contract.js";

export type SqliteStatement = {
  all(...args: unknown[]): unknown[];
  get(...args: unknown[]): unknown;
  run(...args: unknown[]): { changes: number };
};
export type SqliteDb = { exec(sql: string): unknown; prepare(sql: string): SqliteStatement };

export function emitSqlite(db: SqliteDb, event: OutboxEvent, createdAt = new Date()): void {
  validateOutboxEvent(event);
  const date = createdAt.toISOString();
  // Caller MUST invoke this inside its primary-write transaction.
  db.prepare(`INSERT INTO outbox_events
    (source_system,event_kind,event_key,schema_version,payload,created_at,next_attempt_at)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(source_system,event_kind,event_key) DO NOTHING`)
    .run(event.sourceSystem,event.eventKind,event.eventKey,event.schemaVersion,
      JSON.stringify(event.payload),date,date);
}

function rowToEvent(row: Record<string, unknown>, leaseOwner: string, leaseUntil: string): ClaimedEvent {
  return {
    id:String(row.id),sourceSystem:String(row.source_system) as OutboxEvent["sourceSystem"],
    eventKind:String(row.event_kind),eventKey:String(row.event_key),
    schemaVersion:String(row.schema_version),payload:JSON.parse(String(row.payload)) as Record<string,unknown>,
    attempts:Number(row.attempts),leaseOwner,leaseUntil,
  };
}

/**
 * Atomic SQLite claim: BEGIN IMMEDIATE prevents concurrent selection/writes.
 * External ETL happens AFTER COMMIT; every claim has expiring ownership.
 */
export function claimSqlite(db: SqliteDb, options: ClaimOptions): ClaimedEvent[] {
  const now=checkClaimOptions(options), stamp=now.toISOString();
  const leaseUntil=new Date(now.getTime()+options.leaseMs).toISOString();
  db.exec("BEGIN IMMEDIATE");
  let open=true;
  try {
    const rows=db.prepare(`SELECT * FROM outbox_events
      WHERE processed_at IS NULL AND dead_lettered_at IS NULL
        AND next_attempt_at <= ?
        AND (lease_until IS NULL OR lease_until <= ?)
      ORDER BY id LIMIT ?`).all(stamp,stamp,options.batchSize) as Record<string,unknown>[];
    const stmt=db.prepare(`UPDATE outbox_events SET lease_owner=?,lease_until=? WHERE id=?`);
    for (const row of rows) stmt.run(options.workerId,leaseUntil,row.id);
    db.exec("COMMIT");open=false;
    return rows.map(row=>rowToEvent(row,options.workerId,leaseUntil));
  } catch(error) {
    if(open) {try{db.exec("ROLLBACK")}catch{/* preserve */}}
    throw error;
  }
}

export function ackSqlite(db: SqliteDb, id: string, owner: string, leaseUntil: string, now = new Date()): boolean {
  const stamp=now.toISOString();
  return db.prepare(`UPDATE outbox_events SET processed_at=?,lease_owner=NULL,lease_until=NULL
    WHERE id=? AND lease_owner=? AND lease_until=? AND lease_until>?
    AND processed_at IS NULL AND dead_lettered_at IS NULL`)
    .run(stamp,id,owner,leaseUntil,stamp).changes===1;
}

export function failSqlite(db: SqliteDb, id: string, owner: string, leaseUntil: string, reason: string,
                           nextAttemptAt: Date, now=new Date(), maxAttempts=12): boolean {
  if(!Number.isInteger(maxAttempts)||maxAttempts<1) throw new RangeError("maxAttempts");
  const stamp=now.toISOString();
  return db.prepare(`UPDATE outbox_events SET
    attempts=attempts+1,last_error=?,
    dead_lettered_at=CASE WHEN attempts+1 >= ? THEN ? ELSE NULL END,
    next_attempt_at=?,lease_owner=NULL,lease_until=NULL
    WHERE id=? AND lease_owner=? AND lease_until=? AND lease_until>?
    AND processed_at IS NULL AND dead_lettered_at IS NULL`)
    .run(reason.slice(0,1000),maxAttempts,stamp,nextAttemptAt.toISOString(),id,owner,leaseUntil,stamp).changes===1;
}


/** Extend exactly one live claim, returning its new fencing timestamp. */
export function renewSqlite(
  db: SqliteDb, id: string, owner: string, leaseUntil: string, leaseMs: number,
  now = new Date(),
): string | null {
  if (!Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 3_600_000 ||
      !Number.isFinite(now.getTime())) throw new RangeError("Invalid leaseMs/now");
  const prior = new Date(leaseUntil).getTime();
  if (!Number.isFinite(prior)) throw new RangeError("Invalid leaseUntil");
  const stamp = now.toISOString();
  const next = new Date(Math.max(prior, now.getTime() + leaseMs)).toISOString();
  const result = db.prepare(\`UPDATE outbox_events SET lease_until=?
    WHERE id=? AND lease_owner=? AND lease_until=? AND lease_until>?
      AND processed_at IS NULL AND dead_lettered_at IS NULL\`)
    .run(next, id, owner, leaseUntil, stamp);
  return result.changes === 1 ? next : null;
}
