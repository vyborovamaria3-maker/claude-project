import { q1, closePool } from "../lib/trade/pg";
import { reapOrphanArchivePages } from "../lib/archive/orphan-gc";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(arg => arg !== "--delete")) {
    throw new Error("Usage: npm run xactions:archive-gc -- [--delete]");
  }
  const deleteFiles = args.includes("--delete");
  const directory = process.env.ARCHIVE_RAW_DIR ?? "data/archive/raw";
  // A 24-hour grace period protects in-flight transactions and local restarts.
  // No cleanup ever occurs unless --delete was explicitly supplied.
  const result = await reapOrphanArchivePages(directory, 24 * 60 * 60 * 1000,
    async absolutePath => {
      const row = await q1("SELECT 1 FROM archive_raw_pages WHERE path=$1 LIMIT 1", [absolutePath]);
      return Boolean(row);
    }, deleteFiles);
  console.log(JSON.stringify({
    mode: deleteFiles ? "delete-old-unreferenced-only" : "dry-run",
    orphanFiles: result.orphanFiles,
    orphanBytes: result.orphanBytes,
    deletedFiles: result.deletedFiles,
  }, null, 2));
}
main().catch(error => {
  console.error(error instanceof Error ? error.message : "Archive GC failed");
  process.exitCode = 1;
}).finally(() => closePool());
