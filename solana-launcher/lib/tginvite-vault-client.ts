/**
 * Server-side only MTProto session storage and recovery.
 * Sessions are only released by the backend vault to authenticated
 * Next.js workers holding the internal service key. Never serialize
 * a vault payload into a response to the browser.
 */
import "server-only";
import { getBackendBaseUrl } from "@/lib/authProxy";
import { clearClient, createClient, getClient, isAuthorized } from "@/lib/tginvite-mtproto";

export interface VaultSession {
  api_id: number;
  api_hash: string;
  session_string: string;
}

async function vaultRequest(
  method: "GET" | "PUT" | "DELETE",
  authorization: string,
  body?: VaultSession,
): Promise<Response> {
  const secret = process.env.TG_INVITE_INTERNAL_KEY;
  if (!secret || secret.length < 32) {
    throw new Error("TGInvite server session vault is not configured");
  }
  return fetch(`${getBackendBaseUrl()}/api/v1/tginvite/session`, {
    method,
    headers: {
      Authorization: authorization,
      "X-TGInvite-Service-Key": secret,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
}

/**
 * Reserve a per-user Telegram login attempt using the backend's shared limiter.
 * This must succeed before calling Telegram's authentication API.
 */
export async function consumeTGInviteLoginAttempt(
  authorization: string,
  kind: "send_code" | "complete_login",
): Promise<{ allowed: boolean; retryAfter?: string; status: number }> {
  const secret = process.env.TG_INVITE_INTERNAL_KEY;
  if (!secret || secret.length < 32) {
    return { allowed: false, status: 503 };
  }
  const response = await fetch(`${getBackendBaseUrl()}/api/v1/tginvite/login-attempt`, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "X-TGInvite-Service-Key": secret,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ kind }),
    cache: "no-store",
  });
  return {
    allowed: response.status === 204,
    retryAfter: response.headers.get("Retry-After") ?? undefined,
    status: response.status,
  };
}

export async function loadVaultSession(authorization: string): Promise<VaultSession | null> {
  const response = await vaultRequest("GET", authorization);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`TGInvite vault lookup failed (HTTP ${response.status})`);
  return (await response.json()) as VaultSession;
}

export async function persistVaultSession(
  authorization: string,
  session: VaultSession,
): Promise<void> {
  const response = await vaultRequest("PUT", authorization, session);
  if (!response.ok) throw new Error(`TGInvite vault save failed (HTTP ${response.status})`);
}

export async function revokeVaultSession(authorization: string): Promise<void> {
  const response = await vaultRequest("DELETE", authorization);
  if (!response.ok) throw new Error(`TGInvite vault delete failed (HTTP ${response.status})`);
}

/** Reloads a session lost on process restart; identity is never supplied by the browser. */
export async function resolveTGInviteClient(
  ownerId: string,
  authorization: string,
): Promise<Record<string, unknown> | null> {
  const existing = getClient(ownerId);
  if (existing) {
    try {
      if (await isAuthorized(existing)) return existing;
    } catch {
      // Stale in-memory connection; check the persisted vault below.
    }
    await clearClient(ownerId);
  }

  const stored = await loadVaultSession(authorization);
  if (!stored) return null;
  const restored = await createClient({
    apiId: stored.api_id,
    apiHash: stored.api_hash,
    sessionString: stored.session_string,
  }, ownerId);
  try {
    if (await isAuthorized(restored)) return restored;
  } catch {
    // Recoverable connection failures should not silently erase credentials.
    await clearClient(ownerId);
    throw new Error("Unable to restore Telegram session; retry later");
  }
  await clearClient(ownerId);
  await revokeVaultSession(authorization);
  return null;
}
