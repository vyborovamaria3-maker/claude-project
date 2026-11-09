import type Database from "better-sqlite3";

export type WalletSummaryStatus = {
  ready: boolean;
  reason: "ready" | "not_initialized" | "stale";
  sourceSignature: string;
  storedSignature: string | null;
};

export function parseWalletPageSize(raw: string | null): number {
  const value = raw?.trim() ?? "";
  if (!/^-?\d+$/.test(value)) return 100;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return 100;
  return Math.max(1, Math.min(parsed, 500));
}

export function parseWalletPageOffset(raw: string | null): number {
  const value = raw?.trim() ?? "";
  if (!/^\d+$/.test(value)) return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return 0;
  return Math.min(parsed, 100_000);
}

function currentSourceSignature(db: Database.Database): string {
  const source = db.prepare(`
    SELECT
      COALESCE(MAX(rowid), 0) AS max_rowid,
      (SELECT revision FROM database_source_revisions WHERE name = 'migration_wallet_rows') AS revision
    FROM migration_wallet_rows
  `).get() as { max_rowid: number; revision: number | null };
  return `${source.max_rowid ?? 0}:${source.revision ?? 0}`;
}

function ensureWalletSummarySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS database_wallet_summary (
      wallet TEXT PRIMARY KEY,
      avg_pnl REAL,
      avg_roi REAL,
      avg_wr REAL,
      avg_migrated_pct REAL,
      avg_fast_trades_pct REAL,
      avg_total_tokens REAL,
      avg_migrated_tokens REAL,
      total_rockets INTEGER,
      reports INTEGER,
      source_signature TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_database_wallet_summary_pnl ON database_wallet_summary(avg_pnl DESC);
    CREATE INDEX IF NOT EXISTS idx_database_wallet_summary_roi ON database_wallet_summary(avg_roi DESC);
    CREATE INDEX IF NOT EXISTS idx_database_wallet_summary_wr ON database_wallet_summary(avg_wr DESC);
    CREATE INDEX IF NOT EXISTS idx_database_wallet_summary_migrated ON database_wallet_summary(avg_migrated_pct DESC);
    CREATE INDEX IF NOT EXISTS idx_database_wallet_summary_reports ON database_wallet_summary(reports DESC);
    CREATE TABLE IF NOT EXISTS database_wallet_summary_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

export function getWalletSummaryStatus(db: Database.Database): WalletSummaryStatus {
  const tables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table'
      AND name IN ('database_wallet_summary', 'database_wallet_summary_meta', 'database_source_revisions', 'migration_wallet_rows')
  `).all() as Array<{ name: string }>;
  const names = new Set(tables.map((row) => row.name));
  const sourceSignature = names.has("database_source_revisions") && names.has("migration_wallet_rows")
    ? currentSourceSignature(db)
    : "0:0";

  if (!names.has("database_wallet_summary") || !names.has("database_wallet_summary_meta")
      || !names.has("database_source_revisions") || !names.has("migration_wallet_rows")) {
    return { ready: false, reason: "not_initialized", sourceSignature, storedSignature: null };
  }

  const stored = db.prepare(
    "SELECT value FROM database_wallet_summary_meta WHERE key = 'source_signature'",
  ).get() as { value: string } | undefined;
  const storedSignature = stored?.value ?? null;
  const ready = storedSignature === sourceSignature;
  return {
    ready,
    reason: ready ? "ready" : "stale",
    sourceSignature,
    storedSignature,
  };
}

/**
 * Rebuild the expensive wallet aggregate outside read paths. The IMMEDIATE
 * transaction serializes competing import/rebuild processes and rechecks the
 * source revision after acquiring the write lock, avoiding duplicate rebuilds.
 */
export function rebuildWalletSummary(db: Database.Database): {
  rebuilt: boolean;
  sourceSignature: string;
  rows: number;
} {
  ensureWalletSummarySchema(db);

  const rebuild = db.transaction(() => {
    const sourceSignature = currentSourceSignature(db);
    const stored = db.prepare(
      "SELECT value FROM database_wallet_summary_meta WHERE key = 'source_signature'",
    ).get() as { value: string } | undefined;

    if (stored?.value === sourceSignature) {
      const count = db.prepare("SELECT COUNT(*) AS count FROM database_wallet_summary").get() as { count: number };
      return { rebuilt: false, sourceSignature, rows: count.count };
    }

    db.prepare("DELETE FROM database_wallet_summary").run();
    db.prepare(`
      INSERT INTO database_wallet_summary (
        wallet,
        avg_pnl,
        avg_roi,
        avg_wr,
        avg_migrated_pct,
        avg_fast_trades_pct,
        avg_total_tokens,
        avg_migrated_tokens,
        total_rockets,
        reports,
        source_signature
      )
      SELECT
        wallet,
        AVG(pnl) AS avg_pnl,
        AVG(roi) AS avg_roi,
        AVG(wr) AS avg_wr,
        AVG(migrated_pct) AS avg_migrated_pct,
        AVG(fast_trades_pct) AS avg_fast_trades_pct,
        AVG(total_tokens) AS avg_total_tokens,
        AVG(migrated_tokens) AS avg_migrated_tokens,
        SUM(COALESCE(rockets, 0)) AS total_rockets,
        COUNT(*) AS reports,
        ? AS source_signature
      FROM migration_wallet_rows
      WHERE wallet IS NOT NULL AND wallet != ''
      GROUP BY wallet
    `).run(sourceSignature);
    db.prepare(`
      INSERT INTO database_wallet_summary_meta (key, value)
      VALUES ('source_signature', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(sourceSignature);

    const count = db.prepare("SELECT COUNT(*) AS count FROM database_wallet_summary").get() as { count: number };
    return { rebuilt: true, sourceSignature, rows: count.count };
  });

  return rebuild.immediate();
}
