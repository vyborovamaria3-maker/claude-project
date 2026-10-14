import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/authProxy", () => ({
  getBackendBaseUrl: () => "https://internal-backend.test",
}));
vi.mock("@/lib/tginvite-mtproto", () => ({
  getClient: vi.fn(),
  clearClient: vi.fn(),
  createClient: vi.fn(),
  isAuthorized: vi.fn(),
}));

import { resolveTGInviteClient } from "./tginvite-vault-client";
import { clearClient, createClient, getClient, isAuthorized } from "./tginvite-mtproto";

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
