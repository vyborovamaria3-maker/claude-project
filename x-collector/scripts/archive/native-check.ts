import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { q, tx } from "../../lib/trade/pg";
import { Page } from "../../lib/archive/model";
import { rawPage, source, storePage, storeToken } from "../../lib/archive/store";
import { bridgeLegacy } from "../../lib/archive/legacy";
export async function checkArchiveNative() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "archive-native-"));
    try {
        const id = await source("native fixture", "https://fixture.invalid/archive", "CC0-1.0", "tokens");
        const mint = "So11111111111111111111111111111111111111112", received = new Date();
        const page = Page.parse({ data: [{ id: "9000000000000000001", text: mint, created_at: "2025-01-01", author_id: "91", public_metrics: { like_count: 2 } }] });
        const raw = await rawPage(page, root);
        await tx(async (c) => {
            await storePage(c, id, page, raw, received, null);
            for (const price of [0.1, 0.2])
                await storeToken(c, id, { token: mint, average_price_0: price, trades_0: 2, captured_at: "2025-01-01", max_return_1h: 3 });
        });
        const [metric] = await q<{
            views: null;
            metrics_observed_at: null;
        }>("SELECT * FROM archive_metrics WHERE post_id='9000000000000000001'");
        assert.equal(metric.views, null);
        assert.equal(metric.metrics_observed_at, null);
        assert.equal((await q("SELECT * FROM archive_price_samples WHERE mint=$1", [mint])).length, 2);
        const [snapshot] = await q<{
            features: Record<string, unknown>;
            labels: Record<string, unknown>;
        }>("SELECT features,labels FROM archive_token_records WHERE mint=$1 LIMIT 1", [mint]);
        assert(!("max_return_1h" in snapshot.features));
        assert.equal(snapshot.labels.max_return_1h, 3);
        await q("INSERT INTO twitter_tweets(tweet_id,handle,text,posted_at,first_seen_at,updated_at) VALUES('9000000000000000002','legacy',$1,1735689600000,1735689600000,1735689600000)", [mint]);
        assert.equal((await bridgeLegacy(1, root)).imported, 1);
        assert.equal((await bridgeLegacy(1, root)).imported, 0);
        const [post] = await q<{
            author_id: null;
            author_handle: string;
        }>("SELECT * FROM archive_posts WHERE id='9000000000000000002'");
        assert.equal(post.author_id, null);
        assert.equal(post.author_handle, "legacy");
        console.log("PostgreSQL archive checks passed: metadata, NULL metrics, multi-snapshot prices, label separation, legacy bridge checkpoint");
    }
    finally {
        await fs.rm(root, { recursive: true, force: true });
    }
}
