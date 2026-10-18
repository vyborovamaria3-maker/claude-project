import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { Pool } from "pg";
import { AmbiguousCommitError, closePool, isAmbiguousPgCommit, tx } from "../lib/trade/pg";
import { taskFailure } from "../lib/trade/task-errors";

test("lost COMMIT outcome never replays a PostgreSQL write, even on ECONNREFUSED", async () => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgresql://fixture/ambiguous_commit_test";
  let transactions = 0, writes = 0;
  const discarded: boolean[] = [];
  const connection = mock.method(Pool.prototype, "connect", async () => {
    transactions++;
    return {
      query: async (statement: string) => {
        if (statement === "INSERT INTO fixture VALUES (1)") { writes++; return { rows: [], rowCount: 1 }; }
        if (statement === "COMMIT") {
          throw Object.assign(new Error("network operation failed"), { code: "ECONNREFUSED" });
        }
        return { rows: [], rowCount: 0 };
      },
      release: (discard: boolean) => { discarded.push(discard); },
    };
  });
  try {
    await assert.rejects(tx(async client => {
      await client.query("INSERT INTO fixture VALUES (1)");
    }), AmbiguousCommitError);
    assert.equal(transactions, 1, "never retry an uncertain COMMIT");
    assert.equal(writes, 1, "no duplicated SQL effect");
    assert.deepEqual(discarded, [true], "discard the uncertain connection");
  } finally {
    connection.mock.restore();
    await closePool();
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});

test("server-confirmed COMMIT serialization abort can safely retry the whole transaction", async () => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgresql://fixture/serialization_test";
  let transactions = 0, writes = 0;
  const connection = mock.method(Pool.prototype, "connect", async () => {
    const serial = ++transactions;
    return {
      query: async (statement: string) => {
        if (statement === "INSERT INTO fixture VALUES (1)") writes++;
        if (statement === "COMMIT" && serial === 1) {
          throw Object.assign(new Error("could not serialize"), { code: "40001" });
        }
        return { rows: [], rowCount: 1 };
      },
      release: () => {},
    };
  });
  try {
    await tx(async client => { await client.query("INSERT INTO fixture VALUES (1)"); });
    assert.equal(transactions, 2);
    assert.equal(writes, 2, "second write follows PostgreSQL-aborted transaction");
  } finally {
    connection.mock.restore();
    await closePool();
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});

test("COMMIT errors with no SQLSTATE are uncertain, but known constraint errors are not", () => {
  assert.equal(isAmbiguousPgCommit(new Error("socket hang up")), true);
  assert.equal(isAmbiguousPgCommit(Object.assign(new Error("lost"), { code: "EPIPE" })), true);
  assert.equal(isAmbiguousPgCommit(Object.assign(new Error("deadlock"), { code: "40P01" })), false);
  assert.equal(isAmbiguousPgCommit(Object.assign(new Error("unique"), { code: "23505" })), false);
});

test("an uncertain SQL COMMIT is not an X session or proxy failure", () => {
  const result = taskFailure(new AmbiguousCommitError(Object.assign(
    new Error("connection refused"), { code: "ECONNREFUSED" },
  )));
  assert.equal(result.code, "DB_COMMIT_UNCERTAIN");
  assert.equal(result.permanent, false);
  assert(result.retryAfterMs >= 60_000);
});
