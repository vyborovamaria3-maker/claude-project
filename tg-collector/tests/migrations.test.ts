import "dotenv/config";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { pool } from "../src/db.js";

test("legacy duplicate jobs are archived and safely restarted before UNIQUE", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const sql = await readFile(new URL("../sql/001_init.sql",import.meta.url),"utf8");
  const schema = "tg_migration_" + randomUUID().replaceAll("-", "").slice(0,16);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    await client.query(sql);
    const source = await client.query<{id:string}>(
      "INSERT INTO tg_sources(identifier) VALUES($1) RETURNING id::text", ["legacy_123456"]);
    const id = source.rows[0].id;
    await client.query("DROP INDEX tg_jobs_source_unique_idx");
    await client.query(`INSERT INTO tg_jobs(source_id,state,scanned_count,cursor_before_id)
      VALUES ($1,'pending',15,5),($1,'failed',40,2)`,[id]);
    await client.query(sql);
    const remaining = await client.query<{count:number;state:string;scanned_count:number}>(
      "SELECT count(*) OVER()::integer AS count,state,scanned_count FROM tg_jobs WHERE source_id=$1",[id]);
    assert.equal(remaining.rows.length,1);
    assert.equal(remaining.rows[0].state,"pending");
    assert.equal(remaining.rows[0].scanned_count,0);
    const archive = await client.query<{count:number}>(
      "SELECT count(*)::integer AS count FROM tg_jobs_dedup_archive WHERE source_id=$1",[id]);
    assert.equal(archive.rows[0].count,1);
    // Re-running must not alter the reconciled job.
    await client.query(sql);
    const stable = await client.query("SELECT id FROM tg_jobs WHERE source_id=$1",[id]);
    assert.equal(stable.rowCount,1);
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});
