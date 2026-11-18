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
    // All six statuses migration 020 provisions must be accepted.
    for(const status of ["open","sending","delivered","acknowledged","resolved","dead_lettered"]){
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
      // 'open' rows are bounded by the retry budget; stale 'sending' rows are
      // reclaimable at any attempt count so a crash between claim and the
      // terminal update self-heals: the next run either delivers or
      // dead-letters the alert on the failure path.
      const claimed=await client.query(`WITH picked AS (
        SELECT alert_id FROM token_alerts
        WHERE triggered_at <= NOW()
          AND (
            (status='open' AND delivery_attempts < 10
              AND (delivery_attempted_at IS NULL
                   OR delivery_attempted_at < NOW()-INTERVAL '1 minute'))
            OR (status='sending' AND delivery_attempted_at < NOW()-INTERVAL '10 minutes')
          )
        ORDER BY triggered_at ASC LIMIT $1 FOR UPDATE SKIP LOCKED
      )
      UPDATE token_alerts AS alert
      SET status='sending',delivery_attempts=alert.delivery_attempts+1,delivery_attempted_at=NOW()
      FROM picked WHERE alert.alert_id=picked.alert_id
      RETURNING alert.alert_id,alert.canonical_token_id,alert.alert_type,alert.severity,
        alert.triggered_at,alert.score,alert.score_version,alert.evidence_refs,alert.delivery_attempts`,[limit]);
      rows=claimed.rows;
      await client.query("COMMIT");
    } catch(error) {
      try{await client.query("ROLLBACK");}catch{}
      throw error;
    } finally {client.release();}
    let delivered=0,failed=0;
    for(const row of rows) {
      let sent=false;
      try {
        const response=await fetch("https://api.telegram.org/bot"+botToken+"/sendMessage",{
          method:"POST",
          headers:{"content-type":"application/json"},
          body:JSON.stringify({chat_id:chatId,text:formatAlert(row)}),
          signal:AbortSignal.timeout(10_000),
        });
        if(response.ok) {
          const payload=await response.json();
          sent=payload?.ok===true;
        }
      } catch {
        sent=false;
      }
      if(sent) {
        await pool.query("UPDATE token_alerts SET status='delivered',delivered_at=NOW() WHERE alert_id=$1 AND status='sending' AND delivery_attempts=$2",[row.alert_id,row.delivery_attempts]);
        delivered++;
      } else {
        // Terminal dead-letter state after the retry budget is exhausted:
        // leaving the alert as 'open' would silently drop it from both the
        // claim query and any operator dashboard. A one-minute backoff on
        // 'open' rows keeps a Telegram outage from hammering the Bot API.
        await pool.query(
          "UPDATE token_alerts SET status=CASE WHEN delivery_attempts >= 10 "
          +"THEN 'dead_lettered' ELSE 'open' END "
          +"WHERE alert_id=$1 AND status='sending' AND delivery_attempts=$2",
          [row.alert_id,row.delivery_attempts]);
        failed++;
      }
    }
    process.stdout.write(JSON.stringify({claimed:rows.length,delivered,failed})+"\n");
    if(failed)process.exitCode=1;
  } finally {await pool.end();}
}
main().catch((error)=>{
  const code=error instanceof Error&&/^[a-z0-9_]+$/.test(error.message)?error.message:"telegram_alert_dispatch_failed";
  process.stderr.write(code+"\n");
  process.exitCode=1;
});
