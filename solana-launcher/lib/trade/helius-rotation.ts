// data-tag: lib.trade.helius-rotation
// Helius API key rotation helpers.

const HELIUS_KEY_SOURCES = [
  process.env.HELIUS_API_KEYS,
  process.env.HELIUS_API_KEY_1,
  process.env.HELIUS_API_KEY_2,
  process.env.HELIUS_API_KEY_3,
  process.env.HELIUS_API_KEY_4,
  process.env.HELIUS_API_KEY_5,
  process.env.HELIUS_API_KEY,
  process.env.NEXT_PUBLIC_HELIUS_API_KEY,
  process.env.NEXT_PUBLIC_HELIUS_RPC_URL,
  process.env.HELIUS_RPC_URL,
  process.env.NEXT_PUBLIC_RPC_URL,
].filter((value): value is string => Boolean(value));

const ADMIN_INTEGRATIONS_BASE_URL = (process.env.ADMIN_INTEGRATIONS_BASE_URL || "").replace(/\/$/, "");
const ADMIN_HELIUS_SERVICE_TOKEN = process.env.ADMIN_HELIUS_SERVICE_TOKEN || "";
const ADMIN_KEY_CACHE_MS = 30_000;
const ADMIN_FAILURE_CACHE_MS = 5_000;

let runtimeKeyCache: { keys: string[]; expiresAt: number } | null = null;

function normalizeKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  if (trimmed.includes("api-key=")) {
    try {
      const url = new URL(trimmed);
      return url.searchParams.get("api-key")?.trim() ?? "";
    } catch {
      const match = trimmed.match(/api-key=([^&]+)/i);
      return match?.[1]?.trim() ?? "";
    }
  }

  if (trimmed.includes("://") || trimmed.includes("/")) {
    return "";
  }

  return trimmed;
}

export function getHeliusApiKeys(): string[] {
  const keys = HELIUS_KEY_SOURCES
    .flatMap((value) => value.split(","))
    .map(normalizeKey)
    .filter(Boolean);

  return Array.from(new Set(keys));
}

async function loadAdminHeliusKeys(): Promise<string[] | null> {
  if (!ADMIN_INTEGRATIONS_BASE_URL || ADMIN_HELIUS_SERVICE_TOKEN.length < 32) return null;
  try {
    const response = await fetch(`${ADMIN_INTEGRATIONS_BASE_URL}/internal/integrations/helius`, {
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "X-Integration-Service-Key": ADMIN_HELIUS_SERVICE_TOKEN,
      },
      signal: AbortSignal.timeout(2_500),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { keys?: unknown };
    if (!Array.isArray(payload.keys)) return null;
    return Array.from(
      new Set(
        payload.keys
          .filter((value): value is string => typeof value === "string")
          .map(normalizeKey)
          .filter(Boolean)
      )
    );
  } catch {
    return null;
  }
}

/**
 * Runtime keys managed by Admin -> Integrations. Environment keys remain a
 * backwards-compatible fallback when the admin control plane is unavailable or
 * has no active Helius keys.
 */
export async function getRuntimeHeliusApiKeys(): Promise<string[]> {
  const now = Date.now();
  if (runtimeKeyCache && runtimeKeyCache.expiresAt > now) return runtimeKeyCache.keys;

  const envKeys = getHeliusApiKeys();
  const adminKeys = await loadAdminHeliusKeys();
  const keys = adminKeys && adminKeys.length > 0 ? adminKeys : envKeys;
  runtimeKeyCache = {
    keys,
    expiresAt: now + (adminKeys === null ? ADMIN_FAILURE_CACHE_MS : ADMIN_KEY_CACHE_MS),
  };
  return keys;
}

export function clearRuntimeHeliusKeyCache(): void {
  runtimeKeyCache = null;
}

export function getHeliusApiKey(index = 0): string {
  const keys = getHeliusApiKeys();
  if (keys.length === 0) return "";
  return keys[index % keys.length] ?? keys[0] ?? "";
}

export function appendHeliusApiKey(url: string, apiKey?: string | null): string {
  const key = apiKey?.trim();
  if (!key) return url;

  try {
    const parsed = new URL(url);
    parsed.searchParams.set("api-key", key);
    return parsed.toString();
  } catch {
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}api-key=${encodeURIComponent(key)}`;
  }
}

export function isHeliusRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}
