import test from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {randomBytes} from "node:crypto";
import path from "node:path";
import {fileURLToPath} from "node:url";
import pg from "pg";

// Integration coverage for the Telegram alert dispatcher failure path.
// Uses a disposable PostgreSQL schema and a syntactically valid but
// unauthorized bot token: Telegram answers 401 {"ok":false}, so no message
// is ever delivered to any user. The test proves the retry budget, the
// one-minute 'open' backoff and the terminal dead-letter state.
const url=process.env.INTELLIGENCE_TEST_DB_URL;
const script=path.join(path.dirname(fileURLToPath(import.meta.url)),"..","scripts","dispatch-telegram-alerts.mjs");

function runDispatcher(databaseUrl){
  try{
    return execFileSync(process.execPath,[script],{
      env:{
        ...process.env,
        INTELLIGENCE_DATABASE_URL:databaseUrl,
        TELEGRAM_BOT_TOKEN:"123456:"+("A".repeat(40)),
        TELEGRAM_CHAT_ID:"1999999999",
        INTELLIGENCE_ALERT_BATCH_SIZE:"10",
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

function runDispatcherRaw(databaseUrl){
  try{
    const stdout=execFileSync(process.execPath,[script],{
      env:{
        ...process.env,
        INTELLIGENCE_DATABASE_URL:databaseUrl,
        TELEGRAM_BOT_TOKEN:"123456:"+("A".repeat(40)),
        TELEGRAM_CHAT_ID:"1999999999",
        INTELLIGENCE_ALERT_BATCH_SIZE:"10",
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
    const first=JSON.parse(runDispatcher(connectionUrl));
    assert.equal(first.claimed,1);
    assert.equal(first.delivered,0);
    assert.equal(first.failed,1);
    let row=(await pool.query("SELECT status,delivery_attempts FROM token_alerts")).rows[0];
    assert.equal(row.status,"open");
    assert.equal(row.delivery_attempts,1);

    // 2. The one-minute open-row backoff prevents immediate re-claim.
    const second=JSON.parse(runDispatcher(connectionUrl));
    assert.equal(second.claimed,0,"fresh 'open' rows must wait out the backoff");

    // 3. Exhausting the retry budget lands the alert in the terminal
    //    dead-letter state instead of silently dropping it.
    await pool.query(
      "UPDATE token_alerts SET delivery_attempts=9,delivery_attempted_at=NOW()-INTERVAL '2 minutes'");
    const third=JSON.parse(runDispatcher(connectionUrl));
    assert.equal(third.claimed,1);
    assert.equal(third.failed,1);
    row=(await pool.query("SELECT status,delivery_attempts FROM token_alerts")).rows[0];
    assert.equal(row.status,"dead_lettered");
    assert.equal(row.delivery_attempts,10);
    const fourth=JSON.parse(runDispatcher(connectionUrl));
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
      +"GROUP BY conrelid::regclass::text ORDER BY 1",[schema])).rows;
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
    const result=runDispatcherRaw(connectionUrl);
    assert.notEqual(result.status,0,"dispatcher must exit non-zero without migration 020");
    assert.match(result.stderr,/intelligence_migration_020_required/);
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

test("telegram alert dispatcher self-heals crash-window 'sending' rows through the claim query",{
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

    const connectionUrl=url+(url.includes("?")?"&":"?")+"options="+encodeURIComponent(`-c search_path=${schema}`);
    pool=new pg.Pool({connectionString:connectionUrl,max:2});
    await pool.query(
      `INSERT INTO token_alerts
         (canonical_token_id,alert_type,severity,triggered_at,as_of,status,delivery_attempts,delivery_attempted_at)
       VALUES
         ('heal_crashed_at_budget','score_threshold','info',NOW()-INTERVAL '3 minute',NOW()-INTERVAL '30 minutes','sending',10,NOW()-INTERVAL '15 minutes'),
         ('heal_final_retry','score_threshold','info',NOW()-INTERVAL '2 minute',NOW()-INTERVAL '30 minutes','sending',9,NOW()-INTERVAL '15 minutes'),
         ('heal_inflight','score_threshold','info',NOW()-INTERVAL '1 minute',NOW()-INTERVAL '30 minutes','sending',10,NOW()-INTERVAL '1 minute')`);

    // The unauthorized bot token fails every send, so claims exercise the
    // failure path: budget-exhausted claims dead-letter, in-flight rows stay
    // untouched while their claim lease is active.
    const first=JSON.parse(runDispatcher(connectionUrl));
    assert.equal(first.claimed,2,"stale 'sending' rows are reclaimable at any attempt count");
    assert.equal(first.delivered,0);
    assert.equal(first.failed,2);
    let rows=(await pool.query(
      "SELECT canonical_token_id,status,delivery_attempts FROM token_alerts ORDER BY canonical_token_id")).rows;
    assert.deepEqual(rows,[
      {canonical_token_id:"heal_crashed_at_budget",status:"dead_lettered",delivery_attempts:11},
      {canonical_token_id:"heal_final_retry",status:"dead_lettered",delivery_attempts:10},
      {canonical_token_id:"heal_inflight",status:"sending",delivery_attempts:10},
    ]);
    const history=(await pool.query(
      "SELECT alerts.canonical_token_id,history.status FROM token_alert_status_history history "
      +"JOIN token_alerts alerts ON alerts.alert_id=history.alert_id ORDER BY history.history_id")).rows;
    assert.deepEqual(history.map(h=>h.status),
      ["sending","sending","sending","dead_lettered","dead_lettered"],
      "history records the original sending states and the two terminal transitions");

    const second=JSON.parse(runDispatcher(connectionUrl));
    assert.equal(second.claimed,0,"the in-flight row waits out its lease; terminal rows leave the queue");
    rows=(await pool.query(
      "SELECT canonical_token_id,status,delivery_attempts FROM token_alerts ORDER BY canonical_token_id")).rows;
    assert.deepEqual(rows,[
      {canonical_token_id:"heal_crashed_at_budget",status:"dead_lettered",delivery_attempts:11},
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

