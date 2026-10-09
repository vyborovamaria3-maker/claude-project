import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
test("CSV conversion preserves large IDs, missing metrics and explicit date filtering", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "archive-csv-"));
    try {
        const input = path.join(root, "tweets.csv"), output = path.join(root, "tweets.jsonl");
        await fs.writeFile(input, "tweet_id,text,date,likes,views,user_id,username\n1234567890123456789,token,2025-01-01,7,,9999999999999999999,author\n2,old,2020-01-01,1,2,3,old\n");
        await run(process.platform === "win32" ? "python" : "python3", ["scripts/archive/convert-tweets.py", "--input", input, "--out", output, "--start", "2024-10-08", "--end", "2026-10-09"]);
        const row = JSON.parse(await fs.readFile(output, "utf8"));
        assert.equal(row.id, "1234567890123456789");
        assert.equal(row.author_id, "9999999999999999999");
        assert.equal(row.public_metrics.like_count, 7);
        assert(!("impression_count" in row.public_metrics));
        await fs.writeFile(input, "text,date\nmissing-id,2025-01-01\n");
        await assert.rejects(run(process.platform === "win32" ? "python" : "python3", ["scripts/archive/convert-tweets.py", "--input", input, "--out", output]));
        assert.equal(JSON.parse(await fs.readFile(output, "utf8")).id, "1234567890123456789");
    }
    finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});
