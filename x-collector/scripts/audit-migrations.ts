import fs from "node:fs/promises";
import path from "node:path";
import { auditMigrationCatalog } from "../lib/trade/migration-catalog";

async function main(): Promise<void> {
  const files = await fs.readdir(path.resolve(process.cwd(), "migrations"));
  const report = auditMigrationCatalog(files);
  console.log(JSON.stringify(report, null, 2));
  if (report.errors.length) process.exitCode = 1;
}
main().catch(error => {
  console.error("Cannot inspect migration directory:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
