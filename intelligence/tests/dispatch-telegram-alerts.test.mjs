import test from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {randomBytes} from "node:crypto";
import path from "node:path";
import {fileURLToPath} from "node:url";
import pg from "pg";

// Integration coverage for the Telegram alert dispatcher failure path.
// Uses a disposable PostgreSQL schema and never touches the real Telegram
// API: definite-failure runs point at a closed local port (ECONNREFUSED -
// the request provably never leaves the machine), ambiguous runs at a
// non-routable address. No message can ever be delivered to any user.
const url=process.env.INTELLIGENCE_TEST_DB_URL;
const script=path.join(path.dirname(fileURLToPath(import.meta.url)),"..","scripts","dispatch-telegram-alerts.mjs");

function runDispatcher(databaseUrl,extraEnv){
  try{
    return execFileSync(process.execPath,[script],{
      env:{
        ...process.env,
        INTELLIGENCE_DATABASE_URL:databaseUrl,
        TELEGRAM_BOT_TOKEN:"123456:"+("A".repeat(40)),
        TELEGRAM_CHAT_ID:"1999999999",
        INTELLIGENCE_ALERT_BATCH_SIZE:"10",
        ...(extraEnv??{}),
      },
      encoding:"utf8",
    });
  }catch(error){
    // The dispatcher exits non-zero when any dispatch failed; the JSON batch
    // summary on stdout is still the expected outcome for this test.
    if(error.stdout && /"failed":[1-9]/.test(error.stdout))return error.stdout;
    throw error;
  }
}

function runDispatcherRaw(databaseUrl,extraEnv){
  try{
    const stdout=execFileSync(process.execPath,[script],{
      env:{
        ...process.env,
        INTELLIGENCE_DATABASE_URL:databaseUrl,
        TELEGRAM_BOT_TOKEN:"123456:"+("A".repeat(40)),
        TELEGRAM_CHAT_ID:"1999999999",
        INTELLIGENCE_ALERT_BATCH_SIZE:"10",
        ...(extraEnv??{}),
      },
      encoding:"utf8",
      stdio:["ignore","pipe","pipe"],
    });
    return {stdout,stderr:"",status:0};
  }catch(error){
    return {stdout:error.stdout??"",stderr:error.stderr??"",status:error.status??1};
  }
}

