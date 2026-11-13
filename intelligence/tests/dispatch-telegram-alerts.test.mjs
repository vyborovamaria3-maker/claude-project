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
