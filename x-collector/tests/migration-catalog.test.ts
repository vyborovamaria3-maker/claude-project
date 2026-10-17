import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";
import { REQUIRED } from "../lib/trade/migrations";
import { EXCLUDED_MIGRATIONS, assertMigrationCatalog, auditMigrationCatalog } from "../lib/trade/migration-catalog";

test("all tracked SQL migrations are classified before database access", async () => {
  const files = await fs.readdir("migrations");
  const inventory = assertMigrationCatalog(files);
  assert.equal(inventory.errors.length, 0);
  assert.equal(inventory.appliedOrder.length, REQUIRED.length);
  assert.equal(REQUIRED.at(-1), REQUIRED.includes("047_signal_quality_marts.sql") ? "047_signal_quality_marts.sql" : "046_tweet_token_linker.sql");
  assert.deepEqual(inventory.collisions.map(item => item.sequence), ["012", "013", "014", "036"]);
  assert.equal(inventory.excluded.length, Object.keys(EXCLUDED_MIGRATIONS).length);
  assert(inventory.appliedOrder.includes("044_browser_checkpoints.sql"));
  assert(inventory.appliedOrder.includes("045_collector_trace.sql"));
  assert(inventory.appliedOrder.includes("046_tweet_token_linker.sql"));
  assert(!REQUIRED.includes("047_signal_quality_marts.sql") || REQUIRED.indexOf("046_tweet_token_linker.sql") < REQUIRED.indexOf("047_signal_quality_marts.sql"));
  assert(inventory.appliedOrder.includes("047_signal_quality_marts.sql"));
});

test("new or missing SQL cannot silently change the migration graph", async () => {
  const files = await fs.readdir("migrations");
  assert(auditMigrationCatalog([...files, "046_unregistered.sql"]).errors.some(error =>
    error.includes("Unregistered SQL migration") && error.includes("046_unregistered.sql")));
  assert(auditMigrationCatalog([...files, "012_surprise.sql"]).errors.some(error =>
    error.includes("Undocumented numeric migration collision 012")));
  assert(auditMigrationCatalog(files.filter(file => file !== "039_list_checkpoints.sql")).errors.some(error =>
    error.includes("Missing required SQL migration: 039_list_checkpoints.sql")));
  assert(auditMigrationCatalog(files.filter(file => file !== "030_intelligence_jobs.sql")).errors.some(error =>
    error.includes("Missing documented excluded SQL migration")));
});
