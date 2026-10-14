import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/authProxy", () => ({
  getBackendBaseUrl: () => "https://internal-backend.test",
}));
vi.mock("@/lib/tginvite-mtproto", () => ({
  getClient: vi.fn(),
  hasTGInviteLoginInProgress: vi.fn(),
  clearClient: vi.fn(),
  createClient: vi.fn(),
  isAuthorized: vi.fn(),
}));

import { acquireTGInviteLoginLease, verifyTGInviteLoginLease, releaseTGInviteLoginLease, resetTGInviteLoginLease, TGInviteLoginLeaseError, resolveTGInviteClient, persistVaultSession, TGInviteVaultConflict } from "./tginvite-vault-client";
import { clearClient, createClient, getClient, hasTGInviteLoginInProgress, isAuthorized } from "./tginvite-mtproto";

const ownerId = "123e4567-e89b-12d3-a456-426614174000";
const authorization = "Bearer test-owner-token";
const stored = {
  api_id: 123,
  api_hash: "test-api-hash-at-least-16",
  session_string: "current-central-session",
};
const active = (sessionString: string) => ({
  session: { save: () => sessionString },
  connected: true,
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TG_INVITE_INTERNAL_KEY = "s".repeat(32);
  vi.mocked(clearClient).mockResolvedValue(undefined);
  vi.mocked(isAuthorized).mockResolvedValue(true);
  vi.mocked(getClient).mockReturnValue(null);
  vi.mocked(hasTGInviteLoginInProgress).mockReturnValue(false);
  vi.mocked(createClient).mockResolvedValue(active(stored.session_string));
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TG_INVITE_INTERNAL_KEY;
});

function mockVaultResponse(status: number, payload = stored) {
  const fetcher = vi.fn().mockResolvedValue(
    new Response(status === 200 ? JSON.stringify(payload) : null, {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

describe("TGInvite centralized login leases (mocked)", () => {
  it("acquires a server-owned token and validates it before completing a login", async () => {
    const token = "t".repeat(45);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    expect(await acquireTGInviteLoginLease(authorization)).toBe(token);
    await verifyTGInviteLoginLease(authorization, token);
    await releaseTGInviteLoginLease(authorization, token);
    expect(fetcher).toHaveBeenCalledTimes(3);
    const payloads = fetcher.mock.calls.map((call) => JSON.parse(call[1].body));
    expect(payloads).toEqual([
      { action: "acquire" },
      { action: "verify", token },
      { action: "release", token },
    ]);
    expect(fetcher.mock.calls[0][1].cache).toBe("no-store");
  });

  it("returns a conflict when another worker owns the challenge", async () => {
    mockVaultResponse(409);
    await expect(acquireTGInviteLoginLease(authorization))
      .rejects.toMatchObject({ status: 409 });
  });

  it("fails closed on an unavailable Redis lease service", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Redis offline")));
    await expect(acquireTGInviteLoginLease(authorization))
      .rejects.toBeInstanceOf(TGInviteLoginLeaseError);
    await expect(verifyTGInviteLoginLease(authorization, "t".repeat(42)))
      .rejects.toMatchObject({ status: 503 });
  });

  it("rejects empty or truncated server lease tokens", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ token: "short" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(acquireTGInviteLoginLease(authorization))
      .rejects.toMatchObject({ status: 503 });
  });

  it("supports authenticated cancellation without sending tokens to the browser", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    await resetTGInviteLoginLease(authorization);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ action: "reset" });
    expect(fetcher.mock.calls[0][0]).toBe("https://internal-backend.test/api/v1/tginvite/login-lease");
  });
});

describe("TGInvite shared vault write conflicts (mocked)", () => {
  it("turns competing session writes into a typed 409 conflict", async () => {
    const fetcher = mockVaultResponse(409);
    await expect(persistVaultSession(authorization, stored))
      .rejects.toBeInstanceOf(TGInviteVaultConflict);
    expect(fetcher).toHaveBeenCalledWith(
      "https://internal-backend.test/api/v1/tginvite/session",
      expect.objectContaining({ method: "PUT" }),
    );
  });
});

