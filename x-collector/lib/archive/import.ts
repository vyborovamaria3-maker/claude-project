import fs from "node:fs";
import { createHash } from "node:crypto";
import { createGunzip } from "node:zlib";
import readline from "node:readline";
import { q1, tx, getPool } from "../trade/pg";
import { Page, Post } from "./model";
import { rawPage, storePage, storeToken } from "./store";
export async function fileHash(file: string) {
    const hash = createHash("sha256");
    for await (const part of fs.createReadStream(file))
        hash.update(part);
    return hash.digest("hex");
}
export async function importArchive(file: string, source: string, format: "tweets" | "tokens", root?: string) {
    const hash = await fileHash(file);
    const lock = await getPool().connect();
    const key = "archive-import:" + source + hash;
    let held = false;
    try {
        held = (await lock.query<{
            ok: boolean;
        }>("SELECT pg_try_advisory_lock(hashtext($1)::bigint) ok", [key])).rows[0].ok;
        if (!held)
            throw new Error("this dataset import is already running");
        await q1("INSERT INTO archive_imports(source_id,file_hash,format) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [source, hash, format]);
        const state = await q1<{
            next_line: string;
            done: boolean;
        }>("SELECT * FROM archive_imports WHERE source_id=$1 AND file_hash=$2 AND format=$3", [source, hash, format]);
        if (state?.done)
            return { lines: Number(state.next_line), resumed: true };
        const stream = fs.createReadStream(file);
        const input = file.endsWith(".gz") ? stream.pipe(createGunzip()) : stream;
        const lines = readline.createInterface({ input, crlfDelay: Infinity });
        let line = 0;
        let batch: unknown[] = [];
        let batchBytes = 0;
        const flush = async () => {
            if (!batch.length)
                return;
            await lock.query("SELECT 1");
            const received = new Date();
            const raw = await rawPage({ format, records: batch }, root);
            await tx(async (c) => {
                if (format === "tweets")
                    await storePage(c, source, Page.parse({ data: batch, includes: { users: batch.flatMap(v => {
                                const p = v as {
                                    user_profile?: unknown;
                                };
                                return p.user_profile ? [p.user_profile] : [];
                            }) } }), raw, received, null);
                else {
                    for (const row of batch)
                        await storeToken(c, source, row as Record<string, unknown>);
                    await c.query("INSERT INTO archive_raw_pages(hash,source_id,path,received_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [raw.hash, source, raw.path, received]);
                }
                await c.query("UPDATE archive_imports SET next_line=$1 WHERE source_id=$2 AND file_hash=$3 AND format=$4", [line, source, hash, format]);
            });
            batch = [];
            batchBytes = 0;
        };
        try {
            for await (const value of lines) {
                line++;
                if (line <= Number(state?.next_line ?? 0) || !value.trim())
                    continue;
                if (Buffer.byteLength(value) > 2 * 1024 * 1024)
                    throw new Error("dataset record exceeds 2 MB at line " + line);
                let parsed: unknown;
                try {
                    parsed = JSON.parse(value);
                    if (format === "tweets")
                        Post.parse(parsed);
                    else if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
                        throw new Error();
                }
                catch {
                    throw new Error("invalid dataset record at line " + line + "; previous checkpoint preserved");
                }
                batch.push(parsed);
                batchBytes += Buffer.byteLength(value);
                if (batch.length >= 100 || batchBytes >= 4 * 1024 * 1024)
                    await flush();
            }
            await flush();
            await q1("UPDATE archive_imports SET done=true,next_line=$1 WHERE source_id=$2 AND file_hash=$3 AND format=$4 RETURNING next_line", [line, source, hash, format]);
            return { lines: line, resumed: false };
        }
        finally {
            lines.close();
            input.destroy();
            stream.destroy();
        }
    }
    finally {
        if (held)
            await lock.query("SELECT pg_advisory_unlock(hashtext($1)::bigint)", [key]).catch(() => { });
        lock.release();
    }
}
