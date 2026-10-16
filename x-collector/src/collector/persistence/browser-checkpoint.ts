import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { q1, tx } from "../../../lib/trade/pg";
import type { PersistenceLease } from "./collector-store";

export type BrowserCoverage = "partial" | "unverified" | "target_reached";
export interface BrowserCheckpoint {
  observedCount: number;
  oldestId: string | null;
  newestId: string | null;
  coverage: BrowserCoverage;
}
export interface BrowserCheckpointKey {
  taskId: number;
  fingerprint: string;
}
export interface BrowserCheckpointWrite extends BrowserCheckpointKey {
  lease: PersistenceLease;
  ids: string[];
}
interface CheckpointRow {
  query_fingerprint: string; observed_count: string;
  oldest_id: string | null; newest_id: string | null; coverage: BrowserCoverage;
}

export function browserFingerprint(kind:string, target:string, limit:number, sort:string):string {
  return createHash("sha256").update(JSON.stringify([kind,target,limit,sort])).digest("hex");
}
function validateKey(key:BrowserCheckpointKey):void {
  if(!Number.isSafeInteger(key.taskId)||key.taskId<1||!/^[0-9a-f]{64}$/.test(key.fingerprint))
    throw new Error("Invalid browser checkpoint key");
}
function safeId(id:string|null):bigint|null {
  return id && /^\d{1,25}$/.test(id) ? BigInt(id) : null;
}
function extrema(ids:string[], previous:CheckpointRow|null):{oldest:string|null;newest:string|null} {
  const values=[...ids,previous?.oldest_id??"",previous?.newest_id??""]
    .map(s=>safeId(s)).filter((n):n is bigint=>n!==null);
  return {oldest:values.length?values.reduce((a,b)=>a<b?a:b).toString():null,
    newest:values.length?values.reduce((a,b)=>a>b?a:b).toString():null};
}
export async function loadBrowserCheckpoint(key:BrowserCheckpointKey):Promise<BrowserCheckpoint|null> {
  validateKey(key);
  const row=await q1<CheckpointRow>(`SELECT query_fingerprint,observed_count::text,oldest_id,newest_id,coverage
    FROM xc_browser_checkpoints WHERE task_id=$1`,[key.taskId]);
  if(!row)return null;
  if(row.query_fingerprint!==key.fingerprint)throw new Error("BROWSER_CHECKPOINT_CHANGED");
  return {observedCount:Number(row.observed_count),oldestId:row.oldest_id,newestId:row.newest_id,coverage:row.coverage};
}
export function browserResumeQuery(
  query:string, sort:"latest"|"top", limit:number,
  checkpoint:BrowserCheckpoint|null, allowCursor:boolean,
):{query:string;limit:number;usingCursor:boolean} {
  if(!Number.isSafeInteger(limit)||limit<1)throw new Error("Invalid browser target");
  if(!checkpoint || checkpoint.observedCount<1)
    return {query,limit,usingCursor:false};
  const oldest=safeId(checkpoint.oldestId);
  // X advanced search max_id is only an unverified best-effort cursor.
  // Never append another cursor to a historical/list query.
  if(sort!=="latest"||!allowCursor||oldest===null||oldest<=1n||
    /\b(max_id|since_id|until_id):/i.test(query))
    return {query,limit,usingCursor:false};
  return {query:`${query} max_id:${oldest-1n}`,
    limit:Math.max(0,limit-checkpoint.observedCount),usingCursor:true};
}
/** A single transaction must cover persisted posts and checkpoint progression. */
export async function commitBrowserBatch(
  write:BrowserCheckpointWrite, persist:(client:PoolClient)=>Promise<number>,
):Promise<number> {
  return tx(client=>writeBrowserBatchInTransaction(client,write,persist));
}
export async function writeBrowserBatchInTransaction(
  client:PoolClient, write:BrowserCheckpointWrite,
  persist:(client:PoolClient)=>Promise<number>,
):Promise<number> {
  validateKey(write);
  if(write.ids.length>1000||write.ids.some(id=>safeId(id)===null))
    throw new Error("Invalid browser page identifiers");
  const now=Date.now();
  const task=await client.query(`SELECT 1 FROM x_tasks WHERE id=$1 AND status='claimed'
    AND claimed_by=$2 AND attempts=$3 AND lease_expires_at>$4 FOR UPDATE`,
    [write.taskId,write.lease.workerId,write.lease.attempt,now]);
  if(!task.rowCount)throw new Error("Browser checkpoint task lease lost");
  const account=await client.query(`SELECT 1 FROM x_accounts WHERE name=$1
    AND account_claimed_by=$2 AND account_busy_until>$3 FOR UPDATE`,
    [write.lease.accountName,write.lease.accountOwner,now]);
  if(!account.rowCount)throw new Error("Browser checkpoint account lease lost");
  const r=await client.query<CheckpointRow>(`SELECT query_fingerprint,observed_count::text,
    oldest_id,newest_id,coverage FROM xc_browser_checkpoints WHERE task_id=$1 FOR UPDATE`,
    [write.taskId]);
  const previous=r.rows[0]??null;
  if(previous && previous.query_fingerprint!==write.fingerprint)
    throw new Error("BROWSER_CHECKPOINT_CHANGED");
  const saved=await persist(client);
  if(!Number.isSafeInteger(saved)||saved<0||saved>write.ids.length)
    throw new Error("Invalid browser persisted count");
  const {oldest,newest}=extrema(write.ids,previous);
  await client.query(`INSERT INTO xc_browser_checkpoints
    (task_id,query_fingerprint,observed_count,oldest_id,newest_id,coverage,updated_at)
    VALUES($1,$2,$3,$4,$5,'partial',$6)
    ON CONFLICT(task_id) DO UPDATE SET
      observed_count=xc_browser_checkpoints.observed_count+EXCLUDED.observed_count,
      oldest_id=EXCLUDED.oldest_id,newest_id=EXCLUDED.newest_id,
      coverage='partial',updated_at=EXCLUDED.updated_at`,
    [write.taskId,write.fingerprint,saved,oldest,newest,now]);
  return saved;
}
export async function finalizeBrowserCheckpoint(
  key:BrowserCheckpointKey,lease:PersistenceLease,target:number,
):Promise<BrowserCoverage|null> {
  validateKey(key);
  const now=Date.now();
  return tx(async client=>{
    const r=await client.query<{observed_count:string;query_fingerprint:string}>(`
      SELECT cp.observed_count::text,cp.query_fingerprint FROM xc_browser_checkpoints cp
      JOIN x_tasks t ON t.id=cp.task_id
      JOIN x_accounts a ON a.name=$4
      WHERE cp.task_id=$1 AND t.claimed_by=$2 AND t.attempts=$3 AND t.status='claimed'
        AND t.lease_expires_at>$6 AND a.account_claimed_by=$5 AND a.account_busy_until>$6
      FOR UPDATE OF cp,t,a`,
      [key.taskId,lease.workerId,lease.attempt,lease.accountName,lease.accountOwner,now]);
    const row=r.rows[0];
    if(!row)return null;
    if(row.query_fingerprint!==key.fingerprint)throw new Error("BROWSER_CHECKPOINT_CHANGED");
    const coverage=Number(row.observed_count);
    const status:BrowserCoverage=coverage>=target?"target_reached":"unverified";
    await client.query("UPDATE xc_browser_checkpoints SET coverage=$2,updated_at=$3 WHERE task_id=$1",
      [key.taskId,status,now]);
    return status;
  });
}
