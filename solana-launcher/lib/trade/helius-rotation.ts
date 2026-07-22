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
