import { q, q1, tx, getPool } from "../trade/pg";
import { XClient, XError } from "../reply/x-api";
import { Page, windows } from "./model";
import { source, rawPage, storePage } from "./store";
export async function planArchive(query: string, start: string, end: string, days = 1) {
    if (!query.trim() || query.length > 4096)
        throw new Error("explicit X search query required; wildcard full-platform coverage is not supported");
    const id = await source("X full archive", "https://docs.x.com/x-api/posts/search-all-posts", "X developer agreement", "x");
    return tx(async (c) => {
        let count = 0;
        for (const w of windows(start, end, days))
            count += (await c.query("INSERT INTO archive_jobs(source_id,query,start_at,end_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id", [id, query, w.start, w.end])).rowCount ?? 0;
        return count;
    });
}
export interface Job {
    id: string;
    source_id: string;
    query: string;
    start_at: string;
    end_at: string;
    next_token: string | null;
    partial_errors?: number;
}
export function archivePath(job: Job): string {
    const legacy = process.env.REPLY_X_FIELD_DIALECT === "tweets";
    const params = new URLSearchParams({ query: job.query, start_time: new Date(job.start_at).toISOString(), end_time: new Date(job.end_at).toISOString(), max_results: "100", sort_order: "recency",
        expansions: "author_id,entities.mentions.username,attachments.media_keys," + (legacy ? "referenced_tweets.id" : "referenced_posts"),
        "user.fields": "username,name,description,created_at,public_metrics,verified,profile_image_url",
        "media.fields": "url,type,preview_image_url,public_metrics",
    });
    params.set(legacy ? "tweet.fields" : "post.fields", "created_at,conversation_id,public_metrics,entities,attachments,lang,possibly_sensitive,reply_settings,source,withheld,geo,edit_controls," + (legacy ? "author_id,referenced_tweets,note_tweet" : "note_post"));
    if (job.next_token)
        params.set("next_token", job.next_token);
    return "/2/tweets/search/all?" + params;
}
export async function collectArchivePage(job: Job, client: XClient, root?: string) {
    const value = await client.call(archivePath(job));
    const received = new Date();
    const page = Page.parse(value);
    if (page.errors?.length && !page.data.length)
        throw new Error("X returned no data and partial errors; checkpoint kept for review");
    if (page.meta?.next_token && page.meta.next_token === job.next_token)
        throw new Error("X repeated pagination token; checkpoint not advanced");
    if (page.data.some(p => Date.parse(p.created_at) < new Date(job.start_at).getTime() || Date.parse(p.created_at) >= new Date(job.end_at).getTime()))
        throw new Error("X returned primary posts outside the archive window");
    const raw = await rawPage(value, root);
    return tx(async (c) => {
        const locked = await c.query<Job>("SELECT * FROM archive_jobs WHERE id=$1 AND state='pending' FOR UPDATE", [job.id]);
        const current = locked.rows[0];
        if (!current || current.next_token !== job.next_token)
            throw new Error("archive checkpoint changed");
        const count = await storePage(c, job.source_id, page, raw, received, received);
        const errors = page.errors?.length ?? 0, partial = Number(current.partial_errors ?? 0) + errors > 0;
        await c.query("UPDATE archive_jobs SET next_token=$1,state=$2,pages=pages+1,posts_seen=posts_seen+$3,last_error=$5,partial_errors=partial_errors+$6 WHERE id=$4", [page.meta?.next_token ?? null, page.meta?.next_token ? "pending" : partial ? "partial" : "done", count, job.id, partial ? "Some records unavailable; inspect raw response errors" : null, errors]);
        return count;
    });
}
export async function runArchive(maxPages = 1) {
    const token = process.env.X_ARCHIVE_BEARER_TOKEN;
    if (!token)
        throw new Error("X_ARCHIVE_BEARER_TOKEN with full-archive access required");
    const lock = await getPool().connect();
    let held = false, lost = false;
    lock.on("error", () => { lost = true; });
    try {
        held = (await lock.query<{
            ok: boolean;
        }>("SELECT pg_try_advisory_lock(hashtext('x-archive-single-worker')::bigint) ok")).rows[0].ok;
        if (!held)
            throw new Error("archive worker already running");
        const client = new XClient({ access_token: token });
        let pages = 0, posts = 0;
        for (; pages < maxPages; pages++) {
            if (lost)
                throw new Error("archive lock session lost");
            await lock.query("SELECT 1");
            const job = await q1<Job>("SELECT * FROM archive_jobs WHERE state='pending' AND next_attempt_at<=now() AND end_at<=now()-interval '30 seconds' ORDER BY start_at,id LIMIT 1");
            if (!job)
                break;
            try {
                posts += await collectArchivePage(job, client);
            }
            catch (e) {
                const limited = e instanceof XError && e.status === 429;
                await q("UPDATE archive_jobs SET state=$1,next_attempt_at=$2,last_error=$3 WHERE id=$4", [limited ? "pending" : "paused", new Date(Math.max(e instanceof XError ? e.retryAt ?? 0 : 0, Date.now() + 15 * 60000)), limited ? "X rate limit; wait for reset" : "archive request failed; inspect access/query/schema", job.id]);
                throw new Error(limited ? "X rate limit; progress saved" : "archive job paused; progress saved", { cause: e });
            }
            // One request/second and one credential. Never switch identities to defeat limits.
            if (pages + 1 < maxPages)
                await new Promise(r => setTimeout(r, 1000));
        }
        return { pages, posts };
    }
    finally {
        if (held)
            await lock.query("SELECT pg_advisory_unlock(hashtext('x-archive-single-worker')::bigint)").catch(() => { });
        lock.release();
    }
}
