import { scrapeTwitter } from "../lib/trade/twitter-scraper";
import { persistTwitterSocialDiscoveries, type TwitterSocialDiscoveryInput } from "../lib/trade/db";

const SOLANA_ADDRESS_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const MEME_RE = /\b(memecoin|meme coin|degen|cto|community takeover|moonshot|100x|pump\.?fun|pumpfun|bonding curve|fair launch)\b/i;
const PUMPFUN_RE = /\b(pump\.?fun|pumpfun|pump fun|pump portal|bonding curve)\b/i;

const DEFAULT_QUERIES = [
  '"pump.fun" "CA"',
  '"pumpfun" "contract"',
  '"memecoin" "CA"',
  '"meme coin" "contract"',
  '"community takeover" "CA"',
  '"bonding curve" "CA"',
  '"pump.fun" "community"',
  '"pumpfun" "community"',
];

function parseArgs() {
  const args = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    args.set(key, rest.join("=") || "true");
  }
  return {
    limit: Number(args.get("limit") ?? 40),
    strategy: (args.get("strategy") ?? "auto") as "auto" | "nitter" | "playwright",
    headless: args.get("headless") !== "false",
    queries: args.get("query") ? [args.get("query")!] : DEFAULT_QUERIES,
  };
}

function extractContracts(text: string) {
  const matches = text.match(SOLANA_ADDRESS_RE) ?? [];
  return Array.from(new Set(matches)).filter((value) => value.length >= 32 && value.length <= 44);
}

function inferSubjectType(text: string): "account" | "community" {
  return /\b(community|communities|cto)\b/i.test(text) ? "community" : "account";
}

async function main() {
  const options = parseArgs();
  const rows: TwitterSocialDiscoveryInput[] = [];

  for (const query of options.queries) {
    console.log(`[twitter-social] query="${query}" limit=${options.limit}`);
    const result = await scrapeTwitter(query, {
      limit: options.limit,
      strategy: options.strategy,
      headless: options.headless,
    });

    for (const tweet of result.tweets) {
      const contracts = extractContracts(tweet.text);
      if (contracts.length === 0) continue;
      const account = result.accounts.get(tweet.authorHandle);
      const isMemecoin = MEME_RE.test(tweet.text);
      const mentionsPumpfun = PUMPFUN_RE.test(tweet.text);
      const subjectType = inferSubjectType(tweet.text);

      for (const contract of contracts) {
        rows.push({
          subjectType,
          handle: tweet.authorHandle,
          displayName: tweet.authorDisplayName ?? account?.displayName ?? null,
          url: tweet.url || `https://x.com/${tweet.authorHandle}`,
          contractAddress: contract,
          sourceQuery: query,
          matchedIn: "tweet",
          tweetId: tweet.id,
          tweetText: tweet.text,
          tweetPostedAt: tweet.postedAt,
          discoveredAt: Date.now(),
          followers: account?.followers ?? null,
          following: account?.following ?? null,
          postsCount: account?.postsCount ?? null,
          isVerified: tweet.isVerified || Boolean(account?.isVerified),
          isMemecoin,
          mentionsPumpfun,
          raw: {
            tweet,
            account: account ? Object.fromEntries(Object.entries(account)) : null,
            strategy: result.strategy,
          },
        });
      }
    }
  }

  persistTwitterSocialDiscoveries(rows);
  const contracts = new Set(rows.map((row) => row.contractAddress).filter(Boolean));
  const accounts = new Set(rows.map((row) => row.handle).filter(Boolean));
  console.log(`[twitter-social] saved=${rows.length} contracts=${contracts.size} accounts=${accounts.size}`);
}

main().catch((error) => {
  console.error("[twitter-social] failed", error);
  process.exit(1);
});
