import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import http from "node:http";
import { createRequire } from "node:module";
import { chromium } from "playwright";
import { handleArchiveRequest } from "../lib/archive/http";
import { applySecurityHeaders } from "../lib/trade/http-security";
import { Pool } from "pg";
import { q1, closePool } from "../lib/trade/pg";
import { Page, windows, addresses } from "../lib/archive/model";
import { source, rawPage, storePage } from "../lib/archive/store";
import { planArchive, collectArchivePage, Job, archivePath } from "../lib/archive/jobs";
import { importArchive } from "../lib/archive/import";
import { XClient } from "../lib/reply/x-api";
const mint = "So11111111111111111111111111111111111111112";
test("archive range, numeric IDs, metrics and literal addresses fail closed", () => {
    assert.equal(windows("2024-10-08T00:00:00Z", "2024-10-10T00:00:00Z").length, 2);
    assert.throws(() => windows("bad", "2024-10-10"));
    assert.throws(() => Page.parse({ data: [{ id: 123, text: "lossy id", created_at: "2025-01-01" }] }));
    assert.deepEqual(addresses(mint + " " + mint), [mint]);
    assert.deepEqual(addresses("A".repeat(45)), []);
    const p = archivePath({ id: "1", source_id: "x", query: "solana", start_at: "2024-10-08", end_at: "2024-10-09", next_token: "page-2" });
    assert(new URL(p, "https://api.x.com").searchParams.has("start_time"));
    assert(p.includes("next_token=page-2"));
});
test("archive pagination, provenance, graph, snapshots and resumable import use production SQL", async () => {
    const db = new PGlite(), root = await fs.mkdtemp(path.join(os.tmpdir(), "archive-test-"));
    const old = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://fixture/archive_test";
    const query = async (sql: string, params: unknown[] = []) => { const r = await db.query(sql, params); return { rows: r.rows, rowCount: r.affectedRows || r.rows.length }; };
    const a = mock.method(Pool.prototype, "query", query), b = mock.method(Pool.prototype, "connect", async () => ({ query, release() { }, on() { } }));
    try {
        await db.exec(await fs.readFile("migrations/014_archive.sql", "utf8"));
        await db.exec(await fs.readFile("migrations/018_ai_foundation.sql", "utf8"));
        assert.equal(await planArchive("solana", "2024-10-08", "2024-10-09"), 1);
        assert.equal(await planArchive("solana", "2024-10-08", "2024-10-09"), 0);
        let job = (await q1<Job>("SELECT * FROM archive_jobs LIMIT 1"))!;
        const client = new XClient({ access_token: "fixture" }, undefined, async (url) => ({ status: 200, headers: {}, data: { data: [{ id: "1234567890123456789", author_id: "9", conversation_id: "1234567890123456789", text: "Token " + mint, created_at: "2024-10-08T01:00:00Z", public_metrics: { like_count: 7 }, note_post:{text:"Token "+mint,entities:{mentions:[{id:"11",username:"longNoteMention"}]}}, referenced_posts: [{ id: "2", type: "replied_to" }] }], includes: { users: [{ id: "9", username: "author" }] }, meta: url.searchParams.has("next_token") ? {} : { next_token: "next" } } }));
        await collectArchivePage(job, client, root);
        job = (await q1<Job>("SELECT * FROM archive_jobs LIMIT 1"))!;
        assert.equal(job.next_token, "next");
        await collectArchivePage(job, client, root);
        const state = (await db.query<{
            state: string;
            pages: number;
        }>("SELECT * FROM archive_jobs")).rows[0];
        assert.equal(state.state, "done");
        assert.equal(Number(state.pages), 2);
        assert.equal((await db.query("SELECT * FROM archive_posts")).rows.length, 1);
        const metric = (await db.query<{
            views: null;
            likes: number;
        }>("SELECT * FROM archive_metrics LIMIT 1")).rows[0];
        assert.equal(metric.views, null);
        assert.equal(Number(metric.likes), 7);
        assert.equal((await db.query("SELECT * FROM archive_edges")).rows.length, 2);
        const rawFiles = (await db.query<{
            path: string;
        }>("SELECT path FROM archive_raw_pages")).rows;
        for (const file of rawFiles)
            assert((await fs.stat(file.path)).size > 0);
        // Dataset without capture timestamps must never imply historical metric availability.
        const dataset = await source("fixture tweets", "https://fixture.invalid/data", "CC0-1.0", "tweets");
        const file = path.join(root, "tweets.jsonl");
        await fs.writeFile(file, JSON.stringify({ id: "3", author_id: "10", text: mint, created_at: "2024-10-08T02:00:00Z", public_metrics: { like_count: 5 } }) + "\n");
        await importArchive(file, dataset, "tweets", root);
        assert.equal((await importArchive(file, dataset, "tweets", root)).resumed, true);
        assert.equal((await db.query("SELECT * FROM archive_metrics WHERE post_id='3' AND metrics_observed_at IS NULL")).rows.length, 1);
        const tokenSource = await source("tokens", "https://fixture.invalid/tokens", "Apache-2.0", "tokens");
        const tokenFile = path.join(root, "tokens.jsonl");
        await fs.writeFile(tokenFile, JSON.stringify({ token: mint, created_at: "2025-01-01", average_price_0: 0.1, trades_0: 12, captured_at: "2025-01-01", max_return_1h: 4 }) + "\n");
        await importArchive(tokenFile, tokenSource, "tokens", root);
        assert.equal((await db.query("SELECT * FROM archive_price_samples")).rows.length, 1);
        const snapshot = (await db.query<{
            features: Record<string, unknown>;
            labels: Record<string, unknown>;
        }>("SELECT features,labels FROM archive_token_records")).rows[0];
        assert(!("max_return_1h" in snapshot.features));
        assert.equal(snapshot.labels.max_return_1h, 4);
        assert.equal((await db.query("SELECT * FROM archive_author_connections")).rows.length, 1);
        const invalid = path.join(root, "invalid.jsonl");
        await fs.writeFile(invalid, '{"id":42}\n');
        await assert.rejects(importArchive(invalid, dataset, "tweets", root), /invalid dataset record/);
        const received = new Date(), p = Page.parse({ data: [{ id: "4", text: "fresh", created_at: "2024-10-08", author_id: "9" }] });
        const raw = await rawPage(p, root);
        await assert.rejects(async () => { await query("BEGIN"); try {
            await storePage({ query } as never, dataset, p, raw, received, null);
            throw new Error("rollback");
        }
        finally {
            await query("ROLLBACK");
        } });
        assert.equal((await db.query("SELECT * FROM archive_posts WHERE id='4'")).rows.length, 0);
        assert.equal(await planArchive("partial-fixture", "2024-10-08", "2024-10-09"), 1);
        const partialJob = (await q1<Job>("SELECT * FROM archive_jobs WHERE query='partial-fixture'"))!;
        const partialClient = new XClient({ access_token: "fixture" }, undefined, async () => ({ status: 200, headers: {}, data: { data: [{ id: "5", text: "available", created_at: "2024-10-08" }], errors: [{ detail: "referenced post unavailable" }] } }));
        await collectArchivePage(partialJob, partialClient, root);
        assert.equal((await db.query<{
            state: string;
        }>("SELECT state FROM archive_jobs WHERE query='partial-fixture'")).rows[0].state, "partial");
        // A -> B -> A must retain all three observations, even with repeated raw content.
        for(const [minute,likes] of [[1,1],[2,2],[3,1]]) {
            const history=Page.parse({data:[{id:"6",text:"history",created_at:"2024-10-08",public_metrics:{like_count:likes}}]});
            const blob=await rawPage(history,root);
            await storePage({query} as never,dataset,history,blob,new Date(),new Date(`2025-01-01T00:0${minute}:00Z`));
        }
        assert.equal((await db.query("SELECT * FROM archive_metrics WHERE post_id='6'")).rows.length,3);
        const before=(await db.query<{likes:number}>("SELECT likes FROM archive_metrics WHERE post_id='6' AND metrics_observed_at<='2025-01-01T00:02:30Z' ORDER BY metrics_observed_at DESC LIMIT 1")).rows[0];
        assert.equal(Number(before.likes),2);
        const captured=Page.parse({data:[{id:"7",text:"captured",created_at:"2024-10-08",metrics_observed_at:"2024-10-08T01:00:00Z",public_metrics:{like_count:3}}]});
        await storePage({query} as never,dataset,captured,await rawPage(captured,root),new Date(),null);
        assert.equal((await db.query("SELECT * FROM archive_metrics WHERE post_id='7' AND metrics_observed_at='2024-10-08T01:00:00Z'")).rows.length,1);
        const server = http.createServer((req, res) => { applySecurityHeaders(res); void handleArchiveRequest(req, res).then(handled => { if (!handled) {
            res.statusCode = 404;
            res.end();
        } }).catch(() => { res.statusCode = 500; res.end(); }); });
        await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
        const endpoint = server.address();
        assert(endpoint && typeof endpoint !== "string");
        const browser = await chromium.launch({ headless: true });
        try {
            const page = await browser.newPage(), errors: string[] = [];
            page.on("pageerror", e => errors.push(e.message));
            await page.goto(`http://127.0.0.1:${endpoint.port}/archive`);
            await page.waitForFunction(() => document.querySelector("#jobs")?.children.length === 2);
            assert.equal(await page.locator("#sources tr").count(), 3);
            await page.route("**/api/archive/status", route => route.fulfill({ status: 503, body: "unavailable" }));
            await page.locator("#refresh").click();
            await page.waitForFunction(() => document.querySelector("#error")?.textContent?.includes("503"));
            await page.unroute("**/api/archive/status");
            await page.locator("#refresh").click();
            await page.waitForFunction(() => document.querySelector("#error")?.textContent === "");
            assert.deepEqual(errors, []);
        }
        finally {
            await browser.close();
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    }
    finally {
        a.mock.restore();
        b.mock.restore();
        await closePool();
        await db.close();
        await fs.rm(root, { recursive: true, force: true });
        if (old === undefined)
            delete process.env.DATABASE_URL;
        else
            process.env.DATABASE_URL = old;
    }
});
