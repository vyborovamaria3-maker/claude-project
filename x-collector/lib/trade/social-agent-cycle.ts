import type { PoolClient } from "pg";
import { tx } from "./pg";
import { advisoryKey } from "./advisory";
import { previewProvider, selectCandidates, validateChoices, prepareDraft, type AgentProvider, type AgentCandidate } from "./social-agent";

export interface AgentCycleResult { status: "stopped" | "busy" | "no-publisher" | "budget-exhausted" | "preview"; candidates: number; actions: number }
export async function executeAgentCycle(client: Pick<PoolClient,"query">, provider: AgentProvider, now: number): Promise<AgentCycleResult> {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid cycle time");
  const result: AgentCycleResult = { status: "busy", candidates: 0, actions: 0 };
  const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock($1) AS locked", [advisoryKey("x-collector:social-agent")]);
  if (!lock.rows[0]?.locked) return result;
  const settings = await client.query<{ stopped: boolean; max_actions_per_cycle: number; max_actions_per_day: number }>("SELECT * FROM social_agent_settings WHERE id=1 FOR UPDATE");
  const config = settings.rows[0];
  if (!config || config.stopped) return { ...result, status: "stopped" };
  const accounts = await client.query<{ name: string }>("SELECT name FROM x_accounts WHERE role='publisher' AND status='active' AND tier!='retired' AND COALESCE(account_busy_until,0)<=$1 ORDER BY name LIMIT 1 FOR UPDATE",[now]);
  const account = accounts.rows[0];
  if (!account) return { ...result, status: "no-publisher" };
  const counts = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM social_agent_actions WHERE created_at >= $1", [Math.floor(now/86_400_000)*86_400_000]);
  const budget = Math.min(config.max_actions_per_cycle,config.max_actions_per_day-Number(counts.rows[0]?.count ?? 0));
  if (budget <= 0) return { ...result, status: "budget-exhausted" };
  const posts = await client.query<{ tweet_id: string; handle: string; text: string; posted_at: string; mints: string[]; influence: string; engagement: string }>(`
    SELECT t.tweet_id,t.handle,t.text,t.posted_at,COALESCE(r.reputation_score,0)::text influence,
      (t.likes+t.retweets+t.replies)::text engagement,
      ARRAY(SELECT l.mint FROM tweet_token_links l WHERE l.tweet_id=t.tweet_id) mints
    FROM twitter_tweets t LEFT JOIN author_reputation r ON r.handle=t.handle
    WHERE t.posted_at > $1 AND t.posted_at <= $2
      AND NOT EXISTS(SELECT 1 FROM social_agent_actions a WHERE a.tweet_id=t.tweet_id)
    ORDER BY t.posted_at DESC,t.tweet_id LIMIT 200`, [now-86_400_000,now]);
  const candidates = selectCandidates(posts.rows.map((r): AgentCandidate => ({tweetId:r.tweet_id,handle:r.handle,text:r.text,postedAt:Number(r.posted_at),mints:r.mints,influence:Number(r.influence),engagement:Number(r.engagement)})),now);
  result.candidates=candidates.length;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    const output = await Promise.race([
      provider.choose({candidates,maxActions:budget,signal:controller.signal}),
      new Promise<never>((_,reject) => { timer=setTimeout(()=>{controller.abort();reject(new Error("Agent provider timeout"));},15000); }),
    ]);
    const choices=validateChoices(output,candidates,budget);
    for(const choice of choices) {
      const candidate=candidates.find(c=>c.tweetId===choice.tweetId)!;
      const draft=prepareDraft(choice,candidate);
      const inserted=await client.query(`INSERT INTO social_agent_actions(account_name,kind,tweet_id,status,content,reason,evidence,provider,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) ON CONFLICT DO NOTHING RETURNING id`,
        [account.name,draft.kind,draft.tweetId,draft.status,draft.content,draft.reason,JSON.stringify(candidate),provider.name,now]);
      result.actions+=inserted.rowCount??0;
    }
    return { ...result,status:"preview" };
  } finally { if(timer)clearTimeout(timer);controller.abort(); }
}
export function runAgentCycle(provider: AgentProvider=previewProvider,now=Date.now()) {
  return tx(client=>executeAgentCycle(client,provider,now));
}
