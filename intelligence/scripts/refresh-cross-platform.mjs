#!/usr/bin/env node
import pg from "pg";
import { parseTokenId, toUtcIso } from "@claude-project/contracts";
import { refreshTokenDailyCrossPlatform } from "../dist/index.js";

function parseArgs(argv) {
  const values = {};
  const flags = new Set();
  for (let i=0;i<argv.length;i++) {
    const key=argv[i];
    if (!key.startsWith("--")) throw new TypeError("invalid_arguments");
    const name=key.slice(2);
    if (name==="all-registered") {
      if (flags.has(name)) throw new TypeError("duplicate_argument");
      flags.add(name);
      continue;
    }
    if (i+1>=argv.length || Object.hasOwn(values,name)) throw new TypeError("invalid_arguments");
    values[name]=argv[++i];
  }
  const allowed=new Set(["day","as-of","token","limit"]);
  if (Object.keys(values).some((key)=>!allowed.has(key))) throw new TypeError("unknown_argument");
  if (!values.day || !values["as-of"]) throw new TypeError("missing_day_or_as_of");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.day) ||
      new Date(values.day+"T00:00:00.000Z").toISOString().slice(0,10)!==values.day) {
    throw new TypeError("invalid_day");
  }
  const asOf=toUtcIso(values["as-of"]);
  if (asOf < values.day+"T00:00:00.000Z" || asOf > new Date().toISOString()) {
    throw new TypeError("invalid_as_of");
  }
  if (values.token && flags.has("all-registered")) throw new TypeError("token_and_all_registered_conflict");
  if (values.token && parseTokenId(values.token)?.id!==values.token) throw new TypeError("invalid_token_id");
  const limit=Number(values.limit ?? (flags.has("all-registered") ? "1000" : "500"));
  if (!Number.isSafeInteger(limit)||limit<1||limit>(flags.has("all-registered")?10000:5000)) throw new TypeError("invalid_limit");
  return {day:values.day,asOf,token:values.token??null,allRegistered:flags.has("all-registered"),limit};
}
async function main() {
  const args=parseArgs(process.argv.slice(2));
  const connectionString=process.env.INTELLIGENCE_DATABASE_URL;
  if(!connectionString)throw new Error("database_config_required");
  const pool=new pg.Pool({
    connectionString,max:2,connectionTimeoutMillis:3000,
    query_timeout:15000,statement_timeout:12000,
    options:"-c statement_timeout=12000",
  });
  try {
    let tokens;
    if(args.token) {
      tokens=[args.token];
    } else if(args.allRegistered) {
      const result=await pool.query(
        "SELECT canonical_id FROM entity_registry WHERE kind='token' ORDER BY canonical_id LIMIT $1",
        [args.limit],
      );
      tokens=result.rows.map((row)=>row.canonical_id);
    } else {
      const result=await pool.query(`SELECT DISTINCT entity.canonical_id
        FROM timeline_event_entities entity
        JOIN timeline_events event
          ON event.source_system=entity.source_system
          AND event.source_event_kind=entity.source_event_kind
          AND event.event_key=entity.event_key
        JOIN intelligence_inbox inbox
          ON inbox.source_system=event.source_system
          AND inbox.event_kind=event.source_event_kind
          AND inbox.event_key=event.event_key
        WHERE entity.kind='token'
          AND event.occurred_at >= ($1::date::timestamp AT TIME ZONE 'UTC')
          AND event.occurred_at < (($1::date + INTERVAL '1 day') AT TIME ZONE 'UTC')
          AND event.occurred_at <= $2::timestamptz
          AND event.observed_at <= $2::timestamptz
          AND inbox.ingested_at <= $2::timestamptz
        ORDER BY entity.canonical_id LIMIT $3`,[args.day,args.asOf,args.limit]);
      tokens=result.rows.map((row)=>row.canonical_id);
    }
    if(!tokens.length) {
      process.stdout.write(JSON.stringify({day:args.day,asOf:args.asOf,processed:0,skipped:0,reason:"no_candidate_tokens"})+"\n");
      return;
    }
    let processed=0,skipped=0;
    for(const tokenId of tokens) {
      const client=await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        await refreshTokenDailyCrossPlatform(client,tokenId,args.day,args.asOf);
        await client.query("COMMIT");
        processed++;
      } catch(error) {
        try { await client.query("ROLLBACK"); } catch {}
        if(error instanceof Error && error.message==="No observed events or explicit coverage available for this token/day") {
          skipped++;
          continue;
        }
        throw error;
      } finally { client.release(); }
    }
    process.stdout.write(JSON.stringify({day:args.day,asOf:args.asOf,candidates:tokens.length,processed,skipped,allRegistered:args.allRegistered})+"\n");
  } finally { await pool.end(); }
}
main().catch((error)=>{
  const code=error instanceof Error && /^[a-z0-9_]+$/.test(error.message)?error.message:"cross_platform_refresh_failed";
  process.stderr.write(code+"\n");
  process.exitCode=1;
});
