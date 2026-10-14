import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  getMe: vi.fn(),
  getChatMember: vi.fn(),
}));

vi.mock("telegraf", () => ({
  Telegraf: class {
    constructor(public token: string) {}
    telegram = { getMe: state.getMe, getChatMember: state.getChatMember };
  },
}));

import { checkBotInviteRights, getBot, verifyBotToken } from "./telegram";

beforeEach(() => {
  vi.clearAllMocks();
  state.getMe.mockResolvedValue({ id: 12 });
  state.getChatMember.mockResolvedValue({ status: "administrator", can_invite_users: true });
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
