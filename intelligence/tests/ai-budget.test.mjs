import test from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {readFile} from "node:fs/promises";
import pg from "pg";
import {reserveSharedAiBudget,settleSharedAiBudget} from "../dist/index.js";

const dsn=process.env.INTELLIGENCE_TEST_DB_URL;
test("shared AI budget is atomic across concurrent worker sessions",{
  skip:!dsn,
},async()=>{
  const schema="budget_"+randomBytes(7).toString("hex");
  const admin=new pg.Client({connectionString:dsn});
  await admin.connect();
  let pool;
  try{
    await admin.query('CREATE SCHEMA "'+schema+'"');
    await admin.query('SET search_path TO "'+schema+'"');
    await admin.query(await readFile(new URL("../migrations/012_ai_shared_budget.sql",import.meta.url),"utf8"));
    pool=new pg.Pool({connectionString:dsn,options:"-c search_path="+schema,max:3});
    const outcomes=await Promise.allSettled([
      reserveSharedAiBudget(pool,{providerId:"test",dailyLimitUsd:1,reservationUsd:0.6}),
      reserveSharedAiBudget(pool,{providerId:"test",dailyLimitUsd:1,reservationUsd:0.6}),
    ]);
    const ok=outcomes.filter(x=>x.status==="fulfilled");
    const rejected=outcomes.filter(x=>x.status==="rejected");
    assert.equal(ok.length,1);
    assert.equal(rejected.length,1);
    assert.match(rejected[0].reason.message,/budget_exceeded/);
    const reservationId=ok[0].value;
    const live=await pool.query("SELECT reserved_allowance_usd,used_allowance_usd FROM ai_daily_budgets");
    assert.equal(Number(live.rows[0].reserved_allowance_usd),0.6);
    assert.equal(Number(live.rows[0].used_allowance_usd),0);
    assert.equal(await settleSharedAiBudget(pool,{reservationId,measuredCostUsd:0.1}),true);
    assert.equal(await settleSharedAiBudget(pool,{reservationId,measuredCostUsd:0.1}),false);
    const settled=await pool.query("SELECT reserved_allowance_usd,used_allowance_usd FROM ai_daily_budgets");
    assert.equal(Number(settled.rows[0].reserved_allowance_usd),0);
    assert.equal(Number(settled.rows[0].used_allowance_usd),0.6,
      "unknown provider costs must not unlock budget by refunding reserve");
    await assert.rejects(reserveSharedAiBudget(pool,{
      providerId:"test",dailyLimitUsd:1,reservationUsd:0.6,
    }),/budget_exceeded/);
  }finally{
    if(pool)await pool.end();
    await admin.query("SET search_path TO public");
    await admin.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
    await admin.end();
  }
});
test("invalid request bounds never touch DB",async()=>{
  const pool={async connect(){throw new Error("should not connect")}};
  await assert.rejects(reserveSharedAiBudget(pool,{
    providerId:"test",dailyLimitUsd:1,reservationUsd:2,
  }),/budget_exceeded/);
  await assert.rejects(reserveSharedAiBudget(pool,{
    providerId:"test|inject",dailyLimitUsd:1,reservationUsd:0.1,
  }),/invalid_ai_budget_provider/);
});
