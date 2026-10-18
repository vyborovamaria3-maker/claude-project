import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  getMe: vi.fn(),
  getChatMember: vi.fn(),
  createChatInviteLink: vi.fn(),
  revokeChatInviteLink: vi.fn(),
}));

vi.mock("telegraf", () => ({
  Telegraf: class {
    constructor(public token: string) {}
    telegram = {
      getMe: state.getMe,
      getChatMember: state.getChatMember,
      createChatInviteLink: state.createChatInviteLink,
      revokeChatInviteLink: state.revokeChatInviteLink,
    };
  },
}));

import { checkBotInviteRights, createInviteLink, getBot, verifyBotToken } from "./telegram";

beforeEach(() => {
  vi.clearAllMocks();
  state.getMe.mockResolvedValue({ id: 12 });
  state.getChatMember.mockResolvedValue({ status: "administrator", can_invite_users: true });
  state.revokeChatInviteLink.mockResolvedValue({ is_revoked: true });
  state.createChatInviteLink.mockResolvedValue({
    invite_link: "https://t.me/+sandbox",
    creates_join_request: true,
  });
});

describe("isolated bot instances and real permission semantics (mocked)", () => {
  it("never replaces another user's bot when switching tokens", () => {
    const botA = getBot("bot-token-A");
    const botB = getBot("bot-token-B");
    const botA2 = getBot("bot-token-A");
    expect(botA).not.toBe(botB);
    expect(botA).not.toBe(botA2);
    expect(botA).toHaveProperty("token", "bot-token-A");
    expect(botB).toHaveProperty("token", "bot-token-B");
  });

  it("requires the bot's administrator invite privilege", async () => {
    expect(await checkBotInviteRights("token-A", "@my_group")).toEqual({ allowed: true });
    expect(state.getChatMember).toHaveBeenCalledWith("@my_group", 12);
    state.getChatMember.mockResolvedValueOnce({ status: "administrator", can_invite_users: false });
    expect((await checkBotInviteRights("token-A", "@my_group")).allowed).toBe(false);
    state.getChatMember.mockResolvedValueOnce({ status: "member" });
    expect((await checkBotInviteRights("token-A", "@my_group")).allowed).toBe(false);
  });

  it("does not trust failed rights lookups", async () => {
    state.getMe.mockRejectedValueOnce(new Error("Telegram offline"));
    expect(await checkBotInviteRights("token-A", "@my_group")).toMatchObject({
      allowed: false, reason: "Unable to verify bot invite permissions",
    });
  });
});

describe("bot token verification confidentiality (mocked)", () => {
  const token = "123456789:" + "A".repeat(35);

  it("refuses malformed tokens without contacting Telegram", async () => {
    expect(await verifyBotToken("not-a-token")).toEqual({
      valid: false, error: "Invalid Telegram bot token format",
    });
    expect(state.getMe).not.toHaveBeenCalled();
  });

  it("never includes a bot credential or upstream URL in error responses", async () => {
    state.getMe.mockRejectedValueOnce(new Error(
      `Request failed: https://api.telegram.org/bot${token}/getMe 401 Unauthorized`,
    ));
    const result = await verifyBotToken(token);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Invalid or inaccessible Telegram bot token");
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain("api.telegram.org");
  });

  it("accepts a valid bot reply without serializing the token", async () => {
    state.getMe.mockResolvedValueOnce({
      id: 12, username: "sandbox_bot", first_name: "Sandbox",
    });
    const result = await verifyBotToken(token);
    expect(result).toEqual({
      valid: true,
      botInfo: { id: 12, username: "sandbox_bot", firstName: "Sandbox" },
    });
    expect(JSON.stringify(result)).not.toContain(token);
  });
});

describe("Telegram-issued opt-in links (mocked Bot API)", () => {
  it("returns a link only after Telegram confirms admin join requests", async () => {
    const result = await createInviteLink("bot-token-A", "@my_group", {
      name: "TGInvite opt-in", createsJoinRequest: true,
    });
    expect(result.success).toBe(true);
    expect(result.inviteLink).toMatchObject({
      inviteLink: "https://t.me/+sandbox", createsJoinRequest: true,
    });
    expect(state.createChatInviteLink).toHaveBeenCalledWith(
      "@my_group",
      expect.objectContaining({
        creates_join_request: true,
        member_limit: undefined,
        name: "TGInvite opt-in",
      }),
    );
    expect(state.revokeChatInviteLink).not.toHaveBeenCalled();
  });

  it("revokes any link that Telegram unexpectedly creates without join approval", async () => {
    state.createChatInviteLink.mockResolvedValueOnce({
      invite_link: "https://t.me/+unexpected",
      creates_join_request: false,
    });
    const result = await createInviteLink("bot-token-A", "@my_group", {
      createsJoinRequest: true,
    });
    expect(result).toEqual({ success: false, error: "JOIN_REQUEST_NOT_ENFORCED" });
    expect(state.revokeChatInviteLink).toHaveBeenCalledWith("@my_group", "https://t.me/+unexpected");
    expect(JSON.stringify(result)).not.toContain("unexpected");
  });

  it("fails closed even if Telegram also rejects emergency link revocation", async () => {
    state.createChatInviteLink.mockResolvedValueOnce({
      invite_link: "https://t.me/+unexpected",
      creates_join_request: false,
    });
    state.revokeChatInviteLink.mockRejectedValueOnce(new Error("Telegram unavailable"));
    const result = await createInviteLink("bot-token-A", "@my_group", { createsJoinRequest: true });
    expect(result).toEqual({ success: false, error: "JOIN_REQUEST_NOT_ENFORCED" });
  });

  it("returns bounded retry metadata without credential leaks on Telegram 429", async () => {
    state.createChatInviteLink.mockRejectedValueOnce({
      response: { error_code: 429, parameters: { retry_after: 27 } },
      message: "https://api.telegram.org/bot123:secret/createChatInviteLink",
    });
    const result = await createInviteLink("123:secret", "@my_group", { createsJoinRequest: true });
    expect(result).toEqual({ success: false, error: "TELEGRAM_RATE_LIMITED", retryAfter: 27 });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("caps malformed Telegram rate-limit retry metadata", async () => {
    state.createChatInviteLink.mockRejectedValueOnce({
      response: { error_code: 429, parameters: { retry_after: 1000000000 } },
    });
    expect(await createInviteLink("bot-token", "@my_group", { createsJoinRequest: true }))
      .toEqual({ success: false, error: "TELEGRAM_RATE_LIMITED", retryAfter: 60 });
  });

  it("does not accept an empty invite URL in the Bot API response", async () => {
    state.createChatInviteLink.mockResolvedValueOnce({ invite_link: "", creates_join_request: true });
    expect(await createInviteLink("bot-token-A", "@my_group", {
      createsJoinRequest: true,
    })).toMatchObject({ success: false, error: "INVITE_LINK_MISSING" });
  });
});

