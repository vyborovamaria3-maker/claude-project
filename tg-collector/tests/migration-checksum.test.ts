import assert from "node:assert/strict";
import { test } from "node:test";
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
