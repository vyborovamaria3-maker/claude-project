import { ServerResponse } from 'node:http';
import { q } from '../trade/pg';
import { Handle } from '../trade/schemas';
export interface Progress {phase:string;account?:string|null;found?:number;authors?:string[];currentAuthor?:string|null;limit?:number|null;startedAt?:number;}
export async function recordProgress(taskId:number,workerId:string,attempt:number,p:Progress) {
 const authors=[...new Set((p.authors??[]).filter(a=>Handle.safeParse(a).success))].slice(-20);
 const rows=await q(`WITH owned AS (SELECT id FROM x_tasks WHERE id=$1 AND claimed_by=$2 AND attempts=$3 AND status='claimed' AND lease_expires_at>$11 FOR SHARE)
 INSERT INTO x_task_progress(task_id,worker_id,attempt,account_name,phase,found,authors,current_author,target_limit,started_at,updated_at)
 SELECT id,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11 FROM owned
 ON CONFLICT(task_id) DO UPDATE SET worker_id=EXCLUDED.worker_id,attempt=EXCLUDED.attempt,account_name=EXCLUDED.account_name,phase=EXCLUDED.phase,found=EXCLUDED.found,authors=EXCLUDED.authors,current_author=EXCLUDED.current_author,target_limit=EXCLUDED.target_limit,started_at=EXCLUDED.started_at,updated_at=EXCLUDED.updated_at
 WHERE x_task_progress.attempt<=EXCLUDED.attempt RETURNING task_id`,[taskId,workerId,attempt,p.account??null,p.phase,Math.max(0,p.found??0),JSON.stringify(authors),p.currentAuthor??null,p.limit??null,p.startedAt??Date.now(),Date.now()]);
 return rows.length>0;
}
export async function liveSnapshot() {
 const [jobs,accounts,workers]=await Promise.all([
 q(`WITH ids AS (SELECT id FROM (SELECT id FROM x_tasks ORDER BY id DESC LIMIT 50) recent UNION SELECT id FROM (SELECT id FROM x_tasks WHERE status='claimed' ORDER BY id DESC LIMIT 50) active)
 SELECT t.id,t.kind,t.status,t.handle,t.payload_json->>'query' query,t.attempts,t.max_attempts,t.available_at,t.last_error,t.claimed_by,
 p.account_name,p.phase,p.found,p.authors,p.current_author,p.target_limit,p.started_at,p.updated_at progress_at,
 (SELECT count(*) FROM x_task_tweets r WHERE r.task_id=t.id) saved_tweets,
 (SELECT count(*) FROM x_task_profiles r WHERE r.task_id=t.id) saved_profiles
 FROM ids JOIN x_tasks t ON t.id=ids.id LEFT JOIN x_task_progress p ON p.task_id=t.id AND p.attempt=t.attempts ORDER BY t.id DESC`),
 q("SELECT name,status,tier,weight_used_this_hour,weight_quota_per_hour,hour_window_start,cooldown_until,account_busy_until,last_success_at FROM x_accounts ORDER BY name LIMIT 100"),
 q("SELECT id,status,last_heartbeat,tasks_done,tasks_failed FROM x_workers ORDER BY last_heartbeat DESC LIMIT 50"),
 ]);return {at:Date.now(),jobs,accounts,workers};
}
const clients=new Set<ServerResponse>();
let polling=false,timer:NodeJS.Timeout|undefined,stopping=false;
async function poll() {
 if(polling||!clients.size||stopping)return;polling=true;
 try{const data=JSON.stringify(await liveSnapshot());broadcast('snapshot',data);}catch{broadcast('unavailable',JSON.stringify({message:'Мониторинг недоступен: проверьте базу и миграцию 017'}));}
 finally{polling=false;if(clients.size&&!stopping)timer=setTimeout(()=>void poll(),2000);}
}
function broadcast(event:string,data:string){for(const res of clients){if(res.destroyed||res.writableLength>256*1024){clients.delete(res);res.destroy();continue;}res.write(`event: ${event}\ndata: ${data}\n\n`);}}
export function subscribeLive(res:ServerResponse){if(clients.size>=100){res.statusCode=429;res.end("Too many monitoring clients");return;}stopping=false;res.setHeader('Content-Type','text/event-stream; charset=utf-8');res.setHeader('Cache-Control','no-cache, no-transform');res.setHeader('X-Accel-Buffering','no');res.flushHeaders();res.write('retry: 2000\n\n');clients.add(res);res.once('close',()=>{clients.delete(res);if(!clients.size&&timer){clearTimeout(timer);timer=undefined;}});if(!polling){if(timer)clearTimeout(timer);void poll();}}
export function closeLive(){stopping=true;if(timer)clearTimeout(timer);for(const res of clients)res.end();clients.clear();}
