import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { Pool } from 'pg';

export class AccountError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
function settings() {
  const cwd = process.cwd();
  const candidates = process.env.X_COLLECTOR_ENV
    ? [path.resolve(process.env.X_COLLECTOR_ENV)]
    : [path.resolve(cwd, '../x-collector/.env'), path.resolve(cwd, 'x-collector/.env')];
  const filename = candidates.find(p => fs.existsSync(p));
  if (process.env.X_COLLECTOR_ENV && !filename) throw new AccountError('Файл X_COLLECTOR_ENV не найден', 503);
  const env = filename ? dotenv.parse(fs.readFileSync(filename)) : {};
  return { url: env.DATABASE_URL || process.env.X_COLLECTOR_DATABASE_URL,
    key: env.MASTER_KEY || process.env.X_COLLECTOR_MASTER_KEY };
}
let pool: Pool | undefined, poolUrl: string | undefined;
function database() {
  const { url } = settings();
  if (!url) throw new AccountError('Укажите DATABASE_URL в x-collector/.env', 503);
  if (pool && poolUrl !== url) throw new AccountError('Настройки базы изменены. Перезапустите сайт', 503);
  if (!pool) { poolUrl = url; pool = new Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 5000, statement_timeout: 10000 }); pool.on('error', () => {}); }
  return pool;
}
function accountName(raw: unknown) {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(raw)) throw new AccountError('Имя: 1–64 латинских буквы, цифры, _ или -');
  return raw;
}
export function sessionState(raw: unknown) {
  if (typeof raw !== 'string' || raw.length > 200000) throw new AccountError('Нужен JSON сессии размером до 200 КБ');
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { throw new AccountError('Некорректный JSON сессии'); }
  const state = Array.isArray(parsed) ? { cookies: parsed, origins: [] } : parsed;
  if (!state || !Array.isArray(state.cookies) || !state.cookies.length || (state.origins !== undefined && !Array.isArray(state.origins))) throw new AccountError('Ожидается Playwright storageState или массив cookies');
  const allowed = (domain: string) => /^(?:\.)?(?:[a-z0-9-]+\.)*(?:x\.com|twitter\.com)$/i.test(domain);
  for (const cookie of state.cookies) {
    if (!cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string' || typeof cookie.domain !== 'string' || !allowed(cookie.domain) || typeof cookie.path !== 'string' || typeof cookie.expires !== 'number' || !Number.isFinite(cookie.expires) || typeof cookie.httpOnly !== 'boolean' || typeof cookie.secure !== 'boolean' || !['Strict','Lax','None'].includes(cookie.sameSite)) throw new AccountError('Cookies должны иметь полный формат Playwright и домен x.com или twitter.com');
  }
  if (!['auth_token', 'ct0'].every(name => state.cookies.some((c: any) => c.name === name && c.value && (c.expires === -1 || c.expires > Date.now()/1000)))) throw new AccountError('В сессии нужны действующие auth_token и ct0');
  return JSON.stringify({ cookies: state.cookies, origins: state.origins ?? [] });
}
function encryptedSession(session: string) {
  const { key: raw } = settings();
  if (!raw) throw new AccountError('Укажите MASTER_KEY в x-collector/.env', 503);
  const key = /^[a-f0-9]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new AccountError('MASTER_KEY должен содержать 32 байта', 503);
  try {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(session, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  } finally { key.fill(0); }
}
async function hasRole() {
  const r = await database().query("SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='x_accounts' AND column_name='role'");
  return r.rows.length > 0;
}

function publicProxy(raw:unknown) {
 const root=[path.resolve(process.cwd(),'../x-collector'),path.resolve(process.cwd(),'x-collector')].find(p=>fs.existsSync(path.join(p,'scripts/account-health.cjs')));
 if(!root)throw new AccountError('Установите обновление X Collector',503);
 const nativeModule=process.getBuiltinModule('node:module') as typeof import('node:module');
 return nativeModule.createRequire(path.join(root,'package.json'))('./scripts/account-health.cjs').toPublicProxy(raw);
}
export async function listCollectorAccounts() {
 const role=await hasRole();
 const result=await database().query(`SELECT name,tier,status,${role?'role':"'collector'::text AS role"},total_requests::text,total_errors::text,weight_used_this_hour,weight_quota_per_hour,account_busy_until::text,updated_at::text,language,user_agent,timezone,display_name,avatar_url,x_created_at::text,health_score,last_check_at::text,last_check_json,proxy_json FROM x_accounts ORDER BY name`);
 const errors=(await database().query('SELECT DISTINCT ON(account_name) account_name,type,message,created_at::text FROM xc_account_errors ORDER BY account_name,created_at DESC,id DESC')).rows;
 return {accounts:result.rows.map(({proxy_json,last_check_json,...row})=>({...row,proxy:publicProxy(proxy_json),sessionState:last_check_json?.steps?.session?.status==='failed'||last_check_json?.errorType==='SESSION_EXPIRED'?'expired':last_check_json?.ready?'valid':'unverified',lastCheck:last_check_json,lastError:errors.find(e=>e.account_name===row.name)||null})),rolesSupported:role};
}
export async function accountErrors(raw:unknown){
 const name=accountName(raw);
 return {errors:(await database().query('SELECT type,message,created_at::text FROM xc_account_errors WHERE account_name=$1 ORDER BY created_at DESC,id DESC LIMIT 30',[name])).rows};
}
export async function collectorParsing(input:any){
 const name=accountName(input?.name),db=database();
 if(!(await db.query("SELECT name FROM x_accounts WHERE name=$1 AND role='collector' AND status='active'",[name])).rowCount)throw new AccountError('Нужен активный аккаунт collector');
 if(input.action==='account-parse-status'){
  if(!Array.isArray(input.ids)||input.ids.length>20||input.ids.some((id:unknown)=>!/^\d+$/.test(String(id))))throw new AccountError('Некорректные задания');
  const tasks=(await db.query("SELECT id::text,status FROM x_tasks WHERE id=ANY($1::bigint[]) AND payload_json->>'account_name'=$2 ORDER BY id",[input.ids,name])).rows;
  return {tasks,running:tasks.some(t=>['pending','claimed'].includes(t.status))};
 }
 const client=await db.connect();
 try{
  await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(742098532)');
  const sources=(await client.query('SELECT list_id FROM xc_auto_sources WHERE enabled ORDER BY list_id')).rows;
  if(!sources.length)throw new AccountError('Нет включённых списков для сбора');
  const ids:string[]=[];const now=Date.now();
  for(const source of sources){
   const query='list:'+source.list_id;
   let task=(await client.query("SELECT id::text FROM x_tasks WHERE kind='search' AND payload_json->>'query'=$1 AND payload_json->>'account_name'=$2 AND status IN ('pending','claimed') LIMIT 1",[query,name])).rows[0];
   if(!task)task=(await client.query("INSERT INTO x_tasks(kind,payload_json,priority,available_at,created_at,updated_at,max_attempts) VALUES('search',$1::jsonb,10,$2,$2,$2,3) RETURNING id::text",[JSON.stringify({query,limit:100,sort:'latest',account_name:name}),now])).rows[0];
   ids.push(task.id);
   await client.query('UPDATE xc_auto_sources SET last_task_id=$2 WHERE list_id=$1',[source.list_id,task.id]);
  }
  await client.query('COMMIT');
  return {ids,message:'Запущен сбор из списков: '+ids.length,workerActive:!!(await db.query("SELECT 1 FROM x_workers WHERE status='active' AND last_heartbeat>$1 LIMIT 1",[now-90000])).rowCount};
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function saveAccountSettings(input:any){
 const name=accountName(input?.name);
 if(typeof input?.version!=='string'||!/^\d+$/.test(input.version))throw new AccountError('Обновите список аккаунтов');
 const values=['user_agent','timezone','language'].map(key=>{const value=input[key];if(typeof value!=='string'||value.length>(key==='user_agent'?1000:100)||/[\r\n\x00]/.test(value))throw new AccountError('Некорректные настройки аккаунта');return value.trim()||null;});
 try{if(values[1])new Intl.DateTimeFormat('en',{timeZone:values[1]});if(values[2])Intl.getCanonicalLocales(values[2]);}catch{throw new AccountError('Проверьте часовой пояс и язык (например Europe/Moscow и ru-RU)');}
 const now=Date.now();
 const result=await database().query('UPDATE x_accounts SET user_agent=$2,timezone=$3,language=$4,updated_at=GREATEST(updated_at+1,$5::bigint),health_score=NULL,last_check_at=NULL,last_check_json=NULL WHERE name=$1 AND updated_at=$6::bigint AND account_busy_until<=$5 RETURNING name',[name,...values,now,input.version]);
 if(!result.rowCount)throw new AccountError('Аккаунт занят или изменён. Обновите список',409);
 return {ok:true,name};
}
export async function removeAccountProxy(input:any){
 const name=accountName(input?.name);
 if(typeof input?.version!=='string'||!/^\d+$/.test(input.version))throw new AccountError('Обновите список аккаунтов');
 const now=Date.now();
 const result=await database().query('UPDATE x_accounts SET proxy_json=NULL,health_score=NULL,last_check_at=NULL,last_check_json=NULL,updated_at=GREATEST(updated_at+1,$2::bigint) WHERE name=$1 AND updated_at=$3::bigint AND account_busy_until<=$2 RETURNING name',[name,now,input.version]);
 if(!result.rowCount)throw new AccountError('Аккаунт занят или изменён. Обновите список',409);
 return {ok:true,name};
}

export async function addCollectorAccount(input: any) {
  const name = accountName(input?.name), session = encryptedSession(sessionState(input?.session));
  const role = input?.role ?? 'collector';
  if (!['collector','publisher'].includes(role)) throw new AccountError('Неизвестная роль');
  const roleSupported = await hasRole();
  if (role === 'publisher' && !roleSupported) throw new AccountError('Для роли публикации нужна миграция x_accounts.role', 409);
  const now = Date.now();
  try {
    await database().query(`INSERT INTO x_accounts (name,session_encrypted,tier,status,weight_quota_per_hour,hour_window_start,created_at,updated_at${roleSupported ? ',role' : ''}) VALUES ($1,$2,'new','active',15,$3,$3,$3${roleSupported ? ',$4' : ''})`, roleSupported ? [name,session,now,role] : [name,session,now]);
    return { ok: true, name };
  } catch (error: any) {
    if (error.code === '23505') throw new AccountError('Аккаунт с таким именем уже существует', 409);
    throw error;
  } finally { session.fill(0); }
}
export async function deleteCollectorAccount(input: any) {
  const name = accountName(input?.name);
  if (typeof input?.version !== 'string' || !/^\d+$/.test(input.version)) throw new AccountError('Обновите список перед удалением');
  // The row lock taken by DELETE also serializes against a worker claim.
  let result;
  try { result = await database().query('DELETE FROM x_accounts WHERE name=$1 AND updated_at=$2::bigint AND COALESCE(account_busy_until,0)<=$3 RETURNING name', [name,input.version,Date.now()]); }
  catch (error: any) { if(error.code==='23503') throw new AccountError('Аккаунт связан с другими записями. Удаление отменено; сначала проверьте связи в базе',409); throw error; }
  if (!result.rowCount) throw new AccountError('Аккаунт занят, изменён или уже удалён. Обновите список; если занят — остановите worker и дождитесь освобождения', 409);
  return { ok: true, name };
}

export async function changeCollectorAccountRole(input: any) {
  const name=accountName(input?.name);
  if (!['collector','publisher'].includes(input?.role)) throw new AccountError('Неизвестная роль');
  if(typeof input?.version !== 'string' || !/^\d+$/.test(input.version)) throw new AccountError('Обновите список перед изменением роли');
  if(!await hasRole()) throw new AccountError('Сначала установите поддержку ролей аккаунтов',409);
  const now=Date.now();
  const result=await database().query('UPDATE x_accounts SET role=$1,updated_at=GREATEST(updated_at+1,$2::bigint) WHERE name=$3 AND updated_at=$4::bigint AND COALESCE(account_busy_until,0)<=$2 RETURNING name',[input.role,now,name,input.version]);
  if(!result.rowCount) throw new AccountError('Аккаунт занят, изменён или удалён. Обновите список',409);
  return {ok:true,name};
}

async function requirePublisherProfiles() {
  const result=await database().query("SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='x_accounts' AND column_name='publisher_handle'");
  if(!result.rows.length)throw new AccountError('Запустите node scripts/setup-publisher-stats.cjs в x-collector',409);
}
export async function savePublisherProfile(input: any) {
  const name=accountName(input?.name);
  const handle=typeof input?.handle==='string'?input.handle.trim().replace(/^@/,'').toLowerCase():'';
  if(!/^[a-z0-9_]{1,15}$/.test(handle))throw new AccountError('Укажите @username X: до 15 букв, цифр или _');
  if(typeof input?.version!=='string'||!/^\d+$/.test(input.version))throw new AccountError('Обновите список аккаунтов');
  await requirePublisherProfiles();
  try {
    const result=await database().query("UPDATE x_accounts SET publisher_handle=$1,updated_at=GREATEST(updated_at+1,$2::bigint) WHERE name=$3 AND role='publisher' AND updated_at=$4::bigint AND COALESCE(account_busy_until,0)<=$2 RETURNING name",[handle,Date.now(),name,input.version]);
    if(!result.rowCount)throw new AccountError('Аккаунт занят, изменён или не предназначен для публикации. Обновите список',409);
    return {ok:true,name,handle};
  }catch(error:any){if(error.code==='23505')throw new AccountError('Этот @username уже привязан к другому аккаунту публикации',409);throw error;}
}
export async function publisherStatistics(params: URLSearchParams) {
  const name=accountName(params.get('name'));
  const days=Number(params.get('days')??30),page=Number(params.get('page')??1);
  if(![7,30,90].includes(days)||!Number.isInteger(page)||page<1||page>100000)throw new AccountError('Неверный период или номер страницы');
  await requirePublisherProfiles();
  const client=await database().connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const account=(await client.query("SELECT name,publisher_handle FROM x_accounts WHERE name=$1 AND role='publisher'",[name])).rows[0];
    if(!account)throw new AccountError('Аккаунт публикации не найден',404);
    if(!account.publisher_handle){await client.query('COMMIT');return {account,needsHandle:true};}
    const since=Date.now()-days*86400000;
    const filter="lower(ltrim(handle,'@'))=$1 AND posted_at >= $2";
    const args=[account.publisher_handle,since];
    const ownExists=(await client.query("SELECT to_regclass('xc_auto_posts') AS present")).rows[0]?.present;
    const source=ownExists?"(SELECT t.tweet_id,t.handle,t.text,t.url,t.posted_at,t.updated_at,CASE WHEN p.tweet_id IS NULL THEN t.views ELSE p.views END AS views,CASE WHEN p.tweet_id IS NULL THEN t.likes ELSE p.likes END AS likes,CASE WHEN p.tweet_id IS NULL THEN t.replies ELSE p.replies END AS replies,CASE WHEN p.tweet_id IS NULL THEN t.retweets ELSE p.retweets END AS retweets FROM twitter_tweets t LEFT JOIN xc_auto_posts p ON p.tweet_id=t.tweet_id) AS stat":'twitter_tweets';
    const summary=(await client.query(`SELECT count(*)::int AS posts,sum(views)::text AS views,sum(likes)::text AS likes,sum(replies)::text AS replies,sum(retweets)::text AS retweets,max(updated_at)::text AS last_updated FROM ${source} WHERE ${filter}`,args)).rows[0];
    const series=(await client.query(`SELECT to_char(to_timestamp(posted_at/1000.0) AT TIME ZONE 'Europe/Moscow','YYYY-MM-DD') AS day,count(*)::int AS posts,sum(views)::text AS views,sum(likes)::text AS likes,sum(replies)::text AS replies,sum(retweets)::text AS retweets FROM ${source} WHERE ${filter} GROUP BY day ORDER BY day`,args)).rows;
    const posts=(await client.query(`SELECT tweet_id,text,url,posted_at::text,views::text,likes::text,replies::text,retweets::text,updated_at::text FROM ${source} WHERE ${filter} ORDER BY posted_at DESC,tweet_id DESC LIMIT 20 OFFSET $3`,[...args,(page-1)*20])).rows;
    await client.query('COMMIT');
    return {account,needsHandle:false,summary,series,posts,page,pageSize:20,days};
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
  finally{client.release();}
}
