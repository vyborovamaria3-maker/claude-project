// V2-01: sanitize and correlate classified errors without storing raw
// browser/network messages, cookies, tokens, proxies, or tweet content.
const {classifyPreSendError}=require('./publish-retry.cjs');

const X_CODES=new Set(['SESSION_EXPIRED','PROXY_FAILED','X_RESTRICTED','TEMPORARY_NETWORK']);
const VALIDATION_CODES=new Set(['ACCOUNT_MISMATCH','ACCOUNT_INACTIVE','JOB_NOT_ELIGIBLE','TARGET_NOT_FOUND']);
function classifyAuditError(error){
 const sqlstate=typeof error?.code==='string'&&/^[0-9A-Z]{5}$/.test(error.code)?error.code:null;
 if(sqlstate)return {category:'DB_ERROR',code:'PG_'+sqlstate};
 const classified=classifyPreSendError(error);
 if(X_CODES.has(classified.code))return {category:'X_ERROR',code:classified.code};
 if(VALIDATION_CODES.has(classified.code))return {category:'VALIDATION_ERROR',code:classified.code};
 return {category:'PROCESS_ERROR',code:'PRE_SEND_FAILED'};
}

// Caller must already be inside the SAME DB transaction as the job status update.
// Never issue BEGIN/COMMIT here and never call an X action from this helper.
async function recordAttemptFailure(c,jobId,error){
 const failure=classifyAuditError(error);
 const updated=await c.query(`
  UPDATE xc_auto_job_attempts AS a
     SET error_category=$2,error_code=$3
   WHERE a.job_id=$1
     AND a.attempt_no=(SELECT max(attempt_no) FROM xc_auto_job_attempts WHERE job_id=$1)
   RETURNING attempt_id,trace_id`,[jobId,failure.category,failure.code]);
 const attempt=updated.rows[0];
 if(attempt)await c.query(`
  INSERT INTO xc_auto_job_events(job_id,attempt_id,trace_id,event_type,occurred_at,payload)
  VALUES($1,$2,$3,'error_classified',$4,$5::jsonb)`,
  [jobId,attempt.attempt_id,attempt.trace_id,Date.now(),JSON.stringify({category:failure.category,code:failure.code})]);
 return failure;
}

module.exports={classifyAuditError,recordAttemptFailure};
