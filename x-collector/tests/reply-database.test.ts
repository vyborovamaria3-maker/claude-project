import { test } from "node:test";
import fs from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { benchmarkReplyDatabase } from "../scripts/reply/db-benchmark";
test("Reply database indexes improve real plans on a disposable workload", async () => {
  const db = new PGlite();
  try {
    await db.exec(await fs.readFile("migrations/012_reply_guy.sql","utf8"));
    await db.exec(await fs.readFile("migrations/013_reply_performance.sql","utf8"));
    await benchmarkReplyDatabase(async (sql,params)=>(await db.query(sql,params)).rows);
    // The additive migration can be replayed without changing data.
    await db.exec(await fs.readFile("migrations/013_reply_performance.sql","utf8"));
  } finally { await db.close(); }
});
