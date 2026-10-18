// V2-02: one transaction for publishing a verified X result and closing
// the matching job/reconciliation. The external X operation occurs outside it.
const VALID_STATUSES=new Set(['running','uncertain']);
const VALID_RECON_STATUSES=new Set(['running','manual_review','manual_required']);
async function finalizePublication(c,job,tweetId,data={},options={}){
 const jobId=job?.job_id||job?.id;
 if(typeof jobId!=='string'||!/^[a-f0-9-]{36}$/i.test(jobId))throw Error('Invalid publication job ID');
 if(!/^[0-9]{1,25}$/.test(tweetId||''))throw Error('Invalid confirmed tweet ID');
 const expected=options.expectedStatus||'uncertain';
 if(!VALID_STATUSES.has(expected))throw Error('Invalid expected publication state');
 const reconStates=options.reconciliationStates;
 if(expected==='uncertain'&&(!Array.isArray(reconStates)||!reconStates.length||reconStates.some(s=>!VALID_RECON_STATUSES.has(s))))throw Error('Invalid reconciliation states');
 if(expected==='running'&&reconStates!==undefined)throw Error('Unexpected reconciliation states');
 const {persistPostTx}=require('./browser.cjs');
 const db={query:async(...args)=>{try{return await c.query(...args);}catch(error){if(error&&typeof error==='object')error.auditCategory='DB_ERROR';throw error;}}};
 await db.query('BEGIN');
 try{
  const active=(await db.query("SELECT id,account_name,expected_handle,kind,content,status,result_id FROM xc_auto_jobs WHERE id=$1 FOR UPDATE",[jobId])).rows[0];
  if(!active)throw Error('Publication job missing');
  if(!['post','reply'].includes(active.kind))throw Error('Only posts and replies have tweet IDs');
  if(active.status==='published'&&String(active.result_id||'')===tweetId){
   await db.query('COMMIT');
   return {ok:true,alreadyConfirmed:true};
  }
  if(active.status!==expected)throw Error('Publication state changed before finalization');
  if(String(active.account_name)!==String(job.account_name)||String(active.expected_handle).toLowerCase()!==String(job.expected_handle).toLowerCase())throw Error('Publication account identity mismatch');
  if(reconStates){
   const reconciliation=(await db.query('SELECT status FROM xc_auto_reconcile WHERE job_id=$1 FOR UPDATE',[jobId])).rows[0];
   if(!reconciliation||!reconStates.includes(reconciliation.status))throw Error('Reconciliation status changed before finalization');
  }
  await persistPostTx(db,active,tweetId,data);
  const now=Date.now();
  const changed=await db.query("UPDATE xc_auto_jobs SET status='published',result_id=$2,result_url=$3,message=$4,finished_at=$5,lease_until=NULL WHERE id=$1 AND status=$6 RETURNING id",[jobId,tweetId,'https://x.com/'+active.expected_handle+'/status/'+tweetId,options.message||'Публикация подтверждена в X.',now,expected]);
  if(changed.rowCount!==1)throw Error('Publication status update failed');
  if(reconStates){
   const reconciled=await db.query("UPDATE xc_auto_reconcile SET status='resolved',matched_tweet_id=$2,candidates=COALESCE($3::jsonb,candidates),last_error=$4,updated_at=$5,finished_at=$5 WHERE job_id=$1 AND status=ANY($6::text[]) RETURNING job_id",[jobId,tweetId,options.candidates??null,options.lastError??null,now,reconStates]);
   if(reconciled.rowCount!==1)throw Error('Reconciliation state update failed');
  }
  await db.query('COMMIT');
  return {ok:true,alreadyConfirmed:false};
 }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}
}
module.exports={finalizePublication};
