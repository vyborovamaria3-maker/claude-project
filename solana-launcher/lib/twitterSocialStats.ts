import { getDb } from "./trade/db";

export type TwitterSocialSeriesPoint = {
  timestamp: number;
  accounts: number;
  communities: number;
  contracts: number;
  memecoinAccounts: number;
};

export type TwitterSocialStats = {
  totalAccounts: number;
  totalCommunities: number;
  accountsWithContracts: number;
  memecoinAccounts: number;
  pumpfunMentions: number;
  contractsFound: number;
  createdToday: number;
  created7d: number;
  created30d: number;
  created365d: number;
  discoveredToday: number;
  discovered7d: number;
  discoveryVelocity7d: number;
  topContracts: Array<{ contractAddress: string; accounts: number; mentions: number; lastSeenAt: number | null }>;
  recentDiscoveries: Array<{
    subjectType: "account" | "community";
    handle: string | null;
    displayName: string | null;
    contractAddress: string | null;
    matchedIn: string;
    createdAt: number | null;
    discoveredAt: number;
  }>;
  series: TwitterSocialSeriesPoint[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

function countWhere(where: string, params: unknown[] = []) {
  const row = getDb().prepare(`SELECT COUNT(*) AS count FROM twitter_social_discoveries ${where}`).get(...params) as { count: number };
  return row.count ?? 0;
}

export function getTwitterSocialStats(sinceMs: number, intervalMs: number): TwitterSocialStats {
  const db = getDb();
  const now = Date.now();
  const startOfToday = new Date(new Date(now).toDateString()).getTime();
  const sevenDaysAgo = now - 7 * DAY_MS;
  const thirtyDaysAgo = now - 30 * DAY_MS;
  const yearAgo = now - 365 * DAY_MS;

  const totalAccounts = countWhere("WHERE subject_type = 'account'");
  const totalCommunities = countWhere("WHERE subject_type = 'community'");
  const accountsWithContracts = countWhere("WHERE subject_type = 'account' AND contract_address IS NOT NULL AND contract_address != ''");
  const memecoinAccounts = countWhere("WHERE subject_type = 'account' AND is_memecoin = 1");
  const pumpfunMentions = countWhere("WHERE mentions_pumpfun = 1");
  const contractsFound = (db.prepare(
    `SELECT COUNT(DISTINCT contract_address) AS count
     FROM twitter_social_discoveries
     WHERE contract_address IS NOT NULL AND contract_address != ''`
  ).get() as { count: number }).count ?? 0;

  const createdToday = countWhere("WHERE account_created_at >= ?", [startOfToday]);
  const created7d = countWhere("WHERE account_created_at >= ?", [sevenDaysAgo]);
  const created30d = countWhere("WHERE account_created_at >= ?", [thirtyDaysAgo]);
  const created365d = countWhere("WHERE account_created_at >= ?", [yearAgo]);
  const discoveredToday = countWhere("WHERE discovered_at >= ?", [startOfToday]);
  const discovered7d = countWhere("WHERE discovered_at >= ?", [sevenDaysAgo]);

  const topContracts = db.prepare(
    `SELECT
       contract_address AS contractAddress,
       COUNT(DISTINCT COALESCE(handle, url, tweet_id)) AS accounts,
       COUNT(*) AS mentions,
       MAX(discovered_at) AS lastSeenAt
     FROM twitter_social_discoveries
     WHERE contract_address IS NOT NULL AND contract_address != ''
     GROUP BY contract_address
     ORDER BY accounts DESC, mentions DESC
     LIMIT 8`
  ).all() as TwitterSocialStats["topContracts"];

  const recentDiscoveries = db.prepare(
    `SELECT
       subject_type AS subjectType,
       handle,
       display_name AS displayName,
       contract_address AS contractAddress,
       matched_in AS matchedIn,
       account_created_at AS createdAt,
       discovered_at AS discoveredAt
     FROM twitter_social_discoveries
     ORDER BY discovered_at DESC
     LIMIT 8`
  ).all() as TwitterSocialStats["recentDiscoveries"];

  const rows = db.prepare(
    `SELECT
       CAST((COALESCE(account_created_at, discovered_at) / ?) AS INTEGER) * ? AS bucket,
       SUM(CASE WHEN subject_type = 'account' THEN 1 ELSE 0 END) AS accounts,
       SUM(CASE WHEN subject_type = 'community' THEN 1 ELSE 0 END) AS communities,
       COUNT(DISTINCT contract_address) AS contracts,
       SUM(CASE WHEN subject_type = 'account' AND is_memecoin = 1 THEN 1 ELSE 0 END) AS memecoinAccounts
     FROM twitter_social_discoveries
     WHERE COALESCE(account_created_at, discovered_at) >= ?
     GROUP BY bucket
     ORDER BY bucket ASC`
  ).all(intervalMs, intervalMs, sinceMs) as TwitterSocialSeriesPoint[];

  return {
    totalAccounts,
    totalCommunities,
    accountsWithContracts,
    memecoinAccounts,
    pumpfunMentions,
    contractsFound,
    createdToday,
    created7d,
    created30d,
    created365d,
    discoveredToday,
    discovered7d,
    discoveryVelocity7d: discovered7d / 7,
    topContracts,
    recentDiscoveries,
    series: rows,
  };
}

export function getTokenTwitterSocialStats(mint: string) {
  const db = getDb();
  const row = db.prepare(
    `SELECT
       COUNT(*) AS mentions,
       COUNT(DISTINCT handle) AS accounts,
       SUM(CASE WHEN is_memecoin = 1 THEN 1 ELSE 0 END) AS memecoinAccounts,
       MIN(account_created_at) AS firstAccountCreatedAt,
       MAX(discovered_at) AS lastDiscoveredAt
     FROM twitter_social_discoveries
     WHERE contract_address = ?`
  ).get(mint) as {
    mentions: number;
    accounts: number;
    memecoinAccounts: number | null;
    firstAccountCreatedAt: number | null;
    lastDiscoveredAt: number | null;
  };

  return {
    mentions: row.mentions ?? 0,
    accounts: row.accounts ?? 0,
    memecoinAccounts: row.memecoinAccounts ?? 0,
    firstAccountCreatedAt: row.firstAccountCreatedAt,
    lastDiscoveredAt: row.lastDiscoveredAt,
  };
}
