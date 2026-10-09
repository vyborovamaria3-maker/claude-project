import type { PoolClient } from "pg";
import { tx } from "./pg";
export const SOLANA_DISCOVERY_QUERIES = [
  '(solana OR #solana) (memecoin OR "meme coin") -filter:retweets',
  '("pump.fun" OR pumpfun) (token OR memecoin) -filter:retweets',
  '(raydium OR bonk) (solana OR memecoin) -filter:retweets',
];
export async function executeDiscoveryCycle(client: Pick<PoolClient,"query">, now: number): Promise<number> {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid discovery time");
  const settings=await client.query<{ stopped: boolean }>("SELECT stopped FROM social_agent_settings WHERE id=1 FOR UPDATE");
  if(!settings.rows[0] || settings.rows[0].stopped) return 0;
  let queued=0;
  for(const [i,query] of SOLANA_DISCOVERY_QUERIES.entries()) {
    const r=await client.query(`INSERT INTO x_tasks(kind,payload_json,priority,available_at,created_at,updated_at,idempotency_key)
      SELECT 'search',$1::jsonb,1,$2,$2,$2,$3
      WHERE NOT EXISTS(SELECT 1 FROM x_tasks WHERE kind='search' AND payload_json->>'query'=$4 AND status IN ('pending','claimed'))
      ON CONFLICT(idempotency_key) DO NOTHING RETURNING id`,
      [JSON.stringify({query,sort:"latest",limit:50}),now,`solana-discovery:${i}:${Math.floor(now/3_600_000)}`,query]);
    queued+=r.rowCount??0;
  }
  return queued;
}
export function runDiscoveryCycle(now=Date.now()) {return tx(client=>executeDiscoveryCycle(client,now));}
