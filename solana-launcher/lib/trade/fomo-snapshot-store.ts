import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getDb } from "./db";
import { ensureFomoSnapshotSchema } from "./fomo-snapshot-schema";

export type FomoSnapshotRecord = {
  snapshotId: string;
  canonicalTokenId: string;
  mint: string;
  signalAt: number;
  maxInputObservedAt: number;
  bucketStartAt: number;
  scoreVersion: string;
  fomoPressure: number;
  fomoQuality: number;
  qualityCoverage: number;
  xCoverage: "complete" | "partial" | "unknown";
  tgCoverage: "complete" | "partial" | "unknown";
  sourceCoverageKnownAt: number;
  xObservedAt: number;
  tgObservedAt: number;
  xSampleCount: number;
  xMatchedCount: number;
  xTruncated: 0 | 1;
  xCached: 0 | 1;
  tgSampleCount: number;
  tgMatchedCount: number;
  tgTruncated: 0 | 1;
  captureConfigJson: string;
  sourceMetaJson: string;
  xInputSha256: string;
  tgInputSha256: string;
  inputSha256: string;
  snapshotSha256: string;
  createdAt: number;
};

export type CaptureRunStatus = "captured" | "duplicate" | "failed";
export type SourceAttemptStatus = "unknown" | "available" | "unavailable";

export function beginFomoCaptureAttempt(mint: string, requestedAt = Date.now()): string {
  const db = getDb();
  ensureFomoSnapshotSchema(db);
  const runId = randomUUID();
  db.prepare(
    `INSERT INTO fomo_snapshot_capture_runs
       (run_id,mint,requested_at,status,x_status,tg_status,created_at)
     VALUES(?,?,?,'running','unknown','unknown',?)`,
  ).run(runId, mint, requestedAt, requestedAt);
  return runId;
}

export function finishFomoCaptureAttempt(args: {
  runId: string;
  completedAt?: number;
  status: CaptureRunStatus;
  xStatus?: SourceAttemptStatus;
  tgStatus?: SourceAttemptStatus;
  failureCode?: string | null;
  snapshotId?: string | null;
}): void {
  const db = getDb();
  ensureFomoSnapshotSchema(db);
  db.prepare(
    `UPDATE fomo_snapshot_capture_runs
     SET completed_at=?, status=?, x_status=?, tg_status=?, failure_code=?, snapshot_id=?
     WHERE run_id=?`,
  ).run(
    args.completedAt ?? Date.now(),
    args.status,
    args.xStatus ?? "unknown",
    args.tgStatus ?? "unknown",
    args.failureCode ?? null,
    args.snapshotId ?? null,
    args.runId,
  );
}

export function hasFomoSnapshotInBucket(
  canonicalTokenId: string,
  scoreVersion: string,
  bucketStartAt: number,
): boolean {
  const db = getDb();
  ensureFomoSnapshotSchema(db);
  const row = db.prepare(
    `SELECT 1 AS found FROM fomo_score_snapshots
     WHERE canonical_token_id=? AND score_version=? AND bucket_start_at=? LIMIT 1`,
  ).get(canonicalTokenId, scoreVersion, bucketStartAt) as { found: number } | undefined;
  return Boolean(row);
}

export function insertFomoSnapshotWithDb(
  db: Database.Database,
  record: FomoSnapshotRecord,
): { inserted: boolean; snapshotId: string } {
  ensureFomoSnapshotSchema(db);
  const result = db.prepare(
    `INSERT OR IGNORE INTO fomo_score_snapshots (
      snapshot_id,canonical_token_id,mint,signal_at,max_input_observed_at,bucket_start_at,
      score_version,fomo_pressure,fomo_quality,quality_coverage,x_coverage,tg_coverage,
      source_coverage_known_at,x_observed_at,tg_observed_at,x_sample_count,x_matched_count,
      x_truncated,x_cached,tg_sample_count,tg_matched_count,tg_truncated,capture_config_json,
      source_meta_json,x_input_sha256,tg_input_sha256,input_sha256,snapshot_sha256,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    record.snapshotId,
    record.canonicalTokenId,
    record.mint,
    record.signalAt,
    record.maxInputObservedAt,
    record.bucketStartAt,
    record.scoreVersion,
    record.fomoPressure,
    record.fomoQuality,
    record.qualityCoverage,
    record.xCoverage,
    record.tgCoverage,
    record.sourceCoverageKnownAt,
    record.xObservedAt,
    record.tgObservedAt,
    record.xSampleCount,
    record.xMatchedCount,
    record.xTruncated,
    record.xCached,
    record.tgSampleCount,
    record.tgMatchedCount,
    record.tgTruncated,
    record.captureConfigJson,
    record.sourceMetaJson,
    record.xInputSha256,
    record.tgInputSha256,
    record.inputSha256,
    record.snapshotSha256,
    record.createdAt,
  );
  if (result.changes > 0) return { inserted: true, snapshotId: record.snapshotId };

  const existing = db.prepare(
    `SELECT snapshot_id AS snapshotId FROM fomo_score_snapshots
     WHERE canonical_token_id=? AND score_version=? AND bucket_start_at=?`,
  ).get(record.canonicalTokenId, record.scoreVersion, record.bucketStartAt) as
    { snapshotId: string } | undefined;
  if (!existing) throw new Error("snapshot_insert_conflict");
  return { inserted: false, snapshotId: existing.snapshotId };
}

export function insertFomoSnapshot(record: FomoSnapshotRecord) {
  return insertFomoSnapshotWithDb(getDb(), record);
}
