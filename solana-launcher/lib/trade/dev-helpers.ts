// data-tag: lib.trade.dev-helpers
// Shared helpers for dev analysis (used by both dev.ts and dev-stream route)

import { appendHeliusApiKey, getHeliusApiKey, getHeliusApiKeys, getRuntimeHeliusApiKeys, isHeliusRetryableStatus } from "./helius-rotation";

// Legacy exports retained for compatibility with callers that only need the
// startup environment snapshot. Network helpers below always use runtime keys.
export const HELIUS_API_KEY = getHeliusApiKey();
export const HELIUS_API_KEYS = getHeliusApiKeys();

async function fetchWithHeliusRotation<T>(urlBuilder: (apiKey: string) => string, init?: RequestInit): Promise<T> {
  const runtimeKeys = await getRuntimeHeliusApiKeys();
  const keys = runtimeKeys.length > 0 ? runtimeKeys : [""];
  let lastError: unknown = null;

  for (let attempt = 0; attempt < keys.length; attempt += 1) {
    const apiKey = keys[attempt] ?? "";
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const response = await fetch(urlBuilder(apiKey), {
        ...init,
        headers: { Accept: "application/json", ...(init?.headers ?? {}) },
        signal: ctrl.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const error = new Error(`Helius ${response.status}: ${body.slice(0, 120)}`);
        if (!isHeliusRetryableStatus(response.status) || attempt === keys.length - 1) throw error;
        lastError = error;
        continue;
      }
      return (await response.json()) as T;
    } catch (error) {
      lastError = error;
      if (attempt === keys.length - 1) break;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Helius request failed");
}

export async function heliusFetch<T>(path: string): Promise<T> {
  return fetchWithHeliusRotation<T>((apiKey) => appendHeliusApiKey(`https://api.helius.xyz${path}`, apiKey));
}

export const SOL_MINT = "So11111111111111111111111111111111111111112";

// Helius transaction parsing endpoints
export async function parseTransactions<T>(signatures: string[]): Promise<T> {
  return fetchWithHeliusRotation<T>(
    (apiKey) => appendHeliusApiKey("https://api-mainnet.helius-rpc.com/v0/transactions/", apiKey),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transactions: signatures }),
    },
  );
}

export async function parseAddressTransactions<T>(
  address: string,
  options?: { limit?: number; before?: string; after?: string },
): Promise<T> {
  return fetchWithHeliusRotation<T>((apiKey) => {
    const params = new URLSearchParams();
    if (apiKey) params.set("api-key", apiKey);
    if (options?.limit) params.set("limit", options.limit.toString());
    if (options?.before) params.set("before", options.before);
    if (options?.after) params.set("after", options.after);
    return `https://api-mainnet.helius-rpc.com/v0/addresses/${address}/transactions/?${params.toString()}`;
  });
}
