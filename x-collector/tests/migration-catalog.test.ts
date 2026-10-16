import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { REQUIRED } from "../lib/trade/migrations";
import { assertMigrationCatalog, auditMigrationCatalog, EXCLUDED_MIGRATIONS } from "../lib/trade/migration-catalog";

test("full tracked SQL directory is explicitly classified before migrating",async()=>{
  const files=await fs.readdir("migrations");
  const inventory=assertMigrationCatalog(files);
  assert.equal(inventory.errors.length,0);
  assert.equal(inventory.appliedOrder.length,REQUIRED.length);
  assert.deepEqual(inventory.collisions.map(x=>x.sequence),["012","013","014","036"]);
  assert.equal(inventory.excluded.length,8);
  assert.equal(Object.keys(EXCLUDED_MIGRATIONS).length,8);
  assert(inventory.appliedOrder.indexOf("012_reply_guy.sql") >
    inventory.appliedOrder.indexOf("014_signals_engine.sql"),
    "legacy numbering is non-monotonic but order is explicit");
  assert(!inventory.appliedOrder.includes("030_intelligence_jobs.sql"));
});

test("a new SQL migration cannot silently enter the directory",async()=>{
  const files=await fs.readdir("migrations");
  const unknown=auditMigrationCatalog([...files,"046_silent.sql"]);
  assert(unknown.errors.some(s=>s.includes("Unregistered SQL migration")&&s.includes("046_silent.sql")));
  const collision=auditMigrationCatalog([...files,"012_surprise.sql"]);
  assert(collision.errors.some(s=>s.includes("Undocumented numeric migration collision 012")));
  const missing=auditMigrationCatalog(files.filter(s=>s!=="039_list_checkpoints.sql"));
  assert(missing.errors.some(s=>s.includes("Missing required SQL migration: 039_list_checkpoints.sql")));
  const removedLegacy=auditMigrationCatalog(files.filter(s=>s!=="030_intelligence_jobs.sql"));
  assert(removedLegacy.errors.some(s=>s.includes("Missing documented excluded SQL migration")));
  assert.throws(()=>assertMigrationCatalog([...files,"047_unregistered.sql"]),/Migration inventory mismatch/);
});
