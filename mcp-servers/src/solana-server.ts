import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PublicKey } from "@solana/web3.js";
import * as z from "zod/v4";
import { asText, parseCsvList } from "./shared.js";

const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const heliusBaseUrl = process.env.HELIUS_BASE_URL ?? "https://mainnet.helius-rpc.com/v0";
const heliusApiKeys = parseCsvList(process.env.HELIUS_API_KEYS);

const server = new McpServer({
  name: "solana-rpc-mcp",
  version: "1.0.0",
});

async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "mcp", method, params }),
  });

  if (!response.ok) {
    throw new Error(`RPC HTTP ${response.status}: ${await response.text()}`);
  }

  const payload = (await response.json()) as {
    result?: T;
    error?: { message: string; code: number };
  };

  if (payload.error) {
    throw new Error(`RPC ${payload.error.code}: ${payload.error.message}`);
  }

  return payload.result as T;
}

type HeliusEndpointState = {
  apiKey: string;
  unavailableUntil: number;
  failures: number;
};

const heliusEndpoints: HeliusEndpointState[] = heliusApiKeys.map((apiKey) => ({
  apiKey,
  unavailableUntil: 0,
  failures: 0,
}));

let heliusCursor = 0;

function redactHeliusSecrets(value: string): string {
  let redacted = value;
  for (const apiKey of heliusApiKeys) {
    if (apiKey) redacted = redacted.split(apiKey).join("[REDACTED]");
  }
  return redacted;
}

function heliusErrorMessage(response: Response, body: string) {
  // Helius credentials are sent in the request URL as `api-key`. Never include
  // response.url in MCP errors/logs, and defensively redact a reflected key from
  // the response body as well.
  const detail = redactHeliusSecrets(body || response.statusText).slice(0, 500);
  return `Helius HTTP ${response.status}: ${detail}`;
}

function chooseHeliusEndpoint() {
  if (heliusEndpoints.length === 0) {
    throw new Error("HELIUS_API_KEYS is required for Helius tools");
  }

  const now = Date.now();
  for (let offset = 0; offset < heliusEndpoints.length; offset++) {
    const index = (heliusCursor + offset) % heliusEndpoints.length;
    const endpoint = heliusEndpoints[index];
    if (endpoint.unavailableUntil <= now) {
      heliusCursor = (index + 1) % heliusEndpoints.length;
      return endpoint;
    }
  }

  const endpoint = heliusEndpoints[heliusCursor];
  heliusCursor = (heliusCursor + 1) % heliusEndpoints.length;
  return endpoint;
}

async function heliusFetch(pathname: string, init: RequestInit) {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < heliusEndpoints.length; attempt++) {
    const endpoint = chooseHeliusEndpoint();
    const url = new URL(heliusBaseUrl.replace(/\/$/, "") + pathname);
    url.searchParams.set("api-key", endpoint.apiKey);

    const response = await fetch(url, init);
    const body = await response.text().catch(() => "");

    if (response.ok) {
      endpoint.failures = 0;
      return body;
    }

    const retryable =
      response.status === 429 ||
      response.status === 402 ||
      response.status === 503 ||
      response.status === 504 ||
      /rate limit|too many requests|quota/i.test(body);

    if (!retryable) {
      throw new Error(heliusErrorMessage(response, body));
    }

    endpoint.failures += 1;
    endpoint.unavailableUntil = Date.now() + Math.min(5 * 60_000, 15_000 * endpoint.failures);
    lastError = new Error(heliusErrorMessage(response, body));
  }

  throw lastError ?? new Error("Helius request failed");
}

server.registerTool(
  "helius_parse_transactions",
  {
    description: "Parse one or more Solana transaction signatures with Helius Enhanced Transactions",
    inputSchema: {
      signatures: z.array(z.string().min(20)).min(1).max(100),
    },
  },
  async ({ signatures }) => {
    const body = await heliusFetch("/transactions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transactions: signatures }),
    });
    return asText(JSON.parse(body));
  },
);

server.registerTool(
  "helius_address_history",
  {
    description: "Fetch parsed transaction history for a Solana address with Helius Enhanced Transactions",
    inputSchema: {
      address: z.string().min(32),
      limit: z.number().min(1).max(100).default(20),
      beforeSignature: z.string().optional(),
      afterSignature: z.string().optional(),
      commitment: z.enum(["finalized", "confirmed"]).default("finalized"),
      tokenAccounts: z.enum(["none", "balanceChanged", "all"]).default("none"),
      type: z.string().optional(),
    },
  },
  async ({ address, limit, beforeSignature, afterSignature, commitment, tokenAccounts, type }) => {
    new PublicKey(address);
    const params = new URLSearchParams({
      limit: String(limit),
      commitment,
      "token-accounts": tokenAccounts,
    });
    if (beforeSignature) params.set("before-signature", beforeSignature);
    if (afterSignature) params.set("after-signature", afterSignature);
    if (type) params.set("type", type);

    const body = await heliusFetch(`/addresses/${address}/transactions?${params.toString()}`, {
      method: "GET",
    });
    return asText(JSON.parse(body));
  },
);

server.registerTool(
  "get_balance",
  {
    description: "Get SOL balance for an address",
    inputSchema: { address: z.string().min(32) },
  },
  async ({ address }) => {
    new PublicKey(address);
    const result = await rpc<{ value: number }>("getBalance", [address, { commitment: "confirmed" }]);
    return asText({ address, lamports: result.value, sol: result.value / 1_000_000_000 });
  },
);

server.registerTool(
  "get_account_info",
  {
    description: "Get parsed account info for an address",
    inputSchema: { address: z.string().min(32) },
  },
  async ({ address }) => {
    new PublicKey(address);
    const result = await rpc<unknown>("getAccountInfo", [
      address,
      { encoding: "jsonParsed", commitment: "confirmed" },
    ]);
    return asText(result);
  },
);

server.registerTool(
  "get_signatures",
  {
    description: "List recent signatures for an address",
    inputSchema: {
      address: z.string().min(32),
      limit: z.number().min(1).max(100).default(20),
    },
  },
  async ({ address, limit }) => {
    new PublicKey(address);
    const result = await rpc<unknown>("getSignaturesForAddress", [
      address,
      { limit, commitment: "confirmed" },
    ]);
    return asText(result);
  },
);

server.registerTool(
  "get_transaction",
  {
    description: "Fetch a parsed transaction by signature",
    inputSchema: { signature: z.string().min(20) },
  },
  async ({ signature }) => {
    const result = await rpc<unknown>("getTransaction", [
      signature,
      { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
    ]);
    return asText(result);
  },
);

server.registerTool(
  "get_token_supply",
  {
    description: "Get SPL token supply for a mint",
    inputSchema: { mint: z.string().min(32) },
  },
  async ({ mint }) => {
    new PublicKey(mint);
    const result = await rpc<unknown>("getTokenSupply", [mint]);
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
