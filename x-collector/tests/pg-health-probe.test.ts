import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { Pool } from "pg";
import { checkDatabase, closePool } from "../lib/trade/pg";

test("many health requests share one pending PostgreSQL probe and recover", async () => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgresql://fixture/health_singleflight_test";
  let finish: (() => void) | undefined;
  let probes = 0;
  const query = mock.method(Pool.prototype, "query", async () => {
    probes++;
    if (probes > 1) return { rows: [{ "?column?": 1 }], rowCount: 1 };
    await new Promise<void>(resolve => { finish = resolve; });
    return { rows: [{ "?column?": 1 }], rowCount: 1 };
  });
  try {
    const first = checkDatabase(20);
    const second = checkDatabase(50);
    await assert.rejects(first, /database health timeout/);
    assert.equal(probes, 1, "timed out health request must not spawn a second pooled query");
    finish?.();
    await second;
    await checkDatabase(50);
    assert.equal(probes, 2, "next probe starts after the previous query settles");
    await assert.rejects(checkDatabase(0), /Invalid database health timeout/);
  } finally {
    finish?.();
    query.mock.restore();
    await closePool();
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});
