import Database from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { asText, resolveExistingPath, workspacePath } from "./shared.js";

const dbPath =
  resolveExistingPath([
    process.env.PUMPFUN_DB_PATH,
    workspacePath("solana-launcher", "data", "trade.db"),
  ]) ?? null;

if (!dbPath) {
  throw new Error("trade.db not found. Set PUMPFUN_DB_PATH or keep the default workspace paths.");
}

const db = new Database(dbPath, { readonly: true });

const server = new McpServer({
  name: "pumpfun-mcp",
  version: "1.0.0",
});

server.registerTool(
  "find_tokens",
  {
    description: "Search tokens in dev_tokens by mint, symbol, name, or creator",
    inputSchema: {
      query: z.string().min(1),
      limit: z.number().min(1).max(100).default(20),
    },
  },
  async ({ query, limit }) => {
    const like = `%${query}%`;
    const rows = db
      .prepare(
        `
        SELECT *
        FROM dev_tokens
        WHERE mint LIKE ?
           OR COALESCE(symbol, '') LIKE ?
           OR COALESCE(name, '') LIKE ?
           OR creator LIKE ?
        ORDER BY last_updated_at DESC
        LIMIT ?
        `,
      )
      .all(like, like, like, like, limit);

    return asText({ count: rows.length, rows });
  },
);

server.registerTool(
  "get_token",
  {
    description: "Load a single token row by mint",
    inputSchema: { mint: z.string().min(32) },
  },
  async ({ mint }) => {
    const row = db
      .prepare(
        `
        SELECT *
        FROM dev_tokens
        WHERE mint = ?
        ORDER BY last_updated_at DESC
        LIMIT 1
        `,
      )
      .get(mint);

    return asText(row ?? { found: false, mint });
  },
);

server.registerTool(
  "recent_trades",
  {
    description: "Get recent trades for a mint from token_trades",
    inputSchema: {
      mint: z.string().min(32),
      limit: z.number().min(1).max(200).default(20),
    },
  },
  async ({ mint, limit }) => {
    const rows = db
      .prepare(
        `
        SELECT *
        FROM token_trades
        WHERE mint = ?
        ORDER BY timestamp DESC
        LIMIT ?
        `,
      )
      .all(mint, limit);

    return asText({ count: rows.length, rows });
  },
);

server.registerTool(
  "creator_summary",
  {
    description: "Summarize tokens and trades for a creator wallet",
    inputSchema: {
      creator: z.string().min(32),
      limit: z.number().min(1).max(100).default(20),
    },
  },
  async ({ creator, limit }) => {
    const tokens = db
      .prepare(
        `
        SELECT *
        FROM dev_tokens
        WHERE creator = ?
        ORDER BY last_updated_at DESC
        LIMIT ?
        `,
      )
      .all(creator, limit);

    const stats = db
      .prepare(
        `
        SELECT
          COUNT(*) AS token_count,
          SUM(CASE WHEN is_migrated = 1 THEN 1 ELSE 0 END) AS migrated_count,
          SUM(CASE WHEN reached_300k = 1 THEN 1 ELSE 0 END) AS reached_300k_count,
          AVG(market_cap_usd) AS avg_market_cap_usd,
          MAX(market_cap_usd) AS max_market_cap_usd
        FROM dev_tokens
        WHERE creator = ?
        `,
      )
      .get(creator);

    const tradeStats = db
      .prepare(
        `
        SELECT
          COUNT(*) AS trade_count,
          SUM(amount_sol) AS volume_sol
        FROM token_trades
        WHERE mint IN (SELECT mint FROM dev_tokens WHERE creator = ?)
        `,
      )
      .get(creator);

    return asText({ creator, stats, tradeStats, tokens });
  },
);

async function main() {
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
