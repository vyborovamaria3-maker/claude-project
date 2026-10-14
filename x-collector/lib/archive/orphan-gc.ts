import fs from "node:fs/promises";
import path from "node:path";

export interface ArchiveGcResult {
  orphanFiles: number;
  orphanBytes: number;
  deletedFiles: number;
}

/**
 * Content-addressed rawPage() writes a deterministic gzip file *before*
 * committing the DB row. On a rollback an unreferenced file may remain.
 * Never remove it synchronously during rollback: another writer may have
 * committed the same hash. Reap only old, unreferenced files, safely.
 */
export async function reapOrphanArchivePages(
  root: string,
  olderThanMs: number,
  isReferenced: (absolutePath: string) => Promise<boolean>,
  deleteFiles = false,
  now = Date.now(),
): Promise<ArchiveGcResult> {
  if (!Number.isSafeInteger(olderThanMs) || olderThanMs < 0) {
    throw new Error("Archive GC: invalid minimum age");
  }
  const result: ArchiveGcResult = { orphanFiles: 0, orphanBytes: 0, deletedFiles: 0 };
  const directory = path.resolve(root);
  let shards: import("node:fs").Dirent[];
  try { shards = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw error;
  }
  for (const shard of shards) {
    if (!shard.isDirectory() || !/^[0-9a-f]{2}$/.test(shard.name)) continue;
    const shardPath = path.join(directory, shard.name);
    for (const file of await fs.readdir(shardPath, { withFileTypes: true })) {
      // No traversal, symlink or temporary file follows. Only rawPage hashes.
      if (!file.isFile() || !/^[0-9a-f]{64}\.json\.gz$/.test(file.name) ||
          !file.name.startsWith(shard.name)) continue;
      const absolute = path.join(shardPath, file.name);
      const stat = await fs.lstat(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.mtimeMs > now - olderThanMs) continue;
      if (await isReferenced(absolute)) continue;
      result.orphanFiles++;
      result.orphanBytes += stat.size;
      if (deleteFiles) {
        // Repeat the DB query immediately before deletion. A reference could
        // have been committed after the first check.
        if (await isReferenced(absolute)) continue;
        await fs.rm(absolute, { force: true });
        result.deletedFiles++;
      }
    }
  }
  return result;
}
