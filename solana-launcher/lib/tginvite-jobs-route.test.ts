import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tginvite-auth", () => ({ requireTGInviteUser: vi.fn() }));
vi.mock("@/lib/authProxy", () => ({
  getBackendBaseUrl: () => "https://internal-backend.test",
}));

import { GET, POST } from "@/app/api/tginvite/jobs/route";
import { requireTGInviteUser } from "@/lib/tginvite-auth";

const jobId = "123e4567-e89b-42d3-a456-426614174000";
const job = {
  id: jobId,
  destination_chat_id: "-100123456789",
  status: "blocked_transport",
  created_at: "2026-10-14T12:00:00Z",
  recipient_digest: "should-never-leak",
  consent_id: "private-consent",
};

function req(body: unknown): Request {
  return new Request("https://example.test/api/tginvite/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "https://example.test" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TG_INVITE_INTERNAL_KEY = "i".repeat(32);
  vi.mocked(requireTGInviteUser).mockResolvedValue({
    ownerId: "123e4567-e89b-42d3-a456-426614174000",
    authorization: "Bearer test-owner",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TG_INVITE_INTERNAL_KEY;
});

describe("TGInvite audit-only jobs proxy", () => {
  it("returns only whitelisted fields, not recipient consent evidence", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([job]), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetcher);
    const response = await GET(new Request("https://example.test/api/tginvite/jobs"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{
      id: jobId,
      destination_chat_id: job.destination_chat_id,
      status: "blocked_transport",
      created_at: job.created_at,
    }]);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(fetcher).toHaveBeenCalledWith(
      "https://internal-backend.test/api/v1/tginvite/invite-jobs?limit=50",
      expect.objectContaining({
        cache: "no-store",
        headers: expect.objectContaining({
          Authorization: "Bearer test-owner",
          "X-TGInvite-Service-Key": "i".repeat(32),
        }),
      }),
    );
  });

  it("rejects attempts to submit or dispatch invitations", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect((await POST(req({ action: "send", jobId }))).status).toBe(422);
    expect((await POST(req({ action: "create", userIds: [1], consent: true }))).status).toBe(422);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("allows only cancellation and hides backend error bodies", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response("secret", { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    const ok = await POST(req({ action: "cancel", jobId }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ status: "cancelled" });
    expect(fetcher.mock.calls[0][0]).toBe(
      `https://internal-backend.test/api/v1/tginvite/invite-jobs/${jobId}/cancel`,
    );
    const failed = await POST(req({ action: "cancel", jobId }));
    expect(failed.status).toBe(503);
    expect(JSON.stringify(await failed.json())).not.toContain("secret");
  });

  it("fails closed for missing internal credentials or invalid downstream job", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify([{
      ...job, status: "sent",
    }]), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    expect((await GET(new Request("https://example.test/api/tginvite/jobs"))).status).toBe(503);
    delete process.env.TG_INVITE_INTERNAL_KEY;
    expect((await POST(req({ action: "cancel", jobId }))).status).toBe(503);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects unauthenticated requests before accessing internal ledger", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    vi.mocked(requireTGInviteUser).mockResolvedValueOnce({
      error: Response.json({ error: "Unauthorized" }, { status: 401 }) as never,
    });
    expect((await GET(new Request("https://example.test/api/tginvite/jobs"))).status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
