import { describe, expect, it } from "vitest";
import { confirmedTGInviteLink, normalizeTGInviteDestination } from "./tginvite-optin";

describe("TGInvite opt-in destination and response contract", () => {
  it("accepts only an exact public username, t.me public URL or safe numeric chat id", () => {
    expect(normalizeTGInviteDestination(" @my_group ")).toBe("@my_group");
    expect(normalizeTGInviteDestination("my_group")).toBe("@my_group");
    expect(normalizeTGInviteDestination("https://t.me/my_group")).toBe("@my_group");
    expect(normalizeTGInviteDestination("https://www.t.me/my_group/")).toBe("@my_group");
    expect(normalizeTGInviteDestination("-1001234567890")).toBe("-1001234567890");
  });

  it("rejects private join hashes, arbitrary URLs, invalid usernames and unsafe ids", () => {
    for (const value of [
      "", "abc", "https://t.me/+private", "https://t.me/joinchat/abcde",
      "https://evil.example/my_group", "https://t.me/my_group/path",
      "@bad name", "-99999999999999999999", "https://t.me/my_group?x=1",
    ]) {
      expect(normalizeTGInviteDestination(value)).toBeNull();
    }
  });

  it("only trusts a confirmed Telegram invite-link response", () => {
    expect(confirmedTGInviteLink({
      status: "created", link: { inviteLink: "https://t.me/+AbCd123" },
    })).toBe("https://t.me/+AbCd123");
    expect(confirmedTGInviteLink({
      status: "created", link: { inviteLink: "https://t.me/joinchat/AbCd123" },
    })).toBe("https://t.me/joinchat/AbCd123");
    for (const response of [
      null, {}, { status: "failed", link: { inviteLink: "https://t.me/+ABC" } },
      { status: "created", link: { inviteLink: "javascript:alert(1)" } },
      { status: "created", link: { inviteLink: "https://evil.example/join" } },
      { status: "created", link: {} },
    ]) {
      expect(confirmedTGInviteLink(response)).toBeNull();
    }
  });
});
