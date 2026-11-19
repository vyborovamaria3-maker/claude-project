import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { assertMigrationChecksum, migrationChecksum } from "../src/migration-checksum.js";

test("migration checksum is stable and rejects edited applied SQL", () => {
  const sql = "CREATE TABLE example (id integer);\n";
  const checksum = migrationChecksum(sql);
  assert.equal(checksum.length, 64);
  assert.equal(migrationChecksum(sql), checksum);
  assert.doesNotThrow(() => assertMigrationChecksum("001_example.sql", checksum, checksum));
  assert.throws(() => assertMigrationChecksum("001_example.sql", checksum, migrationChecksum(sql + "-- changed")),
    /Applied migration checksum mismatch/);
});


test("TG outbox health indexes are an additive, checksum-managed migration",async()=>{
  const sql=await readFile(new URL("../sql/037_intelligence_outbox_health_indexes.sql",import.meta.url),"utf8");
  assert.match(sql,/outbox_pending_health_idx/);
  assert.match(sql,/outbox_dead_lettered_at_idx/);
  assert.match(sql,/outbox_processed_at_desc_idx/);
  assert.equal(migrationChecksum(sql).length,64);
});
