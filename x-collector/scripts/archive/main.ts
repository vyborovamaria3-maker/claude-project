import "dotenv/config";
import fs from "node:fs/promises";
import { parseArgv, intFlag } from "../../lib/trade/cli";
import { closePool, q } from "../../lib/trade/pg";
import { bridgeLegacy } from "../../lib/archive/legacy";
import { source } from "../../lib/archive/store";
import { planArchive, runArchive } from "../../lib/archive/jobs";
import { fileHash, importArchive } from "../../lib/archive/import";
process.env.PG_POOL_MAX ??= "3";
async function main() {
    const { positional, flags } = parseArgv(process.argv.slice(2));
    if (Number(process.env.PG_POOL_MAX) < 2)
        throw new Error("archive requires PG_POOL_MAX >= 2");
    const command = positional[0];
    if (command === "plan")
        console.log({ queued: await planArchive(flags.query ?? "", flags.start ?? "2024-10-08T00:00:00+03:00", flags.end ?? "2026-10-09T00:00:00+03:00", intFlag(flags, "days", 1, 1, 31)) });
    else if (command === "run")
        console.log(await runArchive(intFlag(flags, "max-pages", 1, 1, 10000)));
    else if (command === "bridge")
        console.log(await bridgeLegacy(intFlag(flags, "max-batches", 1, 1, 10000)));
    else if (command === "import") {
        const metadata = flags.manifest ? JSON.parse(await fs.readFile(flags.manifest,"utf8")) as {name?:string;source?:string;license?:string;jsonl_sha256?:string} : {};
        const url = flags.url ?? metadata.source, license = flags.license ?? metadata.license;
        if (!flags.file || !url || !license || !["tweets", "tokens"].includes(flags.format)) throw new Error("import requires --file --format and --url/--license or --manifest");
        if(metadata.jsonl_sha256 && await fileHash(flags.file)!==metadata.jsonl_sha256)throw new Error("dataset manifest checksum mismatch");
        const format = flags.format as "tweets" | "tokens";
        const id = await source(flags.name ?? metadata.name ?? url,url,license,format,metadata);
        console.log(await importArchive(flags.file, id, format));
    }
    else if (command === "plan-threads") {
        const limit = intFlag(flags, "limit", 10, 1, 100);
        const rows = await q<{
            conversation_id: string;
        }>("SELECT DISTINCT conversation_id FROM archive_posts WHERE conversation_id IS NOT NULL AND conversation_id>$1 ORDER BY conversation_id LIMIT $2", [flags.after??"",limit]);
        let queued = 0;
        for (const row of rows)
            queued += await planArchive("conversation_id:" + row.conversation_id, flags.start ?? "2024-10-08T00:00:00+03:00", flags.end ?? "2026-10-09T00:00:00+03:00", intFlag(flags, "days", 1, 1, 31));
        console.log({ conversations: rows.length, queued, next_after:rows.at(-1)?.conversation_id??null });
    }
    else if (command === "mentions") {
        if (!flags.mint || !flags.before || !Number.isFinite(Date.parse(flags.before)))
            throw new Error("mentions requires --mint --before timestamp");
        console.log(await q("SELECT p.id,p.author_id,p.author_handle,p.posted_at,p.text,m.likes,m.views,m.metrics_observed_at FROM archive_token_links l JOIN archive_posts p ON p.id=l.post_id LEFT JOIN LATERAL(SELECT likes,views,metrics_observed_at FROM archive_metrics WHERE post_id=p.id AND metrics_observed_at<=$2 ORDER BY metrics_observed_at DESC LIMIT 1)m ON true WHERE l.mint=$1 AND p.posted_at<=$2 ORDER BY p.posted_at DESC LIMIT 100", [flags.mint, flags.before]));
    }
    else if (command === "resume") {
        const id = positional[1];
        if (!id || !/^\d+$/.test(id))
            throw new Error("resume requires numeric JOB_ID");
        console.log(await q("UPDATE archive_jobs SET partial_errors=CASE WHEN state='partial' THEN 0 ELSE partial_errors END,state='pending',last_error=NULL WHERE id=$1 AND state IN ('paused','partial') RETURNING id", [id]));
    }
    else if (command === "status")
        console.log(JSON.stringify({ jobs: await q("SELECT state,COUNT(*)::int jobs,SUM(pages) pages,SUM(posts_seen) posts_seen FROM archive_jobs GROUP BY state"), sources: await q("SELECT id,name,url,license,kind FROM archive_sources"), imports: await q("SELECT * FROM archive_imports") }, null, 2));
    else
        throw new Error("archive: plan | plan-threads | run | bridge | import | mentions | resume JOB_ID | status");
}
main().catch(e => { console.error(e instanceof Error ? e.message : "archive failed"); process.exitCode = 1; }).finally(closePool);
