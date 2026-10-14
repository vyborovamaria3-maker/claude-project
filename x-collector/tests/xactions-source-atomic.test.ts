import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { PoolClient } from "pg";
import { source, sourceId } from "../lib/archive/store";

test("XActions HTTP source rows rollback with their checkpoint transaction", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE archive_sources(
      id text PRIMARY KEY,name text,url text,license text,kind text,metadata jsonb
    );`);
    const client = { query: async(sql:string,params:unknown[]=[]) => {
      const r = await db.query(sql,params);
      return { ...r, rowCount:r.affectedRows??r.rows.length };
    }} as unknown as PoolClient;
    const args = ["X HTTP collector","https://x.com/i/api/graphql","X platform terms"] as const;
    const id = sourceId(args[1],args[2],"x");
    await db.exec("BEGIN");
    assert.equal(await source(args[0],args[1],args[2],"x",{ transport:"HTTP GraphQL" },client),id);
    await db.exec("ROLLBACK");
    assert.equal((await db.query("SELECT * FROM archive_sources")).rows.length,0);
    await db.exec("BEGIN");
    assert.equal(await source(args[0],args[1],args[2],"x",{ transport:"HTTP GraphQL" },client),id);
    await db.exec("COMMIT");
    assert.equal((await db.query("SELECT * FROM archive_sources")).rows.length,1);
  } finally { await db.close(); }
});
