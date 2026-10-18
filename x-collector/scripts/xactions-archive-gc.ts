import fs from "node:fs/promises";
import { q, q1, closePool } from "../lib/trade/pg";
import { reapOrphanArchivePages } from "../lib/archive/orphan-gc";

interface ExpiredRawPage {
  hash: string;
  source_id: string;
  path: string;
}

async function expireRawPages(deleteFiles: boolean) {
  const expired = await q<ExpiredRawPage>(
    "SELECT hash,source_id,path FROM archive_raw_pages WHERE expires_at <= now() ORDER BY expires_at LIMIT 1000",
  );
  const paths = [...new Set(expired.map(row => row.path))];
  let candidateFiles = 0;
  let candidateBytes = 0;
  let deletedFiles = 0;
  let deletedBytes = 0;
  let deletedRows = 0;
  let sharedFiles = 0;
  let missingFiles = 0;

  for (const absolutePath of paths) {
    const activeReference = await q1<{ present: number }>(
      "SELECT 1 AS present FROM archive_raw_pages WHERE path=$1 AND expires_at > now() LIMIT 1",
      [absolutePath],
    );
    if (activeReference) {
      sharedFiles++;
      if (deleteFiles) {
        const removed = await q(
          "DELETE FROM archive_raw_pages WHERE path=$1 AND expires_at <= now() RETURNING hash,source_id",
          [absolutePath],
        );
        deletedRows += removed.length;
      }
      continue;
    }

    let bytes = 0;
    try {
      bytes = (await fs.stat(absolutePath)).size;
      candidateFiles++;
      candidateBytes += bytes;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      missingFiles++;
    }

    if (!deleteFiles) continue;
    try {
      await fs.unlink(absolutePath);
      deletedFiles++;
      deletedBytes += bytes;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
    const removed = await q(
      "DELETE FROM archive_raw_pages WHERE path=$1 AND expires_at <= now() RETURNING hash,source_id",
      [absolutePath],
    );
    deletedRows += removed.length;
  }

  return {
    expiredRows: expired.length,
    distinctExpiredPaths: paths.length,
    candidateFiles,
    candidateBytes,
    deletedFiles,
    deletedBytes,
    deletedRows,
    sharedFiles,
    missingFiles,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(arg => arg !== "--delete")) {
    throw new Error("Usage: npm run xactions:archive-gc -- [--delete]");
  }
  const deleteFiles = args.includes("--delete");
  const directory = process.env.ARCHIVE_RAW_DIR ?? "data/archive/raw";

  // Expired rows are only removed in explicit --delete mode. A file still
  // referenced by any unexpired row is kept even if another reference expired.
  const expired = await expireRawPages(deleteFiles);

  // A 24-hour grace period protects in-flight transactions and local restarts.
  const orphans = await reapOrphanArchivePages(directory, 24 * 60 * 60 * 1000,
    async absolutePath => {
      const row = await q1("SELECT 1 FROM archive_raw_pages WHERE path=$1 LIMIT 1", [absolutePath]);
      return Boolean(row);
    }, deleteFiles);

  console.log(JSON.stringify({
    mode: deleteFiles ? "delete-expired-and-old-unreferenced" : "dry-run",
    expired,
    orphanFiles: orphans.orphanFiles,
    orphanBytes: orphans.orphanBytes,
    deletedOrphanFiles: orphans.deletedFiles,
  }, null, 2));
}
main().catch(error => {
  console.error(error instanceof Error ? error.message : "Archive GC failed");
  process.exitCode = 1;
}).finally(() => closePool());