describe("TGInvite pending challenge preservation (mocked)", () => {
  it("does not tear down a pending code flow during a connection status probe", async () => {
    vi.mocked(hasTGInviteLoginInProgress).mockReturnValue(true);
    vi.mocked(getClient).mockReturnValue(active("pending-not-persisted"));
    const fetcher = mockVaultResponse(404);
    expect(await resolveTGInviteClient(ownerId, authorization)).toBeNull();
    expect(clearClient).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe("TGInvite cross-worker vault invalidation (mocked)", () => {
  it("closes a locally authorized socket when another worker revoked the vault session", async () => {
    const cached = active(stored.session_string);
    vi.mocked(getClient).mockReturnValue(cached);
    const fetcher = mockVaultResponse(404);

    expect(await resolveTGInviteClient(ownerId, authorization)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(clearClient).toHaveBeenCalledWith(ownerId);
    expect(isAuthorized).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("reuses a locally authorized socket only when it matches the central vault", async () => {
    const cached = active(stored.session_string);
    vi.mocked(getClient).mockReturnValue(cached);
    const fetcher = mockVaultResponse(200);

    expect(await resolveTGInviteClient(ownerId, authorization)).toBe(cached);
    expect(isAuthorized).toHaveBeenCalledWith(cached);
    expect(clearClient).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledWith(
      "https://internal-backend.test/api/v1/tginvite/session",
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
  });

  it("discards a cached socket after a different worker rotates its session", async () => {
    const cached = active("obsolete-session");
    vi.mocked(getClient).mockReturnValue(cached);
    mockVaultResponse(200);
    const restored = active(stored.session_string);
    vi.mocked(createClient).mockResolvedValue(restored);

    expect(await resolveTGInviteClient(ownerId, authorization)).toBe(restored);
    expect(clearClient).toHaveBeenCalledWith(ownerId);
    expect(createClient).toHaveBeenCalledWith({
      apiId: stored.api_id, apiHash: stored.api_hash, sessionString: stored.session_string,
    }, ownerId);
    expect(isAuthorized).not.toHaveBeenCalledWith(cached);
  });

  it("fails closed, even for a cached authenticated socket, on a vault outage", async () => {
    vi.mocked(getClient).mockReturnValue(active(stored.session_string));
    mockVaultResponse(503);

    await expect(resolveTGInviteClient(ownerId, authorization))
      .rejects.toThrow("vault lookup failed (HTTP 503)");
    expect(clearClient).toHaveBeenCalledWith(ownerId);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("does not delete a newer central session after stale local authorization fails", async () => {
    const fetcher = mockVaultResponse(200);
    vi.mocked(isAuthorized).mockResolvedValue(false);
    // createClient registers the newly restored client in the real owner map.
    // Model that side effect so the cleanup path is actually reachable.
    const restored = active(stored.session_string);
    vi.mocked(createClient).mockResolvedValue(restored);
    vi.mocked(getClient)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(restored);

    expect(await resolveTGInviteClient(ownerId, authorization)).toBeNull();
    expect(clearClient).toHaveBeenCalledWith(ownerId);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("shares an in-flight restore within a worker instead of creating competing clients", async () => {
    mockVaultResponse(200);
    let release!: (value: Record<string, unknown>) => void;
    vi.mocked(createClient).mockImplementation(() =>
      new Promise((resolve) => { release = resolve; }),
    );

    const first = resolveTGInviteClient(ownerId, authorization);
    const second = resolveTGInviteClient(ownerId, authorization);
    expect(second).toBe(first);
    // Allow the mocked vault response to resolve before the client constructor.
    await vi.waitFor(() => expect(createClient).toHaveBeenCalledTimes(1));
    release(active(stored.session_string));

    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it("restores from the vault when the matching cached connection is unauthorized", async () => {
    const cached = active(stored.session_string);
    vi.mocked(getClient).mockReturnValue(cached);
    vi.mocked(isAuthorized).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mockVaultResponse(200);

    expect(await resolveTGInviteClient(ownerId, authorization)).not.toBeNull();
    expect(clearClient).toHaveBeenCalledWith(ownerId);
    expect(createClient).toHaveBeenCalledTimes(1);
  });
});
