import assert from "node:assert/strict";
import fs from "node:fs/promises";
type Query = (sql: string, values?: unknown[]) => Promise<unknown[]>;
interface Plan {
  Plan: { "Total Cost": number; "Actual Rows": number; "Shared Hit Blocks"?: number; "Shared Read Blocks"?: number };
  "Execution Time": number;
}
// Only invoked inside the isolated integration schema or an in-memory test database.
export async function benchmarkReplyDatabase(query: Query) {
  await query("INSERT INTO reply_users(telegram_id) SELECT 'db-bench-'||i FROM generate_series(1,100) i");
  await query("INSERT INTO reply_accounts(user_id,x_user_id,credentials_encrypted) SELECT id,'db-bench-'||id,'encrypted-test-fixture' FROM reply_users WHERE telegram_id LIKE 'db-bench-%'");
  await query("INSERT INTO reply_lore(user_id,name,style) SELECT MIN(id),'benchmark','fixture' FROM reply_users WHERE telegram_id LIKE 'db-bench-%'");
  await query(`INSERT INTO reply_campaigns(user_id,account_id,lore_id,settings_json,filters_json)
    SELECT user_id,id,(SELECT MAX(id) FROM reply_lore),'{}','{}' FROM reply_accounts WHERE x_user_id LIKE 'db-bench-%'`);
  await query(`INSERT INTO reply_drafts(campaign_id,account_id,tweet_id,author_id,tweet_json,status)
    SELECT c.id,c.account_id,'bench-'||i,'fixture','{}',CASE WHEN i%3=0 THEN 'pending' ELSE 'published' END
    FROM generate_series(1,50000) i JOIN (SELECT id,account_id,row_number() OVER(ORDER BY id) n FROM reply_campaigns) c ON c.n=1+(i%100)`);
  await query(`INSERT INTO reply_rate_limits(account_id,hour_epoch,count)
    SELECT a.id,h,1 FROM reply_accounts a CROSS JOIN generate_series(1,2000) h WHERE a.x_user_id LIKE 'db-bench-%'`);
  await query("ANALYZE reply_drafts");
  await query("ANALYZE reply_rate_limits");
  const scope = await query("SELECT MIN(id)::text id FROM reply_campaigns") as Array<{id:string}>;
  const queries = [
    { name:"campaign queue", index:"reply_drafts_campaign_queue", sql:"SELECT id,tweet_json FROM reply_drafts WHERE campaign_id=$1 AND status='pending' ORDER BY created_at,id LIMIT 20", params:[scope[0].id] },
    { name:"recent quota", index:"reply_rates_epoch", sql:"SELECT SUM(count) FROM reply_rate_limits WHERE hour_epoch>=1977", params:[] },
  ];
  for (const item of queries) await query("DROP INDEX IF EXISTS " + item.index);
  const explain = async (sql:string,params:unknown[]) => {
    const rows = await query("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "+sql,params) as Array<{"QUERY PLAN":Plan[]}>;
    return rows[0]["QUERY PLAN"][0];
  };
  const before = await Promise.all(queries.map(item=>explain(item.sql,item.params)));
  const migration = await fs.readFile("migrations/013_reply_performance.sql","utf8");
  for (const statement of migration.split(";")) if(statement.trim()) await query(statement);
  await query("ANALYZE reply_drafts");
  await query("ANALYZE reply_rate_limits");
  const results = [];
  for(let i=0;i<queries.length;i++) {
    const item=queries[i], after=await explain(item.sql,item.params);
    assert(JSON.stringify(after.Plan).includes(item.index),item.name+" must use its index");
    assert.equal(after.Plan["Actual Rows"],before[i].Plan["Actual Rows"]);
    assert(after.Plan["Total Cost"]<before[i].Plan["Total Cost"],item.name+" planner cost must decrease");
    const blocks = (p:Plan)=>(p.Plan["Shared Hit Blocks"]??0)+(p.Plan["Shared Read Blocks"]??0);
    results.push({query:item.name,before:{cost:before[i].Plan["Total Cost"],ms:before[i]["Execution Time"],blocks:blocks(before[i])},after:{cost:after.Plan["Total Cost"],ms:after["Execution Time"],blocks:blocks(after)}});
  }
  console.log("Database fixture benchmark (50k drafts, 200k quota rows): "+JSON.stringify(results));
  return results;
}
