import test from "node:test";
import assert from "node:assert/strict";
import {
  migrationChecksum, validateMigrations, migrateSqlite, migratePostgres,
  MigrationChecksumMismatch,
} from "../dist/index.js";
const migrations = [
  { name: "001_init.sql", sql: "CREATE TABLE IF NOT EXISTS example (id INTEGER PRIMARY KEY)" },
  { name: "002_detail.sql", sql: "CREATE TABLE IF NOT EXISTS details (id INTEGER PRIMARY KEY)" },
];

test("deterministic checksums and safe filenames", () => {
  assert.equal(migrationChecksum("x"), migrationChecksum("x"));
  assert.notEqual(migrationChecksum("x"), migrationChecksum("X"));
  assert.throws(() => validateMigrations([migrations[0],migrations[0]]), /Duplicate/);
  assert.throws(() => validateMigrations([{name:"../escape.sql",sql:"SELECT 1"}]), /Invalid migration/);
  assert.throws(() => validateMigrations([{name:"003_empty.sql",sql:" "}]), /Empty migration/);
});

function fakeSqlite() {
  const applied = new Map();
  const statements = [];
  return {
    applied, statements,
    exec(sql) { statements.push(sql); },
    prepare(sql) {
      if (sql.startsWith("SELECT")) return { all: () => [...applied].map(([name,checksum])=>({name,checksum})) };
      if (sql.startsWith("INSERT")) return { run: (name,checksum) => { applied.set(name, checksum); }};
      throw new Error("Unexpected prepared statement " + sql);
    },
  };
}
test("SQLite: apply, idempotent replay, checksum mismatch, rollback", () => {
  const db = fakeSqlite();
  assert.deepEqual(migrateSqlite(db, migrations).applied, ["001_init.sql","002_detail.sql"]);
  assert.deepEqual(migrateSqlite(db, migrations).unchanged, ["001_init.sql","002_detail.sql"]);
  assert.throws(()=>migrateSqlite(db,[migrations[0],{...migrations[1],sql:"SELECT 1"}]),MigrationChecksumMismatch);
  assert.equal(db.statements.at(-1), "ROLLBACK");
  assert.throws(()=>migrateSqlite(db,[migrations[0]]),/missing from manifest/);
});

function fakePg() {
  const applied = new Map();
  const log = [];
  return {
    applied,log,
    async connect() {
      return {
        async query(sql,params=[]) {
          log.push(sql);
          if (sql.startsWith("SELECT name")) return {rows:[...applied].map(([name,checksum])=>({name,checksum}))};
          if (sql.startsWith("INSERT")) applied.set(params[0],params[1]);
          return {rows:[]};
        },
        release(){log.push("RELEASE")},
      };
    },
  };
}
test("Postgres: transactional/idempotent checks with rollback on mismatch", async () => {
  const pool = fakePg();
  assert.deepEqual((await migratePostgres(pool,migrations)).applied,["001_init.sql","002_detail.sql"]);
  assert.deepEqual((await migratePostgres(pool,migrations)).unchanged,["001_init.sql","002_detail.sql"]);
  await assert.rejects(migratePostgres(pool,[migrations[0],{...migrations[1],sql:"SELECT 1"}]),MigrationChecksumMismatch);
  assert.equal(pool.log.at(-2),"ROLLBACK");
  assert.equal(pool.log.at(-1),"RELEASE");
});
