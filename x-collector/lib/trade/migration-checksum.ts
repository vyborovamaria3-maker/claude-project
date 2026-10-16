import { createHash } from "node:crypto";

export interface AppliedMigrationChecksum {
  filename: string;
  checksum: string | null;
}

export interface MigrationChecksumAudit {
  verified: string[];
  needsBaseline: string[];
  errors: string[];
}

/** SHA-256 of the exact UTF-8 SQL text that the migration runner executes. */
export function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

/**
 * Compare every applied ledger entry with the exact SQL file currently in the
 * migration directory. Null checksums are legacy entries requiring an explicit
 * one-time baseline; a missing file or a non-null mismatch is a hard error.
 */
export function auditAppliedMigrationChecksums(
  applied: readonly AppliedMigrationChecksum[],
  currentChecksums: ReadonlyMap<string, string>,
): MigrationChecksumAudit {
  const verified: string[] = [];
  const needsBaseline: string[] = [];
  const errors: string[] = [];

  for (const row of applied) {
    if (!currentChecksums.has(row.filename)) {
      errors.push("Applied migration has no matching SQL file: " + row.filename);
      continue;
    }
    if (row.checksum === null) {
      needsBaseline.push(row.filename);
      continue;
    }
    if (row.checksum !== currentChecksums.get(row.filename)) {
      errors.push("Migration checksum drift detected: " + row.filename);
      continue;
    }
    verified.push(row.filename);
  }

  return { verified, needsBaseline, errors };
}