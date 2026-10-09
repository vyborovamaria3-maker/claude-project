import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { executeAgentCycle } from "../../lib/trade/social-agent-cycle";
import { previewProvider } from "../../lib/trade/social-agent";
import { executeAgentCommand } from "../../lib/trade/social-agent-commands";
import { CLAIM_COLLECTOR_ACCOUNT_SQL } from "../../lib/trade/account-manager";

test("PostgreSQL server: separate roles and social preview transaction", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:1});
  const client=await pool.connect();
  const now=Date.now(), suffix=String(now);
  const reader=`reader_${suffix}`,writer=`writer_${suffix}`,tweet=`tweet_${suffix}`;
  try {
    await client.query("BEGIN");
    assert.equal((await executeAgentCycle(client,previewProvider,now)).status,"stopped");
    await client.query("UPDATE social_agent_settings SET stopped=false,max_actions_per_day=12 WHERE id=1");
    for(const [name,role] of [[reader,"collector"],[writer,"publisher"]]) await client.query("INSERT INTO x_accounts(name,session_encrypted,role,hour_window_start,created_at,updated_at) VALUES($1,'encrypted',$2,$3,$3,$3)",[name,role,now]);
    const claim=await client.query<{name:string}>(CLAIM_COLLECTOR_ACCOUNT_SQL,[1,now,now+10000,"test-worker"]);
    assert.equal(claim.rows[0].name,reader);
    assert.equal((await client.query(CLAIM_COLLECTOR_ACCOUNT_SQL,[1,now,now+10000,"test-worker-2"])).rows.length,0);
    await client.query("INSERT INTO twitter_tweets(tweet_id,handle,text,posted_at,first_seen_at,updated_at) VALUES($1,'source','Solana memecoin discussion',$2,$2,$2)",[tweet,now-1000]);
    const result=await executeAgentCycle(client,previewProvider,now);
    assert.equal(result.status,"preview");assert.equal(result.actions,1);
    const rows=await client.query<{account_name:string;status:string}>("SELECT account_name,status FROM social_agent_actions WHERE tweet_id=$1",[tweet]);
    assert.equal(rows.rows[0].account_name,writer);assert.equal(rows.rows[0].status,"simulated");
    assert.equal((await executeAgentCycle(client,previewProvider,now)).actions,0);
    await client.query("INSERT INTO social_agent_commands(kind,created_at) VALUES('run',$1)",[now]);
    assert.equal((await executeAgentCommand(client))?.status,"done");
    assert.equal((await client.query("SELECT status FROM social_agent_commands WHERE kind='run'")).rows[0].status,"done");
    await client.query("UPDATE social_agent_settings SET stopped=true WHERE id=1");
    assert.equal((await executeAgentCycle(client,previewProvider,now)).status,"stopped");
    await client.query("ROLLBACK");
    assert.equal((await client.query("SELECT 1 FROM social_agent_actions WHERE tweet_id=$1",[tweet])).rows.length,0);
  } finally {await client.query("ROLLBACK").catch(()=>{});client.release();await pool.end();}
});
