#!/usr/bin/env node
import pg from "pg";

function requiredEnv(name,pattern) {
  const value=process.env[name];
  if(!value||!pattern.test(value))throw new Error("invalid_"+name.toLowerCase());
  return value;
}
function safeRefs(value) {
  if(!Array.isArray(value))return [];
  return value.filter((item)=>typeof item==="string"&&item.length>0&&item.length<=256).slice(0,8);
}
function formatAlert(row) {
  const score=row.score===null||row.score===undefined?"n/a":String(Number(Number(row.score).toFixed(4)));
  const refs=safeRefs(row.evidence_refs).join(", ")||"none";
  return [
    "[POTAPoff] "+String(row.severity).toUpperCase()+" "+String(row.alert_type),
    "Alert ID: "+String(row.alert_id),
    "Token: "+String(row.canonical_token_id),
    "Score: "+score+" ("+String(row.score_version??"unversioned")+")",
    "Triggered at: "+new Date(row.triggered_at).toISOString(),
    "Evidence: "+refs,
  ].join("\n").slice(0,3500);
}
async function main() {
  const connectionString=process.env.INTELLIGENCE_DATABASE_URL;
  if(!connectionString)throw new Error("database_config_required");
  const botToken=requiredEnv("TELEGRAM_BOT_TOKEN",/^\d{6,12}:[A-Za-z0-9_-]{20,128}$/);
  const chatId=requiredEnv("TELEGRAM_CHAT_ID",/^(?:-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/);
  const limit=Number(process.env.INTELLIGENCE_ALERT_BATCH_SIZE??"20");
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error("invalid_alert_batch_size");
  // Testability knobs: production defaults are unchanged; tests point the
  // API base at an unreachable endpoint and shorten the fetch timeout to
  // exercise failure paths without touching Telegram or real credentials.
  const apiBase=process.env.INTELLIGENCE_TELEGRAM_API_BASE??"https://api.telegram.org";
  const fetchTimeoutMs=Number(process.env.INTELLIGENCE_TELEGRAM_TIMEOUT_MS??"10000");
  if(!Number.isSafeInteger(fetchTimeoutMs)||fetchTimeoutMs<100||fetchTimeoutMs>120000)throw new Error("invalid_alert_fetch_timeout");
  const pool=new pg.Pool({
    connectionString,max:2,connectionTimeoutMillis:3000,
    query_timeout:10000,statement_timeout:8000,options:"-c statement_timeout=8000",
  });
  // Fail fast when the terminal dead-letter status has not been provisioned
  // yet (migration 020); otherwise the first exhausted alert would crash the
  // dispatch loop mid-run on the CHECK constraint violation. The deployed
  // CHECK is verified behaviorally (same replay discipline as
  // assertEnvelopeFingerprintContract): a substring match would accept
  // malformed variants such as CHECK (status <> 'dead_lettered') or a
  // domain missing required statuses, and the run would still crash later.
  const probeClient=await pool.connect();
  let probeReleased=false;
  const releaseProbe=()=>{
    if(!probeReleased){probeReleased=true;probeClient.release();}
  };
  try {
    const statusCheck=await probeClient.query(
      "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint "
      +"WHERE conrelid='token_alerts'::regclass "
      +"AND conname='token_alerts_status_check' "
      +"AND contype='c'");
    const constraintDef=String(statusCheck.rows[0]?.def ?? "");
    if(!/^CHECK\s*\(/i.test(constraintDef)){
      throw new Error("intelligence_migration_020_required");
    }
    // Replay the exact deployed expression on a probe table so the accepted
    // status domain is exercised, not inferred from definition text.
    await probeClient.query(
      "CREATE TEMP TABLE token_alerts_status_preflight_probe(status text NOT NULL, "
      +constraintDef+")");
    // All statuses migration 020/021 provision must be accepted.
    for(const status of ["open","sending","delivered","acknowledged","resolved","dead_lettered","needs_review"]){
      try {
        await probeClient.query(
          "INSERT INTO token_alerts_status_preflight_probe(status) VALUES($1)",[status]);
      } catch(error) {
        // Error surfaces as the snake_case code via the top-level handler;
        // the rejected status is encoded in the code itself.
        throw new Error("token_alerts_status_check_rejects_required_status_"+status);
      }
    }
    // Plausible out-of-domain values must be rejected by the same constraint.
    for(const status of ["closed","zprobeinvalid"]){
      let rejected=false;
      try {
        await probeClient.query(
          "INSERT INTO token_alerts_status_preflight_probe(status) VALUES($1)",[status]);
      } catch(error) {
        if(error && error.code==="23514")rejected=true;
        else throw error;
      }
      if(!rejected){
        throw new Error("token_alerts_status_check_accepts_invalid_status_"+status);
      }
    }
    await probeClient.query("DROP TABLE token_alerts_status_preflight_probe");
  } catch(error) {
    // Mirror the old fail-fast contract: close the pool before surfacing the
    // preflight error so the process exits promptly instead of hanging.
    releaseProbe();
    await pool.end().catch(()=>{});
    throw error;
  } finally {
    // The probe table lives in this pooled session only; make sure it never
    // leaks into later claim work even when a preflight error was thrown.
    releaseProbe();
  }
  try {
    const client=await pool.connect();
    let rows;
    try {
      await client.query("BEGIN");
      // Fail-closed claim semantics (migration 021 fencing):
      //  * 'open' rows are bounded by the 10-attempt retry budget and a
      //    one-minute backoff so a Telegram outage does not hammer the API.
      //  * Stale 'sending' rows (crash between claim and the terminal
      //    update) self-heal ONLY inside the budget: re-claiming an
      //    exhausted row would fire an automatic 11th send, which is
      //    forbidden. Stale exhausted rows are parked in 'needs_review'
      //    for operator release instead.
      //  * Every claim receives a unique fencing token; terminal writes
      //    and the pre-send freshness check are guarded by it, so a stale
      //    worker can never overwrite another worker's decision.
      await client.query(
        "UPDATE token_alerts SET status='needs_review' "
        +"WHERE status='sending' AND delivery_attempts>=10 "
        +"AND delivery_attempted_at < NOW()-INTERVAL '10 minutes'");
      const claimed=await client.query(`WITH picked AS (
        SELECT alert_id FROM token_alerts
        WHERE triggered_at <= NOW()
          AND (
            (status='open' AND delivery_attempts < 10
              AND (delivery_attempted_at IS NULL
                   OR delivery_attempted_at < NOW()-INTERVAL '1 minute'))
            OR (status='sending' AND delivery_attempts < 10
              AND delivery_attempted_at < NOW()-INTERVAL '10 minutes')
          )
        ORDER BY triggered_at ASC LIMIT $1 FOR UPDATE SKIP LOCKED
      )
      UPDATE token_alerts AS alert
      SET status='sending',delivery_attempts=alert.delivery_attempts+1,delivery_attempted_at=NOW(),
          claim_token=gen_random_uuid()
      FROM picked WHERE alert.alert_id=picked.alert_id
      RETURNING alert.alert_id,alert.canonical_token_id,alert.alert_type,alert.severity,
        alert.triggered_at,alert.score,alert.score_version,alert.evidence_refs,alert.delivery_attempts,
        alert.claim_token`,[limit]);
      rows=claimed.rows;
      await client.query("COMMIT");
    } catch(error) {
      try{await client.query("ROLLBACK");}catch{}
      throw error;
    } finally {client.release();}
    // Test/injection knob (production default 0): pauses between the claim
    // transaction and the pre-send lease renewal so a test can interleave
    // ownership changes - worker pause, lease loss, re-claim -
    // deterministically. It never alters claim or fencing semantics.
    const claimDelayMs=Number(process.env.INTELLIGENCE_TELEGRAM_CLAIM_DELAY_MS??"0");
    if(claimDelayMs>0)await new Promise((resolve)=>setTimeout(resolve,claimDelayMs));
    let delivered=0,failed=0,fenced=0,ambiguous=0;
    for(const row of rows) {
      // Atomically renew the lease immediately before the outbound call.
      // This is both the freshness check and an ownership assertion: a
      // worker whose token was replaced by another claim (lease expired,
      // row re-claimed) affects zero rows here and must never reach the
      // API. Renewing also pushes the claim lease out by a full window, so
      // a concurrent worker cannot reclaim while this send is in flight.
      // The residual duplicate window - a worker stalling longer than a
      // full lease between this renewal and the fetch - is documented in
      // migrations/021_alert_claim_fencing.sql and cannot be eliminated
      // without an idempotency key on the Telegram side.
      const renewal=await pool.query(
        "UPDATE token_alerts SET delivery_attempted_at=NOW() "
        +"WHERE alert_id=$1 AND status='sending' AND claim_token=$2",
        [row.alert_id,row.claim_token]);
      if(renewal.rowCount===0){
        fenced++;
        continue;
      }
      let outcome; // "delivered" | "failed" | "ambiguous"
      try {
        const response=await fetch(apiBase+"/bot"+botToken+"/sendMessage",{
          method:"POST",
          headers:{"content-type":"application/json"},
          body:JSON.stringify({chat_id:chatId,text:formatAlert(row)}),
          signal:AbortSignal.timeout(fetchTimeoutMs),
        });
        if(response.ok) {
          const payload=await response.json();
          outcome=payload?.ok===true?"delivered":"failed";
        } else if(response.status>=500||response.status===408) {
          // A server-side error or request timeout does NOT prove the
          // message was not processed: the upstream may have accepted and
          // delivered it before failing the response. Automatic retries
          // after such an outcome could duplicate the alert, so the row is
          // parked for operator review like any other ambiguous outcome.
          outcome="ambiguous";
        } else {
          // A definite client-side rejection (4xx) proves the request was
          // received and refused without a send: safe to classify as a
          // normal retryable failure.
          outcome="failed";
        }
      } catch(error) {
        // A network error that proves the request never reached Telegram
        // is a safe retryable failure; anything else (timeout after the
        // request may have been transmitted, mid-response reset, unknown
        // transport condition) is ambiguous: the message may have been
        // delivered. Automatic retries after an ambiguous outcome could
        // duplicate the message, so the alert is parked for operator
        // review instead.
        const code=error?.cause?.code??error?.code;
        outcome=(code==="ECONNREFUSED"||code==="ENOTFOUND"||code==="EAI_AGAIN")?"failed":"ambiguous";
      }
      let updated=0;
      if(outcome==="delivered") {
        const fence=await pool.query(
          "UPDATE token_alerts SET status='delivered',delivered_at=NOW() "
          +"WHERE alert_id=$1 AND status='sending' AND claim_token=$2",
          [row.alert_id,row.claim_token]);
        updated=fence.rowCount;
        if(updated)delivered++;
      } else if(outcome==="ambiguous") {
        const fence=await pool.query(
          "UPDATE token_alerts SET status='needs_review' "
          +"WHERE alert_id=$1 AND status='sending' AND claim_token=$2",
          [row.alert_id,row.claim_token]);
        updated=fence.rowCount;
        if(updated)ambiguous++;
      } else {
        // Terminal dead-letter state after the retry budget is exhausted:
        // leaving the alert as 'open' would silently drop it from both the
        // claim query and any operator dashboard. The write is fenced by
        // the claim token, so a stale worker never reclassifies a row that
        // another worker now owns.
        const fence=await pool.query(
          "UPDATE token_alerts SET status=CASE WHEN delivery_attempts >= 10 "
          +"THEN 'dead_lettered' ELSE 'open' END "
          +"WHERE alert_id=$1 AND status='sending' AND claim_token=$2",
          [row.alert_id,row.claim_token]);
        updated=fence.rowCount;
        if(updated)failed++;
      }
      if(!updated)fenced++;
    }
    // DB ACKs prove only the database state. They are NOT proof that no
    // external side effect occurred (or occurred twice): see the honest
    // semantics note in migrations/021_alert_claim_fencing.sql.
    process.stdout.write(JSON.stringify({claimed:rows.length,delivered,failed,fenced,ambiguous})+"\n");
    if(failed)process.exitCode=1;
  } finally {await pool.end();}
}
main().catch((error)=>{
  const code=error instanceof Error&&/^[a-z0-9_]+$/.test(error.message)?error.message:"telegram_alert_dispatch_failed";
  process.stderr.write(code+"\n");
  process.exitCode=1;
});