test("telegram alert dispatcher: retry budget, open-row backoff and dead-letter terminal state",{
  skip:!url,
},async()=>{
  const admin=new pg.Client({connectionString:url});
  await admin.connect();
  const schema="alert_dispatch_"+randomBytes(5).toString("hex");
  let pool;
  try{
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query("SET search_path TO "+schema);
    const {readFile}=await import("node:fs/promises");
    for(const name of ["006_cross_platform_analytics.sql","008_alert_status_history.sql"]){
      await admin.query(await readFile(new URL("../migrations/"+name,import.meta.url),"utf8"));
    }
    await admin.query(await readFile(new URL("../migrations/020_alert_dead_letter.sql",import.meta.url),"utf8"));
    await admin.query(await readFile(new URL("../migrations/021_alert_claim_fencing.sql",import.meta.url),"utf8"));

    const connectionUrl=url+(url.includes("?")?"&":"?")+"options="+encodeURIComponent(`-c search_path=${schema}`);
    pool=new pg.Pool({connectionString:connectionUrl,max:2});

    // Seeding needs the alert tables created inside the fixture schema.
    for(const table of ["token_alerts","token_alert_status_history"]){
      const exists=await pool.query("SELECT to_regclass($1) IS NOT NULL AS present",[schema+"."+table]);
      if(!exists.rows[0].present){
        throw new Error("fixture table missing: "+table);
      }
    }
    await pool.query(
      `INSERT INTO token_alerts
         (canonical_token_id,alert_type,severity,triggered_at,as_of,status,delivery_attempts,delivery_attempted_at)
       VALUES ('probe_token','score_threshold','info',NOW(),NOW()-INTERVAL '1 minute','open',0,NULL)`);

    // 1. Fresh 'open' row is claimed, the unauthorized token fails, and the
    //    alert returns to 'open' with one recorded attempt (not delivered,
    //    not dead-lettered).
    const first=JSON.parse(runDispatcher(connectionUrl,{INTELLIGENCE_TELEGRAM_API_BASE:"http://127.0.0.1:59999"}));
    assert.equal(first.claimed,1);
    assert.equal(first.delivered,0);
    assert.equal(first.failed,1);
    let row=(await pool.query("SELECT status,delivery_attempts FROM token_alerts")).rows[0];
    assert.equal(row.status,"open");
    assert.equal(row.delivery_attempts,1);

    // 2. The one-minute open-row backoff prevents immediate re-claim.
    const second=JSON.parse(runDispatcher(connectionUrl,{INTELLIGENCE_TELEGRAM_API_BASE:"http://127.0.0.1:59999"}));
    assert.equal(second.claimed,0,"fresh 'open' rows must wait out the backoff");

    // 3. Exhausting the retry budget lands the alert in the terminal
    //    dead-letter state instead of silently dropping it.
    await pool.query(
      "UPDATE token_alerts SET delivery_attempts=9,delivery_attempted_at=NOW()-INTERVAL '2 minutes'");
    const third=JSON.parse(runDispatcher(connectionUrl,{INTELLIGENCE_TELEGRAM_API_BASE:"http://127.0.0.1:59999"}));
    assert.equal(third.claimed,1);
    assert.equal(third.failed,1);
    row=(await pool.query("SELECT status,delivery_attempts FROM token_alerts")).rows[0];
    assert.equal(row.status,"dead_lettered");
    assert.equal(row.delivery_attempts,10);
    const fourth=JSON.parse(runDispatcher(connectionUrl,{INTELLIGENCE_TELEGRAM_API_BASE:"http://127.0.0.1:59999"}));
    assert.equal(fourth.claimed,0,"dead-lettered alerts must leave the claim queue");
  }finally{
    if(pool)await pool.end();
    await admin.query("SET search_path TO public");
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});

test("migration 020: converts exhausted 'sending' rows only after lease expiry, idempotent on re-run",{
  skip:!url,
},async()=>{
  const admin=new pg.Client({connectionString:url});
  await admin.connect();
  const schema="alert_mig020_"+randomBytes(5).toString("hex");
  const {readFile}=await import("node:fs/promises");
  try{
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query("SET search_path TO "+schema);
    for(const name of ["006_cross_platform_analytics.sql","008_alert_status_history.sql"]){
      await admin.query(await readFile(new URL("../migrations/"+name,import.meta.url),"utf8"));
    }
    await admin.query(
      `INSERT INTO token_alerts
         (canonical_token_id,alert_type,severity,triggered_at,as_of,status,delivery_attempts,delivery_attempted_at)
       VALUES
         ('mig_open_exhausted','score_threshold','info',NOW()-INTERVAL '4 minute',NOW()-INTERVAL '30 minutes','open',10,NOW()-INTERVAL '15 minutes'),
         ('mig_sending_expired','score_threshold','info',NOW()-INTERVAL '3 minute',NOW()-INTERVAL '30 minutes','sending',10,NOW()-INTERVAL '15 minutes'),
         ('mig_sending_active','score_threshold','info',NOW()-INTERVAL '2 minute',NOW()-INTERVAL '30 minutes','sending',10,NOW()-INTERVAL '1 minute'),
         ('mig_sending_budget_left','score_threshold','info',NOW()-INTERVAL '1 minute',NOW()-INTERVAL '30 minutes','sending',9,NOW()-INTERVAL '15 minutes')`);

    const migration020=await readFile(new URL("../migrations/020_alert_dead_letter.sql",import.meta.url),"utf8");
    await admin.query(migration020);

    const status=(await admin.query(
      "SELECT canonical_token_id,status,delivery_attempts FROM token_alerts ORDER BY canonical_token_id")).rows;
    assert.deepEqual(status,[
      {canonical_token_id:"mig_open_exhausted",status:"dead_lettered",delivery_attempts:10},
      {canonical_token_id:"mig_sending_active",status:"sending",delivery_attempts:10},
      {canonical_token_id:"mig_sending_budget_left",status:"sending",delivery_attempts:9},
      {canonical_token_id:"mig_sending_expired",status:"dead_lettered",delivery_attempts:10},
    ]);

    // Re-running the migration must converge: no duplicate constraints, no
    // extra history rows, no further status changes.
    await admin.query(migration020);
    const constraints=(await admin.query(
      "SELECT conrelid::regclass::text AS table_name, count(*) AS n FROM pg_constraint "
      +"WHERE conname IN ('token_alerts_status_check','token_alert_status_history_status_check') "
      +"AND conrelid IN (format('%I.token_alerts',$1::text)::regclass,format('%I.token_alert_status_history',$1::text)::regclass) "
      +"GROUP BY conrelid::regclass::text",[schema])).rows
      .sort((a,b)=>a.table_name<b.table_name?-1:1);
    assert.deepEqual(constraints,[
      {table_name:"token_alert_status_history",n:"1"},
      {table_name:"token_alerts",n:"1"},
    ]);
    const historyCount=(await admin.query(
      "SELECT count(*)::int AS n FROM token_alert_status_history")).rows[0].n;
    assert.equal(historyCount,6,"4 initial rows + one transition for each converted alert");
    const statusAfterRerun=(await admin.query(
      "SELECT canonical_token_id,status,delivery_attempts FROM token_alerts ORDER BY canonical_token_id")).rows;
    assert.deepEqual(statusAfterRerun,status);
  }finally{
    await admin.query("SET search_path TO public");
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});

test("telegram alert dispatcher fails fast when migration 020 has not been applied",{
  skip:!url,
},async()=>{
  const admin=new pg.Client({connectionString:url});
  await admin.connect();
  const schema="alert_failfast_"+randomBytes(5).toString("hex");
  const {readFile}=await import("node:fs/promises");
  try{
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query("SET search_path TO "+schema);
    for(const name of ["006_cross_platform_analytics.sql","008_alert_status_history.sql"]){
      await admin.query(await readFile(new URL("../migrations/"+name,import.meta.url),"utf8"));
    }
    await admin.query(
      `INSERT INTO token_alerts
         (canonical_token_id,alert_type,severity,triggered_at,as_of,status,delivery_attempts,delivery_attempted_at)
       VALUES ('failfast_probe','score_threshold','info',NOW(),NOW()-INTERVAL '1 minute','open',0,NULL)`);
    const connectionUrl=url+(url.includes("?")?"&":"?")+"options="+encodeURIComponent(`-c search_path=${schema}`);
    const result=runDispatcherRaw(connectionUrl,{INTELLIGENCE_TELEGRAM_API_BASE:"http://127.0.0.1:59999"});
    assert.notEqual(result.status,0,"dispatcher must exit non-zero without migration 020");
    assert.match(result.stderr,/intelligence_migration_020_required|token_alerts_status_check_rejects_required_status_/);
    const row=(await admin.query(
      "SELECT status,delivery_attempts FROM token_alerts WHERE canonical_token_id='failfast_probe'")).rows[0];
    assert.equal(row.status,"open","no rows may be claimed or mutated without migration 020");
    assert.equal(row.delivery_attempts,0);
  }finally{
    await admin.query("SET search_path TO public");
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});

test("telegram alert dispatcher parks stale exhausted 'sending' rows for review and never sends an 11th attempt",{
  skip:!url,
},async()=>{
  const admin=new pg.Client({connectionString:url});
  await admin.connect();
  const schema="alert_selfheal_"+randomBytes(5).toString("hex");
  const {readFile}=await import("node:fs/promises");
  let pool;
  try{
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query("SET search_path TO "+schema);
    for(const name of ["006_cross_platform_analytics.sql","008_alert_status_history.sql"]){
      await admin.query(await readFile(new URL("../migrations/"+name,import.meta.url),"utf8"));
    }
    await admin.query(await readFile(new URL("../migrations/020_alert_dead_letter.sql",import.meta.url),"utf8"));
    await admin.query(await readFile(new URL("../migrations/021_alert_claim_fencing.sql",import.meta.url),"utf8"));

    const connectionUrl=url+(url.includes("?")?"&":"?")+"options="+encodeURIComponent(`-c search_path=${schema}`);
    pool=new pg.Pool({connectionString:connectionUrl,max:2});
    await pool.query(
      `INSERT INTO token_alerts
         (canonical_token_id,alert_type,severity,triggered_at,as_of,status,delivery_attempts,delivery_attempted_at)
       VALUES
         ('heal_crashed_at_budget','score_threshold','info',NOW()-INTERVAL '3 minute',NOW()-INTERVAL '30 minutes','sending',10,NOW()-INTERVAL '15 minutes'),
         ('heal_final_retry','score_threshold','info',NOW()-INTERVAL '2 minute',NOW()-INTERVAL '30 minutes','sending',9,NOW()-INTERVAL '15 minutes'),
         ('heal_inflight','score_threshold','info',NOW()-INTERVAL '1 minute',NOW()-INTERVAL '30 minutes','sending',10,NOW()-INTERVAL '1 minute')`);

    // The unauthorized bot token fails every send with a definite HTTP
    // answer, so claims exercise the failure path. The stale exhausted row
    // (attempts=10) is parked for operator review, NOT reclaimed: an
    // automatic 11th send is forbidden by the retry budget.
    const first=JSON.parse(runDispatcher(connectionUrl,{INTELLIGENCE_TELEGRAM_API_BASE:"http://127.0.0.1:59999"}));
    assert.equal(first.claimed,1,"only the row with budget left may be claimed");
    assert.equal(first.delivered,0);
    assert.equal(first.failed,1);
    assert.equal(first.ambiguous,0);
    let rows=(await pool.query(
      "SELECT canonical_token_id,status,delivery_attempts FROM token_alerts ORDER BY canonical_token_id")).rows;
    assert.deepEqual(rows,[
      {canonical_token_id:"heal_crashed_at_budget",status:"needs_review",delivery_attempts:10},
      {canonical_token_id:"heal_final_retry",status:"dead_lettered",delivery_attempts:10},
      {canonical_token_id:"heal_inflight",status:"sending",delivery_attempts:10},
    ]);
    const history=(await pool.query(
      "SELECT history.status FROM token_alert_status_history history "
      +"JOIN token_alerts alerts ON alerts.alert_id=history.alert_id ORDER BY history.history_id")).rows;
    assert.deepEqual(history.map(h=>h.status),
      ["sending","sending","sending","needs_review","dead_lettered"],
      "history preserves the original sending states and both transitions");

    const second=JSON.parse(runDispatcher(connectionUrl,{INTELLIGENCE_TELEGRAM_API_BASE:"http://127.0.0.1:59999"}));
    assert.equal(second.claimed,0,"needs_review and in-flight rows never re-enter the automatic queue");
    rows=(await pool.query(
      "SELECT canonical_token_id,status,delivery_attempts FROM token_alerts ORDER BY canonical_token_id")).rows;
    assert.deepEqual(rows,[
      {canonical_token_id:"heal_crashed_at_budget",status:"needs_review",delivery_attempts:10},
      {canonical_token_id:"heal_final_retry",status:"dead_lettered",delivery_attempts:10},
      {canonical_token_id:"heal_inflight",status:"sending",delivery_attempts:10},
    ]);
  }finally{
    if(pool)await pool.end();
    await admin.query("SET search_path TO public");
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});

test("telegram alert dispatcher preflight behaviorally rejects malformed status CHECK constraints",{
  skip:!url,
},async()=>{
  const admin=new pg.Client({connectionString:url});
  await admin.connect();
  // Each variant is a deliberately malformed deployed constraint. The
  // behavioral preflight must fail the run with a domain-specific error;
  // the previous substring implementation (mutation baseline) accepted
  // variants 2-4 and crashed later mid-run instead.
  const variants=[
    {name:"no_constraint",sql:"",
     expect:/intelligence_migration_020_required/},
    {name:"rejects_dead_lettered",sql:"CHECK (status <> 'dead_lettered')",
     expect:/token_alerts_status_check_rejects_required_status_dead_lettered/},
    {name:"missing_statuses",sql:"CHECK (status IN ('open','sending'))",
     expect:/token_alerts_status_check_rejects_required_status_delivered/},
    {name:"permissive_junk",
     sql:"CHECK (status IN ('open','sending','delivered','acknowledged','resolved','dead_lettered') OR length(status) > 0)",
     expect:/token_alerts_status_check_accepts_invalid_status_closed|token_alerts_status_check_accepts_invalid_status_zprobeinvalid/},
  ];
  try{
    for(const variant of variants){
      const schema="alert_preflight_"+randomBytes(5).toString("hex");
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await admin.query("SET search_path TO "+schema);
      await admin.query(
        "CREATE TABLE token_alerts(alert_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, status text NOT NULL"
        +(variant.sql?", "+variant.sql:"")+")");
      const connectionUrl=url+(url.includes("?")?"&":"?")+"options="+encodeURIComponent(`-c search_path=${schema}`);
      const result=runDispatcherRaw(connectionUrl,{INTELLIGENCE_TELEGRAM_API_BASE:"http://127.0.0.1:59999"});
      assert.notEqual(result.status,0,variant.name+": dispatcher must exit non-zero");
      assert.match(result.stderr,variant.expect,variant.name+": wrong failure mode");
      await admin.query("SET search_path TO public");
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
    // Positive control: the deployed six-status domain passes the behavioral
    // preflight and the run proceeds past it. The unauthorized bot token is
    // still used, so no message can ever be delivered.
    const {readFile}=await import("node:fs/promises");
    const schema="alert_preflight_ok_"+randomBytes(5).toString("hex");
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query("SET search_path TO "+schema);
    for(const name of ["006_cross_platform_analytics.sql","008_alert_status_history.sql"]){
      await admin.query(await readFile(new URL("../migrations/"+name,import.meta.url),"utf8"));
    }
    await admin.query(await readFile(new URL("../migrations/020_alert_dead_letter.sql",import.meta.url),"utf8"));
    await admin.query(await readFile(new URL("../migrations/021_alert_claim_fencing.sql",import.meta.url),"utf8"));
    const connectionUrl=url+(url.includes("?")?"&":"?")+"options="+encodeURIComponent(`-c search_path=${schema}`);
    const result=runDispatcherRaw(connectionUrl,{INTELLIGENCE_TELEGRAM_API_BASE:"http://127.0.0.1:59999"});
    assert.equal(result.status,0,"the correct deployed constraint must pass the preflight");
    assert.match(result.stdout,/"claimed":0/);
    assert.doesNotMatch(String(result.stderr),/token_alerts_status_check_/);
  }finally{
    await admin.query("SET search_path TO public");
    await admin.end();
  }
});

test("telegram alert dispatcher fences terminal writes with the per-claim token",{
  skip:!url,
},async()=>{
  const admin=new pg.Client({connectionString:url});
  await admin.connect();
  const schema="alert_fencing_"+randomBytes(5).toString("hex");
  const {readFile}=await import("node:fs/promises");
  let pool;
  try{
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query("SET search_path TO "+schema);
    for(const name of ["006_cross_platform_analytics.sql","008_alert_status_history.sql"]){
      await admin.query(await readFile(new URL("../migrations/"+name,import.meta.url),"utf8"));
    }
    await admin.query(await readFile(new URL("../migrations/020_alert_dead_letter.sql",import.meta.url),"utf8"));
    await admin.query(await readFile(new URL("../migrations/021_alert_claim_fencing.sql",import.meta.url),"utf8"));

    const connectionUrl=url+(url.includes("?")?"&":"?")+"options="+encodeURIComponent(`-c search_path=${schema}`);
    pool=new pg.Pool({connectionString:connectionUrl,max:2});
    await pool.query(
      `INSERT INTO token_alerts
         (canonical_token_id,alert_type,severity,triggered_at,as_of,status,delivery_attempts,delivery_attempted_at)
       VALUES ('fence_probe','score_threshold','info',NOW(),NOW()-INTERVAL '1 minute','open',0,NULL)`);

    // Run 1 claims the alert and assigns claim token T1; the unauthorized
    // token makes the run record a definitive failure.
    const first=JSON.parse(runDispatcher(connectionUrl,{INTELLIGENCE_TELEGRAM_API_BASE:"http://127.0.0.1:59999"}));
    assert.equal(first.claimed,1);
    assert.equal(first.failed,1);
    const afterFirst=(await pool.query(
      "SELECT status,delivery_attempts,claim_token FROM token_alerts")).rows[0];
    assert.equal(afterFirst.status,"open");
    assert.equal(afterFirst.delivery_attempts,1);
    assert.ok(afterFirst.claim_token,"claim must persist its fencing token");
    const staleToken=afterFirst.claim_token;

    // Simulate worker B taking ownership: a fresh 'sending' claim with a new
    // token past the lease window.
    await pool.query(
      "UPDATE token_alerts SET status='sending',delivery_attempts=9,"
      +"delivery_attempted_at=NOW()-INTERVAL '20 minutes',claim_token=gen_random_uuid()");
    const owned=(await pool.query("SELECT claim_token FROM token_alerts")).rows[0].claim_token;
    assert.notEqual(owned,staleToken);

    // Run 2 re-claims inside the budget (attempts 9 -> 10) and dead-letters
    // after the definite 401 failure; a stale worker holding token T1 must
    // not be able to write anything afterwards.
    const second=JSON.parse(runDispatcher(connectionUrl,{INTELLIGENCE_TELEGRAM_API_BASE:"http://127.0.0.1:59999"}));
    assert.equal(second.claimed,1);
    assert.equal(second.failed,1);
    const fencedOld=(await pool.query(
      "UPDATE token_alerts SET status='delivered' "
      +"WHERE alert_id=(SELECT alert_id FROM token_alerts WHERE canonical_token_id='fence_probe') "
      +"AND status='sending' AND claim_token=$1",[staleToken])).rowCount;
    assert.equal(fencedOld,0,"a stale claim token must never overwrite terminal state");
    const row=(await pool.query("SELECT status,delivery_attempts,claim_token FROM token_alerts")).rows[0];
    assert.equal(row.status,"dead_lettered");
    assert.equal(row.delivery_attempts,10);
    assert.notEqual(row.claim_token,staleToken,"the winning token is persisted for audit");
  }finally{
    if(pool)await pool.end();
    await admin.query("SET search_path TO public");
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});

test("telegram alert dispatcher parks ambiguous network outcomes in needs_review and never auto-retries them",{
  skip:!url,
},async()=>{
  const admin=new pg.Client({connectionString:url});
  await admin.connect();
  const schema="alert_ambiguous_"+randomBytes(5).toString("hex");
  const {readFile}=await import("node:fs/promises");
  try{
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query("SET search_path TO "+schema);
    for(const name of ["006_cross_platform_analytics.sql","008_alert_status_history.sql"]){
      await admin.query(await readFile(new URL("../migrations/"+name,import.meta.url),"utf8"));
    }
    await admin.query(await readFile(new URL("../migrations/020_alert_dead_letter.sql",import.meta.url),"utf8"));
    await admin.query(await readFile(new URL("../migrations/021_alert_claim_fencing.sql",import.meta.url),"utf8"));
    await admin.query(
      `INSERT INTO token_alerts
         (canonical_token_id,alert_type,severity,triggered_at,as_of,status,delivery_attempts,delivery_attempted_at)
       VALUES ('ambiguous_probe','score_threshold','info',NOW(),NOW()-INTERVAL '1 minute','open',0,NULL)`);

    const connectionUrl=url+(url.includes("?")?"&":"?")+"options="+encodeURIComponent(`-c search_path=${schema}`);
    // Point the API base at a non-routable address with a short fetch
    // timeout: the request outcome is unknown (it may or may not have been
    // transmitted), so the alert must be parked for operator review, and a
    // second run must NOT re-claim it.
    const result=JSON.parse(runDispatcher(connectionUrl,{
      INTELLIGENCE_TELEGRAM_API_BASE:"http://10.255.255.1",
      INTELLIGENCE_TELEGRAM_TIMEOUT_MS:"300",
    }));
    assert.equal(result.claimed,1);
    assert.equal(result.ambiguous,1);
    assert.equal(result.delivered,0);
    let row=(await admin.query(
      "SELECT status,delivery_attempts FROM token_alerts")).rows[0];
    assert.equal(row.status,"needs_review");
    assert.equal(row.delivery_attempts,1);
    const second=JSON.parse(runDispatcher(connectionUrl,{
      INTELLIGENCE_TELEGRAM_API_BASE:"http://10.255.255.1",
      INTELLIGENCE_TELEGRAM_TIMEOUT_MS:"300",
    }));
    assert.equal(second.claimed,0,"needs_review rows never re-enter the automatic queue");
    row=(await admin.query("SELECT status,delivery_attempts FROM token_alerts")).rows[0];
    assert.equal(row.status,"needs_review");
  }finally{
    await admin.query("SET search_path TO public");
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});

test("telegram alert dispatcher retries definite never-sent failures but parks ambiguous ones",{
  skip:!url,
},async()=>{
  const admin=new pg.Client({connectionString:url});
  await admin.connect();
  const schema="alert_neversent_"+randomBytes(5).toString("hex");
  const {readFile}=await import("node:fs/promises");
  try{
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query("SET search_path TO "+schema);
    for(const name of ["006_cross_platform_analytics.sql","008_alert_status_history.sql"]){
      await admin.query(await readFile(new URL("../migrations/"+name,import.meta.url),"utf8"));
    }
    await admin.query(await readFile(new URL("../migrations/020_alert_dead_letter.sql",import.meta.url),"utf8"));
    await admin.query(await readFile(new URL("../migrations/021_alert_claim_fencing.sql",import.meta.url),"utf8"));
    await admin.query(
      `INSERT INTO token_alerts
         (canonical_token_id,alert_type,severity,triggered_at,as_of,status,delivery_attempts,delivery_attempted_at)
       VALUES ('neversent_probe','score_threshold','info',NOW(),NOW()-INTERVAL '1 minute','open',0,NULL)`);

    const connectionUrl=url+(url.includes("?")?"&":"?")+"options="+encodeURIComponent(`-c search_path=${schema}`);
    // A closed local port fails with ECONNREFUSED: the request provably
    // never reached Telegram, so this is a retryable failure, not an
    // ambiguous one - the alert returns to 'open'.
    const result=JSON.parse(runDispatcher(connectionUrl,{
      INTELLIGENCE_TELEGRAM_API_BASE:"http://127.0.0.1:59999",
      INTELLIGENCE_TELEGRAM_TIMEOUT_MS:"5000",
    }));
    assert.equal(result.claimed,1);
    assert.equal(result.failed,1);
    assert.equal(result.ambiguous,0);
    const row=(await admin.query("SELECT status,delivery_attempts FROM token_alerts")).rows[0];
    assert.equal(row.status,"open");
    assert.equal(row.delivery_attempts,1);
  }finally{
    await admin.query("SET search_path TO public");
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});

test("overlapping dispatcher workers claim every alert exactly once via SKIP LOCKED",{
  skip:!url,
},async()=>{
  const admin=new pg.Client({connectionString:url});
  await admin.connect();
  const schema="alert_concurrent_"+randomBytes(5).toString("hex");
  const {readFile}=await import("node:fs/promises");
  let pool;
  try{
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query("SET search_path TO "+schema);
    for(const name of ["006_cross_platform_analytics.sql","008_alert_status_history.sql"]){
      await admin.query(await readFile(new URL("../migrations/"+name,import.meta.url),"utf8"));
    }
    await admin.query(await readFile(new URL("../migrations/020_alert_dead_letter.sql",import.meta.url),"utf8"));
    await admin.query(await readFile(new URL("../migrations/021_alert_claim_fencing.sql",import.meta.url),"utf8"));
    const values=[];
    for(let i=0;i<5;i++){
      values.push(`('concurrent_probe_${i}','score_threshold','info',NOW(),NOW()-INTERVAL '1 minute','open',0,NULL)`);
    }
    await admin.query(
      "INSERT INTO token_alerts (canonical_token_id,alert_type,severity,triggered_at,as_of,status,delivery_attempts,delivery_attempted_at) VALUES "+values.join(","));

    const connectionUrl=url+(url.includes("?")?"&":"?")+"options="+encodeURIComponent(`-c search_path=${schema}`);
    const {execFile}=await import("node:child_process");
    const runOnce=()=>new Promise((resolve)=>{
      const child=execFile(process.execPath,[script],{
        env:{
          ...process.env,
          INTELLIGENCE_DATABASE_URL:connectionUrl,
          TELEGRAM_BOT_TOKEN:"123456:"+("A".repeat(40)),
          TELEGRAM_CHAT_ID:"1999999999",
          INTELLIGENCE_ALERT_BATCH_SIZE:"10",
          INTELLIGENCE_TELEGRAM_API_BASE:"http://127.0.0.1:59999",
          INTELLIGENCE_TELEGRAM_TIMEOUT_MS:"5000",
        },
        encoding:"utf8",
      },()=>{});
      let stdout="",stderr="";
      child.stdout.on("data",d=>stdout+=d);
      child.stderr.on("data",d=>stderr+=d);
      child.on("close",(code)=>resolve({code,stdout,stderr}));
    });
    const runs=await Promise.all([runOnce(),runOnce()]);
    const claimed=runs.map(r=>{try{return JSON.parse(r.stdout).claimed;}catch{return -1;}});
    assert.equal(claimed.reduce((a,b)=>a+b,0),5,
      "each alert is claimed exactly once across overlapping workers");
    assert.ok(claimed.every(c=>c>=0),"both worker processes must produce a parseable summary");
    assert.ok(Math.max(...claimed)>=1,"at least one worker must claim alerts");
    const rows=(await admin.query(
      "SELECT status,delivery_attempts,claim_token FROM token_alerts ORDER BY canonical_token_id")).rows;
    assert.deepEqual(rows.map(r=>r.delivery_attempts),[1,1,1,1,1],
      "no alert may be incremented twice by overlapping claims");
    assert.equal(new Set(rows.map(r=>r.claim_token)).size,5,
      "every claim carries its own fencing token");
  }finally{
    if(pool)await pool.end();
    await admin.query("SET search_path TO public");
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});
