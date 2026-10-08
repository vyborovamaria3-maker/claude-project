import { hasXSession } from "../trade/x-session";
import path from "node:path";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import { chromium } from "playwright";
import { z } from "zod";
import { q, q1 } from "../trade/pg";
import { decryptBuffer } from "../trade/crypto";
import { enqueueTask } from "../trade/tasks";
import { SearchPayload, TimelinePayload, ProfilePayload } from "../trade/schemas";
import { ensureWorker, runtimeStatus } from "./runtime";
const Input=z.discriminatedUnion("kind",[
 z.object({kind:z.literal("search"),payload:SearchPayload,requestId:z.string().uuid()}),
 z.object({kind:z.literal("timeline"),payload:TimelinePayload,requestId:z.string().uuid()}),
 z.object({kind:z.literal("profile"),payload:ProfilePayload,requestId:z.string().uuid()}),
]);
export type StartInput=z.infer<typeof Input>;
export type Check={name:string;ok:boolean;message:string};
export async function readiness() {
 const checks:Check[]=[];
 if(!process.env.DATABASE_URL)return {ready:false,checks:[{name:"database",ok:false,message:"Настройте DATABASE_URL в .env"}],runtime:runtimeStatus()};
 try { await q("SELECT 1");checks.push({name:"database",ok:true,message:"PostgreSQL доступен"}); }
 catch { return {ready:false,checks:[{name:"database",ok:false,message:"Нет подключения к PostgreSQL; проверьте .env и службу базы"}],runtime:runtimeStatus()}; }
 const required=["x_tasks","x_accounts","x_workers","archive_posts","twitter_tweet_observations","twitter_entity_links","x_task_progress","x_task_tweets","x_task_profiles","twitter_profiles","twitter_profile_observations","archive_metrics","archive_users","archive_raw_pages","archive_sources","archive_token_links","archive_edges"];
 const tables=await q<{name:string;present:boolean}>("SELECT name,to_regclass(name) IS NOT NULL present FROM unnest($1::text[]) AS name",[required]);
 const missing=tables.filter(t=>!t.present).map(t=>t.name);
 if(!missing.includes("x_accounts")&&(await q("SELECT attname FROM pg_attribute WHERE attrelid='x_accounts'::regclass AND attname='account_claimed_by' AND NOT attisdropped")).length===0)missing.push("account lease migration 011");
 checks.push({name:"schema",ok:missing.length===0,message:missing.length?"Примените миграции: npm run migrate (нужна 017)":"Схема сборщика готова"});
 if(missing.length)return {ready:false,checks,runtime:runtimeStatus()};
 const accounts=await q<{session_encrypted:Buffer}>("SELECT session_encrypted FROM x_accounts WHERE tier!='retired' AND status IN ('active','cooldown') ORDER BY name LIMIT 20");
 let valid=false;
 for(const account of accounts){let buffer:Buffer|undefined;try {buffer=decryptBuffer(account.session_encrypted);const state=JSON.parse(buffer.toString("utf8"));valid ||= hasXSession(state);}catch{/* no decrypted details in response */}finally{buffer?.fill(0);}}
 checks.push({name:"session",ok:valid,message:valid?"Зашифрованная сессия найдена; действительность проверится при запросе X":"Настройте MASTER_KEY и войдите: npm run login -- main. CAPTCHA требует ручной проверки"});
 try {
 const root=path.resolve(process.env.ARCHIVE_RAW_DIR??"data/archive/raw");await fs.mkdir(root,{recursive:true,mode:0o700});await fs.access(root,constants.W_OK);const disk=await fs.statfs(root),reserve=Number(process.env.ARCHIVE_MIN_FREE_GB??5);const enough=Number.isFinite(reserve)&&reserve>=0&&disk.bavail*disk.bsize>=reserve*1024**3;
 checks.push({name:"storage",ok:enough,message:enough?"Хранилище доступно для записи":"Недостаточно свободного места для архива или неверный ARCHIVE_MIN_FREE_GB"});
 }catch{checks.push({name:"storage",ok:false,message:"Каталог ARCHIVE_RAW_DIR недоступен для записи"});}
 const external=(await q("SELECT id FROM x_workers WHERE status='active' AND last_heartbeat>$1 LIMIT 1",[Date.now()-90000])).length>0;
 const browserPath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH??chromium.executablePath();
 const installed=await fs.access(browserPath).then(()=>true,()=>false);
 checks.push({name:"browser",ok:external||installed,message:external?"Есть активный worker":installed?"Chromium установлен":"Установите браузер: npm run install-browser"});
 checks.push({name:"worker",ok:external||process.env.COLLECTOR_AUTOSTART!=="false",message:external?"Worker уже работает":process.env.COLLECTOR_AUTOSTART==="false"?"Запустите npm run worker или включите COLLECTOR_AUTOSTART":"Worker запустится автоматически по кнопке"});
 return {ready:checks.every(c=>c.ok),checks,runtime:runtimeStatus()};
}
export async function startCollection(raw:unknown, startWorker=ensureWorker) {
 const input=Input.parse(raw),key="ui:"+input.requestId;
 const existing=await q1<{id:string;kind:string;status:string;payload_json:unknown}>("SELECT id,kind,status,payload_json FROM x_tasks WHERE idempotency_key=$1",[key]);
 if(existing){if(existing.kind!==input.kind||JSON.stringify(existing.payload_json)!==JSON.stringify(input.payload)){// compare JSONB without key order
 const equal=await q1("SELECT id FROM x_tasks WHERE id=$1 AND kind=$2 AND payload_json=$3::jsonb",[existing.id,input.kind,JSON.stringify(input.payload)]);if(!equal)throw new Error("requestId уже использован для другого задания");}
 if(["pending","claimed"].includes(existing.status)){const state=await readiness();if(!state.ready)throw new Error(state.checks.filter(c=>!c.ok).map(c=>c.message).join("; "));await startWorker();}
 return {id:existing.id,reused:true};}
 const state=await readiness();if(!state.ready)throw new Error(state.checks.filter(c=>!c.ok).map(c=>c.message).join("; "));
 await startWorker();
 const id=await enqueueTask({kind:input.kind,payload:input.payload,handle:"handle" in input.payload?input.payload.handle:null,idempotencyKey:key});
 const result=id??(await q1<{id:number}>("SELECT id FROM x_tasks WHERE idempotency_key=$1",[key]))?.id;
 if(!result)throw new Error("Не удалось сохранить задание");
 return {id:result,reused:id===null};
}
export async function taskDetails(id:string) {
 if(!/^\d{1,18}$/.test(id))throw new Error("Некорректный ID задания");
 const task=await q1("SELECT id,kind,payload_json,status,attempts,max_attempts,last_error,available_at,updated_at FROM x_tasks WHERE id=$1",[id]);
 if(!task)return null;
 const [counts,tweets,profiles,workers]=await Promise.all([
 q1("SELECT (SELECT count(*) FROM x_task_tweets WHERE task_id=$1) tweets,(SELECT count(*) FROM x_task_profiles WHERE task_id=$1) profiles",[id]),
 q("SELECT t.tweet_id,t.handle,t.text,t.url,t.views,t.likes,t.replies,t.retweets,t.posted_at FROM x_task_tweets r JOIN twitter_tweets t ON t.tweet_id=r.tweet_id WHERE r.task_id=$1 ORDER BY t.posted_at DESC NULLS LAST LIMIT 100",[id]),
 q("SELECT p.handle,p.display_name,p.bio,p.followers,p.following FROM x_task_profiles r JOIN twitter_profiles p ON p.handle=r.handle WHERE r.task_id=$1",[id]),
 q("SELECT id FROM x_workers WHERE status='active' AND last_heartbeat>$1 LIMIT 1",[Date.now()-90000]),
 ]);return {task,counts,tweets,profiles,workerActive:workers.length>0,runtime:runtimeStatus()};
}

export async function resumeCollection(id:string,startWorker=ensureWorker) {
 if(!/^\d{1,18}$/.test(id))throw new Error("Некорректный ID задания");
 const task=await q1<{status:string}>("SELECT status FROM x_tasks WHERE id=$1",[id]);
 if(!task||!["pending","claimed"].includes(task.status))throw new Error("Возобновление возможно только для незавершённого задания");
 const state=await readiness();if(!state.ready)throw new Error(state.checks.filter(c=>!c.ok).map(c=>c.message).join("; "));
 await startWorker();return {id,resumed:true};
}
