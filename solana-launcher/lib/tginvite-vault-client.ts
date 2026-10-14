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

export class TGInviteVaultConflict extends Error {
  constructor() {
    super("Telegram session changed during login");
    this.name = "TGInviteVaultConflict";
  }
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

/** Shared per-user limiter before potentially expensive Telegram reads. */
export async function consumeTGInviteReadPermit(
  authorization: string,
  kind: "fetch_members" | "analyze_recent" | "validate_candidates" |
    "create_invite_link" | "batch_invite_links",
): Promise<{ allowed: boolean; retryAfter?: string; status: number }> {
  const secret = process.env.TG_INVITE_INTERNAL_KEY;
  if (!secret || secret.length < 32) return { allowed: false, status: 503 };
  try {
    const response = await fetch(`${getBackendBaseUrl()}/api/v1/tginvite/read-permit`, {
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
  } catch {
    return { allowed: false, status: 503 };
  }
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
  if (response.status === 409) throw new TGInviteVaultConflict();
  if (!response.ok) throw new Error(`TGInvite vault save failed (HTTP ${response.status})`);
}

export async function revokeVaultSession(authorization: string): Promise<void> {
  const response = await vaultRequest("DELETE", authorization);
  if (!response.ok) throw new Error(`TGInvite vault delete failed (HTTP ${response.status})`);
}

/**
 * A process-local client must not survive a vault revocation or replacement
 * made by another worker. Revalidate the stored session on every operation:
 * an authorized GramJS socket alone is not evidence that its owner still
 * permits use of that session.
 *
 * These single-flight promises prevent simultaneous reads in this worker from
 * replacing and disconnecting each other's newly restored connections.
 * Cross-worker mutations still require durable coordination before production.
 */
const pendingResolutions = new Map<string, Promise<Record<string, unknown> | null>>();

function matchesVaultSession(client: Record<string, unknown>, stored: VaultSession): boolean {
  const session = client.session as { save?: () => string } | undefined;
  if (!session || typeof session.save !== "function") return false;
  try {
    return session.save() === stored.session_string;
  } catch {
    return false;
  }
}

async function resolveFromVault(
  ownerId: string,
  authorization: string,
): Promise<Record<string, unknown> | null> {
  let stored: VaultSession | null;
  try {
    // Never return the cached client before checking centralized revocation.
    stored = await loadVaultSession(authorization);
  } catch (error) {
    // In particular, a vault outage must not turn a stale socket into access.
    await clearClient(ownerId);
    throw error;
  }

  const existing = getClient(ownerId);
  if (!stored) {
    if (existing) await clearClient(ownerId);
    return null;
  }
  if (existing) {
    if (matchesVaultSession(existing, stored)) {
      try {
        if (await isAuthorized(existing)) return existing;
      } catch {
        // Recreate a stale connection from the latest vault session below.
      }
    }
    if (getClient(ownerId) === existing) await clearClient(ownerId);
  }

  const restored = await createClient({
    apiId: stored.api_id,
    apiHash: stored.api_hash,
    sessionString: stored.session_string,
  }, ownerId);
  try {
    if (await isAuthorized(restored)) return restored;
  } catch {
    if (getClient(ownerId) === restored) await clearClient(ownerId);
    throw new Error("Unable to restore Telegram session; retry later");
  }
  if (getClient(ownerId) === restored) await clearClient(ownerId);
  // Do not delete the central vault record here: another worker may have
  // replaced it after our GET. Only an explicit disconnect may revoke it.
  return null;
}

/** Resolve only a centrally authorized session; identity comes from the backend. */
export function resolveTGInviteClient(
  ownerId: string,
  authorization: string,
): Promise<Record<string, unknown> | null> {
  const inflight = pendingResolutions.get(ownerId);
  if (inflight) return inflight;
  const resolving = (async () => {
    try {
      return await resolveFromVault(ownerId, authorization);
    } finally {
      pendingResolutions.delete(ownerId);
    }
  })();
  pendingResolutions.set(ownerId, resolving);
  return resolving;
}
