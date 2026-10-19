import { Api, type TelegramClient } from "telegram";
import {publicDiscoveryChannel} from "../validation.js";
import { pool } from "../db.js";
import { refreshTwitterKeywords, type TweetKeywordSettings } from "./twitter-keywords.js";
import { classifyTelegramError } from "../queue/retry.js";

type Settings = TweetKeywordSettings & { enabled: boolean; keywords: string[]; interval_minutes: number;
 results_per_query: number; queries_per_cycle: number; max_queries_per_day: number;
 max_new_per_day: number; max_sources: number; keyword_cursor: number; revision: number };


async function addCandidate(candidate: NonNullable<ReturnType<typeof publicDiscoveryChannel>>, keyword: string, revision: number): Promise<void> {
 const tx=await pool.connect();
 try {
  await tx.query("BEGIN");
  const settings=(await tx.query<Settings>("SELECT * FROM tg_discovery_settings WHERE id=1 FOR UPDATE")).rows[0];
  const runtime=(await tx.query<{active:boolean}>(`SELECT collection_enabled AND block_reason IS NULL AND
   (pause_until IS NULL OR pause_until<=now()) AS active FROM tg_runtime WHERE id=1 FOR SHARE`)).rows[0];
  if (!settings.enabled || settings.revision!==revision || !runtime?.active) { await tx.query("ROLLBACK"); return; }
  await tx.query(`INSERT INTO tg_discovered_sources(peer_id,username,title,keyword) VALUES($1,$2,$3,$4)
   ON CONFLICT(peer_id) DO UPDATE SET username=EXCLUDED.username,title=EXCLUDED.title,
   keyword=EXCLUDED.keyword,last_seen_at=now()`,[candidate.peer,candidate.username,candidate.title,keyword]);
  const found=(await tx.query<{connected_at:Date|null}>("SELECT connected_at FROM tg_discovered_sources WHERE peer_id=$1",[candidate.peer])).rows[0];
  // A source previously removed or paused by the operator must not be resurrected.
  const existing=await tx.query("SELECT id FROM tg_sources WHERE peer_id=$1 OR identifier=$2",[candidate.peer,candidate.username]);
  if (existing.rowCount) await tx.query(`UPDATE tg_discovered_sources SET source_id=$2,
   connected_at=COALESCE(connected_at,now()) WHERE peer_id=$1`,[candidate.peer,existing.rows[0].id]);
  const budget=(await tx.query<{added:number;total:number}>(`SELECT COALESCE((SELECT added FROM tg_discovery_daily
   WHERE day=(now() AT TIME ZONE 'UTC')::date),0)::int AS added,(SELECT count(*)::int FROM tg_sources) AS total`)).rows[0];
  if (!found.connected_at && !existing.rowCount && budget.added<settings.max_new_per_day && budget.total<settings.max_sources) {
   const source=await tx.query<{id:string}>(`INSERT INTO tg_sources(identifier,peer_id,title) VALUES($1,$2,$3)
    ON CONFLICT(identifier) DO NOTHING RETURNING id::text`,[candidate.username,candidate.peer,candidate.title]);
   if(source.rowCount) {
    await tx.query("INSERT INTO tg_jobs(source_id) VALUES($1) ON CONFLICT(source_id) DO NOTHING",[source.rows[0].id]);
    await tx.query("UPDATE tg_discovered_sources SET source_id=$2,connected_at=now() WHERE peer_id=$1",[candidate.peer,source.rows[0].id]);
    await tx.query(`INSERT INTO tg_discovery_daily(day,added) VALUES((now() AT TIME ZONE 'UTC')::date,1)
     ON CONFLICT(day) DO UPDATE SET added=tg_discovery_daily.added+1`);
   }
  }
  await tx.query("COMMIT");
 } catch(error) { await tx.query("ROLLBACK");throw error; } finally {tx.release();}
}

/** Run sequentially on the singleton worker; never creates sessions or joins chats. */
export async function discoverPublicSources(client: Pick<TelegramClient,"invoke">, stopping:()=>boolean): Promise<"continue"|"halt"> {
 const settings=(await pool.query<Settings>(`UPDATE tg_discovery_settings d SET
  next_run_at=now()+d.interval_minutes*interval '1 minute',last_run_at=now(),last_error_code=NULL
  WHERE d.id=1 AND d.enabled AND d.next_run_at<=now() AND EXISTS(SELECT 1 FROM tg_runtime
   WHERE id=1 AND collection_enabled AND block_reason IS NULL AND (pause_until IS NULL OR pause_until<=now()))
  RETURNING d.*`)).rows[0];
 if (!settings || stopping()) return "continue";
 let searched=false;
 try {
  const generated=await refreshTwitterKeywords(settings);
  settings.keywords=[...new Set([...generated,...settings.keywords])];
  if(!settings.keywords.length)return "continue";
  for(let i=0;i<settings.queries_per_cycle && !stopping();i++) {
   // Reserve one request durably BEFORE contacting Telegram, including failed calls.
   const reserved=await pool.query<{queries:number}>(`INSERT INTO tg_discovery_daily(day,queries)
    SELECT (now() AT TIME ZONE 'UTC')::date,1 WHERE EXISTS(SELECT 1 FROM tg_discovery_settings d
     CROSS JOIN tg_runtime r WHERE d.id=1 AND r.id=1 AND d.enabled AND d.revision=$1
     AND r.collection_enabled AND r.block_reason IS NULL AND (r.pause_until IS NULL OR r.pause_until<=now())
     AND (SELECT count(*) FROM tg_sources)<d.max_sources)
    ON CONFLICT(day) DO UPDATE SET queries=tg_discovery_daily.queries+1
    WHERE tg_discovery_daily.queries<$2 AND tg_discovery_daily.added<$3 RETURNING queries`,
    [settings.revision,settings.max_queries_per_day,settings.max_new_per_day]);
   if(!reserved.rowCount) break;
   const keyword=settings.keywords[settings.keyword_cursor % settings.keywords.length];
   settings.keyword_cursor=(settings.keyword_cursor+1)%settings.keywords.length;
   await pool.query("UPDATE tg_discovery_settings SET keyword_cursor=$2 WHERE id=1 AND revision=$1",[settings.revision,settings.keyword_cursor]);
   const result=await client.invoke(new Api.contacts.Search({q:keyword,limit:settings.results_per_query}));
   searched=true;
   for(const chat of result.chats.slice(0,settings.results_per_query)) {
    if(stopping()) break;
    const candidate=publicDiscoveryChannel(chat);
    if(candidate) await addCandidate(candidate,keyword,settings.revision);
   }
  }
  if(searched) await pool.query("UPDATE tg_discovery_settings SET last_completed_at=now() WHERE id=1");
 } catch(error) {
  const decision=classifyTelegramError(error,0);
  await pool.query(`UPDATE tg_discovery_settings SET last_error_code=$1,
   next_run_at=GREATEST(next_run_at,now()+($2::int*interval '1 second')) WHERE id=1`,
   [decision.code,decision.action==='delay'?decision.seconds:3600]);
  if(decision.action==='halt') {
   await pool.query("UPDATE tg_runtime SET block_reason=$1,blocked_at=now(),last_error_code=$1 WHERE id=1",[decision.code]);
   return "halt";
  }
  if(decision.action==='delay' && decision.global) await pool.query(`UPDATE tg_runtime SET pause_until=GREATEST(
   COALESCE(pause_until,now()),now()+($1::int*interval '1 second')),last_error_code=$2 WHERE id=1`,[decision.seconds,decision.code]);
 }
 return "continue";
}
