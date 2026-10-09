import { getPool, q1, tx } from "../trade/pg";
import { source, rawPage, storePage } from "./store";
import { Page } from "./model";
interface Legacy {
    tweet_id: string;
    handle: string;
    text: string;
    posted_at: string | null;
    updated_at: string;
    url: string | null;
    views: string;
    likes: string;
    retweets: string;
    replies: string;
}
export async function bridgeLegacy(maxBatches = 1, root?: string) {
    const id = await source("Existing X Collector scraper", "https://github.com/vyborovamaria3-maker/claude-project/tree/main/x-collector", "Existing collector data / platform terms", "tweets");
    const lock = await getPool().connect();
    let held = false, imported = 0, skipped = 0;
    try {
        held = (await lock.query<{
            ok: boolean;
        }>("SELECT pg_try_advisory_lock(hashtext('archive-legacy-bridge')::bigint) ok")).rows[0].ok;
        if (!held)
            throw new Error("legacy bridge already running");
        await q1("INSERT INTO archive_legacy_cursor(source_id) VALUES($1) ON CONFLICT DO NOTHING", [id]);
        for (let batch = 0; batch < maxBatches; batch++) {
            await lock.query("SELECT 1");
            const cursor = (await q1<{
                last_time: string;
                last_id: string;
            }>("SELECT * FROM archive_legacy_cursor WHERE source_id=$1", [id]))!;
            const rows = (await lock.query<Legacy>("SELECT * FROM twitter_tweets WHERE (updated_at,tweet_id)>($1::bigint,$2::text) ORDER BY updated_at,tweet_id LIMIT 100", [cursor.last_time, cursor.last_id])).rows;
            if (!rows.length)
                break;
            const received = new Date();
            const raw = await rawPage({ legacy_records: rows }, root);
            const valid: Array<{
                id: string;
                text: string;
                author_handle: string;
                created_at: string;
                _legacy_original: Legacy;
            }> = [];
            for (const r of rows) {
                const time = Number(r.posted_at);
                if (!r.posted_at || !Number.isSafeInteger(time) || time <= 0 || !Number.isFinite(new Date(time).getTime()) || !/^\d{1,25}$/.test(r.tweet_id)) {
                    skipped++;
                    continue;
                }
                // Legacy counters use zero for absent DOM data. Keep originals, don't claim verified metrics.
                valid.push({ id: r.tweet_id, text: r.text, author_handle: r.handle, created_at: new Date(time).toISOString(), _legacy_original: r });
            }
            const last = rows.at(-1)!;
            const processed = await tx(async (c) => {
                const count = await storePage(c, id, Page.parse({ data: valid }), raw, received, null);
                await c.query("UPDATE archive_legacy_cursor SET last_time=$1,last_id=$2 WHERE source_id=$3", [last.updated_at, last.tweet_id, id]);
                return count;
            });
            imported += processed;
        }
        return { imported, skipped };
    }
    finally {
        if (held)
            await lock.query("SELECT pg_advisory_unlock(hashtext('archive-legacy-bridge')::bigint)").catch(() => { });
        lock.release();
    }
}
