// Disposable database verification of the downloaded real dataset, not a production import.
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import readline from "node:readline";
import path from "node:path";
import type { PoolClient } from "pg";
import { PGlite } from "@electric-sql/pglite";
import { storeToken, sourceId } from "../../lib/archive/store";
async function main() {
    const file = process.argv[2] ?? "data/datasets/solmemes/solmemes.jsonl";
    const manifest = JSON.parse(await fs.readFile(path.join(path.dirname(file), "manifest.json"), "utf8")) as {
        name: string;
        source: string;
        license: string;
    };
    const db = new PGlite();
    try {
        await db.exec(await fs.readFile("migrations/014_archive.sql", "utf8"));
        await db.exec(await fs.readFile("migrations/018_ai_foundation.sql", "utf8"));
        const url = manifest.source, id = sourceId(url, manifest.license, "tokens");
        await db.query("INSERT INTO archive_sources(id,name,url,license,kind) VALUES($1,$2,$3,$4,'tokens')", [id, manifest.name, url, manifest.license]);
        const client = { query: async (sql: string, params: unknown[] = []) => { const r = await db.query(sql, params); return { rows: r.rows, rowCount: r.affectedRows }; } } as unknown as PoolClient;
        let rows = 0;
        const lines = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
        await db.exec("BEGIN");
        try {
            for await (const line of lines) {
                await storeToken(client, id, JSON.parse(line));
                rows++;
                if (rows % 100 === 0) {
                    await db.exec("COMMIT; BEGIN");
                }
            }
            await db.exec("COMMIT");
        }
        catch (e) {
            await db.exec("ROLLBACK");
            throw e;
        }
        finally {
            lines.close();
        }
        const result = { dataset: manifest.name, rows, counts: (await db.query("SELECT (SELECT COUNT(*) FROM archive_tokens)::int tokens,(SELECT COUNT(*) FROM archive_token_records)::int original_records,(SELECT COUNT(*) FROM archive_price_samples)::int price_samples,(SELECT COUNT(*) FROM archive_tokens WHERE created_at IS NULL)::int missing_creation_dates")).rows[0], database: "disposable PGlite", production_import: false };
        await fs.writeFile(path.join(path.dirname(file), "validation.json"), JSON.stringify(result, null, 2) + "\n");
        console.log(JSON.stringify(result));
    }
    finally {
        await db.close();
    }
}
main().catch(e => { console.error(e instanceof Error ? e.message : "validation failed"); process.exitCode = 1; });
