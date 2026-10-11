import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { PoolClient } from "pg";
import { q1 } from "../trade/pg";
import { ArchivePage, addresses, validMint } from "./model";
export function sourceId(url: string, license: string, kind: string): string { return createHash("sha256").update(JSON.stringify([url, license, kind])).digest("hex"); }
export async function source(name: string, url: string, license: string, kind: "x" | "tweets" | "tokens", metadata: unknown = {}) {
    if (!name || !license || new URL(url).protocol !== "https:")
        throw new Error("source name, HTTPS provenance and license required");
    const id = sourceId(url, license, kind);
    await q1("INSERT INTO archive_sources(id,name,url,license,kind,metadata) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(id) DO NOTHING RETURNING id", [id, name, url, license, kind, JSON.stringify(metadata)]);
    return id;
}
export async function rawPage(value: unknown, root = process.env.ARCHIVE_RAW_DIR ?? "data/archive/raw") {
    const json = JSON.stringify(value), hash = createHash("sha256").update(json).digest("hex");
    const dir = path.resolve(root, hash.slice(0, 2));
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const available = await fs.statfs(dir);
    const reserve = Number(process.env.ARCHIVE_MIN_FREE_GB ?? 5);
    if (!Number.isFinite(reserve) || reserve < 0)
        throw new Error("invalid ARCHIVE_MIN_FREE_GB");
    if (available.bavail * available.bsize < reserve * 1024 ** 3)
        throw new Error("archive stopped: free disk below reserve");
    const destination = path.join(dir, hash + ".json.gz"), temp = destination + "." + randomUUID() + ".tmp";
    try {
        await fs.writeFile(temp, await promisify(gzip)(json), { mode: 0o600 });
        await fs.rename(temp, destination);
    }
    finally {
        await fs.rm(temp, { force: true });
    }
    return { hash, path: destination };
}
export async function storePage(c: PoolClient, source: string, page: ArchivePage, raw: {
    hash: string;
    path: string;
}, received: Date, observed: Date | null) {
    const posts = new Map([...page.data, ...(page.includes?.tweets ?? []), ...(page.includes?.posts ?? [])].map(p => [p.id, p]));
    // One query per entity type rather than per post: bounded by the caller's page.
    const users=[...new Map((page.includes?.users??[]).map(u=>[u.id,u])).values()];
    const handles=new Map(users.map(u=>[u.id,u.username]));
    const postRows=[],metrics=[],edges=[],links=[];
    for(const p of posts.values()){
        const text=p.note_post?.text??p.note_tweet?.text??p.text;
        postRows.push({id:p.id,author_id:p.author_id??null,conversation_id:p.conversation_id??null,text,posted_at:p.created_at,lang:p.lang??null,author_handle:p.author_handle??handles.get(p.author_id??"")??null});
        const m=p.public_metrics,observedAt=observed??(p.metrics_observed_at?new Date(p.metrics_observed_at):null);
        const snapshotKey=createHash("sha256").update(raw.hash+"|"+(observedAt?.toISOString()??"unknown")).digest("hex");
        metrics.push({id:p.id,observed_at:observedAt?.toISOString()??null,likes:m?.like_count??null,views:m?.impression_count??null,reposts:m?.repost_count??m?.retweet_count??null,replies:m?.reply_count??null,quotes:m?.quote_count??null,snapshot_key:snapshotKey});
        for(const r of p.referenced_posts??p.referenced_tweets??[])edges.push({id:p.id,target:r.id,kind:r.type});
        for(const m of (p.note_post?.entities??p.note_tweet?.entities??p.entities)?.mentions??[])if(m.id)edges.push({id:p.id,target:m.id,kind:"mentions_user"});
        for(const mint of addresses(text))links.push({id:p.id,mint});
    }
    if(users.length)await c.query(`INSERT INTO archive_users(id,username,profile,received_at)
      SELECT x.id,x.username,x.profile,$2 FROM jsonb_to_recordset($1::jsonb) AS x(id text,username text,profile jsonb)
      ON CONFLICT(id) DO UPDATE SET username=COALESCE(EXCLUDED.username,archive_users.username),profile=EXCLUDED.profile,received_at=EXCLUDED.received_at
      WHERE archive_users.received_at<=EXCLUDED.received_at`,[JSON.stringify(users.map(u=>({id:u.id,username:u.username??null,profile:u}))),received]);
    if(postRows.length){
      await c.query(`INSERT INTO archive_posts(id,author_id,conversation_id,text,posted_at,lang,first_received_at,last_received_at,author_handle)
       SELECT x.id,x.author_id,x.conversation_id,x.text,x.posted_at,x.lang,$2,$2,x.author_handle
       FROM jsonb_to_recordset($1::jsonb) AS x(id text,author_id text,conversation_id text,text text,posted_at timestamptz,lang text,author_handle text)
       ON CONFLICT(id) DO UPDATE SET author_id=COALESCE(EXCLUDED.author_id,archive_posts.author_id),conversation_id=COALESCE(EXCLUDED.conversation_id,archive_posts.conversation_id),author_handle=COALESCE(EXCLUDED.author_handle,archive_posts.author_handle),text=EXCLUDED.text,lang=COALESCE(EXCLUDED.lang,archive_posts.lang),last_received_at=EXCLUDED.last_received_at
       WHERE archive_posts.last_received_at<=EXCLUDED.last_received_at`,[JSON.stringify(postRows),received]);
      await c.query(`INSERT INTO archive_post_versions(post_id,source_id,raw_hash,received_at,text,posted_at,author_id,author_handle,lang)
       SELECT x.id,$2,$3,$4,x.text,x.posted_at,x.author_id,x.author_handle,x.lang
       FROM jsonb_to_recordset($1::jsonb) AS x(id text,text text,posted_at timestamptz,author_id text,author_handle text,lang text)
       ON CONFLICT DO NOTHING`,[JSON.stringify(postRows),source,raw.hash,received]);
      await c.query(`INSERT INTO archive_metrics(post_id,source_id,received_at,metrics_observed_at,likes,views,reposts,replies,quotes,raw_hash,snapshot_key)
       SELECT x.id,$2,$3,x.observed_at,x.likes,x.views,x.reposts,x.replies,x.quotes,$4,x.snapshot_key
       FROM jsonb_to_recordset($1::jsonb) AS x(id text,observed_at timestamptz,likes bigint,views bigint,reposts bigint,replies bigint,quotes bigint,snapshot_key text)
       ON CONFLICT DO NOTHING`,[JSON.stringify(metrics),source,received,raw.hash]);
    }
    if(edges.length)await c.query(`INSERT INTO archive_edges(post_id,target_id,kind)
      SELECT DISTINCT x.id,x.target,x.kind FROM jsonb_to_recordset($1::jsonb) AS x(id text,target text,kind text) ON CONFLICT DO NOTHING`,[JSON.stringify(edges)]);
    if(links.length)await c.query(`INSERT INTO archive_token_links(post_id,mint)
      SELECT DISTINCT x.id,x.mint FROM jsonb_to_recordset($1::jsonb) AS x(id text,mint text) ON CONFLICT DO NOTHING`,[JSON.stringify(links)]);
    await c.query("INSERT INTO archive_raw_pages(hash,source_id,path,received_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [raw.hash, source, raw.path, received]);
    return posts.size;
}
export async function storeToken(c: PoolClient, source: string, row: Record<string, unknown>) {
    const mint = String(row.token ?? row.mint ?? "");
    if (!validMint(mint))
        throw new Error("invalid token mint");
    const timestamp = (v: unknown) => v == null ? null : typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : (() => { throw new Error("invalid token timestamp"); })();
    const str = (v: unknown) => typeof v === "string" ? v : null;
    await c.query("INSERT INTO archive_tokens(mint,source_id,created_at,graduated_at,symbol,name,twitter_url,raw) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(mint,source_id) DO NOTHING", [mint, source, timestamp(row.created_at), timestamp(row.graduated_date), str(row.symbol), str(row.name), str(row.twitter), JSON.stringify(row)]);
    const record = JSON.stringify(row), recordHash = createHash("sha256").update(record).digest("hex");
    const labelNames = new Set(["reaches_2x", "staged_exit_return", "runner_peak_x", "scalp_exit_return", "mdd_from_peak", "time_to_peak_sec", "close_return_1h"]);
    const features: Record<string, unknown> = {}, labels: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row))
        if (key !== "_dataset_original")
            (key.startsWith("max_return_") || labelNames.has(key) ? labels : features)[key] = value;
    await c.query("INSERT INTO archive_token_records(mint,source_id,record_hash,captured_at,features,labels,raw) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb) ON CONFLICT DO NOTHING", [mint, source, recordHash, timestamp(row.captured_at), JSON.stringify(features), JSON.stringify(labels), record]);
    const samples = [];
    for (let minute = 0; minute < 15; minute++) {
        const price = row["average_price_" + minute], trades = row["trades_" + minute];
        if (price == null && trades == null)
            continue;
        if (price != null && (typeof price !== "number" || !Number.isFinite(price) || price < 0))
            throw new Error("invalid price");
        if (trades != null && (typeof trades !== "number" || !Number.isSafeInteger(trades) || trades < 0))
            throw new Error("invalid trade count");
        samples.push({ minute_index: minute, price: price ?? null, trades: trades ?? null });
    }
    if (samples.length)
        await c.query("INSERT INTO archive_price_samples(mint,source_id,record_hash,minute_index,price,trades) SELECT $1,$2,$4,x.minute_index,x.price,x.trades FROM jsonb_to_recordset($3::jsonb) AS x(minute_index int,price float8,trades bigint) ON CONFLICT DO NOTHING", [mint, source, JSON.stringify(samples), recordHash]);
}
