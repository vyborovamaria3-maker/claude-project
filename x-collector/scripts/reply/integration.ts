import { REQUIRED } from "../../lib/trade/migrations";
import { checkCollectorNative } from "../collector/native-check";
import "dotenv/config";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { closePool, getPool, q } from "../../lib/trade/pg";
import { enqueueTask, claimTasks, finishTask } from "../../lib/trade/tasks";
import { pickAccount, releaseAccount } from "../../lib/trade/account-manager";
import { checkArchiveNative } from "../archive/native-check";
import { benchmarkReplyDatabase } from "./db-benchmark";
async function main() {
  const raw = process.env.REPLY_TEST_DATABASE_URL;
  if (!raw) throw new Error("REPLY_TEST_DATABASE_URL is required");
  const url = new URL(raw);
  if (
    !/^postgres(?:ql)?:$/.test(url.protocol) ||
    !decodeURIComponent(url.pathname).endsWith("_test")
  )
    throw new Error("test database name must end with _test");
  const schema = "reply_test_" + randomUUID().replaceAll("-", "");
  const admin = new Pool({ connectionString: raw, max: 1 });
  let created = false;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    created = true;
    url.searchParams.set("options", "-c search_path=" + schema + ",public");
    process.env.DATABASE_URL = url.toString();
    const client = await getPool().connect();
    try {
      for (const file of REQUIRED)
        await client.query(await fs.readFile("migrations/" + file, "utf8"));
    } finally {
      client.release();
    }
    const first = await enqueueTask({
        kind: "search",
        payload: { query: "fixture-a" },
        priority: 10,
      }),
      second = await enqueueTask({
        kind: "search",
        payload: { query: "fixture-b" },
        priority: 1,
      });
    assert(first && second);
    const blocker = await getPool().connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM x_tasks WHERE id=$1 FOR UPDATE", [
      first,
    ]);
    try {
      const [claimed] = await claimTasks("parallel-worker", 1, 60000);
      assert.equal(Number(claimed.id), Number(second));
      assert.equal(await finishTask(claimed.id, "stale-worker"), false);
      assert.equal(await finishTask(claimed.id, "parallel-worker"), true);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
    const [claimed] = await claimTasks("other-worker", 1, 60000);
    assert.equal(Number(claimed.id), Number(first));
    await q(
      "INSERT INTO x_accounts(name,session_encrypted,hour_window_start,created_at,updated_at) VALUES('fixture',$1,0,0,0)",
      [Buffer.from("encrypted-fixture")],
    );
    const results = await Promise.all([
      pickAccount("search", "owner-a"),
      pickAccount("search", "owner-b"),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    const owner = results[0] ? "owner-a" : "owner-b";
    assert.equal(
      await releaseAccount(
        "fixture",
        owner === "owner-a" ? "owner-b" : "owner-a",
      ),
      false,
    );
    assert.equal(await releaseAccount("fixture", owner), true);
    assert.equal(await finishTask(claimed.id,"other-worker"),true);
    await checkArchiveNative();
    await checkCollectorNative();
    await benchmarkReplyDatabase(async (sql,params)=>(await getPool().query(sql,params)).rows);
    console.log(
      "PostgreSQL integration passed: migrations, SKIP LOCKED, parallel account leases, ownership",
    );
  } finally {
    await closePool();
    if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}
main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "PostgreSQL integration failed",
  );
  process.exitCode = 1;
});
