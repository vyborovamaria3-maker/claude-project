import { q, exec } from "../../lib/trade/pg";

export interface XAccount {
  name: string;
  status: string;
  weightQuota: number;
}

export async function getAvailableAccount(): Promise<XAccount | null> {
  const rows = await q<XAccount>(
    `SELECT name, status, weight_quota_per_hour as "weightQuota"
     FROM x_accounts
     WHERE status = 'active'
       AND cooldown_until < $1
       AND account_busy_until < $1
       AND weight_used_this_hour < weight_quota_per_hour
     ORDER BY weight_used_this_hour ASC
     LIMIT 1`,
    [Date.now()]
  );
  return rows[0] ?? null;
}

export async function markUsed(name: string): Promise<void> {
  await exec(
    `UPDATE x_accounts
     SET weight_used_this_hour = weight_used_this_hour + 1,
         updated_at = $2
     WHERE name = $1`,
    [name, Date.now()]
  );
}

export async function getAccountAggregate(name:string) {
 return (await q<Record<string,unknown>>('SELECT * FROM x_accounts WHERE name=$1',[name]))[0]??null;
}
export async function listAccountsSafe() {
 const {toPublicProxy}=await import('./proxy');
 const rows=await q<Record<string,unknown>>('SELECT name,role,status,tier,proxy_json,language,user_agent,timezone,display_name,avatar_url,x_created_at,health_score,last_check_at,last_check_json FROM x_accounts ORDER BY name');
 return rows.map(({proxy_json,...row})=>({...row,proxy:toPublicProxy(proxy_json)}));
}
export async function saveProxy(name:string,input:unknown) {
 const {serializeProxy}=await import('./proxy');
 await exec('UPDATE x_accounts SET proxy_json=$2,updated_at=$3 WHERE name=$1',[name,serializeProxy(input),Date.now()]);
}
export async function saveDiagnostics(name:string,result:{score:number;ready:boolean;steps:unknown}) {
 await exec('UPDATE x_accounts SET health_score=$2,last_check_at=$3,last_check_json=$4::jsonb,updated_at=$3 WHERE name=$1',[name,result.score,Date.now(),JSON.stringify(result)]);
}
export async function saveIdentity(name:string,identity:{display_name?:string;avatar_url?:string;x_created_at?:number;handle?:string}) {
 await exec('UPDATE x_accounts SET display_name=COALESCE($2,display_name),avatar_url=COALESCE($3,avatar_url),x_created_at=COALESCE($4,x_created_at),publisher_handle=COALESCE(publisher_handle,$5),updated_at=$6 WHERE name=$1',[name,identity.display_name??null,identity.avatar_url??null,identity.x_created_at??null,identity.handle??null,Date.now()]);
}
