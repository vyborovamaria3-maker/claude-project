import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tginvite-auth", () => ({
  requireTGInviteUser: vi.fn(),
}));
vi.mock("@/lib/tginvite-vault-client", () => ({
  consumeTGInviteReadPermit: vi.fn(),
  resolveTGInviteClient: vi.fn(),
}));
vi.mock("@/lib/telegram", () => ({
  createInviteLink: vi.fn(),
  getChatInfo: vi.fn(),
  checkBotInviteRights: vi.fn(),
}));

import { POST } from "@/app/api/tginvite/invite/route";
import { requireTGInviteUser } from "@/lib/tginvite-auth";
import { consumeTGInviteReadPermit } from "@/lib/tginvite-vault-client";
import { checkBotInviteRights, createInviteLink, getChatInfo } from "@/lib/telegram";

function request(body: unknown) {
  return new Request("https://example.test/api/tginvite/invite", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "https://example.test" },
    body: JSON.stringify(body),
  });
}
const params = { action: "createLink", token: ["123456789", "a".repeat(35)].join(":"), chatId: "@test_group" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireTGInviteUser).mockResolvedValue({
    ownerId: "123e4567-e89b-12d3-a456-426614174000",
    authorization: "Bearer mock",
  });
  vi.mocked(consumeTGInviteReadPermit).mockResolvedValue({ allowed: true, status: 204 });
  vi.mocked(checkBotInviteRights).mockResolvedValue({ allowed: true });
  vi.mocked(getChatInfo).mockResolvedValue({
    success: true, chat: { id: -100123, title: "Owned sandbox", type: "supergroup" },
  });
  vi.mocked(createInviteLink).mockResolvedValue({
    success: true, inviteLink: { inviteLink: "https://t.me/+sandbox", name: "Mock link", createsJoinRequest: true },
  });
});

