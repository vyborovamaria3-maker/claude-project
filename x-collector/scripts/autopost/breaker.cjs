// V2-06: operator-visible, secret-free account/AI pause policy.
const POLICY={
 account:{threshold:3,cooldownMs:60*60_000},
 ai:{threshold:5,cooldownMs:30*60_000},
};
const PROBE_TIMEOUT_MS=15*60_000;
const ACCOUNT_CODES=new Set(['SESSION_EXPIRED','PROXY_FAILED','X_RESTRICTED','ACCOUNT_MISMATCH']);
function valid(kind,subject){
 if(!Object.hasOwn(POLICY,kind)||typeof subject!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(subject))throw Error('Invalid breaker identity');
}
function qualifyAccountCode(code){return ACCOUNT_CODES.has(code);}
async function permit(c,kind,subject,now=Date.now()){
 valid(kind,subject);
 const row=(await c.query('SELECT state,resume_at,updated_at FROM xc_auto_breakers WHERE kind=$1 AND subject=$2',[kind,subject])).rows[0];
 if(!row||row.state==='closed')return true;
 if(row.state==='half_open'){
  // An abandoned probe is cooled down rather than blocking this account forever.
  if(row.resume_at===null?Number(row.updated_at)+PROBE_TIMEOUT_MS<=now:Number(row.resume_at)<=now)
   await c.query("UPDATE xc_auto_breakers SET state='open',resume_at=$3,updated_at=$4 WHERE kind=$1 AND subject=$2 AND state='half_open' AND (resume_at<=$4 OR (resume_at IS NULL AND updated_at<=$5))",[kind,subject,now+POLICY[kind].cooldownMs,now,now-PROBE_TIMEOUT_MS]);
  return false;
 }
 if(row.state!=='open'||Number(row.resume_at)>now)return false;
 const changed=await c.query("UPDATE xc_auto_breakers SET state='half_open',resume_at=$4,updated_at=$3 WHERE kind=$1 AND subject=$2 AND state='open' AND resume_at<=$3 RETURNING subject",[kind,subject,now,now+PROBE_TIMEOUT_MS]);
 return changed.rowCount===1;
}

async function releaseProbe(c,kind,subject,now=Date.now()){
 valid(kind,subject);
 // Pre-send retries, cancellations and non-breaker errors must not orphan the probe.
 return (await c.query("UPDATE xc_auto_breakers SET state='open',resume_at=$3,updated_at=$4 WHERE kind=$1 AND subject=$2 AND state='half_open' RETURNING subject",[kind,subject,now+POLICY[kind].cooldownMs,now])).rowCount===1;
}
async function expireProbes(c,now=Date.now()){
 const changed=await c.query(`UPDATE xc_auto_breakers SET state='open',
  resume_at=$1+CASE kind WHEN 'account' THEN $2::bigint ELSE $3::bigint END,
  updated_at=$1
  WHERE state='half_open' AND (resume_at<=$1 OR (resume_at IS NULL AND updated_at<=$1-$4::bigint))
  RETURNING subject`,[now,POLICY.account.cooldownMs,POLICY.ai.cooldownMs,PROBE_TIMEOUT_MS]);
 return changed.rowCount||0;
}
async function failure(c,kind,subject,reasonCode,now=Date.now()){
 valid(kind,subject);
 if(typeof reasonCode!=='string'||!(/^[A-Z][A-Z0-9_]{0,47}$/.test(reasonCode)))throw Error('Invalid breaker error code');
 if(kind==='account'&&!qualifyAccountCode(reasonCode))return null;
 const {threshold,cooldownMs}=POLICY[kind];
 await c.query('BEGIN');
 try{
  const current=(await c.query('SELECT state,consecutive_failures FROM xc_auto_breakers WHERE kind=$1 AND subject=$2 FOR UPDATE',[kind,subject])).rows[0];
  if(current?.state==='open'){
   await c.query('COMMIT');
   return {state:'open',failures:Number(current.consecutive_failures)};
  }
  const count=current?.state==='half_open'?threshold:Number(current?.consecutive_failures||0)+1;
  const state=count>=threshold?'open':'closed';
  await c.query(`INSERT INTO xc_auto_breakers(kind,subject,state,consecutive_failures,reason_code,opened_at,resume_at,updated_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8)
 ON CONFLICT(kind,subject) DO UPDATE SET
 state=excluded.state,consecutive_failures=excluded.consecutive_failures,reason_code=excluded.reason_code,
 opened_at=excluded.opened_at,resume_at=excluded.resume_at,updated_at=excluded.updated_at`,
   [kind,subject,state,count,reasonCode,state==='open'?now:null,state==='open'?now+cooldownMs:null,now]);
  await c.query('COMMIT');
  return {state,failures:count};
 }catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}
}
async function success(c,kind,subject,now=Date.now()){
 valid(kind,subject);
 await c.query("UPDATE xc_auto_breakers SET state='closed',consecutive_failures=0,reason_code=NULL,opened_at=NULL,resume_at=NULL,updated_at=$3 WHERE kind=$1 AND subject=$2",[kind,subject,now]);
}
async function operatorReset(c,kind,subject,confirmed,now=Date.now()){
 valid(kind,subject);
 if(confirmed!==true)throw Error('Operator must confirm account/provider was checked');
 await success(c,kind,subject,now);
 return {ok:true};
}
async function runAi(c,providerId,operation){
 if(!await permit(c,'ai',providerId))throw Object.assign(Error('AI_PROVIDER_PAUSED'),{code:'AI_PROVIDER_PAUSED'});
 try{
  const result=await operation();
  await success(c,'ai',providerId);
  return result;
 }catch(error){
  await failure(c,'ai',providerId,'AI_PROVIDER_FAILURE').catch(()=>{});
  throw error;
 }
}
async function readBreakers(c){
 return (await c.query("SELECT kind,subject,state,consecutive_failures,reason_code,resume_at::text,updated_at::text FROM xc_auto_breakers WHERE state<>'closed' ORDER BY kind,subject")).rows;
}
module.exports={POLICY,PROBE_TIMEOUT_MS,qualifyAccountCode,permit,releaseProbe,expireProbes,failure,success,operatorReset,runAi,readBreakers};
