import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { PoolClient } from "pg";
import { PGlite } from "@electric-sql/pglite";
import { executeAgentCycle } from "../lib/trade/social-agent-cycle";
import { previewProvider } from "../lib/trade/social-agent";
import { executeDiscoveryCycle } from "../lib/trade/social-discovery";
import { CLAIM_COLLECTOR_ACCOUNT_SQL } from "../lib/trade/account-manager";
test("PostgreSQL agent: roles, stop switch, simulation, dedup and daily budget",async()=>{
  const db=new PGlite();
  const client={query:async(sql:string,params:unknown[]=[])=>{const r=await db.query(sql,params);return {rows:r.rows,rowCount:r.affectedRows??r.rows.length};}} as unknown as Pick<PoolClient,"query">;
  const cycle=async()=>{
    await db.exec("BEGIN");
    try{const result=await executeAgentCycle(client,previewProvider,100_000);await db.exec("COMMIT");return result;}
    catch(error){await db.exec("ROLLBACK");throw error;}
  };
  try{
    for(const file of (await fs.readdir(path.resolve("migrations"))).filter(f=>f.endsWith(".sql")).sort()) await db.exec(await fs.readFile(path.resolve("migrations",file),"utf8"));
    assert.equal((await cycle()).status,"stopped");
    assert.equal(await executeDiscoveryCycle(client,100000),0);
    await db.exec("UPDATE social_agent_settings SET stopped=false");
    assert.equal((await cycle()).status,"no-publisher");
    for(const [name,role] of [["reader","collector"],["writer","publisher"]]) await db.query("INSERT INTO x_accounts(name,session_encrypted,role,hour_window_start,created_at,updated_at) VALUES($1,'encrypted',$2,0,0,0)",[name,role]);
    const collector=await db.query<{name:string}>(CLAIM_COLLECTOR_ACCOUNT_SQL,[1,100000,110000,"test-worker"]);
    assert.equal(collector.rows[0].name,"reader");
    assert.equal((await db.query(CLAIM_COLLECTOR_ACCOUNT_SQL,[1,100000,110000,"test-worker-2"])).rows.length,0);
    assert.equal(await executeDiscoveryCycle(client,100000),3);
    assert.equal(await executeDiscoveryCycle(client,100001),0);
    await db.exec("INSERT INTO twitter_tweets(tweet_id,handle,text,posted_at,first_seen_at,updated_at) VALUES('123','source','Solana memecoin discussion',99000,99000,99000)");
    await assert.rejects(db.exec("INSERT INTO social_agent_actions(account_name,kind,tweet_id,status,reason,evidence,provider,created_at) VALUES('reader','post','123','simulated','reason','{}','test',100000)"),/publisher/);
    const result=await cycle();assert.equal(result.status,"preview");assert.equal(result.actions,1);
    const actions=(await db.query<{account_name:string;status:string}>("SELECT * FROM social_agent_actions")).rows;
    assert.equal(actions[0].account_name,"writer");assert.equal(actions[0].status,"simulated");
    assert.equal((await cycle()).actions,0);
    await db.exec("UPDATE social_agent_settings SET max_actions_per_day=1");
    assert.equal((await cycle()).status,"budget-exhausted");
    await db.exec("UPDATE social_agent_settings SET stopped=true");
    assert.equal((await cycle()).status,"stopped");
  }finally{await db.close();}
});
