import assert from "node:assert/strict";
import { test } from "node:test";
import { auditAppliedMigrationChecksums, migrationChecksum } from "../lib/trade/migration-checksum";

test("migration checksum is deterministic SHA-256 over exact SQL text", () => {
  assert.equal(
    migrationChecksum("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.notEqual(migrationChecksum("SELECT 1;\n"), migrationChecksum("SELECT 1;"));
});

test("applied migration with matching checksum passes audit", () => {
  const sql = "CREATE TABLE example(id integer);";
  const checksum = migrationChecksum(sql);
  const audit = auditAppliedMigrationChecksums(
    [{ filename: "001_init.sql", checksum }],
    new Map([["001_init.sql", checksum]]),
  );
  assert.deepEqual(audit, { verified: ["001_init.sql"], needsBaseline: [], errors: [] });
});

test("modified applied SQL is reported as checksum drift", () => {
  const audit = auditAppliedMigrationChecksums(
    [{ filename: "001_init.sql", checksum: migrationChecksum("SELECT 1;") }],
    new Map([["001_init.sql", migrationChecksum("SELECT 2;")]]),
  );
  assert.match(audit.errors.join(" "), /checksum drift detected: 001_init\.sql/);
  assert.deepEqual(audit.needsBaseline, []);
});

test("legacy ledger rows require an explicit checksum baseline", () => {
  const audit = auditAppliedMigrationChecksums(
    [{ filename: "001_init.sql", checksum: null }],
    new Map([["001_init.sql", migrationChecksum("SELECT 1;")]]),
  );
  assert.deepEqual(audit.needsBaseline, ["001_init.sql"]);
  assert.deepEqual(audit.errors, []);
});

test("an applied migration without its SQL file is a hard error", () => {
  const audit = auditAppliedMigrationChecksums(
    [{ filename: "001_removed.sql", checksum: null }],
    new Map(),
  );
  assert.match(audit.errors.join(" "), /no matching SQL file: 001_removed\.sql/);
});