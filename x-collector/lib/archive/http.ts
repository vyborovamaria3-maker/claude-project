import fs from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { q } from "../trade/pg";
export async function handleArchiveRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!["/archive", "/archive.js", "/api/archive/status"].includes(url.pathname))
        return false;
    if (req.method !== "GET") {
        res.statusCode = 405;
        res.end();
        return true;
    }
    if (url.pathname === "/api/archive/status") {
        const [counts, jobs, sources] = await Promise.all([
            q("SELECT relname table_name,CASE WHEN reltuples>=0 THEN reltuples::bigint ELSE NULL END estimated_rows FROM pg_class WHERE relnamespace=(SELECT oid FROM pg_namespace WHERE nspname=current_schema()) AND relname IN ('archive_posts','archive_users','archive_tokens','archive_metrics') ORDER BY relname"),
            q("SELECT id,query,start_at,end_at,state,pages,posts_seen,partial_errors,next_attempt_at,last_error FROM archive_jobs ORDER BY id DESC LIMIT 100"),
            q("SELECT name,url,license,kind FROM archive_sources ORDER BY name"),
        ]);
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        res.end(JSON.stringify({ counts: { estimated: true, tables: counts }, jobs, sources }));
    }
    else {
        res.setHeader("Content-Type", url.pathname.endsWith(".js") ? "application/javascript" : "text/html; charset=utf-8");
        res.end(await fs.readFile(path.join(process.cwd(), "public", url.pathname.endsWith(".js") ? "archive.js" : "archive.html")));
    }
    return true;
}