describe("TGInvite invitation endpoint mocked integration", () => {
  it("rejects direct invitations without making Telegram or quota calls", async () => {
    const response = await POST(request({
      action: "inviteFromFetched", channelUsername: "@test_group",
      userIds: [42], confirmedOptIn: true,
    }));
    expect(response.status).toBe(501);
    expect(createInviteLink).not.toHaveBeenCalled();
    expect(consumeTGInviteReadPermit).not.toHaveBeenCalled();
  });

  it("prevents anonymous requests before any mutation", async () => {
    vi.mocked(requireTGInviteUser).mockResolvedValueOnce({
      error: Response.json({ error: "Unauthorized" }, { status: 401 }) as never,
    });
    const response = await POST(request(params));
    expect(response.status).toBe(401);
    expect(createInviteLink).not.toHaveBeenCalled();
  });

  it("rejects malformed bot tokens before quota or Telegram side effects", async () => {
    const response = await POST(request({ ...params, token: "abc/bad:token" }));
    expect(response.status).toBe(422);
    expect(consumeTGInviteReadPermit).not.toHaveBeenCalled();
    expect(getChatInfo).not.toHaveBeenCalled();
    expect(createInviteLink).not.toHaveBeenCalled();
  });

  it("rejects invalid batches before contacting the Bot API", async () => {
    const response = await POST(request({
      ...params, action: "batchLinks", linkCount: -5,
    }));
    expect(response.status).toBe(422);
    expect(consumeTGInviteReadPermit).not.toHaveBeenCalled();
    expect(getChatInfo).not.toHaveBeenCalled();
    expect(createInviteLink).not.toHaveBeenCalled();
  });

  it("honors shared per-owner quota and fails closed on outage", async () => {
    vi.mocked(consumeTGInviteReadPermit).mockResolvedValueOnce({
      allowed: false, status: 503,
    });
    const response = await POST(request(params));
    expect(response.status).toBe(503);
    expect(createInviteLink).not.toHaveBeenCalled();
  });

  it("returns 429 with bounded Retry-After when Telegram limits chat lookup", async () => {
    vi.mocked(getChatInfo).mockResolvedValueOnce({
      success: false, error: "TELEGRAM_RATE_LIMITED", retryAfter: 23,
    });
    const response = await POST(request(params));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("23");
    expect((await response.json()).error).toBe("TELEGRAM_RATE_LIMITED");
    expect(createInviteLink).not.toHaveBeenCalled();
  });

  it("reports Telegram permission-lookup flood limits as retryable, not forbidden", async () => {
    vi.mocked(checkBotInviteRights).mockResolvedValueOnce({
      allowed: false, reason: "TELEGRAM_RATE_LIMITED", retryAfter: 31,
    });
    const response = await POST(request(params));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("31");
    expect(createInviteLink).not.toHaveBeenCalled();
  });

  it("does not disguise creation rate limits as broken chat permissions", async () => {
    vi.mocked(createInviteLink).mockResolvedValueOnce({
      success: false, error: "TELEGRAM_RATE_LIMITED", retryAfter: 41,
    });
    const response = await POST(request({ ...params, createsJoinRequest: true }));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("41");
    expect((await response.json()).error).toBe("TELEGRAM_RATE_LIMITED");
  });

  it("stops a batch immediately when Telegram imposes rate limits", async () => {
    vi.mocked(createInviteLink).mockResolvedValueOnce({
      success: false, error: "TELEGRAM_RATE_LIMITED", retryAfter: 17,
    });
    const response = await POST(request({ ...params, action: "batchLinks", linkCount: 3 }));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("17");
    expect(await response.json()).toMatchObject({
      count: 0, requestedCount: 3, error: "TELEGRAM_RATE_LIMITED", status: "failed",
    });
    expect(createInviteLink).toHaveBeenCalledTimes(1);
  });

  it("fails closed if the bot lacks invite rights", async () => {
    vi.mocked(checkBotInviteRights).mockResolvedValueOnce({
      allowed: false, reason: "Bot needs administrator rights to invite users",
    });
    const response = await POST(request(params));
    expect(response.status).toBe(403);
    expect(createInviteLink).not.toHaveBeenCalled();
  });

  it("fails closed if rights lookup cannot verify the bot", async () => {
    vi.mocked(checkBotInviteRights).mockResolvedValueOnce({
      allowed: false, reason: "Unable to verify bot invite permissions",
    });
    const response = await POST(request(params));
    expect(response.status).toBe(403);
    expect(createInviteLink).not.toHaveBeenCalled();
  });

  it("creates an opt-in join-request link with no member limit", async () => {
    const response = await POST(request({ ...params, createsJoinRequest: true }));
    expect(response.status).toBe(200);
    expect(consumeTGInviteReadPermit).toHaveBeenCalledWith("Bearer mock", "create_invite_link");
    expect(createInviteLink).toHaveBeenCalledWith(
      params.token, params.chatId,
      expect.objectContaining({ createsJoinRequest: true, memberLimit: undefined }),
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await response.json()).status).toBe("created");
  });

  it("rejects an unmoderated link even if Telegram reports successful creation", async () => {
    vi.mocked(createInviteLink).mockResolvedValueOnce({
      success: true,
      inviteLink: { inviteLink: "https://t.me/+unmoderated", createsJoinRequest: false },
    });
    const response = await POST(request({ ...params, createsJoinRequest: true }));
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.status).not.toBe("created");
    expect(payload.error).toBe("JOIN_REQUEST_NOT_ENFORCED");
    expect(JSON.stringify(payload)).not.toContain("unmoderated");
  });

  it("never counts an unmoderated link in opt-in batches", async () => {
    vi.mocked(createInviteLink).mockResolvedValueOnce({
      success: true,
      inviteLink: { inviteLink: "https://t.me/+unmoderated", createsJoinRequest: false },
    });
    const response = await POST(request({
      ...params, action: "batchLinks", linkCount: 3, createsJoinRequest: true,
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      links: [], count: 0, requestedCount: 3, status: "failed", error: "JOIN_REQUEST_NOT_ENFORCED",
    });
    expect(createInviteLink).toHaveBeenCalledTimes(1);
  });

  it("does not leak bot tokens and stops after a thrown Telegram error", async () => {
    vi.mocked(createInviteLink).mockRejectedValueOnce(
      new Error(`Bot token ${params.token} was rejected`),
    );
    const response = await POST(request({
      ...params, action: "batchLinks", linkCount: 3,
    }));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ count: 0, requestedCount: 3, status: "failed" });
    expect(JSON.stringify(result)).not.toContain(params.token);
    expect(createInviteLink).toHaveBeenCalledTimes(1);
  });

  it("reports partial batches honestly and stops after first Telegram error", async () => {
    vi.mocked(createInviteLink)
      .mockResolvedValueOnce({
        success: true, inviteLink: { inviteLink: "https://t.me/+one", name: "one", createsJoinRequest: false },
      })
      .mockResolvedValueOnce({ success: false, error: "CHAT_ADMIN_REQUIRED" });
    const response = await POST(request({
      ...params, action: "batchLinks", linkCount: 3,
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      count: 1, requestedCount: 3, status: "partial", error: "CHAT_ADMIN_REQUIRED",
    });
    expect(createInviteLink).toHaveBeenCalledTimes(2);
    expect(consumeTGInviteReadPermit).toHaveBeenCalledWith("Bearer mock", "batch_invite_links");
  });
});
