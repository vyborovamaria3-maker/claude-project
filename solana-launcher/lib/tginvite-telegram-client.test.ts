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

import { checkBotInviteRights, getBot } from "./telegram";

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
