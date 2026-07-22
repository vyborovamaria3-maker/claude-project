import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { asText } from "./shared.js";

const bearer = process.env.X_BEARER_TOKEN;
if (!bearer) {
  throw new Error("X_BEARER_TOKEN is required");
}

const apiBase = process.env.X_API_BASE ?? "https://api.x.com/2";

const server = new McpServer({
  name: "x-api-mcp",
  version: "1.0.0",
});

async function xApi<T>(path: string, query: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
  const url = new URL(apiBase.replace(/\/$/, "") + path);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${bearer}`,
      "user-agent": "mcp-x-api/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`X API HTTP ${response.status}: ${await response.text()}`);
  }

  return (await response.json()) as T;
}

server.registerTool(
  "search_recent_tweets",
  {
    description: "Search recent tweets with the X API",
    inputSchema: {
      query: z.string().min(1),
      max_results: z.number().min(10).max(100).default(10),
    },
  },
  async ({ query, max_results }) => {
    const result = await xApi<unknown>("/tweets/search/recent", {
      query,
      max_results,
      "tweet.fields": "created_at,public_metrics,author_id,lang",
      expansions: "author_id",
      "user.fields": "id,name,username,verified,public_metrics,profile_image_url",
    });
    return asText(result);
  },
);

server.registerTool(
  "get_user_by_username",
  {
    description: "Resolve a username to a user profile",
    inputSchema: { username: z.string().min(1) },
  },
  async ({ username }) => {
    const result = await xApi<unknown>(`/users/by/username/${encodeURIComponent(username)}`, {
      "user.fields": "id,name,username,verified,public_metrics,created_at,description,profile_image_url",
    });
    return asText(result);
  },
);

server.registerTool(
  "get_user_tweets",
  {
    description: "Fetch recent tweets for a username",
    inputSchema: {
      username: z.string().min(1),
      max_results: z.number().min(5).max(100).default(10),
    },
  },
  async ({ username, max_results }) => {
    const user = (await xApi<{ data?: { id: string } }>(`/users/by/username/${encodeURIComponent(username)}`)).data;
    if (!user?.id) {
      throw new Error(`User not found: ${username}`);
    }

    const result = await xApi<unknown>(`/users/${user.id}/tweets`, {
      max_results,
      "tweet.fields": "created_at,public_metrics,referenced_tweets,lang",
      exclude: "replies",
    });
    return asText(result);
  },
);

async function main() {
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
