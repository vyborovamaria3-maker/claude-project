import { pool } from '@/server/db/pool.js';

export type TokenRow = {
  id: string;
  mint_address: string;
  symbol: string;
  name: string | null;
  image_uri: string | null;
  x_url: string | null;
  x_link_kind: string | null;
  community_url: string | null;
  usd_market_cap: string | null;
  launched_at: Date | null;
  metadata_synced_at: Date | null;
  created_at: Date;
  mentions: string;
  prev_mentions: string;
  last_recorded_at: Date | null;
};

const SELECT = `
  SELECT t.*,
    COALESCE(s.mentions_count, 0)::text AS mentions,
    COALESCE(prev.mentions_count, 0)::text AS prev_mentions,
    s.captured_at AS last_recorded_at
  FROM tokens t
  LEFT JOIN LATERAL (
    SELECT mentions_count, captured_at FROM token_snapshots
    WHERE token_id=t.id ORDER BY captured_at DESC LIMIT 1
  ) s ON true
  LEFT JOIN LATERAL (
    SELECT mentions_count FROM token_snapshots
    WHERE token_id=t.id ORDER BY captured_at DESC OFFSET 1 LIMIT 1
  ) prev ON true`;

export function serializeToken(row: TokenRow) {
  const mentions = Number(row.mentions ?? 0);
  const prevMentions = Number(row.prev_mentions ?? 0);
  return {
    id: row.id,
    mintAddress: row.mint_address,
    symbol: row.symbol,
    name: row.name,
    imageUri: row.image_uri,
    xUrl: row.x_url,
    xLinkKind: row.x_link_kind,
    communityUrl: row.community_url,
    usdMarketCap: row.usd_market_cap === null ? null : Number(row.usd_market_cap),
    launchedAt: row.launched_at,
    metadataSyncedAt: row.metadata_synced_at,
    mentions,
    prevMentions,
    delta: mentions - prevMentions,
    lastRecordedAt: row.last_recorded_at,
    createdAt: row.created_at,
  };
}

export async function listTokens() {
  const { rows } = await pool.query<TokenRow>(`${SELECT} ORDER BY COALESCE(s.mentions_count,0) DESC, t.symbol`);
  return rows.map(serializeToken);
}

export async function getToken(address: string) {
  const { rows } = await pool.query<TokenRow>(`${SELECT} WHERE t.chain='solana' AND t.mint_address=$1`, [address]);
  return rows[0] ? serializeToken(rows[0]) : null;
}

export async function upsertToken(input: any) {
  const { rows } = await pool.query<{ id: string }>(`
    INSERT INTO tokens(chain,mint_address,symbol,name,description,image_uri,website_url,x_url,x_link_kind,community_url,creator_address,launched_at,metadata_synced_at,usd_market_cap,ath_usd_market_cap)
    VALUES('solana',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),$12,$13)
    ON CONFLICT(chain,mint_address) DO UPDATE SET
      symbol=EXCLUDED.symbol,name=EXCLUDED.name,description=EXCLUDED.description,image_uri=EXCLUDED.image_uri,
      website_url=EXCLUDED.website_url,x_url=EXCLUDED.x_url,x_link_kind=EXCLUDED.x_link_kind,
      community_url=EXCLUDED.community_url,creator_address=EXCLUDED.creator_address,launched_at=EXCLUDED.launched_at,
      metadata_synced_at=now(),usd_market_cap=EXCLUDED.usd_market_cap,ath_usd_market_cap=EXCLUDED.ath_usd_market_cap,updated_at=now()
    RETURNING id`, [input.mintAddress,input.symbol,input.name,input.description,input.imageUri,input.website,input.xUrl,input.xLinkKind,input.communityUrl,input.creator,input.launchedAt,input.usdMarketCap,input.athUsdMarketCap]);
  return rows[0]!.id;
}

export async function removeToken(address: string) {
  const { rows } = await pool.query<{ id: string; symbol: string }>(`DELETE FROM tokens WHERE chain='solana' AND mint_address=$1 RETURNING id,symbol`, [address]);
  if (!rows[0]) throw new Error('Token is not watched');
  return rows[0];
}

export async function recordSnapshot(tokenId: string, mentions: number) {
  await pool.query(`INSERT INTO token_snapshots(token_id,mentions_count) VALUES($1,$2)`, [tokenId, mentions]);
  return { id: tokenId, mentions };
}
